//! Native dispatcher/admission with a distinct fake executor and the real TS
//! controller/route evaluator. Captures and account observations are fixtures.
use super::*;
use crate::agsdl_host_flow030 as flow;
use crate::agsdl_host_runtime030::*;
use crate::agsdl_host_work_admission030::{AttestedWorkPolicy030, PreparedEffectiveAgentWork030};
use crate::db::agsdl_execution::{
    flow030::{FlowEffect030, FlowEvent030, FlowEventKind030, FlowIdentity030},
    start030::StartCapture030,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::{
    io::AsyncWriteExt,
    sync::{watch, Notify},
};
use tokio_util::sync::CancellationToken;

async fn bun(script: &str, value: &impl serde::Serialize) -> Value {
    let mut child = crate::core::process::background_tokio_command("bun")
        .args(["-e", script])
        .current_dir(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap(),
        )
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(value).unwrap())
        .await
        .unwrap();
    let output = child.wait_with_output().await.unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
// Fake native observation; persistence and entry use the production Start transaction.
struct FixtureStart030 {
    capture: StartCapture030,
}
impl crate::db::agsdl_execution::flow_store030::Authority030 for FixtureStart030 {
    fn owner<'a>(
        &'a self,
        db: &'a mut sqlx::SqliteConnection,
        id: &'a FlowIdentity030,
    ) -> crate::db::agsdl_execution::flow_store030::CheckFuture<'a> {
        Box::pin(async move {
            let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM engine_flow030_owners WHERE system_id=? AND invocation_id=? AND owner_epoch='owner' AND generation='generation' AND status='live')")
                .bind(&id.system_start_id).bind(&id.flow_invocation_id).fetch_one(db).await?;
            if exists {
                Ok(())
            } else {
                Err(crate::db::agsdl_execution::flow_store030::StoreError030::Authority)
            }
        })
    }
    fn effect<'a>(
        &'a self,
        _: &'a mut sqlx::SqliteConnection,
        _: &'a FlowEffect030,
    ) -> crate::db::agsdl_execution::flow_store030::CheckFuture<'a> {
        Box::pin(async { Err(crate::db::agsdl_execution::flow_store030::StoreError030::Authority) })
    }
    fn settlement<'a>(
        &'a self,
        _: &'a mut sqlx::SqliteConnection,
        _: &'a FlowEffect030,
        _: &'a Value,
    ) -> crate::db::agsdl_execution::flow_store030::CheckFuture<'a> {
        Box::pin(async { Err(crate::db::agsdl_execution::flow_store030::StoreError030::Authority) })
    }
    fn owner_epoch(&self) -> &str {
        "owner"
    }
}
impl crate::db::agsdl_execution::start030::StartAuthority030 for FixtureStart030 {
    type SourceGuard = ();
    fn require_clear(
        &self,
        _: &crate::db::agsdl_execution::dto::EngineStartRequest,
    ) -> crate::db::agsdl_execution::Result<()> {
        Ok(())
    }
    fn begin_commit(
        &self,
        _: &crate::db::agsdl_execution::dto::EngineStartRequest,
        _: &FlowIdentity030,
    ) -> crate::db::agsdl_execution::Result<()> {
        Ok(())
    }
    fn commit_acknowledged(
        &self,
        _: &crate::db::agsdl_execution::dto::EngineStartRequest,
        _: &FlowIdentity030,
    ) {
    }
    async fn capture(
        &self,
        _: &crate::db::agsdl_execution::dto::EngineStartRequest,
    ) -> crate::db::agsdl_execution::Result<StartCapture030> {
        Ok(self.capture.clone())
    }
    async fn lock_source(
        &self,
        _: &crate::db::agsdl_execution::dto::EngineStartRequest,
    ) -> crate::db::agsdl_execution::Result<()> {
        Ok(())
    }
    async fn bind_capture_tx(
        &self,
        db: &mut sqlx::SqliteConnection,
        _: &crate::db::agsdl_execution::dto::EngineStartRequest,
        capture: &StartCapture030,
    ) -> crate::db::agsdl_execution::Result<()> {
        let raw = serde_json::to_vec(capture)?;
        sqlx::query("INSERT INTO engine_flow030_owners VALUES (?,?,?,?,?,?,?,?)")
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
    config: crate::config::ConfigManager,
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
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let workspace = root.join("workspace");
        let metadata = root.join("metadata");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::create_dir(&metadata).unwrap();
        let config = crate::config::ConfigManager::initialize(root.join("config"))
            .await
            .unwrap();
        config
            .register_project_root("project", metadata)
            .await
            .unwrap();
        let authored = document.to_string();
        let source = json!({"owner":{"projectId":"project","planId":"source","branch":"develop"},"revision":"1","sourceSha256":format!("{:x}",Sha256::digest(authored.as_bytes()))});
        let scope = json!({"projectId":"project","root":workspace,"rootIdentity":crate::fs::operations::workspace_root_identity(&workspace).unwrap().observation_key().unwrap(),"sourceOwner":source["owner"]});
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
        let (harness, agents) = crate::agsdl_host_capture::codex_registry030(
            &document,
            source["sourceSha256"].as_str().unwrap(),
            &scope,
            &observed,
        )
        .unwrap();
        let registry = json!({"format":"macro-agsdl-registry/030","version":"fixture","modules":[{"harness":"codex","moduleJson":include_str!("../../src/vendor/agsdl/v0.3/harnesses/codex/module.json")}],"harnesses":[harness],"agents":agents,"hostCapabilities":[]});
        let compiled = bun("import {compileHost030} from './src/services/agsdlExecution/hostCompilation';const j=JSON.parse(await Bun.stdin.text());process.stdout.write(await compileHost030(j.authored,j.source,j.registry));", &json!({"authored":authored,"source":source,"registry":registry})).await;
        let plan = compiled["compiledPlanJson"]
            .as_str()
            .unwrap_or_else(|| panic!("compiler: {compiled}"))
            .to_owned();
        let identity = FlowIdentity030 {
            system_start_id: "system".into(),
            flow_invocation_id: "flow".into(),
            snapshot_id: "snapshot".into(),
            epoch: "capture".into(),
        };
        let tools = config.lock_execution_tools("project").await.unwrap();
        let permissions = crate::agsdl_host_tools::permissions("Implement", false, &tools.tools)
            .unwrap()
            .to_string();
        drop(tools);
        let capture = StartCapture030 { identity:identity.clone(), source:serde_json::from_value(source.clone()).unwrap(), versions:serde_json::from_value(serde_json::from_str::<Value>(&plan).unwrap()["versions"].clone()).unwrap(),
            authored_source:authored, compiled_plan_json:plan.clone(), registry_json:registry.to_string(), private_capture_json:json!({"format":"macro-native-flow-capture/030","callPermissionsJson":permissions,"callScopeJson":scope.to_string()}).to_string() };
        let pool = crate::db::create_pool(&root.join("run.db")).await.unwrap();
        let request = serde_json::from_value(json!({"source":source,"profile":"macro-agsdl-030-v1", "associations":{}, "requestId":"request", "entry":{"deliveryId":"delivery", "messageJson":"{\"prompt\":\"Start\"}"}})).unwrap();
        crate::db::agsdl_execution::start030::start_linked(
            &pool,
            &request,
            &FixtureStart030 { capture },
            None,
        )
        .await
        .unwrap();
        let owner = EngineOwner {
            system_start_id: "system".into(),
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
            loads: AtomicUsize::new(0),
            owners: Mutex::new(BTreeMap::from([("system".into(), owner.clone())])),
            qa_request: Mutex::new(None),
        });
        let host = Arc::new(HostState(
            Mutex::new(Some(OwnedHost {
                incarnation: incarnation.clone(),
                resource: 0,
            })),
            Default::default(),
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
            incarnation,
            owner,
            identity,
        }
    }
    fn emitter(
        &self,
        tasks: &crate::ai::stream_tasks::StreamTasks,
    ) -> Arc<dyn Fn(String) -> EventEmitter030 + Send + Sync> {
        let (host, pool, config) = (self.host.clone(), self.pool.clone(), self.config.clone());
        let tasks = tasks.clone();
        Arc::new(move |_| {
            let (host, pool, config, tasks) =
                (host.clone(), pool.clone(), config.clone(), tasks.clone());
            Arc::new(move |attempt, label, body, cancel| {
                let (host, pool, config, tasks) =
                    (host.clone(), pool.clone(), config.clone(), tasks.clone());
                Box::pin(async move {
                    emit_work_event030(
                        &host, &pool, &config, &tasks, &attempt, "project", &label, body, &cancel,
                    )
                    .await
                })
            })
        })
    }
    fn pumps(&self) -> Vec<tokio::task::JoinHandle<()>> {
        self.pumps_with_physical_hook(None)
    }
    fn pumps_with_physical_hook(
        &self,
        physical: Option<(Arc<Notify>, Arc<Notify>)>,
    ) -> Vec<tokio::task::JoinHandle<()>> {
        let work = self.incarnation.clone();
        let route = self.incarnation.clone();
        vec![
            tokio::spawn(async move {
                loop {
                    let job = work.work_protocol.next().await.unwrap();
                    if job.input.event_json.contains("physicalEnded") {
                        if let Some((reached, release)) = &physical {
                            reached.notify_one();
                            release.notified().await;
                        }
                    }
                    let output = bun("import {evaluateHostWork030} from './src/services/agsdlExecution/hostWorkTransition030';import {connectValueSchemaValidator030} from './src/services/agsdlExecution/valueSchemaPort030';import {NumberToken,parse} from './src/vendor/agsdl/v0.3/json.mjs';import {validate} from './src/vendor/agsdl/v0.3/valueschema.mjs';const {input:i}=JSON.parse(await Bun.stdin.text());process.stdout.write(JSON.stringify(evaluateHostWork030(i.context,i.eventId,i.expectedRevision,i.contractJson,i.stateJson,i.eventJson,i.optionsJson,connectValueSchemaValidator030({NumberToken,parse,validate}))));", &job).await;
                    work.work_protocol
                        .complete(
                            &job.generation,
                            crate::agsdl_host_work::HostWorkCompletion030 {
                                ticket: job.ticket,
                                input_digest: job.input_digest,
                                generation: job.generation.clone(),
                                output: serde_json::from_value(output).unwrap(),
                            },
                        )
                        .unwrap();
                }
            }),
            tokio::spawn(async move {
                loop {
                    let job = route.route030.next().await.unwrap();
                    let output = bun("import {createHostRoutePort030} from './src/services/agsdlExecution/hostRouteBroker030';const j=JSON.parse(await Bun.stdin.text());process.stdout.write(JSON.stringify(await createHostRoutePort030(j.generation).evaluate(j)));",&job).await;
                    route
                        .route030
                        .complete(
                            &job.generation,
                            crate::agsdl_host_route030::HostRouteCompletion030 {
                                ticket: job.ticket,
                                generation: job.generation.clone(),
                                input_digest: job.input_digest,
                                output: serde_json::from_value(output).unwrap(),
                            },
                        )
                        .unwrap();
                }
            }),
        ]
    }
}
struct FakeExecutor {
    starts: Arc<AtomicUsize>,
    started: Arc<Notify>,
    cleanup: Option<Arc<Notify>>,
    cancelled: Arc<Notify>,
    submitted: Option<Arc<Notify>>,
    independent_finish: bool,
}
impl AgentExecutor030 for FakeExecutor {
    fn prepare(
        &self,
        prepared: PreparedEffectiveAgentWork030,
    ) -> crate::db::agsdl_execution::Result<AttestedWorkPolicy030> {
        AttestedWorkPolicy030::from_codex(prepared)
    }
    fn run(
        &self,
        work: AgentWork030,
        events: WorkEventSink030,
        cancel: CancellationToken,
    ) -> futures::future::BoxFuture<'static, crate::db::agsdl_execution::Result<()>> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        let started = self.started.clone();
        let submission = if work.attempt.agent() == "reviewer" {
            "{\"choice\":\"approve\"}"
        } else {
            "{}"
        };
        let writer = work.attempt.agent() == "writer";
        let independent = self.independent_finish;
        let (cleanup, cancelled, submitted) = (
            self.cleanup.clone(),
            self.cancelled.clone(),
            self.submitted.clone(),
        );
        Box::pin(async move {
            if writer {
                events.emit(json!({"kind":"visibleText","messageId":"draft","textParts":["Synthetic draft"]}), &cancel).await?;
            }
            started.notify_one();
            if let Some(signal) = submitted {
                events
                    .emit(
                        json!({"kind":"submit","callId":"fake","argumentsJson":submission}),
                        &cancel,
                    )
                    .await?;
                signal.notify_one();
            }
            if let Some(cleanup) = cleanup {
                if !independent {
                    cancel.cancelled().await;
                    cancelled.notify_one();
                }
                cleanup.notified().await;
            } else {
                events
                    .emit(
                        json!({"kind":"submit","callId":"fake","argumentsJson":submission}),
                        &cancel,
                    )
                    .await?;
            }
            Ok(())
        })
    }
}
#[tokio::test]
async fn distinct_executor_chains_two_works_without_double_dispatch() {
    let f = Fixture::new(true).await;
    let pumps = f.pumps();
    let tasks = crate::ai::stream_tasks::StreamTasks::default();
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
            &f.config,
            &tasks,
            &f.owner,
            &executors,
            receiver,
            &CancellationToken::new(),
            emitter,
        ),
    )
    .await;
    for pump in pumps {
        pump.abort();
    }
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
    let tasks = crate::ai::stream_tasks::StreamTasks::default();
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
    let supervisor = supervise_with_emitter030(
        None, &f.host, &f.pool, &f.config, &tasks, &f.owner, &executors, receiver, &cancel, emitter,
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
    let tasks = crate::ai::stream_tasks::StreamTasks::default();
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
        &f.config,
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
    fn tick(&self) -> futures::future::BoxFuture<'_, crate::db::agsdl_execution::Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn next_wake(
        &self,
    ) -> futures::future::BoxFuture<
        '_,
        crate::db::agsdl_execution::Result<Option<std::time::Duration>>,
    > {
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
    let pumps = f.pumps();
    let tasks = crate::ai::stream_tasks::StreamTasks::default();
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
    let supervisor = supervise_with_emitter030(
        None,
        &f.host,
        &f.pool,
        &f.config,
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
    for pump in pumps {
        pump.abort();
    }
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
    let pumps = f.pumps_with_physical_hook(Some((reached.clone(), release.clone())));
    let tasks = crate::ai::stream_tasks::StreamTasks::default();
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
    let supervisor = supervise_with_emitter030(
        None,
        &f.host,
        &f.pool,
        &f.config,
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
    for pump in pumps {
        pump.abort();
    }
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
    let tasks = crate::ai::stream_tasks::StreamTasks::default();
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
            &f.config,
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
    ) -> crate::db::agsdl_execution::Result<AttestedWorkPolicy030> {
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
                Ok::<_, crate::db::agsdl_execution::dto::EngineFailure>(())
            })
        })?;
        AttestedWorkPolicy030::from_codex(prepared)
    }
    fn run(
        &self,
        _work: AgentWork030,
        _events: WorkEventSink030,
        _cancel: CancellationToken,
    ) -> futures::future::BoxFuture<'static, crate::db::agsdl_execution::Result<()>> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { panic!("Stop invalidated this start before its claim") })
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_between_preparation_and_claim_does_not_start_or_interrupt_the_supervisor() {
    let f = Fixture::new(false).await;
    let tasks = crate::ai::stream_tasks::StreamTasks::default();
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
            &f.config,
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
    let pumps = f.pumps();
    let tasks = crate::ai::stream_tasks::StreamTasks::default();
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
            &f.config,
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
    for pump in pumps {
        pump.abort();
    }
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

struct CommandFixture {
    fixture: Fixture,
    app: tauri::App<tauri::test::MockRuntime>,
    request: crate::db::agsdl_execution::dto::EngineStartRequest,
    pumps: Vec<tokio::task::JoinHandle<()>>,
    compiler: tokio::task::JoinHandle<()>,
}
impl CommandFixture {
    async fn new(executor: Arc<dyn AgentExecutor030>, with_ai: bool) -> Self {
        use crate::db::agsdl_execution::dto::{
            EngineAssociations, EngineEntry, EngineSourceOwner, EngineStartRequest,
        };
        use crate::workspace::metadata::{ProjectDto, WorkspaceState};
        let document = json!({"contract":"agsdl-0.3.0","id":"codex-demo","agents":{
        "writer":{"harness":"codex","permissions":"workspace","model":{"name":"fixture","effort":"high"}},
        "reviewer":{"harness":"codex","permissions":"read-only"}},
        "flow":{"entry":"write","steps":{
            "write":{"type":"agent","agent":"writer","maxVisits":3,"next":"review"},
            "review":{"type":"agent","agent":"reviewer","maxVisits":3,"next":{"approve":[],"revise":"write"}}}}});
        let mut fixture = Fixture::with_document(document.clone()).await;
        let root = fixture._temp.path().canonicalize().unwrap();
        let workspace = root.join("workspace");
        let metadata = workspace.join(".macro");
        let project = workspace.join("project");
        let dir = project.join(".macro/branches/develop/plans/source");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&metadata).unwrap();
        let registered: ProjectDto = serde_json::from_value(json!({
        "id":"project", "name":"Synthetic", "path":project, "created_at":"2026-01-01", "status":"active",
        "directEdit":true, "gitSetupState":"not_git", "metadata":{"description":"", "tags":[], "team_members":[], "api_contracts":[], "dependencies":[]}
    })).unwrap();
        let mut state = WorkspaceState::default();
        state.standalone_projects.push(registered);
        std::fs::write(
            metadata.join("workspace.json"),
            serde_json::to_vec(&state).unwrap(),
        )
        .unwrap();
        std::fs::write(dir.join("plan.json"), serde_json::to_vec(&json!({
        "id":"source", "projectIds":["project"], "revision":1, "updatedAt":"time", "agsdl":{"source":document.to_string()}
    })).unwrap()).unwrap();
        let scope = EngineSourceOwner {
            project_id: "project".into(),
            plan_id: "source".into(),
            branch: "develop".into(),
        };
        let locked = crate::workspace::architect::lock_execution_source_owner(
            &workspace, &metadata, &scope, None,
        )
        .await
        .unwrap();
        let request = EngineStartRequest {
            source: locked.revision.clone(),
            profile: "macro-agsdl-030-v1".into(),
            associations: EngineAssociations::default(),
            request_id: "production-start".into(),
            entry: Some(EngineEntry {
                delivery_id: "delivery".into(),
                message_json: "{\"prompt\":\"Start\"}".into(),
            }),
        };
        drop(locked);
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
        crate::agsdl_host_capture::test_codex_observations030()
            .lock()
            .unwrap()
            .insert(workspace.clone(), observed);
        fixture.pool = crate::db::create_pool(&root.join("production-start.db"))
            .await
            .unwrap();
        let compiler = fixture.incarnation.clone();
        let worker = tokio::spawn(async move {
            let job = compiler.compiler.next().await.unwrap();
            let script = "import {compileHost030} from './src/services/agsdlExecution/hostCompilation';const j=JSON.parse(await Bun.stdin.text());process.stdout.write(await compileHost030(j.authoredSource,j.source,JSON.parse(j.registryJson)));";
            let mut child = crate::core::process::background_tokio_command("bun")
                .args(["-e", script])
                .current_dir(
                    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                        .parent()
                        .unwrap(),
                )
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(&serde_json::to_vec(&job).unwrap())
                .await
                .unwrap();
            let output = child.wait_with_output().await.unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            compiler
                .compiler
                .complete(
                    &job.generation,
                    &job.ticket,
                    String::from_utf8(output.stdout).unwrap(),
                )
                .unwrap();
        });
        let pumps = fixture.pumps();
        let host = Arc::try_unwrap(std::mem::take(&mut fixture.host))
            .ok()
            .unwrap();
        let db = crate::commands::DbPool::default();
        db.set_ready(fixture.pool.clone()).await.unwrap();
        let mut builder = tauri::test::mock_builder()
            .manage(host)
            .manage(db)
            .manage(fixture.config.clone())
            .manage(crate::git::GitState::new())
            .manage(crate::WorkspaceMetadataRoot(Arc::new(
                tokio::sync::RwLock::new(workspace),
            )))
            .manage(TestAgentExecutor030(executor));
        if with_ai {
            builder = builder.manage(crate::ai::AiState::default());
        }
        let app = builder
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        Self {
            fixture,
            app,
            request,
            pumps,
            compiler: worker,
        }
    }
    async fn start(
        &self,
    ) -> crate::db::agsdl_execution::Result<crate::db::agsdl_execution::public::PublicStartReceipt>
    {
        crate::commands::agsdl_execution::execution_start(
            self.app.handle().clone(),
            self.request.clone(),
        )
        .await
    }
    fn host(&self) -> tauri::State<'_, HostState> {
        self.app.state::<HostState>()
    }
    async fn only_system(&self) -> String {
        sqlx::query_scalar("SELECT system_id FROM engine_start030_requests")
            .fetch_one(&self.fixture.pool)
            .await
            .unwrap()
    }
    async fn interrupted(&self, system: &str) -> bool {
        sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM engine_flow030_interruptions WHERE system_id=?)",
        )
        .bind(system)
        .fetch_one(&self.fixture.pool)
        .await
        .unwrap()
    }
    async fn finish(self) {
        self.compiler.await.unwrap();
        for pump in self.pumps {
            pump.abort();
        }
        let workspace = self
            .fixture
            ._temp
            .path()
            .canonicalize()
            .unwrap()
            .join("workspace");
        crate::agsdl_host_capture::test_codex_observations030()
            .lock()
            .unwrap()
            .remove(&workspace);
    }
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
async fn execution_start_attaches_supervisor_and_completes_write_review() {
    let _secret_guard = crate::secrets::lock_test_store();
    let secret_root = tempfile::tempdir().unwrap();
    crate::secrets::init(secret_root.path()).unwrap();
    let executor = Arc::new(fake_executor());
    let f = CommandFixture::new(executor.clone(), true).await;
    // No repository is required by Start or history, even beneath another repo.
    let parent_repo = git2::Repository::init(f.fixture._temp.path()).unwrap();
    let workspace = f
        .fixture
        ._temp
        .path()
        .canonicalize()
        .unwrap()
        .join("workspace");
    assert!(!workspace.join(".git").exists());
    let receipt = tokio::time::timeout(std::time::Duration::from_secs(15), f.start())
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        f.host()
            .flow030()
            .supervisors
            .wait(&receipt.system_start_id),
    )
    .await
    .unwrap()
    .unwrap();
    let owner = EngineOwner {
        system_start_id: receipt.system_start_id.clone(),
        owner_epoch: "0".into(),
    };
    let result = flow::inspect_run(f.host().flow030(), &f.host(), &f.fixture.pool, &owner)
        .await
        .unwrap();
    assert_eq!(result.flow.state.verdict.as_deref(), Some("succeeded"));
    assert_eq!(executor.starts.load(Ordering::SeqCst), 2);
    assert!(result
        .flow
        .state
        .activations
        .iter()
        .any(|activation| activation.agent.as_deref() == Some("reviewer")
            && activation
                .message_json
                .as_deref()
                .is_some_and(|message| message.contains("Synthetic draft"))));
    // Replaying the same command returns the retained run, even after completion.
    assert_eq!(
        f.start().await.unwrap().system_start_id,
        receipt.system_start_id
    );
    assert_eq!(executor.starts.load(Ordering::SeqCst), 2);
    assert!(!f.interrupted(&receipt.system_start_id).await);
    let history = crate::commands::agsdl_execution::list_runs030_scoped(
        &f.fixture.pool,
        &workspace,
        crate::db::agsdl_execution::discovery030::RunListRequest030 {
            owner: receipt.snapshot.source.owner.clone(),
            after: None,
            limit: Some(20),
        },
    )
    .await
    .unwrap();
    assert_eq!(history.runs.len(), 1);
    assert_eq!(history.runs[0].system_start_id, receipt.system_start_id);
    assert!(!parent_repo
        .path()
        .join(crate::git::MACRO_WORKTREE_DIR_NAME)
        .exists());

    // A fresh host has no resident owner for this run. Historical observation
    // must still work, without reattaching a supervisor or starting an agent.
    let fresh_host = crate::agsdl_host::route_attestation_test_host030(
        EngineOwner {
            system_start_id: "another-run".into(),
            owner_epoch: "0".into(),
        },
        "new-generation",
    );
    let query = crate::agsdl_host_projection030::RuntimeProjectionQuery030 {
        system_start_id: receipt.system_start_id.clone(),
        source: result.capture.source.clone(),
        snapshot_id: Some(result.capture.identity.snapshot_id.clone()),
    };
    let historical =
        crate::agsdl_host_projection030::read(&fresh_host, &f.fixture.pool, query.clone(), None)
            .await
            .unwrap();
    assert_eq!(historical.verdict.as_deref(), Some("succeeded"));
    assert_eq!(
        historical.flow_invocation_id,
        result.capture.identity.flow_invocation_id
    );
    let mut wrong_scope = query;
    wrong_scope.source.owner.branch = "another-branch".into();
    assert_eq!(
        crate::agsdl_host_projection030::read(&fresh_host, &f.fixture.pool, wrong_scope, None)
            .await
            .unwrap_err()
            .code,
        "CORRELATION"
    );
    assert_eq!(executor.starts.load(Ordering::SeqCst), 2);

    let root = f.fixture._temp.path().canonicalize().unwrap();
    let dir = root.join("workspace/project/.macro/branches/develop/plans/source");
    let mut plan: Value =
        serde_json::from_slice(&std::fs::read(dir.join("plan.json")).unwrap()).unwrap();
    let mut unsupported: Value =
        serde_json::from_str(plan["agsdl"]["source"].as_str().unwrap()).unwrap();
    unsupported["flow"]["steps"]["write"]["timeoutMs"] = json!(1000);
    plan["agsdl"]["source"] = json!(unsupported.to_string());
    plan["revision"] = json!(2);
    std::fs::write(dir.join("plan.json"), serde_json::to_vec(&plan).unwrap()).unwrap();
    let workspace = root.join("workspace");
    let locked = crate::workspace::architect::lock_execution_source_owner(
        &workspace,
        &workspace.join(".macro"),
        &f.request.source.owner,
        None,
    )
    .await
    .unwrap();
    let mut refused = f.request.clone();
    refused.source = locked.revision.clone();
    refused.request_id = "unsupported-start".into();
    drop(locked);
    let error = crate::commands::agsdl_execution::execution_start(f.app.handle().clone(), refused)
        .await
        .err()
        .unwrap();
    assert_eq!(error.code, "UNSUPPORTED_030_FEATURE");
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM engine_start030_requests")
        .fetch_one(&f.fixture.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    f.finish().await;
}

