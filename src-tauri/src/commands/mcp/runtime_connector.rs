use super::modern_adapter::{
    McpModernProbeOutcome, McpModernToolCallOutcome, RmcpModernStdioClient,
};
use super::rmcp_adapter::{RmcpLegacyStdioClient, RmcpStdioServerConfig};
use super::runtime::{
    McpAuthorityGuard, McpConnectedSession, McpConnectionRequest, McpConnector, McpFuture,
    McpOperationCancellation, McpRuntimeError, McpSession,
};
use super::stdio::resolve_stdio_transport;
use super::streamable_http::{
    probe_modern_era, user_header_map, validate_endpoint, GuardedStreamableHttpClient,
    HttpEraProbeOutcome, RmcpLegacyHttpClient, RmcpModernHttpClient, ValidatedEndpoint,
};
use super::types::{
    McpCallToolResponse, McpProtocolEra, McpProtocolMode, McpRuntimeKey, McpRuntimeSelector,
    McpServerDto, McpToolDto, McpTransportDto,
};
use crate::config::{
    self, ConfigDocumentKind, McpProtocolMode as ConfigProtocolMode, McpServerDefinition,
    McpTransport,
};
use crate::secrets;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use url::Url;

use super::ids::{build_mcp_env_secret_id, parse_mcp_env_secret_ref};

const MAX_TOOLS_LIST_PAGES: usize = 100;
const MAX_TOOLS_CATALOG_BYTES: usize = 16 * 1024 * 1024;
const MIN_STARTUP_TIMEOUT_MS: u32 = 1_000;
const MAX_STARTUP_TIMEOUT_MS: u32 = 300_000;
const MIN_OPERATION_TIMEOUT_MS: u32 = 1_000;
const MAX_OPERATION_TIMEOUT_MS: u32 = 600_000;
const MIN_PROBE_TIMEOUT_MS: u32 = 500;
const MAX_PROBE_TIMEOUT_MS: u32 = 15_000;

#[derive(Default)]
pub(crate) struct ConfiguredMcpConnector;

impl McpConnector for ConfiguredMcpConnector {
    fn acquire_authority<'a>(&'a self) -> McpFuture<'a, Option<McpAuthorityGuard>> {
        Box::pin(async move {
            let manager = config::runtime_config_manager().ok_or_else(|| {
                runtime_error(
                    "MCP_RUNTIME_CONFIG_UNAVAILABLE",
                    "The Macro configuration manager is unavailable.",
                )
            })?;
            let guard = manager.lock_mcp_runtime_configuration().await;
            Ok(Some(Box::new(guard) as McpAuthorityGuard))
        })
    }

    fn config_fingerprint<'a>(&'a self, selector: &'a McpRuntimeSelector) -> McpFuture<'a, String> {
        Box::pin(async move {
            let key = McpRuntimeKey {
                server_id: selector.server_id.clone(),
                project_id: None,
                project_ids: selector.project_ids.clone(),
                config_generation: 0,
            };
            let definition = resolve_server_definition(&key).await?;
            match &definition.transport {
                McpTransport::StreamableHttp { .. } => {
                    // Fingerprints stay DNS-free: they cover the normalized
                    // URL, its origin and hashed resolved header values.
                    let input = http_transport_fingerprint_input(&key.server_id, &definition)?;
                    Ok(http_config_fingerprint(&definition, &input))
                }
                _ => {
                    let server = definition_to_dto(&key.server_id, &definition);
                    let (command, args, env) =
                        resolve_stdio_transport(&server).map_err(|error| {
                            runtime_error("MCP_RUNTIME_CONFIG_INVALID", error.message)
                        })?;
                    stdio_config_fingerprint(&definition, &command, &args, &env)
                }
            }
        })
    }

    fn connect<'a>(
        &'a self,
        request: &'a McpConnectionRequest,
    ) -> McpFuture<'a, McpConnectedSession> {
        Box::pin(async move {
            let definition = resolve_server_definition(&request.key).await?;
            if definition.enabled != Some(true) {
                return Err(runtime_error(
                    "MCP_RUNTIME_SERVER_DISABLED",
                    format!("MCP server '{}' is disabled.", request.key.server_id),
                ));
            }

            // Imported configurations predate the protocol field and must stay
            // legacy. Once a protocol object exists, an omitted mode means auto.
            let requested_mode = definition
                .protocol
                .as_ref()
                .map(|protocol| protocol.mode.unwrap_or(ConfigProtocolMode::Auto))
                .unwrap_or(ConfigProtocolMode::Legacy);

            let startup_timeout = validated_timeout(
                "startupTimeoutMs",
                definition.startup_timeout_ms,
                MIN_STARTUP_TIMEOUT_MS,
                MAX_STARTUP_TIMEOUT_MS,
            )?;
            let operation_timeout = validated_timeout(
                "operationTimeoutMs",
                definition.operation_timeout_ms,
                MIN_OPERATION_TIMEOUT_MS,
                MAX_OPERATION_TIMEOUT_MS,
            )?;
            let disabled_tools = definition.disabled_tools.clone().unwrap_or_default();

            let (session, negotiated_era, negotiated_protocol_version, decision_reason) =
                match &definition.transport {
                    McpTransport::StreamableHttp { .. } => {
                        let transport =
                            resolve_http_transport(&request.key.server_id, &definition).await?;
                        let actual_fingerprint =
                            http_config_fingerprint(&definition, &transport.fingerprint_input());
                        if actual_fingerprint != request.config_fingerprint {
                            return Err(runtime_error(
                                "MCP_RUNTIME_CONFIG_CHANGED",
                                format!(
                                    "MCP server '{}' changed while its connection was being prepared; retry the connection.",
                                    request.key.server_id
                                ),
                            ));
                        }
                        connect_http_transport(
                            request,
                            &definition,
                            transport,
                            requested_mode,
                            startup_timeout,
                            operation_timeout,
                            disabled_tools,
                        )
                        .await?
                    }
                    _ => {
                        let server = definition_to_dto(&request.key.server_id, &definition);
                        let (command, args, env) =
                            resolve_stdio_transport(&server).map_err(|error| {
                                runtime_error("MCP_RUNTIME_CONFIG_INVALID", error.message)
                            })?;
                        let actual_fingerprint =
                            stdio_config_fingerprint(&definition, &command, &args, &env)?;
                        if actual_fingerprint != request.config_fingerprint {
                            return Err(runtime_error(
                                "MCP_RUNTIME_CONFIG_CHANGED",
                                format!(
                                    "MCP server '{}' changed while its connection was being prepared; retry the connection.",
                                    request.key.server_id
                                ),
                            ));
                        }
                        let base_config = RmcpStdioServerConfig {
                            server_id: request.key.server_id.clone(),
                            server_name: server.name,
                            command,
                            args,
                            env,
                            startup_timeout,
                            operation_timeout,
                        };
                        connect_stdio_transport(
                            &base_config,
                            requested_mode,
                            &definition,
                            disabled_tools,
                        )
                        .await?
                    }
                };

            Ok(McpConnectedSession {
                session,
                requested_protocol_mode: Some(map_protocol_mode(requested_mode)),
                negotiated_era: Some(negotiated_era),
                negotiated_protocol_version: Some(negotiated_protocol_version),
                protocol_decision_reason: Some(decision_reason),
                max_concurrent_operations: definition
                    .max_concurrent_operations
                    .unwrap_or(1)
                    .clamp(1, 16) as usize,
            })
        })
    }
}

