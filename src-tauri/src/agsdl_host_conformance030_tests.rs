//! Official run scenarios against native persistence, dispatch and Rust adapters.
//! TS oracle replay is a separate test; it never supplies a protocol result.
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
use sqlx::Row;
use tauri::Manager;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::watch,
};
use tokio_util::sync::CancellationToken;

#[path = "agsdl_host_conformance030_projection.rs"]
mod projection;
#[path = "agsdl_host_conformance030_route_data.rs"]
mod route_data_capture;
#[path = "agsdl_host_conformance030_work.rs"]
mod work_capture;

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
    async fn request(&mut self, request: Value) -> Value {
        self.request_raw(request).await.0
    }
    async fn request_raw(&mut self, request: Value) -> (Value, String) {
        self.request_text(&request.to_string()).await
    }
    async fn request_text(&mut self, request: &str) -> (Value, String) {
        self.sequence += 1;
        let bytes = format!("{{\"id\":{},{}\n", self.sequence, &request[1..]).into_bytes();
        self.input.write_all(&bytes).await.unwrap();
        let line =
            tokio::time::timeout(std::time::Duration::from_secs(15), self.output.next_line())
                .await
                .expect("Bun evaluator timed out")
                .unwrap()
                .expect("Bun evaluator exited");
        let reply: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(reply["id"], self.sequence);
        assert!(reply.get("error").is_none(), "Bun evaluator: {reply}");
        #[derive(serde::Deserialize)]
        struct RawReply {
            output: Box<serde_json::value::RawValue>,
        }
        let raw: RawReply = serde_json::from_str(&line).expect("raw evaluator output");
        (reply["output"].clone(), raw.output.get().to_owned())
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
    work_captures: Arc<Mutex<Vec<work_capture::Capture>>>,
    compile_captures: Arc<Mutex<Vec<(String, String)>>>,
    route_captures: Arc<Mutex<Vec<route_data_capture::Capture>>>,
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
    async fn new(raw: &str) -> Self {
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
            json!({"format":"macro-agsdl-registry/030", "version":"fixture", "modules":[], "harnesses":[], "agents":[], "hostCapabilities":[{"name":"call.command","support":"native","evidenceJson":"{\"transport\":\"native-call-test\"}"},{"name":"call.mcp","support":"native","evidenceJson":"{\"transport\":\"native-call-test\"}"},{"name":"approval","support":"native","evidenceJson":"{\"transport\":\"native-human-test\"}"}]})
        } else if document["agents"]
            .as_object()
            .unwrap()
            .values()
            .all(|a| a["harness"] == "codex")
        {
            let observed = crate::agsdl_host_codex::CodexObservation030 {
                profile: crate::agsdl_host_codex::profile::Profile {
                    executable: workspace.join("bin/codex"),
                    directory: workspace.join("profile"),
                    home: workspace.join("profile/home"),
                    bootstrap: workspace.join("bootstrap"),
                    digest: "synthetic-profile".into(),
                },
                version: "0.167.0".into(),
                models: vec![
                    json!({"name":"fixture","efforts":["medium"],"defaultEffort":"medium","isDefault":true}),
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
            json!({"format":"macro-agsdl-registry/030","version":"fixture","modules":[{"harness":"codex","moduleJson":crate::agsdl_host_codex030::approvals::module030()}],"harnesses":[harness],"agents":agents,"hostCapabilities":[]})
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
        let compile_captures = Arc::new(Mutex::new(Vec::new()));
        let captures = compile_captures.clone();
        *incarnation.compiler.native.probe.lock().unwrap() = Some(Arc::new(move |job, output| {
            captures
                .lock()
                .unwrap()
                .push((job.to_owned(), output.clone()))
        }));
        let receipt = host
            .compile(
                serde_json::from_value(source.clone()).unwrap(),
                authored.clone(),
                registry.to_string(),
            )
            .await
            .unwrap();
        let compiled: Value = serde_json::from_str(&receipt.result_json).unwrap();
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
        let request = serde_json::from_value(json!({"source":source,"profile":"macro-agsdl-030-v1", "associations":{}, "requestId":"request", "entry": if plan.entry.is_some() { json!({"deliveryId":"delivery", "messageJson":entry}) } else { Value::Null }})).unwrap();
        crate::db::agsdl_execution::start030::start_linked(
            &pool,
            &request,
            &FixtureStart030 { capture },
            None,
        )
        .await
        .unwrap();
        host.flow030()
            .install_runtime_fixture_control(&host, owner.clone(), identity.clone());
        let app = tauri::test::mock_builder()
            .manage(host)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let work_captures = Arc::new(Mutex::new(Vec::new()));
        let captures = work_captures.clone();
        *incarnation.work_protocol.native.probe.lock().unwrap() =
            Some(Arc::new(move |job, output| {
                captures.lock().unwrap().push(work_capture::Capture {
                    raw_job: job.to_owned(),
                    output: serde_json::from_str(output).unwrap(),
                    difference: None,
                })
            }));
        let route_captures = Arc::new(Mutex::new(Vec::new()));
        let captures = route_captures.clone();
        *incarnation.route030.native.probe.lock().unwrap() = Some(Arc::new(move |job, output| {
            captures.lock().unwrap().push(route_data_capture::Capture {
                raw_job: job.to_owned(),
                raw_output: output.clone(),
                operation: route_data_capture::operation(job),
                difference: None,
            })
        }));
        assert!(fixture["timeline"].is_array());
        Self {
            work_captures,
            compile_captures,
            route_captures,
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
}

struct ScriptedAgent {
    attempt: crate::agsdl_host_flow030::FlowWorkAttempt030,
    protocol: tokio::sync::mpsc::Sender<(
        Value,
        tokio::sync::oneshot::Sender<
            Result<crate::db::agsdl_execution::work_dto030::ProtocolDecision030>,
        >,
    )>,
    plan_lock: Option<Arc<crate::agsdl_host_work_admission030::NativePlanLock030>>,
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
                _ = control.machine_timeout.cancelled() => Ok(CallEnd030::TimedOut),
                receipt = receive => Ok(CallEnd030::Returned { event: receipt.map_err(|_| failure("INTERRUPTED", "call", "Scripted receipt lost"))? }),
            }
        }))
    }
}
struct Executor {
    plans: Mutex<BTreeMap<String, Arc<crate::agsdl_host_work_admission030::NativePlanLock030>>>,
    running: Arc<Mutex<Vec<ScriptedAgent>>>,
    wake: watch::Sender<u64>,
}
impl AgentExecutor030 for Executor {
    fn prepare(&self, work: PreparedEffectiveAgentWork030) -> Result<AttestedWorkPolicy030> {
        let key = work.work().work().activation_id.clone();
        let policy = AttestedWorkPolicy030::from_example(
            work,
            &crate::agsdl_host_example030::ExampleAdapter030::observe(),
        )?;
        if let Some(lock) = policy.plan_lock() {
            self.plans.lock().unwrap().insert(key, lock);
        }
        Ok(policy)
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
        let (send, mut result) = tokio::sync::oneshot::channel();
        let (protocol, mut protocol_events) = tokio::sync::mpsc::channel::<(
            Value,
            tokio::sync::oneshot::Sender<
                Result<crate::db::agsdl_execution::work_dto030::ProtocolDecision030>,
            >,
        )>(1);
        let plan_lock = self
            .plans
            .lock()
            .unwrap()
            .remove(&work.attempt.work().activation_id);
        self.running.lock().unwrap().push(ScriptedAgent {
            attempt: work.attempt.clone(),
            protocol,
            plan_lock,
            key,
            activation: work.attempt.work().activation_id.clone(),
            send,
        });
        let wake = self.wake.clone();
        Box::pin(async move {
            let mut inbox = work.steer;
            let outcome = loop {
                tokio::select! {
                    _ = cancel.cancelled() => return Ok(()),
                    Some(delivery) = inbox.receive() => { delivery.acknowledge(&work.tasks, &work.attempt)?; wake.send_modify(|n| *n += 1); },
                    result = &mut result => break result.map_err(|_| crate::db::agsdl_execution::failure("INTERRUPTED","test","Scripted outcome lost"))?,
                    Some((body,reply)) = protocol_events.recv() => {
                        let result=events.emit(body,&cancel).await;
                        let stopping=result.as_ref().ok().and_then(|r|serde_json::from_str::<Value>(&r.receipt_json).ok()).is_some_and(|r|r["decision"]["kind"]=="stopping");
                        let _=reply.send(result);
                        if stopping {return Ok(());}
                    }
                }
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
            let clock_works: Vec<String> =
                sqlx::query_scalar("SELECT activation_id FROM engine_flow030_clock_works")
                    .fetch_all(&f.pool)
                    .await
                    .unwrap();
            let pending_clock: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM engine_flow030_clock_events WHERE output_json IS NULL",
            )
            .fetch_one(&f.pool)
            .await
            .unwrap();
            let pending_controls: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM engine_flow030_clock_controls WHERE joined=0",
            )
            .fetch_one(&f.pool)
            .await
            .unwrap();
            let agents = running.lock().unwrap();
            let ready = pending_clock == 0
                && pending_controls == 0
                && view
                    .state
                    .activations
                    .iter()
                    .filter(|a| a.physical)
                    .all(|a| clock_works.contains(&a.id))
                && !view
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
                            || a.agent.is_none()
                                && a.step.as_ref().is_some_and(|step| {
                                    f.plan
                                        .steps
                                        .iter()
                                        .any(|s| &s.address == step && s.r#type == "approval")
                                })
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
    let host = f.app.state::<HostState>();
    let clock = host.flow030().humans.virtual_clock().await?;
    let human = host
        .flow030()
        .humans
        .broker(&host, &f.pool, &f.identity)
        .await?;
    let executors: Executors030<tauri::test::MockRuntime> = Executors030 {
        agents: Arc::new(Executor {
            plans: Default::default(),
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
        humans: Some(Arc::new(
            crate::agsdl_host_human_executor030::HumanExecutor030 {
                pool: f.pool.clone(),
                tasks: tasks.clone(),
            },
        )),
        clock: Some(Arc::new(
            crate::agsdl_host_human_executor030::HumanClockRuntime030 {
                app: f.app.handle().clone(),
                pool: f.pool.clone(),
                tasks: tasks.clone(),
                identity: f.identity.clone(),
            },
        )),
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
                    let approval = view.state.activations.iter().find(|a| {
                        a.physical && a.step.as_ref() == Some(&key.step) && a.agent.is_none()
                    });
                    if let Some(approval) = approval {
                        let ExampleResult030::Returned { submit_json, .. } = outcome else {
                            panic!("Approval answer missing");
                        };
                        let answer: Value = serde_json::from_str(&submit_json)?;
                        let work = human.owned_work(&approval.id).await?;
                        let request_id = human.oldest_open(&work).await?.unwrap();
                        let _operation = human.operation.lock().await;
                        human
                            .submit(
                                &host,
                                crate::agsdl_host_human030::HumanSubmission030 {
                                    scope: crate::db::agsdl_execution::public030::HumanScope030 {
                                        system_start_id: f.identity.system_start_id.clone(),
                                        source: serde_json::from_value(f.plan.source.clone())?,
                                    },
                                    request_id,
                                    expected_revision: "0".into(),
                                    answer: crate::agsdl_host_human030::HumanAnswer030::Approval {
                                        choice: answer["choice"].as_str().unwrap().into(),
                                        comment: answer["comment"].as_str().unwrap_or("").into(),
                                    },
                                },
                                crate::agsdl_host_human030::HumanOrigin030::SyntheticPerson,
                            )
                            .await?;
                        human.pump(&host, &CancellationToken::new()).await?;
                        ended = Some(approval.id.clone());
                        wake.send_modify(|n| *n += 1);
                        continue;
                    }
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
                TimelineEvent030::Request { key, kind } => {
                    let activation = view
                        .state
                        .activations
                        .iter()
                        .find(|a| a.physical && a.step.as_ref() == Some(&key.step))
                        .unwrap();
                    let work = human.owned_work(&activation.id).await?;
                    let payload = if kind == "plan" {
                        let (attempt, lock, protocol) = {
                            let agents = running.lock().unwrap();
                            let agent = agents
                                .iter()
                                .find(|a| a.activation == activation.id)
                                .unwrap();
                            (
                                agent.attempt.clone(),
                                agent.plan_lock.clone().unwrap(),
                                agent.protocol.clone(),
                            )
                        };
                        let plan_id = format!("plan:{}", activation.id);
                        lock.presented(&attempt, &plan_id).await?;
                        let (reply, done) = tokio::sync::oneshot::channel();
                        protocol.send((json!({"kind":"planPresented","planId":plan_id,"text":"Pinned QA plan"}),reply)).await.unwrap();
                        done.await.unwrap()?;
                        json!({"planId":plan_id,"text":"Pinned QA plan"})
                    } else {
                        json!({"question":"Pinned QA request"})
                    };
                    let _operation = human.operation.lock().await;
                    human.open(&host, &work, &kind, payload).await?;
                    human.pump(&host, &CancellationToken::new()).await?;
                }
                TimelineEvent030::Answer { key, answer } => {
                    let activation = view
                        .state
                        .activations
                        .iter()
                        .find(|a| a.physical && a.step.as_ref() == Some(&key.step))
                        .unwrap();
                    let work = human.owned_work(&activation.id).await?;
                    let request = human.oldest_open(&work).await?.unwrap();
                    let _operation = human.operation.lock().await;
                    human
                        .submit(
                            &host,
                            crate::agsdl_host_human030::HumanSubmission030 {
                                scope: crate::db::agsdl_execution::public030::HumanScope030 {
                                    system_start_id: f.identity.system_start_id.clone(),
                                    source: serde_json::from_value(f.plan.source.clone())?,
                                },
                                request_id: request,
                                expected_revision: "0".into(),
                                answer: crate::agsdl_host_human030::HumanAnswer030::Decision {
                                    decision: answer,
                                    comment: String::new(),
                                },
                            },
                            crate::agsdl_host_human030::HumanOrigin030::SyntheticPerson,
                        )
                        .await?;
                    human.pump(&host, &CancellationToken::new()).await?;
                }
                TimelineEvent030::Elapse(ms) => {
                    use crate::agsdl_host_clock030::Clock030;
                    let end = clock.now_ms() + ms;
                    loop {
                        let fresh = idle(f, &running, &calls, ended.as_deref()).await;
                        let _operation = human.operation.lock().await;
                        if fresh.state.verdict.is_some() {
                            clock.advance_to(end)?;
                            break;
                        }
                        for request in human.pending_resolutions().await? {
                            if human.request_kind(&request).await? != "approval" {
                                let decision = human.take_resolution(&host, &request).await?;
                                if decision.kind() == "plan" {
                                    let work = decision.resolution()["workActions"][0]["workId"]
                                        .as_str()
                                        .unwrap();
                                    let (attempt, lock, protocol) = {
                                        let agents = running.lock().unwrap();
                                        let agent =
                                            agents.iter().find(|a| a.activation == work).unwrap();
                                        (
                                            agent.attempt.clone(),
                                            agent.plan_lock.clone().unwrap(),
                                            agent.protocol.clone(),
                                        )
                                    };
                                    lock.resolve(&attempt, &decision).await?;
                                    let (reply, done) = tokio::sync::oneshot::channel();
                                    protocol
                                        .send((decision.plan_event()?, reply))
                                        .await
                                        .unwrap();
                                    let receipt = done.await.unwrap()?;
                                    if serde_json::from_str::<Value>(&receipt.receipt_json)?
                                        ["decision"]["kind"]
                                        == "stopping"
                                    {
                                        ended = Some(work.to_owned());
                                    }
                                }
                                human.acknowledge(&host, &decision).await?;
                                human.pump(&host, &CancellationToken::new()).await?;
                            }
                        }
                        let now = clock.now_ms();
                        if now == end {
                            break;
                        }
                        let slice = human.next_wake_ms().await?.unwrap_or(end - now);
                        if slice == 0 {
                            drop(_operation);
                            wake.send_modify(|n| *n += 1);
                            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                            continue;
                        }
                        clock.advance_to(end.min(now + slice))?;
                        drop(_operation);
                        wake.send_modify(|n| *n += 1);
                        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    }
                }
            }
            wake.send_modify(|n| *n += 1);
        }
        let view = idle(f, &running, &calls, ended.as_deref()).await;
        assert!(view.state.verdict.is_some());
        assert!(view.state.activations.iter().all(|a| !a.physical));
        Ok::<_, crate::db::agsdl_execution::dto::EngineFailure>(view)
    };
    let guarded_timeline = async {
        let result = std::panic::AssertUnwindSafe(tokio::time::timeout(
            std::time::Duration::from_secs(30),
            timeline,
        ))
        .catch_unwind()
        .await;
        match result {
            Ok(Ok(Ok(view))) => Ok(view),
            other => {
                // A broken timeline must still let the same supervisor cancel
                // and physically join every scripted executor before returning.
                cancel.cancel();
                let message = match other {
                    Ok(Err(_)) => "Native timeline exceeded 30 seconds".into(),
                    Ok(Ok(Err(error))) => format!("Native timeline failed: {error:?}"),
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
    let (outcome, view) = tokio::join!(
        async {
            let result = supervisor.await;
            if let Err(error) = &result {
                eprintln!("SUPERVISOR ERROR {error:?}");
            }
            result
        },
        guarded_timeline
    );
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
    let raw = scenarios::SCENARIOS
        .iter()
        .find(|(n, _)| *n == "error-route")
        .unwrap()
        .1;
    let f = Fixture::new(raw).await;
    let (wake, receiver) = watch::channel(0);
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
    f.pool.close().await;
}

#[tokio::test]
async fn agsdl030_conformance_human_timeout() {
    let raw = scenarios::SCENARIOS
        .iter()
        .find(|(n, _)| *n == "timeout-pauses-for-person")
        .unwrap()
        .1;
    let f = Fixture::new(raw).await;
    let (wake, receiver) = watch::channel(0);
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
    f.pool.close().await;
}

// Select by capability, never by scenario name or expected output. The fallback
// uses the existing scripted driver and the production drain_effects030 pass.
fn scripted_reason(_f: &Fixture, _scenario: &scenarios::PinnedScenario030) -> Option<&'static str> {
    None
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
    run_all_37(false).await;
}

#[cfg(unix)]
#[test]
fn agsdl030_conformance_runs_with_only_bun_removed_from_path() {
    let directory = tempfile::tempdir().unwrap();
    let mut paths = Vec::new();
    for (ordinal, source) in
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).enumerate()
    {
        let Ok(source) = source.canonicalize() else {
            continue;
        };
        let Ok(entries) = std::fs::read_dir(&source) else {
            continue;
        };
        let target = directory.path().join(ordinal.to_string());
        std::fs::create_dir(&target).unwrap();
        for entry in entries {
            let entry = entry.unwrap();
            if entry.file_name() != "bun" {
                std::os::unix::fs::symlink(entry.path(), target.join(entry.file_name())).unwrap();
            }
        }
        paths.push(target);
    }
    let path = std::env::join_paths(paths).unwrap();
    let absent = std::process::Command::new("bun")
        .arg("--version")
        .env("PATH", &path)
        .output()
        .unwrap_err();
    assert_eq!(absent.kind(), std::io::ErrorKind::NotFound);
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "agsdl_host::conformance030_tests::agsdl030_conformance_all_37_scenarios",
            "--exact",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("PATH", &path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stderr).contains("CONFORMANCE TOTAL: N=33 M=4 K=0"));
    eprintln!("NATIVE_WITHOUT_BUN: 37 complete base projections, N33/M4/K0; all other PATH entries retained");
}

#[tokio::test]
async fn native_adapter_inputs_differential() {
    run_all_37(true).await;
}

async fn run_all_37(compare_ts: bool) {
    let mut bun = compare_ts.then(BunHost::start);
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
    let (mut native, mut scripted, mut failures) = (0, 0, Vec::new());
    let mut capture_manifest = Vec::new();
    let mut route_capture_manifest = Vec::new();
    for (name, raw) in scenarios::SCENARIOS {
        let prepared = std::panic::AssertUnwindSafe(async { Fixture::new(raw).await })
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
            if let Some(directory) = std::env::var_os("ARGENTIC_PROJECTION_DIR") {
                std::fs::create_dir_all(&directory).unwrap();
                std::fs::write(
                    std::path::Path::new(&directory).join(format!("{name}.json")),
                    observed.to_string(),
                )
                .unwrap();
            }
            let reference: Value =
                serde_json::from_str(include_str!("../tests/fixtures/agsdl030_projections.json"))
                    .unwrap();
            assert_eq!(
                observed, reference["observations"][*name],
                "complete TS base projection {name}"
            );
            let errors = projection::compare(&expected, &observed);
            if !errors.is_empty() {
                return Err(crate::db::agsdl_execution::failure(
                    "CONFORMANCE",
                    "test",
                    &errors.join("\n"),
                ));
            }
            Ok(())
        }
        .boxed_local();
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
        if error.is_none() {
            if let Some(directory) = std::env::var_os("ARGENTIC_COMPILE_CAPTURE_DIR") {
                std::fs::create_dir_all(&directory).unwrap();
                let rows: String = f.compile_captures.lock().unwrap().iter().enumerate().map(|(ordinal, (job, output))| format!("{}\n", json!({"scenario": name, "ordinal": ordinal, "rawJob": job, "rawOutput": output}))).collect();
                std::fs::write(
                    std::path::Path::new(&directory).join(format!("{name}.jsonl")),
                    rows,
                )
                .unwrap();
            }
            if let Some(bun) = bun.as_mut() {
                let captures = f.compile_captures.lock().unwrap().clone();
                assert!(!captures.is_empty());
                for (raw_job, expected) in captures {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct CompileCapture {
                        authored_source: String,
                        source: Box<serde_json::value::RawValue>,
                        registry_json: String,
                    }
                    let job: CompileCapture = serde_json::from_str(&raw_job).unwrap();
                    let request = format!("{{\"kind\":\"compile\",\"authoredSource\":{},\"source\":{},\"registry\":{}}}", serde_json::to_string(&job.authored_source).unwrap(), job.source.get(), job.registry_json);
                    for _ in 0..2 {
                        assert_eq!(
                            bun.request_text(&request).await.1,
                            expected,
                            "production compilation {name}"
                        );
                    }
                }
            }

            capture_manifest.push(work_capture::replay(&f, bun.as_mut(), name).await);
            route_capture_manifest.push(route_data_capture::replay(&f, bun.as_mut(), name).await);
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
    if let Some(bun) = bun {
        bun.close().await;
    }
    eprintln!(
        "CONFORMANCE TOTAL: N={native} M={scripted} K={}",
        failures.len()
    );
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert_eq!(
        capture_manifest.len(),
        37,
        "Every scenario needs a capture manifest, including zero-work cases"
    );
    route_data_capture::finish(&route_capture_manifest, native, scripted, compare_ts);
    let manifest =
        json!({"scenarios": capture_manifest, "N": native, "M": scripted, "K": failures.len()});
    eprintln!("ARGENTIC_WORK_CAPTURE_MANIFEST {manifest}");
    if let Some(directory) = std::env::var_os("ARGENTIC_WORK_CAPTURE_DIR") {
        std::fs::write(
            std::path::Path::new(&directory).join("manifest.json"),
            manifest.to_string(),
        )
        .unwrap();
    }
}

#[tokio::test]
async fn invalid_timeline_cancels_and_joins_the_native_workers() {
    let raw = scenarios::SCENARIOS
        .iter()
        .find(|(n, _)| *n == "error-route")
        .unwrap()
        .1;
    let f = Fixture::new(raw).await;
    let mut scenario =
        scenarios::PinnedScenario030::from_capture(&f.plan.document_json, r#"{"prompt":"Start."}"#)
            .unwrap();
    // The initial work is already running. This deliberately incorrect check
    // must fail without leaving the executor waiting for its scripted result.
    scenario.timeline = vec![TimelineEvent030::Running(vec![])];
    let (wake, receiver) = watch::channel(0);
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        native_timeline(&f, scenario, wake, receiver),
    )
    .await
    .expect("Failed timeline left a live native executor");
    assert_eq!(result.unwrap_err().code, "CONFORMANCE");
    f.pool.close().await;
}

#[path = "agsdl_host_call_executor030_tests.rs"]
mod call_executor_tests;

#[tokio::test]
async fn approval_keeps_admission_through_revision_application() {
    let raw = scenarios::SCENARIOS
        .iter()
        .find(|(name, _)| *name == "approval")
        .unwrap()
        .1;
    let f = Fixture::new(raw).await;
    let (wake, receiver) = watch::channel(0);
    let host = f.app.state::<HostState>();
    let (probe, observed) = tokio::sync::oneshot::channel();
    *host.flow030().humans.approval_commit_probe.lock().unwrap() = Some(probe);
    let fixture: Value = serde_json::from_str(raw).unwrap();
    let scenario = scenarios::PinnedScenario030::from_capture(
        &f.plan.document_json,
        &fixture["entry"].to_string(),
    )
    .unwrap();
    let view = native_timeline(&f, scenario, wake, receiver).await.unwrap();
    assert_eq!(
        view.state.verdict.as_deref(),
        fixture["expect"]["run"].as_str()
    );
    assert!(
        observed.await.unwrap(),
        "Admission was released between revision read and apply"
    );
    let reserved: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM engine_flow030_human_requests WHERE delivery='reserved'",
    )
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(reserved, 0);
    f.pool.close().await;
}

#[tokio::test]
async fn handled_historical_failure_does_not_block_the_current_compose_failure() {
    let raw = scenarios::SCENARIOS
        .iter()
        .find(|(name, _)| *name == "compose-body-failure")
        .unwrap()
        .1;
    let f = Fixture::new(raw).await;
    let (wake, receiver) = watch::channel(0);
    let fixture: Value = serde_json::from_str(raw).unwrap();
    let scenario = scenarios::PinnedScenario030::from_capture(
        &f.plan.document_json,
        &fixture["entry"].to_string(),
    )
    .unwrap();
    let view = native_timeline(&f, scenario, wake, receiver).await.unwrap();
    let producer = view
        .effects
        .iter()
        .filter_map(|row| serde_json::from_value::<FlowEffect030>(row["effect"].clone()).ok())
        .find_map(|effect| match effect.kind {
            FlowEffectKind030::PrepareRoute { producer, .. } if producer.kind == "compose" => {
                Some(producer)
            }
            _ => None,
        })
        .unwrap();
    let row=sqlx::query("SELECT event_json,receipt_json FROM engine_flow030_events WHERE json_extract(event_json,'$.kind.WorkResult.result.Failed') IS NOT NULL LIMIT 1").fetch_one(&f.pool).await.unwrap();
    let mut event: Value = serde_json::from_str(row.get("event_json")).unwrap();
    let mut receipt: Value = serde_json::from_str(row.get("receipt_json")).unwrap();
    event["eventId"] = json!("handled-historical");
    receipt["eventId"] = json!("handled-historical");
    sqlx::query("INSERT INTO engine_flow030_events(system_id,invocation_id,event_id,event_json,receipt_json) VALUES(?,?,'handled-historical',?,?)")
        .bind(&f.identity.system_start_id).bind(&f.identity.flow_invocation_id).bind(event.to_string()).bind(receipt.to_string()).execute(&f.pool).await.unwrap();
    let host = f.app.state::<HostState>();
    let inspection = flow::inspect_run(host.flow030(), &host, &f.pool, &f.owner)
        .await
        .unwrap();
    let mut db = f.pool.acquire().await.unwrap();
    crate::agsdl_host_route_verifier030::verify_human_compose_source_tx(
        &mut db,
        &inspection.capture,
        &producer,
        &f.owner,
        "generation",
    )
    .await
    .unwrap();
    for field in ["activation", "step", "input", "message", "error"] {
        let mut changed = producer.clone();
        match field {
            "activation" => changed.activation_id.push_str("-other"),
            "step" => changed.step = Some(vec!["neighbor".into()]),
            "input" => changed.input_json = "{\"other\":true}".into(),
            "message" => changed.message_json = Some("{\"prompt\":\"other\"}".into()),
            "error" => changed.output_json =
                "{\"error\":{\"code\":\"VISIT_LIMIT\",\"message\":\"VISIT_LIMIT\",\"details\":[]}}"
                    .into(),
            _ => unreachable!(),
        }
        assert!(
            crate::agsdl_host_route_verifier030::verify_human_compose_source_tx(
                &mut db,
                &inspection.capture,
                &changed,
                &f.owner,
                "generation",
            )
            .await
            .is_err(),
            "accepted a different {field}"
        );
    }
    drop(db);
    f.pool.close().await;
}

#[tokio::test]
async fn delivery030_validates_retained_capture_and_is_idempotent_without_legacy_tables() {
    let raw = json!({"document":{"contract":"agsdl-0.3.0","id":"graphless-messages","agents":{"worker":{"harness":"codex","permissions":"workspace"}}},"timeline":[]}).to_string();
    let f = Fixture::new(&raw).await;
    let host = f.app.state::<HostState>();
    let request = flow::DeliveryRequest030 {
        scope: crate::agsdl_host_projection030::RuntimeProjectionScope030 {
            system_start_id: f.identity.system_start_id.clone(),
            snapshot_id: f.identity.snapshot_id.clone(),
            source: serde_json::from_value(f.plan.source.clone()).unwrap(),
        },
        delivery_id: "first".into(),
        agent_name: "worker".into(),
        instance: None,
        delivery: "queue".into(),
        message_json: "{\"prompt\":\"Initial mission\"}".into(),
    };
    let first = flow::deliver030(&host, &f.pool, request.clone())
        .await
        .unwrap();
    let replay = flow::deliver030(&host, &f.pool, request.clone())
        .await
        .unwrap();
    assert_eq!(first.event_id, replay.event_id);
    assert_eq!(first.revision, replay.revision);
    let mut second = request.clone();
    second.delivery_id = "second".into();
    second.message_json = "{\"prompt\":\"Queued mission\"}".into();
    flow::deliver030(&host, &f.pool, second).await.unwrap();
    let view = flow::inspect_run(host.flow030(), &host, &f.pool, &f.owner)
        .await
        .unwrap();
    assert_eq!(view.flow.state.activations.len(), 2);
    assert_eq!(view.flow.state.activations[1].phase, "queued");
    assert_eq!(view.flow.state.instances[0].queue.len(), 1);
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_flow030_events")
        .fetch_one(&f.pool)
        .await
        .unwrap();
    let mut changed = request.clone();
    changed.message_json = "{\"prompt\":\"Changed mission\"}".into();
    assert!(flow::deliver030(&host, &f.pool, changed).await.is_err());
    let mut invalid = request.clone();
    invalid.delivery_id = "invalid".into();
    invalid.message_json = "{\"unexpected\":true}".into();
    assert_eq!(
        flow::deliver030(&host, &f.pool, invalid)
            .await
            .unwrap_err()
            .code,
        "INPUT_CONSTRAINT"
    );
    let mut foreign = request.clone();
    foreign.scope.snapshot_id = "foreign".into();
    assert_eq!(
        flow::deliver030(&host, &f.pool, foreign)
            .await
            .unwrap_err()
            .code,
        "CORRELATION"
    );
    let mut fresh = request;
    fresh.instance = Some("new".into());
    assert_eq!(
        flow::deliver030(&host, &f.pool, fresh)
            .await
            .unwrap_err()
            .code,
        "INPUT_CONSTRAINT"
    );
    assert_eq!(
        before,
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM engine_flow030_events")
            .fetch_one(&f.pool)
            .await
            .unwrap()
    );
    assert_eq!(
        0,
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='engine_deliveries'"
        )
        .fetch_one(&f.pool)
        .await
        .unwrap()
    );
    f.pool.close().await;
}
