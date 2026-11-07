use super::*;
use crate::db::agsdl_execution::work_protocol030::{
    open_human, resolve_human, set_human_link, HumanLink030, HumanRequest030,
};
use crate::db::agsdl_execution::work_protocol030_tests::setup;

async fn scope(pool: &SqlitePool) -> HumanScope030 {
    let mut db = pool.acquire().await.unwrap();
    HumanScope030 {
        system_start_id: "system".into(),
        source: load(&mut db, "system").await.unwrap().snapshot.source,
    }
}
fn request(context: &EngineContext, id: &str) -> HumanRequest030 {
    HumanRequest030 {
        owner: context.owner.clone(),
        request_id: id.into(),
        contexts: vec![context.clone()],
        kind: "ask".into(),
        payload_json: r#"{"secret":"private"}"#.into(),
        deadline_ms: Some("100".into()),
    }
}
fn content() -> HumanContent030 {
    HumanContent030::Approval {
        message: "Review".into(),
        title: "Approval".into(),
        description: "Continue?".into(),
        choices: vec!["yes".into(), "no".into()],
    }
}
fn decision(scope: HumanScope030, id: String, choice: &str) -> HumanDecision030 {
    HumanDecision030 {
        scope,
        request_id: id,
        expected_revision: "0".into(),
        answer: HumanAnswer030::Approval {
            choice: choice.into(),
            comment: None,
        },
    }
}

#[tokio::test]
async fn attestation_projection_and_submission_do_not_expose_private_records() {
    let (_dir, pool, context) = setup().await;
    let original = request(&context, "private-provider-id");
    open_human(&pool, &original).await.unwrap();
    let scope = scope(&pool).await;
    assert!(human_page(&pool, scope.clone(), None)
        .await
        .unwrap()
        .requests
        .is_empty());
    let id = attest_human(&pool, &original, &content()).await.unwrap();
    assert_ne!(id, original.request_id);
    assert_eq!(
        id,
        attest_human(&pool, &original, &content()).await.unwrap()
    );
    let page = human_page(&pool, scope.clone(), None).await.unwrap();
    assert_eq!(page.requests.len(), 1);
    assert_eq!(page.requests[0].id, id);
    assert_ne!(page.requests[0].work_ids[0], context.work.activation_id);
    let json = serde_json::to_string(&page).unwrap();
    assert!(!json.contains("private"));
    assert!(!json.contains("permissions"));
    assert_eq!(page.requests[0].revision, "0");
    assert!(
        decide_human(&pool, decision(scope.clone(), id.clone(), "invalid"))
            .await
            .is_err()
    );
    let (a, b) = tokio::join!(
        decide_human(&pool, decision(scope.clone(), id.clone(), "yes")),
        decide_human(&pool, decision(scope.clone(), id.clone(), "no"))
    );
    assert_ne!(a.is_ok(), b.is_ok());
    let page = human_page(&pool, scope.clone(), None).await.unwrap();
    assert_eq!(page.requests[0].status, "submitted");
    assert_eq!(page.requests[0].revision, "1");
    let native = pending_submissions(&pool, "system").await.unwrap();
    assert_eq!(native.len(), 1);
    let row: (String, Option<String>) = sqlx::query_as("SELECT revision,answer_json FROM engine_human_requests030 WHERE system_id='system' AND request_id=?").bind(&original.request_id).fetch_one(&pool).await.unwrap();
    assert_eq!(row, ("0".into(), None));
    resolve_human(&pool, &original, "0", "false").await.unwrap();
    assert!(pending_submissions(&pool, "system")
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        human_page(&pool, scope, None).await.unwrap().requests[0].status,
        "resolved"
    );
}

