//! Strict MCP 2026-07-28 stdio adapter built on `rmcp`.
//!
//! This module deliberately owns only the modern lifecycle. Automatic
//! negotiation remains a separate concern: its disposable sibling probe must
//! select this adapter before the long-lived worker process is spawned.
//!
//! Integration note: `rmcp_adapter::ContainedStdioTransport` and its `spawn`
//! method must become `pub(crate)`. No other sibling visibility is required.
//! Reusing that transport keeps NDJSON framing, the 4 MiB frame limit, process
//! groups / Windows Job Objects, stderr draining, and bounded reaping in one
//! place.

use std::error::Error as StdError;
use std::future::Future;
use std::time::Duration;

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, ClientCapabilities, ClientInfo, Implementation,
    PaginatedRequestParams, ProtocolVersion,
};
use rmcp::service::{
    ClientCacheConfig, ClientInitializeError, ClientLifecycleMode, ClientServiceExt, RoleClient,
    RunningService, ServiceError,
};
use rmcp::transport::IntoTransport;
use rmcp::ClientHandler;
use serde_json::Value;

use super::ids::build_mcp_tool_id;
use super::result_format::format_tool_call_result;
use super::rmcp_adapter::{ContainedStdioTransport, McpToolPageDto, RmcpStdioServerConfig};
use super::types::{McpCallToolResponse, McpToolDto};
use crate::commands::{command_error, CommandError, CommandResult};

pub(crate) const MODERN_PROTOCOL_VERSION: &str = "2026-07-28";

const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_OPERATION_TIMEOUT: Duration = Duration::from_secs(60);
const SERVICE_CLOSE_BUDGET: Duration = Duration::from_secs(10);

/// Modern peer information retained after `server/discover`.
///
/// All values are Macro-owned or JSON values, so no `rmcp` type crosses the
/// adapter boundary. The metadata is intentionally preserved for diagnostics,
/// cache policy and future extension handling.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct McpModernServerMetadata {
    pub negotiated_protocol_version: String,
    pub capabilities: Value,
    pub server_info: Option<Value>,
    pub instructions: Option<String>,
    pub meta: Option<Value>,
}

/// A modern tool call can finish, request another MRTR round, or materialize a
/// task. Lot G will broker the latter two; this adapter preserves their exact
/// SDK representation now instead of converting them into lossy strings.
#[derive(Debug, Clone)]
pub(crate) enum McpModernToolCallOutcome {
    Complete(McpCallToolResponse),
    InputRequired { raw_result: Value },
    Task { raw_result: Value },
}

pub(crate) enum McpModernProbeOutcome {
    Modern(RmcpModernStdioClient),
    Legacy { reason: String },
}

struct ModernStartupError {
    message: String,
    legacy_compatible: bool,
}

#[derive(Debug)]
struct ModernClientHandler {
    info: ClientInfo,
}

impl ModernClientHandler {
    fn new() -> Self {
        Self {
            info: ClientInfo::new(
                ClientCapabilities::default(),
                Implementation::new("Macro", env!("CARGO_PKG_VERSION")),
            )
            .with_protocol_version(ProtocolVersion::V_2026_07_28),
        }
    }
}

impl ClientHandler for ModernClientHandler {
    fn get_info(&self) -> ClientInfo {
        self.info.clone()
    }
}

/// Persistent strict-modern stdio client. It owns one confined worker process
/// through the shared transport and never sends `initialize`.
pub(crate) struct RmcpModernStdioClient {
    service: RunningService<RoleClient, ModernClientHandler>,
    server_id: String,
    server_name: String,
    metadata: McpModernServerMetadata,
    operation_timeout: Duration,
}

impl RmcpModernStdioClient {
    fn lifecycle() -> ClientLifecycleMode {
        ClientLifecycleMode::Discover {
            preferred_versions: vec![ProtocolVersion::V_2026_07_28],
        }
    }

