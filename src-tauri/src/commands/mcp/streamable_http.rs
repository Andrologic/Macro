//! Persistent Streamable HTTP MCP transport guarded by Macro-owned policy
//! (plan Lot E of `docs/mcp-dual-era-implementation-plan.md`).
//!
//! Ownership boundaries, mirroring the stdio adapters:
//! - no `rmcp` type leaks to callers: the surface is Macro DTOs plus Macro
//!   errors;
//! - the HTTP stack stays Macro's own `reqwest` 0.12; the rmcp reqwest feature
//!   stays disabled and [`GuardedStreamableHttpClient`] implements rmcp's
//!   `StreamableHttpClient` trait directly;
//! - every request passes one choke point that enforces, in order: endpoint
//!   validation with DNS pinning, same-origin method-preserving redirect
//!   policy, runtime header precedence over user headers, and bounded response
//!   bodies plus bounded SSE events. No path sends a request around it;
//! - era detection (`server/discover` probe) classifies status and body with
//!   fail-closed rules before any legacy `initialize` may run;
//! - header values may resolve server-scoped secret references; resolved
//!   values feed only fingerprints and requests and are never logged.

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures::stream::BoxStream;
use futures::StreamExt;
use http::{HeaderMap, HeaderName, HeaderValue};
use rmcp::model::{
    CallToolResponse, ClientCapabilities, ClientInfo, ClientJsonRpcMessage, ClientRequest,
    DiscoverRequest, DiscoverRequestParams, ErrorCode, Implementation, JsonRpcMessage,
    PaginatedRequestParams, ProtocolVersion, RequestId, RequestMetaObject, ServerJsonRpcMessage,
    ServerResult, Tool,
};
use rmcp::service::{
    ClientCacheConfig, ClientLifecycleMode, ClientServiceExt, RoleClient, RunningService,
    ServiceError,
};
use rmcp::transport::streamable_http_client::{
    AuthRequiredError, InsufficientScopeError, StreamableHttpClient, StreamableHttpClientTransport,
    StreamableHttpClientTransportConfig, StreamableHttpError, StreamableHttpPostResponse,
};
use serde_json::Value;
use sse_stream::{Sse, SseStream};
use url::Url;

use super::ids::build_mcp_tool_id;
use super::modern_adapter::{McpModernServerMetadata, MODERN_PROTOCOL_VERSION};
use super::result_format::format_tool_call_result;
use super::types::{McpCallToolResponse, McpToolDto};
use crate::commands::{command_error, CommandError, CommandResult};

/// Compiled list of modern protocol versions Macro proposes during probes
/// (plan §5: versions are compiled choices, never free-form configuration).
/// A `-32022` rejection retries the remaining entries before failing closed.
const MODERN_PROTOCOL_VERSIONS: [ProtocolVersion; 1] = [ProtocolVersion::V_2026_07_28];

/// Legacy versions Macro accepts back from an HTTP legacy server. Mirrors
/// commands/mcp/rmcp_adapter.rs so both transports accept the same eras.
const KNOWN_LEGACY_PROTOCOL_VERSIONS: [&str; 5] = [
    "2024-10-07",
    "2024-11-05",
    "2025-03-26",
    "2025-06-18",
    "2025-11-25",
];

const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_OPERATION_TIMEOUT: Duration = Duration::from_secs(60);
const SERVICE_CLOSE_BUDGET: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Buffered JSON or error response bodies larger than this are rejected
/// (plan §9 HTTP response size limit).
pub(crate) const MAX_HTTP_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
/// Probe responses are classified, never forwarded; the small bound keeps a
/// hostile peer from streaming unbounded data during detection.
const MAX_PROBE_RESPONSE_BYTES: usize = 1024 * 1024;
/// Raw SSE event cap enforced at the byte layer before SSE parsing (plan §9).
pub(crate) const MAX_SSE_EVENT_BYTES: usize = 1024 * 1024;
/// Redirect hops allowed within the configured origin.
const MAX_REDIRECT_HOPS: usize = 3;

const EVENT_STREAM_MIME_TYPE: &str = "text/event-stream";
const JSON_MIME_TYPE: &str = "application/json";
const ACCEPT_MIME_TYPES: &str = "application/json, text/event-stream";

fn session_header_name() -> HeaderName {
    HeaderName::from_static("mcp-session-id")
}

// ---------------------------------------------------------------------------
// Endpoint URL / SSRF policy
// ---------------------------------------------------------------------------

/// Address classes a configured endpoint host may belong to. Local means
/// loopback only: private, link-local and metadata-service ranges remain
/// forbidden even for explicitly configured endpoints.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EndpointHostClass {
    Local,
    Public,
}

/// A validated Streamable HTTP endpoint: normalized URL, address class, and
/// the DNS answer pinned at validation time.
#[derive(Debug, Clone)]
pub(crate) struct ValidatedEndpoint {
    /// Normalized endpoint URL (fragment stripped).
    pub url: Url,
    /// Lowercased host name used as the DNS override key.
    pinned_host: String,
    pinned_addrs: Vec<SocketAddr>,
}

fn ipv4_is_public(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 88 && c == 99)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113))
}

fn ipv6_is_public(address: Ipv6Addr) -> bool {
    if let Some(mapped) = address.to_ipv4_mapped() {
        return ipv4_is_public(mapped);
    }
    let segments = address.segments();
    if (segments[0] & 0xe000) != 0x2000 {
        return false;
    }
    !(segments[0] == 0x2002
        || (segments[0] == 0x2001
            && (segments[1] == 0x0000
                || (0x0010..=0x002f).contains(&segments[1])
                || segments[1] == 0x0db8)))
}

/// Same public-address semantics as the web fetch path so every Macro remote
/// access shares one threat model (plan §9).
pub(crate) fn ip_is_public(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => ipv4_is_public(address),
        IpAddr::V6(address) => ipv6_is_public(address),
    }
}

fn normalized_host(url: &Url) -> Option<String> {
    url.host_str().map(|host| {
        host.trim_start_matches('[')
            .trim_end_matches(']')
            .trim_end_matches('.')
            .to_ascii_lowercase()
    })
}

pub(crate) fn classify_host(host: &str) -> EndpointHostClass {
    if host == "localhost" || host.ends_with(".localhost") {
        return EndpointHostClass::Local;
    }
    match host.parse::<IpAddr>() {
        Ok(address) if ip_is_public(address) => EndpointHostClass::Public,
        Ok(_) => EndpointHostClass::Local,
        Err(_) => EndpointHostClass::Public,
    }
}

