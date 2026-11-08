//! Reducer/SQLite fixture for the opaque native control. This is not a real
//! Start, provider invocation, or proof of operating-system process termination.
use super::*;
use crate::db::agsdl_execution::flow030::{reduce, FlowPlan030, WorkRef030};

#[tokio::test]
async fn unclaimed_start_is_settled_atomically_without_a_handoff() {
    exercise(0).await;
}

#[tokio::test]
async fn uncertain_without_tombstone_does_not_prove_no_admission() {
    exercise(1).await;
}

#[tokio::test]
async fn durable_handoff_excludes_no_admission_even_after_stop() {
    exercise(2).await;
}

#[tokio::test]
async fn dropped_claim_guard_supplies_a_single_use_tombstone() {
    exercise(3).await;
}

#[tokio::test]
async fn system_stop_request_is_durable_idempotent_and_rejects_partial_scope() {
    exercise(4).await;
}

#[tokio::test]
async fn committed_stop_survives_lost_ack_and_requires_exact_readback() {
    exercise(5).await;
}

#[tokio::test]
async fn failed_stop_commit_keeps_the_barrier_when_no_row_exists() {
    exercise(6).await;
}

async fn exercise(mode: u8) {
    let temp = tempfile::TempDir::new().unwrap();
    let pool = crate::db::create_pool(&temp.path().join("unadmitted.db"))
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
    let enter = FlowEvent030 {
        identity: identity.clone(),
        event_id: "enter".into(),
        expected_revision: "0".into(),
        kind: FlowEventKind030::Enter {
            message_json: "{}".into(),
        },
    };
    let transition = reduce(&plan, &FlowState030::new(identity.clone()), &enter).unwrap();
    let start = transition
        .effects
        .iter()
        .find_map(|effect| match &effect.kind {
            FlowEffectKind030::Start { work, .. } => Some(work.clone()),
            _ => None,
        })
        .expect("fixture start");
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO engine_flow030_runs VALUES (?,?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind("snapshot")
        .bind("capture")
        .bind(plan.source.to_string())
        .bind(plan_json)
        .bind(serde_json::to_string(&transition.state).unwrap())
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
        .bind("revoked")
        .bind("a".repeat(64))
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_events VALUES (?,?,?,?,?,NULL)")
        .bind("system")
        .bind("flow")
        .bind("enter")
        .bind(serde_json::to_string(&enter).unwrap())
        .bind(serde_json::to_string(&transition.receipt).unwrap())
        .execute(&mut *tx)
        .await
        .unwrap();
    for effect in &transition.effects {
        let status = if effect.id == start.start_effect_id {
            match mode {
                1 | 3 => "uncertain",
                2 => "settled",
                _ => "pending",
            }
        } else {
            "pending"
        };
        let settlement = (status == "settled").then_some("{}");
        sqlx::query("INSERT INTO engine_flow030_outbox VALUES (?,?,?,?,?,?,?,?)")
            .bind("system")
            .bind("flow")
            .bind(&effect.id)
            .bind("enter")
            .bind(serde_json::to_string(effect).unwrap())
            .bind("owner")
            .bind(status)
            .bind(settlement)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    if mode == 2 {
        sqlx::query("INSERT INTO engine_flow030_handoffs VALUES (?,?,?,?,?,?)")
            .bind("system")
            .bind("flow")
            .bind(&start.start_effect_id)
            .bind("owner")
            .bind("generation")
            .bind("{}")
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    let runtime = Arc::new(FlowHost030::default());
    let control = Arc::new(FlowControl030 {
        owner: EngineOwner {
            system_start_id: "system".into(),
            owner_epoch: "owner".into(),
        },
        identity: identity.clone(),
        generation: "generation".into(),
        admission: Arc::new(tokio::sync::Mutex::new(())),
    });
    runtime
        .controls
        .lock()
        .unwrap()
        .insert("system".into(), control.clone());
    if mode == 5 {
        let request = crate::db::agsdl_execution::dto::EngineStopRequest {
            system_start_id: "system".into(),
            request_id: "lost-ack".into(),
            activation_id: None,
        };
        let hook = runtime.install_system_stop_commit_hook(&request.request_id);
        let runtime_task = runtime.clone();
        let pool_task = pool.clone();
        let request_task = request.clone();
        let task = tokio::spawn(async move {
            request_system_stop030(&runtime_task, &pool_task, &request_task).await
        });
        hook.reached().await;
        task.abort();
        assert!(matches!(task.await, Err(error) if error.is_cancelled()));
        assert!(runtime.available(&identity).is_err());
        let mut alias = request.clone();
        alias.request_id = "blocked-after-commit".into();
        assert!(request_system_stop030(&runtime, &pool, &alias)
            .await
            .is_err());
        let stored = inspect_system_stop_request030(&runtime, &pool, &request)
            .await
            .unwrap()
            .unwrap();
        assert!(stored.receipt().stopping);
        assert!(runtime.available(&identity).is_ok());
        return;
    }
    if mode == 6 {
        sqlx::raw_sql("CREATE TABLE test_stop_parent(id INTEGER PRIMARY KEY);\
            CREATE TABLE test_stop_child(id INTEGER REFERENCES test_stop_parent(id) DEFERRABLE INITIALLY DEFERRED);\
            CREATE TRIGGER test_stop_reject_commit AFTER INSERT ON engine_flow030_system_stop_requests BEGIN INSERT INTO test_stop_child VALUES (1); END;")
            .execute(&pool).await.unwrap();
        let request = crate::db::agsdl_execution::dto::EngineStopRequest {
            system_start_id: "system".into(),
            request_id: "commit-rejected".into(),
            activation_id: None,
        };
        assert!(request_system_stop030(&runtime, &pool, &request)
            .await
            .is_err());
        assert!(inspect_system_stop_request030(&runtime, &pool, &request)
            .await
            .unwrap()
            .is_none());
        assert!(runtime.available(&identity).is_err());
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM engine_flow030_system_stop_requests")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 0);
        return;
    }
    if mode == 4 {
        let tasks = crate::ai::stream_tasks::StreamTasks::default();
        assert_eq!(
            crate::agsdl_host_stop030::ensure(&runtime, &pool, &tasks, "system")
                .await
                .unwrap_err()
                .code,
            "UNCERTAIN"
        );
        let mut request = crate::db::agsdl_execution::dto::EngineStopRequest {
            system_start_id: "system".into(),
            request_id: "stop-request".into(),
            activation_id: Some(start.activation_id.clone()),
        };
        let error = crate::agsdl_host_stop030::request(&runtime, &pool, &tasks, &request)
            .await
            .unwrap_err();
        assert_eq!(error.code, "PARTIAL_STOP_UNAVAILABLE");
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM engine_flow030_system_stop_requests")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 0);
        request.activation_id = None;
        let first = request_system_stop030(&runtime, &pool, &request)
            .await
            .unwrap();
        let first_revision = first.receipt().revision.clone();
        assert!(first.receipt().stopping);
        assert!(
            !crate::agsdl_host_stop030::reconcile(&runtime, &pool, &tasks, first.control())
                .await
                .unwrap()
        );
        let replay = request_system_stop030(&runtime, &pool, &request)
            .await
            .unwrap();
        assert_eq!(replay.receipt().revision, first_revision);
        assert!(matches!(
            crate::agsdl_host_stop030::ensure(&runtime, &pool, &tasks, "system")
                .await
                .unwrap(),
            crate::db::agsdl_execution::public::PublicStopState::Requested { .. }
        ));
        let marker = stop_marker(first.receipt());
        runtime.begin_event_commit(&marker).unwrap();
        assert!(runtime.available(&identity).is_err());
        assert!(inspect_system_stop_request030(&runtime, &pool, &request)
            .await
            .unwrap()
            .is_some());
        assert!(runtime.available(&identity).is_ok());
        let mut absent_request = request.clone();
        absent_request.request_id = "absent".into();
        let mut absent_receipt = first.receipt().clone();
        absent_receipt.request_id = absent_request.request_id.clone();
        let absent_marker = stop_marker(&absent_receipt);
        runtime.begin_event_commit(&absent_marker).unwrap();
        assert!(
            inspect_system_stop_request030(&runtime, &pool, &absent_request)
                .await
                .unwrap()
                .is_none()
        );
        assert!(runtime.available(&identity).is_err());
        assert!(request_system_stop030(&runtime, &pool, &absent_request)
            .await
            .is_err());
        let mut blocked_alias = absent_request.clone();
        blocked_alias.request_id = "blocked-alias".into();
        assert!(request_system_stop030(&runtime, &pool, &blocked_alias)
            .await
            .is_err());
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM engine_flow030_system_stop_requests")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 1);
        runtime.acknowledge_event_commit(&absent_marker);

        let other_identity = FlowIdentity030 {
            system_start_id: "other-system".into(),
            flow_invocation_id: "other-flow".into(),
            snapshot_id: "other-snapshot".into(),
            epoch: "other-capture".into(),
        };
        sqlx::query("INSERT INTO engine_flow030_runs VALUES (?,?,?,?,?,?,?)")
            .bind(&other_identity.system_start_id)
            .bind(&other_identity.flow_invocation_id)
            .bind(&other_identity.snapshot_id)
            .bind(&other_identity.epoch)
            .bind("{}")
            .bind("{}")
            .bind("{}")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO engine_flow030_owners VALUES (?,?,?,?,?,?,?,?)")
            .bind(&other_identity.system_start_id)
            .bind(&other_identity.flow_invocation_id)
            .bind(&other_identity.snapshot_id)
            .bind(&other_identity.epoch)
            .bind("other-owner")
            .bind("generation")
            .bind("live")
            .bind("b".repeat(64))
            .execute(&pool)
            .await
            .unwrap();
        let other_control = Arc::new(FlowControl030 {
            owner: EngineOwner {
                system_start_id: other_identity.system_start_id.clone(),
                owner_epoch: "other-owner".into(),
            },
            identity: other_identity.clone(),
            generation: "generation".into(),
            admission: Arc::new(tokio::sync::Mutex::new(())),
        });
        runtime
            .controls
            .lock()
            .unwrap()
            .insert(other_identity.system_start_id.clone(), other_control);
        let mut foreign = request.clone();
        foreign.system_start_id = other_identity.system_start_id;
        assert!(request_system_stop030(&runtime, &pool, &foreign)
            .await
            .is_err());
        request.request_id = "stop-alias".into();
        let alias = request_system_stop030(&runtime, &pool, &request)
            .await
            .unwrap();
        assert!(alias.receipt().flow_event_id.is_none());
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM engine_flow030_system_stop_requests")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 2);
        return;
    }
    if mode == 3 {
        let effect = transition
            .effects
            .iter()
            .find(|effect| effect.id == start.start_effect_id)
            .unwrap()
            .clone();
        let guard = UnadmittedClaimGuard030 {
            runtime: &runtime,
            witness: Some(Unadmitted030 {
                owner: control.owner.clone(),
                generation: "generation".into(),
                effect,
            }),
        };
        drop(guard);
    }
    let stop = FlowEvent030 {
        identity: identity.clone(),
        event_id: "stop".into(),
        expected_revision: transition.state.revision,
        kind: FlowEventKind030::Stop,
    };
    control.apply(&pool, &stop).await.unwrap();
    assert!(control
        .settle_unadmitted(&FlowHost030::default(), &pool, &start)
        .await
        .is_err());
    if mode == 1 || mode == 2 {
        assert!(control
            .settle_unadmitted(&runtime, &pool, &start)
            .await
            .unwrap()
            .is_none());
        assert!(
            control
                .read(&pool)
                .await
                .unwrap()
                .state
                .activations
                .iter()
                .find(|a| a.id == start.activation_id)
                .unwrap()
                .physical
        );
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_flow030_no_admissions")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
        let tasks = crate::ai::stream_tasks::StreamTasks::default();
        let mut dropped = None;
        if mode == 2 {
            struct OnDrop(Option<tokio::sync::oneshot::Sender<()>>);
            impl Drop for OnDrop {
                fn drop(&mut self) {
                    if let Some(done) = self.0.take() {
                        let _ = done.send(());
                    }
                }
            }
            let (started, ready) = tokio::sync::oneshot::channel();
            let (finished, confirmed) = tokio::sync::oneshot::channel();
            tasks
                .start(
                    format!("flow030:system:{}", start.start_effect_id),
                    async move {
                        let _guard = OnDrop(Some(finished));
                        let _ = started.send(());
                        std::future::pending::<()>().await;
                    },
                )
                .unwrap();
            ready.await.unwrap();
            dropped = Some(confirmed);
        }
        assert!(
            crate::agsdl_host_stop030::reconcile(&runtime, &pool, &tasks, &control)
                .await
                .unwrap()
        );
        if let Some(confirmed) = dropped {
            confirmed.await.unwrap();
        }
        return;
    }
    sqlx::query("CREATE TRIGGER reject_proof BEFORE INSERT ON engine_flow030_no_admissions BEGIN SELECT RAISE(ABORT,'test rollback'); END")
        .execute(&pool).await.unwrap();
    assert!(control
        .settle_unadmitted(&runtime, &pool, &start)
        .await
        .is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_flow030_no_admissions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert!(
        control
            .read(&pool)
            .await
            .unwrap()
            .state
            .activations
            .iter()
            .find(|a| a.id == start.activation_id)
            .unwrap()
            .physical
    );
    sqlx::query("DROP TRIGGER reject_proof")
        .execute(&pool)
        .await
        .unwrap();
    let result = control
        .settle_unadmitted(&runtime, &pool, &start)
        .await
        .unwrap();
    assert!(result.is_some());
    let view = control.read(&pool).await.unwrap();
    assert!(
        !view
            .state
            .activations
            .iter()
            .find(|a| a.id == start.activation_id)
            .unwrap()
            .physical
    );
    let row: (String, String) = sqlx::query_as("SELECT status,settlement_json FROM engine_flow030_outbox WHERE system_id='system' AND effect_id=?")
        .bind(&start.start_effect_id).fetch_one(&pool).await.unwrap();
    assert_eq!(row.0, "settled");
    assert!(row.1.contains(if mode == 3 {
        "unreleasedNativeClaim"
    } else {
        "unclaimed"
    }));
    assert!(control
        .settle_unadmitted(&runtime, &pool, &start)
        .await
        .unwrap()
        .is_some());
    assert!(!crate::agsdl_host_stop030::reconcile(
        &runtime,
        &pool,
        &crate::ai::stream_tasks::StreamTasks::default(),
        &control,
    )
    .await
    .unwrap());
    let mut foreign: WorkRef030 = start;
    foreign.start_effect_id = "other".into();
    assert!(control
        .settle_unadmitted(&runtime, &pool, &foreign)
        .await
        .is_err());
}
