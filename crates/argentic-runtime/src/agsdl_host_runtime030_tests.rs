//! Native dispatcher/admission with a distinct fake executor and the Rust
//! controller/route adapters. Captures and account observations are fixtures.
use super::*;
use crate::agsdl_host_flow030 as flow;
use crate::agsdl_host_runtime030::*;
use crate::agsdl_host_work_admission030::{AttestedWorkPolicy030, PreparedEffectiveAgentWork030};
use crate::persistence::{
    flow030::{FlowEffect030, FlowEvent030, FlowEventKind030, FlowIdentity030},
    start030::{self, StartCapture030},
};
use crate::tasks::StreamTasks;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{query, query_scalar};
use tokio::sync::{watch, Notify};
use tokio_util::sync::CancellationToken;

#[cfg(unix)]
#[path = "agsdl_host_codex030/continuity_tests.rs"]
mod codex_continuity;

#[path = "agsdl_host_parallel030_tests.rs"]
mod parallel;

#[path = "agsdl_host_composition030_tests.rs"]
mod composition;

struct FixtureStart030 {
    capture: StartCapture030,
}
impl crate::persistence::flow_store030::Authority030 for FixtureStart030 {
    fn owner<'a>(
        &'a self,
        db: &'a mut sqlx::SqliteConnection,
        id: &'a FlowIdentity030,
    ) -> crate::persistence::flow_store030::CheckFuture<'a> {
        Box::pin(async move {
            let exists: bool = query_scalar("SELECT EXISTS(SELECT 1 FROM engine_flow030_owners WHERE system_id=? AND invocation_id=? AND owner_epoch='owner' AND generation='generation' AND status='live')")
                .bind(&id.system_start_id).bind(&id.flow_invocation_id).fetch_one(db).await?;
            if exists {
                Ok(())
            } else {
                Err(crate::persistence::flow_store030::StoreError030::Authority)
            }
        })
    }
    fn effect<'a>(
        &'a self,
        _: &'a mut sqlx::SqliteConnection,
        _: &'a FlowEffect030,
    ) -> crate::persistence::flow_store030::CheckFuture<'a> {
        Box::pin(async { Err(crate::persistence::flow_store030::StoreError030::Authority) })
    }
    fn settlement<'a>(
        &'a self,
        _: &'a mut sqlx::SqliteConnection,
        _: &'a FlowEffect030,
        _: &'a Value,
    ) -> crate::persistence::flow_store030::CheckFuture<'a> {
        Box::pin(async { Err(crate::persistence::flow_store030::StoreError030::Authority) })
    }
    fn owner_epoch(&self) -> &str {
        "owner"
    }
}
impl crate::persistence::start030::StartAuthority030 for FixtureStart030 {
    type SourceGuard = ();
    fn require_clear(
        &self,
        _: &crate::persistence::dto::EngineStartRequest,
    ) -> crate::persistence::Result<()> {
        Ok(())
    }
    fn begin_commit(
        &self,
        _: &crate::persistence::dto::EngineStartRequest,
        _: &FlowIdentity030,
    ) -> crate::persistence::Result<()> {
        Ok(())
    }
    fn commit_acknowledged(
        &self,
        _: &crate::persistence::dto::EngineStartRequest,
        _: &FlowIdentity030,
    ) {
    }
    async fn capture(
        &self,
        _: &crate::persistence::dto::EngineStartRequest,
    ) -> crate::persistence::Result<StartCapture030> {
        Ok(self.capture.clone())
    }
    async fn lock_source(
        &self,
        _: &crate::persistence::dto::EngineStartRequest,
    ) -> crate::persistence::Result<()> {
        Ok(())
    }
    async fn bind_capture_tx(
        &self,
        db: &mut sqlx::SqliteConnection,
        _: &crate::persistence::dto::EngineStartRequest,
        capture: &StartCapture030,
    ) -> crate::persistence::Result<()> {
        let raw = serde_json::to_vec(capture)?;
        query("INSERT INTO engine_flow030_owners VALUES (?,?,?,?,?,?,?,?)")
            .bind(&capture.identity.system_start_id)
            .bind(&capture.identity.flow_invocation_id)
            .bind(&capture.identity.snapshot_id)
            .bind(&capture.identity.epoch)
            .bind("owner")
            .bind("generation")
            .bind("live")
            .bind(format!("{:x}", Sha256::digest(raw)))
            .execute(db)
            .await?;
        Ok(())
    }
}
struct Fixture {
    _temp: tempfile::TempDir,
    host: Arc<HostState>,
    pool: sqlx::SqlitePool,
    config: crate::host::HostContext,
    policy: Arc<crate::test_context::Policy>,
    incarnation: Arc<Incarnation>,
    owner: EngineOwner,
    identity: FlowIdentity030,
}
impl Fixture {
    async fn new(chained: bool) -> Self {
        let document = json!({"contract":"agsdl-0.3.0","id":"runtime-fixture","agents":{"worker":{"harness":"codex","permissions":"workspace"}},
            "flow":{"entry":"first","steps": if chained { json!({"first":{"type":"agent","agent":"worker","next":"second"},"second":{"type":"agent","agent":"worker"}}) } else { json!({"first":{"type":"agent","agent":"worker"}}) }}});
        Self::with_document(document).await
    }
    async fn with_document(document: Value) -> Self {
        Self::with_document_in_run(document, "system").await
    }
    async fn with_document_in_run(document: Value, run: &str) -> Self {
        Self::with_capabilities(document, run, &[]).await
    }
    async fn with_capabilities(document: Value, run: &str, capabilities: &[&str]) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let workspace = root.join("workspace");
        let metadata = root.join("metadata");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::create_dir(&metadata).unwrap();
        let (config, policy) = crate::test_context::context_with_policy(root.join("config"));
        let authored = document.to_string();
        let source = json!({"owner":{"projectId":"project","planId":"source","branch":"develop"},"revision":"1","sourceSha256":format!("{:x}",Sha256::digest(authored.as_bytes()))});
        let scope = json!({"projectId":"project","root":workspace,"rootIdentity":crate::content_io::admitted::workspace_root_identity(&workspace).unwrap().observation_key().unwrap(),"sourceOwner":source["owner"]});
        let observed = crate::agsdl_host_codex::CodexObservation030 {
            profile: crate::agsdl_host_codex::Profile {
                executable: root.join("synthetic-codex"),
                directory: root.join("profile"),
                home: root.join("profile/home"),
                bootstrap: root.join("bootstrap"),
                digest: "synthetic-profile".into(),
            },
            version: "0.167.0".into(),
            models: vec![
                json!({"name":"fixture","efforts":["medium","high"],"defaultEffort":"medium","isDefault":true}),
            ],
            account_digest: "synthetic-account".into(),
        };
        let (harness, agents) = crate::test_context::codex_registry030(
            &document,
            source["sourceSha256"].as_str().unwrap(),
            &scope,
            &observed,
        )
        .unwrap();
        let mut registry = json!({"format":"macro-agsdl-registry/030","version":"fixture","modules":[{"harness":"codex","moduleJson":crate::agsdl_host_codex030::approvals::module030()}],"harnesses":[harness],"agents":agents,"hostCapabilities":[{"name":"approval","support":"native","evidenceJson":"{\"runtime\":\"synthetic-human-clock\"}"}]});
        for name in capabilities {
            registry["hostCapabilities"].as_array_mut().unwrap().push(json!({
                "name": name, "support": "native", "evidenceJson": "{\"runtime\":\"synthetic-shutdown-reader\"}"
            }));
        }
        let receipt = crate::agsdl_host_compiler::CompileBroker::default()
            .compile_native(
                "generation",
                serde_json::from_value(source.clone()).unwrap(),
                authored.clone(),
                registry.to_string(),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        let compiled: Value = serde_json::from_str(&receipt.result_json).unwrap();
        let plan = compiled["compiledPlanJson"]
            .as_str()
            .unwrap_or_else(|| panic!("compiler: {compiled}"))
            .to_owned();
        let identity = FlowIdentity030 {
            system_start_id: run.into(),
            flow_invocation_id: "flow".into(),
            snapshot_id: "snapshot".into(),
            epoch: "capture".into(),
        };
        let permissions = crate::test_context::captured_permissions().to_string();
        let capture = StartCapture030 { identity:identity.clone(), source:serde_json::from_value(source.clone()).unwrap(), versions:serde_json::from_value(serde_json::from_str::<Value>(&plan).unwrap()["versions"].clone()).unwrap(),
            authored_source:authored, compiled_plan_json:plan.clone(), registry_json:registry.to_string(), private_capture_json:json!({"format":"macro-native-flow-capture/030","callPermissionsJson":permissions,"callScopeJson":scope.to_string()}).to_string() };
        let pool = crate::sqlite::create_file(&root.join("run.db"))
            .await
            .unwrap();
        let request = serde_json::from_value(json!({"source":source,"profile":"macro-agsdl-030-v1", "associations":{}, "requestId":"request", "entry":{"deliveryId":"delivery", "messageJson":"{\"prompt\":\"Start\"}"}})).unwrap();
        start030::start_linked(
            &pool,
            &request,
            &FixtureStart030 { capture },
            &start030::UnlinkedStart,
        )
        .await
        .unwrap();
        let owner = EngineOwner {
            system_start_id: run.into(),
            owner_epoch: "owner".into(),
        };
        let incarnation = Arc::new(Incarnation {
            generation: "generation".into(),
            compiler: Default::default(),
            work_protocol: Default::default(),
            route030: Default::default(),
            lifecycle: Default::default(),
            handoff: Mutex::new(()),
            live: AtomicBool::new(true),
            ready: AtomicBool::new(true),
            retired: Default::default(),
            owners: Mutex::new(BTreeMap::from([(run.into(), owner.clone())])),
        });
        let host = Arc::new(HostState::from_parts(
            Mutex::new(Some(OwnedHost {
                incarnation: incarnation.clone(),
            })),
            Default::default(),
            Default::default(),
        ));
        host.flow030()
            .install_runtime_fixture_control(&host, owner.clone(), identity.clone());
        Self {
            _temp: temp,
            host,
            pool,
            config,
            policy,
            incarnation,
            owner,
            identity,
        }
    }
    fn emitter(&self, tasks: &StreamTasks) -> Arc<dyn Fn(String) -> EventEmitter030 + Send + Sync> {
        let (host, pool, config) = (self.host.clone(), self.pool.clone(), self.config.clone());
        let tasks = tasks.clone();
        Arc::new(move |_| {
            let (host, pool, config, tasks) =
                (host.clone(), pool.clone(), config.clone(), tasks.clone());
            let (check_host, check_pool, check_config, check_tasks) =
                (host.clone(), pool.clone(), config.clone(), tasks.clone());
            EventEmitter030 {
                event: Arc::new(move |attempt, label, body, cancel| {
                    let (host, pool, config, tasks) =
                        (host.clone(), pool.clone(), config.clone(), tasks.clone());
                    Box::pin(async move {
                        emit_work_event030(
                            &host,
                            &pool,
                            &config.clone(),
                            &tasks,
                            &attempt,
                            "project",
                            &label,
                            body,
                            &cancel,
                        )
                        .await
                    })
                }),
                check: Arc::new(move |attempt, check, cancel| {
                    let (host, pool, config, tasks) = (
                        check_host.clone(),
                        check_pool.clone(),
                        check_config.clone(),
                        check_tasks.clone(),
                    );
                    Box::pin(async move {
                        crate::agsdl_host_completion030::execute(
                            &host,
                            &pool,
                            &config.clone(),
                            &tasks,
                            &attempt,
                            "project",
                            &check,
                            &cancel,
                        )
                        .await
                    })
                }),
            }
        })
    }
    fn pause_physical_evaluation(&self, reached: Arc<Notify>, release: Arc<Notify>) {
        *self.incarnation.work_protocol.native.probe.lock().unwrap() =
            Some(Arc::new(move |raw, _| {
                if raw.contains("physicalEnded") {
                    reached.notify_one();
                    tokio::runtime::Handle::current().block_on(release.notified());
                }
            }));
    }
}

