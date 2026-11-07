use super::*;
use crate::agsdl_host_calls::{
    execute,
    tests::{grant, identity, TestHost},
    CallRequest, Invocation, LaunchGrant, RawReceipt,
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

#[test]
fn raw_results_preserve_numeric_lexemes_null_and_original_error_marker() {
    let raw = r#"{"content":[{"type":"text","text":"plain"},{"type":"image","data":"ignored"}],"isError":false,"structuredContent":{"large":9007199254740993,"exp":1e999999,"zero":-0}}"#;
    let r = receipt(raw.into()).unwrap();
    assert!(!r.is_error);
    assert_eq!(r.text, "plain");
    assert_eq!(r.raw_result_json, raw);
    assert_eq!(
        r.structured_content_json.unwrap(),
        r#"{"large":9007199254740993,"exp":1e999999,"zero":-0}"#
    );
    assert_eq!(
        receipt(r#"{"structuredContent":null,"isError":true}"#.into())
            .unwrap()
            .structured_content_json,
        Some("null".into())
    );
    assert!(receipt(r#"{"content":[],"isError":false,"isError":true}"#.into()).is_err());
    let text = "x".repeat(9 * 1024 * 1024);
    let raw = format!("{{\"content\":[{{\"type\":\"text\",\"text\":\"{text}\"}}]}}");
    assert_eq!(receipt(raw).unwrap().text.len(), text.len());
}

struct HttpFixture {
    requests: tokio::sync::Mutex<Vec<String>>,
    calls: AtomicUsize,
    mode: &'static str,
}
async fn http_handler(
    axum::extract::State(state): axum::extract::State<Arc<HttpFixture>>,
    headers: axum::http::HeaderMap,
    body: String,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let value: serde_json::Value = serde_json::from_str(&body).unwrap();
    state.requests.lock().await.push(body.clone());
    let id = value.get("id").cloned().unwrap_or(serde_json::Value::Null);
    let method = value.get("method").and_then(|v| v.as_str()).unwrap_or("");
    if method.is_empty() || method == "notifications/initialized" {
        return axum::http::StatusCode::ACCEPTED.into_response();
    }
    let result: String = match method {
        "initialize" => r#"{"protocolVersion":"2025-11-25","capabilities":{},"serverInfo":{"name":"synthetic","version":"1"}}"#.into(),
        "server/discover" => {
            assert!(value["params"]["_meta"].is_object());
            assert!(value["params"].get("protocolVersions").is_none());
            r#"{"resultType":"complete","supportedVersions":["2026-07-28"],"capabilities":{},"ttlMs":0,"cacheScope":"private"}"#.into()
        }
        "tools/call" => {
            let call = state.calls.fetch_add(1, Ordering::SeqCst);
            assert!(body.contains("9007199254740993"));
            if state.mode == "redirect" { return (axum::http::StatusCode::TEMPORARY_REDIRECT, [("location", "/other")]).into_response(); }
            if state.mode == "lost" { return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response(); }
            if state.mode == "modern" || state.mode == "modern-bad-state" {
                assert_eq!(headers.get("mcp-protocol-version").unwrap(), "2026-07-28");
                assert_eq!(headers.get("mcp-method").unwrap(), "tools/call");
                assert_eq!(headers.get("mcp-name").unwrap(), "synthetic");
                if state.mode == "modern-bad-state" { return ([("content-type", "application/json")], format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{{\"resultType\":\"input_required\",\"requestState\":123}}}}")).into_response(); }
                if call == 0 { r#"{"resultType":"input_required","requestState":"opaque-9007199254740993","inputRequests":{"ask":{"method":"elicitation/create","params":{"message":"Continue?","requestedSchema":{"type":"object"}}}}}"#.into() }
                else {
                    assert!(body.contains("\"requestState\":\"opaque-9007199254740993\""));
                    assert!(value["params"].get("inputResponses").is_some());
                    r#"{"resultType":"complete","content":[],"structuredContent":{"large":9007199254740993},"isError":true}"#.into()
                }
            } else if state.mode == "sse" {
                let raw = format!("data: {{\"jsonrpc\":\"2.0\",\"id\":\"human\",\"method\":\"elicitation/create\",\"params\":{{\"message\":\"Continue?\",\"requestedSchema\":{{\"type\":\"object\"}}}}}}\r\n\r\ndata: {{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{{\"content\":[{{\"type\":\"text\",\"text\":\"done\"}}],\"isError\":false}}}}\r\n\r\n");
                return ([("content-type", "text/event-stream"), ("mcp-session-id", "captured")], raw).into_response();
            } else { r#"{"content":[{"type":"text","text":"complete"}],"structuredContent":{"n":9007199254740993,"exp":1e999999},"isError":false}"#.into() }
        }
        _ => panic!("unexpected method {method}"),
    };
    (
        [
            ("content-type", "application/json"),
            ("mcp-session-id", "captured"),
        ],
        format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{result}}}"),
    )
        .into_response()
}

async fn http_fixture(
    mode: &'static str,
) -> (
    CapturedServer,
    Arc<HttpFixture>,
    tokio::task::JoinHandle<()>,
) {
    let state = Arc::new(HttpFixture {
        requests: tokio::sync::Mutex::new(vec![]),
        calls: AtomicUsize::new(0),
        mode,
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = axum::Router::new()
        .route("/mcp", axum::routing::post(http_handler))
        .with_state(state.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (
        CapturedServer {
            document_name: "document-server".into(),
            capture_digest: "capture".into(),
            protocol: if mode.starts_with("modern") {
                Protocol::Modern
            } else {
                Protocol::Legacy
            },
            transport: ServerTransport::Http(HttpServer {
                url: format!("http://127.0.0.1:{}/mcp", address.port())
                    .parse()
                    .unwrap(),
                addresses: vec![address],
                headers: Default::default(),
            }),
        },
        state,
        task,
    )
}
fn request() -> CallRequest {
    CallRequest {
        identity: identity(),
        invocation: Invocation::Mcp {
            server: "document-server".into(),
            tool: "synthetic".into(),
            arguments_json: "{\"n\":9007199254740993}".into(),
        },
    }
}

#[tokio::test]
async fn http_exact_receipts_human_waits_modern_continuation_and_no_replay() {
    for mode in [
        "json",
        "sse",
        "modern",
        "modern-bad-state",
        "redirect",
        "lost",
    ] {
        let (server, fixture, task) = http_fixture(mode).await;
        let host = Arc::new(TestHost::new(LaunchGrant::Mcp(server)));
        let result = execute(host.clone(), request()).await.unwrap();
        match mode {
            "redirect" | "lost" | "modern-bad-state" => {
                assert!(result.failure.is_some());
                assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
            }
            _ => {
                assert!(result.failure.is_none(), "{mode}: {:?}", result.failure);
                let RawReceipt::Mcp { receipt } = result.receipt.unwrap() else {
                    panic!()
                };
                if mode == "sse" {
                    assert_eq!(receipt.text, "done");
                } else {
                    assert!(receipt
                        .structured_content_json
                        .unwrap()
                        .contains("9007199254740993"));
                }
                assert_eq!(receipt.is_error, mode == "modern");
                if mode != "json" {
                    assert_eq!(host.human_open.load(Ordering::SeqCst), 1);
                    assert_eq!(host.human_closed.load(Ordering::SeqCst), 1);
                }
            }
        }
        assert!(matches!(
            result.evidence,
            PhysicalEvidence::Remote {
                termination_proven: false,
                ..
            }
        ));
        assert!(execute(host, request()).await.is_err());
        task.abort();
        let _ = task.await;
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[tokio::test]
#[ignore = "Real confined stdio MCP process; run outside the agent sandbox"]
async fn darwin_stdio_exact_result_and_legacy_elicitation() {
    let root = tempfile::tempdir().unwrap();
    let script = r#"
IFS= read -r init
printf '%s\n' '{"jsonrpc":"2.0","id":"1","result":{"protocolVersion":"2025-11-25","capabilities":{},"serverInfo":{"name":"fixture","version":"1"}}}'
IFS= read -r initialized
IFS= read -r call
case "$call" in *9007199254740993*) ;; *) exit 9;; esac
printf '%s\n' '{"jsonrpc":"2.0","id":"ask","method":"elicitation/create","params":{"message":"Continue?","requestedSchema":{"type":"object"}}}'
IFS= read -r answer
case "$answer" in *decline*) ;; *) exit 10;; esac
printf '%s\n' '{"jsonrpc":"2.0","id":"2","result":{"structuredContent":{"n":9007199254740993,"e":1e999999},"content":[],"isError":true}}'
"#;
    let server = CapturedServer {
        document_name: "document-server".into(),
        capture_digest: "capture".into(),
        protocol: Protocol::Legacy,
        transport: ServerTransport::Stdio(StdioServer {
            program: "/bin/sh".into(),
            arguments: vec!["-c".into(), script.into()],
            grant: grant(root.path()),
        }),
    };
    let host = Arc::new(TestHost::new(LaunchGrant::Mcp(server)));
    let result = execute(host.clone(), request()).await.unwrap();
    assert!(result.failure.is_none(), "{:?}", result.failure);
    let RawReceipt::Mcp { receipt } = result.receipt.unwrap() else {
        panic!()
    };
    assert!(receipt.is_error);
    assert_eq!(
        receipt.structured_content_json.unwrap(),
        "{\"n\":9007199254740993,\"e\":1e999999}"
    );
    assert_eq!(host.human_closed.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn literal_endpoint_must_match_every_captured_address_and_port() {
    fn server(url: &str, addresses: &[&str]) -> CapturedServer {
        CapturedServer {
            document_name: "document-server".into(),
            capture_digest: "native-capture".into(),
            protocol: Protocol::Legacy,
            transport: ServerTransport::Http(HttpServer {
                url: url.parse().unwrap(),
                addresses: addresses
                    .iter()
                    .map(|address| address.parse().unwrap())
                    .collect(),
                headers: Default::default(),
            }),
        }
    }
    assert!(start(server("http://127.0.0.1:3000/mcp", &["127.0.0.1:3000"])).is_ok());
    assert!(start(server("http://127.0.0.1:3000/mcp", &["127.0.0.2:3000"])).is_err());
    assert!(start(server("http://127.0.0.1:3000/mcp", &["127.0.0.1:3001"])).is_err());
    assert!(start(server(
        "http://127.0.0.1:3000/mcp",
        &["127.0.0.1:3000", "127.0.0.2:3000"]
    ))
    .is_err());
    assert!(start(server("http://[::1]:3000/mcp", &["[::1]:3000"])).is_ok());
}
