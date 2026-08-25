//! Narrow Macro-owned adapter around the official `rmcp` SDK for legacy stdio
//! MCP servers. This is Lot C1 of `docs/mcp-dual-era-implementation-plan.md`.
//!
//! Ownership boundaries:
//! - no `rmcp` type leaks through the public surface: callers only see Macro
//!   DTOs (`McpToolDto`, serialized JSON) and `CommandError`;
//! - process confinement is delegated to `ContainedBackgroundProcess` (Lot B),
//!   never to `rmcp`'s own child-process transport;
//! - stdio framing is bounded NDJSON, matching Macro's existing 4 MiB cap;
//! - lifecycle is strictly `ClientLifecycleMode::Initialize` (legacy era).
use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, ClientCapabilities, ClientInfo,
    ElicitationCreateRequestMethod, Implementation, ListRootsRequestMethod, PaginatedRequestParams,
    ProtocolVersion,
};
use rmcp::service::{
    ClientCacheConfig, ClientLifecycleMode, ClientServiceExt, MaybeSendFuture, RequestContext,
    RoleClient, RunningService, RxJsonRpcMessage, ServiceError, TxJsonRpcMessage,
};
use rmcp::transport::Transport;
use rmcp::{ClientHandler, ErrorData as McpError};
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::Mutex;

use super::env_secrets::sanitized_process_environment;
use super::ids::build_mcp_tool_id;
use super::result_format::format_tool_call_result;
use super::types::{McpCallToolResponse, McpToolDto};
use crate::commands::{command_error, CommandError, CommandResult};
use crate::core::process::{background_tokio_command, ContainedBackgroundProcess};

/// Matches Macro's existing stdio message cap (commands/mcp/protocol.rs) and
/// the production MCP limit used by Codex's local stdio transport.
pub(crate) const MAX_MCP_STDIO_LINE_BYTES: usize = 4 * 1024 * 1024;

/// Legacy-era version this client proposes during `initialize`. Matches the
/// artisanal client it replaces.
#[cfg(test)]
const PROPOSED_PROTOCOL_VERSION: &str = "2025-11-25";

/// Versions Macro accepts back from a legacy server. Mirrors
/// commands/mcp/protocol.rs so behavior does not regress during migration.
const KNOWN_LEGACY_PROTOCOL_VERSIONS: [&str; 5] = [
    "2024-10-07",
    "2024-11-05",
    "2025-03-26",
    "2025-06-18",
    "2025-11-25",
];

const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_OPERATION_TIMEOUT: Duration = Duration::from_secs(60);
/// Time a server has to exit voluntarily after stdin EOF before the contained
/// process group gets SIGKILLed.
const TRANSPORT_VOLUNTARY_EXIT_GRACE: Duration = Duration::from_secs(3);
/// Budget for `RunningService::close_with_timeout`; must exceed the transport
/// close path (voluntary grace + SIGKILL + bounded reap) with margin.
const SERVICE_CLOSE_BUDGET: Duration = Duration::from_secs(10);
const MAX_STDERR_BYTES: usize = 64 * 1024;
const MAX_STDERR_EXCERPT_CHARS: usize = 2_000;
const STDERR_DRAIN_BUDGET: Duration = Duration::from_secs(1);

#[derive(Debug, Clone)]
pub(crate) struct RmcpStdioServerConfig {
    pub server_id: String,
    pub server_name: String,
    pub command: String,
    pub args: Vec<String>,
    /// Fully resolved environment (declared vars plus secrets). Callers keep
    /// ownership of resolution policy; this adapter never logs these values.
    pub env: HashMap<String, String>,
    pub startup_timeout: Option<Duration>,
    pub operation_timeout: Option<Duration>,
}

impl RmcpStdioServerConfig {
    fn startup_timeout(&self) -> Duration {
        self.startup_timeout.unwrap_or(DEFAULT_STARTUP_TIMEOUT)
    }

    fn operation_timeout(&self) -> Duration {
        self.operation_timeout.unwrap_or(DEFAULT_OPERATION_TIMEOUT)
    }
}