use crate::dev_fixture::ScriptedAgent as FakeExecutor;
#[tokio::test]
async fn distinct_executor_chains_two_works_without_double_dispatch() {
    let f = Fixture::new(true).await;
    let tasks = StreamTasks::default();
    let starts = Arc::new(AtomicUsize::new(0));
    let executor = Arc::new(FakeExecutor {
        starts: starts.clone(),
        started: Default::default(),
        cleanup: None,
        cancelled: Default::default(),
        submitted: None,
        independent_finish: false,
    });
    let executors: Executors030 = Executors030 {
        agents: executor,
        calls: None,
        humans: None,
        clock: None,
    };
    let (_wake, receiver) = watch::channel(0);
    let emitter = f.emitter(&tasks);
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        supervise_with_emitter030(
            None,
            &f.host,
            &f.pool,
            &f.config.clone(),
            &tasks,
            &f.owner,
            &executors,
            receiver,
            &CancellationToken::new(),
            emitter,
        ),
    )
    .await;
    assert!(result.is_ok(), "supervisor timed out");
    result.unwrap().unwrap();
    assert_eq!(starts.load(Ordering::SeqCst), 2);
    let view = flow::inspect_run(f.host.flow030(), &f.host, &f.pool, &f.owner)
        .await
        .unwrap();
    assert_eq!(view.flow.state.verdict.as_deref(), Some("succeeded"));
}