/// Resolves one remote header value, accepting server-scoped secret
/// references (`macro-secret://mcp-env/<server>/<KEY>`) that the previous
/// build refused outright (plan Lot E).
fn resolve_remote_header_value(
    server_id: &str,
    name: &str,
    value: &str,
) -> Result<String, McpRuntimeError> {
    if let Some((secret_server_id, secret_key)) = parse_mcp_env_secret_ref(value) {
        if secret_server_id != server_id || !secret_key.eq_ignore_ascii_case(name.trim()) {
            return Err(runtime_error(
                "MCP_RUNTIME_CONFIG_INVALID",
                format!(
                    "MCP header '{name}' must reference a secret scoped to the same server and header name."
                ),
            ));
        }
        let secret_id = build_mcp_env_secret_id(secret_server_id, secret_key);
        let secret = secrets::get_api_key(&secret_id).map_err(|error| {
            runtime_error(
                "MCP_RUNTIME_SECRETS_UNAVAILABLE",
                format!("Failed to read MCP header secret '{secret_id}': {error}"),
            )
        })?;
        secret.ok_or_else(|| {
            runtime_error(
                "MCP_RUNTIME_CONFIG_INVALID",
                format!("MCP header secret '{secret_id}' is missing."),
            )
        })
    } else if value.starts_with("macro-secret://") {
        Err(runtime_error(
            "MCP_RUNTIME_CONFIG_INVALID",
            format!("MCP header reference for '{name}' is malformed."),
        ))
    } else {
        Ok(value.to_string())
    }
}

/// Fully resolved Streamable HTTP transport: validated endpoint (URL policy,
/// DNS pinning) plus user headers with every secret reference resolved.
struct ResolvedHttpTransport {
    endpoint: ValidatedEndpoint,
    resolved_headers: BTreeMap<String, String>,
    client: GuardedStreamableHttpClient,
}

impl ResolvedHttpTransport {
    fn fingerprint_input(&self) -> HttpFingerprintInput {
        HttpFingerprintInput {
            url: self.endpoint.url.as_str().to_owned(),
            origin: self.endpoint.origin_ascii(),
            headers: self.resolved_headers.clone(),
        }
    }
}

struct HttpFingerprintInput {
    url: String,
    origin: String,
    headers: BTreeMap<String, String>,
}

/// DNS-free identity input for the HTTP transport: normalized URL, ASCII
/// origin and every header value with secret references resolved.
fn http_transport_fingerprint_input(
    server_id: &str,
    definition: &McpServerDefinition,
) -> Result<HttpFingerprintInput, McpRuntimeError> {
    let McpTransport::StreamableHttp { url, headers } = &definition.transport else {
        return Err(runtime_error(
            "MCP_RUNTIME_CONFIG_INVALID",
            "The MCP server transport is not streamable HTTP.",
        ));
    };
    let parsed = Url::parse(url.trim()).map_err(|error| {
        runtime_error(
            "MCP_RUNTIME_CONFIG_INVALID",
            format!("MCP endpoint URL is invalid: {error}"),
        )
    })?;
    let mut normalized = parsed.clone();
    normalized.set_fragment(None);
    let mut resolved_headers = BTreeMap::new();
    for (name, value) in headers {
        resolved_headers.insert(
            name.clone(),
            resolve_remote_header_value(server_id, name, value)?,
        );
    }
    Ok(HttpFingerprintInput {
        url: normalized.as_str().to_owned(),
        origin: normalized.origin().ascii_serialization(),
        headers: resolved_headers,
    })
}