    /// Starts a confined stdio worker and proves strict modern support through
    /// `server/discover`. There is deliberately no legacy fallback here.
    pub(crate) async fn connect(config: &RmcpStdioServerConfig) -> CommandResult<Self> {
        let (transport, mut stderr) = ContainedStdioTransport::spawn(config)?;
        match Self::connect_transport_classified(config, transport).await {
            Ok(client) => Ok(client),
            Err(mut error) => {
                let excerpt = stderr.finish().await;
                if !excerpt.is_empty() {
                    error.message.push_str(" Stderr: ");
                    error.message.push_str(&excerpt);
                }
                Err(command_error(error.message))
            }
        }
    }

    pub(crate) async fn probe(
        config: &RmcpStdioServerConfig,
    ) -> CommandResult<McpModernProbeOutcome> {
        let (transport, mut stderr) = ContainedStdioTransport::spawn(config)?;
        match Self::connect_transport_classified(config, transport).await {
            Ok(client) => Ok(McpModernProbeOutcome::Modern(client)),
            Err(mut error) if error.legacy_compatible => {
                let excerpt = stderr.finish().await;
                if !excerpt.is_empty() {
                    error.message.push_str(" Stderr: ");
                    error.message.push_str(&excerpt);
                }
                Ok(McpModernProbeOutcome::Legacy {
                    reason: error.message,
                })
            }
            Err(mut error) => {
                let excerpt = stderr.finish().await;
                if !excerpt.is_empty() {
                    error.message.push_str(" Stderr: ");
                    error.message.push_str(&excerpt);
                }
                Err(command_error(error.message))
            }
        }
    }

    #[cfg(test)]
    async fn connect_transport<T, E, A>(
        config: &RmcpStdioServerConfig,
        transport: T,
    ) -> CommandResult<Self>
    where
        T: IntoTransport<RoleClient, E, A>,
        E: StdError + Send + Sync + 'static,
    {
        Self::connect_transport_classified(config, transport)
            .await
            .map_err(|error| command_error(error.message))
    }

    async fn connect_transport_classified<T, E, A>(
        config: &RmcpStdioServerConfig,
        transport: T,
    ) -> Result<Self, ModernStartupError>
    where
        T: IntoTransport<RoleClient, E, A>,
        E: StdError + Send + Sync + 'static,
    {
        let startup_timeout = config.startup_timeout.unwrap_or(DEFAULT_STARTUP_TIMEOUT);
        let handler = ModernClientHandler::new();
        let handshake = handler.serve_with_lifecycle(transport, Self::lifecycle());
        let service = match tokio::time::timeout(startup_timeout, handshake).await {
            Ok(Ok(service)) => service,
            Ok(Err(error)) => {
                let legacy_compatible = is_legacy_compatible_discovery_error(&error);
                return Err(ModernStartupError {
                    message: format!(
                        "MCP server '{}' rejected strict modern discovery: {error}",
                        config.server_name
                    ),
                    legacy_compatible,
                });
            }
            Err(_) => {
                return Err(ModernStartupError {
                    message: format!(
                        "MCP server '{}' timed out during strict modern discovery after {startup_timeout:?}.",
                        config.server_name
                    ),
                    // A disposable sibling timing out is legacy-compatible;
                    // strict mode still surfaces this same error without fallback.
                    legacy_compatible: true,
                });
            }
        };

        // Observed state belongs to Macro's runtime. Avoid rmcp's implicit
        // stale-on-error response cache until Lot H installs the scoped cache.
        service
            .peer()
            .set_response_cache_config(ClientCacheConfig::disabled())
            .await;

        let peer_info = service
            .peer()
            .peer_info()
            .ok_or_else(|| ModernStartupError {
                message: format!(
                    "MCP server '{}' completed discovery without peer metadata.",
                    config.server_name
                ),
                legacy_compatible: false,
            })?;
        if peer_info.protocol_version != ProtocolVersion::V_2026_07_28 {
            let negotiated = peer_info.protocol_version.as_str().to_owned();
            let mut service = service;
            let _ = service.close_with_timeout(SERVICE_CLOSE_BUDGET).await;
            return Err(ModernStartupError {
                message: format!(
                    "MCP server '{}' negotiated '{negotiated}' in strict modern mode; expected '{MODERN_PROTOCOL_VERSION}'.",
                    config.server_name
                ),
                legacy_compatible: false,
            });
        }

        let metadata = McpModernServerMetadata {
            negotiated_protocol_version: peer_info.protocol_version.as_str().to_owned(),
            capabilities: serde_json::to_value(&peer_info.capabilities).unwrap_or(Value::Null),
            server_info: peer_info
                .server_info
                .as_ref()
                .and_then(|value| serde_json::to_value(value).ok()),
            instructions: peer_info.instructions.clone(),
            meta: peer_info
                .meta
                .as_ref()
                .and_then(|value| serde_json::to_value(value).ok()),
        };

        Ok(Self {
            service,
            server_id: config.server_id.clone(),
            server_name: config.server_name.clone(),
            metadata,
            operation_timeout: config
                .operation_timeout
                .unwrap_or(DEFAULT_OPERATION_TIMEOUT),
        })
    }