/// Validates the configured Streamable HTTP endpoint and pins its DNS answer:
/// scheme, embedded credentials and address classes are checked once, then the
/// validated addresses are frozen into the reqwest client so later requests in
/// the session can never be re-bound to an internal address.
pub(crate) async fn validate_endpoint(raw_url: &str) -> CommandResult<ValidatedEndpoint> {
    let mut url = Url::parse(raw_url.trim())
        .map_err(|error| command_error(format!("MCP endpoint URL is invalid: {error}")))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(command_error(
            "MCP endpoint URL must use the http or https scheme.",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(command_error(
            "MCP endpoint URL must not embed credentials.",
        ));
    }
    let host =
        normalized_host(&url).ok_or_else(|| command_error("MCP endpoint URL has no host."))?;
    url.set_fragment(None);
    let host_class = classify_host(&host);

    let mut pinned_addrs = Vec::new();
    if let Some(address) = match url.host() {
        Some(url::Host::Ipv4(address)) => Some(IpAddr::V4(address)),
        Some(url::Host::Ipv6(address)) => Some(IpAddr::V6(address)),
        _ => None,
    } {
        let allowed = match host_class {
            EndpointHostClass::Local => address.is_loopback(),
            EndpointHostClass::Public => ip_is_public(address),
        };
        if !allowed {
            return Err(command_error(
                "MCP endpoint IP literals must be public or loopback addresses.",
            ));
        }
    } else if matches!(url.host(), Some(url::Host::Domain(_))) {
        let port = url.port_or_known_default().unwrap_or(0);
        let addresses = tokio::net::lookup_host((host.as_str(), port))
            .await
            .map_err(|error| {
                command_error(format!("Failed to resolve MCP endpoint host: {error}"))
            })?
            .collect::<Vec<_>>();
        if addresses.is_empty() {
            return Err(command_error("MCP endpoint host resolved no addresses."));
        }
        for address in &addresses {
            let allowed = match host_class {
                EndpointHostClass::Local => address.ip().is_loopback(),
                EndpointHostClass::Public => ip_is_public(address.ip()),
            };
            if !allowed {
                return Err(command_error(format!(
                    "MCP endpoint '{host}' resolved outside its permitted address class."
                )));
            }
        }
        pinned_addrs = addresses;
    }
    Ok(ValidatedEndpoint {
        url,
        pinned_host: host,
        pinned_addrs,
    })
}

impl ValidatedEndpoint {
    /// ASCII origin used in cache partitioning and fingerprints (plan §6.2).
    pub(crate) fn origin_ascii(&self) -> String {
        self.url.origin().ascii_serialization()
    }

    fn build_client(&self) -> CommandResult<reqwest::Client> {
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .pool_max_idle_per_host(0)
            .user_agent(concat!("Macro/", env!("CARGO_PKG_VERSION")));
        if !self.pinned_addrs.is_empty() {
            // Port 0 lets each request's own URL port win; the address set is
            // the pinned DNS answer for this connection's lifetime.
            let pinned = self
                .pinned_addrs
                .iter()
                .map(|address| SocketAddr::new(address.ip(), 0))
                .collect::<Vec<_>>();
            builder = builder.resolve_to_addrs(self.pinned_host.as_str(), &pinned);
        }
        builder.build().map_err(|error| {
            command_error(format!(
                "Failed to build the guarded MCP HTTP client: {error}"
            ))
        })
    }
}

// ---------------------------------------------------------------------------
// Header policy
// ---------------------------------------------------------------------------

/// Headers whose values define the wire protocol or the transport hop. User
/// configuration entries with such names are dropped case-insensitively; only
/// the runtime may set them (plan §9: non-overridable generated headers).
const RESERVED_HEADER_NAMES: &[&str] = &[
    "accept",
    "content-type",
    "content-length",
    "mcp-session-id",
    "mcp-protocol-version",
    "last-event-id",
    "host",
    "connection",
    "transfer-encoding",
    "upgrade",
];

fn is_reserved_header(name: &str) -> bool {
    let lowered = name.to_ascii_lowercase();
    RESERVED_HEADER_NAMES.contains(&lowered.as_str())
}

/// Builds the user-header map handed to the rmcp worker: reserved names are
/// stripped, remaining names keep their canonical parsed casing. Values arrive
/// already resolved (secrets included) and are never logged.
pub(crate) fn user_header_map(
    headers: &BTreeMap<String, String>,
) -> CommandResult<HashMap<HeaderName, HeaderValue>> {
    let mut map = HashMap::new();
    for (name, value) in headers {
        if is_reserved_header(name) {
            continue;
        }
        let header_name = HeaderName::from_bytes(name.as_bytes()).map_err(|error| {
            command_error(format!("MCP header name '{name}' is invalid: {error}"))
        })?;
        let header_value = HeaderValue::from_str(value).map_err(|_| {
            command_error(format!(
                "MCP header '{name}' has a value with invalid characters."
            ))
        })?;
        map.insert(header_name, header_value);
    }
    Ok(map)
}

/// Merges rmcp's per-request protocol headers over the user map. Protocol
/// headers win because parsed `HeaderName`s are case-insensitively canonical;
/// colliding user spellings collapse onto one entry that protocol headers
/// overwrite last. Reserved names were already stripped from the user side.
fn merge_protocol_headers(
    user: &HashMap<HeaderName, HeaderValue>,
    protocol: &HashMap<HeaderName, HeaderValue>,
) -> HeaderMap {
    let mut merged = HeaderMap::with_capacity(user.len() + protocol.len());
    for (name, value) in user {
        merged.insert(name.clone(), value.clone());
    }
    for (name, value) in protocol {
        merged.insert(name.clone(), value.clone());
    }
    merged
}

// ---------------------------------------------------------------------------
// Response limits
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub(crate) enum HttpTransportError {
    #[error("HTTP body exceeded {maximum_bytes} bytes")]
    BodyTooLarge { maximum_bytes: usize },
    #[error("redirect refused: {0}")]
    RedirectRefused(String),
    #[error("invalid HTTP header: {0}")]
    Header(String),
    #[error("transport attempted to use an unexpected MCP endpoint")]
    UnexpectedEndpoint,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

type AdapterError = HttpTransportError;

fn request_transport_error(error: reqwest::Error) -> StreamableHttpError<AdapterError> {
    StreamableHttpError::Client(AdapterError::Io(std::io::Error::other(error)))
}

async fn collect_bounded_body(
    response: &mut reqwest::Response,
    maximum_bytes: usize,
) -> Result<Vec<u8>, StreamableHttpError<AdapterError>> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(request_transport_error)? {
        if body.len() + chunk.len() > maximum_bytes {
            return Err(StreamableHttpError::Client(AdapterError::BodyTooLarge {
                maximum_bytes,
            }));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn first_sse_event_end(body: &[u8]) -> Option<usize> {
    let lf = body
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|index| index + 2);
    let crlf = body
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4);
    match (lf, crlf) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (Some(end), None) | (None, Some(end)) => Some(end),
        (None, None) => None,
    }
}

async fn collect_probe_body(
    response: &mut reqwest::Response,
    stop_after_first_sse_event: bool,
) -> Result<Vec<u8>, StreamableHttpError<AdapterError>> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(request_transport_error)? {
        if body.len() + chunk.len() > MAX_PROBE_RESPONSE_BYTES {
            return Err(StreamableHttpError::Client(AdapterError::BodyTooLarge {
                maximum_bytes: MAX_PROBE_RESPONSE_BYTES,
            }));
        }
        body.extend_from_slice(&chunk);
        if stop_after_first_sse_event {
            if let Some(end) = first_sse_event_end(&body) {
                body.truncate(end);
                break;
            }
        }
    }
    Ok(body)
}

/// Enforces a raw per-event byte budget at the byte layer, before SSE parsing.
/// Comment lines count while they are received so a hostile heartbeat cannot
/// grow without bound; completed comments are then discarded from the budget
/// retained for the event's data fields.
struct SseEventSizeLimit {
    maximum_bytes: usize,
    retained_bytes: usize,
    line_bytes: usize,
    line_is_comment: bool,
    previous_was_carriage_return: bool,
    failed: bool,
}

impl SseEventSizeLimit {
    fn new(maximum_bytes: usize) -> Self {
        Self {
            maximum_bytes,
            retained_bytes: 0,
            line_bytes: 0,
            line_is_comment: false,
            previous_was_carriage_return: false,
            failed: false,
        }
    }

    fn observe(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        if self.failed {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "oversized MCP SSE event was already rejected",
            ));
        }
        for &byte in bytes {
            if self.previous_was_carriage_return {
                self.previous_was_carriage_return = false;
                if byte == b'\n' {
                    continue;
                }
            }
            match byte {
                b'\r' => {
                    self.finish_line()?;
                    self.previous_was_carriage_return = true;
                }
                b'\n' => self.finish_line()?,
                _ => {
                    if self.line_bytes == 0 {
                        self.line_is_comment = byte == b':';
                    }
                    self.line_bytes = self.line_bytes.saturating_add(1);
                    self.check_limit()?;
                }
            }
        }
        Ok(())
    }

    fn finish_line(&mut self) -> std::io::Result<()> {
        if self.line_bytes == 0 {
            self.retained_bytes = 0;
        } else if !self.line_is_comment {
            // The SSE parser joins data lines with a newline.
            self.retained_bytes = self
                .retained_bytes
                .saturating_add(self.line_bytes)
                .saturating_add(1);
        }
        self.line_bytes = 0;
        self.line_is_comment = false;
        self.check_limit()
    }

    fn check_limit(&mut self) -> std::io::Result<()> {
        if self.retained_bytes.saturating_add(self.line_bytes) > self.maximum_bytes {
            self.failed = true;
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("MCP SSE event exceeds {} bytes", self.maximum_bytes),
            ));
        }
        Ok(())
    }
}

fn limited_sse_stream<S, E>(
    stream: S,
    maximum_event_bytes: usize,
) -> BoxStream<'static, Result<Sse, sse_stream::Error>>
where
    S: futures::Stream<Item = Result<Bytes, E>> + Send + 'static,
    E: std::error::Error + Send + Sync + 'static,
{
    let pinned_source = Box::pin(stream);
    let limited = futures::stream::unfold(
        (pinned_source, SseEventSizeLimit::new(maximum_event_bytes)),
        |(mut source, mut limit)| async move {
            match source.as_mut().next().await {
                Some(Ok(chunk)) => {
                    if let Err(error) = limit.observe(&chunk) {
                        return Some((
                            Err(sse_stream::Error::Body(Box::new(error))),
                            (source, limit),
                        ));
                    }
                    Some((Ok(chunk), (source, limit)))
                }
                Some(Err(error)) => Some((
                    Err(sse_stream::Error::Body(Box::new(error))),
                    (source, limit),
                )),
                None => None,
            }
        },
    );
    SseStream::from_bytes_stream(limited).boxed()
}

// ---------------------------------------------------------------------------
// Guarded client
// ---------------------------------------------------------------------------

fn insert_forced_header(
    headers: &mut HeaderMap,
    name: HeaderName,
    value: String,
) -> Result<(), StreamableHttpError<AdapterError>> {
    let value = HeaderValue::from_str(&value).map_err(|error| {
        StreamableHttpError::Client(AdapterError::Header(format!("{name}: {error}")))
    })?;
    headers.insert(name, value);
    Ok(())
}