async fn resolve_http_transport(
    server_id: &str,
    definition: &McpServerDefinition,
) -> Result<ResolvedHttpTransport, McpRuntimeError> {
    let McpTransport::StreamableHttp { url, headers } = &definition.transport else {
        return Err(runtime_error(
            "MCP_RUNTIME_CONFIG_INVALID",
            "The MCP server transport is not streamable HTTP.",
        ));
    };
    let endpoint = validate_endpoint(url)
        .await
        .map_err(|error| runtime_error("MCP_RUNTIME_CONFIG_INVALID", error.message))?;
    let mut resolved_headers = BTreeMap::new();
    for (name, value) in headers {
        resolved_headers.insert(
            name.clone(),
            resolve_remote_header_value(server_id, name, value)?,
        );
    }
    let user_headers = user_header_map(&resolved_headers)
        .map_err(|error| runtime_error("MCP_RUNTIME_CONFIG_INVALID", error.message))?;
    let client = GuardedStreamableHttpClient::new(endpoint.clone(), user_headers, None)
        .map_err(|error| runtime_error("MCP_RUNTIME_CONNECT_FAILED", error.message))?;
    Ok(ResolvedHttpTransport {
        endpoint,
        resolved_headers,
        client,
    })
}

/// Hashes the definition, normalized URL, origin and resolved header values.
/// Values are individually hashed so fingerprints never contain secrets
/// (plan §6.2) and any rotation invalidates the runtime identity.
fn http_config_fingerprint(
    definition: &McpServerDefinition,
    input: &HttpFingerprintInput,
) -> String {
    let mut hashed_headers = BTreeMap::new();
    for (name, value) in &input.headers {
        hashed_headers.insert(name.clone(), format!("sha256:{:x}", Sha256::digest(value)));
    }
    let payload = json!({
        "definition": definition_without_transport(definition),
        "transport": {
            "kind": "streamable_http",
            "url": input.url,
            "origin": input.origin,
            "headers": hashed_headers,
        },
    });
    let bytes = serde_json::to_vec(&payload).unwrap_or_else(|_| payload.to_string().into_bytes());
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn definition_without_transport(definition: &McpServerDefinition) -> serde_json::Value {
    let mut value = serde_json::to_value(definition).unwrap_or(Value::Null);
    if let Value::Object(fields) = &mut value {
        fields.remove("transport");
    }
    value
}

#[expect(
    clippy::too_many_lines,
    reason = "one branch per requested protocol mode keeps the decision table readable"
)]
async fn connect_http_transport(
    request: &McpConnectionRequest,
    definition: &McpServerDefinition,
    transport: ResolvedHttpTransport,
    requested_mode: ConfigProtocolMode,
    startup_timeout: Option<Duration>,
    operation_timeout: Option<Duration>,
    disabled_tools: Vec<String>,
) -> Result<(Arc<dyn McpSession>, McpProtocolEra, String, String), McpRuntimeError> {
    let server_name = definition
        .name
        .clone()
        .unwrap_or_else(|| request.key.server_id.clone());
    let server_id = request.key.server_id.clone();
    match requested_mode {
        ConfigProtocolMode::Legacy => {
            let (session, era, version) = connect_legacy_http(
                transport.client,
                server_id,
                server_name,
                startup_timeout,
                operation_timeout,
                disabled_tools,
            )
            .await?;
            Ok((
                session,
                era,
                version,
                "Strict legacy mode was configured.".to_string(),
            ))
        }
        ConfigProtocolMode::Modern => {
            let (session, era, version) = connect_modern_http(
                transport.client,
                server_id,
                server_name,
                startup_timeout,
                operation_timeout,
                disabled_tools,
            )
            .await?;
            Ok((
                session,
                era,
                version,
                "Strict modern mode was configured.".to_string(),
            ))
        }
        ConfigProtocolMode::Auto => {
            let probe_timeout = validated_timeout(
                "protocol.probeTimeoutMs",
                definition
                    .protocol
                    .as_ref()
                    .and_then(|protocol| protocol.probe_timeout_ms),
                MIN_PROBE_TIMEOUT_MS,
                MAX_PROBE_TIMEOUT_MS,
            )?
            .unwrap_or(Duration::from_secs(5));
            match probe_modern_era(&transport.client, probe_timeout).await {
                Ok(HttpEraProbeOutcome::Modern) => {
                    let (session, era, version) = connect_modern_http(
                        transport.client,
                        server_id,
                        server_name,
                        startup_timeout,
                        operation_timeout,
                        disabled_tools,
                    )
                    .await?;
                    Ok((
                        session,
                        era,
                        version,
                        "The streamable HTTP probe completed server/discover.".to_string(),
                    ))
                }
                Ok(HttpEraProbeOutcome::LegacySafe { reason }) => {
                    let decision_reason =
                        format!("The streamable HTTP probe showed legacy compatibility: {reason}");
                    let (session, era, version) = connect_legacy_http(
                        transport.client,
                        server_id,
                        server_name,
                        startup_timeout,
                        operation_timeout,
                        disabled_tools,
                    )
                    .await?;
                    Ok((session, era, version, decision_reason))
                }
                Err(failure) => Err(runtime_error(
                    "MCP_RUNTIME_PROTOCOL_PROBE_FAILED",
                    format!(
                        "MCP modern probe failed without safe legacy fallback: {}",
                        failure.reason
                    ),
                )),
            }
        }
    }
}