#[tokio::test]
async fn stop_remains_responsive_and_waits_for_physical_end() {
    let f = Fixture::new(false).await;
    let tasks = StreamTasks::default();
    let cleanup = Arc::new(Notify::new());
    let started = Arc::new(Notify::new());
    let cancelled = Arc::new(Notify::new());
    let starts = Arc::new(AtomicUsize::new(0));
    let snapshot_read = Arc::new(Notify::new());
    let release_clock = Arc::new(Notify::new());
    let executors: Executors030 = Executors030 {
        agents: Arc::new(FakeExecutor {
            starts: starts.clone(),
            started: started.clone(),
            cleanup: Some(cleanup.clone()),
            cancelled: cancelled.clone(),
            submitted: None,
            independent_finish: false,
        }),
        calls: None,
        humans: None,
        clock: Some(Arc::new(WakeRaceClock {
            read: snapshot_read.clone(),
            release: release_clock.clone(),
            first: AtomicBool::new(true),
        })),
    };
    let (wake, receiver) = watch::channel(0);
    let cancel = CancellationToken::new();
    let emitter = f.emitter(&tasks);
    let native_config = f.config.clone();
    let supervisor = supervise_with_emitter030(
        None,
        &f.host,
        &f.pool,
        &native_config,
        &tasks,
        &f.owner,
        &executors,
        receiver,
        &cancel,
        emitter,
    );
    tokio::pin!(supervisor);
    let exercise = async {
        started.notified().await;
        snapshot_read.notified().await;
        let view = flow::inspect_run(f.host.flow030(), &f.host, &f.pool, &f.owner)
            .await
            .unwrap();
        flow::apply_native_event(
            f.host.flow030(),
            &f.host,
            &f.pool,
            &FlowEvent030 {
                identity: f.identity.clone(),
                event_id: "stop".into(),
                expected_revision: view.flow.state.revision,
                kind: FlowEventKind030::Stop,
            },
        )
        .await
        .unwrap();
        wake.send_modify(|value| *value += 1);
        release_clock.notify_one();
        tokio::time::timeout(std::time::Duration::from_millis(250), cancelled.notified())
            .await
            .expect("wake between state read and select must not wait for the 500ms fallback");
        let view = flow::inspect_run(f.host.flow030(), &f.host, &f.pool, &f.owner)
            .await
            .unwrap();
        assert!(view.flow.state.stopping);
        assert!(view.flow.state.verdict.is_none());
        assert!(view.flow.state.activations.iter().any(|a| a.physical));
        cleanup.notify_one();
    };
    let (result, ()) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::join!(&mut supervisor, exercise)
    })
    .await
    .expect("Stop must not wait for the live agent in the dispatch loop");
    result.unwrap();
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    let view = flow::inspect_run(f.host.flow030(), &f.host, &f.pool, &f.owner)
        .await
        .unwrap();
    assert_eq!(view.flow.state.verdict.as_deref(), Some("cancelled"));
}

