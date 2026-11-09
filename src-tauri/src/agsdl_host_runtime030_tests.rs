//! Native dispatcher/admission with a distinct fake executor and the real TS
//! controller/route evaluator. Captures and account observations are fixtures.
use super::*;
use crate::agsdl_host_flow030 as flow;
use crate::agsdl_host_runtime030::*;
use crate::agsdl_host_work_admission030::{AttestedWorkPolicy030, PreparedEffectiveAgentWork030};
use crate::db::agsdl_execution::{
    flow030::{FlowEvent030, FlowEventKind030, FlowIdentity030, FlowState030},
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
        let document = json!({"contract":"agsdl-0.3.0","id":"runtime-fixture","agents":{"worker":{"harness":"codex","permissions":"workspace"}},
            "flow":{"entry":"first","steps": if chained { json!({"first":{"type":"agent","agent":"worker","next":"second"},"second":{"type":"agent","agent":"worker"}}) } else { json!({"first":{"type":"agent","agent":"worker"}}) }}});
        let authored = document.to_string();
        let source = json!({"owner":{"projectId":"project","planId":"source","branch":"develop"},"revision":"1","sourceSha256":format!("{:x}",Sha256::digest(authored.as_bytes()))});
        let scope = json!({"projectId":"project","root":workspace,"rootIdentity":crate::fs::operations::workspace_root_identity(&workspace).unwrap().observation_key().unwrap(),"sourceOwner":source["owner"]});
        let capabilities = [
            "result-submission",
            "continuity",
            "permission-enforcement",
            "contained-stop",
            "response-attribution",
            "delivery.queue",
            "resources",
        ]
        .into_iter()
        .map(|name| json!({"name":name,"support":"native","evidenceJson":"{\"fixture\":true}"}))
        .collect::<Vec<_>>();
        let registry = json!({"format":"macro-agsdl-registry/030","version":"fixture","modules":[{"harness":"codex","moduleJson":include_str!("../../src/vendor/agsdl/v0.3/harnesses/codex/module.json")}],
            "harnesses":[{"harness":"codex","version":"0.167.0","installation":"available","adapterId":"distinct-fake-executor","qualified":true,"capabilities":capabilities,"models":[{"name":"fixture","efforts":[],"defaultEffort":null}],"defaultModel":"fixture"}],
            "agents":[{"agentName":"worker","agentDeclarationJson":document["agents"]["worker"].to_string(),"settingsJson":"{}","permissionsJson":"{\"fixture\":true}","scopeJson":scope.to_string(),"evidenceJson":"{\"fixture\":true}","provenanceJson":"{\"fixture\":true}"}],"hostCapabilities":[]});
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
        let raw = serde_json::to_string(&capture).unwrap();
        sqlx::query("INSERT INTO engine_flow030_runs VALUES (?,?,?,?,?,?,?)")
            .bind("system")
            .bind("flow")
            .bind("snapshot")
            .bind("capture")
            .bind(source.to_string())
            .bind(plan)
            .bind(serde_json::to_string(&FlowState030::new(identity.clone())).unwrap())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO engine_start030_requests VALUES (?,?,?,?,?,?,?,?)")
            .bind("request")
            .bind("{}")
            .bind("system")
            .bind("flow")
            .bind("snapshot")
            .bind("capture")
            .bind(&raw)
            .bind("{}")
            .execute(&pool)
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
            .bind(format!("{:x}", Sha256::digest(raw.as_bytes())))
            .execute(&pool)
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
        flow::apply_native_event(
            host.flow030(),
            &host,
            &pool,
            &FlowEvent030 {
                identity: identity.clone(),
                event_id: "enter".into(),
                expected_revision: "0".into(),
                kind: FlowEventKind030::Enter {
                    message_json: "{\"prompt\":\"Start\"}".into(),
                },
            },
        )
        .await
        .unwrap();
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
        Ok(AttestedWorkPolicy030::from_runtime_fixture(prepared))
    }
    fn run(
        &self,
        _work: AgentWork030,
        events: WorkEventSink030,
        cancel: CancellationToken,
    ) -> futures::future::BoxFuture<'static, crate::db::agsdl_execution::Result<()>> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        self.started.notify_one();
        let independent = self.independent_finish;
        let (cleanup, cancelled, submitted) = (
            self.cleanup.clone(),
            self.cancelled.clone(),
            self.submitted.clone(),
        );
        Box::pin(async move {
            if let Some(signal) = submitted {
                events
                    .emit(
                        json!({"kind":"submit","callId":"fake","argumentsJson":"{}"}),
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
                        json!({"kind":"submit","callId":"fake","argumentsJson":"{}"}),
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
    let executors = Executors030 {
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
    let executors = Executors030 {
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
    let executors = Executors030 {
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
    let executors = Executors030 {
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
    let executors = Executors030 {
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
    let executors = Executors030 {
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
        Ok(AttestedWorkPolicy030::from_runtime_fixture(prepared))
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
    let executors = Executors030 {
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