#[tokio::test]
async fn execution_stop_waits_for_fake_executor_physical_end() {
    let _secret_guard = crate::secrets::lock_test_store();
    let secret_root = tempfile::tempdir().unwrap();
    crate::secrets::init(secret_root.path()).unwrap();
    let executor = Arc::new(FakeExecutor {
        cleanup: Some(Arc::new(Notify::new())),
        ..fake_executor()
    });
    let f = CommandFixture::new(executor.clone(), true).await;
    let receipt = f.start().await.unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        executor.started.notified(),
    )
    .await
    .unwrap();
    assert_eq!(
        f.start().await.unwrap().system_start_id,
        receipt.system_start_id
    );
    assert_eq!(executor.starts.load(Ordering::SeqCst), 1);
    let app = f.app.handle().clone();
    let system = receipt.system_start_id.clone();
    let mut stop = tokio::spawn(async move {
        crate::commands::agsdl_execution::execution_stop(
            app.clone(),
            app.state(),
            app.state(),
            crate::db::agsdl_execution::dto::EngineStopRequest {
                system_start_id: system,
                request_id: "command-stop".into(),
                activation_id: None,
            },
        )
        .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        executor.cancelled.notified(),
    )
    .await
    .unwrap();
    let app = f.app.handle().clone();
    let system = receipt.system_start_id.clone();
    let mut ensure = tokio::spawn(async move {
        crate::commands::agsdl_execution::execution_ensure_stop(
            app,
            crate::db::agsdl_execution::intents::ExecutionEnsureStopRequest {
                system_start_id: system,
                activation_id: None,
            },
        )
        .await
    });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut stop)
            .await
            .is_err(),
        "Stop returned before the executor's physical end"
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut ensure)
            .await
            .is_err(),
        "EnsureStop returned before physical end"
    );
    executor.cleanup.as_ref().unwrap().notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(5), stop)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), ensure)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(executor.starts.load(Ordering::SeqCst), 1);
    let owner = EngineOwner {
        system_start_id: receipt.system_start_id,
        owner_epoch: "0".into(),
    };
    let result = flow::inspect_run(f.host().flow030(), &f.host(), &f.fixture.pool, &owner)
        .await
        .unwrap();
    assert_eq!(result.flow.state.verdict.as_deref(), Some("cancelled"));
    assert!(result
        .flow
        .state
        .activations
        .iter()
        .all(|work| !work.physical));
    f.finish().await;
}