#[tokio::test]
async fn an_unowned_claim_is_interrupted_and_never_retried() {
    let f = Fixture::new(false).await;
    let tasks = StreamTasks::default();
    drop(
        flow::claim_next(f.host.flow030(), &f.host, &f.pool, &f.identity)
            .await
            .unwrap()
            .unwrap(),
    );
    let starts = Arc::new(AtomicUsize::new(0));
    let executors: Executors030 = Executors030 {
        agents: Arc::new(FakeExecutor {
            starts: starts.clone(),
            started: Default::default(),
            cleanup: None,
            cancelled: Default::default(),
            submitted: None,
            independent_finish: false,
        }),
        calls: None,
        humans: None,
        clock: None,
    };
    let (_wake, receiver) = watch::channel(0);
    let result = supervise_with_emitter030(
        None,
        &f.host,
        &f.pool,
        &f.config.clone(),
        &tasks,
        &f.owner,
        &executors,
        receiver,
        &CancellationToken::new(),
        f.emitter(&tasks),
    )
    .await;
    assert_eq!(result.unwrap_err().code, "INTERRUPTED");
    assert_eq!(starts.load(Ordering::SeqCst), 0);
}

struct WakeRaceClock {
    read: Arc<Notify>,
    release: Arc<Notify>,
    first: AtomicBool,
}
impl RuntimeClock030 for WakeRaceClock {
    fn tick(&self) -> futures::future::BoxFuture<'_, crate::persistence::Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn next_wake(
        &self,
    ) -> futures::future::BoxFuture<'_, crate::persistence::Result<Option<std::time::Duration>>>
    {
        Box::pin(async move {
            if self.first.swap(false, Ordering::SeqCst) {
                self.read.notify_one();
                self.release.notified().await;
            }
            Ok(None)
        })
    }
}

