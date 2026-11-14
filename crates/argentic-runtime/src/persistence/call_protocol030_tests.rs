use super::*;
use crate::agsdl_host_calls030::{
    self as calls,
    tests::{self as fixtures, Fixture},
};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn duplicate_raw_receipt_is_idempotent_but_contradictory_receipt_is_refused() {
    let f = Fixture::new(r#"{"type":"call","command":"never execute"}"#).await;
    let broker = calls::CallDataBroker030::default();
    let joined = fixtures::joined(&f, &broker, fixtures::command(0, "original")).await;
    // received() is deliberately available only after native join/SQL read.
    // The host sibling has private fields, so obtain an original received row
    // by cancelling the pure worker after the raw commit.
    let cancel = CancellationToken::new();
    let finish = fixtures::finish_terminal(&f.pool, &f.authority, &broker, &joined, &cancel);
    let task = async {
        let _job = broker.next().await.unwrap();
        cancel.cancel();
    };
    let (result, ()) = tokio::join!(finish, task);
    assert!(result.is_err());
    let mut tx = f.pool.begin().await.unwrap();
    let raw: String = sqlx::query_scalar("SELECT received_json FROM engine_flow030_calls")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(
        decode_received(&raw).unwrap(),
        received_from_join(&joined).unwrap()
    );
    receive_tx(&mut tx, &f.authority, &joined).await.unwrap();
    tx.commit().await.unwrap();
    // The private SQL DTO is not a write capability. An adversarial ledger
    // containing different raw data must reject the genuine join witness.
    let other = Fixture::new(r#"{"type":"call","command":"never execute"}"#).await;
    let other_broker = calls::CallDataBroker030::default();
    let other_joined =
        fixtures::joined(&other, &other_broker, fixtures::command(0, "original")).await;
    let mut conflicting = received_from_join(&other_joined).unwrap();
    conflicting.end = CallEnd030::Returned {
        event: fixtures::command(1, "different"),
    };
    sqlx::query(
        "UPDATE engine_flow030_calls SET status='received',received_json=? WHERE call_id=?",
    )
    .bind(serde_json::to_string(&conflicting).unwrap())
    .bind(other_joined.attempt().call_id())
    .execute(&other.pool)
    .await
    .unwrap();
    let mut tx = other.pool.begin().await.unwrap();
    assert!(receive_tx(&mut tx, &other.authority, &other_joined)
        .await
        .is_err());
    tx.rollback().await.unwrap();
    let receipt = fixtures::finish(&f, &broker, &joined).await;
    assert_eq!(receipt.status(), "succeeded");
}

#[tokio::test]
async fn another_visit_snapshot_epoch_and_call_id_cannot_consume_a_receipt() {
    let f = Fixture::new(r#"{"type":"call","command":"never execute"}"#).await;
    let attempt = f.reserve().await;
    let mut tx = f.pool.begin().await.unwrap();
    let mut other_work = attempt.work().clone();
    other_work.start_effect_id = "other-start".into();
    assert!(read_attempt_tx(&mut tx, &f.authority, &f.id, &other_work)
        .await
        .is_err());
    let mut changed = attempt.clone();
    changed.call_id = "another-call".into();
    assert!(row_tx(&mut tx, &changed).await.is_err());
    let mut stale = f.id.clone();
    stale.snapshot_id = "another-snapshot".into();
    assert!(
        read_attempt_tx(&mut tx, &f.authority, &stale, attempt.work())
            .await
            .is_err()
    );
    stale = f.id.clone();
    stale.epoch = "another-epoch".into();
    assert!(
        read_attempt_tx(&mut tx, &f.authority, &stale, attempt.work())
            .await
            .is_err()
    );
    assert!(read_attempt_tx(
        &mut tx,
        &f.authority,
        &f.id,
        &WorkRef030 {
            activation_id: "another-visit".into(),
            ..attempt.work().clone()
        }
    )
    .await
    .unwrap()
    .is_none());
    assert_eq!(
        read_attempt_tx(&mut tx, &f.authority, &f.id, attempt.work())
            .await
            .unwrap(),
        Some(attempt)
    );
}

#[tokio::test]
async fn lost_reservation_or_launch_ack_never_grants_a_second_launch() {
    let f = Fixture::new(r#"{"type":"call","command":"never execute"}"#).await;
    let _lost_attempt = f.reserve().await;
    assert!(calls::reserve_call030(&f.pool, &f.authority, &f.effect)
        .await
        .is_err());
    let mut tx = f.pool.begin().await.unwrap();
    let work = match &f.effect.kind {
        FlowEffectKind030::Start { work, .. } => work,
        _ => unreachable!(),
    };
    let attempt = read_attempt_tx(&mut tx, &f.authority, &f.id, work)
        .await
        .unwrap()
        .unwrap();
    tx.commit().await.unwrap();
    let broker = calls::CallDataBroker030::default();
    fixtures::prepare(&f, &broker, &attempt).await;
    f.handoff(&attempt).await;
    let mut tx = f.pool.begin().await.unwrap();
    launch_tx(&mut tx, &f.authority, &attempt, &fixtures::control())
        .await
        .unwrap();
    tx.commit().await.unwrap(); // acknowledgement deliberately discarded
    let mut tx = f.pool.begin().await.unwrap();
    assert!(
        launch_tx(&mut tx, &f.authority, &attempt, &fixtures::control())
            .await
            .is_err()
    );
    assert!(read_receipt_tx(&mut tx, &f.authority, &f.id, work)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        row_tx(&mut tx, &attempt)
            .await
            .unwrap()
            .get::<&str, _>("status"),
        "launched"
    );
}

#[tokio::test]
async fn terminal_readback_after_lost_ack_never_replays_worker_or_transport() {
    let f = Fixture::new(r#"{"type":"call","command":"never execute","parse":"json"}"#).await;
    let broker = calls::CallDataBroker030::default();
    let joined = fixtures::joined(
        &f,
        &broker,
        fixtures::command(0, r#"{"n":9007199254740993,"large":1e999}"#),
    )
    .await;
    let receipt = fixtures::finish(&f, &broker, &joined).await;
    let before = f.state().await;
    // A disconnected worker makes accidental normalization replay fail.
    broker.close();
    assert_eq!(
        fixtures::finish_terminal(
            &f.pool,
            &f.authority,
            &broker,
            &joined,
            &CancellationToken::new()
        )
        .await
        .unwrap(),
        receipt
    );
    for _ in 0..3 {
        assert_eq!(
            calls::read_call_receipt030(&f.pool, &f.authority, &f.id, joined.attempt().work())
                .await
                .unwrap(),
            Some(receipt.clone())
        );
    }
    assert_eq!(f.state().await, before);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM engine_flow030_calls")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        1
    );
    assert!(
        sqlx::query("UPDATE engine_flow030_calls SET status='prepared' WHERE call_id=?")
            .bind(joined.attempt().call_id())
            .execute(&f.pool)
            .await
            .is_err()
    );
    assert!(sqlx::query("DELETE FROM engine_flow030_calls")
        .execute(&f.pool)
        .await
        .is_err());
}

#[tokio::test]
async fn stop_race_retains_raw_receipt_but_only_publishes_physical_end() {
    let f = Fixture::new(r#"{"type":"call","command":"never execute"}"#).await;
    let broker = calls::CallDataBroker030::default();
    let joined = fixtures::joined(&f, &broker, fixtures::command(0, "late success")).await;
    f.stop().await;
    broker.close();
    let receipt = fixtures::finish_terminal(
        &f.pool,
        &f.authority,
        &broker,
        &joined,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(receipt.status(), "stopped");
    assert!(receipt.work_result().unwrap().is_none());
    let state = f.state().await;
    assert!(!state.activations[0].physical);
    assert!(state.activations[0].result.is_none());
    assert_eq!(state.verdict.as_deref(), Some("cancelled"));
    calls::read_call_receipt030(&f.pool, &f.authority, &f.id, joined.attempt().work())
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn native_output_verification_refuses_forged_outcome_stdout_and_mcp_data() {
    let prepared = PreparedCall030::Command {
        command: "never execute".into(),
        parse: Some("json".into()),
    };
    let event = fixtures::command(1, r#"{"n":9007199254740993}"#);
    for output in [
        r#"{"outcome":"passed","data":{"exitCode":1,"output":"{\"n\":9007199254740993}stderr","value":{"n":9007199254740993}}}"#,
        r#"{"outcome":"failed","data":{"exitCode":1,"output":"{\"n\":9007199254740993}stderr","value":{"n":9007199254740992}}}"#,
    ] {
        assert!(validate_output(&prepared, &event, output).is_err());
    }
    let prepared = PreparedCall030::Mcp {
        server: "server".into(),
        tool: "tool".into(),
        arguments_json: "{}".into(),
    };
    let event = CallEvent030::ToolReturned {
        is_error: true,
        text: "declined".into(),
        structured_content_json: None,
    };
    assert!(validate_output(
        &prepared,
        &event,
        r#"{"outcome":"passed","data":"declined"}"#
    )
    .is_err());
    assert!(validate_output(
        &prepared,
        &event,
        r#"{"outcome":"failed","data":"accepted"}"#
    )
    .is_err());
    assert!(validate_event(&prepared, &fixtures::command(0, "fake tool")).is_err());
}

#[tokio::test]
async fn forged_prepared_mcp_arguments_and_unowned_handoff_are_refused() {
    let f = Fixture::new(r#"{"type":"call","mcp":{"server":"server","tool":"tool"},"arguments":{"n":{"value":9007199254740993}}}"#).await;
    let attempt = f.reserve().await;
    assert!(validate_prepared(
        &attempt,
        &PreparedCall030::Mcp {
            server: "server".into(),
            tool: "tool".into(),
            arguments_json: r#"{"n":9007199254740992}"#.into()
        }
    )
    .is_err());
    let broker = calls::CallDataBroker030::default();
    fixtures::prepare(&f, &broker, &attempt).await;
    assert!(
        calls::launch_synthetic030(&f.pool, &f.authority, &attempt, fixtures::control())
            .await
            .is_err()
    );
    let mut tx = f.pool.begin().await.unwrap();
    assert_eq!(
        row_tx(&mut tx, &attempt)
            .await
            .unwrap()
            .get::<&str, _>("status"),
        "prepared"
    );
}

#[tokio::test]
async fn unknown_commit_fence_requires_exact_readback_and_never_relaunches() {
    let f = Fixture::new(r#"{"type":"call","command":"never execute"}"#).await;
    let broker = calls::CallDataBroker030::default();
    let joined = fixtures::joined(&f, &broker, fixtures::command(0, "done")).await;
    let receipt = fixtures::finish(&f, &broker, &joined).await;
    let mut tx = f.pool.begin().await.unwrap();
    let marker = commit_marker_tx(&mut tx, joined.attempt()).await.unwrap();
    f.authority.call_commits().begin(&marker).unwrap();
    tx.commit().await.unwrap(); // simulate acknowledged DB commit with lost host ack
    assert!(f.authority.call_commits().require_clear(&f.id).is_err());
    assert!(
        calls::read_call_receipt030(&f.pool, &f.authority, &f.id, joined.attempt().work())
            .await
            .is_err()
    );
    assert!(calls::launch_synthetic030(
        &f.pool,
        &f.authority,
        joined.attempt(),
        fixtures::control()
    )
    .await
    .is_err());
    let before = f.state().await;
    broker.close();
    assert!(calls::inspect_call_commit030(&f.pool, &f.authority, &f.id)
        .await
        .unwrap());
    assert!(!calls::inspect_call_commit030(&f.pool, &f.authority, &f.id)
        .await
        .unwrap());
    assert_eq!(
        calls::read_call_receipt030(&f.pool, &f.authority, &f.id, joined.attempt().work())
            .await
            .unwrap(),
        Some(receipt)
    );
    assert_eq!(f.state().await, before);
}

#[tokio::test]
async fn operand_failure_requires_an_actual_unreadable_native_operand() {
    let valid = Fixture::new(
        r#"{"type":"call","mcp":{"server":"server","tool":"tool"},"arguments":{"n":{"value":42}}}"#,
    )
    .await;
    let attempt = valid.reserve().await;
    assert!(require_operand_failure(&attempt).is_err());
    let mut tx = valid.pool.begin().await.unwrap();
    assert!(fail_preparation_tx(&mut tx, &valid.authority, &attempt)
        .await
        .is_err());
    tx.rollback().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM engine_flow030_calls")
            .fetch_one(&valid.pool)
            .await
            .unwrap(),
        "reserved"
    );
    assert!(
        calls::read_call_receipt030(&valid.pool, &valid.authority, &valid.id, attempt.work())
            .await
            .unwrap()
            .is_none()
    );
}