#[tokio::test]
async fn execution_start_attachment_failure_releases_waiters_even_when_marker_fails() {
    let _secret_guard = crate::secrets::lock_test_store();
    let secret_root = tempfile::tempdir().unwrap();
    crate::secrets::init(secret_root.path()).unwrap();
    for fail_marker in [false, true] {
        // Missing managed state fails after commit, before supervisor attachment.
        let f = CommandFixture::new(Arc::new(fake_executor()), false).await;
        if fail_marker {
            sqlx::query("CREATE TRIGGER fail_marker BEFORE INSERT ON engine_flow030_interruptions BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END").execute(&f.fixture.pool).await.unwrap();
        }
        assert!(f.start().await.is_err());
        let system = f.only_system().await;
        assert!(tokio::time::timeout(
            std::time::Duration::from_secs(2),
            f.host().flow030().supervisors.wait(&system)
        )
        .await
        .unwrap()
        .is_err());
        assert_eq!(f.interrupted(&system).await, !fail_marker);
        if fail_marker {
            sqlx::query("DROP TRIGGER fail_marker")
                .execute(&f.fixture.pool)
                .await
                .unwrap();
            flow::interrupt_previous_runs030(&f.fixture.pool)
                .await
                .unwrap();
            assert!(f.interrupted(&system).await);
        }
        f.finish().await;
    }
}

