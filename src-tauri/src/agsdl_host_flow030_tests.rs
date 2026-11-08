//! Exercises the real flow façade with a locally seeded capture. This does not
//! qualify production capture, providers or operating-system confinement.
use super::*;
use crate::agsdl_host_flow030 as flow;
use crate::db::agsdl_execution::{
    flow030::{FlowEvent030, FlowEventKind030, FlowIdentity030, FlowPlan030, FlowState030},
    start030::StartCapture030,
};
use sha2::{Digest, Sha256};

#[tokio::test(flavor = "current_thread")]
async fn flow_handoff_is_owned_once_and_revocation_rejects_later_claims() {
    exercise_handoff(0).await;
}

#[tokio::test(flavor = "current_thread")]
async fn failed_handoff_never_polls_work_or_replays_uncertain_effect() {
    exercise_handoff(1).await;
}

#[tokio::test(flavor = "current_thread")]
async fn dropped_dispatch_lease_never_reissues_claim() {
    exercise_handoff(2).await;
}

async fn exercise_handoff(mode: u8) {
    let temp = tempfile::TempDir::new().unwrap();
    let pool = crate::db::create_pool(&temp.path().join("flow.db"))
        .await
        .unwrap();
    let identity = FlowIdentity030 {
        system_start_id: "system".into(),
        flow_invocation_id: "flow".into(),
        snapshot_id: "snapshot".into(),
        epoch: "capture".into(),
    };
    let plan_json = include_str!("../tests/fixtures/agsdl030_compiled_plan.json");
    let plan: FlowPlan030 = serde_json::from_str(plan_json).unwrap();
    let capture = StartCapture030 {
        identity: identity.clone(),
        source: serde_json::from_value(plan.source.clone()).unwrap(),
        versions: serde_json::from_value(serde_json::to_value(&plan.versions).unwrap()).unwrap(),
        authored_source: "{}".into(),
        compiled_plan_json: plan_json.into(),
        registry_json: "{}".into(),
        private_capture_json: "{}".into(),
    };
    let capture_json = serde_json::to_string(&capture).unwrap();
    let capture_sha = format!("{:x}", Sha256::digest(capture_json.as_bytes()));
    let state_json = serde_json::to_string(&FlowState030::new(identity.clone())).unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO engine_flow030_runs VALUES (?,?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind("snapshot")
        .bind("capture")
        .bind(plan.source.to_string())
        .bind(plan_json)
        .bind(state_json)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_start030_requests VALUES (?,?,?,?,?,?,?,?)")
        .bind("request")
        .bind("{}")
        .bind("system")
        .bind("flow")
        .bind("snapshot")
        .bind("capture")
        .bind(&capture_json)
        .bind("{}")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_owners VALUES (?,?,?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind("snapshot")
        .bind("capture")
        .bind("owner")
        .bind("generation")
        .bind("live")
        .bind(capture_sha)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let owner = EngineOwner {
        system_start_id: "system".into(),
        owner_epoch: "owner".into(),
    };
    let incarnation = Arc::new(Incarnation {
        generation: "generation".into(),
        compiler: Default::default(),
        work_protocol: Default::default(),
        lifecycle: Arc::new(tokio::sync::RwLock::new(())),
        handoff: Mutex::new(()),
        live: AtomicBool::new(true),
        ready: AtomicBool::new(true),
        retired: Default::default(),
        loads: AtomicUsize::new(0),
        owners: Mutex::new(BTreeMap::from([("system".into(), owner)])),
        qa_request: Mutex::new(None),
    });
    let host = HostState(
        Mutex::new(Some(OwnedHost {
            incarnation: incarnation.clone(),
            resource: 0,
        })),
        Arc::new(tokio::sync::Mutex::new(())),
        Default::default(),
    );
    let runtime = flow::FlowHost030::default();
    let event = FlowEvent030 {
        identity: identity.clone(),
        event_id: "enter".into(),
        expected_revision: "0".into(),
        kind: FlowEventKind030::Enter {
            message_json: "{}".into(),
        },
    };
    flow::apply_native_event(&runtime, &host, &pool, &event)
        .await
        .unwrap();
    let claim = flow::claim_next(&runtime, &host, &pool, &identity)
        .await
        .unwrap()
        .unwrap();
    let effect_id = claim.effect().id.clone();
    let tasks = crate::ai::stream_tasks::StreamTasks::default();
    let request_id = claim.request_id();
    if mode == 2 {
        drop(claim);
        assert!(!tasks.cancel_owned(&request_id).await.unwrap());
        let status: String = sqlx::query_scalar("SELECT status FROM engine_flow030_outbox WHERE system_id='system' AND invocation_id='flow' AND effect_id=?")
            .bind(&effect_id).fetch_one(&pool).await.unwrap();
        assert_eq!(status, "uncertain");
        assert!(flow::claim_next(&runtime, &host, &pool, &identity)
            .await
            .unwrap()
            .is_none());
        return;
    }
    let fail_handoff = mode == 1;
    if fail_handoff {
        sqlx::query("CREATE TRIGGER reject_flow_handoff BEFORE INSERT ON engine_flow030_handoffs BEGIN SELECT RAISE(ABORT, 'test rejection'); END")
            .execute(&pool).await.unwrap();
    }
    let (started, done) = tokio::sync::oneshot::channel();
    let result = claim
        .handoff(&tasks, async move {
            let _ = started.send(());
        })
        .await;
    if fail_handoff {
        assert!(result.is_err());
        assert!(
            done.await.is_err(),
            "work was polled after the failed handoff"
        );
    } else {
        result.unwrap();
        done.await.unwrap();
    }
    tasks.cancel_owned(&request_id).await.unwrap();
    let status: String = sqlx::query_scalar("SELECT status FROM engine_flow030_outbox WHERE system_id='system' AND invocation_id='flow' AND effect_id=?")
        .bind(&effect_id).fetch_one(&pool).await.unwrap();
    assert_eq!(status, if fail_handoff { "uncertain" } else { "settled" });
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM engine_flow030_handoffs WHERE system_id='system' AND effect_id=?",
    )
    .bind(&effect_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, i64::from(!fail_handoff));
    assert!(flow::claim_next(&runtime, &host, &pool, &identity)
        .await
        .unwrap()
        .is_none());
    assert!(revoke_now(&incarnation));
    assert!(flow::claim_next(&runtime, &host, &pool, &identity)
        .await
        .is_err());
}