/// One `tools/list` page mapped onto Macro DTOs.
#[derive(Debug, Clone)]
pub(crate) struct McpToolPageDto {
    pub tools: Vec<McpToolDto>,
    pub next_cursor: Option<String>,
}

/// Reads one newline-delimited frame from `reader`, enforcing
/// `MAX_MCP_STDIO_LINE_BYTES`. Returns `Ok(None)` on clean EOF at a line
/// boundary. A trailing `\r` (CRLF servers) is stripped; the frame content is
/// returned raw for the caller to decode.
async fn read_bounded_line<R>(reader: &mut R) -> io::Result<Option<Vec<u8>>>
where
    R: AsyncBufRead + Unpin,
{
    let mut line: Vec<u8> = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            break;
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let chunk_end = newline.unwrap_or(available.len());
        if line.len() + chunk_end > MAX_MCP_STDIO_LINE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("MCP stdio message exceeds {MAX_MCP_STDIO_LINE_BYTES} bytes"),
            ));
        }
        line.extend_from_slice(&available[..chunk_end]);
        let consumed = chunk_end + usize::from(newline.is_some());
        reader.consume(consumed);
        if newline.is_some() {
            if line.ends_with(b"\r") {
                line.pop();
            }
            return Ok(Some(line));
        }
    }
    if line.ends_with(b"\r") {
        line.pop();
    }
    if line.is_empty() {
        return Ok(None);
    }
    Ok(Some(line))
}

fn parse_line_message(line: &[u8]) -> Option<RxJsonRpcMessage<RoleClient>> {
    match serde_json::from_slice(line) {
        Ok(message) => Some(message),
        Err(error) => {
            tracing::debug!(error = %error, "skipping non-JSON MCP stdio output");
            None
        }
    }
}

/// Bounded stderr drain shared between connect failures and shutdown.
pub(crate) struct StderrCollector {
    buffer: Arc<Mutex<String>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl StderrCollector {
    fn spawn(stderr: Option<tokio::process::ChildStderr>) -> Self {
        let buffer = Arc::new(Mutex::new(String::new()));
        let task = stderr.map(|stderr| {
            let buffer = Arc::clone(&buffer);
            tokio::spawn(async move {
                let mut stderr = stderr;
                let mut stored = Vec::with_capacity(MAX_STDERR_BYTES);
                let mut chunk = [0u8; 8 * 1024];
                loop {
                    match stderr.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => {
                            let remaining = MAX_STDERR_BYTES.saturating_sub(stored.len());
                            stored.extend_from_slice(&chunk[..read.min(remaining)]);
                            // Continue draining after the diagnostic budget is
                            // full so a verbose long-lived server never blocks
                            // or receives EPIPE on stderr.
                        }
                    }
                }
                *buffer.lock().await = String::from_utf8_lossy(&stored).into_owned();
            })
        });
        Self { buffer, task }
    }

    async fn excerpt(&self) -> String {
        let trimmed = self.buffer.lock().await.trim().to_string();
        trimmed.chars().take(MAX_STDERR_EXCERPT_CHARS).collect()
    }

    pub(crate) async fn finish(&mut self) -> String {
        if let Some(task) = self.task.take() {
            let _ = tokio::time::timeout(STDERR_DRAIN_BUDGET, task).await;
        }
        self.excerpt().await
    }
}

fn attach_stderr_excerpt(error: CommandError, excerpt: &str) -> CommandError {
    if excerpt.is_empty() {
        return error;
    }
    CommandError {
        message: format!("{} Stderr: {}", error.message, excerpt),
    }
}

async fn init_error(
    config: &RmcpStdioServerConfig,
    stderr: &mut StderrCollector,
    detail: String,
) -> CommandError {
    let excerpt = stderr.finish().await;
    attach_stderr_excerpt(
        command_error(format!(
            "Failed to initialize MCP server '{}': {detail}",
            config.server_name
        )),
        &excerpt,
    )
}

