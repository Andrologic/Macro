//! Reducer/SQLite fixture for the opaque native control. This is not a real
//! Start, provider invocation, or proof of operating-system process termination.
use super::*;
use crate::persistence::flow030::{reduce, FlowPlan030, WorkRef030};

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

#[tokio::test]
async fn opaque_control_can_clean_up_while_work_commit_is_frozen() {
    exercise(7).await;
}

#[tokio::test]
async fn retained_join_witness_settles_diagnostic_stop_atomically_and_replays() {
    exercise(8).await;
}

#[tokio::test]
async fn diagnostic_stop_keeps_physical_and_pending_when_commit_marker_is_unresolved() {
    exercise(9).await;
}

async fn exercise(mode: u8) {
    let temp = tempfile::TempDir::new().unwrap();
    let pool = crate::sqlite::create_file(&temp.path().join("unadmitted.db"))
        .await
        .unwrap();
    let identity = FlowIdentity030 {
        system_start_id: "system".into(),
        flow_invocation_id: "flow".into(),
        snapshot_id: "snapshot".into(),
        epoch: "capture".into(),
    };
    let original_plan = include_str!("../tests/fixtures/agsdl030_compiled_plan.json");
    let mut plan: FlowPlan030 = serde_json::from_str(original_plan).unwrap();
    let plan_json = if mode == 8 || mode == 9 {
        plan.entry = Some(vec!["left".into()]);
        plan.scopes
            .iter_mut()
            .find(|scope| scope.address.is_empty())
            .unwrap()
            .entry = vec!["left".into()];
        serde_json::to_string(&plan).unwrap()
    } else {
        original_plan.to_owned()
    };
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
        .bind(&plan_json)
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
                2 | 8 | 9 => "settled",
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
    let attempt = if mode == 8 || mode == 9 {
        let effect = transition
            .effects
            .iter()
            .find(|e| e.id == start.start_effect_id)
            .unwrap();
        let (step, agent) = match &effect.kind {
            FlowEffectKind030::Start {
                step,
                agent: Some(agent),
                ..
            } => (step.clone(), agent.clone()),
            _ => panic!("agent fixture required"),
        };
        let attempt = FlowWorkAttempt030 {
            identity: identity.clone(),
            owner: EngineOwner {
                system_start_id: "system".into(),
                owner_epoch: "owner".into(),
            },
            generation: "generation".into(),
            work: crate::persistence::dto::EngineWork {
                system_start_id: "system".into(),
                flow_invocation_id: "flow".into(),
                activation_id: start.activation_id.clone(),
                step,
                agent_instance_id: start.agent_instance_id.clone(),
            },
            start_effect_id: start.start_effect_id.clone(),
            agent,
            provider_attempt_id: "joined-fixture-attempt".into(),
        };
        let request_id = format!(
            "flow030:{}:{}",
            identity.system_start_id,
            attempt.start_effect_id()
        );
        let handoff = json!({"kind":"nativeOwnedHandoff030","identity":identity,"effectId":attempt.start_effect_id(),"ownerEpoch":"owner","generation":"generation","requestId":request_id,"workAttempt":attempt});
        sqlx::query("INSERT INTO engine_flow030_handoffs VALUES (?,?,?,?,?,?)")
            .bind("system")
            .bind("flow")
            .bind(attempt.start_effect_id())
            .bind("owner")
            .bind("generation")
            .bind(handoff.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        let context = crate::persistence::dto::EngineContext {
            owner: attempt.owner().clone(),
            work: attempt.work().clone(),
            permissions_json: "[]".into(),
            scope_json: "{}".into(),
            registry_version: "fixture".into(),
        };
        let physical_id = format!("physical:{}", attempt.provider_attempt_id());
        sqlx::query("INSERT INTO engine_flow030_work_admissions VALUES (?,?,?,?,?,?,?,?,?,?,?)")
            .bind("system")
            .bind("flow")
            .bind(&start.activation_id)
            .bind(attempt.start_effect_id())
            .bind("owner")
            .bind("generation")
            .bind("a".repeat(64))
            .bind(serde_json::to_string(&context).unwrap())
            .bind("{}")
            .bind("{}")
            .bind("{}")
            .execute(&mut *tx)
            .await
            .unwrap();
        let physical_event = json!({"eventId":physical_id,"owner":{"systemStartId":"system","activationId":start.activation_id,"agentInstanceId":start.agent_instance_id,"ownerEpoch":"owner"},"event":{"kind":"physicalEnded","providerEnded":true,"effectsEnded":true}});
        let input = crate::persistence::work_dto030::ProtocolEvent030 {
            context: context.clone(),
            event_id: physical_id.clone(),
            expected_revision: "0".into(),
            event_json: physical_event.to_string(),
            native_call: None,
            control: true,
        };
        sqlx::query("INSERT INTO engine_flow030_work_authorizations VALUES (?,?,?,?,?,?,?)")
            .bind("system")
            .bind("flow")
            .bind(&physical_id)
            .bind(&start.activation_id)
            .bind(serde_json::to_string(&input).unwrap())
            .bind(None::<String>)
            .bind(None::<String>)
            .execute(&mut *tx)
            .await
            .unwrap();
        let ticket = json!({"identity":identity,"generation":"generation","input":input});
        let receipt = json!({"receiptId":format!("{}:1",start.activation_id),"revision":"1","owner":{"systemStartId":"system","activationId":start.activation_id,"agentInstanceId":start.agent_instance_id,"ownerEpoch":"owner"},"decision":{"kind":"finished","outcome":"failure","code":"AGENT_FAILED"}});
        let decision = json!({"receiptJson":receipt.to_string()});
        sqlx::query("INSERT INTO engine_flow030_work_events VALUES (?,?,?,?,?,?)")
            .bind("system")
            .bind("flow")
            .bind(&physical_id)
            .bind(&start.activation_id)
            .bind(ticket.to_string())
            .bind(decision.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        let event = FlowEvent030 {
            identity: identity.clone(),
            event_id: work_terminal_event_id030(&identity, &physical_id).unwrap(),
            expected_revision: transition.state.revision.clone(),
            kind: FlowEventKind030::WorkResult {
                work: start.clone(),
                result: crate::persistence::flow030::WorkResult030::Failed {
                    error: Failure030::new("AGENT_FAILED"),
                },
                physical: Some(PhysicalEvidence030 {
                    native_receipt_id: physical_id,
                    descendants_joined: true,
                }),
            },
        };
        sqlx::query("INSERT INTO engine_flow030_events VALUES (?,?,?,?,NULL,?)")
            .bind("system")
            .bind("flow")
            .bind(&event.event_id)
            .bind(serde_json::to_string(&event).unwrap())
            .bind(r#"{"code":"UNSPECIFIED_SHARED_CANCELLATION"}"#)
            .execute(&mut *tx)
            .await
            .unwrap();
        Some(attempt)
    } else {
        None
    };
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
    if let Some(attempt) = attempt {
        // The SQL rows above are explicit fixtures; the witness below is
        // produced by the real registry only after its owned future joins.
        let tasks = crate::tasks::StreamTasks::default();
        let request_id = format!(
            "flow030:{}:{}",
            identity.system_start_id,
            attempt.start_effect_id()
        );
        tasks
            .start_agent030(request_id, &attempt, async {})
            .unwrap();
        let joined = tasks.join_agent030(&attempt, false).await.unwrap();
        runtime.retain_diagnostic_join(&joined).unwrap();
        let stop = FlowEvent030 {
            identity: identity.clone(),
            event_id: "fixture-stop".into(),
            expected_revision: transition.state.revision.clone(),
            kind: FlowEventKind030::Stop,
        };
        control.apply(&pool, &stop).await.unwrap();
        let stopped = control.read(&pool).await.unwrap();
        let activation = stopped
            .state
            .activations
            .iter()
            .find(|a| a.id == start.activation_id)
            .unwrap();
        let stop_id = activation.stop_effect_id.clone().unwrap();
        assert!(activation.physical);
        let mut foreign_attempt = attempt.clone();
        foreign_attempt.provider_attempt_id = "foreign-attempt".into();
        let foreign_tasks = crate::tasks::StreamTasks::default();
        foreign_tasks
            .start_agent030(
                format!(
                    "flow030:{}:{}",
                    identity.system_start_id,
                    foreign_attempt.start_effect_id()
                ),
                &foreign_attempt,
                async {},
            )
            .unwrap();
        let foreign = foreign_tasks
            .join_agent030(&foreign_attempt, false)
            .await
            .unwrap();
        assert!(control
            .settle_joined_diagnostic(&runtime, &pool, &foreign, None)
            .await
            .is_err());
        let unchanged: String =
            sqlx::query_scalar("SELECT status FROM engine_flow030_outbox WHERE effect_id=?")
                .bind(&stop_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(unchanged, "pending");
        assert!(control
            .read(&pool)
            .await
            .unwrap()
            .state
            .activations
            .iter()
            .any(|a| a.id == start.activation_id && a.physical));
        if mode == 9 {
            let event = FlowEvent030 {
                identity: identity.clone(),
                event_id: work_terminal_event_id030(
                    &identity,
                    &format!("joined-stop:{}", attempt.provider_attempt_id()),
                )
                .unwrap(),
                expected_revision: stopped.state.revision.clone(),
                kind: FlowEventKind030::PhysicalEnded {
                    work: start.clone(),
                    stop_effect_id: Some(stop_id.clone()),
                    evidence: PhysicalEvidence030 {
                        native_receipt_id: format!("physical:{}", attempt.provider_attempt_id()),
                        descendants_joined: true,
                    },
                },
            };
            runtime.begin_event_commit(&event).unwrap();
            assert_eq!(
                control
                    .settle_joined_diagnostic(&runtime, &pool, &joined, None)
                    .await
                    .unwrap_err()
                    .code,
                "UNCERTAIN"
            );
            assert!(runtime.available(&identity).is_err());
            let pending: String =
                sqlx::query_scalar("SELECT status FROM engine_flow030_outbox WHERE effect_id=?")
                    .bind(&stop_id)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(pending, "pending");
            assert!(control
                .read(&pool)
                .await
                .unwrap()
                .state
                .activations
                .iter()
                .any(|a| a.id == start.activation_id && a.physical));
            return;
        }
        assert!(
            !crate::agsdl_host_stop030::reconcile(&runtime, &pool, &tasks, &control)
                .await
                .unwrap()
        );
        let after = control.read(&pool).await.unwrap();
        assert!(after
            .state
            .activations
            .iter()
            .any(|a| a.id == start.activation_id && !a.physical));
        let status: String =
            sqlx::query_scalar("SELECT status FROM engine_flow030_outbox WHERE effect_id=?")
                .bind(&stop_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "settled");
        let diagnostics: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM engine_flow030_events WHERE diagnostic_json IS NOT NULL",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(diagnostics, 1);
        assert!(matches!(
            control
                .settle_joined_diagnostic(&runtime, &pool, &joined, None)
                .await
                .unwrap(),
            Apply030::Replayed(_)
        ));
        assert!(runtime
            .diagnostic_join(&identity, &start.activation_id)
            .unwrap()
            .is_none());
        let contradictory = FlowEvent030 {
            identity: identity.clone(),
            event_id: work_terminal_event_id030(
                &identity,
                &format!("joined-stop:{}", attempt.provider_attempt_id()),
            )
            .unwrap(),
            expected_revision: "999".into(),
            kind: FlowEventKind030::PhysicalEnded {
                work: start.clone(),
                stop_effect_id: Some(stop_id.clone()),
                evidence: PhysicalEvidence030 {
                    native_receipt_id: format!("physical:{}", attempt.provider_attempt_id()),
                    descendants_joined: true,
                },
            },
        };
        runtime.begin_event_commit(&contradictory).unwrap();
        assert!(control
            .settle_joined_diagnostic(&runtime, &pool, &joined, None)
            .await
            .is_err());
        assert!(runtime.available(&identity).is_err());
        return;
    }
    let frozen_work = if mode == 7 {
        Some(
            runtime
                .begin_work_commit(&identity, "uncertain-work", "{}", "{}")
                .unwrap(),
        )
    } else {
        None
    };
    if mode == 5 {
        let request = crate::persistence::dto::EngineStopRequest {
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
        let request = crate::persistence::dto::EngineStopRequest {
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
        let tasks = crate::tasks::StreamTasks::default();
        assert_eq!(
            crate::agsdl_host_stop030::ensure(&runtime, &pool, &tasks, "system")
                .await
                .unwrap_err()
                .code,
            "UNCERTAIN"
        );
        let mut request = crate::persistence::dto::EngineStopRequest {
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
            crate::persistence::public::PublicStopState::Requested { .. }
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
        let tasks = crate::tasks::StreamTasks::default();
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
        &crate::tasks::StreamTasks::default(),
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
    if let Some(marker) = frozen_work {
        assert!(runtime.available(&identity).is_err());
        runtime.acknowledge_work_commit(&marker).unwrap(); // Fixture cleanup only.
    }
}

/// SQL owner and graph are fixtures; the parent and its join witness are real
/// registry operations. No provider or policy admission is asserted here.
#[tokio::test]
async fn claimed_group_stop_joins_exact_parent_and_replays_without_routing() {
    let temp = tempfile::tempdir().unwrap();
    let pool = crate::sqlite::create_file(&temp.path().join("group-stop.db"))
        .await
        .unwrap();
    let identity = FlowIdentity030 {
        system_start_id: "system".into(),
        flow_invocation_id: "flow".into(),
        snapshot_id: "snapshot".into(),
        epoch: "capture".into(),
    };
    let mut plan: FlowPlan030 = serde_json::from_str(include_str!(
        "../tests/fixtures/agsdl030_compiled_plan.json"
    ))
    .unwrap();
    plan.entry = Some(vec!["left".into()]);
    plan.scopes
        .iter_mut()
        .find(|s| s.address.is_empty())
        .unwrap()
        .entry = vec!["left".into()];
    let plan_json = serde_json::to_string(&plan).unwrap();
    let enter = FlowEvent030 {
        identity: identity.clone(),
        event_id: "enter".into(),
        expected_revision: "0".into(),
        kind: FlowEventKind030::Enter {
            message_json: "{}".into(),
        },
    };
    let initial = reduce(&plan, &FlowState030::new(identity.clone()), &enter).unwrap();
    let start_effect = initial
        .effects
        .iter()
        .find(|e| matches!(&e.kind, FlowEffectKind030::Start { agent: Some(_), .. }))
        .unwrap()
        .clone();
    let (work, step, agent) = match &start_effect.kind {
        FlowEffectKind030::Start {
            work,
            step,
            agent: Some(agent),
            ..
        } => (work.clone(), step.clone(), agent.clone()),
        _ => unreachable!(),
    };
    let owner = EngineOwner {
        system_start_id: "system".into(),
        owner_epoch: "owner".into(),
    };
    let capture = StartCapture030 {
        identity: identity.clone(),
        source: serde_json::from_value(plan.source.clone()).unwrap(),
        versions: serde_json::from_value(serde_json::to_value(&plan.versions).unwrap()).unwrap(),
        authored_source: "{}".into(),
        compiled_plan_json: plan_json.clone(),
        registry_json: "{}".into(),
        private_capture_json: "{}".into(),
    };
    let capture_json = serde_json::to_string(&capture).unwrap();
    let capture_sha = format!("{:x}", Sha256::digest(capture_json.as_bytes()));
    let attempt = FlowWorkAttempt030 {
        identity: identity.clone(),
        owner: owner.clone(),
        generation: "generation".into(),
        work: repository::dto::EngineWork {
            system_start_id: "system".into(),
            flow_invocation_id: "flow".into(),
            activation_id: work.activation_id.clone(),
            step,
            agent_instance_id: work.agent_instance_id.clone(),
        },
        start_effect_id: work.start_effect_id.clone(),
        agent,
        provider_attempt_id: "group-attempt".into(),
    };
    let request_id = format!(
        "flow030:{}:{}",
        identity.system_start_id,
        attempt.start_effect_id()
    );
    let handoff = json!({"kind":"nativeOwnedHandoff030","identity":identity,"effectId":attempt.start_effect_id(),"ownerEpoch":"owner","generation":"generation","requestId":request_id,"workAttempt":attempt});
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO engine_flow030_runs VALUES (?,?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind("snapshot")
        .bind("capture")
        .bind(plan.source.to_string())
        .bind(&plan_json)
        .bind(serde_json::to_string(&initial.state).unwrap())
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
        .bind(capture_json)
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
    sqlx::query("INSERT INTO engine_flow030_events VALUES (?,?,?,?,?,NULL)")
        .bind("system")
        .bind("flow")
        .bind("enter")
        .bind(serde_json::to_string(&enter).unwrap())
        .bind(serde_json::to_string(&initial.receipt).unwrap())
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_outbox VALUES (?,?,?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind(&start_effect.id)
        .bind("enter")
        .bind(serde_json::to_string(&start_effect).unwrap())
        .bind("owner")
        .bind("settled")
        .bind("{}")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_handoffs VALUES (?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind(&start_effect.id)
        .bind("owner")
        .bind("generation")
        .bind(handoff.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let host = crate::agsdl_host::route_attestation_test_host030(owner.clone(), "generation");
    let runtime = host.flow030();
    let control = Arc::new(FlowControl030 {
        owner: owner.clone(),
        identity: identity.clone(),
        generation: "generation".into(),
        admission: host.admission_lock(),
    });
    runtime
        .controls
        .lock()
        .unwrap()
        .insert("system".into(), control.clone());
    let stop = FlowEvent030 {
        identity: identity.clone(),
        event_id: "fixture-group-stop".into(),
        expected_revision: initial.state.revision.clone(),
        kind: FlowEventKind030::Stop,
    };
    control.apply(&pool, &stop).await.unwrap();
    // Model the reducer state after a group, rather than a system, has issued
    // the same StopWork. This remains an explicitly synthetic SQL fixture.
    let mut stopped = control.read(&pool).await.unwrap().state;
    stopped.stopping = false;
    let stop_id = stopped
        .activations
        .iter()
        .find(|a| a.id == work.activation_id)
        .unwrap()
        .stop_effect_id
        .clone()
        .unwrap();
    sqlx::query("UPDATE engine_flow030_runs SET state_json=?")
        .bind(serde_json::to_string(&stopped).unwrap())
        .execute(&pool)
        .await
        .unwrap();
    let raw: String =
        sqlx::query_scalar("SELECT effect_json FROM engine_flow030_outbox WHERE effect_id=?")
            .bind(&stop_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let effect: FlowEffect030 = serde_json::from_str(&raw).unwrap();
    let tasks = crate::tasks::StreamTasks::default();
    let (started, received) = tokio::sync::oneshot::channel();
    tasks
        .start_agent030(request_id, &attempt, async move {
            started.send(()).unwrap();
            std::future::pending::<()>().await
        })
        .unwrap();
    received.await.unwrap();
    let foreign = EngineOwner {
        system_start_id: "system".into(),
        owner_epoch: "foreign".into(),
    };
    assert!(crate::agsdl_host_dispatch030::dispatch_stop_work030(
        &host, &pool, &tasks, &foreign, &effect, &attempt
    )
    .await
    .is_err());
    let status: String =
        sqlx::query_scalar("SELECT status FROM engine_flow030_outbox WHERE effect_id=?")
            .bind(&stop_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "pending");
    let claim = claim_expected(runtime, &host, &pool, &identity, &stop_id)
        .await
        .unwrap()
        .unwrap()
        .into_stop_work(&attempt)
        .unwrap();
    let joined = crate::agsdl_host_dispatch030::cancel_and_join_owned_agent030(&tasks, &attempt)
        .await
        .unwrap();
    assert!(matches!(
        control
            .settle_joined_diagnostic(runtime, &pool, &joined, Some(&claim))
            .await
            .unwrap(),
        Apply030::Applied(_)
    ));
    let after = control.read(&pool).await.unwrap();
    assert!(after
        .state
        .activations
        .iter()
        .any(|a| a.id == work.activation_id && !a.physical));
    let status: String =
        sqlx::query_scalar("SELECT status FROM engine_flow030_outbox WHERE effect_id=?")
            .bind(&stop_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "settled");
    assert!(matches!(
        control
            .settle_joined_diagnostic(runtime, &pool, &joined, Some(&claim))
            .await
            .unwrap(),
        Apply030::Replayed(_)
    ));
    let routed: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM engine_flow030_outbox WHERE effect_json LIKE '%prepareRoute%'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(routed, 0);
}

/// SQL owner and graph are fixtures; the parent and its join witness are real
/// registry operations. No provider or policy admission is asserted here.
#[tokio::test]
async fn dispatch_stop_waits_for_registered_cleanup_and_rejects_late_result() {
    let temp = tempfile::tempdir().unwrap();
    let pool = crate::sqlite::create_file(&temp.path().join("delayed-group-stop.db"))
        .await
        .unwrap();
    let identity = FlowIdentity030 {
        system_start_id: "system".into(),
        flow_invocation_id: "flow".into(),
        snapshot_id: "snapshot".into(),
        epoch: "capture".into(),
    };
    let mut plan: FlowPlan030 = serde_json::from_str(include_str!(
        "../tests/fixtures/agsdl030_compiled_plan.json"
    ))
    .unwrap();
    plan.entry = Some(vec!["left".into()]);
    plan.scopes
        .iter_mut()
        .find(|s| s.address.is_empty())
        .unwrap()
        .entry = vec!["left".into()];
    let plan_json = serde_json::to_string(&plan).unwrap();
    let enter = FlowEvent030 {
        identity: identity.clone(),
        event_id: "enter".into(),
        expected_revision: "0".into(),
        kind: FlowEventKind030::Enter {
            message_json: "{}".into(),
        },
    };
    let initial = reduce(&plan, &FlowState030::new(identity.clone()), &enter).unwrap();
    let start_effect = initial
        .effects
        .iter()
        .find(|e| matches!(&e.kind, FlowEffectKind030::Start { agent: Some(_), .. }))
        .unwrap()
        .clone();
    let (work, step, agent) = match &start_effect.kind {
        FlowEffectKind030::Start {
            work,
            step,
            agent: Some(agent),
            ..
        } => (work.clone(), step.clone(), agent.clone()),
        _ => unreachable!(),
    };
    let owner = EngineOwner {
        system_start_id: "system".into(),
        owner_epoch: "owner".into(),
    };
    let capture = StartCapture030 {
        identity: identity.clone(),
        source: serde_json::from_value(plan.source.clone()).unwrap(),
        versions: serde_json::from_value(serde_json::to_value(&plan.versions).unwrap()).unwrap(),
        authored_source: "{}".into(),
        compiled_plan_json: plan_json.clone(),
        registry_json: "{}".into(),
        private_capture_json: "{}".into(),
    };
    let capture_json = serde_json::to_string(&capture).unwrap();
    let capture_sha = format!("{:x}", Sha256::digest(capture_json.as_bytes()));
    let attempt = FlowWorkAttempt030 {
        identity: identity.clone(),
        owner: owner.clone(),
        generation: "generation".into(),
        work: repository::dto::EngineWork {
            system_start_id: "system".into(),
            flow_invocation_id: "flow".into(),
            activation_id: work.activation_id.clone(),
            step,
            agent_instance_id: work.agent_instance_id.clone(),
        },
        start_effect_id: work.start_effect_id.clone(),
        agent,
        provider_attempt_id: "group-attempt".into(),
    };
    let request_id = format!(
        "flow030:{}:{}",
        identity.system_start_id,
        attempt.start_effect_id()
    );
    let handoff = json!({"kind":"nativeOwnedHandoff030","identity":identity,"effectId":attempt.start_effect_id(),"ownerEpoch":"owner","generation":"generation","requestId":request_id,"workAttempt":attempt});
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO engine_flow030_runs VALUES (?,?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind("snapshot")
        .bind("capture")
        .bind(plan.source.to_string())
        .bind(&plan_json)
        .bind(serde_json::to_string(&initial.state).unwrap())
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
        .bind(capture_json)
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
    sqlx::query("INSERT INTO engine_flow030_events VALUES (?,?,?,?,?,NULL)")
        .bind("system")
        .bind("flow")
        .bind("enter")
        .bind(serde_json::to_string(&enter).unwrap())
        .bind(serde_json::to_string(&initial.receipt).unwrap())
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_outbox VALUES (?,?,?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind(&start_effect.id)
        .bind("enter")
        .bind(serde_json::to_string(&start_effect).unwrap())
        .bind("owner")
        .bind("settled")
        .bind("{}")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_handoffs VALUES (?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind(&start_effect.id)
        .bind("owner")
        .bind("generation")
        .bind(handoff.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let host = crate::agsdl_host::route_attestation_test_host030(owner.clone(), "generation");
    let runtime = host.flow030();
    let control = Arc::new(FlowControl030 {
        owner: owner.clone(),
        identity: identity.clone(),
        generation: "generation".into(),
        admission: host.admission_lock(),
    });
    runtime
        .controls
        .lock()
        .unwrap()
        .insert("system".into(), control.clone());
    let stop = FlowEvent030 {
        identity: identity.clone(),
        event_id: "fixture-group-stop".into(),
        expected_revision: initial.state.revision.clone(),
        kind: FlowEventKind030::Stop,
    };
    control.apply(&pool, &stop).await.unwrap();
    // Model the reducer state after a group, rather than a system, has issued
    // the same StopWork. This remains an explicitly synthetic SQL fixture.
    let mut stopped = control.read(&pool).await.unwrap().state;
    stopped.stopping = false;
    let stop_id = stopped
        .activations
        .iter()
        .find(|a| a.id == work.activation_id)
        .unwrap()
        .stop_effect_id
        .clone()
        .unwrap();
    sqlx::query("UPDATE engine_flow030_runs SET state_json=?")
        .bind(serde_json::to_string(&stopped).unwrap())
        .execute(&pool)
        .await
        .unwrap();
    let raw: String =
        sqlx::query_scalar("SELECT effect_json FROM engine_flow030_outbox WHERE effect_id=?")
            .bind(&stop_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let effect: FlowEffect030 = serde_json::from_str(&raw).unwrap();
    let tasks = crate::tasks::StreamTasks::default();
    for kind in ["work", "generation", "attempt"] {
        let mut wrong_attempt = attempt.clone();
        if kind == "work" {
            wrong_attempt.work.activation_id.push_str("-other");
        } else if kind == "generation" {
            wrong_attempt.generation.push_str("-other");
        } else {
            wrong_attempt.provider_attempt_id.push_str("-other");
        }
        assert!(crate::agsdl_host_dispatch030::dispatch_stop_work030(
            &host,
            &pool,
            &tasks,
            &owner,
            &effect,
            &wrong_attempt,
        )
        .await
        .is_err());
        let status: String =
            sqlx::query_scalar("SELECT status FROM engine_flow030_outbox WHERE effect_id=?")
                .bind(&stop_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "pending");
    }
    let (started, received) = tokio::sync::oneshot::channel();
    tasks
        .start_agent030(request_id.clone(), &attempt, async move {
            started.send(()).unwrap();
            std::future::pending::<()>().await;
        })
        .unwrap();
    received.await.unwrap();
    let (release_cleanup, wait_cleanup) = tokio::sync::oneshot::channel::<()>();
    let cleanup = tokio::spawn(async move {
        wait_cleanup.await.map_err(|error| error.to_string())?;
        Ok(())
    });
    tasks.attach_test_cleanup030(&request_id, cleanup).unwrap();
    let stop_future = crate::agsdl_host_dispatch030::dispatch_stop_work030(
        &host, &pool, &tasks, &owner, &effect, &attempt,
    );
    tokio::pin!(stop_future);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            tokio::select! {
                result = &mut stop_future => panic!("dispatch returned before cleanup: {result:?}"),
                _ = tokio::time::sleep(std::time::Duration::from_millis(10)) => {}
            }
            let status: String =
                sqlx::query_scalar("SELECT status FROM engine_flow030_outbox WHERE effect_id=?")
                    .bind(&stop_id)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            if status == "uncertain" {
                break;
            }
            assert_eq!(status, "pending");
        }
    })
    .await
    .expect("dispatch did not claim StopWork");
    let waiting = control.read(&pool).await.unwrap().state;
    assert!(waiting
        .activations
        .iter()
        .any(|a| a.id == work.activation_id && a.physical && a.phase == "stopping"));
    let late = FlowEvent030 {
        identity: identity.clone(),
        event_id: "late-result".into(),
        expected_revision: waiting.revision.clone(),
        kind: FlowEventKind030::WorkResult {
            work: work.clone(),
            result: crate::persistence::flow030::WorkResult030::Completed {
                output_json: "{}".into(),
                route_key: None,
            },
            physical: None,
        },
    };
    assert!(matches!(
        reduce(&plan, &waiting, &late),
        Err(crate::persistence::flow030::FlowInputError030::StaleReference)
    ));
    let concurrent_stop = FlowEvent030 {
        identity: identity.clone(),
        event_id: "concurrent-system-stop".into(),
        expected_revision: waiting.revision.clone(),
        kind: FlowEventKind030::Stop,
    };
    assert!(matches!(
        control.apply(&pool, &concurrent_stop).await.unwrap(),
        Apply030::Applied(_)
    ));
    assert!(control.read(&pool).await.unwrap().state.stopping);
    let before_routes: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM engine_flow030_outbox WHERE effect_json LIKE '%prepareRoute%'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    tokio::select! {
        result = &mut stop_future => panic!("dispatch returned with cleanup still blocked: {result:?}"),
        _ = tokio::time::sleep(std::time::Duration::from_millis(40)) => {}
    }
    let status: String =
        sqlx::query_scalar("SELECT status FROM engine_flow030_outbox WHERE effect_id=?")
            .bind(&stop_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "uncertain");
    release_cleanup.send(()).unwrap();
    assert!(matches!(
        tokio::time::timeout(std::time::Duration::from_secs(5), &mut stop_future)
            .await
            .unwrap()
            .unwrap(),
        Apply030::Applied(_)
    ));
    let after = control.read(&pool).await.unwrap().state;
    assert!(after
        .activations
        .iter()
        .any(|a| a.id == work.activation_id && !a.physical && a.phase != "running"));
    let status: String =
        sqlx::query_scalar("SELECT status FROM engine_flow030_outbox WHERE effect_id=?")
            .bind(&stop_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "settled");
    let settled: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM engine_flow030_outbox WHERE effect_id=? AND status='settled'",
    )
    .bind(&stop_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(settled, 1);
    let routes: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM engine_flow030_outbox WHERE effect_json LIKE '%prepareRoute%'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(routes, before_routes);
    let events: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM engine_flow030_events WHERE event_json LIKE '%PhysicalEnded%'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(events, 1);
    assert!(crate::agsdl_host_dispatch030::dispatch_stop_work030(
        &host, &pool, &tasks, &owner, &effect, &attempt
    )
    .await
    .is_err());
    let events_after: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM engine_flow030_events WHERE event_json LIKE '%PhysicalEnded%'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(events_after, events);
}

/// The reducer state and 04 journal are synthetic fixtures. The terminal is
/// produced by the real 04 validator and the witness by the owned registry.
#[tokio::test]
async fn validated_work_result_diagnostic_retains_join_for_real_stop_cleanup() {
    use crate::persistence::flow030::{
        DeliveryOccurrence030, PreparedBatch030, PreparedItem030, PreparedResult030, Target030,
        WorkResult030,
    };
    use crate::persistence::flow_work_protocol030::{test_accepted_terminal030, FlowWorkTicket030};
    use crate::persistence::work_dto030::{ProtocolDecision030, ProtocolEvent030};
    let temp = tempfile::tempdir().unwrap();
    let pool = crate::sqlite::create_file(&temp.path().join("diagnostic-joined.db"))
        .await
        .unwrap();
    let identity = FlowIdentity030 {
        system_start_id: "system".into(),
        flow_invocation_id: "flow".into(),
        snapshot_id: "snapshot".into(),
        epoch: "capture".into(),
    };
    let plan: FlowPlan030 = serde_json::from_str(include_str!(
        "../tests/fixtures/agsdl030_shared_stop_active_compiled_plan.json"
    ))
    .unwrap();
    let plan_json = serde_json::to_string(&plan).unwrap();
    let capture = StartCapture030 {
        identity: identity.clone(),
        source: serde_json::from_value(plan.source.clone()).unwrap(),
        versions: serde_json::from_value(serde_json::to_value(&plan.versions).unwrap()).unwrap(),
        authored_source: "{}".into(),
        compiled_plan_json: plan_json.clone(),
        registry_json: "{}".into(),
        private_capture_json: "{}".into(),
    };
    let owner = EngineOwner {
        system_start_id: "system".into(),
        owner_epoch: "owner".into(),
    };
    let mut state = FlowState030::new(identity.clone());
    let mut history = Vec::new();
    let enter = FlowEvent030 {
        identity: identity.clone(),
        event_id: "enter".into(),
        expected_revision: state.revision.clone(),
        kind: FlowEventKind030::Enter {
            message_json: "{}".into(),
        },
    };
    let t = reduce(&plan, &state, &enter).unwrap();
    state = t.state.clone();
    history.push((enter, t));
    let origin = state
        .activations
        .iter()
        .find(|a| a.step.as_deref() == Some(&["o".to_string()][..]) && a.physical)
        .unwrap();
    let origin_work = WorkRef030 {
        activation_id: origin.id.clone(),
        start_effect_id: origin.start_effect_id.clone().unwrap(),
        agent_instance_id: origin.instance_id.clone(),
    };
    let event = FlowEvent030 {
        identity: identity.clone(),
        event_id: "origin".into(),
        expected_revision: state.revision.clone(),
        kind: FlowEventKind030::WorkResult {
            work: origin_work,
            result: WorkResult030::Completed {
                output_json: r#"{"choice":"approve","results":{"items":["x","y"]}}"#.into(),
                route_key: Some("approve".into()),
            },
            physical: Some(PhysicalEvidence030 {
                native_receipt_id: "synthetic-origin-joined".into(),
                descendants_joined: true,
            }),
        },
    };
    let t = reduce(&plan, &state, &event).unwrap();
    state = t.state.clone();
    history.push((event, t));
    let prep = state
        .preparations
        .iter()
        .find(|p| p.status == "pending")
        .unwrap()
        .clone();
    let route = plan
        .routes
        .iter()
        .find(|r| {
            r.source == prep.reference.route.source
                && r.kind == prep.reference.route.kind
                && r.key == prep.reference.route.key
        })
        .unwrap();
    let batches = route
        .targets
        .iter()
        .enumerate()
        .map(|(ordinal, target)| {
            let Target030::Step {
                address,
                each_path_json,
                ..
            } = target
            else {
                panic!("fixture requires steps")
            };
            let values = if each_path_json.is_some() {
                vec![Some("\"x\"".to_owned()), Some("\"y\"".to_owned())]
            } else {
                vec![None]
            };
            let agent = plan
                .steps
                .iter()
                .find(|s| s.address == *address)
                .unwrap()
                .r#type
                == "agent";
            PreparedBatch030 {
                target_ordinal: ordinal,
                target: target.clone(),
                items: values
                    .into_iter()
                    .enumerate()
                    .map(|(index, item_json)| PreparedItem030 {
                        message_json: agent.then(|| "{}".into()),
                        item_json,
                        occurrence: DeliveryOccurrence030 {
                            native_receipt_id: "synthetic-prepare".into(),
                            target_ordinal: ordinal,
                            item_index: index.to_string(),
                        },
                    })
                    .collect(),
            }
        })
        .collect();
    let event = FlowEvent030 {
        identity: identity.clone(),
        event_id: "prepared".into(),
        expected_revision: state.revision.clone(),
        kind: FlowEventKind030::Prepared {
            reference: prep.reference,
            native_receipt_id: "synthetic-prepare".into(),
            result: PreparedResult030::Ready { batches },
        },
    };
    let t = reduce(&plan, &state, &event).unwrap();
    state = t.state.clone();
    history.push((event, t));
    let activation = state
        .activations
        .iter()
        .find(|a| a.step.as_deref() == Some(&["a".to_string()][..]) && a.phase == "running")
        .unwrap();
    let work = WorkRef030 {
        activation_id: activation.id.clone(),
        start_effect_id: activation.start_effect_id.clone().unwrap(),
        agent_instance_id: activation.instance_id.clone(),
    };
    let attempt = FlowWorkAttempt030 {
        identity: identity.clone(),
        owner: owner.clone(),
        generation: "generation".into(),
        work: repository::dto::EngineWork {
            system_start_id: "system".into(),
            flow_invocation_id: "flow".into(),
            activation_id: work.activation_id.clone(),
            step: activation.step.clone(),
            agent_instance_id: work.agent_instance_id.clone(),
        },
        start_effect_id: work.start_effect_id.clone(),
        agent: activation.agent.clone().unwrap(),
        provider_attempt_id: "joined-attempt".into(),
    };
    let tasks = crate::tasks::StreamTasks::default();
    let request_id = format!(
        "flow030:{}:{}",
        identity.system_start_id, work.start_effect_id
    );
    tasks
        .start_agent030(request_id.clone(), &attempt, async {})
        .unwrap();
    let joined = tasks.join_agent030(&attempt, false).await.unwrap();
    let context = repository::dto::EngineContext {
        owner: owner.clone(),
        work: attempt.work().clone(),
        permissions_json: "[]".into(),
        scope_json: "{}".into(),
        registry_version: capture.versions.registry.clone(),
    };
    let physical_id = format!("physical:{}", attempt.provider_attempt_id());
    let owner_json = json!({"systemStartId":"system","activationId":work.activation_id,"agentInstanceId":work.agent_instance_id,"ownerEpoch":"owner"});
    let input = ProtocolEvent030 {context:context.clone(),event_id:physical_id.clone(),expected_revision:"0".into(),event_json:json!({"eventId":physical_id,"owner":owner_json,"event":{"kind":"physicalEnded","providerEnded":true,"effectsEnded":true}}).to_string(),native_call:None,control:true};
    let receipt = json!({"receiptId":format!("{}:1",work.activation_id),"owner":owner_json,"revision":"1","decision":{"kind":"finished","outcome":"success","output":{"text":"","resultsJson":"{}","choice":"one"}}});
    let ticket = FlowWorkTicket030 {
        identity: identity.clone(),
        input: input.clone(),
        ticket_id: "synthetic-ticket".into(),
        generation: "generation".into(),
        flow_revision: state.revision.clone(),
        state_json: "{}".into(),
        contract_json: "{}".into(),
        options_json: "{}".into(),
    };
    let decision = ProtocolDecision030 {
        state_json: "{}".into(),
        receipt_json: receipt.to_string(),
        check: None,
    };
    let terminal = test_accepted_terminal030(&attempt, &joined, &ticket, &decision)
        .unwrap()
        .unwrap();
    let capture_json = serde_json::to_string(&capture).unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO engine_flow030_runs VALUES (?,?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind("snapshot")
        .bind("capture")
        .bind(plan.source.to_string())
        .bind(&plan_json)
        .bind(serde_json::to_string(&state).unwrap())
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
        .bind(format!("{:x}", Sha256::digest(capture_json.as_bytes())))
        .execute(&mut *tx)
        .await
        .unwrap();
    for (event, transition) in &history {
        sqlx::query("INSERT INTO engine_flow030_events VALUES (?,?,?,?,?,NULL)")
            .bind("system")
            .bind("flow")
            .bind(&event.event_id)
            .bind(serde_json::to_string(event).unwrap())
            .bind(serde_json::to_string(&transition.receipt).unwrap())
            .execute(&mut *tx)
            .await
            .unwrap();
        for effect in &transition.effects {
            sqlx::query("INSERT INTO engine_flow030_outbox VALUES (?,?,?,?,?,?,?,?)")
                .bind("system")
                .bind("flow")
                .bind(&effect.id)
                .bind(&event.event_id)
                .bind(serde_json::to_string(effect).unwrap())
                .bind("owner")
                .bind("settled")
                .bind("{}")
                .execute(&mut *tx)
                .await
                .unwrap();
        }
    }
    let handoff = json!({"kind":"nativeOwnedHandoff030","identity":identity,"effectId":work.start_effect_id,"ownerEpoch":"owner","generation":"generation","requestId":request_id,"workAttempt":attempt});
    sqlx::query("INSERT INTO engine_flow030_handoffs VALUES (?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind(&work.start_effect_id)
        .bind("owner")
        .bind("generation")
        .bind(handoff.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_work_admissions VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind(&work.activation_id)
        .bind(&work.start_effect_id)
        .bind("owner")
        .bind("generation")
        .bind(format!("{:x}", Sha256::digest(capture_json.as_bytes())))
        .bind(serde_json::to_string(&context).unwrap())
        .bind("{}")
        .bind("{}")
        .bind("{}")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_work_authorizations VALUES (?,?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind(&physical_id)
        .bind(&work.activation_id)
        .bind(serde_json::to_string(&input).unwrap())
        .bind(None::<String>)
        .bind(None::<String>)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_work_events VALUES (?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind(&physical_id)
        .bind(&work.activation_id)
        .bind(serde_json::to_string(&ticket).unwrap())
        .bind(serde_json::to_string(&decision).unwrap())
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let host = crate::agsdl_host::route_attestation_test_host030(owner.clone(), "generation");
    let runtime = host.flow030();
    let control = Arc::new(FlowControl030 {
        owner,
        identity: identity.clone(),
        generation: "generation".into(),
        admission: host.admission_lock(),
    });
    runtime
        .controls
        .lock()
        .unwrap()
        .insert("system".into(), control.clone());
    let lease = host.start_lease().await.unwrap();
    let gate = host.admission_lock().lock_owned().await;
    let mut tx = pool.begin().await.unwrap();
    let applied = apply_work_terminal_tx(runtime, &mut tx, &lease, &terminal, &joined)
        .await
        .unwrap();
    assert!(matches!(applied, Apply030::Diagnostic(_)));
    tx.commit().await.unwrap();
    drop(gate);
    drop(lease);
    assert!(
        runtime
            .diagnostic_join(&identity, &work.activation_id)
            .unwrap()
            .is_some(),
        "terminal diagnostic must retain the real joined witness"
    );
    let before = control.read(&pool).await.unwrap();
    let stop = FlowEvent030 {
        identity: identity.clone(),
        event_id: "stop".into(),
        expected_revision: before.state.revision,
        kind: FlowEventKind030::Stop,
    };
    control.apply(&pool, &stop).await.unwrap();
    crate::agsdl_host_stop030::reconcile(runtime, &pool, &tasks, &control)
        .await
        .unwrap();
    let after = control.read(&pool).await.unwrap();
    assert!(after
        .state
        .activations
        .iter()
        .any(|a| a.id == work.activation_id && !a.physical));
    let stop_effect = after
        .effects
        .iter()
        .find(|r| {
            r["effect"]["kind"]["kind"] == "stopWork"
                && r["effect"]["kind"]["work"]["activationId"] == work.activation_id
        })
        .unwrap();
    assert_eq!(stop_effect["status"], "settled");
    let diagnostics: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM engine_flow030_events WHERE diagnostic_json IS NOT NULL",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(diagnostics, 1);
    assert!(runtime
        .diagnostic_join(&identity, &work.activation_id)
        .unwrap()
        .is_none());
}

/// The plan and SQL rows are fixtures; group decisions use the real reducer,
/// and dispatch joins the actual owned registry and its delayed cleanup.
#[tokio::test]
async fn dispatch_stop_waits_for_cleanup_before_one_real_group_continuation() {
    exercise_real_group_stop(false).await;
}

#[tokio::test]
async fn generation_revoked_during_group_join_never_releases_the_continuation() {
    exercise_real_group_stop(true).await;
}

async fn exercise_real_group_stop(revoke_during_join: bool) {
    use crate::persistence::flow030::{
        DeliveryOccurrence030, PreparedBatch030, PreparedItem030, PreparedResult030, Target030,
        WorkResult030,
    };
    let temp = tempfile::tempdir().unwrap();
    let pool = crate::sqlite::create_file(&temp.path().join("real-group-stop.db"))
        .await
        .unwrap();
    let identity = FlowIdentity030 {
        system_start_id: "system".into(),
        flow_invocation_id: "flow".into(),
        snapshot_id: "snapshot".into(),
        epoch: "capture".into(),
    };
    let mut plan: FlowPlan030 = serde_json::from_str(include_str!(
        "../tests/fixtures/agsdl030_shared_stop_active_compiled_plan.json"
    ))
    .unwrap();
    for route in &mut plan.routes {
        if route.source == vec!["o".to_string()] {
            for target in &mut route.targets {
                if let Target030::Step {
                    concurrency_json, ..
                } = target
                {
                    *concurrency_json = Some("2".into());
                }
            }
        }
        if route.source == vec!["j2".to_string()] && route.key.as_deref() == Some("reached") {
            route.targets = vec![Target030::Step {
                address: vec!["o".into()],
                message_json: None,
                each_path_json: None,
                concurrency_json: None,
                max_json: None,
            }];
        }
    }
    for join in &mut plan.joins {
        if join.address == vec!["j2".to_string()] {
            join.quorum_count_json = Some("1".into());
        }
    }
    let plan_json = serde_json::to_string(&plan).unwrap();
    let capture = StartCapture030 {
        identity: identity.clone(),
        source: serde_json::from_value(plan.source.clone()).unwrap(),
        versions: serde_json::from_value(serde_json::to_value(&plan.versions).unwrap()).unwrap(),
        authored_source: "{}".into(),
        compiled_plan_json: plan_json.clone(),
        registry_json: "{}".into(),
        private_capture_json: "{}".into(),
    };
    let owner = EngineOwner {
        system_start_id: "system".into(),
        owner_epoch: "owner".into(),
    };
    let mut state = FlowState030::new(identity.clone());
    let mut history = Vec::new();
    let enter = FlowEvent030 {
        identity: identity.clone(),
        event_id: "enter".into(),
        expected_revision: state.revision.clone(),
        kind: FlowEventKind030::Enter {
            message_json: "{}".into(),
        },
    };
    let t = reduce(&plan, &state, &enter).unwrap();
    state = t.state.clone();
    history.push((enter, t));
    let origin = state
        .activations
        .iter()
        .find(|a| a.step.as_deref() == Some(&["o".to_string()][..]) && a.physical)
        .unwrap();
    let origin_work = WorkRef030 {
        activation_id: origin.id.clone(),
        start_effect_id: origin.start_effect_id.clone().unwrap(),
        agent_instance_id: origin.instance_id.clone(),
    };
    let event = FlowEvent030 {
        identity: identity.clone(),
        event_id: "origin".into(),
        expected_revision: state.revision.clone(),
        kind: FlowEventKind030::WorkResult {
            work: origin_work,
            result: WorkResult030::Completed {
                output_json: r#"{"choice":"approve","results":{"items":["x","y"]}}"#.into(),
                route_key: Some("approve".into()),
            },
            physical: Some(PhysicalEvidence030 {
                native_receipt_id: "synthetic-origin-joined".into(),
                descendants_joined: true,
            }),
        },
    };
    let t = reduce(&plan, &state, &event).unwrap();
    state = t.state.clone();
    history.push((event, t));
    let prep = state
        .preparations
        .iter()
        .find(|p| p.status == "pending")
        .unwrap()
        .clone();
    let route = plan
        .routes
        .iter()
        .find(|r| {
            r.source == prep.reference.route.source
                && r.kind == prep.reference.route.kind
                && r.key == prep.reference.route.key
        })
        .unwrap();
    let batches = route
        .targets
        .iter()
        .enumerate()
        .map(|(ordinal, target)| {
            let Target030::Step {
                address,
                each_path_json,
                ..
            } = target
            else {
                panic!("fixture requires steps")
            };
            let values = if each_path_json.is_some() {
                vec![Some("\"x\"".to_owned()), Some("\"y\"".to_owned())]
            } else {
                vec![None]
            };
            let agent = plan
                .steps
                .iter()
                .find(|s| s.address == *address)
                .unwrap()
                .r#type
                == "agent";
            PreparedBatch030 {
                target_ordinal: ordinal,
                target: target.clone(),
                items: values
                    .into_iter()
                    .enumerate()
                    .map(|(index, item_json)| PreparedItem030 {
                        message_json: agent.then(|| "{}".into()),
                        item_json,
                        occurrence: DeliveryOccurrence030 {
                            native_receipt_id: "synthetic-prepare".into(),
                            target_ordinal: ordinal,
                            item_index: index.to_string(),
                        },
                    })
                    .collect(),
            }
        })
        .collect();
    let event = FlowEvent030 {
        identity: identity.clone(),
        event_id: "prepared".into(),
        expected_revision: state.revision.clone(),
        kind: FlowEventKind030::Prepared {
            reference: prep.reference,
            native_receipt_id: "synthetic-prepare".into(),
            result: PreparedResult030::Ready { batches },
        },
    };
    let t = reduce(&plan, &state, &event).unwrap();
    state = t.state.clone();
    history.push((event, t));
    let workers = state
        .activations
        .iter()
        .filter(|a| a.step.as_deref() == Some(&["a".to_string()][..]) && a.phase == "running")
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(workers.len(), 2);
    let completed = WorkRef030 {
        activation_id: workers[0].id.clone(),
        start_effect_id: workers[0].start_effect_id.clone().unwrap(),
        agent_instance_id: workers[0].instance_id.clone(),
    };
    let event = FlowEvent030 {
        identity: identity.clone(),
        event_id: "first-branch".into(),
        expected_revision: state.revision.clone(),
        kind: FlowEventKind030::WorkResult {
            work: completed,
            result: WorkResult030::Completed {
                output_json: r#"{"choice":"two"}"#.into(),
                route_key: Some("two".into()),
            },
            physical: Some(PhysicalEvidence030 {
                native_receipt_id: "first-joined".into(),
                descendants_joined: true,
            }),
        },
    };
    let t = reduce(&plan, &state, &event).unwrap();
    state = t.state.clone();
    history.push((event, t));
    let group = state
        .groups
        .iter()
        .find(|g| g.join == vec!["j2".to_string()])
        .unwrap();
    assert_eq!(group.decision.as_deref(), Some("reached"));
    assert!(!group.released);
    let effect = history
        .last()
        .unwrap()
        .1
        .effects
        .iter()
        .find(|e| matches!(&e.kind, FlowEffectKind030::StopWork { .. }))
        .unwrap()
        .clone();
    let work = match &effect.kind {
        FlowEffectKind030::StopWork { work, .. } => work.clone(),
        _ => unreachable!(),
    };
    let activation = state
        .activations
        .iter()
        .find(|a| a.id == work.activation_id)
        .unwrap();
    let attempt = FlowWorkAttempt030 {
        identity: identity.clone(),
        owner: owner.clone(),
        generation: "generation".into(),
        work: repository::dto::EngineWork {
            system_start_id: "system".into(),
            flow_invocation_id: "flow".into(),
            activation_id: work.activation_id.clone(),
            step: activation.step.clone(),
            agent_instance_id: work.agent_instance_id.clone(),
        },
        start_effect_id: work.start_effect_id.clone(),
        agent: activation.agent.clone().unwrap(),
        provider_attempt_id: "real-group-attempt".into(),
    };
    let request_id = format!(
        "flow030:{}:{}",
        identity.system_start_id,
        attempt.start_effect_id()
    );
    let capture_json = serde_json::to_string(&capture).unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO engine_flow030_runs VALUES (?,?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind("snapshot")
        .bind("capture")
        .bind(plan.source.to_string())
        .bind(&plan_json)
        .bind(serde_json::to_string(&state).unwrap())
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
        .bind(format!("{:x}", Sha256::digest(capture_json.as_bytes())))
        .execute(&mut *tx)
        .await
        .unwrap();
    for (event, transition) in &history {
        sqlx::query("INSERT INTO engine_flow030_events VALUES (?,?,?,?,?,NULL)")
            .bind("system")
            .bind("flow")
            .bind(&event.event_id)
            .bind(serde_json::to_string(event).unwrap())
            .bind(serde_json::to_string(&transition.receipt).unwrap())
            .execute(&mut *tx)
            .await
            .unwrap();
        for item in &transition.effects {
            let status = if item.id == effect.id {
                "pending"
            } else {
                "settled"
            };
            sqlx::query("INSERT INTO engine_flow030_outbox VALUES (?,?,?,?,?,?,?,?)")
                .bind("system")
                .bind("flow")
                .bind(&item.id)
                .bind(&event.event_id)
                .bind(serde_json::to_string(item).unwrap())
                .bind("owner")
                .bind(status)
                .bind(if status == "settled" {
                    Some("{}")
                } else {
                    None
                })
                .execute(&mut *tx)
                .await
                .unwrap();
        }
    }
    let handoff = json!({"kind":"nativeOwnedHandoff030","identity":identity,"effectId":attempt.start_effect_id(),"ownerEpoch":"owner","generation":"generation","requestId":request_id,"workAttempt":attempt});
    sqlx::query("INSERT INTO engine_flow030_handoffs VALUES (?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind(attempt.start_effect_id())
        .bind("owner")
        .bind("generation")
        .bind(handoff.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let host = crate::agsdl_host::route_attestation_test_host030(owner.clone(), "generation");
    let runtime = host.flow030();
    let control = Arc::new(FlowControl030 {
        owner: owner.clone(),
        identity: identity.clone(),
        generation: "generation".into(),
        admission: host.admission_lock(),
    });
    runtime
        .controls
        .lock()
        .unwrap()
        .insert("system".into(), control.clone());
    let tasks = crate::tasks::StreamTasks::default();
    let (started, ready) = tokio::sync::oneshot::channel();
    tasks
        .start_agent030(request_id.clone(), &attempt, async move {
            started.send(()).unwrap();
            std::future::pending::<()>().await;
        })
        .unwrap();
    ready.await.unwrap();
    let (release, wait) = tokio::sync::oneshot::channel::<()>();
    tasks
        .attach_test_cleanup030(
            &request_id,
            tokio::spawn(async move {
                wait.await.map_err(|e| e.to_string())?;
                Ok(())
            }),
        )
        .unwrap();
    let dispatch = crate::agsdl_host_dispatch030::dispatch_stop_work030(
        &host, &pool, &tasks, &owner, &effect, &attempt,
    );
    tokio::pin!(dispatch);
    tokio::time::timeout(std::time::Duration::from_secs(5),async {loop {tokio::select! {r=&mut dispatch=>panic!("dispatch ended before cleanup: {r:?}"),_=tokio::time::sleep(std::time::Duration::from_millis(10))=>{}}let status:String=sqlx::query_scalar("SELECT status FROM engine_flow030_outbox WHERE effect_id=?").bind(&effect.id).fetch_one(&pool).await.unwrap();if status=="uncertain" {break;}assert_eq!(status,"pending");}}).await.unwrap();
    let waiting = control.read(&pool).await.unwrap().state;
    let g = waiting
        .groups
        .iter()
        .find(|g| g.join == vec!["j2".to_string()])
        .unwrap();
    assert!(!g.released);
    assert_eq!(
        waiting
            .preparations
            .iter()
            .filter(|p| p.producer.step == Some(vec!["j2".into()]))
            .count(),
        0
    );
    let late = FlowEvent030 {
        identity: identity.clone(),
        event_id: "late".into(),
        expected_revision: waiting.revision.clone(),
        kind: FlowEventKind030::WorkResult {
            work: work.clone(),
            result: WorkResult030::Completed {
                output_json: "{}".into(),
                route_key: None,
            },
            physical: None,
        },
    };
    assert!(matches!(
        reduce(&plan, &waiting, &late),
        Err(crate::persistence::flow030::FlowInputError030::StaleReference)
    ));
    if revoke_during_join {
        revoke_generation(&pool, "generation").await.unwrap();
        release.send(()).unwrap();
        assert!(dispatch.await.is_err());
        let raw: String = sqlx::query_scalar("SELECT state_json FROM engine_flow030_runs")
            .fetch_one(&pool)
            .await
            .unwrap();
        let after: FlowState030 = serde_json::from_str(&raw).unwrap();
        assert!(
            !after
                .groups
                .iter()
                .find(|g| g.join == vec!["j2".to_string()])
                .unwrap()
                .released
        );
        assert!(!after
            .preparations
            .iter()
            .any(|p| p.producer.step == Some(vec!["j2".into()])));
        let status: String =
            sqlx::query_scalar("SELECT status FROM engine_flow030_outbox WHERE effect_id=?")
                .bind(&effect.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "uncertain");
        return;
    }
    release.send(()).unwrap();
    assert!(matches!(dispatch.await.unwrap(), Apply030::Applied(_)));
    let after = control.read(&pool).await.unwrap().state;
    let g = after
        .groups
        .iter()
        .find(|g| g.join == vec!["j2".to_string()])
        .unwrap();
    assert!(g.released);
    assert_eq!(g.decision.as_deref(), Some("reached"));
    assert_eq!(
        after
            .preparations
            .iter()
            .filter(|p| p.producer.step == Some(vec!["j2".into()]))
            .count(),
        1
    );
    assert!(
        !after
            .activations
            .iter()
            .find(|a| a.id == work.activation_id)
            .unwrap()
            .physical
    );
    let status: String =
        sqlx::query_scalar("SELECT status FROM engine_flow030_outbox WHERE effect_id=?")
            .bind(&effect.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "settled");
    assert!(crate::agsdl_host_dispatch030::dispatch_stop_work030(
        &host, &pool, &tasks, &owner, &effect, &attempt
    )
    .await
    .is_err());
    let replayed = control.read(&pool).await.unwrap().state;
    assert_eq!(
        replayed
            .preparations
            .iter()
            .filter(|p| p.producer.step == Some(vec!["j2".into()]))
            .count(),
        1
    );
}