/// Runtime-generated headers layered last so they always beat user values
/// (plan §9). `json_content_type` is false for SSE-only GET streams.
struct ForcedRequestHeaders {
    accept: &'static str,
    json_content_type: bool,
    auth_token: Option<String>,
    session_id: Option<String>,
}

/// Pure assembly of one request's header map:
/// user headers < rmcp protocol headers < forced runtime headers.
fn build_request_header_map(
    user: &HashMap<HeaderName, HeaderValue>,
    protocol: &HashMap<HeaderName, HeaderValue>,
    forced: ForcedRequestHeaders,
) -> Result<HeaderMap, StreamableHttpError<AdapterError>> {
    let mut merged = merge_protocol_headers(user, protocol);
    insert_forced_header(&mut merged, http::header::ACCEPT, forced.accept.to_string())?;
    if forced.json_content_type {
        insert_forced_header(
            &mut merged,
            http::header::CONTENT_TYPE,
            JSON_MIME_TYPE.to_string(),
        )?;
    }
    if let Some(auth_token) = forced.auth_token {
        insert_forced_header(
            &mut merged,
            http::header::AUTHORIZATION,
            format!("Bearer {auth_token}"),
        )?;
    }
    if let Some(session_id) = forced.session_id {
        insert_forced_header(&mut merged, session_header_name(), session_id)?;
    }
    Ok(merged)
}