/// Bounded NDJSON transport over an already-confined child process. The child
/// stays owned by this transport for its whole life so that every shutdown
/// path (graceful close, handshake failure, drop) goes through Lot B's
/// containment guarantees.
pub(crate) struct ContainedStdioTransport {
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    stdout: BufReader<tokio::process::ChildStdout>,
    process: ContainedBackgroundProcess,
    server_name: String,
}

impl ContainedStdioTransport {
    pub(crate) fn spawn(config: &RmcpStdioServerConfig) -> CommandResult<(Self, StderrCollector)> {
        if config.command.trim().is_empty() {
            return Err(command_error(format!(
                "MCP server '{}' has an empty stdio command.",
                config.server_name
            )));
        }
        let mut child_command = background_tokio_command(config.command.trim());
        child_command
            .args(&config.args)
            .env_clear()
            .envs(sanitized_process_environment(&config.env))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = ContainedBackgroundProcess::spawn(child_command).map_err(|error| {
            command_error(format!(
                "Failed to start MCP server '{}': {}",
                config.server_name, error
            ))
        })?;
        let stdin = child
            .take_stdin()
            .ok_or_else(|| command_error("Failed to open MCP server stdin."))?;
        let stdout = child
            .take_stdout()
            .ok_or_else(|| command_error("Failed to open MCP server stdout."))?;
        let stderr_collector = StderrCollector::spawn(child.take_stderr());

        Ok((
            Self {
                stdin: Arc::new(Mutex::new(Some(stdin))),
                stdout: BufReader::new(stdout),
                process: child,
                server_name: config.server_name.clone(),
            },
            stderr_collector,
        ))
    }

    async fn next_message(&mut self) -> Option<RxJsonRpcMessage<RoleClient>> {
        loop {
            match read_bounded_line(&mut self.stdout).await {
                Ok(Some(line)) => {
                    if line.iter().all(u8::is_ascii_whitespace) {
                        continue;
                    }
                    if let Some(message) = parse_line_message(&line) {
                        return Some(message);
                    }
                }
                Ok(None) => return None,
                Err(error) => {
                    tracing::warn!(
                        server = %self.server_name,
                        error = %error,
                        "closing MCP stdio transport after read failure"
                    );
                    return None;
                }
            }
        }
    }
}

impl Transport<RoleClient> for ContainedStdioTransport {
    type Error = io::Error;

    // Holding the stdin guard across these awaits is intentional: a JSON-RPC
    // frame must be written and flushed atomically from rmcp's concurrent send
    // futures. Macro has no clippy.toml declaring `tokio::sync::MutexGuard`
    // await-holding-invalid, so an `expect` here would be unfulfilled.
    #[allow(clippy::await_holding_invalid_type)]
    fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleClient>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        let stdin = Arc::clone(&self.stdin);
        async move {
            let mut frame = serde_json::to_vec(&item)?;
            frame.push(b'\n');
            let mut guard = stdin.lock().await;
            let writer = guard
                .as_mut()
                .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "MCP stdin closed"))?;
            writer.write_all(&frame).await?;
            writer.flush().await
        }
    }

    fn receive(&mut self) -> impl Future<Output = Option<RxJsonRpcMessage<RoleClient>>> + Send {
        self.next_message()
    }

    async fn close(&mut self) -> Result<(), Self::Error> {
        // Dropping stdin sends EOF so well-behaved servers exit on their own.
        self.stdin.lock().await.take();
        match tokio::time::timeout(TRANSPORT_VOLUNTARY_EXIT_GRACE, self.process.wait()).await {
            Ok(status) => {
                status?;
            }
            Err(_) => {
                // No voluntary exit after EOF: hard-stop the whole group now.
                self.process.terminate_with_grace(Duration::ZERO).await?;
            }
        }
        Ok(())
    }
}

/// Client handler advertising nothing (plan §12.1): no roots, sampling or
/// elicitation capability, and correlated `-32601` errors for unsupported
/// legacy server requests instead of silent successes.
#[derive(Debug)]
struct ClosedCapabilityClientHandler {
    info: ClientInfo,
}

impl ClosedCapabilityClientHandler {
    fn new(info: ClientInfo) -> Self {
        Self { info }
    }
}