async fn connect_legacy_http(
    client: GuardedStreamableHttpClient,
    server_id: String,
    server_name: String,
    startup_timeout: Option<Duration>,
    operation_timeout: Option<Duration>,
    disabled_tools: Vec<String>,
) -> Result<(Arc<dyn McpSession>, McpProtocolEra, String), McpRuntimeError> {
    let http_client = RmcpLegacyHttpClient::connect(
        client,
        server_id.clone(),
        server_name,
        startup_timeout,
        operation_timeout,
    )
    .await
    .map_err(|error| runtime_error("MCP_RUNTIME_CONNECT_FAILED", error.message))?;
    let version = http_client.negotiated_protocol_version().to_string();
    Ok((
        Arc::new(LegacyHttpSession {
            client: Mutex::new(Some(Arc::new(http_client))),
            disabled_tools,
        }),
        McpProtocolEra::Legacy,
        version,
    ))
}

async fn connect_modern_http(
    client: GuardedStreamableHttpClient,
    server_id: String,
    server_name: String,
    startup_timeout: Option<Duration>,
    operation_timeout: Option<Duration>,
    disabled_tools: Vec<String>,
) -> Result<(Arc<dyn McpSession>, McpProtocolEra, String), McpRuntimeError> {
    let http_client = RmcpModernHttpClient::connect(
        client,
        server_id.clone(),
        server_name,
        startup_timeout,
        operation_timeout,
    )
    .await
    .map_err(|error| runtime_error("MCP_RUNTIME_CONNECT_FAILED", error.message))?;
    let version = http_client
        .server_metadata()
        .negotiated_protocol_version
        .clone();
    Ok((
        Arc::new(ModernHttpSession {
            client: Mutex::new(Some(Arc::new(http_client))),
            disabled_tools,
        }),
        McpProtocolEra::Modern,
        version,
    ))
}

struct ModernHttpSession {
    client: Mutex<Option<Arc<RmcpModernHttpClient>>>,
    disabled_tools: Vec<String>,
}

impl ModernHttpSession {
    fn client(&self) -> Result<Arc<RmcpModernHttpClient>, McpRuntimeError> {
        self.client
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .ok_or_else(|| {
                runtime_error(
                    "MCP_RUNTIME_NOT_CONNECTED",
                    "The MCP session is already closed.",
                )
            })
    }

    fn tool_disabled(&self, tool_name: &str) -> bool {
        self.disabled_tools.iter().any(|name| name == tool_name)
    }
}

impl McpSession for ModernHttpSession {
    fn is_closed(&self) -> bool {
        self.client()
            .map(|client| client.is_closed())
            .unwrap_or(true)
    }

    fn list_tools<'a>(
        &'a self,
        _cancellation: Arc<McpOperationCancellation>,
    ) -> McpFuture<'a, Vec<McpToolDto>> {
        Box::pin(async move {
            paginate_tools(
                |cursor| {
                    let client = self.client()?;
                    Ok(async move { client.list_tools_page(cursor).await })
                },
                &self.disabled_tools,
            )
            .await
        })
    }

    fn call_tool<'a>(
        &'a self,
        tool_name: &'a str,
        arguments: Value,
        _cancellation: Arc<McpOperationCancellation>,
    ) -> McpFuture<'a, McpCallToolResponse> {
        Box::pin(async move {
            if self.tool_disabled(tool_name) {
                return Err(runtime_error(
                    "MCP_RUNTIME_TOOL_DISABLED",
                    format!("MCP tool '{tool_name}' is disabled."),
                ));
            }
            self.client()?
                .call_tool_complete(tool_name, arguments)
                .await
                .map_err(|error| runtime_error("MCP_RUNTIME_CALL_TOOL_FAILED", error.message))
        })
    }

    fn close<'a>(&'a self) -> McpFuture<'a, ()> {
        Box::pin(async move {
            let client = self
                .client
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            let Some(mut client) = client else {
                return Ok(());
            };
            for _ in 0..100 {
                match Arc::try_unwrap(client) {
                    Ok(client) => {
                        client.shutdown().await;
                        return Ok(());
                    }
                    Err(shared) => {
                        client = shared;
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                }
            }
            drop(client);
            Err(runtime_error(
                "MCP_RUNTIME_CLOSE_TIMEOUT",
                "MCP operations did not release the modern HTTP session before shutdown.",
            ))
        })
    }
}

struct LegacyHttpSession {
    client: Mutex<Option<Arc<RmcpLegacyHttpClient>>>,
    disabled_tools: Vec<String>,
}

impl LegacyHttpSession {
    fn client(&self) -> Result<Arc<RmcpLegacyHttpClient>, McpRuntimeError> {
        self.client
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .ok_or_else(|| {
                runtime_error(
                    "MCP_RUNTIME_NOT_CONNECTED",
                    "The MCP session is already closed.",
                )
            })
    }
}