fn response_header_value(headers: &reqwest::header::HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

fn parse_json_rpc_error(body: &[u8]) -> Option<ServerJsonRpcMessage> {
    match serde_json::from_slice::<ServerJsonRpcMessage>(body) {
        Ok(message @ JsonRpcMessage::Error(_)) => Some(message),
        _ => None,
    }
}

/// Extracts the `scope=` parameter from a `WWW-Authenticate` challenge. Local
/// copy because rmcp keeps its parser crate-private; handles quoted and bare
/// values the same way.
fn extract_scope_from_challenge(challenge: &str) -> Option<String> {
    let lowered = challenge.to_ascii_lowercase();
    let position = lowered.find("scope=")?;
    let rest = &challenge[position + "scope=".len()..];
    if let Some(stripped) = rest.strip_prefix('"') {
        let end = stripped.find('"')?;
        return Some(stripped[..end].to_string());
    }
    let end = rest
        .find(|character: char| character == ',' || character.is_whitespace())
        .unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

/// One shared request path for probe traffic and rmcp transport traffic.
///
/// Redirect policy: only 307/308 within the configured origin are followed,
/// preserving method and body by rebuilding the identical request on each hop;
/// every other redirect status is returned untouched so upper layers see the
/// server's actual behavior. Because the reqwest client pins the endpoint's
/// DNS answer and redirects can never leave the origin, no hop can reach an
/// unvalidated address.
#[derive(Clone)]
pub(crate) struct GuardedStreamableHttpClient {
    http: reqwest::Client,
    endpoint: Arc<ValidatedEndpoint>,
    user_headers: Arc<HashMap<HeaderName, HeaderValue>>,
    request_head_timeout: Duration,
}

impl GuardedStreamableHttpClient {
    pub(crate) fn new(
        endpoint: ValidatedEndpoint,
        user_headers: HashMap<HeaderName, HeaderValue>,
        operation_timeout: Option<Duration>,
    ) -> CommandResult<Self> {
        let http = endpoint.build_client()?;
        Ok(Self {
            http,
            endpoint: Arc::new(endpoint),
            user_headers: Arc::new(user_headers),
            request_head_timeout: operation_timeout.unwrap_or(DEFAULT_OPERATION_TIMEOUT),
        })
    }

    fn redirect_refused(
        status: reqwest::StatusCode,
        location: &str,
    ) -> StreamableHttpError<AdapterError> {
        StreamableHttpError::Client(AdapterError::RedirectRefused(format!(
            "HTTP {status} redirected to '{location}', which leaves the configured origin"
        )))
    }

    fn validate_transport_uri(&self, uri: &str) -> Result<(), StreamableHttpError<AdapterError>> {
        if uri == self.endpoint.url.as_str() {
            return Ok(());
        }
        Err(StreamableHttpError::Client(
            AdapterError::UnexpectedEndpoint,
        ))
    }

    /// Sends a request built by `build_request(target_url)` and follows only
    /// same-origin 307/308 hops, rebuilding the identical request each hop.
    async fn send_following_same_origin<F>(
        &self,
        build_request: F,
    ) -> Result<reqwest::Response, StreamableHttpError<AdapterError>>
    where
        F: Fn(&Url) -> reqwest::RequestBuilder,
    {
        let mut current_url = self.endpoint.url.clone();
        for _hop in 0..=MAX_REDIRECT_HOPS {
            let response = tokio::time::timeout(
                self.request_head_timeout,
                build_request(&current_url).send(),
            )
            .await
            .map_err(|_| {
                StreamableHttpError::UnexpectedServerResponse(
                    "timed out waiting for the MCP HTTP response head".into(),
                )
            })?
            .map_err(request_transport_error)?;
            let status = response.status();
            if status != reqwest::StatusCode::TEMPORARY_REDIRECT
                && status != reqwest::StatusCode::PERMANENT_REDIRECT
            {
                return Ok(response);
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let Some(location) = location else {
                return Ok(response);
            };
            let next_url = current_url
                .join(&location)
                .map_err(|_| Self::redirect_refused(status, "an invalid location"))?;
            if next_url.origin() != self.endpoint.url.origin() {
                return Err(Self::redirect_refused(status, "a different origin"));
            }
            tracing::debug!("following same-origin MCP redirect");
            current_url = next_url;
        }
        Err(StreamableHttpError::Client(AdapterError::RedirectRefused(
            format!("MCP request exceeded {MAX_REDIRECT_HOPS} same-origin redirects"),
        )))
    }

    /// Probe-grade POST returning the raw response pieces so the era
    /// classifier sees status, content type and body emptiness without rmcp's
    /// leniency mapping. Any redirect is refused outright: replaying the probe
    /// elsewhere is never acceptable evidence of anything.
    pub(crate) async fn raw_post_json(
        &self,
        body: Vec<u8>,
        extra_protocol_headers: &HashMap<HeaderName, HeaderValue>,
        timeout: Duration,
    ) -> Result<RawHttpResponse, StreamableHttpError<AdapterError>> {
        let headers = build_request_header_map(
            &self.user_headers,
            extra_protocol_headers,
            ForcedRequestHeaders {
                accept: ACCEPT_MIME_TYPES,
                json_content_type: true,
                auth_token: None,
                session_id: None,
            },
        )?;

        let client = self.http.clone();
        let endpoint = self.endpoint.url.clone();
        let exchange = async {
            let mut request = client.post(endpoint.as_str());
            for (name, value) in &headers {
                request = request.header(name, value);
            }
            let mut response = request
                .body(body)
                .send()
                .await
                .map_err(request_transport_error)?;
            let status = response.status();
            let content_type = response_header_value(response.headers(), "content-type");
            let is_sse = content_type
                .as_deref()
                .is_some_and(|value| value.starts_with(EVENT_STREAM_MIME_TYPE));
            let body = collect_probe_body(&mut response, is_sse).await?;
            Ok::<_, StreamableHttpError<AdapterError>>(RawHttpResponse {
                status,
                content_type,
                body,
            })
        };
        tokio::time::timeout(timeout, exchange).await.map_err(|_| {
            StreamableHttpError::UnexpectedServerResponse(
                "timed out while reading the MCP probe response".into(),
            )
        })?
    }
}

pub(crate) struct RawHttpResponse {
    pub status: reqwest::StatusCode,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

impl StreamableHttpClient for GuardedStreamableHttpClient {
    type Error = AdapterError;

    async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_token: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<StreamableHttpPostResponse, StreamableHttpError<Self::Error>> {
        self.post_message_with_max_sse_event_size(
            uri,
            message,
            session_id,
            auth_token,
            custom_headers,
            MAX_SSE_EVENT_BYTES,
        )
        .await
    }

    async fn get_stream(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        auth_token: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<BoxStream<'static, Result<Sse, sse_stream::Error>>, StreamableHttpError<Self::Error>>
    {
        self.get_stream_with_max_sse_event_size(
            uri,
            session_id,
            last_event_id,
            auth_token,
            custom_headers,
            MAX_SSE_EVENT_BYTES,
        )
        .await
    }

    async fn post_message_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_token: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
        max_sse_event_size: usize,
    ) -> Result<StreamableHttpPostResponse, StreamableHttpError<Self::Error>> {
        self.validate_transport_uri(&uri)?;
        // Precedence (plan §9): user headers first, rmcp protocol headers over
        // them, forced runtime headers (accept/content-type/authorization/
        // session id) last so generated values always win.
        let headers = build_request_header_map(
            &self.user_headers,
            &custom_headers,
            ForcedRequestHeaders {
                accept: ACCEPT_MIME_TYPES,
                json_content_type: true,
                auth_token,
                session_id: session_id.as_ref().map(ToString::to_string),
            },
        )?;
        let body = serde_json::to_vec(&message).map_err(StreamableHttpError::Deserialize)?;

        let client = self.http.clone();
        let headers_clone = headers.clone();
        let mut response = self
            .send_following_same_origin(move |url| {
                let mut request = client.post(url.as_str());
                for (name, value) in &headers_clone {
                    request = request.header(name, value);
                }
                request.body(body.clone())
            })
            .await?;

        let status = response.status();
        let session_from_server =
            response_header_value(response.headers(), session_header_name().as_str());
        if status == reqwest::StatusCode::UNAUTHORIZED {
            if let Some(challenge) = response_header_value(response.headers(), "www-authenticate") {
                return Err(StreamableHttpError::AuthRequired(AuthRequiredError::new(
                    challenge,
                )));
            }
        }
        if status == reqwest::StatusCode::FORBIDDEN {
            if let Some(challenge) = response_header_value(response.headers(), "www-authenticate") {
                let scope = extract_scope_from_challenge(&challenge);
                return Err(StreamableHttpError::InsufficientScope(
                    InsufficientScopeError::new(challenge, scope),
                ));
            }
        }
        if matches!(
            status,
            reqwest::StatusCode::ACCEPTED | reqwest::StatusCode::NO_CONTENT
        ) {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        if status == reqwest::StatusCode::NOT_FOUND && session_id.is_some() {
            return Err(StreamableHttpError::SessionExpired);
        }
        let content_type = response_header_value(response.headers(), "content-type");
        if !status.is_success() {
            let body = collect_bounded_body(&mut response, MAX_HTTP_RESPONSE_BYTES).await?;
            // Non-success JSON-RPC errors stay correlated for the caller;
            // everything else becomes an unexpected-response failure so era
            // negotiation applies its fail-closed rules.
            let json_error = if content_type
                .as_deref()
                .is_some_and(|ct| ct.starts_with(JSON_MIME_TYPE))
            {
                parse_json_rpc_error(&body)
            } else {
                None
            };
            match json_error {
                Some(message) => {
                    return Ok(StreamableHttpPostResponse::Json(
                        message,
                        session_from_server,
                    ))
                }
                None => {
                    return Err(StreamableHttpError::UnexpectedServerResponse(
                        format!("HTTP {status} returned an invalid MCP error body").into(),
                    ));
                }
            }
        }
        if response.content_length() == Some(0)
            && !matches!(message, ClientJsonRpcMessage::Request(_))
        {
            // Spec asks for 202 on notifications; tolerate empty successes.
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        match content_type.as_deref() {
            Some(ct) if ct.starts_with(EVENT_STREAM_MIME_TYPE) => {
                Ok(StreamableHttpPostResponse::Sse(
                    limited_sse_stream(response.bytes_stream(), max_sse_event_size),
                    session_from_server,
                ))
            }
            Some(ct) if ct.starts_with(JSON_MIME_TYPE) => {
                let body = collect_bounded_body(&mut response, MAX_HTTP_RESPONSE_BYTES).await?;
                // Unlike the SDK default, a success JSON body that does not
                // parse stays an error for requests: silent acceptance would
                // hide invalid modern bodies from era negotiation.
                match serde_json::from_slice::<ServerJsonRpcMessage>(&body) {
                    Ok(parsed) => Ok(StreamableHttpPostResponse::Json(
                        parsed,
                        session_from_server,
                    )),
                    Err(_) if matches!(message, ClientJsonRpcMessage::Notification(_)) => {
                        Ok(StreamableHttpPostResponse::Accepted)
                    }
                    Err(error) => Err(StreamableHttpError::UnexpectedServerResponse(
                        format!("invalid MCP JSON body: {error}").into(),
                    )),
                }
            }
            other => Err(StreamableHttpError::UnexpectedContentType(
                other.map(str::to_owned),
            )),
        }
    }

    async fn delete_session(
        &self,
        uri: Arc<str>,
        session_id: Arc<str>,
        auth_token: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<(), StreamableHttpError<Self::Error>> {
        self.validate_transport_uri(&uri)?;
        let headers = build_request_header_map(
            &self.user_headers,
            &custom_headers,
            ForcedRequestHeaders {
                accept: ACCEPT_MIME_TYPES,
                json_content_type: false,
                auth_token,
                session_id: Some(session_id.to_string()),
            },
        )?;
        let client = self.http.clone();
        let headers_clone = headers.clone();
        let mut response = self
            .send_following_same_origin(move |url| {
                let mut request = client.delete(url.as_str());
                for (name, value) in &headers_clone {
                    request = request.header(name, value);
                }
                request
            })
            .await?;
        if response.status() == reqwest::StatusCode::METHOD_NOT_ALLOWED {
            return Ok(());
        }
        let status = response.status();
        if !status.is_success() {
            let body = collect_bounded_body(&mut response, MAX_HTTP_RESPONSE_BYTES).await?;
            return Err(StreamableHttpError::UnexpectedServerResponse(
                format!("DELETE returned HTTP {status} with {} bytes", body.len()).into(),
            ));
        }
        collect_bounded_body(&mut response, MAX_HTTP_RESPONSE_BYTES).await?;
        Ok(())
    }

    async fn get_stream_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        auth_token: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
        max_sse_event_size: usize,
    ) -> Result<BoxStream<'static, Result<Sse, sse_stream::Error>>, StreamableHttpError<Self::Error>>
    {
        self.validate_transport_uri(&uri)?;
        let mut headers = build_request_header_map(
            &self.user_headers,
            &custom_headers,
            ForcedRequestHeaders {
                accept: EVENT_STREAM_MIME_TYPE,
                json_content_type: false,
                auth_token,
                session_id: session_id.as_ref().map(ToString::to_string),
            },
        )?;
        if let Some(last_event_id) = last_event_id {
            insert_forced_header(
                &mut headers,
                HeaderName::from_static("last-event-id"),
                last_event_id,
            )?;
        }
        let client = self.http.clone();
        let headers_clone = headers.clone();
        let mut response = self
            .send_following_same_origin(move |url| {
                let mut request = client.get(url.as_str());
                for (name, value) in &headers_clone {
                    request = request.header(name, value);
                }
                request
            })
            .await?;
        let status = response.status();
        if status == reqwest::StatusCode::METHOD_NOT_ALLOWED {
            return Err(StreamableHttpError::ServerDoesNotSupportSse);
        }
        if status == reqwest::StatusCode::UNAUTHORIZED {
            if let Some(challenge) = response_header_value(response.headers(), "www-authenticate") {
                return Err(StreamableHttpError::AuthRequired(AuthRequiredError::new(
                    challenge,
                )));
            }
        }
        if !status.is_success() {
            let body = collect_bounded_body(&mut response, MAX_HTTP_RESPONSE_BYTES).await?;
            return Err(StreamableHttpError::UnexpectedServerResponse(
                format!("GET returned HTTP {status} with {} bytes", body.len()).into(),
            ));
        }
        let content_type = response_header_value(response.headers(), "content-type");
        match content_type.as_deref() {
            Some(ct) if ct.starts_with(EVENT_STREAM_MIME_TYPE) => {}
            other => {
                return Err(StreamableHttpError::UnexpectedContentType(
                    other.map(str::to_owned),
                ))
            }
        }
        Ok(limited_sse_stream(
            response.bytes_stream(),
            max_sse_event_size,
        ))
    }
}

// ---------------------------------------------------------------------------
// Era probe
// ---------------------------------------------------------------------------

/// Outcome of the modern-era probe over Streamable HTTP (plan §6.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HttpEraProbeOutcome {
    Modern,
    /// Rejection compatible with a pre-2026 server: safe to attempt a legacy
    /// `initialize`.
    LegacySafe {
        reason: String,
    },
}

/// Failure that must never fold back to legacy: authentication, rate limits,
/// server faults, TLS/DNS/transport faults, forbidden redirects, or invalid
/// modern bodies.
#[derive(Debug, Clone)]
pub(crate) struct McpProbeFailure {
    pub reason: String,
}

impl fmt::Display for McpProbeFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.reason)
    }
}

/// Classification verdict for one probe exchange. Pure so the entire
/// status/body matrix stays unit-testable without network fixtures.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ProbeVerdict {
    Modern,
    LegacySafe { reason: String },
    VersionRetry,
    Fatal { reason: String },
}

fn message_request_id(message: &ServerJsonRpcMessage) -> Option<&RequestId> {
    match message {
        JsonRpcMessage::Response(response) => Some(&response.id),
        JsonRpcMessage::Error(error) => error.id.as_ref(),
        _ => None,
    }
}

/// Classifies a decoded probe payload. `correlated` requires id matching;
/// pre-validation rejections (`HTTP 400` without a request-scoped reply) pass
/// `false` because such servers answer before any id exists.
fn classify_probe_payload(
    payload: &[u8],
    correlated: bool,
    expected_id: &RequestId,
) -> ProbeVerdict {
    let message = match serde_json::from_slice::<ServerJsonRpcMessage>(payload) {
        Ok(message) => message,
        Err(error) => {
            return ProbeVerdict::Fatal {
                reason: format!("the modern probe body is not a valid MCP message: {error}"),
            };
        }
    };
    if correlated && message_request_id(&message) != Some(expected_id) {
        return ProbeVerdict::Fatal {
            reason: "the modern probe reply does not correlate with its request id".to_string(),
        };
    }
    match message {
        JsonRpcMessage::Response(response) => match response.result {
            ServerResult::DiscoverResult(_) => ProbeVerdict::Modern,
            _ => ProbeVerdict::Fatal {
                reason: "the modern probe returned a non-discovery result".to_string(),
            },
        },
        JsonRpcMessage::Error(error) => {
            if error.error.code == ErrorCode::UNSUPPORTED_PROTOCOL_VERSION {
                return ProbeVerdict::VersionRetry;
            }
            if error.error.code == ErrorCode::METHOD_NOT_FOUND {
                return ProbeVerdict::LegacySafe {
                    reason: "the server rejected server/discover as an unknown method".to_string(),
                };
            }
            if matches!(
                error.error.code,
                ErrorCode::MISSING_REQUIRED_CLIENT_CAPABILITY | ErrorCode::HEADER_MISMATCH
            ) {
                return ProbeVerdict::Fatal {
                    reason: format!(
                        "the server understands the modern protocol but rejected discovery ({:?})",
                        error.error.code
                    ),
                };
            }
            ProbeVerdict::Fatal {
                reason: format!(
                    "the modern probe failed with JSON-RPC error {:?}",
                    error.error.code
                ),
            }
        }
        _ => ProbeVerdict::Fatal {
            reason: "the modern probe produced neither a result nor an error".to_string(),
        },
    }
}

/// Returns the first complete SSE event's joined `data` payload from a raw
/// response body. Minimal parser: comment/id/retry fields are ignored and the
/// first blank line terminates the event.
fn first_sse_data_payload(body: &[u8]) -> Option<Vec<u8>> {
    let mut data_lines: Vec<&[u8]> = Vec::new();
    for line in body.split(|byte| *byte == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.is_empty() {
            if !data_lines.is_empty() {
                let mut joined = Vec::new();
                for (index, data) in data_lines.iter().enumerate() {
                    if index > 0 {
                        joined.push(b'\n');
                    }
                    joined.extend_from_slice(data);
                }
                return Some(joined);
            }
            continue;
        }
        if let Some(data) = line.strip_prefix(b"data:") {
            data_lines.push(data.strip_prefix(b" ").unwrap_or(data));
        }
    }
    None
}

fn classify_probe_status(
    status: reqwest::StatusCode,
    content_type: Option<&str>,
    payload: &[u8],
    expected_id: &RequestId,
) -> ProbeVerdict {
    let empty = payload.iter().all(u8::is_ascii_whitespace);
    if status.is_success() {
        if empty {
            return ProbeVerdict::Fatal {
                reason: "the endpoint accepted the modern probe but returned no body".to_string(),
            };
        }
        // Some modern servers answer a discover POST with an SSE stream whose
        // first correlated message carries the result (plan §6.2 step 7).
        if content_type.is_some_and(|ct| ct.starts_with(EVENT_STREAM_MIME_TYPE)) {
            return match first_sse_data_payload(payload) {
                Some(data) => classify_probe_payload(&data, true, expected_id),
                None => ProbeVerdict::Fatal {
                    reason: "the probe's SSE reply carried no data event".to_string(),
                },
            };
        }
        return classify_probe_payload(payload, true, expected_id);
    }
    match status {
        reqwest::StatusCode::UNAUTHORIZED => ProbeVerdict::Fatal {
            reason: "the endpoint requires authentication (HTTP 401)".to_string(),
        },
        reqwest::StatusCode::FORBIDDEN => ProbeVerdict::Fatal {
            reason: "the endpoint refused authorization (HTTP 403)".to_string(),
        },
        reqwest::StatusCode::TOO_MANY_REQUESTS => ProbeVerdict::Fatal {
            reason: "the endpoint rate-limited the probe (HTTP 429)".to_string(),
        },
        reqwest::StatusCode::METHOD_NOT_ALLOWED => ProbeVerdict::Fatal {
            reason: "the endpoint rejects POST (HTTP 405); it looks like a pre-streamable \
                     HTTP+SSE server, which Macro does not speak yet"
                .to_string(),
        },
        status if status.is_server_error() => ProbeVerdict::Fatal {
            reason: format!("the endpoint failed server-side (HTTP {status})"),
        },
        reqwest::StatusCode::BAD_REQUEST => {
            if empty {
                // The classic pre-2026 streamable rejection (plan §6.2 step 5).
                return ProbeVerdict::LegacySafe {
                    reason: "the server answered the modern probe with an empty HTTP 400"
                        .to_string(),
                };
            }
            match parse_json_rpc_error(payload) {
                // Pre-validation rejections carry no correlated id.
                Some(_) => classify_probe_payload(payload, false, expected_id),
                None => ProbeVerdict::Fatal {
                    reason: format!(
                        "HTTP 400 carried an undecodable rejection ({} bytes)",
                        payload.len()
                    ),
                },
            }
        }
        _ => ProbeVerdict::Fatal {
            reason: format!("unexpected HTTP {status} during the modern probe"),
        },
    }
}

/// Sends `server/discover` with runtime-generated MCP headers and classifies
/// the answer. Transport-level failures (TLS, DNS, timeouts, redirects) always
/// surface as [`McpProbeFailure`]: they are never evidence of a legacy server.
pub(crate) async fn probe_modern_era(
    client: &GuardedStreamableHttpClient,
    probe_timeout: Duration,
) -> Result<HttpEraProbeOutcome, McpProbeFailure> {
    let mut attempted_versions = Vec::new();
    for version in MODERN_PROTOCOL_VERSIONS {
        let verdict = post_probe_version(client, &version, probe_timeout).await;
        match verdict {
            ProbeVerdict::Modern => return Ok(HttpEraProbeOutcome::Modern),
            ProbeVerdict::LegacySafe { reason } => {
                return Ok(HttpEraProbeOutcome::LegacySafe { reason });
            }
            ProbeVerdict::VersionRetry => attempted_versions.push(version.to_string()),
            ProbeVerdict::Fatal { reason } => return Err(McpProbeFailure { reason }),
        }
    }
    Err(McpProbeFailure {
        reason: format!(
            "no common modern protocol version is supported (attempted: {})",
            attempted_versions.join(", ")
        ),
    })
}

fn next_probe_request_id() -> i64 {
    // Distinct negative ids cannot collide with rmcp worker ids.
    static COUNTER: AtomicI64 = AtomicI64::new(-2);
    COUNTER.fetch_sub(1, Ordering::Relaxed)
}

async fn post_probe_version(
    client: &GuardedStreamableHttpClient,
    version: &ProtocolVersion,
    probe_timeout: Duration,
) -> ProbeVerdict {
    let mut discover = DiscoverRequest::new(DiscoverRequestParams {});
    discover
        .extensions
        .insert(RequestMetaObject::with_client_context(
            version.clone(),
            Implementation::new("Macro", env!("CARGO_PKG_VERSION")),
            ClientCapabilities::default(),
        ));
    let request_id = RequestId::Number(next_probe_request_id());
    let message =
        ClientJsonRpcMessage::request(ClientRequest::DiscoverRequest(discover), request_id.clone());
    let body = match serde_json::to_vec(&message) {
        Ok(body) => body,
        Err(error) => {
            return ProbeVerdict::Fatal {
                reason: format!("failed to serialize the modern probe: {error}"),
            };
        }
    };

    let mut protocol_headers = HashMap::new();
    if let Ok(value) = HeaderValue::from_str(version.as_str()) {
        protocol_headers.insert(HeaderName::from_static("mcp-protocol-version"), value);
    }

    match client
        .raw_post_json(body, &protocol_headers, probe_timeout)
        .await
    {
        Ok(response) => classify_probe_status(
            response.status,
            response.content_type.as_deref(),
            &response.body,
            &request_id,
        ),
        Err(StreamableHttpError::Client(AdapterError::RedirectRefused(detail))) => {
            ProbeVerdict::Fatal {
                reason: format!("the modern probe hit a forbidden redirect: {detail}"),
            }
        }
        Err(error) => ProbeVerdict::Fatal {
            reason: format!("the modern probe failed at the transport layer: {error}"),
        },
    }
}

// ---------------------------------------------------------------------------
// Persistent legacy and modern HTTP clients (rmcp lifecycles)
// ---------------------------------------------------------------------------

/// Client capabilities stay empty and unsupported server-to-client legacy
/// requests receive correlated `-32601` answers (plan §12.1). Mirrors the
/// stdio adapter's closed handler, which keeps its copy privately.
#[derive(Debug)]
struct ClosedCapabilityHttpClientHandler {
    info: ClientInfo,
}

impl ClosedCapabilityHttpClientHandler {
    fn legacy() -> Self {
        Self {
            info: ClientInfo::new(
                ClientCapabilities::default(),
                Implementation::new("Macro", env!("CARGO_PKG_VERSION")),
            )
            .with_protocol_version(ProtocolVersion::V_2025_11_25),
        }
    }

    fn modern() -> Self {
        Self {
            info: ClientInfo::new(
                ClientCapabilities::default(),
                Implementation::new("Macro", env!("CARGO_PKG_VERSION")),
            )
            .with_protocol_version(ProtocolVersion::V_2026_07_28),
        }
    }
}

impl rmcp::ClientHandler for ClosedCapabilityHttpClientHandler {
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
        _context: rmcp::service::RequestContext<RoleClient>,
    ) -> impl Future<Output = Result<rmcp::model::ListRootsResult, rmcp::ErrorData>>
           + rmcp::service::MaybeSendFuture
           + '_ {
        let _ = _context;
        std::future::ready(Err(rmcp::ErrorData::method_not_found::<
            rmcp::model::ListRootsRequestMethod,
        >()))
    }

    fn create_elicitation(
        &self,
        params: rmcp::model::ElicitRequestParams,
        context: rmcp::service::RequestContext<RoleClient>,
    ) -> impl Future<Output = Result<rmcp::model::ElicitResult, rmcp::ErrorData>>
           + rmcp::service::MaybeSendFuture
           + '_ {
        let _ = (params, context);
        std::future::ready(Err(rmcp::ErrorData::method_not_found::<
            rmcp::model::ElicitationCreateRequestMethod,
        >()))
    }
}