#[tokio::test]
async fn pagination_detects_link_and_request_mutations_and_scope_changes() {
    let (_dir, pool, context) = setup().await;
    for n in 0..65 {
        let item = request(&context, &format!("request-{n}"));
        open_human(&pool, &item).await.unwrap();
        attest_human(&pool, &item, &content()).await.unwrap();
    }
    let scope = scope(&pool).await;
    let first = human_page(&pool, scope.clone(), None).await.unwrap();
    assert_eq!(first.requests.len(), 64);
    assert_eq!(first.total, "65");
    let next = first.next_page.unwrap();
    assert_eq!(
        human_page(&pool, scope.clone(), Some(next.clone()))
            .await
            .unwrap()
            .requests
            .len(),
        1
    );
    let item = request(&context, "request-0");
    let link = HumanLink030 {
        operation_id: "detach".into(),
        context: context.clone(),
        attached: false,
    };
    set_human_link(&pool, &item, &link).await.unwrap();
    assert_eq!(
        human_page(&pool, scope.clone(), Some(next))
            .await
            .unwrap_err()
            .code,
        "CONFLICT"
    );
    let fresh = human_page(&pool, scope.clone(), None)
        .await
        .unwrap()
        .next_page
        .unwrap();
    open_human(&pool, &request(&context, "unattested"))
        .await
        .unwrap();
    assert_eq!(
        human_page(&pool, scope.clone(), Some(fresh))
            .await
            .unwrap_err()
            .code,
        "CONFLICT"
    );
    let mut foreign = scope.clone();
    foreign.source.owner.branch = "foreign".into();
    assert!(human_page(&pool, foreign, None).await.is_err());
}

#[tokio::test]
async fn submission_fences_stopped_and_revoked_work_without_deciding_timeouts() {
    let (_dir, pool, context) = setup().await;
    let item = request(&context, "request");
    open_human(&pool, &item).await.unwrap();
    let id = attest_human(&pool, &item, &content()).await.unwrap();
    let scope = scope(&pool).await;
    let mut db = pool.acquire().await.unwrap();
    let mut stored = load(&mut db, "system").await.unwrap();
    stored.state.stop = EngineStopState::Requested {
        request_id: "stop".into(),
    };
    save(&mut db, "system", &stored.state).await.unwrap();
    drop(db);
    assert!(
        decide_human(&pool, decision(scope.clone(), id.clone(), "yes"))
            .await
            .is_err()
    );
    let mut db = pool.acquire().await.unwrap();
    stored.state.stop = EngineStopState::None;
    stored.state.epoch = "2".into();
    save(&mut db, "system", &stored.state).await.unwrap();
    drop(db);
    assert!(decide_human(&pool, decision(scope, id, "yes"))
        .await
        .is_err());
    assert!(pending_submissions(&pool, "system")
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn shared_request_survives_targeted_stop_without_resuming_the_work() {
    let (_dir, pool, first) = setup().await;
    let mut second = first.clone();
    second.work.activation_id = "second".into();
    let mut db = pool.acquire().await.unwrap();
    let mut stored = load(&mut db, "system").await.unwrap();
    let mut activation = stored.state.activations["work"].clone();
    activation.delivery.delivery.work = second.work.clone();
    activation.delivery.delivery.delivery_id = "second-delivery".into();
    stored.state.activations.insert("second".into(), activation);
    save(&mut db, "system", &stored.state).await.unwrap();
    drop(db);
    work_protocol030::initialize(&pool, &second, "{}", "{}")
        .await
        .unwrap();
    let mut item = request(&first, "shared");
    item.contexts.push(second);
    open_human(&pool, &item).await.unwrap();
    let id = attest_human(&pool, &item, &content()).await.unwrap();
    stop(
        &pool,
        EngineStopRequest {
            system_start_id: "system".into(),
            request_id: "stop-first".into(),
            activation_id: Some(first.work.activation_id.clone()),
        },
    )
    .await
    .unwrap();
    decide_human(&pool, decision(scope(&pool).await, id, "yes"))
        .await
        .unwrap();
    let mut db = pool.acquire().await.unwrap();
    let stored = load(&mut db, "system").await.unwrap();
    assert!(!matches!(
        stored.state.activations["work"].stop_state,
        EngineStopState::None
    ));
    assert_eq!(stored.state.activations["second"].work_state, "active");
    let row: (String, Option<String>) = sqlx::query_as("SELECT revision,answer_json FROM engine_human_requests030 WHERE system_id='system' AND request_id='shared'").fetch_one(&pool).await.unwrap();
    assert_eq!(row, ("0".into(), None));
}

#[test]
fn structured_question_wire_retains_exact_json_text() {
    let answer = HumanAnswer030::Question {
        answer_json: r#"{ "value":9007199254740993, "small":1.0 }"#.into(),
    };
    let wire = serde_json::to_string(&answer).unwrap();
    let decoded: HumanAnswer030 = serde_json::from_str(&wire).unwrap();
    assert_eq!(decoded, answer);
    assert!(validate_answer(&content(), &decoded).is_err());
}