impl McpSession for LegacyHttpSession {
    fn is_closed(&self) -> bool {
        self.client()
            .map(|client| client.is_closed())
            .unwrap_or(true)
    }

    fn list_tools<'a>(
        &'a self,
        _cancellation: Arc<McpOperationCancellation>,
    ) -> McpFuture<'a, Vec<McpToolDto>> {
        Box::pin(async move {
            paginate_tools(
                |cursor| {
                    let client = self.client()?;
                    Ok(async move { client.list_tools_page(cursor).await })
                },
                &self.disabled_tools,
            )
            .await
        })
    }

    fn call_tool<'a>(
        &'a self,
        tool_name: &'a str,
        arguments: Value,
        _cancellation: Arc<McpOperationCancellation>,
    ) -> McpFuture<'a, McpCallToolResponse> {
        Box::pin(async move {
            if self.disabled_tools.iter().any(|name| name == tool_name) {
                return Err(runtime_error(
                    "MCP_RUNTIME_TOOL_DISABLED",
                    format!("MCP tool '{tool_name}' is disabled."),
                ));
            }
            self.client()?
                .call_tool(tool_name, arguments)
                .await
                .map_err(|error| runtime_error("MCP_RUNTIME_CALL_TOOL_FAILED", error.message))
        })
    }

    fn close<'a>(&'a self) -> McpFuture<'a, ()> {
        Box::pin(async move {
            let client = self
                .client
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            let Some(mut client) = client else {
                return Ok(());
            };
            for _ in 0..100 {
                match Arc::try_unwrap(client) {
                    Ok(client) => {
                        client.shutdown().await;
                        return Ok(());
                    }
                    Err(shared) => {
                        client = shared;
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                }
            }
            drop(client);
            Err(runtime_error(
                "MCP_RUNTIME_CLOSE_TIMEOUT",
                "MCP operations did not release the legacy HTTP session before shutdown.",
            ))
        })
    }
}

/// Shared pagination loop: page count and cumulative catalog budgets apply to
/// every transport identically.
async fn paginate_tools<F, Fut>(
    mut page: F,
    disabled_tools: &[String],
) -> Result<Vec<McpToolDto>, McpRuntimeError>
where
    F: FnMut(Option<String>) -> Result<Fut, McpRuntimeError>,
    Fut:
        Future<Output = Result<super::rmcp_adapter::McpToolPageDto, crate::commands::CommandError>>,
{
    let mut cursor = None;
    let mut tools = Vec::new();
    let mut total_bytes = 0usize;
    for _ in 0..MAX_TOOLS_LIST_PAGES {
        let fetched = page(cursor)?
            .await
            .map_err(|error| runtime_error("MCP_RUNTIME_LIST_TOOLS_FAILED", error.message))?;
        total_bytes = add_page_budget(total_bytes, &fetched.tools)?;
        tools.extend(fetched.tools.into_iter().map(|mut tool| {
            if disabled_tools.iter().any(|name| name == &tool.name) {
                tool.enabled = false;
            }
            tool
        }));
        cursor = fetched.next_cursor;
        if cursor.is_none() {
            return Ok(tools);
        }
    }
    Err(runtime_error(
        "MCP_RUNTIME_CATALOG_PAGE_LIMIT",
        format!("MCP tools/list exceeded {MAX_TOOLS_LIST_PAGES} pages."),
    ))
}

async fn connect_stdio_transport(
    base_config: &RmcpStdioServerConfig,
    requested_mode: ConfigProtocolMode,
    definition: &McpServerDefinition,
    disabled_tools: Vec<String>,
) -> Result<(Arc<dyn McpSession>, McpProtocolEra, String, String), McpRuntimeError> {
    let mut disabled_tools = disabled_tools;
    match requested_mode {
        ConfigProtocolMode::Legacy => {
            let (session, era, version) =
                connect_legacy(base_config, std::mem::take(&mut disabled_tools)).await?;
            Ok((
                session,
                era,
                version,
                "Strict legacy mode was configured.".to_string(),
            ))
        }
        ConfigProtocolMode::Modern => {
            let (session, era, version) =
                connect_modern(base_config, std::mem::take(&mut disabled_tools)).await?;
            Ok((
                session,
                era,
                version,
                "Strict modern mode was configured.".to_string(),
            ))
        }
        ConfigProtocolMode::Auto => {
            let mut probe_config = base_config.clone();
            probe_config.startup_timeout = validated_timeout(
                "protocol.probeTimeoutMs",
                definition
                    .protocol
                    .as_ref()
                    .and_then(|protocol| protocol.probe_timeout_ms),
                MIN_PROBE_TIMEOUT_MS,
                MAX_PROBE_TIMEOUT_MS,
            )?
            .or(Some(Duration::from_secs(5)));
            match RmcpModernStdioClient::probe(&probe_config).await {
                Ok(McpModernProbeOutcome::Modern(probe)) => {
                    probe.shutdown().await;
                    let reason =
                        "The disposable sibling probe completed server/discover.".to_string();
                    let (session, era, version) =
                        connect_modern(base_config, disabled_tools).await?;
                    Ok((session, era, version, reason))
                }
                Ok(McpModernProbeOutcome::Legacy {
                    reason: probe_reason,
                }) => {
                    let reason = format!(
                        "The disposable sibling probe showed legacy compatibility: {probe_reason}"
                    );
                    let (session, era, version) =
                        connect_legacy(base_config, disabled_tools).await?;
                    Ok((session, era, version, reason))
                }
                Err(error) => Err(runtime_error(
                    "MCP_RUNTIME_PROTOCOL_PROBE_FAILED",
                    format!(
                        "MCP modern probe failed without safe legacy fallback: {}",
                        error.message
                    ),
                )),
            }
        }
    }
}