fn http_transport_config(
    client: &GuardedStreamableHttpClient,
) -> StreamableHttpClientTransportConfig {
    let mut config =
        StreamableHttpClientTransportConfig::with_uri(client.endpoint.url.as_str().to_owned());
    config.custom_headers = (*client.user_headers).clone();
    config.max_sse_event_size = MAX_SSE_EVENT_BYTES;
    // rmcp replays the saved initialize handshake after an expired-session
    // 404. That request was never accepted (unknown session), so this is not
    // tool-call replay; one bounded recovery attempt keeps long sessions alive.
    config.reinit_on_expired_session = true;
    config
}

fn startup_failure(server_name: &str, label: &str, detail: impl fmt::Display) -> CommandError {
    command_error(format!(
        "Failed to connect to Streamable HTTP MCP server '{server_name}' during {label}: {detail}"
    ))
}

trait HttpClientRuntimeInfo {
    fn operation_timeout(&self) -> Duration;
    fn server_name(&self) -> &str;
}

macro_rules! impl_http_client_runtime_info {
    ($($ty:ty),*) => {$(
        impl HttpClientRuntimeInfo for $ty {
            fn operation_timeout(&self) -> Duration {
                self.operation_timeout
            }
            fn server_name(&self) -> &str {
                &self.server_name
            }
        }
    )*};
}