#[tokio::test]
async fn accepted_completion_and_stop_do_not_route_or_double_send() {
    let f = Fixture::new(true).await;
    let tasks = StreamTasks::default();
    let cleanup = Arc::new(Notify::new());
    let submitted = Arc::new(Notify::new());
    let cancelled = Arc::new(Notify::new());
    let starts = Arc::new(AtomicUsize::new(0));
    let executors: Executors030 = Executors030 {
        agents: Arc::new(FakeExecutor {
            starts: starts.clone(),
            started: Default::default(),
            cleanup: Some(cleanup.clone()),
            cancelled: cancelled.clone(),
            submitted: Some(submitted.clone()),
            independent_finish: true,
        }),
        calls: None,
        humans: None,
        clock: None,
    };
    let (wake, receiver) = watch::channel(0);
    let cancel = CancellationToken::new();
    let native_config = f.config.clone();
    let supervisor = supervise_with_emitter030(
        None,
        &f.host,
        &f.pool,
        &native_config,
        &tasks,
        &f.owner,
        &executors,
        receiver,
        &cancel,
        f.emitter(&tasks),
    );
    tokio::pin!(supervisor);
    let exercise = async {
        submitted.notified().await;
        let view = flow::inspect_run(f.host.flow030(), &f.host, &f.pool, &f.owner)
            .await
            .unwrap();
        flow::apply_native_event(
            f.host.flow030(),
            &f.host,
            &f.pool,
            &FlowEvent030 {
                identity: f.identity.clone(),
                event_id: "racing-stop".into(),
                expected_revision: view.flow.state.revision,
                kind: FlowEventKind030::Stop,
            },
        )
        .await
        .unwrap();
        // Both logical completion and Stop are ready before the supervisor
        // selects a completion. Physical cleanup is released in the same turn.
        cleanup.notify_one();
        wake.send_modify(|value| *value += 1);
    };
    let (result, ()) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::join!(&mut supervisor, exercise)
    })
    .await
    .unwrap();
    result.unwrap();
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    let view = flow::inspect_run(f.host.flow030(), &f.host, &f.pool, &f.owner)
        .await
        .unwrap();
    assert_eq!(view.flow.state.verdict.as_deref(), Some("cancelled"));
    assert!(view.flow.state.activations.iter().all(|a| !a.physical));
}

async fn stop_fixture(f: &Fixture, event: &str) {
    let view = flow::inspect_run(f.host.flow030(), &f.host, &f.pool, &f.owner)
        .await
        .unwrap();
    flow::apply_native_event(
        f.host.flow030(),
        &f.host,
        &f.pool,
        &FlowEvent030 {
            identity: f.identity.clone(),
            event_id: event.into(),
            expected_revision: view.flow.state.revision,
            kind: FlowEventKind030::Stop,
        },
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn stop_during_physical_controller_evaluation_retains_the_join() {
    let f = Fixture::new(true).await;
    let reached = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    f.pause_physical_evaluation(reached.clone(), release.clone());
    let tasks = StreamTasks::default();
    let starts = Arc::new(AtomicUsize::new(0));
    let executors: Executors030 = Executors030 {
        agents: Arc::new(FakeExecutor {
            starts: starts.clone(),
            started: Default::default(),
            cleanup: None,
            cancelled: Default::default(),
            submitted: None,
            independent_finish: false,
        }),
        calls: None,
        humans: None,
        clock: None,
    };
    let (wake, receiver) = watch::channel(0);
    let cancel = CancellationToken::new();
    let native_config = f.config.clone();
    let supervisor = supervise_with_emitter030(
        None,
        &f.host,
        &f.pool,
        &native_config,
        &tasks,
        &f.owner,
        &executors,
        receiver,
        &cancel,
        f.emitter(&tasks),
    );
    tokio::pin!(supervisor);
    let exercise = async {
        reached.notified().await;
        stop_fixture(&f, "stop-during-evaluation").await;
        wake.send_modify(|v| *v += 1);
        release.notify_one();
    };
    let (result, ()) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::join!(&mut supervisor, exercise)
    })
    .await
    .unwrap();
    result.unwrap();
    let view = flow::inspect_run(f.host.flow030(), &f.host, &f.pool, &f.owner)
        .await
        .unwrap();
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(view.flow.state.verdict.as_deref(), Some("cancelled"));
    assert!(view.flow.state.activations.iter().all(|a| !a.physical));
}

