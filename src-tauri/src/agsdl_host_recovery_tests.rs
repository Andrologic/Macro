use super::*;
use repository::dto::*;
use sha2::{Digest, Sha256};
use std::time::Duration;

fn host() -> Arc<Incarnation> {
    Arc::new(Incarnation {
        generation: "generation".into(),
        compiler: Default::default(),
        work_protocol: Default::default(),
        lifecycle: Arc::new(tokio::sync::RwLock::new(())),
        handoff: Mutex::new(()),
        live: AtomicBool::new(true),
        ready: AtomicBool::new(true),
        retired: Default::default(),
        loads: AtomicUsize::new(0),
        owners: Mutex::new(BTreeMap::new()),
        qa_request: Mutex::new(None),
    })
}
fn request(id: &str) -> EngineStartRequest {
    EngineStartRequest {
        source: EngineSourceRevision {
            owner: EngineSourceOwner {
                project_id: "synthetic".into(),
                plan_id: id.into(),
                branch: "feature/test".into(),
            },
            revision: "1".into(),
            source_sha256: format!("{:x}", Sha256::digest(b"{}")),
        },
        profile: "macro-serial-inline-v1".into(),
        associations: Default::default(),
        request_id: id.into(),
        entry: Some(EngineEntry {
            delivery_id: format!("entry-{id}"),
            message_json: "{}".into(),
        }),
    }
}
fn plan(source: &EngineSourceRevision) -> String {
    serde_json::json!({"format":"macro-agsdl-compiled-plan/1", "source":source, "versions":{"registry":"registry"}, "documentJson":"{}"}).to_string()
}
struct Capture;
impl repository::CaptureAuthority for Capture {
    type CommitGuard = ();
    async fn capture(
        &self,
        request: &EngineStartRequest,
        id: &str,
    ) -> Result<repository::TrustedCapture> {
        Ok(repository::TrustedCapture {
            snapshot: EngineSnapshot {
                system_start_id: id.into(),
                source: request.source.clone(),
                authored_source: "{}".into(),
                versions: EngineVersions {
                    snapshot: "1".into(),
                    contract: "agsdl-0.2.0".into(),
                    compiler: "compiler".into(),
                    runtime: "runtime".into(),
                    registry: "registry".into(),
                    profile: request.profile.clone(),
                },
                agents: vec![EngineAgentConfiguration {
                    agent_name: "worker".into(),
                    configuration_name: "fixed".into(),
                    provider_id: "synthetic".into(),
                    model_id: "synthetic".into(),
                    configuration_json: "{}".into(),
                    settings_json: "{}".into(),
                    permissions_json: "[]".into(),
                    scope_json: "{}".into(),
                }],
                compiled_plan_json: plan(&request.source),
                associations: request.associations.clone(),
            },
            private: repository::capture::PrivateCapture {
                registry_json: "{\"version\":\"registry\"}".into(),
                card_associations: vec![],
                native_catalogue_json: "{}".into(),
                implementation_digest: "macro-native-host/1".into(),
                call_scopes: vec![],
            },
            policies: vec![repository::StepPolicy {
                step: vec!["work".into()],
                agent_name: Some("worker".into()),
                max_visits: None,
            }],
            entry_step: Some(vec!["work".into()]),
        })
    }
    async fn recheck(&self, _: &EngineStartRequest) -> Result<()> {
        Ok(())
    }
}
fn complete(
    host: &Incarnation,
    job: &crate::agsdl_host_compiler::HostCompileJob,
    compiled: Option<String>,
) {
    host.compiler.complete(&host.generation, &job.ticket, serde_json::json!({
        "runtime":{"source":job.source,"registryVersion":"registry","supported":compiled.is_some()},
        "compiledPlanJson":compiled,
    }).to_string()).unwrap();
}
async fn next(host: &Incarnation) -> crate::agsdl_host_compiler::HostCompileJob {
    tokio::time::timeout(Duration::from_secs(3), host.compiler.next())
        .await
        .unwrap()
        .unwrap()
}
async fn wait_owners(host: &Incarnation, count: usize) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while host.owners.lock().unwrap().len() != count {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

async fn initialize_work_admission(pool: &sqlx::SqlitePool, context: &EngineContext) {
    let state = repository::work_protocol030::read(pool, &context.work)
        .await
        .unwrap();
    repository::work_protocol030::initialize_admitted(
        pool,
        context,
        &state.contract_json,
        &state.state_json,
        &repository::work_protocol030::WorkAdmission030 {
            options_json: r#"{"checkTimeoutMs":"1000","enforcedPlanLock":true}"#.into(),
            evidence_json: r#"{"nativeLockReceipt":"fixture"}"#.into(),
        },
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn work030_db_commit_replays_without_a_second_mailbox_or_check() {
    use repository::work_protocol030::{self as protocol, ProtocolEvent030};
    let (_temp, pool, context) = repository::work_protocol030_tests::setup().await;
    initialize_work_admission(&pool, &context).await;
    let incarnation = host();
    incarnation
        .owners
        .lock()
        .unwrap()
        .insert(context.owner.system_start_id.clone(), context.owner.clone());
    let state = Arc::new(HostState::default());
    *state.0.lock().unwrap() = Some(OwnedHost {
        incarnation: incarnation.clone(),
        resource: 0,
    });
    let event = ProtocolEvent030 {
        context: context.clone(),
        event_id: "event".into(),
        expected_revision: "0".into(),
        event_json: "{}".into(),
        native_call: None,
        control: false,
    };
    let worker = state.clone();
    let worker_pool = pool.clone();
    let worker_event = event.clone();
    let task = tokio::spawn(async move {
        worker
            .transition_work030(
                &worker_pool,
                &worker_event,
                &tokio_util::sync::CancellationToken::new(),
            )
            .await
    });
    let job = incarnation.work_protocol.next().await.unwrap();
    assert_eq!(
        job.input.options_json,
        r#"{"checkTimeoutMs":"1000","enforcedPlanLock":true}"#
    );
    let receipt = r#"{"receiptId":"work:1","owner":{"systemStartId":"system","activationId":"work","agentInstanceId":"agent","ownerEpoch":"1"},"revision":"1","decision":{"kind":"checkRequested","check":{"checkId":"check","owner":{"systemStartId":"system","activationId":"work","agentInstanceId":"agent","ownerEpoch":"1"},"command":"example"}}}"#;
    incarnation
        .work_protocol
        .complete(
            &incarnation.generation,
            crate::agsdl_host_work::HostWorkCompletion030 {
                ticket: job.ticket,
                generation: job.generation,
                input_digest: job.input_digest,
                output: crate::agsdl_host_work::HostWorkOutput030 {
                    state_json: "{}".into(),
                    receipt_json: receipt.into(),
                },
            },
        )
        .unwrap();
    let decision = task.await.unwrap().unwrap();
    assert_eq!(decision.check.as_ref().unwrap().check_id, "check");
    let replay = state
        .transition_work030(&pool, &event, &tokio_util::sync::CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(decision, replay);
    let checks = protocol::read_checks(&pool, &context.work).await.unwrap();
    assert_eq!(checks.len(), 1);
    assert!(!checks[0].claimed);
    assert!(
        tokio::time::timeout(Duration::from_millis(25), incarnation.work_protocol.next())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn work030_stop_before_commit_rejects_the_late_mailbox_decision() {
    use repository::work_protocol030::{self as protocol, ProtocolEvent030};
    let (_temp, pool, context) = repository::work_protocol030_tests::setup().await;
    initialize_work_admission(&pool, &context).await;
    let incarnation = host();
    incarnation
        .owners
        .lock()
        .unwrap()
        .insert(context.owner.system_start_id.clone(), context.owner.clone());
    let state = Arc::new(HostState::default());
    *state.0.lock().unwrap() = Some(OwnedHost {
        incarnation: incarnation.clone(),
        resource: 0,
    });
    let event = ProtocolEvent030 {
        context: context.clone(),
        event_id: "event".into(),
        expected_revision: "0".into(),
        event_json: "{}".into(),
        native_call: None,
        control: false,
    };
    let worker = state.clone();
    let worker_pool = pool.clone();
    let task = tokio::spawn(async move {
        worker
            .transition_work030(
                &worker_pool,
                &event,
                &tokio_util::sync::CancellationToken::new(),
            )
            .await
    });
    let job = incarnation.work_protocol.next().await.unwrap();
    repository::stop(
        &pool,
        EngineStopRequest {
            system_start_id: context.work.system_start_id.clone(),
            request_id: "stop".into(),
            activation_id: Some(context.work.activation_id.clone()),
        },
    )
    .await
    .unwrap();
    let receipt = r#"{"receiptId":"work:1","owner":{"systemStartId":"system","activationId":"work","agentInstanceId":"agent","ownerEpoch":"1"},"revision":"1","decision":{"kind":"checkRequested","check":{"checkId":"check","owner":{"systemStartId":"system","activationId":"work","agentInstanceId":"agent","ownerEpoch":"1"}}}}"#;
    incarnation
        .work_protocol
        .complete(
            &incarnation.generation,
            crate::agsdl_host_work::HostWorkCompletion030 {
                ticket: job.ticket,
                generation: job.generation,
                input_digest: job.input_digest,
                output: crate::agsdl_host_work::HostWorkOutput030 {
                    state_json: "{}".into(),
                    receipt_json: receipt.into(),
                },
            },
        )
        .unwrap();
    assert!(task.await.unwrap().is_err());
    assert!(protocol::read_checks(&pool, &context.work)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        protocol::read(&pool, &context.work).await.unwrap().revision,
        "0"
    );
}

#[tokio::test]
async fn work030_host_revocation_after_evaluation_blocks_commit_before_sql_revocation() {
    use repository::work_protocol030::{
        self as protocol, EventReservation030, ProtocolDecision030, ProtocolEvent030,
    };
    let (_temp, pool, context) = repository::work_protocol030_tests::setup().await;
    initialize_work_admission(&pool, &context).await;
    let incarnation = host();
    incarnation
        .owners
        .lock()
        .unwrap()
        .insert(context.owner.system_start_id.clone(), context.owner.clone());
    let state = Arc::new(HostState::default());
    *state.0.lock().unwrap() = Some(OwnedHost {
        incarnation: incarnation.clone(),
        resource: 0,
    });
    let event = ProtocolEvent030 {
        context: context.clone(),
        event_id: "event".into(),
        expected_revision: "0".into(),
        event_json: "{}".into(),
        native_call: None,
        control: false,
    };
    let ticket = match protocol::reserve_event(&pool, &event).await.unwrap() {
        EventReservation030::Pending { ticket } => ticket,
        _ => panic!("unexpected replay"),
    };
    let worker = state.clone();
    let work_input = crate::agsdl_host_work::HostWorkInput030 {
        context: context.clone(),
        event_id: event.event_id.clone(),
        expected_revision: event.expected_revision.clone(),
        contract_json: ticket.contract_json.clone(),
        state_json: ticket.state_json.clone(),
        event_json: event.event_json.clone(),
        options_json: "{}".into(),
    };
    let task = tokio::spawn(async move {
        worker
            .evaluate_work030(work_input, &tokio_util::sync::CancellationToken::new())
            .await
    });
    let job = incarnation.work_protocol.next().await.unwrap();
    let receipt = r#"{"receiptId":"work:1","owner":{"systemStartId":"system","activationId":"work","agentInstanceId":"agent","ownerEpoch":"1"},"revision":"1","decision":{"kind":"checkRequested","check":{"checkId":"check","owner":{"systemStartId":"system","activationId":"work","agentInstanceId":"agent","ownerEpoch":"1"}}}}"#;
    incarnation
        .work_protocol
        .complete(
            &incarnation.generation,
            crate::agsdl_host_work::HostWorkCompletion030 {
                ticket: job.ticket,
                generation: job.generation,
                input_digest: job.input_digest,
                output: crate::agsdl_host_work::HostWorkOutput030 {
                    state_json: "{}".into(),
                    receipt_json: receipt.into(),
                },
            },
        )
        .unwrap();
    let (output, evaluated_host) = task.await.unwrap().unwrap();
    let decision = ProtocolDecision030 {
        check: crate::agsdl_host_work::reserved_check030(&context, &output.receipt_json).unwrap(),
        state_json: output.state_json,
        receipt_json: output.receipt_json,
    };
    // Revoke the very same incarnation after evaluate's final live check, but
    // deliberately do not run the asynchronous DB epoch revocation yet.
    assert!(revoke_now(&incarnation));
    assert!(state
        .commit_work030(
            &pool,
            &evaluated_host,
            &ticket,
            &decision,
            &tokio_util::sync::CancellationToken::new()
        )
        .await
        .is_err());
    assert_eq!(
        protocol::read(&pool, &context.work).await.unwrap().revision,
        "0"
    );
    assert!(protocol::read_checks(&pool, &context.work)
        .await
        .unwrap()
        .is_empty());
    assert!(state
        .transition_work030(&pool, &event, &tokio_util::sync::CancellationToken::new())
        .await
        .is_err());
}

#[tokio::test]
async fn work030_revocation_while_sql_commit_is_blocked_is_uncertain_without_effect() {
    use repository::work_protocol030::{
        self as protocol, EventReservation030, ProtocolDecision030, ProtocolEvent030,
    };
    let (_temp, pool, context) = repository::work_protocol030_tests::setup().await;
    initialize_work_admission(&pool, &context).await;
    let event = ProtocolEvent030 {
        context: context.clone(),
        event_id: "event".into(),
        expected_revision: "0".into(),
        event_json: "{}".into(),
        native_call: None,
        control: false,
    };
    let ticket = match protocol::reserve_event(&pool, &event).await.unwrap() {
        EventReservation030::Pending { ticket } => ticket,
        _ => panic!("unexpected replay"),
    };
    let decision = ProtocolDecision030 {
        state_json: "{}".into(),
        receipt_json: "{}".into(),
        check: None,
    };
    let incarnation = host();
    let state = Arc::new(HostState::default());
    let mut blocker = pool.acquire().await.unwrap();
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *blocker)
        .await
        .unwrap();
    let worker = state.clone();
    let worker_pool = pool.clone();
    let worker_host = incarnation.clone();
    let task = tokio::spawn(async move {
        worker
            .commit_work030(
                &worker_pool,
                &worker_host,
                &ticket,
                &decision,
                &tokio_util::sync::CancellationToken::new(),
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if incarnation.lifecycle.try_write().is_err() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("commit should acquire the lifecycle lease");
    assert!(revoke_now(&incarnation));
    let result = tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(result.code, "UNCERTAIN");
    sqlx::query("ROLLBACK")
        .execute(&mut *blocker)
        .await
        .unwrap();
    drop(blocker);
    assert_eq!(
        protocol::read(&pool, &context.work).await.unwrap().revision,
        "0"
    );
    assert!(protocol::read_checks(&pool, &context.work)
        .await
        .unwrap()
        .is_empty());
}
fn close(host: &Incarnation) {
    host.live.store(false, Ordering::SeqCst);
    host.retired.cancel();
    host.compiler.close();
}

#[tokio::test]
async fn recovery_retries_a_transient_sql_failure_without_hiding_b_or_replaying_effects() {
    let temp = tempfile::TempDir::new().unwrap();
    let pool = crate::db::create_pool(&temp.path().join("recovery.db"))
        .await
        .unwrap();
    let mut receipts = vec![
        repository::start(&pool, request("first"), &Capture)
            .await
            .unwrap(),
        repository::start(&pool, request("second"), &Capture)
            .await
            .unwrap(),
    ];
    receipts.sort_by(|a, b| a.system_start_id.cmp(&b.system_start_id));
    let a = &receipts[0];
    let b = &receipts[1];
    let old = EngineOwner {
        system_start_id: a.system_start_id.clone(),
        owner_epoch: "0".into(),
    };
    let activation = repository::read_projection(&pool, &a.system_start_id)
        .await
        .unwrap()
        .activations
        .remove(0);
    repository::begin(&pool, &old, &activation.delivery.delivery.delivery_id)
        .await
        .unwrap();
    let effect = EngineEffect {
        context: EngineContext {
            owner: old.clone(),
            work: activation.delivery.delivery.work.clone(),
            permissions_json: "[]".into(),
            scope_json: "{}".into(),
            registry_version: "registry".into(),
        },
        effect: EngineEffectIdentity::Provider {
            provider_attempt_id: "retained-attempt".into(),
        },
        invocation_json: "{}".into(),
    };
    repository::register_effect(&pool, effect.clone())
        .await
        .unwrap();
    // Fail exactly A's resume transaction; enumeration and B remain usable.
    sqlx::query("CREATE TABLE recovery_fault(system_id TEXT)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO recovery_fault VALUES (?)")
        .bind(&a.system_start_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("CREATE TRIGGER fail_resume BEFORE UPDATE ON engine_systems WHEN NEW.system_id IN (SELECT system_id FROM recovery_fault) BEGIN SELECT RAISE(FAIL, 'temporary failure'); END").execute(&pool).await.unwrap();
    let database = DbPool::default();
    database.set_ready(pool.clone()).await.unwrap();
    let host = host();
    let supervisor = tokio::spawn(reattach_retained(
        database,
        host.clone(),
        Default::default(),
        Duration::from_millis(10),
    ));
    let first = next(&host).await;
    assert_eq!(first.source, a.snapshot.source);
    complete(&host, &first, Some(a.snapshot.compiled_plan_json.clone()));
    let second = next(&host).await;
    assert_eq!(second.source, b.snapshot.source);
    sqlx::query("DROP TRIGGER fail_resume")
        .execute(&pool)
        .await
        .unwrap();
    complete(&host, &second, Some(b.snapshot.compiled_plan_json.clone()));
    let retry = next(&host).await;
    assert_eq!(retry.source, a.snapshot.source);
    assert!(host.owners.lock().unwrap().contains_key(&b.system_start_id));
    assert!(!host.owners.lock().unwrap().contains_key(&a.system_start_id));
    complete(&host, &retry, Some(a.snapshot.compiled_plan_json.clone()));
    wait_owners(&host, 2).await;
    let projection = repository::read_projection(&pool, &a.system_start_id)
        .await
        .unwrap();
    assert_eq!(projection.activations[0].work_state, "uncertain");
    assert!(repository::authorize_reserved_effect(&pool, &effect)
        .await
        .is_err());
    assert!(
        repository::begin(&pool, &old, &activation.delivery.delivery.delivery_id)
            .await
            .is_err()
    );
    let effects = repository::read_effects(&pool, &effect.context.work)
        .await
        .unwrap();
    assert_eq!(effects.len(), 1);
    assert_eq!(effects[0].status, "uncertain");
    // Further scans do not rotate an attached owner's epoch or replay admissions.
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(
        host.owners.lock().unwrap()[&a.system_start_id].owner_epoch,
        "1"
    );
    close(&host);
    tokio::time::timeout(Duration::from_secs(1), supervisor)
        .await
        .unwrap()
        .unwrap();
    assert!(host.lifecycle.try_write().is_ok());
}

#[tokio::test]
async fn recovery_retries_database_initialization_and_stays_fenced_after_retirement() {
    let temp = tempfile::TempDir::new().unwrap();
    let pool = crate::db::create_pool(&temp.path().join("retirement.db"))
        .await
        .unwrap();
    let receipt = repository::start(&pool, request("retirement"), &Capture)
        .await
        .unwrap();
    let database = DbPool::default();
    database
        .set_failed("temporary initialization failure")
        .await;
    let host = host();
    let supervisor = tokio::spawn(reattach_retained(
        database.clone(),
        host.clone(),
        Default::default(),
        Duration::from_millis(10),
    ));
    tokio::time::sleep(Duration::from_millis(20)).await;
    database.set_ready(pool.clone()).await.unwrap();
    let job = next(&host).await;
    close(&host);
    // A reply from the retired physical generation cannot attach or rotate ownership.
    assert!(host
        .compiler
        .complete("generation", &job.ticket, "{}".into())
        .is_err());
    tokio::time::timeout(Duration::from_secs(1), supervisor)
        .await
        .unwrap()
        .unwrap();
    assert!(host.owners.lock().unwrap().is_empty());
    let old = EngineOwner {
        system_start_id: receipt.system_start_id,
        owner_epoch: "0".into(),
    };
    assert!(repository::inspection::read(&pool, &old).await.is_ok());
}

#[tokio::test]
async fn recovery_keeps_an_incompatible_capture_closed_without_repeated_compilation() {
    let temp = tempfile::TempDir::new().unwrap();
    let pool = crate::db::create_pool(&temp.path().join("incompatible.db"))
        .await
        .unwrap();
    let receipt = repository::start(&pool, request("incompatible"), &Capture)
        .await
        .unwrap();
    let database = DbPool::default();
    database.set_ready(pool.clone()).await.unwrap();
    let host = host();
    let supervisor = tokio::spawn(reattach_retained(
        database,
        host.clone(),
        Default::default(),
        Duration::from_millis(10),
    ));
    let job = next(&host).await;
    // Valid ticket, but its plan differs from the immutable captured plan.
    let mut changed: serde_json::Value =
        serde_json::from_str(&receipt.snapshot.compiled_plan_json).unwrap();
    changed["versions"]["compiler"] = "different".into();
    complete(&host, &job, Some(changed.to_string()));
    assert!(
        tokio::time::timeout(Duration::from_millis(60), host.compiler.next())
            .await
            .is_err()
    );
    assert!(host.owners.lock().unwrap().is_empty());
    let old = EngineOwner {
        system_start_id: receipt.system_start_id,
        owner_epoch: "0".into(),
    };
    assert!(repository::inspection::read(&pool, &old).await.is_ok());
    close(&host);
    supervisor.await.unwrap();
}

#[tokio::test]
async fn local_size_refusal_preserves_active_owner_and_the_next_ticket() {
    let temp = tempfile::TempDir::new().unwrap();
    let pool = crate::db::create_pool(&temp.path().join("compile-refusal.db"))
        .await
        .unwrap();
    let receipt = repository::start(&pool, request("active"), &Capture)
        .await
        .unwrap();
    let owner = EngineOwner {
        system_start_id: receipt.system_start_id.clone(),
        owner_epoch: "0".into(),
    };
    let activation = repository::read_projection(&pool, &receipt.system_start_id)
        .await
        .unwrap()
        .activations
        .remove(0);
    repository::begin(&pool, &owner, &activation.delivery.delivery.delivery_id)
        .await
        .unwrap();
    let host = host();
    host.owners
        .lock()
        .unwrap()
        .insert(owner.system_start_id.clone(), owner.clone());
    for oversized in [true, false] {
        let pending_host = host.clone();
        let source = request("preflight").source;
        let pending = tokio::spawn(async move {
            pending_host
                .compiler
                .compile(
                    "generation",
                    source,
                    "{}".into(),
                    "{\"version\":\"registry\"}".into(),
                )
                .await
        });
        let job = next(&host).await;
        if oversized {
            let oversized_result = serde_json::json!({ "runtime":{"source":job.source,"registryVersion":"registry","supported":false}, "padding":"x".repeat(8_000_000) }).to_string();
            assert!(host
                .compiler
                .complete("generation", &job.ticket, oversized_result)
                .is_err());
            // The production frontend sends this compact, correlated refusal instead.
            complete(&host, &job, None);
        } else {
            complete(&host, &job, Some(plan(&job.source)));
        }
        assert!(pending.await.unwrap().is_ok());
        assert!(host.live.load(Ordering::SeqCst));
        assert_eq!(
            host.owners.lock().unwrap().get(&owner.system_start_id),
            Some(&owner)
        );
        assert_eq!(
            repository::read_projection(&pool, &owner.system_start_id)
                .await
                .unwrap()
                .activations[0]
                .work_state,
            "active"
        );
    }
}

#[tokio::test]
async fn recovery_retries_a_full_compiler_mailbox_in_the_same_generation() {
    let temp = tempfile::TempDir::new().unwrap();
    let pool = crate::db::create_pool(&temp.path().join("busy.db"))
        .await
        .unwrap();
    let receipt = repository::start(&pool, request("busy"), &Capture)
        .await
        .unwrap();
    let host = host();
    let mut pending = Vec::new();
    let mut jobs = Vec::new();
    for _ in 0..32 {
        let pending_host = host.clone();
        let source = receipt.snapshot.source.clone();
        pending.push(tokio::spawn(async move {
            pending_host
                .compiler
                .compile(
                    "generation",
                    source,
                    "{}".into(),
                    "{\"version\":\"registry\"}".into(),
                )
                .await
        }));
        jobs.push(next(&host).await);
    }
    let database = DbPool::default();
    database.set_ready(pool).await.unwrap();
    let supervisor = tokio::spawn(reattach_retained(
        database,
        host.clone(),
        Default::default(),
        Duration::from_millis(10),
    ));
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(host.owners.lock().unwrap().is_empty());
    for job in jobs {
        complete(&host, &job, None);
    }
    for ticket in pending {
        ticket.await.unwrap().unwrap();
    }
    let retried = next(&host).await;
    complete(&host, &retried, Some(receipt.snapshot.compiled_plan_json));
    wait_owners(&host, 1).await;
    tokio::time::timeout(Duration::from_secs(1), supervisor)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        host.owners.lock().unwrap()[&receipt.system_start_id].owner_epoch,
        "1"
    );
}

#[tokio::test]
async fn recovery_survives_a_real_compile_timeout_and_late_reply_before_resuming_a_and_b() {
    let temp = tempfile::TempDir::new().unwrap();
    let pool = crate::db::create_pool(&temp.path().join("compile-timeout.db"))
        .await
        .unwrap();
    let mut receipts = vec![
        repository::start(&pool, request("timeout-a"), &Capture)
            .await
            .unwrap(),
        repository::start(&pool, request("timeout-b"), &Capture)
            .await
            .unwrap(),
    ];
    receipts.sort_by(|a, b| a.system_start_id.cmp(&b.system_start_id));
    let a = &receipts[0];
    let b = &receipts[1];
    let database = DbPool::default();
    database.set_ready(pool.clone()).await.unwrap();
    let host = host();
    let supervisor = tokio::spawn(reattach_retained(
        database,
        host.clone(),
        Default::default(),
        Duration::from_millis(10),
    ));
    let first = next(&host).await;
    assert_eq!(first.source, a.snapshot.source);
    // B is enqueued only once A's actual production 30-second timeout has expired.
    let second = tokio::time::timeout(Duration::from_secs(35), host.compiler.next())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(second.source, b.snapshot.source);
    assert!(host.owners.lock().unwrap().is_empty());
    complete(&host, &first, Some(a.snapshot.compiled_plan_json.clone()));
    // A's stale response is acknowledged, but gives no owner or admission.
    assert!(host.owners.lock().unwrap().is_empty());
    assert!(host.live.load(Ordering::SeqCst));
    complete(&host, &second, Some(b.snapshot.compiled_plan_json.clone()));
    let retry = next(&host).await;
    assert_eq!(retry.source, a.snapshot.source);
    assert!(host.owners.lock().unwrap().contains_key(&b.system_start_id));
    assert!(!host.owners.lock().unwrap().contains_key(&a.system_start_id));
    complete(&host, &retry, Some(a.snapshot.compiled_plan_json.clone()));
    wait_owners(&host, 2).await;
    tokio::time::timeout(Duration::from_secs(1), supervisor)
        .await
        .unwrap()
        .unwrap();
    for receipt in receipts {
        assert_eq!(
            host.owners.lock().unwrap()[&receipt.system_start_id].owner_epoch,
            "1"
        );
        let projection = repository::read_projection(&pool, &receipt.system_start_id)
            .await
            .unwrap();
        assert_eq!(projection.activations.len(), 1);
        assert_eq!(projection.activations[0].work_state, "queued");
    }
    close(&host);
}

#[tokio::test]
async fn work030_durable_readback_never_replays_or_treats_pending_as_rolled_back() {
    use crate::agsdl_host_work::{observe_commit030, DurableCommitObservation030};
    use repository::work_protocol030::{
        self as protocol, EventReservation030, ProtocolDecision030, ProtocolEvent030,
    };
    let (_temp, pool, context) = repository::work_protocol030_tests::setup().await;
    initialize_work_admission(&pool, &context).await;
    let input = ProtocolEvent030 {
        context: context.clone(),
        event_id: "readback".into(),
        expected_revision: "0".into(),
        event_json: "{}".into(),
        native_call: None,
        control: false,
    };
    let ticket = match protocol::reserve_event(&pool, &input).await.unwrap() {
        EventReservation030::Pending { ticket } => ticket,
        _ => panic!("unexpected prior decision"),
    };
    let decision = ProtocolDecision030 {
        state_json: "{}".into(),
        receipt_json: "{}".into(),
        check: None,
    };
    assert_eq!(
        observe_commit030(&pool, &ticket, &decision).await.unwrap(),
        DurableCommitObservation030::Unresolved
    );
    protocol::commit_event(&pool, &ticket, &decision)
        .await
        .unwrap();
    assert_eq!(
        observe_commit030(&pool, &ticket, &decision).await.unwrap(),
        DurableCommitObservation030::Committed
    );
    let mut forged = decision.clone();
    forged.receipt_json = "{ }".into();
    assert!(observe_commit030(&pool, &ticket, &forged).await.is_err());
    assert!(protocol::read_checks(&pool, &context.work)
        .await
        .unwrap()
        .is_empty());
}

/// The SQLite commit hook runs inside sqlite3_step(COMMIT), after SQLx's worker
/// has received COMMIT. It gives the test a deterministic cancellation boundary.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn work030_revocation_after_commit_submission_reads_both_durable_outcomes_without_replay() {
    use crate::agsdl_host_work::{observe_commit030, DurableCommitObservation030};
    use repository::work_protocol030::{
        self as protocol, CheckRequest030, EventReservation030, ProtocolDecision030,
        ProtocolEvent030,
    };
    for allow_commit in [true, false] {
        let (temp, original_pool, context) = repository::work_protocol030_tests::setup().await;
        initialize_work_admission(&original_pool, &context).await;
        let input = ProtocolEvent030 {
            context: context.clone(),
            event_id: "commit-boundary".into(),
            expected_revision: "0".into(),
            event_json: "{}".into(),
            native_call: None,
            control: false,
        };
        let ticket = match protocol::reserve_event(&original_pool, &input)
            .await
            .unwrap()
        {
            EventReservation030::Pending { ticket } => ticket,
            _ => panic!("unexpected prior decision"),
        };
        original_pool.close().await;
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(temp.path().join("protocol.db"))
                    .foreign_keys(true)
                    .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
                    .synchronous(sqlx::sqlite::SqliteSynchronous::Normal),
            )
            .await
            .unwrap();
        let decision = ProtocolDecision030 {
            state_json: "{}".into(),
            receipt_json: "{}".into(),
            check: Some(CheckRequest030 {
                check_id: "boundary-check".into(),
                invocation_json: "{}".into(),
            }),
        };
        let (arrived_tx, arrived_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        {
            let mut connection = pool.acquire().await.unwrap();
            let mut handle = connection.lock_handle().await.unwrap();
            let mut arrived = Some(arrived_tx);
            handle.set_commit_hook(move || {
                if let Some(sender) = arrived.take() {
                    let _ = sender.send(());
                }
                release_rx.recv_timeout(Duration::from_secs(15)).is_ok() && allow_commit
            });
        }
        let state = Arc::new(HostState::default());
        let incarnation = host();
        let cancellation = tokio_util::sync::CancellationToken::new();
        let worker = state.clone();
        let worker_pool = pool.clone();
        let worker_host = incarnation.clone();
        let worker_ticket = ticket.clone();
        let worker_decision = decision.clone();
        let worker_cancellation = cancellation.clone();
        let task = tokio::spawn(async move {
            worker
                .commit_work030(
                    &worker_pool,
                    &worker_host,
                    &worker_ticket,
                    &worker_decision,
                    &worker_cancellation,
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(10), arrived_rx)
            .await
            .unwrap()
            .unwrap();
        assert!(revoke_now(&incarnation));
        release_tx.send(()).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(15), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(result.code, "UNCERTAIN");
        {
            let mut connection = pool.acquire().await.unwrap();
            let mut handle = connection.lock_handle().await.unwrap();
            handle.remove_commit_hook();
        }
        let observation = observe_commit030(&pool, &ticket, &decision).await.unwrap();
        let checks = protocol::read_checks(&pool, &context.work).await.unwrap();
        if allow_commit {
            assert_eq!(observation, DurableCommitObservation030::Committed);
            assert_eq!(checks.len(), 1);
            assert!(!checks[0].claimed);
        } else {
            // The read is deliberately inconclusive: it never grants replay.
            assert_eq!(observation, DurableCommitObservation030::Unresolved);
            assert!(checks.is_empty());
        }
        pool.close().await;
    }
}