async fn run_bounded<T>(
    info: &(impl HttpClientRuntimeInfo + Sync),
    label: &'static str,
    operation: impl Future<Output = Result<T, ServiceError>>,
) -> CommandResult<T> {
    let timeout = info.operation_timeout();
    let server_name = info.server_name().to_string();
    match tokio::time::timeout(timeout, operation).await {
        Ok(result) => result.map_err(|error| map_service_error(&server_name, label, error)),
        Err(_) => Err(command_error(format!(
            "Streamable HTTP MCP server '{server_name}' timed out during {label} after {timeout:?}."
        ))),
    }
}

fn map_service_error(server_name: &str, label: &'static str, error: ServiceError) -> CommandError {
    match error {
        ServiceError::TransportClosed => command_error(format!(
            "Streamable HTTP MCP server '{server_name}' closed the connection during {label}."
        )),
        ServiceError::Timeout { timeout } => command_error(format!(
            "Streamable HTTP MCP server '{server_name}' timed out during {label} after {timeout:?}."
        )),
        ServiceError::Cancelled { reason } => command_error(format!(
            "Streamable HTTP MCP server '{server_name}' cancelled {label}: {}.",
            reason.as_deref().unwrap_or("no reason given")
        )),
        other => command_error(format!(
            "Streamable HTTP MCP server '{server_name}' failed {label}: {other}"
        )),
    }
}

fn tools_to_dtos(server_id: &str, tools: &[Tool]) -> Vec<McpToolDto> {
    tools
        .iter()
        .map(|tool| McpToolDto {
            id: build_mcp_tool_id(server_id, tool.name.as_ref()),
            server_id: server_id.to_string(),
            name: tool.name.to_string(),
            description: tool.description.as_ref().map(|value| value.to_string()),
            input_schema: Value::Object((*tool.input_schema).clone()),
            enabled: true,
        })
        .collect()
}

fn build_call_params(
    tool_name: &str,
    arguments: Value,
) -> CommandResult<rmcp::model::CallToolRequestParams> {
    let arguments = match arguments {
        Value::Null => None,
        Value::Object(map) => Some(map),
        other => {
            return Err(command_error(format!(
                "MCP tool arguments must be a JSON object, got {other}"
            )));
        }
    };
    let mut params = rmcp::model::CallToolRequestParams::new(tool_name.to_string());
    params.arguments = arguments;
    Ok(params)
}

async fn shutdown_service(
    mut service: RunningService<RoleClient, ClosedCapabilityHttpClientHandler>,
    server_name: &str,
) {
    match service.close_with_timeout(SERVICE_CLOSE_BUDGET).await {
        Ok(Some(_)) => {}
        Ok(None) => tracing::warn!(
            server = %server_name,
            "MCP HTTP service cleanup exceeded its close budget"
        ),
        Err(error) => tracing::warn!(
            server = %server_name,
            error = %error,
            "MCP HTTP service task failed during shutdown"
        ),
    }
}

/// Persistent legacy-era Streamable HTTP client: performs `initialize`, keeps
/// `Mcp-Session-Id`, and drains JSON or SSE-linked replies through the
/// official SDK lifecycle.
pub(crate) struct RmcpLegacyHttpClient {
    service: RunningService<RoleClient, ClosedCapabilityHttpClientHandler>,
    server_id: String,
    server_name: String,
    negotiated_version: String,
    operation_timeout: Duration,
}

impl RmcpLegacyHttpClient {
    pub(crate) async fn connect(
        client: GuardedStreamableHttpClient,
        server_id: String,
        server_name: String,
        startup_timeout: Option<Duration>,
        operation_timeout: Option<Duration>,
    ) -> CommandResult<Self> {
        let transport = StreamableHttpClientTransport::with_client(
            client.clone(),
            http_transport_config(&client),
        );
        let handler = ClosedCapabilityHttpClientHandler::legacy();
        let startup = startup_timeout.unwrap_or(DEFAULT_STARTUP_TIMEOUT);
        let handshake = handler.serve_with_lifecycle(transport, ClientLifecycleMode::Initialize);
        let service = match tokio::time::timeout(startup, handshake).await {
            Ok(Ok(service)) => service,
            Ok(Err(error)) => return Err(startup_failure(&server_name, "initialize", error)),
            Err(_) => {
                return Err(startup_failure(
                    &server_name,
                    "initialize",
                    format!("timed out after {startup:?}"),
                ));
            }
        };
        // Observed state belongs to Macro's runtime (plan §4.3): disable the
        // SDK's implicit stale-on-error response cache like the stdio adapter.
        service
            .peer()
            .set_response_cache_config(ClientCacheConfig::disabled())
            .await;
        let peer_info = service.peer().peer_info().ok_or_else(|| {
            startup_failure(
                &server_name,
                "initialize",
                "handshake produced no server metadata",
            )
        })?;
        let negotiated_version = peer_info.protocol_version.as_str().to_string();
        if !KNOWN_LEGACY_PROTOCOL_VERSIONS.contains(&negotiated_version.as_str()) {
            let mut service = service;
            let _ = service.close_with_timeout(SERVICE_CLOSE_BUDGET).await;
            return Err(command_error(format!(
                "Streamable HTTP MCP server '{server_name}' negotiated unsupported protocol \
                 version '{negotiated_version}'. Macro supports: {}.",
                KNOWN_LEGACY_PROTOCOL_VERSIONS.join(", ")
            )));
        }
        Ok(Self {
            service,
            server_id,
            server_name,
            negotiated_version,
            operation_timeout: operation_timeout.unwrap_or(DEFAULT_OPERATION_TIMEOUT),
        })
    }

