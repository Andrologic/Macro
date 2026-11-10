//! Host-owned calls use the existing confined process and captured MCP transports.
use crate::{
    agsdl_host::HostState,
    agsdl_host_call_authority030::NativeCallAuthority030,
    agsdl_host_calls::{self as transport, raw_mcp, CommandGrant, Control, PhysicalEvidence},
    agsdl_host_calls030::{
        self as calls, CallAttempt030, CallEvent030, JoinedCall030, PreparedCall030,
    },
    agsdl_host_confinement::{FileAccess, OsCeiling, PathScope, SandboxPolicy},
    agsdl_host_flow030::{self as flow, NativeFlowInspection030},
    agsdl_host_runtime030::HostExecutor030,
    ai::stream_tasks::StreamTasks,
    config::ConfigManager,
    db::agsdl_execution::{
        dto::EngineOwner, failure, flow030::FlowEffect030, start030::StartCapture030, Result,
    },
};
use futures::future::BoxFuture;
use serde_json::Value;
use sqlx::SqlitePool;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use tauri::Manager;
use tokio_util::sync::CancellationToken;

pub(crate) struct CallExecutor030 {
    pub config: ConfigManager,
    pub pool: SqlitePool,
    pub tasks: StreamTasks,
    pub owner: EngineOwner,
    pub transport: std::sync::Arc<dyn CallTransport030>,
}
pub(crate) struct StartedCall030 {
    pub attempt: CallAttempt030,
    pub cancel: CancellationToken,
    pub timeout: CancellationToken,
    pub request_id: String,
    pub result: tokio::sync::oneshot::Receiver<Result<Option<JoinedCall030>>>,
}
impl<R: tauri::Runtime> HostExecutor030<R> for CallExecutor030 {
    fn start(
        &self,
        app: tauri::AppHandle<R>,
        inspection: NativeFlowInspection030,
        effect: FlowEffect030,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<Option<StartedCall030>>> {
        let transport = self.transport.clone();
        let (config, pool, tasks, owner) = (
            self.config.clone(),
            self.pool.clone(),
            self.tasks.clone(),
            self.owner.clone(),
        );
        Box::pin(async move {
            let host = app.state::<HostState>();
            let authority = NativeCallAuthority030::capture(&host, &owner).await?;
            let broker = host.start_lease().await?.call_data030()?;
            let attempt = calls::reserve_call030(&pool, &authority, &effect).await?;
            match calls::prepare_call030(&pool, &authority, &broker, &attempt, &cancel).await? {
                calls::CallPreparation030::Ready => (),
                calls::CallPreparation030::Failed { .. } => return Ok(None),
                calls::CallPreparation030::Diagnostic { .. } => {
                    return Err(failure(
                        "UNCERTAIN",
                        "call",
                        "Call preparation has a diagnostic",
                    ))
                }
            }
            drop(authority);
            let Some(claim) =
                flow::claim_expected(host.flow030(), &host, &pool, &effect.identity, &effect.id)
                    .await?
            else {
                let authority = NativeCallAuthority030::capture(&host, &owner).await?;
                calls::stop_before_launch030(&pool, &authority, &attempt).await?;
                return Ok(None);
            };
            let request_id = claim.request_id();
            let (send, result) = tokio::sync::oneshot::channel();
            let timeout = CancellationToken::new();
            let machine_timeout = timeout.clone();
            let (owned_attempt, owned_cancel) = (attempt.clone(), cancel.clone());
            let (clock_ready, wait_clock) = tokio::sync::oneshot::channel();
            let worker_app = app.clone();
            let clock_pool = pool.clone();
            claim
                .handoff_host(&tasks, async move {
                    let host = worker_app.state::<HostState>();
                    let result = async {
                        wait_clock.await.map_err(|_| {
                            failure("INTERRUPTED", "clock", "Clock admission failed")
                        })?;
                        let authority = NativeCallAuthority030::capture(&host, &owner).await?;
                        let control = Control {
                            stop: owned_cancel,
                            machine_timeout,
                        };
                        let prepared = prepared(&pool, &owned_attempt).await?;
                        // Keep approved configuration leases until the synchronous spawn.
                        let global = config.lock_agsdl_host_permissions().await.map_err(|_| {
                            failure("PERMISSION", "call", "Host permissions unavailable")
                        })?;
                        let project = config
                            .lock_execution_tools(&inspection.capture.source.owner.project_id)
                            .await
                            .map_err(|_| {
                                failure("PERMISSION", "call", "Project permissions unavailable")
                            })?;
                        let mut grant = grant(
                            &inspection.capture,
                            &serde_json::to_value(global.permissions())?,
                            &project.tools,
                            &prepared,
                        );
                        if serde_json::to_value(&project.agsdl_host_permissions)? != "workspace" {
                            grant = Err(failure(
                                "PERMISSION",
                                "call",
                                "Current project permissions do not allow local calls",
                            ));
                        }
                        let started = calls::launch_native030(
                            &pool,
                            &authority,
                            &owned_attempt,
                            &control,
                            || {
                                control
                                    .check()
                                    .and_then(|_| {
                                        grant.map_err(|e| {
                                            transport::CallError::new(&e.code, e.message)
                                        })
                                    })
                                    .and_then(|grant| {
                                        transport.start(
                                            grant,
                                            prepared.clone(),
                                            inspection.capture.clone(),
                                            owned_attempt.clone(),
                                            control.clone(),
                                        )
                                    })
                            },
                        )
                        .await;
                        drop(project);
                        drop(global);
                        // A Stop can win the preparation/launch race. It authorizes no IO.
                        let end = match started {
                            Ok(Ok(started)) => started.await?,
                            Ok(Err(_)) => {
                                crate::db::agsdl_execution::call_protocol030::CallEnd030::Returned {
                                    event: CallEvent030::StartFailed,
                                }
                            }
                            Err(error) => {
                                if control.stop.is_cancelled()
                                    || flow::inspect_run(host.flow030(), &host, &pool, &owner)
                                        .await?
                                        .flow
                                        .state
                                        .stopping
                                {
                                    calls::stop_before_launch030(&pool, &authority, &owned_attempt)
                                        .await?;
                                    return Ok(None);
                                }
                                return Err(error);
                            }
                        };
                        let joined = JoinedCall030::from_native(owned_attempt, end, control);
                        Ok(Some(joined))
                    }
                    .await;
                    host.flow030().supervisors.wake(&owner.system_start_id);
                    let _ = send.send(result);
                })
                .await?;
            let human = host
                .flow030()
                .humans
                .broker(&host, &clock_pool, &effect.identity)
                .await?;
            {
                let _operation = human.operation.lock().await;
                human.admit_host_work(&host, &effect.id).await?;
                human.pump(&host, &CancellationToken::new()).await?;
            }
            let _ = clock_ready.send(());
            Ok(Some(StartedCall030 {
                attempt,
                cancel,
                timeout,
                request_id,
                result,
            }))
        })
    }
}

async fn prepared(pool: &SqlitePool, attempt: &CallAttempt030) -> Result<PreparedCall030> {
    let raw: String = sqlx::query_scalar(
        "SELECT prepared_json FROM engine_flow030_calls WHERE call_id=? AND status='prepared'",
    )
    .bind(attempt.call_id())
    .fetch_one(pool)
    .await?;
    Ok(serde_json::from_str(&raw)?)
}

/// Calls have no agent permissions to borrow. Both captured and current host
/// ceilings must explicitly allow local work; project read-only remains a ceiling.
pub(crate) fn grant(
    capture: &StartCapture030,
    current_host: &Value,
    tools: &Value,
    prepared: &PreparedCall030,
) -> Result<CommandGrant> {
    let private: Value = serde_json::from_str(&capture.private_capture_json)?;
    let scope: Value = serde_json::from_str(
        private["callScopeJson"]
            .as_str()
            .ok_or_else(|| failure("PERMISSION", "call", "Call scope missing"))?,
    )?;
    let captured: Value = serde_json::from_str(
        private["callPermissionsJson"]
            .as_str()
            .ok_or_else(|| failure("PERMISSION", "call", "Call permissions missing"))?,
    )?;
    if captured["agsdlHostPermissions"] != "workspace"
        || current_host != "workspace"
        || crate::core::tool_policy::agsdl_native_read_only(&captured)
        || tools.get("readOnly").and_then(Value::as_bool) == Some(true)
    {
        return Err(failure(
            "PERMISSION",
            "call",
            "Local calls require approved workspace permissions and a writable project",
        ));
    }
    let root = PathBuf::from(
        scope["root"]
            .as_str()
            .ok_or_else(|| failure("PERMISSION", "call", "Workspace missing"))?,
    );
    let canonical = root
        .canonicalize()
        .map_err(|_| failure("PERMISSION", "call", "Workspace unavailable"))?;
    let identity = crate::fs::operations::workspace_root_identity(&canonical)
        .map_err(|_| failure("PERMISSION", "call", "Workspace identity unavailable"))?
        .observation_key()
        .ok_or_else(|| failure("PERMISSION", "call", "Workspace identity unavailable"))?;
    if canonical != root || scope["rootIdentity"] != identity {
        return Err(failure(
            "PERMISSION",
            "call",
            "Workspace changed since capture",
        ));
    }
    let _ = prepared;
    let mut read = vec![
        PathScope::Literal(PathBuf::from("/")),
        PathScope::Subtree(root.clone()),
    ];
    // Explicit native runtime dependencies. User home and application profiles
    // are outside these roots; the environment inherits no credentials.
    for path in [
        "/bin",
        "/usr/bin",
        "/usr/lib",
        "/System/Library",
        "/private/var/select",
    ] {
        if Path::new(path).exists() {
            read.push(PathScope::Subtree(Path::new(path).canonicalize().map_err(
                |_| failure("PERMISSION", "call", "Runtime directory unavailable"),
            )?));
        }
    }
    read.push(PathScope::Literal(PathBuf::from("/dev/null")));
    let sandbox = SandboxPolicy::from_authorized_ceilings(
        capture.source.source_sha256.clone(),
        &[OsCeiling {
            read: FileAccess {
                allow: read,
                block: vec![],
            },
            write: FileAccess {
                allow: vec![
                    PathScope::Subtree(root.clone()),
                    PathScope::Literal(PathBuf::from("/dev/null")),
                ],
                block: vec![],
            },
            network: false,
        }],
    )
    .map_err(|message| failure("HOST_CAPABILITY", "call", &message))?;
    Ok(CommandGrant {
        workspace: root,
        environment: BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
        sandbox,
    })
}

/// start is synchronous under native admission. The future owns every resource
/// it starts and returns only after physical cleanup, even on cancellation.
pub(crate) trait CallTransport030: Send + Sync {
    fn start(
        &self,
        grant: CommandGrant,
        prepared: PreparedCall030,
        capture: StartCapture030,
        attempt: CallAttempt030,
        control: Control,
    ) -> transport::Result<
        BoxFuture<'static, Result<crate::db::agsdl_execution::call_protocol030::CallEnd030>>,
    >;
}
pub(crate) struct NativeCallTransport030 {
    pub humans: Option<std::sync::Arc<dyn transport::HostPort>>,
}
impl CallTransport030 for NativeCallTransport030 {
    fn start(
        &self,
        grant: CommandGrant,
        prepared: PreparedCall030,
        capture: StartCapture030,
        attempt: CallAttempt030,
        control: Control,
    ) -> transport::Result<
        BoxFuture<'static, Result<crate::db::agsdl_execution::call_protocol030::CallEnd030>>,
    > {
        let started = start_transport(grant, &prepared, &capture)?;
        let humans = self
            .humans
            .clone()
            .unwrap_or_else(|| std::sync::Arc::new(NoHuman));
        Ok(Box::pin(async move {
            run_transport(started, &prepared, &attempt, &control, humans).await
        }))
    }
}

enum StartedTransport {
    Command(
        crate::core::process::ContainedBackgroundProcess,
        SandboxPolicy,
    ),
    Mcp(raw_mcp::Session),
}
fn start_transport(
    grant: CommandGrant,
    prepared: &PreparedCall030,
    capture: &StartCapture030,
) -> transport::Result<StartedTransport> {
    match prepared {
        PreparedCall030::Command { command, .. } => {
            let child = grant
                .sandbox
                .spawn(
                    Path::new("/bin/sh"),
                    &["-c".into(), command.clone()],
                    &grant.workspace,
                    &grant.environment,
                )
                .map_err(transport::CallError::transport)?;
            Ok(StartedTransport::Command(child, grant.sandbox))
        }
        PreparedCall030::Mcp { server, .. } => {
            let document: Value = serde_json::from_str(&capture.authored_source)
                .map_err(|e| transport::CallError::transport(e.to_string()))?;
            let command = document["mcpServers"][server]["command"]
                .as_array()
                .ok_or_else(|| {
                    transport::CallError::transport("Only local stdio MCP servers are supported")
                })?;
            let program = command
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| transport::CallError::transport("MCP program missing"))?;
            // Resolve bare program names only within the fixed native PATH.
            let program = if Path::new(program).is_absolute() {
                PathBuf::from(program)
            } else if program.contains('/') {
                grant.workspace.join(program)
            } else {
                ["/usr/bin", "/bin"]
                    .iter()
                    .map(|dir| Path::new(dir).join(program))
                    .find(|path| path.is_file())
                    .ok_or_else(|| {
                        transport::CallError::transport(
                            "MCP executable not found in the confined PATH",
                        )
                    })?
            };
            let arguments = command
                .iter()
                .skip(1)
                .map(|v| {
                    v.as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| transport::CallError::transport("MCP argument is not text"))
                })
                .collect::<transport::Result<Vec<_>>>()?;
            raw_mcp::start(raw_mcp::CapturedServer {
                document_name: server.clone(),
                capture_digest: capture.source.source_sha256.clone(),
                protocol: raw_mcp::Protocol::Legacy,
                transport: raw_mcp::ServerTransport::Stdio(raw_mcp::StdioServer {
                    program,
                    arguments,
                    grant,
                }),
            })
            .map(StartedTransport::Mcp)
        }
    }
}
async fn run_transport(
    started: StartedTransport,
    prepared: &PreparedCall030,
    attempt: &CallAttempt030,
    control: &Control,
    humans: std::sync::Arc<dyn transport::HostPort>,
) -> Result<crate::db::agsdl_execution::call_protocol030::CallEnd030> {
    let (event, failure, evidence) = match started {
        StartedTransport::Command(child, policy) => {
            let (receipt, failure, evidence) =
                transport::run_command(child, &policy, control, None).await;
            let event = receipt.map(|r| CallEvent030::CommandReceipt {
                stdout: r.stdout,
                stderr: r.stderr,
                exit_code: r.exit_code_json.parse().unwrap_or(1),
            });
            (event, failure, evidence)
        }
        StartedTransport::Mcp(mut session) => {
            let PreparedCall030::Mcp {
                tool,
                arguments_json,
                ..
            } = prepared
            else {
                unreachable!()
            };
            let identity = transport::CallIdentity {
                system_id: attempt.identity().system_start_id.clone(),
                run_id: attempt.identity().flow_invocation_id.clone(),
                group_id: String::new(),
                work_id: attempt.work().activation_id.clone(),
                epoch: attempt.generation().into(),
                effect_id: attempt.effect().id.clone(),
                provider_attempt_id: None,
                native_call_id: attempt.call_id().into(),
            };
            let result = session
                .call(tool, arguments_json, humans, &identity, control)
                .await;
            let (evidence, cleanup) = session.shutdown(result.is_ok()).await;
            match result {
                Ok(r) => (
                    Some(CallEvent030::ToolReturned {
                        is_error: r.is_error,
                        text: r.text,
                        structured_content_json: r.structured_content_json,
                    }),
                    cleanup,
                    evidence,
                ),
                Err(error) => (None, cleanup.or(Some(error)), evidence),
            }
        }
    };
    if !matches!(
        evidence,
        PhysicalEvidence::Local {
            leader_reaped: true,
            tree_termination_succeeded: true,
            streams_joined: true,
            ..
        }
    ) {
        return Err(failure_fn("Call process cleanup did not complete"));
    }
    use crate::db::agsdl_execution::call_protocol030::CallEnd030;
    if control.stop.is_cancelled() {
        return Ok(CallEnd030::Stopped);
    }
    Ok(CallEnd030::Returned {
        event: if failure
            .as_ref()
            .is_some_and(|error| error.code == "OUTPUT_INVALID")
            && matches!(prepared, PreparedCall030::Command { .. })
        {
            CallEvent030::OutputInvalid
        } else if failure.is_some() {
            CallEvent030::StartFailed
        } else {
            event.unwrap_or(CallEvent030::StartFailed)
        },
    })
}
fn failure_fn(message: &str) -> crate::db::agsdl_execution::dto::EngineFailure {
    failure("UNCERTAIN", "call", message)
}