    pub(crate) fn server_metadata(&self) -> &McpModernServerMetadata {
        &self.metadata
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.service.is_closed() || self.service.peer().is_transport_closed()
    }

    /// Fetches one page so the runtime manager can enforce page-count and
    /// cumulative catalog-size budgets without trusting the remote peer.
    pub(crate) async fn list_tools_page(
        &self,
        cursor: Option<String>,
    ) -> CommandResult<McpToolPageDto> {
        let params = PaginatedRequestParams::default().with_cursor(cursor);
        let result = self
            .run_bounded("tools/list", self.service.list_tools(Some(params)))
            .await?;

        let tools = result
            .tools
            .iter()
            .map(|tool| McpToolDto {
                id: build_mcp_tool_id(&self.server_id, tool.name.as_ref()),
                server_id: self.server_id.clone(),
                name: tool.name.to_string(),
                description: tool.description.as_ref().map(ToString::to_string),
                input_schema: Value::Object((*tool.input_schema).clone()),
                enabled: true,
            })
            .collect();

        Ok(McpToolPageDto {
            tools,
            next_cursor: result.next_cursor,
        })
    }

    /// Sends exactly one modern tool round. MRTR continuation is intentionally
    /// left to Macro's interaction broker so `requestState` remains opaque.
    pub(crate) async fn call_tool(
        &self,
        tool_name: &str,
        arguments: Value,
    ) -> CommandResult<McpModernToolCallOutcome> {
        let arguments = match arguments {
            Value::Null => None,
            Value::Object(map) => Some(map),
            other => {
                return Err(command_error(format!(
                    "MCP tool arguments must be a JSON object, got {other}"
                )));
            }
        };
        let mut params = CallToolRequestParams::new(tool_name.to_owned());
        params.arguments = arguments;

        let response = self
            .run_bounded("tools/call", self.service.call_tool_once(params))
            .await?;
        match response {
            CallToolResponse::Complete(result) => {
                let raw_result = serde_json::to_value(&result).unwrap_or(Value::Null);
                Ok(McpModernToolCallOutcome::Complete(McpCallToolResponse {
                    content: format_tool_call_result(&raw_result),
                    is_error: result.is_error.unwrap_or(false),
                    raw_result,
                }))
            }
            CallToolResponse::InputRequired(result) => {
                Ok(McpModernToolCallOutcome::InputRequired {
                    raw_result: serde_json::to_value(result).unwrap_or(Value::Null),
                })
            }
            CallToolResponse::Task(result) => Ok(McpModernToolCallOutcome::Task {
                raw_result: serde_json::to_value(result).unwrap_or(Value::Null),
            }),
            _ => Err(command_error(format!(
                "MCP server '{}' returned an unexpected tools/call response kind.",
                self.server_name
            ))),
        }
    }