struct FailingPreparation {
    panic: bool,
}
impl AgentExecutor030 for FailingPreparation {
    fn prepare(
        &self,
        _: PreparedEffectiveAgentWork030,
    ) -> crate::db::agsdl_execution::Result<AttestedWorkPolicy030> {
        assert!(!self.panic, "synthetic supervisor panic");
        Err(crate::db::agsdl_execution::failure(
            "HOST_CAPABILITY",
            "test",
            "Synthetic preparation failure",
        ))
    }
    fn run(
        &self,
        _: AgentWork030,
        _: WorkEventSink030,
        _: CancellationToken,
    ) -> futures::future::BoxFuture<'static, crate::db::agsdl_execution::Result<()>> {
        unreachable!("failed preparation must never start work")
    }
}
#[tokio::test]
async fn supervisor_error_and_panic_mark_interrupted_and_release_waiters() {
    let _secret_guard = crate::secrets::lock_test_store();
    let secret_root = tempfile::tempdir().unwrap();
    crate::secrets::init(secret_root.path()).unwrap();
    for panic in [false, true] {
        let f = CommandFixture::new(Arc::new(FailingPreparation { panic }), true).await;
        let receipt = f.start().await.unwrap();
        let error = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            f.host()
                .flow030()
                .supervisors
                .wait(&receipt.system_start_id),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert_eq!(
            error.code,
            if panic {
                "INTERRUPTED"
            } else {
                "HOST_CAPABILITY"
            }
        );
        assert!(f.interrupted(&receipt.system_start_id).await);
        f.finish().await;
    }
}

struct PanickingClock;
impl RuntimeClock030 for PanickingClock {
    fn tick(&self) -> futures::future::BoxFuture<'_, crate::db::agsdl_execution::Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn next_wake(
        &self,
    ) -> futures::future::BoxFuture<
        '_,
        crate::db::agsdl_execution::Result<Option<std::time::Duration>>,
    > {
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
    let tasks = crate::ai::stream_tasks::StreamTasks::default();
    let (_wake, receiver) = watch::channel(0);
    let cancel = CancellationToken::new();
    let supervisor = supervise_with_emitter030(
        None,
        &f.host,
        &f.pool,
        &f.config,
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