async fn connect_legacy(
    config: &RmcpStdioServerConfig,
    disabled_tools: Vec<String>,
) -> Result<(Arc<dyn McpSession>, McpProtocolEra, String), McpRuntimeError> {
    let client = RmcpLegacyStdioClient::connect(config)
        .await
        .map_err(|error| runtime_error("MCP_RUNTIME_CONNECT_FAILED", error.message))?;
    let version = client.negotiated_protocol_version().to_string();
    Ok((
        Arc::new(LegacyRmcpSession {
            client: Mutex::new(Some(Arc::new(client))),
            disabled_tools,
        }),
        McpProtocolEra::Legacy,
        version,
    ))
}

async fn connect_modern(
    config: &RmcpStdioServerConfig,
    disabled_tools: Vec<String>,
) -> Result<(Arc<dyn McpSession>, McpProtocolEra, String), McpRuntimeError> {
    let client = RmcpModernStdioClient::connect(config)
        .await
        .map_err(|error| runtime_error("MCP_RUNTIME_CONNECT_FAILED", error.message))?;
    let version = client.server_metadata().negotiated_protocol_version.clone();
    Ok((
        Arc::new(ModernRmcpSession {
            client: Mutex::new(Some(Arc::new(client))),
            disabled_tools,
        }),
        McpProtocolEra::Modern,
        version,
    ))
}

struct ModernRmcpSession {
    client: Mutex<Option<Arc<RmcpModernStdioClient>>>,
    disabled_tools: Vec<String>,
}

impl ModernRmcpSession {
    fn client(&self) -> Result<Arc<RmcpModernStdioClient>, McpRuntimeError> {
        self.client
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .ok_or_else(|| {
                runtime_error(
                    "MCP_RUNTIME_NOT_CONNECTED",
                    "The MCP session is already closed.",
                )
            })
    }
}

impl McpSession for ModernRmcpSession {
    fn is_closed(&self) -> bool {
        self.client()
            .map(|client| client.is_closed())
            .unwrap_or(true)
    }

    fn list_tools<'a>(
        &'a self,
        _cancellation: Arc<McpOperationCancellation>,
    ) -> McpFuture<'a, Vec<McpToolDto>> {
        Box::pin(async move {
            let client = self.client()?;
            let mut cursor = None;
            let mut tools = Vec::new();
            let mut total_bytes = 0usize;
            for _ in 0..MAX_TOOLS_LIST_PAGES {
                let page = client.list_tools_page(cursor).await.map_err(|error| {
                    runtime_error("MCP_RUNTIME_LIST_TOOLS_FAILED", error.message)
                })?;
                total_bytes = add_page_budget(total_bytes, &page.tools)?;
                tools.extend(page.tools.into_iter().map(|mut tool| {
                    if self.disabled_tools.iter().any(|name| name == &tool.name) {
                        tool.enabled = false;
                    }
                    tool
                }));
                cursor = page.next_cursor;
                if cursor.is_none() {
                    return Ok(tools);
                }
            }
            Err(runtime_error(
                "MCP_RUNTIME_CATALOG_PAGE_LIMIT",
                format!("MCP tools/list exceeded {MAX_TOOLS_LIST_PAGES} pages."),
            ))
        })
    }

    fn call_tool<'a>(
        &'a self,
        tool_name: &'a str,
        arguments: Value,
        _cancellation: Arc<McpOperationCancellation>,
    ) -> McpFuture<'a, McpCallToolResponse> {
        Box::pin(async move {
            if self.disabled_tools.iter().any(|name| name == tool_name) {
                return Err(runtime_error(
                    "MCP_RUNTIME_TOOL_DISABLED",
                    format!("MCP tool '{tool_name}' is disabled."),
                ));
            }
            match self
                .client()?
                .call_tool(tool_name, arguments)
                .await
                .map_err(|error| runtime_error("MCP_RUNTIME_CALL_TOOL_FAILED", error.message))?
            {
                McpModernToolCallOutcome::Complete(result) => Ok(result),
                McpModernToolCallOutcome::InputRequired { raw_result } => {
                    // requestState may contain sensitive opaque data; keep it
                    // out of diagnostics until the Lot G broker can retain it.
                    drop(raw_result);
                    Err(runtime_error(
                        "MCP_RUNTIME_INTERACTION_REQUIRED",
                        "The MCP tool requires an interaction round that is not connected yet.",
                    ))
                }
                McpModernToolCallOutcome::Task { raw_result } => {
                    drop(raw_result);
                    Err(runtime_error(
                        "MCP_RUNTIME_TASK_RESULT_UNSUPPORTED",
                        "The MCP tool returned a task result that is not connected yet.",
                    ))
                }
            }
        })
    }

    fn close<'a>(&'a self) -> McpFuture<'a, ()> {
        Box::pin(async move {
            let client = self
                .client
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            let Some(client) = client else {
                return Ok(());
            };
            close_modern_client(client).await
        })
    }
}

