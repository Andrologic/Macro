use super::*;
use repository::dto::*;
use sha2::{Digest, Sha256};
use std::time::Duration;

fn host() -> Arc<Incarnation> {
    Arc::new(Incarnation {
        generation: "generation".into(),
        compiler: Default::default(),
        lifecycle: Arc::new(tokio::sync::RwLock::new(())),
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
    database.set_ready(pool.clone());
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
    database.set_failed("temporary initialization failure");
    let host = host();
    let supervisor = tokio::spawn(reattach_retained(
        database.clone(),
        host.clone(),
        Default::default(),
        Duration::from_millis(10),
    ));
    tokio::time::sleep(Duration::from_millis(20)).await;
    database.set_ready(pool.clone());
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
    database.set_ready(pool.clone());
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
    database.set_ready(pool);
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
    database.set_ready(pool.clone());
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