    pub(crate) fn negotiated_protocol_version(&self) -> &str {
        &self.negotiated_version
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.service.is_closed() || self.service.peer().is_transport_closed()
    }

    /// One `tools/list` page mapped onto Macro DTOs; page-count and cumulative
    /// catalog budgets stay enforced by the runtime manager above.
    pub(crate) async fn list_tools_page(
        &self,
        cursor: Option<String>,
    ) -> CommandResult<super::rmcp_adapter::McpToolPageDto> {
        let params = PaginatedRequestParams::default().with_cursor(cursor);
        let result = run_bounded(self, "tools/list", async move {
            self.service.peer().list_tools(Some(params)).await
        })
        .await?;
        Ok(super::rmcp_adapter::McpToolPageDto {
            tools: tools_to_dtos(&self.server_id, result.tools.as_ref()),
            next_cursor: result.next_cursor,
        })
    }

    pub(crate) async fn call_tool(
        &self,
        tool_name: &str,
        arguments: Value,
    ) -> CommandResult<McpCallToolResponse> {
        let params = build_call_params(tool_name, arguments)?;
        let response = run_bounded(self, "tools/call", async move {
            self.service.peer().call_tool_once(params).await
        })
        .await?;
        match response {
            CallToolResponse::Complete(result) => {
                let raw_result = serde_json::to_value(&result).unwrap_or(Value::Null);
                Ok(McpCallToolResponse {
                    content: format_tool_call_result(&raw_result),
                    is_error: result.is_error.unwrap_or(false),
                    raw_result,
                })
            }
            CallToolResponse::InputRequired(_) => Err(command_error(format!(
                "Streamable HTTP MCP server '{}' requires interaction rounds; \
                 interaction brokering arrives with plan Lot G.",
                self.server_name
            ))),
            CallToolResponse::Task(_) => Err(command_error(format!(
                "Streamable HTTP MCP server '{}' returned a task result; \
                 task materialization arrives with plan Lot G.",
                self.server_name
            ))),
            _ => Err(command_error(format!(
                "Streamable HTTP MCP server '{}' returned an unexpected tools/call kind.",
                self.server_name
            ))),
        }
    }

    pub(crate) async fn shutdown(self) {
        shutdown_service(self.service, &self.server_name).await;
    }
}

impl_http_client_runtime_info!(RmcpLegacyHttpClient);

/// Persistent modern-era Streamable HTTP client: strict `server/discover`
/// lifecycle with stateless autonomous requests carrying per-request MCP
/// metadata. It never sends `initialize`.
pub(crate) struct RmcpModernHttpClient {
    service: RunningService<RoleClient, ClosedCapabilityHttpClientHandler>,
    server_id: String,
    server_name: String,
    metadata: McpModernServerMetadata,
    operation_timeout: Duration,
}

impl RmcpModernHttpClient {
    pub(crate) async fn connect(
        client: GuardedStreamableHttpClient,
        server_id: String,
        server_name: String,
        startup_timeout: Option<Duration>,
        operation_timeout: Option<Duration>,
    ) -> CommandResult<Self> {
        let transport = StreamableHttpClientTransport::with_client(
            client.clone(),
            http_transport_config(&client),
        );
        let handler = ClosedCapabilityHttpClientHandler::modern();
        let startup = startup_timeout.unwrap_or(DEFAULT_STARTUP_TIMEOUT);
        let handshake = handler.serve_with_lifecycle(
            transport,
            ClientLifecycleMode::Discover {
                preferred_versions: vec![ProtocolVersion::V_2026_07_28],
            },
        );
        let service = match tokio::time::timeout(startup, handshake).await {
            Ok(Ok(service)) => service,
            Ok(Err(error)) => {
                return Err(startup_failure(&server_name, "server/discover", error));
            }
            Err(_) => {
                return Err(startup_failure(
                    &server_name,
                    "server/discover",
                    format!("timed out after {startup:?}"),
                ));
            }
        };
        service
            .peer()
            .set_response_cache_config(ClientCacheConfig::disabled())
            .await;
        let peer_info = service.peer().peer_info().ok_or_else(|| {
            startup_failure(
                &server_name,
                "server/discover",
                "discovery produced no metadata",
            )
        })?;
        if peer_info.protocol_version != ProtocolVersion::V_2026_07_28 {
            let negotiated = peer_info.protocol_version.as_str().to_owned();
            let mut service = service;
            let _ = service.close_with_timeout(SERVICE_CLOSE_BUDGET).await;
            return Err(command_error(format!(
                "Streamable HTTP MCP server '{server_name}' negotiated '{negotiated}' in strict \
                 modern mode; expected '{MODERN_PROTOCOL_VERSION}'."
            )));
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
            server_id,
            server_name,
            metadata,
            operation_timeout: operation_timeout.unwrap_or(DEFAULT_OPERATION_TIMEOUT),
        })
    }

    pub(crate) fn server_metadata(&self) -> &McpModernServerMetadata {
        &self.metadata
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.service.is_closed() || self.service.peer().is_transport_closed()
    }

    pub(crate) async fn list_tools_page(
        &self,
        cursor: Option<String>,
    ) -> CommandResult<super::rmcp_adapter::McpToolPageDto> {
        let params = PaginatedRequestParams::default().with_cursor(cursor);
        let result = run_bounded(self, "tools/list", async move {
            self.service.list_tools(Some(params)).await
        })
        .await?;
        Ok(super::rmcp_adapter::McpToolPageDto {
            tools: tools_to_dtos(&self.server_id, result.tools.as_ref()),
            next_cursor: result.next_cursor,
        })
    }

    /// Sends exactly one modern tool round. MRTR continuation stays with the
    /// interaction broker; nothing here ever replays an accepted call.
    pub(crate) async fn call_tool_complete(
        &self,
        tool_name: &str,
        arguments: Value,
    ) -> CommandResult<McpCallToolResponse> {
        let params = build_call_params(tool_name, arguments)?;
        let response = run_bounded(self, "tools/call", async move {
            self.service.call_tool_once(params).await
        })
        .await?;
        match response {
            CallToolResponse::Complete(result) => {
                let raw_result = serde_json::to_value(&result).unwrap_or(Value::Null);
                Ok(McpCallToolResponse {
                    content: format_tool_call_result(&raw_result),
                    is_error: result.is_error.unwrap_or(false),
                    raw_result,
                })
            }
            CallToolResponse::InputRequired(_) => Err(command_error(format!(
                "Streamable HTTP MCP server '{}' requested an interaction round; \
                 interaction brokering arrives with plan Lot G.",
                self.server_name
            ))),
            CallToolResponse::Task(_) => Err(command_error(format!(
                "Streamable HTTP MCP server '{}' materialized a task; \
                 task support arrives with plan Lot G.",
                self.server_name
            ))),
            _ => Err(command_error(format!(
                "Streamable HTTP MCP server '{}' returned an unexpected tools/call kind.",
                self.server_name
            ))),
        }
    }

    pub(crate) async fn shutdown(self) {
        shutdown_service(self.service, &self.server_name).await;
    }
}