    pub(crate) async fn shutdown(self) {
        let Self {
            service: mut owned_service,
            server_name,
            ..
        } = self;
        match owned_service.close_with_timeout(SERVICE_CLOSE_BUDGET).await {
            Ok(Some(_)) => {}
            Ok(None) => tracing::warn!(
                server = %server_name,
                "modern MCP service cleanup exceeded its close budget; containment remains active"
            ),
            Err(error) => tracing::warn!(
                server = %server_name,
                error = %error,
                "modern MCP service task failed during shutdown"
            ),
        }
    }

    async fn run_bounded<T>(
        &self,
        label: &'static str,
        operation: impl Future<Output = Result<T, ServiceError>>,
    ) -> CommandResult<T> {
        match tokio::time::timeout(self.operation_timeout, operation).await {
            Ok(result) => {
                result.map_err(|error| map_service_error(&self.server_name, label, error))
            }
            Err(_) => Err(command_error(format!(
                "MCP server '{}' timed out during {label} after {:?}.",
                self.server_name, self.operation_timeout
            ))),
        }
    }
}

fn is_legacy_compatible_discovery_error(error: &ClientInitializeError) -> bool {
    match error {
        ClientInitializeError::JsonRpcError(data) => !matches!(
            data.code,
            rmcp::model::ErrorCode::MISSING_REQUIRED_CLIENT_CAPABILITY
                | rmcp::model::ErrorCode::HEADER_MISMATCH
                | rmcp::model::ErrorCode::UNSUPPORTED_PROTOCOL_VERSION
        ),
        ClientInitializeError::ConnectionClosed(_)
        | ClientInitializeError::ExpectedInitResponse(_)
        | ClientInitializeError::ExpectedInitResult(_)
        | ClientInitializeError::TransportError { .. } => true,
        ClientInitializeError::NoCompatibleProtocolVersion { .. }
        | ClientInitializeError::NoPreferredProtocolVersion
        | ClientInitializeError::UncorrelatedErrorResponse { .. }
        | ClientInitializeError::Cancelled
        | ClientInitializeError::LegacyFallbackFailed { .. }
        | ClientInitializeError::ConflictInitResponseId(_, _) => false,
        _ => false,
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::model::{
        ClientJsonRpcMessage, ClientRequest, DiscoverResult, ErrorCode, ErrorData, GetMeta,
        ServerCapabilities, ServerJsonRpcMessage, ServerResult,
    };
    use rmcp::transport::Transport;

    fn config() -> RmcpStdioServerConfig {
        RmcpStdioServerConfig {
            server_id: "modern_server".to_owned(),
            server_name: "Modern server".to_owned(),
            command: "unused-in-duplex-tests".to_owned(),
            args: vec![],
            env: Default::default(),
            startup_timeout: Some(Duration::from_secs(2)),
            operation_timeout: Some(Duration::from_secs(2)),
        }
    }

    #[test]
    fn strict_modern_lifecycle_has_no_legacy_fallback() {
        assert_eq!(
            RmcpModernStdioClient::lifecycle(),
            ClientLifecycleMode::Discover {
                preferred_versions: vec![ProtocolVersion::V_2026_07_28],
            }
        );
    }

    #[test]
    fn modern_client_context_is_closed_by_default() {
        let info = ModernClientHandler::new().get_info();
        assert_eq!(info.protocol_version, ProtocolVersion::V_2026_07_28);
        assert_eq!(info.client_info.name, "Macro");
        assert_eq!(
            serde_json::to_value(info.capabilities).unwrap(),
            serde_json::json!({})
        );
    }

    #[test]
    fn classifies_only_safe_discovery_errors_as_legacy_compatible() {
        let method_not_found = ClientInitializeError::JsonRpcError(ErrorData::new(
            ErrorCode::METHOD_NOT_FOUND,
            "method not found",
            None,
        ));
        let missing_capability = ClientInitializeError::JsonRpcError(ErrorData::new(
            ErrorCode::MISSING_REQUIRED_CLIENT_CAPABILITY,
            "missing capability",
            None,
        ));
        let unsupported_version = ClientInitializeError::JsonRpcError(ErrorData::new(
            ErrorCode::UNSUPPORTED_PROTOCOL_VERSION,
            "unsupported version",
            None,
        ));

        assert!(is_legacy_compatible_discovery_error(&method_not_found));
        assert!(!is_legacy_compatible_discovery_error(&missing_capability));
        assert!(!is_legacy_compatible_discovery_error(&unsupported_version));
    }

    #[tokio::test]
    async fn discover_starts_without_initialize_and_retains_modern_metadata() {
        let (server_io, client_io) = tokio::io::duplex(16 * 1024);
        let mut server = IntoTransport::<rmcp::RoleServer, _, _>::into_transport(server_io);
        let server_task = tokio::spawn(async move {
            let ClientJsonRpcMessage::Request(request) =
                server.receive().await.expect("expected discovery request")
            else {
                panic!("expected request")
            };
            assert!(matches!(request.request, ClientRequest::DiscoverRequest(_)));
            assert!(!matches!(
                request.request,
                ClientRequest::InitializeRequest(_)
            ));
            let request_meta = request.request.get_meta();
            assert_eq!(
                request_meta.protocol_version(),
                Some(ProtocolVersion::V_2026_07_28)
            );
            assert_eq!(
                request_meta.client_info().map(|info| info.name),
                Some("Macro".to_owned())
            );
            assert!(request_meta.client_capabilities().is_some());

            let mut result = DiscoverResult::new(
                vec![ProtocolVersion::V_2026_07_28],
                ServerCapabilities::builder().enable_tools().build(),
            )
            .with_server_info(Implementation::new("modern-fixture", "1.0.0"));
            result.instructions = Some("Use modern requests".to_owned());
            server
                .send(ServerJsonRpcMessage::response(
                    ServerResult::DiscoverResult(result),
                    request.id,
                ))
                .await
                .expect("send discovery response");
        });

        let client = RmcpModernStdioClient::connect_transport(&config(), client_io)
            .await
            .expect("strict modern discovery should succeed");
        assert_eq!(
            client.server_metadata().negotiated_protocol_version,
            MODERN_PROTOCOL_VERSION
        );
        assert_eq!(
            client
                .server_metadata()
                .server_info
                .as_ref()
                .and_then(|info| info.get("name"))
                .and_then(Value::as_str),
            Some("modern-fixture")
        );
        assert_eq!(
            client.server_metadata().instructions.as_deref(),
            Some("Use modern requests")
        );
        client.shutdown().await;
        server_task.await.expect("server task");
    }

    #[tokio::test]
    async fn strict_modern_rejection_never_falls_back_to_initialize() {
        let (server_io, client_io) = tokio::io::duplex(16 * 1024);
        let mut server = IntoTransport::<rmcp::RoleServer, _, _>::into_transport(server_io);
        let server_task = tokio::spawn(async move {
            let ClientJsonRpcMessage::Request(discover) =
                server.receive().await.expect("expected discovery request")
            else {
                panic!("expected request")
            };
            assert!(matches!(
                discover.request,
                ClientRequest::DiscoverRequest(_)
            ));
            server
                .send(ServerJsonRpcMessage::error(
                    ErrorData::new(ErrorCode::METHOD_NOT_FOUND, "method not found", None),
                    Some(discover.id),
                ))
                .await
                .expect("send discovery rejection");

            let follow_up =
                tokio::time::timeout(Duration::from_millis(100), server.receive()).await;
            assert!(
                !matches!(
                    follow_up,
                    Ok(Some(ClientJsonRpcMessage::Request(request)))
                        if matches!(request.request, ClientRequest::InitializeRequest(_))
                ),
                "strict modern mode must never send initialize"
            );
        });

        let error = match RmcpModernStdioClient::connect_transport(&config(), client_io).await {
            Ok(client) => {
                client.shutdown().await;
                panic!("method-not-found must fail strict modern discovery")
            }
            Err(error) => error,
        };
        assert!(error.message.contains("rejected strict modern discovery"));
        server_task.await.expect("server task");
    }

    #[tokio::test]
    async fn paginated_list_and_tool_call_carry_modern_request_metadata() {
        let (server_io, client_io) = tokio::io::duplex(64 * 1024);
        let mut server = IntoTransport::<rmcp::RoleServer, _, _>::into_transport(server_io);
        let server_task = tokio::spawn(async move {
            for step in 0..4 {
                let ClientJsonRpcMessage::Request(request) =
                    server.receive().await.expect("expected client request")
                else {
                    panic!("expected request")
                };
                let meta = request.request.get_meta();
                assert_eq!(meta.protocol_version(), Some(ProtocolVersion::V_2026_07_28));
                assert!(meta.client_info().is_some());
                assert!(meta.client_capabilities().is_some());

                let result = match step {
                    0 => {
                        assert!(matches!(request.request, ClientRequest::DiscoverRequest(_)));
                        ServerResult::DiscoverResult(DiscoverResult::new(
                            vec![ProtocolVersion::V_2026_07_28],
                            ServerCapabilities::builder().enable_tools().build(),
                        ))
                    }
                    1 => {
                        assert!(matches!(
                            request.request,
                            ClientRequest::ListToolsRequest(_)
                        ));
                        ServerResult::ListToolsResult(
                            serde_json::from_value(serde_json::json!({
                                "resultType": "complete",
                                "tools": [{
                                    "name": "first",
                                    "description": "first page",
                                    "inputSchema": {"type": "object"}
                                }],
                                "nextCursor": "page-2",
                                "ttlMs": 0,
                                "cacheScope": "private"
                            }))
                            .expect("valid first tool page"),
                        )
                    }
                    2 => {
                        let ClientRequest::ListToolsRequest(list) = &request.request else {
                            panic!("expected second tool page")
                        };
                        assert_eq!(
                            list.params
                                .as_ref()
                                .and_then(|params| params.cursor.as_deref()),
                            Some("page-2")
                        );
                        ServerResult::ListToolsResult(
                            serde_json::from_value(serde_json::json!({
                                "resultType": "complete",
                                "tools": [{
                                    "name": "second",
                                    "inputSchema": {"type": "object"}
                                }],
                                "ttlMs": 0,
                                "cacheScope": "private"
                            }))
                            .expect("valid second tool page"),
                        )
                    }
                    _ => {
                        assert!(matches!(request.request, ClientRequest::CallToolRequest(_)));
                        ServerResult::CallToolResult(
                            serde_json::from_value(serde_json::json!({
                                "resultType": "complete",
                                "content": [{"type": "text", "text": "done"}],
                                "isError": false
                            }))
                            .expect("valid tool result"),
                        )
                    }
                };
                server
                    .send(ServerJsonRpcMessage::response(result, request.id))
                    .await
                    .expect("send server response");
            }
        });

        let client = RmcpModernStdioClient::connect_transport(&config(), client_io)
            .await
            .expect("connect modern client");
        let first = client.list_tools_page(None).await.expect("first page");
        assert_eq!(first.tools[0].name, "first");
        assert_eq!(first.next_cursor.as_deref(), Some("page-2"));
        let second = client
            .list_tools_page(first.next_cursor)
            .await
            .expect("second page");
        assert_eq!(second.tools[0].name, "second");
        assert!(second.next_cursor.is_none());
        let call = client
            .call_tool("second", serde_json::json!({}))
            .await
            .expect("tool call");
        let McpModernToolCallOutcome::Complete(call) = call else {
            panic!("expected completed tool call")
        };
        assert!(!call.is_error);
        assert!(call.content.contains("done"));

        client.shutdown().await;
        server_task.await.expect("server task");
    }
}