impl ClientHandler for ClosedCapabilityClientHandler {
    fn get_info(&self) -> ClientInfo {
        self.info.clone()
    }

    #[expect(
        deprecated,
        reason = "roots are never advertised (plan §12.1); we still answer \
                  a correlated -32601 for non-compliant legacy servers"
    )]
    fn list_roots(
        &self,
        _context: RequestContext<RoleClient>,
    ) -> impl Future<Output = Result<rmcp::model::ListRootsResult, McpError>> + MaybeSendFuture + '_
    {
        let _ = _context;
        std::future::ready(Err(McpError::method_not_found::<ListRootsRequestMethod>()))
    }

    fn create_elicitation(
        &self,
        params: rmcp::model::ElicitRequestParams,
        context: RequestContext<RoleClient>,
    ) -> impl Future<Output = Result<rmcp::model::ElicitResult, McpError>> + MaybeSendFuture + '_
    {
        let _ = (params, context);
        std::future::ready(Err(McpError::method_not_found::<
            ElicitationCreateRequestMethod,
        >()))
    }
}

/// Persistent legacy stdio client backed by `rmcp`. One instance owns exactly
/// one confined server process and one initialized session.
pub(crate) struct RmcpLegacyStdioClient {
    service: RunningService<RoleClient, ClosedCapabilityClientHandler>,
    server_id: String,
    server_name: String,
    negotiated_version: String,
    operation_timeout: Duration,
}

fn is_supported_legacy_protocol_version(version: &str) -> bool {
    KNOWN_LEGACY_PROTOCOL_VERSIONS.contains(&version)
}

fn map_service_error(server_name: &str, label: &str, error: ServiceError) -> CommandError {
    match error {
        ServiceError::TransportClosed => command_error(format!(
            "MCP server '{server_name}' closed the connection during {label}."
        )),
        ServiceError::Timeout { timeout } => command_error(format!(
            "MCP server '{server_name}' request timed out during {label} after {timeout:?}."
        )),
        ServiceError::Cancelled { reason } => command_error(format!(
            "MCP server '{server_name}' cancelled {label}: {}.",
            reason.as_deref().unwrap_or("no reason given")
        )),
        other => command_error(format!(
            "MCP server '{server_name}' failed {label}: {other}"
        )),
    }
}

impl RmcpLegacyStdioClient {
    fn legacy_client_info() -> ClientInfo {
        ClientInfo::new(
            ClientCapabilities::default(),
            Implementation::new("Macro", env!("CARGO_PKG_VERSION")),
        )
        .with_protocol_version(ProtocolVersion::V_2025_11_25)
    }

    fn validate_negotiated_version(version: &str) -> CommandResult<()> {
        if is_supported_legacy_protocol_version(version) {
            return Ok(());
        }
        Err(command_error(format!(
            "MCP server negotiated unsupported protocol version '{version}'. \
             Macro supports: {}.",
            KNOWN_LEGACY_PROTOCOL_VERSIONS.join(", ")
        )))
    }