impl_http_client_runtime_info!(RmcpModernHttpClient);

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::State;
    use axum::response::{IntoResponse, Response};
    use axum::routing::post;
    use axum::{Json, Router};
    use rmcp::model::{
        DiscoverResult, EmptyObject, ErrorData, InitializeResult, ServerCapabilities,
    };
    use std::sync::Mutex as StdMutex;
    use tokio::task::JoinHandle;

    fn test_endpoint() -> ValidatedEndpoint {
        ValidatedEndpoint {
            url: Url::parse("http://127.0.0.1:43123/mcp").unwrap(),
            pinned_host: "127.0.0.1".to_string(),
            pinned_addrs: Vec::new(),
        }
    }

    #[derive(Clone, Copy)]
    enum FixtureEra {
        Legacy,
        Modern,
    }

    #[derive(Clone)]
    struct FixtureState {
        era: FixtureEra,
        methods: Arc<StdMutex<Vec<String>>>,
    }

    async fn fixture_post(
        State(state): State<FixtureState>,
        Json(message): Json<Value>,
    ) -> Response {
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("<missing>")
            .to_string();
        state
            .methods
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(method.clone());
        let Some(id_value) = message.get("id") else {
            return reqwest::StatusCode::ACCEPTED.into_response();
        };
        let id: RequestId = serde_json::from_value(id_value.clone()).unwrap();

        let response = match (state.era, method.as_str()) {
            (FixtureEra::Legacy, "initialize") => {
                let result =
                    InitializeResult::new(ServerCapabilities::builder().enable_tools().build())
                        .with_protocol_version(ProtocolVersion::V_2025_11_25)
                        .with_server_info(Implementation::new("legacy-http-fixture", "1.0.0"));
                ServerJsonRpcMessage::response(ServerResult::InitializeResult(result), id)
            }
            (FixtureEra::Modern, "server/discover") => {
                let result = DiscoverResult::new(
                    vec![ProtocolVersion::V_2026_07_28],
                    ServerCapabilities::builder().enable_tools().build(),
                )
                .with_server_info(Implementation::new("modern-http-fixture", "1.0.0"));
                ServerJsonRpcMessage::response(ServerResult::DiscoverResult(result), id)
            }
            _ => ServerJsonRpcMessage::error(
                ErrorData::new(ErrorCode::METHOD_NOT_FOUND, "method not found", None),
                Some(id),
            ),
        };
        let mut output = Json(serde_json::to_value(response).unwrap()).into_response();
        if matches!(state.era, FixtureEra::Legacy) && method == "initialize" {
            output.headers_mut().insert(
                session_header_name(),
                HeaderValue::from_static("legacy-session"),
            );
        }
        output
    }

    async fn spawn_fixture(
        era: FixtureEra,
    ) -> (String, Arc<StdMutex<Vec<String>>>, JoinHandle<()>) {
        let methods = Arc::new(StdMutex::new(Vec::new()));
        let state = FixtureState {
            era,
            methods: methods.clone(),
        };
        let app = Router::new()
            .route("/mcp", post(fixture_post))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}/mcp"), methods, task)
    }

    #[tokio::test]
    async fn endpoint_policy_accepts_loopback_and_rejects_private_literals() {
        assert!(validate_endpoint("http://127.0.0.1:43123/mcp")
            .await
            .is_ok());
        assert!(validate_endpoint("http://[::1]:43123/mcp").await.is_ok());

        for forbidden in [
            "http://10.0.0.1/mcp",
            "http://169.254.169.254/latest/meta-data",
            "http://172.16.0.1/mcp",
            "http://192.168.1.1/mcp",
        ] {
            assert!(validate_endpoint(forbidden).await.is_err(), "{forbidden}");
        }
    }

    #[tokio::test]
    async fn strict_http_lifecycles_use_initialize_only_for_legacy() {
        let (legacy_url, legacy_methods, legacy_server) = spawn_fixture(FixtureEra::Legacy).await;
        let legacy_endpoint = validate_endpoint(&legacy_url).await.unwrap();
        let legacy_transport =
            GuardedStreamableHttpClient::new(legacy_endpoint, HashMap::new(), None).unwrap();
        let legacy = RmcpLegacyHttpClient::connect(
            legacy_transport,
            "legacy".to_string(),
            "Legacy fixture".to_string(),
            Some(Duration::from_secs(2)),
            Some(Duration::from_secs(2)),
        )
        .await
        .unwrap();
        assert_eq!(legacy.negotiated_protocol_version(), "2025-11-25");
        legacy.shutdown().await;
        let legacy_calls = legacy_methods
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        assert!(legacy_calls.iter().any(|method| method == "initialize"));
        assert!(legacy_calls
            .iter()
            .any(|method| method == "notifications/initialized"));
        assert!(!legacy_calls
            .iter()
            .any(|method| method == "server/discover"));
        legacy_server.abort();

        let (modern_url, modern_methods, modern_server) = spawn_fixture(FixtureEra::Modern).await;
        let modern_endpoint = validate_endpoint(&modern_url).await.unwrap();
        let modern_transport =
            GuardedStreamableHttpClient::new(modern_endpoint, HashMap::new(), None).unwrap();
        let modern = RmcpModernHttpClient::connect(
            modern_transport,
            "modern".to_string(),
            "Modern fixture".to_string(),
            Some(Duration::from_secs(2)),
            Some(Duration::from_secs(2)),
        )
        .await
        .unwrap();
        assert_eq!(
            modern.server_metadata().negotiated_protocol_version,
            MODERN_PROTOCOL_VERSION
        );
        modern.shutdown().await;
        let modern_calls = modern_methods
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        assert_eq!(modern_calls, vec!["server/discover"]);
        modern_server.abort();
    }

    #[test]
    fn transport_cannot_override_the_validated_endpoint() {
        let client = GuardedStreamableHttpClient::new(test_endpoint(), HashMap::new(), None)
            .expect("build guarded client");
        assert!(client
            .validate_transport_uri("http://127.0.0.1:43123/mcp")
            .is_ok());
        assert!(client
            .validate_transport_uri("http://127.0.0.1:43123/other")
            .is_err());
        assert!(client
            .validate_transport_uri("https://attacker.example/mcp")
            .is_err());
    }

    #[test]
    fn runtime_headers_override_user_and_protocol_values() {
        let mut user = HashMap::new();
        user.insert(
            HeaderName::from_static("authorization"),
            HeaderValue::from_static("Bearer user"),
        );
        user.insert(
            HeaderName::from_static("x-custom"),
            HeaderValue::from_static("user"),
        );
        let mut protocol = HashMap::new();
        protocol.insert(
            HeaderName::from_static("x-custom"),
            HeaderValue::from_static("protocol"),
        );

        let headers = build_request_header_map(
            &user,
            &protocol,
            ForcedRequestHeaders {
                accept: ACCEPT_MIME_TYPES,
                json_content_type: true,
                auth_token: Some("runtime".to_string()),
                session_id: Some("session".to_string()),
            },
        )
        .unwrap();

        assert_eq!(headers[http::header::AUTHORIZATION], "Bearer runtime");
        assert_eq!(headers["x-custom"], "protocol");
        assert_eq!(headers[session_header_name()], "session");
        assert_eq!(headers[http::header::CONTENT_TYPE], JSON_MIME_TYPE);
    }

    #[test]
    fn modern_probe_requires_a_correlated_discovery_result() {
        let request_id = RequestId::Number(41);
        let result = DiscoverResult::new(
            vec![ProtocolVersion::V_2026_07_28],
            ServerCapabilities::default(),
        );
        let response = ServerJsonRpcMessage::response(
            ServerResult::DiscoverResult(result),
            request_id.clone(),
        );
        let body = serde_json::to_vec(&response).unwrap();
        assert_eq!(
            classify_probe_payload(&body, true, &request_id),
            ProbeVerdict::Modern
        );

        let wrong_id = RequestId::Number(42);
        assert!(matches!(
            classify_probe_payload(&body, true, &wrong_id),
            ProbeVerdict::Fatal { .. }
        ));

        let non_discovery = ServerJsonRpcMessage::response(
            ServerResult::EmptyResult(EmptyObject {}),
            request_id.clone(),
        );
        assert!(matches!(
            classify_probe_payload(
                &serde_json::to_vec(&non_discovery).unwrap(),
                true,
                &request_id
            ),
            ProbeVerdict::Fatal { .. }
        ));
    }

    #[test]
    fn probe_falls_back_only_for_explicit_legacy_evidence() {
        let request_id = RequestId::Number(7);
        let method_not_found = ServerJsonRpcMessage::error(
            ErrorData::new(ErrorCode::METHOD_NOT_FOUND, "unknown", None),
            Some(request_id.clone()),
        );
        let body = serde_json::to_vec(&method_not_found).unwrap();
        assert!(matches!(
            classify_probe_status(
                reqwest::StatusCode::BAD_REQUEST,
                Some(JSON_MIME_TYPE),
                &body,
                &request_id
            ),
            ProbeVerdict::LegacySafe { .. }
        ));
        assert!(matches!(
            classify_probe_status(reqwest::StatusCode::BAD_REQUEST, None, b"  ", &request_id),
            ProbeVerdict::LegacySafe { .. }
        ));

        for status in [
            reqwest::StatusCode::UNAUTHORIZED,
            reqwest::StatusCode::FORBIDDEN,
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
        ] {
            assert!(matches!(
                classify_probe_status(status, None, b"", &request_id),
                ProbeVerdict::Fatal { .. }
            ));
        }
    }

    #[test]
    fn sse_probe_stops_at_the_first_complete_event() {
        let first = b"id: 1\r\ndata: {\"jsonrpc\":\"2.0\"}\r\n\r\n";
        let mut stream = first.to_vec();
        stream.extend_from_slice(b"id: 2\ndata: ignored\n\n");
        assert_eq!(first_sse_event_end(&stream), Some(first.len()));
        assert_eq!(
            first_sse_data_payload(&stream),
            Some(br#"{"jsonrpc":"2.0"}"#.to_vec())
        );
    }

    #[test]
    fn sse_event_limit_rejects_oversized_payloads_and_resets() {
        let mut limit = SseEventSizeLimit::new(12);
        limit.observe(b"data: short\n\n").unwrap();
        assert!(limit.observe(b"data: this-is-too-long").is_err());

        let mut comments = SseEventSizeLimit::new(64);
        comments
            .observe(b": a long heartbeat comment\n\ndata: ok\n\n")
            .unwrap();
    }
}
