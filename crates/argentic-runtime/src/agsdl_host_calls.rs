//! Native command/check/MCP execution. The parent owns durable effect identities,
//! permissions03, capture, the controller04 broker, and normalization05.
//! No routing decisions or provider-generated identities are accepted here.
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use async_trait::async_trait;
use serde::Serialize;
use tokio::{io::AsyncReadExt, sync::Mutex};
use tokio_util::sync::CancellationToken;

use crate::agsdl_host_confinement::SandboxPolicy;
use crate::process::ContainedBackgroundProcess;

#[path = "transport/agsdl_raw.rs"]
pub(crate) mod raw_mcp;

pub(crate) type Result<T> = std::result::Result<T, CallError>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CallError {
    pub code: String,
    pub detail: String,
}
impl CallError {
    pub(crate) fn new(code: &str, detail: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            detail: detail.into(),
        }
    }
    pub(crate) fn transport(detail: impl Into<String>) -> Self {
        Self::new("CALL_FAILED", detail)
    }
}

/// Native allocation only. These types have no Deserialize implementation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CallIdentity {
    pub system_id: String,
    pub run_id: String,
    pub group_id: String,
    pub work_id: String,
    pub epoch: String,
    pub effect_id: String,
    pub provider_attempt_id: Option<String>,
    pub native_call_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum Invocation {
    Command {
        command: String,
        parse: Option<CommandParse>,
    },
    CompletionCheck {
        command: String,
        candidate_json: String,
        output_limit: usize,
        limit_ms: u64,
    },
    Mcp {
        server: String,
        tool: String,
        arguments_json: String,
    },
}
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CommandParse {
    Json,
    Lines,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CallRequest {
    pub identity: CallIdentity,
    /// Exact authored/resolved request, used by the durable store for correlation.
    pub invocation: Invocation,
}

#[derive(Clone)]
pub(crate) struct Control {
    pub stop: CancellationToken,
    /// Fired by the durable work clock04. Never a fixed MCP response watchdog.
    pub machine_timeout: CancellationToken,
}
impl Control {
    pub(crate) fn check(&self) -> Result<()> {
        if self.stop.is_cancelled() {
            return Err(CallError::new("STOPPED", "Native work stopped"));
        }
        if self.machine_timeout.is_cancelled() {
            return Err(CallError::new("TIMEOUT", "Work machine budget expired"));
        }
        Ok(())
    }
    pub(crate) async fn cancelled(&self) -> CallError {
        tokio::select! {
            biased;
            _ = self.stop.cancelled() => CallError::new("STOPPED", "Native work stopped"),
            _ = self.machine_timeout.cancelled() => CallError::new("TIMEOUT", "Work machine budget expired"),
        }
    }
}

pub(crate) struct CommandGrant {
    pub workspace: PathBuf,
    pub environment: BTreeMap<String, String>,
    pub sandbox: SandboxPolicy,
}
pub(crate) enum LaunchGrant {
    Command(CommandGrant),
    Mcp(raw_mcp::CapturedServer),
}
pub(crate) struct ClaimedCall {
    pub ticket: String,
    pub control: Control,
}

/// Actual evidence, not an assertion that closing a transport stops remote IO.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum PhysicalEvidence {
    NotStarted,
    /// The existing process owner waits for the leader and every discovered
    /// descendant to disappear. Callers must reject incomplete tree inspection,
    /// termination or stream joins before publishing a terminal result.
    Local {
        policy_digest: String,
        profile_digest: String,
        leader_reaped: bool,
        tree_termination_succeeded: bool,
        streams_joined: bool,
    },
    Remote {
        response_received: bool,
        termination_proven: bool,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandReceipt {
    pub stdout: String,
    pub stderr: String,
    /// Stable concatenation, stdout then stderr. No fabricated interleaving order.
    pub output: String,
    pub exit_code_json: String,
    pub signal: Option<i32>,
    pub complete: bool,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    pub truncated: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum RawReceipt {
    Command { receipt: CommandReceipt },
    CompletionCheck { receipt: CommandReceipt },
    Mcp { receipt: raw_mcp::McpReceipt },
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Completion {
    pub identity: CallIdentity,
    pub receipt: Option<RawReceipt>,
    pub failure: Option<CallError>,
    pub evidence: PhysicalEvidence,
}

#[async_trait]
pub(crate) trait HostPort: Send + Sync + 'static {
    fn supports_human_requests(&self) -> bool {
        true
    }
    /// One durable claim before any external IO. A consumed claim, even after a
    /// lost receipt, MUST return an error, never a fresh launch ticket. Bind all
    /// request bytes and candidate/provider/work/epoch identities transactionally.
    async fn claim(&self, request: &CallRequest) -> Result<ClaimedCall>;
    /// Same gate acquired by parent Stop/revocation. It covers revalidation and
    /// synchronous process launch, not the whole duration of the effect.
    fn launch_gate(&self) -> Arc<Mutex<()>>;
    /// Under the gate: authenticate ticket, reload captured policy/server, consume
    /// any one-shot ask grant, enforce03 and revalidate current epoch/work/plan.
    async fn authorize_launch(&self, request: &CallRequest, ticket: &str) -> Result<LaunchGrant>;
    /// Persist raw result + physical facts atomically with effect settlement.
    /// Use normalization05 for calls and durable controller04 checkEnded for
    /// checks. Revalidate Stop/epoch; late results cannot release successors.
    async fn finish(&self, ticket: &str, completion: &Completion) -> Result<()>;
    /// Durable human open/close, pauses and answer deadlines belong to04/09.
    /// No answerTimeout means no implicit refusal. The callback returns only
    /// after its close fact is durable, including decline on its human deadline.
    async fn human_open(
        &self,
        identity: &CallIdentity,
        server: &str,
        request_json: &str,
    ) -> Result<String>;
    /// Resolve with exact MCP elicitation result or modern InputResponses JSON.
    async fn human_answer(&self, ticket: &str) -> Result<String>;
    /// Close/pause bookkeeping is durable even on Stop or a failed answer wait.
    async fn human_close(&self, ticket: &str, answer: &Result<String>) -> Result<()>;
}

/// One service shared by all provider adapters. The host stops admitted works,
/// then calls close_and_join before releasing its runtime. IPC cancellation only
/// drops the answer receiver; the owned job still cleans up and persists.
pub(crate) struct HostCallService {
    jobs: Mutex<Option<tokio::task::JoinSet<bool>>>,
    owner_failed: AtomicBool,
    closed: AtomicBool,
}
impl HostCallService {
    pub(crate) fn new() -> Self {
        Self {
            jobs: Mutex::new(Some(tokio::task::JoinSet::new())),
            owner_failed: AtomicBool::new(false),
            closed: AtomicBool::new(false),
        }
    }
    pub(crate) async fn execute(
        &self,
        host: Arc<dyn HostPort>,
        request: CallRequest,
    ) -> Result<Completion> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        {
            let mut jobs = self.jobs.lock().await;
            if self.closed.load(Ordering::Acquire) {
                return Err(CallError::new("STOPPED", "Native call service closed"));
            }
            let jobs = jobs
                .as_mut()
                .ok_or_else(|| CallError::new("STOPPED", "Native call service closed"))?;
            while let Some(result) = jobs.try_join_next() {
                if !matches!(result, Ok(false)) {
                    self.owner_failed.store(true, Ordering::Relaxed);
                }
            }
            jobs.spawn(async move {
                let result = execute_owned(host, request).await;
                let failed = result.is_err();
                let _ = tx.send(result);
                failed
            });
        }
        rx.await.map_err(|_| {
            CallError::new(
                "UNCERTAIN",
                "Native effect owner failed before durable completion",
            )
        })?
    }
    pub(crate) async fn close_and_join(&self) -> Result<()> {
        self.closed.store(true, Ordering::Release);
        // Keep the JoinSet inside the service while awaiting it. If this future
        // is cancelled, a later caller can resume joining the same owners.
        let mut guard = self.jobs.lock().await;
        let mut failed = self.owner_failed.load(Ordering::Relaxed);
        if let Some(jobs) = guard.as_mut() {
            while let Some(result) = jobs.join_next().await {
                if !matches!(result, Ok(false)) {
                    failed = true;
                    self.owner_failed.store(true, Ordering::Relaxed);
                }
            }
        }
        *guard = None;
        if failed {
            Err(CallError::new(
                "UNCERTAIN",
                "A native effect owner failed during shutdown",
            ))
        } else {
            Ok(())
        }
    }
}
#[cfg(test)]
async fn execute(host: Arc<dyn HostPort>, request: CallRequest) -> Result<Completion> {
    let service = HostCallService::new();
    let result = service.execute(host, request).await;
    service.close_and_join().await?;
    result
}

async fn execute_owned(host: Arc<dyn HostPort>, request: CallRequest) -> Result<Completion> {
    let claimed = host.claim(&request).await?;
    let gate = host.launch_gate();
    let guard = gate.lock().await;
    let authorized = match claimed.control.check() {
        Ok(()) => host.authorize_launch(&request, &claimed.ticket).await,
        Err(error) => Err(error),
    };
    let mut completion = Completion {
        identity: request.identity.clone(),
        receipt: None,
        failure: None,
        evidence: PhysicalEvidence::NotStarted,
    };
    let started = match authorized.and_then(|grant| {
        claimed.control.check()?;
        Ok(grant)
    }) {
        Ok(LaunchGrant::Command(grant)) => match &request.invocation {
            Invocation::Command { command, .. } | Invocation::CompletionCheck { command, .. } => {
                grant
                    .sandbox
                    .spawn(
                        std::path::Path::new("/bin/sh"),
                        &["-c".into(), command.clone()],
                        &grant.workspace,
                        &grant.environment,
                    )
                    .map(|child| Started::Command(child, grant))
                    .map_err(CallError::transport)
            }
            _ => Err(CallError::new(
                "CORRELATION",
                "Command grant for a non-command invocation",
            )),
        },
        Ok(LaunchGrant::Mcp(_)) => Err(CallError::new(
            "HOST_CAPABILITY",
            "MCP dispatch is closed until the native delivery fence is connected",
        )),
        Err(error) => Err(error),
    };
    drop(guard);
    match started {
        Ok(Started::Command(child, grant)) => {
            let limits = match &request.invocation {
                Invocation::CompletionCheck {
                    output_limit,
                    limit_ms,
                    ..
                } => Some((*output_limit, Duration::from_millis(*limit_ms))),
                _ => None,
            };
            let (receipt, failure, evidence) =
                run_command(child, &grant.sandbox, &claimed.control, limits).await;
            completion.evidence = evidence;
            completion.failure = failure;
            completion.receipt = receipt.map(|receipt| {
                if limits.is_some() {
                    RawReceipt::CompletionCheck { receipt }
                } else {
                    RawReceipt::Command { receipt }
                }
            });
        }
        Err(error) => completion.failure = Some(error),
    }
    // The parent still revalidates under its transactional commit gate.
    if let Err(error) = claimed.control.check() {
        completion.failure = Some(error);
    }
    host.finish(&claimed.ticket, &completion).await?;
    Ok(completion)
}

enum Started {
    Command(ContainedBackgroundProcess, CommandGrant),
}

struct StreamOutput {
    bytes: Vec<u8>,
    total: u64,
}
async fn collect(
    mut pipe: impl tokio::io::AsyncRead + Unpin,
    limit: Option<usize>,
) -> std::io::Result<StreamOutput> {
    const MAX_CALL_STREAM_BYTES: usize = 64 * 1024 * 1024;
    let mut bytes = Vec::new();
    let mut total = 0u64;
    let mut buf = [0u8; 16384];
    loop {
        let n = pipe.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        total = total
            .checked_add(n as u64)
            .ok_or_else(|| std::io::Error::other("Output size overflow"))?;
        if limit.is_none() && total > MAX_CALL_STREAM_BYTES as u64 {
            return Err(std::io::Error::other(
                "Call stream exceeds 64 MiB; complete output unavailable",
            ));
        }
        let retain = limit.map_or(n, |limit| n.min(limit.saturating_sub(bytes.len())));
        bytes
            .try_reserve(retain)
            .map_err(|_| std::io::Error::other("Could not retain complete call output"))?;
        bytes.extend_from_slice(&buf[..retain]);
    }
    Ok(StreamOutput { bytes, total })
}

pub(crate) async fn run_command(
    mut child: ContainedBackgroundProcess,
    policy: &SandboxPolicy,
    control: &Control,
    limits: Option<(usize, Duration)>,
) -> (Option<CommandReceipt>, Option<CallError>, PhysicalEvidence) {
    let mut out = child.take_stdout().expect("piped stdout");
    let err = child.take_stderr().expect("piped stderr");
    // Draining concurrently avoids deadlock on a full stderr or stdout pipe.
    let (stream_failure_tx, mut stream_failure_rx) = tokio::sync::mpsc::unbounded_channel();
    let stdout_failure_tx = stream_failure_tx.clone();
    let mut stdout = tokio::spawn(async move {
        let result = match crate::agsdl_host_confinement::attest(&mut out).await {
            Ok(()) => collect(out, limits.map(|v| v.0)).await,
            Err(error) => Err(std::io::Error::other(format!(
                "Sandbox startup not attested: {error}"
            ))),
        };
        if let Err(error) = &result {
            let _ = stdout_failure_tx.send(error.to_string());
        }
        result
    });
    let mut stderr = tokio::spawn(async move {
        let result = collect(err, limits.map(|v| v.0)).await;
        if let Err(error) = &result {
            let _ = stream_failure_tx.send(error.to_string());
        }
        result
    });
    let deadline = async {
        match limits {
            Some((_, duration)) => tokio::time::sleep(duration).await,
            None => std::future::pending().await,
        }
    };
    let mut failure = None;
    let status = tokio::select! {
        biased;
        error = control.cancelled() => { failure = Some(error); None },
        _ = deadline => { failure = Some(CallError::new("CHECK_TIMEOUT", "Host completion-check time limit expired")); None },
        Some(error) = stream_failure_rx.recv() => { failure = Some(CallError::new("UNCERTAIN", format!("Command output could not be collected: {error}"))); None },
        status = child.wait() => match status {
            Ok(status) => Some(status),
            Err(error) => { failure = Some(CallError::transport(error.to_string())); None },
        },
    };
    // Even a normally exited leader can leave background descendants behind.
    let terminated = child.terminate_bounded().await;
    if let Err(error) = &terminated {
        failure = Some(CallError::new("UNCERTAIN", error.to_string()));
    }
    let joined = tokio::time::timeout(Duration::from_secs(5), async {
        let out = (&mut stdout)
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        let err = (&mut stderr)
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        Ok::<_, String>((out, err))
    })
    .await;
    let evidence = PhysicalEvidence::Local {
        policy_digest: policy.policy_digest().into(),
        profile_digest: policy.profile_digest().into(),
        leader_reaped: status.is_some() || terminated.is_ok(),
        tree_termination_succeeded: terminated.is_ok(),
        streams_joined: matches!(joined, Ok(Ok(_))),
    };
    let (out, err) = match joined {
        Ok(Ok(streams)) => streams,
        _ => {
            stdout.abort();
            stderr.abort();
            if !stdout.is_finished() {
                let _ = stdout.await;
            }
            if !stderr.is_finished() {
                let _ = stderr.await;
            }
            return (
                None,
                Some(CallError::new(
                    "UNCERTAIN",
                    "Output drain failed or exceeded its cleanup budget",
                )),
                evidence,
            );
        }
    };
    let truncated = out.total != out.bytes.len() as u64 || err.total != err.bytes.len() as u64;
    let decode = |bytes: Vec<u8>| -> Result<String> {
        if limits.is_some() {
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        } else {
            String::from_utf8(bytes).map_err(|_| {
                CallError::new(
                    "OUTPUT_INVALID",
                    "Call output is not UTF-8; no lossy normative result was produced",
                )
            })
        }
    };
    let decoded = decode(out.bytes).and_then(|out| decode(err.bytes).map(|err| (out, err)));
    let (stdout, stderr) = match decoded {
        Ok(value) => value,
        Err(error) => return (None, Some(error), evidence),
    };
    let status = status.or_else(|| terminated.ok());
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.as_ref().and_then(|s| s.signal())
    };
    #[cfg(not(unix))]
    let signal: Option<i32> = None;
    // Signals retain their identity and use the shell convention for05's integer
    // exit status. A stopped/timed-out effect is still a failure, not failed outcome.
    let code = status
        .and_then(|s| s.code())
        .unwrap_or_else(|| 128 + signal.unwrap_or(0));
    let output = format!("{stdout}{stderr}");
    let receipt = CommandReceipt {
        stdout,
        stderr,
        output,
        exit_code_json: code.to_string(),
        signal,
        complete: !truncated,
        truncated,
        stdout_bytes: out.total,
        stderr_bytes: err.total,
    };
    (Some(receipt), failure, evidence)
}

#[cfg(test)]
#[path = "agsdl_host_confinement/calls_tests.rs"]
pub(crate) mod tests;