#[tokio::test]
async fn stop_before_the_first_handoff_settles_an_unadmitted_start() {
    let f = Fixture::new(false).await;
    stop_fixture(&f, "stop-before-handoff").await;
    let tasks = StreamTasks::default();
    let starts = Arc::new(AtomicUsize::new(0));
    let executors: Executors030 = Executors030 {
        agents: Arc::new(FakeExecutor {
            starts: starts.clone(),
            started: Default::default(),
            cleanup: None,
            cancelled: Default::default(),
            submitted: None,
            independent_finish: false,
        }),
        calls: None,
        humans: None,
        clock: None,
    };
    let (_wake, receiver) = watch::channel(0);
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        supervise_with_emitter030(
            None,
            &f.host,
            &f.pool,
            &f.config.clone(),
            &tasks,
            &f.owner,
            &executors,
            receiver,
            &CancellationToken::new(),
            f.emitter(&tasks),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(starts.load(Ordering::SeqCst), 0);
    let view = flow::inspect_run(f.host.flow030(), &f.host, &f.pool, &f.owner)
        .await
        .unwrap();
    assert_eq!(view.flow.state.verdict.as_deref(), Some("cancelled"));
}

struct StopBeforeClaimExecutor {
    host: Arc<HostState>,
    pool: sqlx::SqlitePool,
    owner: EngineOwner,
    identity: FlowIdentity030,
    starts: Arc<AtomicUsize>,
}
impl AgentExecutor030 for StopBeforeClaimExecutor {
    fn prepare(
        &self,
        prepared: PreparedEffectiveAgentWork030,
    ) -> crate::persistence::Result<AttestedWorkPolicy030> {
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                let view =
                    flow::inspect_run(self.host.flow030(), &self.host, &self.pool, &self.owner)
                        .await?;
                flow::apply_native_event(
                    self.host.flow030(),
                    &self.host,
                    &self.pool,
                    &FlowEvent030 {
                        identity: self.identity.clone(),
                        event_id: "stop-in-prepare".into(),
                        expected_revision: view.flow.state.revision,
                        kind: FlowEventKind030::Stop,
                    },
                )
                .await?;
                Ok::<_, crate::persistence::dto::EngineFailure>(())
            })
        })?;
        AttestedWorkPolicy030::from_codex(prepared)
    }
    fn run(
        &self,
        _work: AgentWork030,
        _events: WorkEventSink030,
        _cancel: CancellationToken,
    ) -> futures::future::BoxFuture<'static, crate::persistence::Result<()>> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { panic!("Stop invalidated this start before its claim") })
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_between_preparation_and_claim_does_not_start_or_interrupt_the_supervisor() {
    let f = Fixture::new(false).await;
    let tasks = StreamTasks::default();
    let starts = Arc::new(AtomicUsize::new(0));
    let executors: Executors030 = Executors030 {
        agents: Arc::new(StopBeforeClaimExecutor {
            host: f.host.clone(),
            pool: f.pool.clone(),
            owner: f.owner.clone(),
            identity: f.identity.clone(),
            starts: starts.clone(),
        }),
        calls: None,
        humans: None,
        clock: None,
    };
    let (_wake, receiver) = watch::channel(0);
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        supervise_with_emitter030(
            None,
            &f.host,
            &f.pool,
            &f.config.clone(),
            &tasks,
            &f.owner,
            &executors,
            receiver,
            &CancellationToken::new(),
            f.emitter(&tasks),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(starts.load(Ordering::SeqCst), 0);
    let view = flow::inspect_run(f.host.flow030(), &f.host, &f.pool, &f.owner)
        .await
        .unwrap();
    assert_eq!(view.flow.state.verdict.as_deref(), Some("cancelled"));
}

#[tokio::test]
async fn qualified_codex_registry_and_policy_run_the_write_review_demo() {
    let document = json!({"contract":"agsdl-0.3.0","id":"codex-demo","agents":{
        "writer":{"harness":"codex","permissions":"workspace","model":{"name":"fixture","effort":"high"}},
        "reviewer":{"harness":"codex","permissions":"read-only"}},
        "flow":{"entry":"write","steps":{
            "write":{"type":"agent","agent":"writer","maxVisits":3,"next":"review"},
            "review":{"type":"agent","agent":"reviewer","maxVisits":3,"next":{"approve":[],"revise":"write"}}}}});
    let f = Fixture::with_document(document).await;
    let tasks = StreamTasks::default();
    let starts = Arc::new(AtomicUsize::new(0));
    let executors: Executors030 = Executors030 {
        agents: Arc::new(FakeExecutor {
            starts: starts.clone(),
            started: Default::default(),
            cleanup: None,
            cancelled: Default::default(),
            submitted: None,
            independent_finish: false,
        }),
        calls: None,
        humans: None,
        clock: None,
    };
    let (_wake, receiver) = watch::channel(0);
    let inspection = flow::inspect_run(f.host.flow030(), &f.host, &f.pool, &f.owner)
        .await
        .unwrap();
    let registry: Value = serde_json::from_str(&inspection.capture.registry_json).unwrap();
    assert_eq!(registry["harnesses"][0]["qualified"], true);
    assert_eq!(registry["agents"].as_array().unwrap().len(), 2);
    assert_eq!(registry["harnesses"][0]["models"][0]["name"], "fixture");
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        supervise_with_emitter030(
            None,
            &f.host,
            &f.pool,
            &f.config.clone(),
            &tasks,
            &f.owner,
            &executors,
            receiver,
            &CancellationToken::new(),
            f.emitter(&tasks),
        ),
    )
    .await
    .unwrap();
    result.unwrap();
    let inspection = flow::inspect_run(f.host.flow030(), &f.host, &f.pool, &f.owner)
        .await
        .unwrap();
    assert_eq!(inspection.flow.state.verdict.as_deref(), Some("succeeded"));
    assert_eq!(starts.load(Ordering::SeqCst), 2);
    assert!(inspection
        .flow
        .state
        .activations
        .iter()
        .any(|activation| activation.agent.as_deref() == Some("reviewer")
            && activation
                .message_json
                .as_deref()
                .is_some_and(|message| message.contains("Synthetic draft"))));
}