async fn close_modern_client(
    mut client: Arc<RmcpModernStdioClient>,
) -> Result<(), McpRuntimeError> {
    for _ in 0..100 {
        match Arc::try_unwrap(client) {
            Ok(client) => {
                client.shutdown().await;
                return Ok(());
            }
            Err(shared) => {
                client = shared;
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
    }
    drop(client);
    Err(runtime_error(
        "MCP_RUNTIME_CLOSE_TIMEOUT",
        "MCP operations did not release the modern session before shutdown.",
    ))
}

struct LegacyRmcpSession {
    client: Mutex<Option<Arc<RmcpLegacyStdioClient>>>,
    disabled_tools: Vec<String>,
}

impl LegacyRmcpSession {
    fn client(&self) -> Result<Arc<RmcpLegacyStdioClient>, McpRuntimeError> {
        self.client
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .ok_or_else(|| {
                runtime_error(
                    "MCP_RUNTIME_NOT_CONNECTED",
                    "The MCP session is already closed.",
                )
            })
    }
}

impl McpSession for LegacyRmcpSession {
    fn is_closed(&self) -> bool {
        self.client()
            .map(|client| client.is_closed())
            .unwrap_or(true)
    }

    fn list_tools<'a>(
        &'a self,
        _cancellation: Arc<McpOperationCancellation>,
    ) -> McpFuture<'a, Vec<McpToolDto>> {
        Box::pin(async move {
            let client = self.client()?;
            let mut cursor = None;
            let mut tools = Vec::new();
            let mut total_bytes = 0usize;
            for _ in 0..MAX_TOOLS_LIST_PAGES {
                let page = client.list_tools_page(cursor).await.map_err(|error| {
                    runtime_error("MCP_RUNTIME_LIST_TOOLS_FAILED", error.message)
                })?;
                total_bytes = add_page_budget(total_bytes, &page.tools)?;
                tools.extend(page.tools.into_iter().map(|mut tool| {
                    if self.disabled_tools.iter().any(|name| name == &tool.name) {
                        tool.enabled = false;
                    }
                    tool
                }));
                cursor = page.next_cursor;
                if cursor.is_none() {
                    return Ok(tools);
                }
            }
            Err(runtime_error(
                "MCP_RUNTIME_CATALOG_PAGE_LIMIT",
                format!("MCP tools/list exceeded {MAX_TOOLS_LIST_PAGES} pages."),
            ))
        })
    }

    fn call_tool<'a>(
        &'a self,
        tool_name: &'a str,
        arguments: Value,
        _cancellation: Arc<McpOperationCancellation>,
    ) -> McpFuture<'a, McpCallToolResponse> {
        Box::pin(async move {
            if self.disabled_tools.iter().any(|name| name == tool_name) {
                return Err(runtime_error(
                    "MCP_RUNTIME_TOOL_DISABLED",
                    format!("MCP tool '{tool_name}' is disabled."),
                ));
            }
            self.client()?
                .call_tool(tool_name, arguments)
                .await
                .map_err(|error| runtime_error("MCP_RUNTIME_CALL_TOOL_FAILED", error.message))
        })
    }

    fn close<'a>(&'a self) -> McpFuture<'a, ()> {
        Box::pin(async move {
            let client = self
                .client
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            let Some(mut client) = client else {
                return Ok(());
            };
            for _ in 0..100 {
                match Arc::try_unwrap(client) {
                    Ok(client) => {
                        client.shutdown().await;
                        return Ok(());
                    }
                    Err(shared) => {
                        client = shared;
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                }
            }
            drop(client);
            Err(runtime_error(
                "MCP_RUNTIME_CLOSE_TIMEOUT",
                "MCP operations did not release the session before shutdown.",
            ))
        })
    }
}

async fn resolve_server_definition(
    key: &McpRuntimeKey,
) -> Result<McpServerDefinition, McpRuntimeError> {
    let manager = config::runtime_config_manager().ok_or_else(|| {
        runtime_error(
            "MCP_RUNTIME_CONFIG_UNAVAILABLE",
            "The Macro configuration manager is unavailable.",
        )
    })?;
    let project_ids = if key.project_ids.is_empty() {
        key.project_id.iter().cloned().collect::<Vec<_>>()
    } else {
        key.project_ids.clone()
    };
    let tools = if !project_ids.is_empty() {
        let snapshot = manager
            .get_snapshot(&project_ids)
            .await
            .map_err(|error| runtime_error("MCP_RUNTIME_CONFIG_INVALID", error.message))?;
        snapshot
            .effective
            .get("tools")
            .cloned()
            .unwrap_or(Value::Null)
    } else {
        manager
            .effective_user_document(ConfigDocumentKind::Tools)
            .await
    };
    let value = tools
        .get("mcpServers")
        .and_then(|servers| servers.get(&key.server_id))
        .cloned()
        .ok_or_else(|| {
            runtime_error(
                "MCP_RUNTIME_SERVER_NOT_FOUND",
                format!(
                    "MCP server '{}' is absent from the effective configuration.",
                    key.server_id
                ),
            )
        })?;
    serde_json::from_value(value)
        .map_err(|error| runtime_error("MCP_RUNTIME_CONFIG_INVALID", error.to_string()))
}