// The transport's human callbacks fail explicitly until lot 3.2. No implicit
// approval/decline, fixed watchdog or historical work protocol is introduced.
struct NoHuman;
#[async_trait::async_trait]
impl transport::HostPort for NoHuman {
    fn supports_human_requests(&self) -> bool {
        false
    }
    async fn claim(&self, _: &transport::CallRequest) -> transport::Result<transport::ClaimedCall> {
        Err(no_human())
    }
    fn launch_gate(&self) -> std::sync::Arc<tokio::sync::Mutex<()>> {
        std::sync::Arc::new(tokio::sync::Mutex::new(()))
    }
    async fn authorize_launch(
        &self,
        _: &transport::CallRequest,
        _: &str,
    ) -> transport::Result<transport::LaunchGrant> {
        Err(no_human())
    }
    async fn finish(&self, _: &str, _: &transport::Completion) -> transport::Result<()> {
        Err(no_human())
    }
    async fn human_open(
        &self,
        _: &transport::CallIdentity,
        _: &str,
        _: &str,
    ) -> transport::Result<String> {
        Err(no_human())
    }
    async fn human_answer(&self, _: &str) -> transport::Result<String> {
        Err(no_human())
    }
    async fn human_close(&self, _: &str, _: &transport::Result<String>) -> transport::Result<()> {
        Err(no_human())
    }
}
fn no_human() -> transport::CallError {
    transport::CallError::new(
        "HOST_CAPABILITY",
        "MCP human requests are not supported in this run",
    )
}
