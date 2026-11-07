//! Dedicated captured-server transport for AgSDL030. Existing UI clients keep
//! their formatting, connection selection and timeout behavior unchanged.
//! Raw JSON tokens never pass through a floating-point representation.
use std::{
    collections::{BTreeMap, VecDeque},
    net::SocketAddr,
    path::PathBuf,
    process::Stdio,
    time::Duration,
};

use serde::Serialize;
use serde_json::value::RawValue;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use crate::agsdl_host_calls::{
    CallError, CallIdentity, CommandGrant, Control, HostPort, PhysicalEvidence, Result,
};
use crate::core::process::ContainedBackgroundProcess;

#[derive(Clone, Copy)]
pub(crate) enum Protocol {
    Legacy,
    Modern,
}

/// Resolved native capture. Callers must authorize every frozen IP, including
/// private/loopback endpoints, before constructing this value. No proxy, redirect,
/// DNS rebinding, reconnect, automatic retry or global UI lookup occurs here.
pub(crate) struct HttpServer {
    pub url: url::Url,
    pub addresses: Vec<SocketAddr>,
    pub headers: reqwest::header::HeaderMap,
}
pub(crate) struct StdioServer {
    pub program: PathBuf,
    pub arguments: Vec<String>,
    pub grant: CommandGrant,
}
pub(crate) enum ServerTransport {
    Stdio(StdioServer),
    Http(HttpServer),
}
pub(crate) struct CapturedServer {
    pub document_name: String,
    pub capture_digest: String,
    pub protocol: Protocol,
    pub transport: ServerTransport,
}
impl CapturedServer {
    pub(crate) fn name(&self) -> &str {
        &self.document_name
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpReceipt {
    pub is_error: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structured_content_json: Option<String>,
    pub text: String,
    pub raw_result_json: String,
}

/// Reject ambiguous envelopes; preserve each value's original JSON bytes.
fn object(json: &str) -> Result<BTreeMap<String, Box<RawValue>>> {
    struct ObjectVisitor;
    impl<'de> serde::de::Visitor<'de> for ObjectVisitor {
        type Value = BTreeMap<String, Box<RawValue>>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("an object without duplicate keys")
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut map: A,
        ) -> std::result::Result<Self::Value, A::Error> {
            let mut result = BTreeMap::new();
            while let Some((key, value)) = map.next_entry::<String, Box<RawValue>>()? {
                if result.insert(key, value).is_some() {
                    return Err(serde::de::Error::custom("duplicate JSON key"));
                }
            }
            Ok(result)
        }
    }
    let mut parser = serde_json::Deserializer::from_str(json);
    let value = serde::de::Deserializer::deserialize_map(&mut parser, ObjectVisitor)
        .map_err(|e| CallError::transport(format!("Invalid MCP object: {e}")))?;
    parser
        .end()
        .map_err(|e| CallError::transport(e.to_string()))?;
    Ok(value)
}
fn string(value: &RawValue) -> Result<String> {
    serde_json::from_str(value.get())
        .map_err(|e| CallError::transport(format!("Invalid MCP string: {e}")))
}
fn encode<T: Serialize>(value: &T) -> Result<String> {
    serde_json::to_string(value).map_err(|e| CallError::transport(e.to_string()))
}

pub(crate) fn receipt(raw: String) -> Result<McpReceipt> {
    let fields = object(&raw)?;
    let is_error = fields
        .get("isError")
        .map(|v| serde_json::from_str::<bool>(v.get()))
        .transpose()
        .map_err(|_| CallError::transport("MCP isError is not a boolean"))?
        .unwrap_or(false);
    let structured_content_json = fields.get("structuredContent").map(|v| v.get().to_owned());
    let mut texts = Vec::new();
    if let Some(content) = fields.get("content") {
        let blocks: Vec<Box<RawValue>> = serde_json::from_str(content.get())
            .map_err(|e| CallError::transport(format!("Invalid MCP content: {e}")))?;
        for block in blocks {
            let item = object(block.get())?;
            if item.get("type").map(|v| string(v)).transpose()?.as_deref() == Some("text") {
                texts.push(string(
                    item.get("text")
                        .ok_or_else(|| CallError::transport("Missing MCP text"))?,
                )?);
            }
        }
    }
    if !fields.contains_key("content") && structured_content_json.is_none() {
        return Err(CallError::transport(
            "MCP result has neither content nor structuredContent",
        ));
    }
    Ok(McpReceipt {
        is_error,
        structured_content_json,
        text: texts.join("\n"),
        raw_result_json: raw,
    })
}

pub(crate) struct Session {
    server: String,
    protocol: Protocol,
    next_id: u64,
    wire: Wire,
}
enum Wire {
    Stdio {
        process: ContainedBackgroundProcess,
        stdin: tokio::process::ChildStdin,
        stdout: BufReader<tokio::process::ChildStdout>,
        stderr: tokio::task::JoinHandle<std::io::Result<()>>,
        policy_digest: String,
        profile_digest: String,
    },
    Http(HttpWire),
}
struct HttpWire {
    client: reqwest::Client,
    url: url::Url,
    headers: reqwest::header::HeaderMap,
    session: Option<String>,
    version: &'static str,
    responses: VecDeque<Body>,
}
struct Body {
    response: reqwest::Response,
    buffer: Vec<u8>,
    sse: bool,
    eof: bool,
}

pub(crate) fn start(server: CapturedServer) -> Result<Session> {
    if server.document_name.is_empty() || server.capture_digest.is_empty() {
        return Err(CallError::new(
            "CORRELATION",
            "MCP server is not a captured document definition",
        ));
    }
    let wire = match server.transport {
        ServerTransport::Stdio(config) => {
            let policy = &config.grant.sandbox;
            let mut command = policy
                .command(
                    &config.program,
                    &config.arguments,
                    &config.grant.workspace,
                    &config.grant.environment,
                )
                .map_err(CallError::transport)?;
            command.stdin(Stdio::piped());
            let mut process = ContainedBackgroundProcess::spawn(command)
                .map_err(|e| CallError::transport(e.to_string()))?;
            let stdin = process.take_stdin().expect("piped MCP stdin");
            let stdout = BufReader::new(process.take_stdout().expect("piped MCP stdout"));
            let mut stderr = process.take_stderr().expect("piped MCP stderr");
            let stderr = tokio::spawn(async move {
                // Server diagnostics are not normative tool results; drain without
                // retaining secrets or unbounded unrelated log output.
                let mut buffer = [0; 8192];
                while stderr.read(&mut buffer).await? != 0 {}
                Ok(())
            });
            Wire::Stdio {
                process,
                stdin,
                stdout,
                stderr,
                policy_digest: policy.policy_digest().into(),
                profile_digest: policy.profile_digest().into(),
            }
        }
        ServerTransport::Http(config) => {
            if !matches!(config.url.scheme(), "http" | "https")
                || !config.url.username().is_empty()
                || config.url.password().is_some()
                || config.url.fragment().is_some()
                || config.addresses.is_empty()
            {
                return Err(CallError::transport(
                    "MCP endpoint must have an authorized HTTP URL and frozen addresses",
                ));
            }
            let host = config
                .url
                .host_str()
                .ok_or_else(|| CallError::transport("MCP endpoint has no host"))?;
            let port = config
                .url
                .port_or_known_default()
                .ok_or_else(|| CallError::transport("MCP endpoint has no port"))?;
            if config
                .addresses
                .iter()
                .any(|address| address.port() != port)
            {
                return Err(CallError::new(
                    "CORRELATION",
                    "Captured MCP address port differs from endpoint",
                ));
            }
            if let Ok(literal) = host
                .trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<std::net::IpAddr>()
            {
                if config
                    .addresses
                    .iter()
                    .any(|address| address.ip() != literal)
                {
                    return Err(CallError::new(
                        "CORRELATION",
                        "MCP IP literal differs from captured addresses",
                    ));
                }
            }
            let pinned: Vec<_> = config
                .addresses
                .iter()
                .map(|address| SocketAddr::new(address.ip(), 0))
                .collect();
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .resolve_to_addrs(host, &pinned)
                .build()
                .map_err(|e| CallError::transport(e.to_string()))?;
            let mut headers = config.headers;
            // Prevent capture headers from overriding protocol-controlled values.
            for key in [
                "host",
                "content-length",
                "accept",
                "content-type",
                "mcp-session-id",
                "mcp-protocol-version",
                "last-event-id",
                "connection",
                "transfer-encoding",
                "upgrade",
                "mcp-method",
                "mcp-name",
            ] {
                headers.remove(key);
            }
            let reserved: Vec<_> = headers
                .keys()
                .filter(|name| name.as_str().starts_with("mcp-param-"))
                .cloned()
                .collect();
            for name in reserved {
                headers.remove(name);
            }
            Wire::Http(HttpWire {
                client,
                url: config.url,
                headers,
                session: None,
                version: match server.protocol {
                    Protocol::Legacy => "2025-11-25",
                    Protocol::Modern => "2026-07-28",
                },
                responses: VecDeque::new(),
            })
        }
    };
    Ok(Session {
        server: server.document_name,
        protocol: server.protocol,
        next_id: 1,
        wire,
    })
}

impl Session {
    pub(crate) async fn call(
        &mut self,
        tool: &str,
        args: &str,
        host: &dyn HostPort,
        identity: &CallIdentity,
        control: &Control,
    ) -> Result<McpReceipt> {
        object(args)?;
        let startup = match self.protocol {
            Protocol::Legacy => self.rpc("initialize", r#"{"protocolVersion":"2025-11-25","capabilities":{"elicitation":{"form":{}}},"clientInfo":{"name":"Macro AgSDL","version":"0.3.0"}}"#, host, identity, control).await?,
            Protocol::Modern => self.rpc("server/discover", "{}", host, identity, control).await?,
        };
        let startup = object(&startup)?;
        let version = match self.protocol {
            Protocol::Legacy => startup
                .get("protocolVersion")
                .map(|v| string(v))
                .transpose()?
                .ok_or_else(|| CallError::transport("MCP handshake omitted protocolVersion"))?,
            Protocol::Modern => {
                let versions: Vec<String> = serde_json::from_str(
                    startup
                        .get("supportedVersions")
                        .ok_or_else(|| {
                            CallError::transport("MCP discovery omitted supportedVersions")
                        })?
                        .get(),
                )
                .map_err(|e| CallError::transport(e.to_string()))?;
                if !versions.iter().any(|v| v == "2026-07-28") {
                    return Err(CallError::transport(
                        "Captured server does not support modern MCP",
                    ));
                }
                "2026-07-28".into()
            }
        };
        match self.protocol {
            Protocol::Legacy
                if ![
                    "2024-10-07",
                    "2024-11-05",
                    "2025-03-26",
                    "2025-06-18",
                    "2025-11-25",
                ]
                .contains(&version.as_str()) =>
            {
                return Err(CallError::transport(
                    "Unsupported legacy MCP protocol version",
                ))
            }
            Protocol::Modern if version != "2026-07-28" => {
                return Err(CallError::transport(
                    "Captured modern MCP server negotiated another era",
                ))
            }
            _ => {}
        }
        if let Wire::Http(http) = &mut self.wire {
            http.version = match version.as_str() {
                "2024-10-07" => "2024-10-07",
                "2024-11-05" => "2024-11-05",
                "2025-03-26" => "2025-03-26",
                "2025-06-18" => "2025-06-18",
                "2025-11-25" => "2025-11-25",
                _ => "2026-07-28",
            };
        }
        if matches!(self.protocol, Protocol::Legacy) {
            self.send(
                r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
                control,
            )
            .await?;
        }
        let base = format!("\"name\":{},\"arguments\":{args}", encode(&tool)?);
        let mut params = format!("{{{base}}}");
        let mut continuations = 0;
        loop {
            let raw = self
                .rpc("tools/call", &params, host, identity, control)
                .await?;
            let fields = object(&raw)?;
            match fields.get("resultType").map(|v| string(v)).transpose()?.as_deref() {
                Some("input_required") => {
                    if !matches!(self.protocol, Protocol::Modern) || continuations >= 4 {
                        return Err(CallError::new("UNCERTAIN", "Unsupported MCP continuation or interaction limit exceeded"));
                    }
                    continuations += 1;
                    let state = fields.get("requestState").map(|v| string(v)).transpose()?;
                    if state.as_ref().is_some_and(|s| s.len() > 128 * 1024) {
                        return Err(CallError::transport("MCP requestState exceeds the 128 KiB limit"));
                    }
                    let requests = fields.get("inputRequests").map(|v| object(v.get())).transpose()?;
                    if state.is_none() && requests.as_ref().is_none_or(|r| r.is_empty()) {
                        return Err(CallError::transport("MCP input_required has no state or prompts"));
                    }
                    let mut extra = String::new();
                    if let Some(value) = fields.get("requestState") {
                        extra.push_str(&format!(",\"requestState\":{}", value.get()));
                    }
                    if let Some(requests) = requests.filter(|r| !r.is_empty()) {
                        for request in requests.values() {
                            let fields = object(request.get())?;
                            if fields.get("method").map(|v| string(v)).transpose()?.as_deref() != Some("elicitation/create") {
                                return Err(CallError::transport("Only MCP form elicitation is supported"));
                            }
                            let params = object(fields.get("params").ok_or_else(|| CallError::transport("MCP elicitation has no parameters"))?.get())?;
                            if !params.contains_key("requestedSchema") || params.get("mode").map(|v| string(v)).transpose()?.is_some_and(|m| m != "form") {
                                return Err(CallError::transport("Only MCP form elicitation is supported"));
                            }
                        }
                        let answers = wait_human(host, identity, &self.server, &raw, control).await?;
                        let answers_map = object(&answers)?;
                        if answers_map.len() != requests.len() || requests.keys().any(|id| !answers_map.contains_key(id)) {
                            return Err(CallError::new("CORRELATION", "MCP form answers do not match requests"));
                        }
                        extra.push_str(&format!(",\"inputResponses\":{answers}"));
                    }
                    params = format!("{{{base}{extra}}}");
                }
                Some("task") => return Err(CallError::new("UNCERTAIN", "MCP task requires a captured task completion adapter; remote effect may remain active")),
                None | Some("complete") => return receipt(raw),
                Some(_) => return Err(CallError::transport("Unknown MCP resultType")),
            }
        }
    }

    async fn send(&mut self, message: &str, control: &Control) -> Result<()> {
        control.check()?;
        tokio::select! {
            biased;
            error = control.cancelled() => Err(error),
            sent = self.wire.send(message) => sent,
        }
    }
    async fn rpc(
        &mut self,
        method: &str,
        params: &str,
        host: &dyn HostPort,
        identity: &CallIdentity,
        control: &Control,
    ) -> Result<String> {
        let id = self.next_id.to_string();
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or_else(|| CallError::transport("MCP request identity overflow"))?;
        let params = if matches!(self.protocol, Protocol::Modern) {
            let mut fields = object(params)?;
            fields.insert("_meta".into(), RawValue::from_string(r#"{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{"elicitation":{"form":{}}},"io.modelcontextprotocol/clientInfo":{"name":"Macro AgSDL","version":"0.3.0"}}"#.into()).expect("static JSON"));
            encode(&fields)?
        } else {
            params.to_owned()
        };
        self.send(
            &format!(
                "{{\"jsonrpc\":\"2.0\",\"id\":{},\"method\":{},\"params\":{params}}}",
                encode(&id)?,
                encode(&method)?
            ),
            control,
        )
        .await?;
        loop {
            let raw = tokio::select! {
                biased;
                error = control.cancelled() => return Err(error),
                raw = self.wire.receive() => raw?,
            };
            let fields = object(&raw)?;
            if fields
                .get("jsonrpc")
                .map(|v| string(v))
                .transpose()?
                .as_deref()
                != Some("2.0")
            {
                return Err(CallError::transport("Invalid MCP JSON-RPC version"));
            }
            if let Some(method) = fields.get("method") {
                let method = string(method)?;
                if let Some(request_id) = fields.get("id") {
                    let response = if method == "elicitation/create" {
                        let answer =
                            wait_human(host, identity, &self.server, &raw, control).await?;
                        object(&answer)?;
                        format!("\"result\":{answer}")
                    } else if method == "ping" {
                        "\"result\":{}".into()
                    } else {
                        "\"error\":{\"code\":-32601,\"message\":\"Method not supported by this captured call\"}".into()
                    };
                    self.send(
                        &format!(
                            "{{\"jsonrpc\":\"2.0\",\"id\":{},{response}}}",
                            request_id.get()
                        ),
                        control,
                    )
                    .await?;
                }
                continue;
            }
            if fields.get("id").map(|v| string(v)).transpose()?.as_deref() != Some(&id) {
                return Err(CallError::new(
                    "CORRELATION",
                    "MCP response belongs to another request",
                ));
            }
            if fields.contains_key("error") {
                return Err(CallError::transport("MCP returned a JSON-RPC error"));
            }
            return fields
                .get("result")
                .map(|v| v.get().to_owned())
                .ok_or_else(|| CallError::transport("MCP response has no result"));
        }
    }

    pub(crate) async fn shutdown(self, received: bool) -> (PhysicalEvidence, Option<CallError>) {
        match self.wire {
            Wire::Http(_) => (
                PhysicalEvidence::Remote {
                    response_received: received,
                    termination_proven: false,
                },
                None,
            ),
            Wire::Stdio {
                mut process,
                stdin,
                stdout,
                mut stderr,
                policy_digest,
                profile_digest,
            } => {
                drop(stdin);
                drop(stdout);
                let ended = process.terminate_bounded().await;
                let drained = tokio::time::timeout(Duration::from_secs(5), &mut stderr).await;
                let streams_joined = matches!(drained, Ok(Ok(Ok(()))));
                if !streams_joined {
                    stderr.abort();
                    let _ = stderr.await;
                }
                let evidence = PhysicalEvidence::Local {
                    policy_digest,
                    profile_digest,
                    leader_reaped: ended.is_ok(),
                    tree_termination_succeeded: ended.is_ok(),
                    streams_joined,
                };
                let failure = if ended.is_err() || !streams_joined {
                    Some(CallError::new(
                        "UNCERTAIN",
                        "MCP local process cleanup was not attested",
                    ))
                } else {
                    None
                };
                (evidence, failure)
            }
        }
    }
}

async fn wait_human(
    host: &dyn HostPort,
    identity: &CallIdentity,
    server: &str,
    raw: &str,
    control: &Control,
) -> Result<String> {
    control.check()?;
    let ticket = host.human_open(identity, server, raw).await?;
    let answer = tokio::select! {
        biased;
        error = control.cancelled() => Err(error),
        answer = host.human_answer(&ticket) => answer,
    };
    host.human_close(&ticket, &answer).await?;
    answer
}

impl Wire {
    async fn send(&mut self, message: &str) -> Result<()> {
        match self {
            Wire::Stdio { stdin, .. } => {
                stdin
                    .write_all(message.as_bytes())
                    .await
                    .map_err(|e| CallError::transport(e.to_string()))?;
                stdin
                    .write_all(b"\n")
                    .await
                    .map_err(|e| CallError::transport(e.to_string()))?;
                stdin
                    .flush()
                    .await
                    .map_err(|e| CallError::transport(e.to_string()))
            }
            Wire::Http(http) => {
                let mut request = http
                    .client
                    .post(http.url.clone())
                    .headers(http.headers.clone())
                    .header("accept", "application/json, text/event-stream")
                    .header("content-type", "application/json")
                    .header("mcp-protocol-version", http.version)
                    .body(message.to_owned());
                if let Some(session) = &http.session {
                    request = request.header("mcp-session-id", session);
                }
                if http.version == "2026-07-28" {
                    let message_fields = object(message)?;
                    if let Some(method) = message_fields.get("method") {
                        let method = string(method)?;
                        request = request.header("mcp-method", &method);
                        if method == "tools/call" {
                            let params = object(
                                message_fields
                                    .get("params")
                                    .ok_or_else(|| CallError::transport("MCP call has no params"))?
                                    .get(),
                            )?;
                            let name =
                                string(params.get("name").ok_or_else(|| {
                                    CallError::transport("MCP call has no name")
                                })?)?;
                            let bytes = name.as_bytes();
                            let wrap = bytes.first().is_some_and(|b| matches!(b, b' ' | b'\t'))
                                || bytes.last().is_some_and(|b| matches!(b, b' ' | b'\t'))
                                || bytes.iter().any(|b| *b < 0x20 || *b > 0x7e)
                                || (name.starts_with("=?base64?") && name.ends_with("?="));
                            let name = if wrap {
                                use base64::Engine;
                                format!(
                                    "=?base64?{}?=",
                                    base64::engine::general_purpose::STANDARD.encode(name)
                                )
                            } else {
                                name
                            };
                            request = request.header("mcp-name", name);
                        }
                    }
                }
                let response = request
                    .send()
                    .await
                    .map_err(|e| CallError::transport(e.to_string()))?;
                if !response.status().is_success() {
                    return Err(CallError::transport(format!(
                        "Captured MCP HTTP returned {} without replay",
                        response.status()
                    )));
                }
                if let Some(session) = response.headers().get("mcp-session-id") {
                    let session = session
                        .to_str()
                        .map_err(|_| CallError::transport("Invalid MCP session header"))?;
                    if http
                        .session
                        .as_deref()
                        .is_some_and(|previous| previous != session)
                    {
                        return Err(CallError::new(
                            "CORRELATION",
                            "MCP server changed its captured session",
                        ));
                    }
                    http.session = Some(session.into());
                }
                if response.status() == reqwest::StatusCode::ACCEPTED
                    || response.status() == reqwest::StatusCode::NO_CONTENT
                {
                    return Ok(());
                }
                let kind = response
                    .headers()
                    .get("content-type")
                    .and_then(|h| h.to_str().ok())
                    .unwrap_or("")
                    .split(';')
                    .next()
                    .unwrap_or("")
                    .trim();
                let sse = match kind {
                    "application/json" => false,
                    "text/event-stream" => true,
                    _ => return Err(CallError::transport("Unsupported MCP HTTP content type")),
                };
                http.responses.push_back(Body {
                    response,
                    buffer: Vec::new(),
                    sse,
                    eof: false,
                });
                Ok(())
            }
        }
    }
    async fn receive(&mut self) -> Result<String> {
        match self {
            Wire::Stdio { stdout, .. } => {
                let mut bytes = Vec::new();
                let count = stdout
                    .read_until(b'\n', &mut bytes)
                    .await
                    .map_err(|e| CallError::transport(e.to_string()))?;
                if count == 0 || bytes.last() != Some(&b'\n') {
                    return Err(CallError::transport(
                        "MCP stdio ended without a complete frame",
                    ));
                }
                String::from_utf8(bytes)
                    .map_err(|_| CallError::transport("MCP stdio frame is not UTF-8"))
            }
            Wire::Http(http) => loop {
                let body = http.responses.front_mut().ok_or_else(|| {
                    CallError::transport(
                        "MCP HTTP has no response stream; effect will not be retried",
                    )
                })?;
                if let Some(value) = body.next().await? {
                    return Ok(value);
                }
                http.responses.pop_front();
            },
        }
    }
}
impl Body {
    async fn next(&mut self) -> Result<Option<String>> {
        loop {
            if self.sse {
                // SSE LF and CRLF framing; data fields join with LF. Heartbeats
                // and non-message events do not fabricate a JSON-RPC response.
                let end = self
                    .buffer
                    .windows(2)
                    .position(|w| w == b"\n\n")
                    .map(|p| (p, 2))
                    .into_iter()
                    .chain(
                        self.buffer
                            .windows(4)
                            .position(|w| w == b"\r\n\r\n")
                            .map(|p| (p, 4)),
                    )
                    .min_by_key(|v| v.0);
                if let Some((end, separator)) = end {
                    let event = String::from_utf8(self.buffer.drain(..end + separator).collect())
                        .map_err(|_| CallError::transport("MCP SSE is not UTF-8"))?;
                    let data: Vec<_> = event
                        .lines()
                        .filter_map(|line| {
                            line.strip_prefix("data:")
                                .map(|v| v.strip_prefix(' ').unwrap_or(v))
                        })
                        .collect();
                    if !data.is_empty() {
                        return Ok(Some(data.join("\n")));
                    }
                    continue;
                }
            }
            if self.eof {
                if self.buffer.is_empty() {
                    return Ok(None);
                }
                if self.sse {
                    return Err(CallError::transport(
                        "MCP SSE ended with an incomplete event",
                    ));
                }
                return String::from_utf8(std::mem::take(&mut self.buffer))
                    .map(Some)
                    .map_err(|_| CallError::transport("MCP HTTP JSON is not UTF-8"));
            }
            match self
                .response
                .chunk()
                .await
                .map_err(|e| CallError::transport(e.to_string()))?
            {
                None => self.eof = true,
                Some(chunk) => {
                    self.buffer.try_reserve(chunk.len()).map_err(|_| {
                        CallError::transport("Could not retain complete MCP result")
                    })?;
                    self.buffer.extend_from_slice(&chunk);
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "agsdl_raw_tests.rs"]
mod tests;