    /// Spawns the confined server process and performs the legacy
    /// `initialize`/`notifications/initialized` handshake.
    pub(crate) async fn connect(config: &RmcpStdioServerConfig) -> CommandResult<Self> {
        let (transport, mut stderr) = ContainedStdioTransport::spawn(config)?;
        let handler = ClosedCapabilityClientHandler::new(Self::legacy_client_info());

        let handshake = handler.serve_with_lifecycle(transport, ClientLifecycleMode::Initialize);
        let service = match tokio::time::timeout(config.startup_timeout(), handshake).await {
            Ok(result) => match result {
                Ok(service) => service,
                Err(error) => {
                    return Err(init_error(config, &mut stderr, error.to_string()).await);
                }
            },
            Err(_) => {
                // The timed-out future dropped the transport, whose contained
                // kill-on-drop already stopped the process group.
                return Err(init_error(
                    config,
                    &mut stderr,
                    format!("timed out after {:?}", config.startup_timeout()),
                )
                .await);
            }
        };

        // rmcp 3 enables response caching and stale-on-error by default; Macro
        // keeps observed state explicit (plan §4.3), so disable it like Codex.
        service
            .peer()
            .set_response_cache_config(ClientCacheConfig::disabled())
            .await;

        let peer_info = service.peer().peer_info().ok_or_else(|| {
            command_error(format!(
                "Failed to initialize MCP server '{}': handshake succeeded but \
                 server info was missing.",
                config.server_name
            ))
        })?;
        let negotiated_version = peer_info.protocol_version.as_str().to_string();

        if let Err(error) = Self::validate_negotiated_version(&negotiated_version) {
            // Shut down cleanly instead of leaking an unusable session; the
            // validation error itself carries the actionable message.
            Self {
                service,
                server_id: config.server_id.clone(),
                server_name: config.server_name.clone(),
                negotiated_version: negotiated_version.clone(),
                operation_timeout: config.operation_timeout(),
            }
            .shutdown()
            .await;
            return Err(error);
        }

        Ok(Self {
            service,
            server_id: config.server_id.clone(),
            server_name: config.server_name.clone(),
            negotiated_version,
            operation_timeout: config.operation_timeout(),
        })
    }

    pub(crate) fn negotiated_protocol_version(&self) -> &str {
        &self.negotiated_version
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.service.is_closed() || self.service.peer().is_transport_closed()
    }

    /// Fetches one `tools/list` page. Pagination stays caller-driven so the
    /// manager applies Macro's page-count and cumulative-size budgets.
    pub(crate) async fn list_tools_page(
        &self,
        cursor: Option<String>,
    ) -> CommandResult<McpToolPageDto> {
        let params = PaginatedRequestParams::default().with_cursor(cursor);
        let result = run_bounded(self, "tools/list", async move {
            self.service.peer().list_tools(Some(params)).await
        })
        .await?;

        let tools = result
            .tools
            .iter()
            .map(|tool| McpToolDto {
                id: build_mcp_tool_id(&self.server_id, tool.name.as_ref()),
                server_id: self.server_id.clone(),
                name: tool.name.to_string(),
                description: tool.description.as_ref().map(|value| value.to_string()),
                input_schema: Value::Object((*tool.input_schema).clone()),
                enabled: true,
            })
            .collect();

        Ok(McpToolPageDto {
            tools,
            next_cursor: result.next_cursor,
        })
    }

    pub(crate) async fn call_tool(
        &self,
        tool_name: &str,
        arguments: Value,
    ) -> CommandResult<McpCallToolResponse> {
        let arguments = match arguments {
            Value::Null => None,
            Value::Object(map) => Some(map),
            other => {
                return Err(command_error(format!(
                    "MCP tool arguments must be a JSON object, got {other}"
                )))
            }
        };
        let mut params = CallToolRequestParams::new(tool_name.to_string());
        params.arguments = arguments;

        let response = run_bounded(self, "tools/call", async move {
            self.service.peer().call_tool_once(params).await
        })
        .await?;

        match response {
            CallToolResponse::Complete(result) => {
                let raw_result = serde_json::to_value(&result).unwrap_or(Value::Null);
                let content = format_tool_call_result(&raw_result);
                Ok(McpCallToolResponse {
                    content,
                    is_error: result.is_error.unwrap_or(false),
                    raw_result,
                })
            }
            CallToolResponse::InputRequired(_input_required) => Err(command_error(format!(
                "MCP server '{}' requires interaction to complete tools/call; \
                 interaction brokering arrives with plan Lot G.",
                self.server_name // requestState and inputResponses are intentionally never
                                 // logged or echoed into diagnostics (plan §9).
            ))),
            CallToolResponse::Task(_) => Err(command_error(format!(
                "MCP server '{}' returned a task materialization for tools/call; \
                 not supported yet in Macro.",
                self.server_name
            ))),
            _ => Err(command_error(format!(
                "MCP server '{}' returned an unexpected tools/call response kind.",
                self.server_name
            ))),
        }
    }

