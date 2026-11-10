//! Official run scenarios against native persistence, dispatch and TS ports.
use super::*;
use crate::agsdl_host_flow030 as flow;
use crate::agsdl_host_runtime030::*;
use crate::agsdl_host_scenario030::{
    self as scenarios, ExampleResult030, TimelineEvent030, WorkKey030,
};
use crate::agsdl_host_work_admission030::{AttestedWorkPolicy030, PreparedEffectiveAgentWork030};
use crate::db::agsdl_execution::{flow030::*, start030::StartCapture030, Result};
use futures::{future::BoxFuture, FutureExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::watch,
};
use tokio_util::sync::CancellationToken;

#[path = "agsdl_host_conformance030_projection.rs"]
mod projection;

struct BunHost {
    child: tokio::process::Child,
    input: tokio::process::ChildStdin,
    output: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    sequence: u64,
}
impl BunHost {
    fn start() -> Self {
        let mut child = crate::core::process::background_tokio_command("bun")
            .arg("dev/agsdl/conformance-host030.ts")
            .current_dir(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap(),
            )
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .expect("Bun is required for AgSDL conformance; this test never skips");
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap()).lines();
        Self {
            child,
            input,
            output,
            sequence: 0,
        }
    }
    async fn request(&mut self, mut request: Value) -> Value {
        self.sequence += 1;
        request["id"] = self.sequence.into();
        let mut bytes = serde_json::to_vec(&request).unwrap();
        bytes.push(b'\n');
        self.input.write_all(&bytes).await.unwrap();
        let line =
            tokio::time::timeout(std::time::Duration::from_secs(15), self.output.next_line())
                .await
                .expect("Bun evaluator timed out")
                .unwrap()
                .expect("Bun evaluator exited");
        let reply: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(reply["id"], request["id"]);
        assert!(reply.get("error").is_none(), "Bun evaluator: {reply}");
        reply["output"].clone()
    }
    async fn close(mut self) {
        self.input.shutdown().await.unwrap();
        drop(self.input);
        let status = tokio::time::timeout(std::time::Duration::from_secs(5), self.child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(status.success(), "Bun evaluator: {status}");
    }
}

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
    app: tauri::App<tauri::test::MockRuntime>,
    pool: sqlx::SqlitePool,
    config: crate::config::ConfigManager,
    incarnation: Arc<Incarnation>,
    owner: EngineOwner,
    identity: FlowIdentity030,
    plan: FlowPlan030,
}
impl Fixture {
    async fn new(raw: &str, bun: &mut BunHost) -> Self {
        let fixture: Value = serde_json::from_str(raw).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let workspace = root.join("workspace");
        let metadata = root.join("metadata");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::create_dir(&metadata).unwrap();
        let config = crate::config::ConfigManager::initialize(root.join("config"))
            .await
            .unwrap();
        let tools_document = config
            .get_document(
                crate::config::ConfigDocumentKind::Tools,
                crate::config::ConfigScope::User,
            )
            .await
            .unwrap();
        let mut approved_tools = tools_document.value;
        approved_tools["agsdlHostPermissions"] = json!("workspace");
        std::fs::write(
            &tools_document.file_path,
            serde_json::to_vec(&approved_tools).unwrap(),
        )
        .unwrap();
        let pending = config
            .reload(
                crate::config::ConfigDocumentKind::Tools,
                crate::config::ConfigScope::User,
                crate::config::ConfigChangeSource::ExternalEditor,
            )
            .await
            .unwrap()
            .pending
            .unwrap();
        config.accept_pending_change(&pending.id).await.unwrap();
        assert_eq!(
            serde_json::to_value(
                config
                    .lock_agsdl_host_permissions()
                    .await
                    .unwrap()
                    .permissions()
            )
            .unwrap(),
            json!("workspace")
        );
        config
            .register_project_root("project", metadata)
            .await
            .unwrap();
        // Read exact source text from the fixture, preserving numeric tokens.
        let fields: BTreeMap<String, Box<serde_json::value::RawValue>> =
            serde_json::from_str(raw).unwrap();
        let authored = fields["document"].get().to_owned();
        let document: Value = serde_json::from_str(&authored).unwrap();
        let source = json!({"owner":{"projectId":"project","planId":"source","branch":"develop"},"revision":"1","sourceSha256":format!("{:x}",Sha256::digest(authored.as_bytes()))});
        let scope = json!({"projectId":"project","root":workspace,"rootIdentity":crate::fs::operations::workspace_root_identity(&workspace).unwrap().observation_key().unwrap(),"sourceOwner":source["owner"]});
        let mut registry = if document["agents"].as_object().unwrap().is_empty() {
            json!({"format":"macro-agsdl-registry/030", "version":"fixture", "modules":[], "harnesses":[], "agents":[], "hostCapabilities":[{"name":"call.command","support":"native","evidenceJson":"{\"transport\":\"native-call-test\"}"},{"name":"call.mcp","support":"native","evidenceJson":"{\"transport\":\"native-call-test\"}"}]})
        } else {
            crate::agsdl_host_example030::ExampleAdapter030::observe()
                .registry(
                    &document,
                    &authored,
                    source["sourceSha256"].as_str().unwrap(),
                    &scope,
                )
                .unwrap()
        };
        registry["format"] = "macro-agsdl-registry/030".into();
        registry["version"] = json!(format!(
            "sha256:{:x}",
            Sha256::digest(registry.to_string().as_bytes())
        ));
        let compiled = bun.request(json!({"kind":"compile","authoredSource":authored,"source":source,"registry":registry})).await;
        let plan_json = compiled["compiledPlanJson"]
            .as_str()
            .unwrap_or_else(|| panic!("compiler: {compiled}"))
            .to_owned();
        let plan: FlowPlan030 = serde_json::from_str(&plan_json).unwrap();
        let identity = FlowIdentity030 {
            system_start_id: "system".into(),
            flow_invocation_id: "flow".into(),
            snapshot_id: "snapshot".into(),
            epoch: "capture".into(),
        };
        let tools = config.lock_execution_tools("project").await.unwrap();
        let mut permissions =
            crate::agsdl_host_tools::permissions("Implement", false, &tools.tools).unwrap();
        permissions["agsdlHostPermissions"] = json!("workspace");
        let permissions = permissions.to_string();
        drop(tools);
        let capture = StartCapture030 { identity:identity.clone(), source:serde_json::from_value(source.clone()).unwrap(), versions:serde_json::from_value(serde_json::to_value(&plan.versions).unwrap()).unwrap(),
            authored_source:authored, compiled_plan_json:plan_json, registry_json:registry.to_string(), private_capture_json:json!({"format":"macro-native-flow-capture/030","callPermissionsJson":permissions,"callScopeJson":scope.to_string()}).to_string() };
        let pool = crate::db::create_pool(&root.join("run.db")).await.unwrap();
        let entry = fields.get("entry").map(|v| v.get()).unwrap_or("{}");
        let request = serde_json::from_value(json!({"source":source,"profile":"macro-agsdl-030-v1", "associations":{}, "requestId":"request", "entry":{"deliveryId":"delivery", "messageJson":entry}})).unwrap();
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
        let host = HostState(
            Mutex::new(Some(OwnedHost {
                incarnation: incarnation.clone(),
                resource: 0,
            })),
            Default::default(),
            Default::default(),
            Default::default(),
        );
        host.flow030()
            .install_runtime_fixture_control(&host, owner.clone(), identity.clone());
        let app = tauri::test::mock_builder()
            .manage(host)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        assert!(fixture["timeline"].is_array());
        Self {
            _temp: temp,
            app,
            pool,
            config,
            incarnation,
            owner,
            identity,
            plan,
        }
    }
    fn pump(
        &self,
        bun: Arc<tokio::sync::Mutex<BunHost>>,
        wake: watch::Sender<u64>,
    ) -> tokio::task::JoinHandle<()> {
        let host = self.incarnation.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    job = host.work_protocol.next() => {
                        let job = job.unwrap();
                        let output = bun.lock().await.request(json!({"kind":"work","job":job})).await;
                        host.work_protocol.complete(&job.generation, crate::agsdl_host_work::HostWorkCompletion030 {
                            ticket:job.ticket, generation:job.generation.clone(), input_digest:job.input_digest, output:serde_json::from_value(output).unwrap()
                        }).unwrap();
                    }
                    job = host.route030.next() => {
                        let job = job.unwrap();
                        let output = bun.lock().await.request(json!({"kind":"route","job":job})).await;
                        host.route030.complete(&job.generation, crate::agsdl_host_route030::HostRouteCompletion030 {
                            ticket:job.ticket, generation:job.generation.clone(), input_digest:job.input_digest, output:serde_json::from_value(output).unwrap()
                        }).unwrap();
                    }
                }
                wake.send_modify(|n| *n += 1);
            }
        })
    }
}