fn stdio_config_fingerprint(
    definition: &McpServerDefinition,
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
) -> Result<String, McpRuntimeError> {
    let sorted_env = env
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<BTreeMap<_, _>>();
    let payload = json!({
        "definition": definition,
        "resolvedStdio": {
            "command": command,
            "args": args,
            "env": sorted_env,
        },
    });
    let bytes = serde_json::to_vec(&payload).map_err(|error| {
        runtime_error(
            "MCP_RUNTIME_CONFIG_INVALID",
            format!("Failed to fingerprint MCP configuration: {error}"),
        )
    })?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn definition_to_dto(server_id: &str, definition: &McpServerDefinition) -> McpServerDto {
    let transport = match &definition.transport {
        McpTransport::Stdio { command, args, env } => McpTransportDto::Stdio {
            command: command.clone(),
            args: args.clone(),
            env: env.clone().into_iter().collect::<HashMap<_, _>>(),
        },
        McpTransport::Sse { url, headers } => McpTransportDto::Sse {
            url: url.clone(),
            headers: headers.clone().into_iter().collect::<HashMap<_, _>>(),
        },
        McpTransport::StreamableHttp { url, headers } => McpTransportDto::StreamableHttp {
            url: url.clone(),
            headers: headers.clone().into_iter().collect::<HashMap<_, _>>(),
        },
    };
    McpServerDto {
        id: server_id.to_string(),
        name: definition
            .name
            .clone()
            .unwrap_or_else(|| server_id.to_string()),
        transport: Some(transport),
        config: Some(json!({ "enabled": definition.enabled.unwrap_or(false) })),
    }
}

fn map_protocol_mode(mode: ConfigProtocolMode) -> McpProtocolMode {
    match mode {
        ConfigProtocolMode::Auto => McpProtocolMode::Auto,
        ConfigProtocolMode::Legacy => McpProtocolMode::Legacy,
        ConfigProtocolMode::Modern => McpProtocolMode::Modern,
    }
}

fn runtime_error(code: &'static str, message: impl Into<String>) -> McpRuntimeError {
    McpRuntimeError::new(code, message)
}

fn validated_timeout(
    field: &str,
    value: Option<u32>,
    minimum_ms: u32,
    maximum_ms: u32,
) -> Result<Option<Duration>, McpRuntimeError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if !(minimum_ms..=maximum_ms).contains(&value) {
        return Err(runtime_error(
            "MCP_RUNTIME_CONFIG_INVALID",
            format!(
                "MCP field '{field}' must be between {minimum_ms} and {maximum_ms} milliseconds."
            ),
        ));
    }
    Ok(Some(Duration::from_millis(u64::from(value))))
}

fn add_page_budget(current: usize, tools: &[McpToolDto]) -> Result<usize, McpRuntimeError> {
    let page_bytes = serde_json::to_vec(tools).map_or(0, |value| value.len());
    let total = current.checked_add(page_bytes).ok_or_else(|| {
        runtime_error(
            "MCP_RUNTIME_CATALOG_TOO_LARGE",
            "MCP tools catalog size overflowed its budget.",
        )
    })?;
    if total > MAX_TOOLS_CATALOG_BYTES {
        return Err(runtime_error(
            "MCP_RUNTIME_CATALOG_TOO_LARGE",
            format!(
                "MCP tools catalog exceeds {} bytes.",
                MAX_TOOLS_CATALOG_BYTES
            ),
        ));
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_timeout_bounds_without_silent_clamping() {
        assert_eq!(validated_timeout("probe", None, 500, 15_000).unwrap(), None);
        assert_eq!(
            validated_timeout("probe", Some(500), 500, 15_000).unwrap(),
            Some(Duration::from_millis(500))
        );
        assert_eq!(
            validated_timeout("probe", Some(15_000), 500, 15_000).unwrap(),
            Some(Duration::from_millis(15_000))
        );
        assert_eq!(
            validated_timeout("probe", Some(499), 500, 15_000)
                .unwrap_err()
                .code,
            "MCP_RUNTIME_CONFIG_INVALID"
        );
        assert_eq!(
            validated_timeout("probe", Some(15_001), 500, 15_000)
                .unwrap_err()
                .code,
            "MCP_RUNTIME_CONFIG_INVALID"
        );
    }

    #[test]
    fn fingerprints_resolved_secrets_deterministically() {
        let definition: McpServerDefinition = serde_json::from_value(json!({
            "enabled": true,
            "transport": {
                "type": "stdio",
                "command": "fixture",
                "args": []
            }
        }))
        .unwrap();
        let mut first_env = HashMap::new();
        first_env.insert("TOKEN".to_string(), "secret-one".to_string());
        first_env.insert("MODE".to_string(), "test".to_string());
        let mut reordered_env = HashMap::new();
        reordered_env.insert("MODE".to_string(), "test".to_string());
        reordered_env.insert("TOKEN".to_string(), "secret-one".to_string());
        let mut rotated_env = reordered_env.clone();
        rotated_env.insert("TOKEN".to_string(), "secret-two".to_string());

        let first = stdio_config_fingerprint(&definition, "fixture", &[], &first_env).unwrap();
        let reordered =
            stdio_config_fingerprint(&definition, "fixture", &[], &reordered_env).unwrap();
        let rotated = stdio_config_fingerprint(&definition, "fixture", &[], &rotated_env).unwrap();

        assert_eq!(first, reordered);
        assert_ne!(first, rotated);
        assert!(first.starts_with("sha256:"));
        assert!(!first.contains("secret-one"));
    }
}