    /// Stops the session and reaps the confined process group with bounded
    /// waits. Dropping without calling this still cannot leak processes:
    /// rmcp's drop guard cancels the service task and containment
    /// kill-on-drop backstops everything else.
    pub(crate) async fn shutdown(self) {
        let Self {
            service: mut owned_service,
            server_name,
            ..
        } = self;
        match owned_service.close_with_timeout(SERVICE_CLOSE_BUDGET).await {
            Ok(Some(_quit_reason)) => {}
            Ok(None) => {
                tracing::warn!(
                    server = %server_name,
                    "MCP service cleanup exceeded its close budget; containment \
                     kill-on-drop remains active"
                );
            }
            Err(join_error) => {
                tracing::warn!(
                    server = %server_name,
                    error = %join_error,
                    "MCP service task failed during shutdown"
                );
            }
        }
    }
}

async fn run_bounded<T>(
    client: &RmcpLegacyStdioClient,
    label: &'static str,
    operation: impl Future<Output = Result<T, ServiceError>>,
) -> CommandResult<T> {
    let timeout = client.operation_timeout;
    match tokio::time::timeout(timeout, operation).await {
        Ok(result) => result.map_err(|error| map_service_error(&client.server_name, label, error)),
        Err(_) => Err(command_error(format!(
            "MCP server '{}' timed out during {label} after {timeout:?}.",
            client.server_name
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::process::background_command;

    // ---------- framing ----------

    fn ndjson(lines: &[&[u8]]) -> BufReader<std::io::Cursor<Vec<u8>>> {
        let mut bytes = lines.join(&b'\n');
        bytes.push(b'\n');
        BufReader::new(std::io::Cursor::new(bytes))
    }

    #[tokio::test]
    async fn reads_bounded_lines_and_strips_crlf() {
        let mut reader = ndjson(&[b"{\"a\":1}\r", b"{\"b\":2}", b""]);
        assert_eq!(
            read_bounded_line(&mut reader).await.unwrap().unwrap(),
            b"{\"a\":1}".to_vec()
        );
        assert_eq!(
            read_bounded_line(&mut reader).await.unwrap().unwrap(),
            b"{\"b\":2}".to_vec()
        );
        assert_eq!(read_bounded_line(&mut reader).await.unwrap().unwrap(), b"");
        assert!(read_bounded_line(&mut reader).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn returns_partial_line_at_eof_without_newline() {
        let mut reader = BufReader::new(std::io::Cursor::new(b"{\"partial\":true}".to_vec()));
        assert_eq!(
            read_bounded_line(&mut reader).await.unwrap().unwrap(),
            b"{\"partial\":true}".to_vec()
        );
        assert!(read_bounded_line(&mut reader).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn rejects_lines_over_the_bound() {
        let oversized = vec![b'a'; MAX_MCP_STDIO_LINE_BYTES + 1];
        let mut reader = ndjson(&[&oversized]);
        let error = read_bounded_line(&mut reader)
            .await
            .expect_err("oversized line must fail");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[tokio::test]
    async fn skips_non_json_lines_instead_of_dying() {
        let banner = b"server starting".to_vec();
        let good = br#"{"jsonrpc":"2.0","id":1,"result":{}}"#.to_vec();
        let mut reader = ndjson(&[&banner, &good]);
        let first = read_bounded_line(&mut reader).await.unwrap().unwrap();
        assert!(
            parse_line_message(&first).is_none(),
            "banner must not parse"
        );
        let second = read_bounded_line(&mut reader).await.unwrap().unwrap();
        assert!(parse_line_message(&second).is_some(), "valid frame parses");
    }

    // ---------- negotiation policy ----------

    #[test]
    fn proposes_latest_legacy_version_and_accepts_only_known_legacy_versions() {
        assert_eq!(PROPOSED_PROTOCOL_VERSION, "2025-11-25");
        for accepted in KNOWN_LEGACY_PROTOCOL_VERSIONS {
            assert!(
                RmcpLegacyStdioClient::validate_negotiated_version(accepted).is_ok(),
                "{accepted} must be accepted"
            );
        }
        for rejected in ["2026-07-28", "2099-01-01", "", "latest"] {
            let error = RmcpLegacyStdioClient::validate_negotiated_version(rejected)
                .expect_err("non-legacy versions must fail closed");
            assert!(error.message.contains("unsupported protocol version"));
        }
    }

    #[test]
    fn client_info_advertises_macro_and_no_capabilities() {
        let info = RmcpLegacyStdioClient::legacy_client_info();
        assert_eq!(info.client_info.name, "Macro");
        assert_eq!(info.protocol_version.as_str(), "2025-11-25");
        let serialized = serde_json::to_value(&info).unwrap();
        assert_eq!(serialized["capabilities"], serde_json::json!({}));
    }

    #[test]
    fn maps_tool_pages_onto_macro_dtos_with_pagination_cursor() {
        let page = McpToolPageDto {
            tools: vec![],
            next_cursor: Some("page-2".to_string()),
        };
        assert_eq!(page.next_cursor.as_deref(), Some("page-2"));

        let dto = McpToolDto {
            id: build_mcp_tool_id("github_server", "issues_list"),
            server_id: "github_server".to_string(),
            name: "issues_list".to_string(),
            description: Some("List issues".to_string()),
            input_schema: serde_json::json!({ "type": "object" }),
            enabled: true,
        };
        assert_eq!(dto.id, "mcp__github_server__issues_list");
        assert!(dto.enabled);
    }

    // ---------- end-to-end against a real NDJSON subprocess ----------

    fn python3() -> Option<String> {
        background_command("python3")
            .arg("--version")
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|_| "python3".to_string())
    }

    fn fixture_script() -> String {
        r#"
import json, os, sys

MODE = sys.argv[1] if len(sys.argv) > 1 else 'ok'

PAGE_ONE = [{'name': 'echo-value', 'description': 'Echo input', 'inputSchema': {'type': 'object', 'properties': {'value': {'type': 'string'}}}}]
PAGE_TWO = [{'name': 'echo-value-two', 'description': 'Echo input again', 'inputSchema': {'type': 'object', 'properties': {'value': {'type': 'string'}}}}]

def read():
    line = sys.stdin.buffer.readline()
    if not line:
        raise SystemExit(0)
    line = line.strip()
    if not line:
        return None
    return json.loads(line)

def write(payload):
    sys.stdout.buffer.write(json.dumps(payload).encode() + b'\n')
    sys.stdout.buffer.flush()

while True:
    msg = read()
    if msg is None:
        continue
    if 'id' not in msg:
        continue
    method = msg.get('method')
    if method == 'initialize':
        version = '2026-07-28' if MODE == 'modern' else msg['params']['protocolVersion']
        write({'jsonrpc': '2.0', 'id': msg['id'], 'result': {'protocolVersion': version, 'capabilities': {}, 'serverInfo': {'name': 'fixture', 'version': '0'}}})
    elif method == 'ping':
        write({'jsonrpc': '2.0', 'id': msg['id'], 'result': {}})
    elif method == 'tools/list':
        if MODE == 'flood':
            sys.stdout.buffer.write(b'x' * (5 * 1024 * 1024))
            sys.stdout.buffer.flush()
            continue
        if MODE == 'crash':
            os._exit(9)
        cursor = (msg.get('params') or {}).get('cursor')
        if cursor == 'page-2':
            write({'jsonrpc': '2.0', 'id': msg['id'], 'result': {'tools': PAGE_TWO}})
        else:
            write({'jsonrpc': '2.0', 'id': msg['id'], 'result': {'tools': PAGE_ONE, 'nextCursor': 'page-2'}})
    elif method == 'tools/call':
        args = (msg.get('params') or {}).get('arguments') or {}
        write({'jsonrpc': '2.0', 'id': msg['id'], 'result': {'content': [{'type': 'text', 'text': 'echo:' + args.get('value', '')}]}})
"#
        .to_string()
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        script_path: std::path::PathBuf,
        python: String,
    }

    fn write_fixture() -> Option<Fixture> {
        let python = python3()?;
        let dir = tempfile::TempDir::new().ok()?;
        let script_path = dir.path().join("rmcp_fixture_server.py");
        std::fs::write(&script_path, fixture_script()).ok()?;
        Some(Fixture {
            _dir: dir,
            script_path,
            python,
        })
    }

    fn fixture_config(fixture: &Fixture, mode: &str) -> RmcpStdioServerConfig {
        RmcpStdioServerConfig {
            server_id: "fixture_server".to_string(),
            server_name: "Fixture Server".to_string(),
            command: fixture.python.clone(),
            args: vec![
                fixture.script_path.to_string_lossy().to_string(),
                mode.to_string(),
            ],
            env: HashMap::new(),
            startup_timeout: Some(Duration::from_secs(10)),
            operation_timeout: Some(Duration::from_secs(10)),
        }
    }

    #[tokio::test]
    async fn initializes_paginates_and_calls_tools_on_one_confined_process() {
        let Some(fixture) = write_fixture() else {
            return;
        };
        let client = RmcpLegacyStdioClient::connect(&fixture_config(&fixture, "ok"))
            .await
            .expect("connect");

        assert_eq!(client.negotiated_protocol_version(), "2025-11-25");

        let page_one = client.list_tools_page(None).await.expect("page one");
        assert_eq!(page_one.tools.len(), 1);
        assert_eq!(page_one.tools[0].name, "echo-value");
        assert_eq!(page_one.tools[0].server_id, "fixture_server");
        assert_eq!(page_one.tools[0].id, "mcp__fixture_server__echo-value");
        assert_eq!(page_one.next_cursor.as_deref(), Some("page-2"));

        let page_two = client
            .list_tools_page(page_one.next_cursor.clone())
            .await
            .expect("page two");
        assert_eq!(page_two.tools.len(), 1);
        assert_eq!(page_two.tools[0].name, "echo-value-two");
        assert!(page_two.next_cursor.is_none());

        let call = client
            .call_tool("echo-value", serde_json::json!({ "value": "ok" }))
            .await
            .expect("tool call");
        assert_eq!(call.content, "echo:ok");
        assert!(!call.is_error);
        assert_eq!(call.raw_result["content"][0]["text"], "echo:ok");

        assert!(!client.is_closed());
        client.shutdown().await;
    }

    #[tokio::test]
    async fn fails_closed_when_server_negotiates_a_modern_version() {
        let Some(fixture) = write_fixture() else {
            return;
        };
        let connect_result =
            RmcpLegacyStdioClient::connect(&fixture_config(&fixture, "modern")).await;
        let error = match connect_result {
            Err(error) => error,
            Ok(_) => panic!("modern-era negotiation must fail the legacy adapter"),
        };
        assert!(
            error.message.contains("unsupported protocol version"),
            "{}",
            error.message
        );
        assert!(error.message.contains("2026-07-28"), "{}", error.message);
    }

    #[tokio::test]
    async fn surfaces_process_crash_as_operation_failure() {
        let Some(fixture) = write_fixture() else {
            return;
        };
        let client = RmcpLegacyStdioClient::connect(&fixture_config(&fixture, "crash"))
            .await
            .expect("connect");
        let error = client
            .list_tools_page(None)
            .await
            .expect_err("crashed server must fail the operation");
        assert!(
            error.message.contains("closed the connection")
                || error.message.contains("failed tools/list"),
            "{}",
            error.message
        );
        assert!(client.is_closed());
        client.shutdown().await;
    }

    #[tokio::test]
    async fn oversized_stdout_line_closes_transport() {
        let Some(fixture) = write_fixture() else {
            return;
        };
        let client = RmcpLegacyStdioClient::connect(&fixture_config(&fixture, "flood"))
            .await
            .expect("connect");
        let error = client
            .list_tools_page(None)
            .await
            .expect_err("oversized frame must close the transport");
        assert!(
            error.message.contains("closed the connection")
                || error.message.contains("failed tools/list"),
            "{}",
            error.message
        );
        assert!(client.is_closed());
        client.shutdown().await;
    }
}