#[tokio::test]
async fn shutdown_snapshot_reads_all_owned_call_only_runs_and_fails_closed() {
    let document = json!({"contract":"agsdl-0.3.0","id":"shutdown-calls","agents":{},
        "flow":{"entry":"call","steps":{"call":{"type":"call","command":"true"}}}});
    let f = Fixture::with_capabilities(document.clone(), "first", &["call.command"]).await;
    let other = Fixture::with_capabilities(document, "unselected", &["call.command"]).await;
    let raw: String = query_scalar("SELECT capture_json FROM engine_start030_requests")
        .fetch_one(&other.pool)
        .await
        .unwrap();
    let capture = serde_json::from_str::<StartCapture030>(&raw).unwrap();
    let request = serde_json::from_value(json!({"source": capture.source,
        "profile":"macro-agsdl-030-v1","associations":{},"requestId":"second-request",
        "entry":{"deliveryId":"second-delivery","messageJson":"{}"}}))
    .unwrap();
    start030::start_linked(
        &f.pool,
        &request,
        &FixtureStart030 { capture },
        &start030::UnlinkedStart,
    )
    .await
    .unwrap();
    f.incarnation
        .owners
        .lock()
        .unwrap()
        .insert("unselected".into(), other.owner.clone());
    assert_eq!(
        f.host.shutdown_active_runs(&f.pool).await.unwrap(),
        ["first", "unselected"]
    );
    // A terminal label cannot conceal resources that are still physically pending.
    query("UPDATE engine_flow030_runs SET state_json=json_set(state_json,'$.verdict','cancelled') WHERE system_id='first'")
        .execute(&f.pool).await.unwrap();
    assert_eq!(
        f.host.shutdown_active_runs(&f.pool).await.unwrap(),
        ["first", "unselected"]
    );
    query("UPDATE engine_flow030_runs SET state_json='{}' WHERE system_id='unselected'")
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(f.host.shutdown_active_runs(&f.pool).await.is_err());
}

#[tokio::test]
async fn shutdown_failed_stop_does_not_commit_an_interruption_marker() {
    let f = Fixture::new(false).await;
    assert!(!f.host.shutdown_started());
    let approved = f.host.shutdown_active_runs(&f.pool).await.unwrap();
    query("CREATE TRIGGER reject_shutdown_stop BEFORE INSERT ON engine_flow030_events WHEN NEW.event_id LIKE 'retire:%' BEGIN SELECT RAISE(ABORT, 'synthetic Stop persistence failure'); END")
        .execute(&f.pool).await.unwrap();
    assert!(f
        .host
        .prepare_shutdown(&f.pool, &StreamTasks::default(), &approved)
        .await
        .is_err());
    assert!(f.host.shutdown_started());
    assert_eq!(
        f.host.begin_start().await.err().unwrap().code,
        "SHUTDOWN_PENDING"
    );
    let interrupted: bool =
        query_scalar("SELECT EXISTS(SELECT 1 FROM engine_flow030_interruptions)")
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert!(
        !interrupted,
        "a failed native Stop must not publish an interruption"
    );
    assert!(
        f.host.start_lease().await.is_ok(),
        "failed cleanup keeps native ownership"
    );
}

fn fake_executor() -> FakeExecutor {
    FakeExecutor {
        starts: Default::default(),
        started: Default::default(),
        cleanup: None,
        cancelled: Default::default(),
        submitted: None,
        independent_finish: false,
    }
}