struct ScriptedAgent {
    key: WorkKey030,
    activation: String,
    send: tokio::sync::oneshot::Sender<ExampleResult030>,
}
struct ScriptedCall {
    key: WorkKey030,
    activation: String,
    send: tokio::sync::oneshot::Sender<crate::agsdl_host_calls030::CallEvent030>,
}
struct CallTransport {
    running: Arc<Mutex<Vec<ScriptedCall>>>,
    wake: watch::Sender<u64>,
}
impl crate::agsdl_host_call_executor030::CallTransport030 for CallTransport {
    fn start(
        &self,
        _grant: crate::agsdl_host_calls::CommandGrant,
        _prepared: crate::agsdl_host_calls030::PreparedCall030,
        _capture: StartCapture030,
        attempt: crate::agsdl_host_calls030::CallAttempt030,
        control: crate::agsdl_host_calls::Control,
    ) -> crate::agsdl_host_calls::Result<
        BoxFuture<'static, Result<crate::db::agsdl_execution::call_protocol030::CallEnd030>>,
    > {
        let (send, receive) = tokio::sync::oneshot::channel();
        let work = attempt.work();
        let FlowEffectKind030::Start {
            item_json,
            occurrence,
            ..
        } = &attempt.effect().kind
        else {
            unreachable!()
        };
        let key = WorkKey030 {
            step: attempt.address().to_vec(),
            item: item_json
                .as_ref()
                .map(|_| occurrence.as_ref().unwrap().item_index.clone()),
        };
        self.running.lock().unwrap().push(ScriptedCall {
            key,
            activation: work.activation_id.clone(),
            send,
        });
        self.wake.send_modify(|n| *n += 1);
        Ok(Box::pin(async move {
            use crate::db::agsdl_execution::call_protocol030::CallEnd030;
            tokio::select! {
                _ = control.stop.cancelled() => Ok(CallEnd030::Stopped),
                receipt = receive => Ok(CallEnd030::Returned { event: receipt.map_err(|_| failure("INTERRUPTED", "call", "Scripted receipt lost"))? }),
            }
        }))
    }
}
struct Executor {
    running: Arc<Mutex<Vec<ScriptedAgent>>>,
    wake: watch::Sender<u64>,
}
impl AgentExecutor030 for Executor {
    fn prepare(&self, work: PreparedEffectiveAgentWork030) -> Result<AttestedWorkPolicy030> {
        AttestedWorkPolicy030::from_example(
            work,
            &crate::agsdl_host_example030::ExampleAdapter030::observe(),
        )
    }
    fn run(
        &self,
        work: AgentWork030,
        events: WorkEventSink030,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<()>> {
        let FlowEffectKind030::Start {
            step: Some(step),
            item_json,
            occurrence,
            ..
        } = &work.effect.kind
        else {
            unreachable!()
        };
        let key = WorkKey030 {
            step: step.clone(),
            item: item_json
                .as_ref()
                .map(|_| occurrence.as_ref().unwrap().item_index.clone()),
        };
        let (send, result) = tokio::sync::oneshot::channel();
        self.running.lock().unwrap().push(ScriptedAgent {
            key,
            activation: work.attempt.work().activation_id.clone(),
            send,
        });
        let wake = self.wake.clone();
        Box::pin(async move {
            let outcome = tokio::select! {
                _ = cancel.cancelled() => return Ok(()),
                result = result => result.map_err(|_| crate::db::agsdl_execution::failure("INTERRUPTED","test","Scripted outcome lost"))?,
            };
            match outcome {
                ExampleResult030::Failed(code) => {
                    events
                        .emit(json!({"kind":"stop","reason":code}), &cancel)
                        .await?;
                }
                ExampleResult030::Returned { text, submit_json } => {
                    if let Some(text) = text {
                        events.emit(json!({"kind":"visibleText","messageId":"scripted","textParts":[text]}), &cancel).await?;
                    }
                    let receipt = events.emit(json!({"kind":"submit","callId":"scripted","argumentsJson":submit_json}), &cancel).await?;
                    let decision: Value = serde_json::from_str(&receipt.receipt_json)?;
                    if decision["decision"]["kind"] != "accepted" {
                        return Err(crate::db::agsdl_execution::failure(
                            "CORRELATION",
                            "test",
                            &format!("Submission refused: {decision}"),
                        ));
                    }
                }
            }
            wake.send_modify(|n| *n += 1);
            Ok(())
        })
    }
}

async fn idle(
    f: &Fixture,
    running: &Mutex<Vec<ScriptedAgent>>,
    calls: &Mutex<Vec<ScriptedCall>>,
    ended: Option<&str>,
) -> crate::db::agsdl_execution::flow_store030::FlowView030 {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            let host = f.app.state::<HostState>();
            let view = flow::inspect_run(host.flow030(), &host, &f.pool, &f.owner)
                .await
                .unwrap()
                .flow;
            let agents = running.lock().unwrap();
            let ready = !view
                .effects
                .iter()
                .any(|r| r["status"] == "pending" || r["status"] == "uncertain")
                && view
                    .state
                    .preparations
                    .iter()
                    .all(|p| p.status != "pending")
                && view
                    .state
                    .activations
                    .iter()
                    .filter(|a| a.physical)
                    .all(|a| {
                        agents.iter().any(|w| w.activation == a.id)
                            || calls.lock().unwrap().iter().any(|w| w.activation == a.id)
                    })
                && ended.is_none_or(|id| {
                    view.state
                        .activations
                        .iter()
                        .any(|a| a.id == id && !a.physical)
                });
            drop(agents);
            if ready {
                return view;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("Supervisor did not reach the next timeline boundary")
}

async fn native_timeline(
    f: &Fixture,
    scenario: scenarios::PinnedScenario030,
    wake: watch::Sender<u64>,
    receiver: watch::Receiver<u64>,
) -> Result<crate::db::agsdl_execution::flow_store030::FlowView030> {
    let running = Arc::new(Mutex::new(Vec::<ScriptedAgent>::new()));
    let calls = Arc::new(Mutex::new(Vec::<ScriptedCall>::new()));
    let tasks = crate::ai::stream_tasks::StreamTasks::default();
    let executors: Executors030<tauri::test::MockRuntime> = Executors030 {
        agents: Arc::new(Executor {
            running: running.clone(),
            wake: wake.clone(),
        }),
        calls: Some(Arc::new(
            crate::agsdl_host_call_executor030::CallExecutor030 {
                config: f.config.clone(),
                pool: f.pool.clone(),
                tasks: tasks.clone(),
                owner: f.owner.clone(),
                transport: Arc::new(CallTransport {
                    running: calls.clone(),
                    wake: wake.clone(),
                }),
            },
        )),
        humans: None,
        clock: None,
    };
    let emitter = {
        let (app, pool, config, tasks) = (
            f.app.handle().clone(),
            f.pool.clone(),
            f.config.clone(),
            tasks.clone(),
        );
        Arc::new(move |project| {
            native_event_emitter030(
                app.clone(),
                pool.clone(),
                config.clone(),
                tasks.clone(),
                project,
            )
        })
    };
    let host = f.app.state::<HostState>();
    let cancel = CancellationToken::new();
    let supervisor = supervise_with_emitter030(
        Some(f.app.handle()),
        &host,
        &f.pool,
        &f.config,
        &tasks,
        &f.owner,
        &executors,
        receiver,
        &cancel,
        emitter,
    );
    let timeline = async {
        let mut ended = None;
        for event in scenario.timeline {
            let view = idle(f, &running, &calls, ended.as_deref()).await;
            match event {
                TimelineEvent030::Work { key, outcome } => {
                    let mut agents = running.lock().unwrap();
                    let candidates = agents
                        .iter()
                        .enumerate()
                        .filter(|(_, a)| {
                            a.key == key
                                && view
                                    .state
                                    .activations
                                    .iter()
                                    .any(|v| v.id == a.activation && v.physical)
                        })
                        .map(|(i, _)| i)
                        .collect::<Vec<_>>();
                    assert_eq!(candidates.len(), 1, "Timeline work is not unique: {key:?}");
                    let agent = agents.remove(candidates[0]);
                    ended = Some(agent.activation);
                    agent.send.send(outcome).unwrap();
                }
                TimelineEvent030::Command { key, receipt } => {
                    let mut calls = calls.lock().unwrap();
                    let candidates = calls
                        .iter()
                        .enumerate()
                        .filter(|(_, c)| {
                            c.key == key
                                && view
                                    .state
                                    .activations
                                    .iter()
                                    .any(|a| a.id == c.activation && a.physical)
                        })
                        .map(|(i, _)| i)
                        .collect::<Vec<_>>();
                    assert_eq!(candidates.len(), 1, "Timeline call is not unique: {key:?}");
                    let call = calls.remove(candidates[0]);
                    ended = Some(call.activation);
                    call.send.send(receipt).unwrap();
                }
                TimelineEvent030::Running(mut expected) => {
                    let mut actual = view
                        .state
                        .activations
                        .iter()
                        .filter(|a| a.physical)
                        .map(|a| WorkKey030 {
                            step: a.step.clone().unwrap(),
                            item: a
                                .item_json
                                .as_ref()
                                .map(|_| a.occurrence.as_ref().unwrap().item_index.clone()),
                        })
                        .collect::<Vec<_>>();
                    actual.sort_by(|a, b| (&a.step, &a.item).cmp(&(&b.step, &b.item)));
                    expected.sort_by(|a, b| (&a.step, &a.item).cmp(&(&b.step, &b.item)));
                    assert_eq!(actual, expected);
                }
                event => panic!("Unsupported native timeline event: {event:?}"),
            }
            wake.send_modify(|n| *n += 1);
        }
        let view = idle(f, &running, &calls, ended.as_deref()).await;
        assert!(view.state.verdict.is_some());
        assert!(view.state.activations.iter().all(|a| !a.physical));
        view
    };
    let guarded_timeline = async {
        let result = std::panic::AssertUnwindSafe(tokio::time::timeout(
            std::time::Duration::from_secs(30),
            timeline,
        ))
        .catch_unwind()
        .await;
        match result {
            Ok(Ok(view)) => Ok(view),
            other => {
                // A broken timeline must still let the same supervisor cancel
                // and physically join every scripted executor before returning.
                cancel.cancel();
                let message = match other {
                    Ok(Err(_)) => "Native timeline exceeded 30 seconds".into(),
                    Err(panic) => panic_message(panic),
                    Ok(Ok(_)) => unreachable!(),
                };
                Err(crate::db::agsdl_execution::failure(
                    "CONFORMANCE",
                    "timeline",
                    &message,
                ))
            }
        }
    };
    let (outcome, view) = tokio::join!(supervisor, guarded_timeline);
    let view = view?;
    outcome?;
    Ok(view)
}

fn panic_message(panic: Box<dyn std::any::Any + Send>) -> String {
    panic
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_else(|| "Scenario panicked".into())
}

#[tokio::test]
async fn agsdl030_conformance_error_route() {
    let mut bun = BunHost::start();
    let raw = scenarios::SCENARIOS
        .iter()
        .find(|(n, _)| *n == "error-route")
        .unwrap()
        .1;
    let f = Fixture::new(raw, &mut bun).await;
    let bun = Arc::new(tokio::sync::Mutex::new(bun));
    let (wake, receiver) = watch::channel(0);
    let pump = f.pump(bun.clone(), wake.clone());
    let fixture: Value = serde_json::from_str(raw).unwrap();
    let scenario = scenarios::PinnedScenario030::from_capture(
        &f.plan.document_json,
        &fixture["entry"].to_string(),
    )
    .unwrap();
    let view = native_timeline(&f, scenario, wake, receiver).await.unwrap();
    let observed = projection::project(&f, &view).await;
    assert!(
        projection::compare(&fixture["expect"], &observed).is_empty(),
        "{observed}"
    );
    pump.abort();
    let _ = pump.await;
    Arc::try_unwrap(bun)
        .ok()
        .unwrap()
        .into_inner()
        .close()
        .await;
    f.pool.close().await;
}

// Select by capability, never by scenario name or expected output. The fallback
// uses the existing scripted driver and the production drain_effects030 pass.
fn scripted_reason(f: &Fixture, scenario: &scenarios::PinnedScenario030) -> Option<&'static str> {
    if f.plan.steps.iter().any(|s| s.r#type == "approval") {
        Some("human executor not connected")
    } else if scenario.timeline.iter().any(|e| {
        matches!(
            e,
            TimelineEvent030::Elapse(_)
                | TimelineEvent030::Request { .. }
                | TimelineEvent030::Answer { .. }
        )
    }) {
        Some("human/clock executor not connected")
    } else if f
        .plan
        .steps
        .iter()
        .any(|s| s.delivery.as_deref() == Some("steer"))
    {
        Some("steer executor not connected")
    } else {
        None
    }
}

fn product_gap(f: &Fixture) -> Option<String> {
    // The official scenarios deliberately use the fictional example harness.
    // Substitute only its name for this reporting check, never for execution.
    // All other restrictions are evaluated by the actual production preflight.
    let mut authored: Value = serde_json::from_str(&f.plan.document_json).unwrap();
    for agent in authored["agents"].as_object_mut().unwrap().values_mut() {
        assert_eq!(agent["harness"], "example");
        agent["harness"] = "codex".into();
    }
    crate::agsdl_host_capture::product_slice030(
        &authored.to_string(),
        Some(&serde_json::to_string(&f.plan).unwrap()),
    )
    .map(|d| format!("{} {}: {}", d.code, d.pointer, d.message))
}

#[tokio::test]
async fn agsdl030_conformance_all_37_scenarios() {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../dev/agsdl/fixtures/v0.3/conformance/runs");
    let discovered = std::fs::read_dir(directory)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .map(|p| p.file_stem().unwrap().to_str().unwrap().to_owned())
        .collect::<std::collections::BTreeSet<_>>();
    let pinned = scenarios::SCENARIOS
        .iter()
        .map(|(n, _)| n.to_string())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(pinned.len(), 37, "Official scenario inventory changed");
    assert_eq!(
        pinned, discovered,
        "Every scenario must be explicitly covered"
    );
    let bun = Arc::new(tokio::sync::Mutex::new(BunHost::start()));
    let (mut native, mut scripted, mut failures) = (0, 0, Vec::new());
    for (name, raw) in scenarios::SCENARIOS {
        let prepared =
            std::panic::AssertUnwindSafe(async { Fixture::new(raw, &mut *bun.lock().await).await })
                .catch_unwind()
                .await;
        let f = match prepared {
            Ok(f) => f,
            Err(panic) => {
                let error = format!("{name}: preparation failed: {}", panic_message(panic));
                eprintln!("CONFORMANCE {error}");
                failures.push(error);
                continue;
            }
        };
        let fields: BTreeMap<String, Box<serde_json::value::RawValue>> =
            serde_json::from_str(raw).unwrap();
        let scenario = scenarios::PinnedScenario030::from_capture(
            fields["document"].get(),
            fields.get("entry").map(|v| v.get()).unwrap_or("{}"),
        )
        .unwrap();
        assert_eq!(scenario.name, *name);
        let reason = scripted_reason(&f, &scenario);
        let gap = product_gap(&f);
        let (wake, receiver) = watch::channel(0);
        let pump = f.pump(bun.clone(), wake.clone());
        let run = async {
            let view = if reason.is_some() {
                crate::agsdl_host_example030::drive_scenario030(
                    f.app.handle(),
                    &f.pool,
                    &f.config,
                    &crate::ai::stream_tasks::StreamTasks::default(),
                    &f.owner,
                    scenario,
                    &CancellationToken::new(),
                )
                .await?
            } else {
                native_timeline(&f, scenario, wake, receiver).await?
            };
            let observed = projection::project(&f, &view).await;
            let expected: Value = serde_json::from_str(fields["expect"].get()).unwrap();
            let errors = projection::compare(&expected, &observed);
            if !errors.is_empty() {
                return Err(crate::db::agsdl_execution::failure(
                    "CONFORMANCE",
                    "test",
                    &errors.join("\n"),
                ));
            }
            Ok(())
        };
        let result = std::panic::AssertUnwindSafe(tokio::time::timeout(
            std::time::Duration::from_secs(40),
            run,
        ))
        .catch_unwind()
        .await;
        let error = match result {
            Ok(Ok(Ok(()))) => None,
            Ok(Ok(Err(e))) => Some(format!("{}: {}", e.code, e.message)),
            Ok(Err(_)) => Some("scenario exceeded 40 seconds".into()),
            Err(panic) => Some(panic_message(panic)),
        };
        pump.abort();
        if let Err(error) = pump.await {
            assert!(error.is_cancelled(), "Mailbox pump panicked: {error}");
        }
        match error {
            None if reason.is_none() && gap.is_none() => {
                native += 1;
                eprintln!("CONFORMANCE {name}: PASS native supervisor");
            }
            None => {
                scripted += 1;
                eprintln!(
                    "CONFORMANCE {name}: PASS scripted coverage; path={}; reason={}",
                    if reason.is_some() {
                        "scripted driver + production dispatch"
                    } else {
                        "production supervisor, outside product slice"
                    },
                    reason.map(str::to_owned).or(gap).unwrap()
                );
            }
            Some(error) => {
                eprintln!("CONFORMANCE {name}: FAIL {error}");
                failures.push(format!("{name}: {error}"));
            }
        }
        f.pool.close().await;
    }
    Arc::try_unwrap(bun)
        .ok()
        .unwrap()
        .into_inner()
        .close()
        .await;
    eprintln!(
        "CONFORMANCE TOTAL: N={native} M={scripted} K={}",
        failures.len()
    );
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn invalid_timeline_cancels_and_joins_the_native_workers() {
    let mut bun = BunHost::start();
    let raw = scenarios::SCENARIOS
        .iter()
        .find(|(n, _)| *n == "error-route")
        .unwrap()
        .1;
    let f = Fixture::new(raw, &mut bun).await;
    let mut scenario =
        scenarios::PinnedScenario030::from_capture(&f.plan.document_json, r#"{"prompt":"Start."}"#)
            .unwrap();
    // The initial work is already running. This deliberately incorrect check
    // must fail without leaving the executor waiting for its scripted result.
    scenario.timeline = vec![TimelineEvent030::Running(vec![])];
    let bun = Arc::new(tokio::sync::Mutex::new(bun));
    let (wake, receiver) = watch::channel(0);
    let pump = f.pump(bun.clone(), wake.clone());
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        native_timeline(&f, scenario, wake, receiver),
    )
    .await
    .expect("Failed timeline left a live native executor");
    assert_eq!(result.unwrap_err().code, "CONFORMANCE");
    pump.abort();
    let _ = pump.await;
    Arc::try_unwrap(bun)
        .ok()
        .unwrap()
        .into_inner()
        .close()
        .await;
    f.pool.close().await;
}

#[path = "agsdl_host_call_executor030_tests.rs"]
mod call_executor_tests;
