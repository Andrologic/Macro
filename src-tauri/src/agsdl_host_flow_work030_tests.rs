//! Real Rust controller with an explicitly synthetic native admission.
//! This does not attest a provider, policy grant, or operating-system process.
use super::*;
use crate::agsdl_host_work::{captured_work_contract030, CapturedWorkPlan030};
use crate::db::agsdl_execution::{
    dto::{EngineContext, EngineWork},
    flow030::{
        Activation030, FlowEffect030, FlowEffectKind030, FlowIdentity030, FlowPlan030,
        FlowState030, Instance030, WorkRef030,
    },
    flow_work_protocol030,
    start030::StartCapture030,
    work_dto030::ProtocolEvent030,
};
use sha2::{Digest, Sha256};
use sqlx::{query, query_scalar, SqlitePool};

async fn fixture() -> (
    tempfile::TempDir,
    SqlitePool,
    FlowIdentity030,
    ProtocolEvent030,
    Arc<HostState>,
    Arc<Incarnation>,
) {
    let tmp = tempfile::TempDir::new().unwrap();
    let pool = crate::db::create_pool(&tmp.path().join("work.db"))
        .await
        .unwrap();
    let id = FlowIdentity030 {
        system_start_id: "system".into(),
        flow_invocation_id: "flow".into(),
        snapshot_id: "snapshot".into(),
        epoch: "capture".into(),
    };
    let plan_json = include_str!("../tests/fixtures/agsdl030_compiled_plan.json");
    let plan: FlowPlan030 = serde_json::from_str(plan_json).unwrap();
    let capture = StartCapture030 {
        identity: id.clone(),
        source: serde_json::from_value(plan.source.clone()).unwrap(),
        versions: serde_json::from_value(serde_json::to_value(&plan.versions).unwrap()).unwrap(),
        authored_source: "{}".into(),
        compiled_plan_json: plan_json.into(),
        registry_json: "{}".into(),
        private_capture_json: "{}".into(),
    };
    let capture_raw = serde_json::to_string(&capture).unwrap();
    let capture_sha = format!("{:x}", Sha256::digest(capture_raw.as_bytes()));
    let owner = EngineOwner {
        system_start_id: "system".into(),
        owner_epoch: "owner".into(),
    };
    let work = EngineWork {
        system_start_id: "system".into(),
        flow_invocation_id: "flow".into(),
        activation_id: "work".into(),
        step: Some(vec!["left".into()]),
        agent_instance_id: Some("instance".into()),
    };
    let context = EngineContext {
        owner: owner.clone(),
        work: work.clone(),
        permissions_json: "[]".into(),
        scope_json: "{}".into(),
        registry_version: capture.versions.registry.clone(),
    };
    let mut state = FlowState030::new(id.clone());
    state.revision = "1".into();
    state.activations.push(Activation030 {
        id: "work".into(),
        step: Some(vec!["left".into()]),
        agent: Some("worker".into()),
        selector: Some(Instance030::Shared),
        delivery: "queue".into(),
        instance_id: Some("instance".into()),
        sender: None,
        context: vec![],
        phase: "running".into(),
        physical: true,
        physical_wait_groups: vec![],
        start_effect_id: Some("start".into()),
        stop_effect_id: None,
        input_json: "{}".into(),
        message_json: None,
        item_json: None,
        occurrence: None,
        producer: None,
        result: None,
    });
    let reference = WorkRef030 {
        activation_id: "work".into(),
        start_effect_id: "start".into(),
        agent_instance_id: Some("instance".into()),
    };
    let effect = FlowEffect030 {
        id: "start".into(),
        identity: id.clone(),
        revision: "1".into(),
        kind: FlowEffectKind030::Start {
            work: reference,
            step: Some(vec!["left".into()]),
            agent: Some("worker".into()),
            input_json: "{}".into(),
            message_json: None,
            item_json: None,
            occurrence: None,
            sender: None,
        },
    };
    let contract = captured_work_contract030(
        &CapturedWorkPlan030 {
            system_start_id: "system",
            source: &capture.source,
            versions: &capture.versions,
            compiled_plan_json: plan_json,
        },
        &work,
        "worker",
    )
    .unwrap();
    let options =
        r#"{"checkTimeoutMs":"1000","maxCheckOutputBytes":1024,"enforcedPlanLock":false}"#;
    let event_json = serde_json::json!({"owner":{"systemStartId":"system","activationId":"work","agentInstanceId":"instance","ownerEpoch":"owner"},"eventId":"event","event":{"kind":"visibleText","messageId":"message","textParts":["hello"]}}).to_string();
    let input = ProtocolEvent030 {
        context: context.clone(),
        event_id: "event".into(),
        expected_revision: "0".into(),
        event_json,
        native_call: None,
        control: false,
    };
    let mut tx = pool.begin().await.unwrap();
    query("INSERT INTO engine_flow030_runs VALUES (?,?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind("snapshot")
        .bind("capture")
        .bind(plan.source.to_string())
        .bind(plan_json)
        .bind(serde_json::to_string(&state).unwrap())
        .execute(&mut *tx)
        .await
        .unwrap();
    query("INSERT INTO engine_start030_requests VALUES (?,?,?,?,?,?,?,?)")
        .bind("request")
        .bind("{}")
        .bind("system")
        .bind("flow")
        .bind("snapshot")
        .bind("capture")
        .bind(&capture_raw)
        .bind("{}")
        .execute(&mut *tx)
        .await
        .unwrap();
    query("INSERT INTO engine_flow030_owners VALUES (?,?,?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind("snapshot")
        .bind("capture")
        .bind("owner")
        .bind("generation")
        .bind("live")
        .bind(&capture_sha)
        .execute(&mut *tx)
        .await
        .unwrap();
    query("INSERT INTO engine_flow030_events VALUES (?,?,?,?,?,NULL)")
        .bind("system")
        .bind("flow")
        .bind("seed")
        .bind("{}")
        .bind("{}")
        .execute(&mut *tx)
        .await
        .unwrap();
    query("INSERT INTO engine_flow030_outbox VALUES (?,?,?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind("start")
        .bind("seed")
        .bind(serde_json::to_string(&effect).unwrap())
        .bind("owner")
        .bind("settled")
        .bind("{}")
        .execute(&mut *tx)
        .await
        .unwrap();
    query("INSERT INTO engine_flow030_handoffs VALUES (?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind("start")
        .bind("owner")
        .bind("generation")
        .bind("{}")
        .execute(&mut *tx)
        .await
        .unwrap();
    query("INSERT INTO engine_flow030_work_admissions VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind("work")
        .bind("start")
        .bind("owner")
        .bind("generation")
        .bind(&capture_sha)
        .bind(serde_json::to_string(&context).unwrap())
        .bind(&contract)
        .bind(options)
        .bind("{}")
        .execute(&mut *tx)
        .await
        .unwrap();
    query("INSERT INTO engine_flow030_work_authorizations VALUES (?,?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind("event")
        .bind("work")
        .bind(serde_json::to_string(&input).unwrap())
        .bind(None::<String>)
        .bind(None::<String>)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let incarnation = Arc::new(Incarnation {
        generation: "generation".into(),
        compiler: Default::default(),
        work_protocol: Default::default(),
        route030: Default::default(),
        lifecycle: Arc::new(tokio::sync::RwLock::new(())),
        handoff: Mutex::new(()),
        live: AtomicBool::new(true),
        ready: AtomicBool::new(true),
        retired: Default::default(),
        owners: Mutex::new(BTreeMap::from([("system".into(), owner)])),
    });
    let host = Arc::new(HostState(
        Mutex::new(Some(OwnedHost {
            incarnation: incarnation.clone(),
        })),
        Arc::new(tokio::sync::Mutex::new(())),
        Default::default(),
    ));
    (tmp, pool, id, input, host, incarnation)
}

#[tokio::test(flavor = "current_thread")]
async fn real_controller_commit_lost_ack_requires_exact_native_readback() {
    let (_tmp, pool, id, input, host, _incarnation) = fixture().await;
    let hook = host.flow030().install_work_commit_hook(&id, "event");
    let host_task = host.clone();
    let pool_task = pool.clone();
    let id_task = id.clone();
    let task = tokio::spawn(async move {
        flow_work_protocol030::transition(
            &host_task,
            &pool_task,
            &id_task,
            &input,
            &tokio_util::sync::CancellationToken::new(),
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(20), hook.reached())
        .await
        .expect("controller did not reach the work commit hook");
    task.abort();
    assert!(matches!(task.await, Err(error) if error.is_cancelled()));
    assert!(host.flow030().available(&id).is_err());
    assert!(
        flow_work_protocol030::inspect_work_commit(&host, &pool, &id, "event")
            .await
            .unwrap()
            .is_some()
    );
    assert!(host.flow030().available(&id).is_ok());
    let decisions: i64 = query_scalar(
        "SELECT count(*) FROM engine_flow030_work_events WHERE decision_json IS NOT NULL",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let checks: i64 = query_scalar("SELECT count(*) FROM engine_flow030_work_checks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(decisions, 1);
    assert_eq!(checks, 0);
}

#[tokio::test]
async fn pending_native_reservation_retries_renews_and_replays_only_the_committed_decision() {
    for renew in [false, true] {
        let (_tmp, pool, id, input, host, incarnation) = fixture().await;
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let reached = Arc::new(tokio::sync::Notify::new());
        let notify = reached.clone();
        let (release, release_rx) = std::sync::mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        *incarnation.work_protocol.native.probe.lock().unwrap() = Some(Arc::new(move |_, _| {
            if count.fetch_add(1, Ordering::SeqCst) == 0 {
                notify.notify_one();
                release_rx.lock().unwrap().recv().unwrap();
            }
        }));
        let cancel = tokio_util::sync::CancellationToken::new();
        let first = flow_work_protocol030::transition(&host, &pool, &id, &input, &cancel);
        let exercise = async {
            reached.notified().await;
            cancel.cancel();
        };
        let (result, ()) = tokio::join!(first, exercise);
        assert_eq!(result.unwrap_err().code, "INTERRUPTED");
        let before: String = query_scalar(
            "SELECT ticket_json FROM engine_flow030_work_events WHERE event_id='event'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        release.send(()).unwrap();
        if renew {
            // A valid new flow revision leaves this work journal untouched.
            query(
                "UPDATE engine_flow030_runs SET state_json=json_set(state_json,'$.revision','2')",
            )
            .execute(&pool)
            .await
            .unwrap();
        }
        let decision = flow_work_protocol030::transition(
            &host,
            &pool,
            &id,
            &input,
            &tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
        let after: String = query_scalar(
            "SELECT ticket_json FROM engine_flow030_work_events WHERE event_id='event'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let before: serde_json::Value = serde_json::from_str(&before).unwrap();
        let after: serde_json::Value = serde_json::from_str(&after).unwrap();
        assert_eq!(before["ticketId"] == after["ticketId"], !renew);
        assert_eq!(after["flowRevision"], if renew { "2" } else { "1" });
        let replay = flow_work_protocol030::transition(
            &host,
            &pool,
            &id,
            &input,
            &tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(
            serde_json::to_value(decision).unwrap(),
            serde_json::to_value(replay).unwrap()
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "committed replay must not calculate again"
        );
    }
}

#[tokio::test]
async fn pending_native_reservation_rejects_foreign_generation_revision_contract_and_capture() {
    for change in ["generation", "revision", "contract", "capture"] {
        let (_tmp, pool, id, input, host, incarnation) = fixture().await;
        let reached = Arc::new(tokio::sync::Notify::new());
        let notify = reached.clone();
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let (release, release_rx) = std::sync::mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        *incarnation.work_protocol.native.probe.lock().unwrap() = Some(Arc::new(move |_, _| {
            count.fetch_add(1, Ordering::SeqCst);
            notify.notify_one();
            release_rx.lock().unwrap().recv().unwrap();
        }));
        let cancel = tokio_util::sync::CancellationToken::new();
        let (result, ()) = tokio::join!(
            flow_work_protocol030::transition(&host, &pool, &id, &input, &cancel),
            async {
                reached.notified().await;
                cancel.cancel();
            }
        );
        assert_eq!(result.unwrap_err().code, "INTERRUPTED");
        release.send(()).unwrap();
        let statement = match change {
            "generation" => "UPDATE engine_flow030_work_events SET ticket_json=json_set(ticket_json,'$.generation','foreign')",
            "revision" => "UPDATE engine_flow030_work_state SET revision='1'",
            "contract" => "UPDATE engine_flow030_work_events SET ticket_json=json_set(ticket_json,'$.contractJson','{}')",
            _ => "UPDATE engine_flow030_work_events SET ticket_json=json_set(ticket_json,'$.identity.snapshotId','foreign')",
        };
        query(statement).execute(&pool).await.unwrap();
        let result = flow_work_protocol030::transition(
            &host,
            &pool,
            &id,
            &input,
            &tokio_util::sync::CancellationToken::new(),
        )
        .await;
        assert_eq!(result.unwrap_err().code, "CORRELATION", "{change}");
        let count_decisions: i64 = query_scalar(
            "SELECT count(*) FROM engine_flow030_work_events WHERE decision_json IS NOT NULL",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count_decisions, 0);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn native_calculation_failure_is_local_but_explicit_retirement_fences_the_same_owner() {
    let (_tmp, pool, id, input, host, incarnation) = fixture().await;
    *incarnation.work_protocol.native.probe.lock().unwrap() =
        Some(Arc::new(|_, _| panic!("synthetic calculation failure")));
    let error = flow_work_protocol030::transition(
        &host,
        &pool,
        &id,
        &input,
        &tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "RUNTIME_UNAVAILABLE");
    assert!(host.start_lease().await.is_ok());
    let decisions: i64 = query_scalar(
        "SELECT count(*) FROM engine_flow030_work_events WHERE decision_json IS NOT NULL",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(decisions, 0);
    *incarnation.work_protocol.native.probe.lock().unwrap() = None;
    flow_work_protocol030::transition(
        &host,
        &pool,
        &id,
        &input,
        &tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap();
    host.revoke_native(&pool, &Default::default())
        .await
        .unwrap();
    assert!(host.start_lease().await.is_err());
    let status: String = query_scalar("SELECT status FROM engine_flow030_owners")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(status, "revoked");
    let replacement =
        route_attestation_test_host030(input.context.owner.clone(), &incarnation.generation);
    assert!(flow_work_protocol030::transition(
        &replacement,
        &pool,
        &id,
        &input,
        &tokio_util::sync::CancellationToken::new()
    )
    .await
    .is_err());
}