#[tokio::test]
async fn native_flow_choices_preserve_received_prompt_through_entry_and_route() {
    use crate::agsdl_host_human030::{HumanAnswer030, HumanOrigin030, HumanSubmission030};
    use crate::agsdl_host_human_executor030::{HumanClockRuntime030, HumanExecutor030};
    use StreamTasks;
    let document = json!({"contract":"agsdl-0.3.0","id":"human-prompt-continuity",
        "agents":{"worker":{"harness":"codex","permissions":"read-only"}},
        "flow":{"entry":"first","steps":{
            "first":{"type":"approval","next":{"continue":"second"}},
            "second":{"type":"approval","next":{"continue":"work"}},
            "work":{"type":"agent","agent":"worker"}}}});
    let f = Fixture::with_document(document).await;
    let app = f.host.clone();
    let tasks = StreamTasks::default();
    let executor = Arc::new(fake_executor());
    let executors = Executors030 {
        agents: executor.clone(),
        calls: None,
        humans: Some(Arc::new(HumanExecutor030 {
            pool: f.pool.clone(),
            tasks: tasks.clone(),
        })),
        clock: Some(Arc::new(HumanClockRuntime030 {
            app: app.as_ref().clone(),
            pool: f.pool.clone(),
            tasks: tasks.clone(),
            identity: f.identity.clone(),
        })),
    };
    let answer_app = app.clone();
    let (pool, identity) = (f.pool.clone(), f.identity.clone());
    let answers = tokio::spawn(async move {
        let host = &answer_app;
        let broker = host
            .flow030()
            .humans
            .broker(&host, &pool, &identity)
            .await
            .unwrap();
        for comment in ["First choice", "Second choice"] {
            let request = loop {
                let request: Option<String> = query_scalar("SELECT request_id FROM engine_flow030_human_requests WHERE system_id=? AND kind='approval' AND resolution_json IS NULL ORDER BY rowid LIMIT 1")
                    .bind(&identity.system_start_id).fetch_optional(&pool).await.unwrap();
                if let Some(request) = request {
                    break request;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            };
            let _operation = broker.operation.lock().await;
            let source: String =
                query_scalar("SELECT capture_json FROM engine_start030_requests WHERE system_id=?")
                    .bind(&identity.system_start_id)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let source: StartCapture030 = serde_json::from_str(&source).unwrap();
            broker
                .submit(
                    &host,
                    HumanSubmission030 {
                        scope: crate::persistence::public030::HumanScope030 {
                            source: source.source,
                            system_start_id: identity.system_start_id.clone(),
                        },
                        request_id: request,
                        expected_revision: "0".into(),
                        answer: HumanAnswer030::Approval {
                            choice: "continue".into(),
                            comment: comment.into(),
                        },
                    },
                    HumanOrigin030::Person,
                )
                .await
                .unwrap();
            broker.pump(&host, &CancellationToken::new()).await.unwrap();
        }
    });
    let event_app = app.as_ref().clone();
    let (pool, config, event_tasks) = (f.pool.clone(), f.config.clone(), tasks.clone());
    let emitter = Arc::new(move |project| {
        native_event_emitter030(
            event_app.clone(),
            pool.clone(),
            config.clone(),
            event_tasks.clone(),
            project,
        )
    });
    let host = &app;
    let (_wake, receiver) = watch::channel(0);
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        supervise_with_emitter030(
            Some(app.as_ref()),
            &host,
            &f.pool,
            &f.config.clone(),
            &tasks,
            &f.owner,
            &executors,
            receiver,
            &CancellationToken::new(),
            emitter,
        ),
    )
    .await;
    answers.abort();
    result.expect("flow choices stalled").unwrap();
    let view = flow::inspect_run(host.flow030(), &host, &f.pool, &f.owner)
        .await
        .unwrap();
    assert_eq!(view.flow.state.verdict.as_deref(), Some("succeeded"));
    assert_eq!(executor.starts.load(Ordering::SeqCst), 1);
    let message: Value = serde_json::from_str(
        view.flow
            .state
            .activations
            .iter()
            .find(|a| a.agent.as_deref() == Some("worker"))
            .unwrap()
            .message_json
            .as_deref()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(message["prompt"], "Start");
    assert_eq!(message["comments"][0]["comment"], "First choice");
    assert_eq!(message["comments"][1]["comment"], "Second choice");
    let sources: Vec<String> =
        query_scalar("SELECT source_json FROM engine_flow030_route_source_attestations")
            .fetch_all(&f.pool)
            .await
            .unwrap();
    assert_eq!(sources.len(), 2);
    for source in sources {
        let source: Value = serde_json::from_str(&source).unwrap();
        assert_eq!(source["provenance"]["prompt"], json!({"kind":"host"}));
        assert_eq!(source["provenance"]["instructions"], json!([]));
    }
}

struct PanickingClock;
impl RuntimeClock030 for PanickingClock {
    fn tick(&self) -> futures::future::BoxFuture<'_, crate::persistence::Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn next_wake(
        &self,
    ) -> futures::future::BoxFuture<'_, crate::persistence::Result<Option<std::time::Duration>>>
    {
        Box::pin(async { panic!("synthetic dispatch panic with active work") })
    }
}
#[tokio::test]
async fn supervisor_panic_waits_for_active_executor_cleanup() {
    let f = Fixture::new(false).await;
    let executor = Arc::new(FakeExecutor {
        cleanup: Some(Arc::new(Notify::new())),
        ..fake_executor()
    });
    let executors: Executors030 = Executors030 {
        agents: executor.clone(),
        calls: None,
        humans: None,
        clock: Some(Arc::new(PanickingClock)),
    };
    let tasks = StreamTasks::default();
    let (_wake, receiver) = watch::channel(0);
    let cancel = CancellationToken::new();
    let native_config = f.config.clone();
    let supervisor = supervise_with_emitter030(
        None,
        &f.host,
        &f.pool,
        &native_config,
        &tasks,
        &f.owner,
        &executors,
        receiver,
        &cancel,
        f.emitter(&tasks),
    );
    tokio::pin!(supervisor);
    tokio::select! {
        result = &mut supervisor => panic!("supervisor returned before cleanup: {result:?}"),
        _ = executor.cancelled.notified() => (),
        _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => panic!("panic did not cancel active work"),
    }
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut supervisor)
            .await
            .is_err(),
        "panic must not bypass the executor's physical cleanup"
    );
    executor.cleanup.as_ref().unwrap().notify_one();
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(5), &mut supervisor)
            .await
            .unwrap()
            .unwrap_err()
            .code,
        "INTERRUPTED"
    );
}
