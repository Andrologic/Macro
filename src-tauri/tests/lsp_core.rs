use futures::FutureExt;
use macro_lib::lsp::{
    CancellationToken, ClientState, LspClient, LspError, LspEvent, LspFramer, LspServerConfig,
    RequestOptions, ServerRequest, ServerRequestFuture, ServerRequestHandler, ServerRequestResult,
};
use serde_json::{json, Value};
use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{broadcast, Mutex};
use tokio::time::{sleep, timeout, Instant};

const FAKE_SERVER_ENV: &str = "MACRO_FAKE_LSP_SERVER";
const FAKE_TRACE_ENV: &str = "MACRO_FAKE_LSP_TRACE";

#[tokio::main]
async fn main() {
    if let Some(mode) = std::env::var_os(FAKE_SERVER_ENV) {
        run_fake_server(mode.to_string_lossy().as_ref()).await;
        return;
    }

    run_case(
        "concurrent requests and incoming events",
        concurrent_requests_and_incoming_events(),
    )
    .await;
    run_case(
        "timeouts, cancellation, and late responses",
        timeouts_cancellation_and_late_responses(),
    )
    .await;
    run_case(
        "process exit rejects pending request",
        process_exit_rejects_pending_request(),
    )
    .await;
    run_case(
        "spawn failure returns without cleanup delay",
        spawn_failure_returns_without_cleanup_delay(),
    )
    .await;
    run_case(
        "initialize and idempotent shutdown sequence",
        initialize_and_idempotent_shutdown_sequence(),
    )
    .await;
    run_case(
        "shutdown cancels every in-flight request",
        shutdown_cancels_every_inflight_request(),
    )
    .await;
    run_case(
        "forced shutdown reaps uncooperative server",
        forced_shutdown_reaps_uncooperative_server(),
    )
    .await;
    run_case("document cache lifecycle", document_cache_lifecycle()).await;
}

async fn run_case(name: &str, future: impl std::future::Future<Output = ()>) {
    print!("test {name} ... ");
    std::io::stdout().flush().expect("flush test status");
    match std::panic::AssertUnwindSafe(future).catch_unwind().await {
        Ok(()) => println!("ok"),
        Err(panic) => {
            println!("FAILED");
            std::panic::resume_unwind(panic);
        }
    }
}

struct TestServerRequestHandler;

impl ServerRequestHandler for TestServerRequestHandler {
    fn handle(&self, request: ServerRequest) -> ServerRequestFuture {
        Box::pin(async move {
            match request.method.as_str() {
                "server/ask" => ServerRequestResult::Result(json!({
                    "answer": request.params.get("question").cloned().unwrap_or(Value::Null),
                })),
                _ => ServerRequestResult::Unhandled,
            }
        })
    }
}

fn client_for(
    temp: &TempDir,
    mode: &str,
    trace_path: Option<&Path>,
) -> Result<LspClient, LspError> {
    let executable = std::env::current_exe().expect("current test executable");
    let mut config = LspServerConfig::new(
        executable,
        temp.path(),
        json!({
            "processId": null,
            "rootUri": "file:///test-workspace",
            "capabilities": {"window": {"workDoneProgress": true}},
            "initializationOptions": {"test": true},
        }),
    );
    config
        .environment
        .insert(OsString::from(FAKE_SERVER_ENV), OsString::from(mode));
    if let Some(trace_path) = trace_path {
        config.environment.insert(
            OsString::from(FAKE_TRACE_ENV),
            trace_path.as_os_str().to_os_string(),
        );
    }
    config.startup_timeout = Duration::from_secs(2);
    config.request_timeout = Duration::from_secs(1);
    config.shutdown_timeout = Duration::from_millis(250);
    config.stderr_capacity_bytes = 1024;
    LspClient::new(config, Some(Arc::new(TestServerRequestHandler)))
}

async fn concurrent_requests_and_incoming_events() {
    let temp = TempDir::new().expect("temp dir");
    let client = client_for(&temp, "normal", None).expect("client");
    let initialize = client.start().await.expect("initialize client");
    assert_eq!(initialize["capabilities"]["hoverProvider"], true);
    assert_eq!(client.state(), ClientState::Ready);
    let mut events = client.subscribe();

    let slow_client = client.clone();
    let slow = tokio::spawn(async move {
        slow_client
            .request("test/delayed", json!({"value": "slow", "delayMs": 100}))
            .await
    });
    sleep(Duration::from_millis(10)).await;

    client
        .notify(
            "test/serverRequest",
            json!({"method": "server/ask", "question": "collision-safe"}),
        )
        .await
        .expect("trigger server request");
    let fast = client.request("test/delayed", json!({"value": "fast", "delayMs": 5}));
    let fast_result = fast.await.expect("fast response");
    let slow_result = slow.await.expect("slow task").expect("slow response");
    assert_eq!(fast_result, json!("fast"));
    assert_eq!(slow_result, json!("slow"));

    let server_result = next_event(&mut events, |event| match event {
        LspEvent::Notification { method, params } if method == "server/requestResult" => {
            Some(params)
        }
        _ => None,
    })
    .await;
    assert_eq!(server_result["result"]["answer"], "collision-safe");

    client
        .notify("test/serverRequest", json!({"method": "server/unknown"}))
        .await
        .expect("trigger unknown server request");
    let unknown_result = next_event(&mut events, |event| match event {
        LspEvent::Notification { method, params } if method == "server/requestResult" => {
            Some(params)
        }
        _ => None,
    })
    .await;
    assert_eq!(unknown_result["error"]["code"], -32601);

    client
        .notify("test/emitNotification", json!({"payload": "hello"}))
        .await
        .expect("trigger notification");
    let notice = next_event(&mut events, |event| match event {
        LspEvent::Notification { method, params } if method == "server/notice" => Some(params),
        _ => None,
    })
    .await;
    assert_eq!(notice["payload"], "hello");

    client
        .notify("test/emitSpecialEvents", Value::Null)
        .await
        .expect("trigger special events");
    next_event(&mut events, |event| match event {
        LspEvent::Diagnostics { params } => Some(params),
        _ => None,
    })
    .await;
    next_event(&mut events, |event| match event {
        LspEvent::Progress { params } => Some(params),
        _ => None,
    })
    .await;
    let log = next_event(&mut events, |event| match event {
        LspEvent::LogMessage { params, .. } => Some(params),
        _ => None,
    })
    .await;
    assert_eq!(log["message"], "fake log");

    client.shutdown().await.expect("shutdown");
    assert_clean(&client, ClientState::Stopped);
}

async fn timeouts_cancellation_and_late_responses() {
    let temp = TempDir::new().expect("temp dir");
    let client = client_for(&temp, "normal", None).expect("client");
    client.start().await.expect("start");
    let mut events = client.subscribe();

    let timed_out = client
        .request_with_options(
            "test/delayed",
            json!({"value": "late", "delayMs": 100}),
            RequestOptions {
                timeout: Some(Duration::from_millis(20)),
                cancellation: None,
            },
        )
        .await;
    assert!(matches!(timed_out, Err(LspError::RequestTimeout { .. })));
    next_event(&mut events, |event| match event {
        LspEvent::UnmatchedResponse { .. } => Some(()),
        _ => None,
    })
    .await;
    assert_eq!(client.pending_request_count(), 0);

    let healthy = client
        .request("test/delayed", json!({"value": "healthy", "delayMs": 1}))
        .await
        .expect("session remains usable after timeout");
    assert_eq!(healthy, json!("healthy"));

    let cancellation = CancellationToken::new();
    let request_client = client.clone();
    let request_cancellation = cancellation.clone();
    let request = tokio::spawn(async move {
        request_client
            .request_with_options(
                "test/delayed",
                json!({"value": "cancelled", "delayMs": 100}),
                RequestOptions {
                    timeout: Some(Duration::from_secs(1)),
                    cancellation: Some(request_cancellation),
                },
            )
            .await
    });
    sleep(Duration::from_millis(10)).await;
    cancellation.cancel();
    assert!(matches!(
        request.await.expect("request task"),
        Err(LspError::RequestCancelled { .. })
    ));
    next_event(&mut events, |event| match event {
        LspEvent::Notification { method, .. } if method == "server/cancelSeen" => Some(()),
        _ => None,
    })
    .await;

    client.shutdown().await.expect("shutdown");
    assert_clean(&client, ClientState::Stopped);
}

async fn process_exit_rejects_pending_request() {
    let temp = TempDir::new().expect("temp dir");
    let client = client_for(&temp, "normal", None).expect("client");
    client.start().await.expect("start");
    let mut events = client.subscribe();
    let result = client.request("test/exit", Value::Null).await;
    assert!(result.is_err(), "request must fail when process exits");
    let exit = next_event(&mut events, |event| match event {
        LspEvent::ProcessExited(exit) => Some(exit),
        _ => None,
    })
    .await;
    assert_eq!(exit.code, Some(17));
    wait_for_state(&client, ClientState::Failed).await;
    client.shutdown().await.expect("cleanup failed client");
    assert_clean(&client, ClientState::Failed);
}

async fn spawn_failure_returns_without_cleanup_delay() {
    let temp = TempDir::new().expect("temp dir");
    let mut config = LspServerConfig::new(
        temp.path().join("missing-lsp-server"),
        temp.path(),
        json!({"capabilities": {}}),
    );
    config.shutdown_timeout = Duration::from_secs(5);
    let client = LspClient::new(config, None).expect("client");

    let result = timeout(Duration::from_millis(500), client.start())
        .await
        .expect("spawn failure must not wait for the shutdown deadline");
    assert!(matches!(result, Err(LspError::Spawn { .. })));
    assert_eq!(client.state(), ClientState::Failed);
    timeout(Duration::from_millis(500), client.shutdown())
        .await
        .expect("failed client cleanup must be immediate")
        .expect("cleanup failed client");
    assert_clean(&client, ClientState::Failed);
}

async fn initialize_and_idempotent_shutdown_sequence() {
    let temp = TempDir::new().expect("temp dir");
    let trace = temp.path().join("lsp-trace.txt");
    let client = client_for(&temp, "normal", Some(&trace)).expect("client");
    client.start().await.expect("start");
    let first = client.clone();
    let second = client.clone();
    let (first_result, second_result) = tokio::join!(first.shutdown(), second.shutdown());
    first_result.expect("first shutdown");
    second_result.expect("second shutdown");
    client.shutdown().await.expect("third shutdown");
    assert_clean(&client, ClientState::Stopped);

    let methods = std::fs::read_to_string(trace)
        .expect("trace")
        .lines()
        .map(str::to_string)
        .collect::<Vec<_>>();
    assert_eq!(methods, ["initialize", "initialized", "shutdown", "exit"]);
}

async fn forced_shutdown_reaps_uncooperative_server() {
    let temp = TempDir::new().expect("temp dir");
    let client = client_for(&temp, "ignore_exit", None).expect("client");
    client.start().await.expect("start");
    let process_id = client.process_id().expect("server pid");
    let started = Instant::now();
    client.shutdown().await.expect("forced shutdown");
    assert!(started.elapsed() >= Duration::from_millis(200));
    assert_clean(&client, ClientState::Stopped);
    assert_ne!(process_id, 0);
}

async fn shutdown_cancels_every_inflight_request() {
    let temp = TempDir::new().expect("temp dir");
    let client = client_for(&temp, "normal", None).expect("client");
    client.start().await.expect("start");
    let mut requests = Vec::new();
    for value in 0..20 {
        let request_client = client.clone();
        requests.push(tokio::spawn(async move {
            request_client
                .request("test/delayed", json!({"value": value, "delayMs": 200}))
                .await
        }));
    }
    sleep(Duration::from_millis(20)).await;
    client.shutdown().await.expect("shutdown");
    for request in requests {
        assert!(request.await.expect("request task").is_err());
    }
    assert_clean(&client, ClientState::Stopped);
}

async fn document_cache_lifecycle() {
    let temp = TempDir::new().expect("temp dir");
    let client = client_for(&temp, "normal", None).expect("client");
    client.start().await.expect("start");
    let mut events = client.subscribe();
    let uri = "file:///tmp/../tmp/document.rs";

    let opened = client
        .open_document(uri, "rust", 1, "let café = 1;\n")
        .await
        .expect("open");
    assert_eq!(opened.uri, "file:///tmp/document.rs");
    assert_document_event(&mut events, "textDocument/didOpen").await;

    let replaced = client
        .replace_document(uri, 2, "let café = 2;\n")
        .await
        .expect("replace");
    assert_eq!(replaced.version, 2);
    assert_document_event(&mut events, "textDocument/didChange").await;

    let stale = client.replace_document(uri, 2, "let café = 0;\n").await;
    assert!(matches!(stale, Err(LspError::StaleDocumentVersion { .. })));
    assert_eq!(
        client
            .document_snapshot(uri)
            .await
            .expect("snapshot")
            .expect("tracked")
            .content,
        "let café = 2;\n"
    );

    let edited = client
        .edit_document(
            uri,
            3,
            &[macro_lib::lsp::DocumentEdit {
                start_byte: 12,
                end_byte: 13,
                text: "3".to_string(),
            }],
        )
        .await
        .expect("edit");
    assert_eq!(edited.content, "let café = 3;\n");
    assert_document_event(&mut events, "textDocument/didChange").await;

    let closed = client.close_document(uri).await.expect("close");
    assert!(!closed.is_open);
    assert_document_event(&mut events, "textDocument/didClose").await;
    client.shutdown().await.expect("shutdown");
    assert_clean(&client, ClientState::Stopped);
}

async fn assert_document_event(events: &mut broadcast::Receiver<LspEvent>, expected: &str) {
    let method = next_event(events, |event| match event {
        LspEvent::Notification { method, params }
            if method == "server/documentEvent" && params["method"] == expected =>
        {
            Some(params["method"].as_str().unwrap().to_string())
        }
        _ => None,
    })
    .await;
    assert_eq!(method, expected);
}

async fn next_event<T>(
    events: &mut broadcast::Receiver<LspEvent>,
    mut select: impl FnMut(LspEvent) -> Option<T>,
) -> T {
    timeout(Duration::from_secs(2), async {
        loop {
            match events.recv().await {
                Ok(event) => {
                    if let Some(result) = select(event) {
                        return result;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(error) => panic!("event channel closed: {error}"),
            }
        }
    })
    .await
    .expect("timed out waiting for LSP event")
}

async fn wait_for_state(client: &LspClient, expected: ClientState) {
    let mut state = client.subscribe_state();
    timeout(Duration::from_secs(2), async {
        loop {
            if *state.borrow() == expected {
                return;
            }
            state.changed().await.expect("state channel");
        }
    })
    .await
    .expect("state transition timeout");
}

fn assert_clean(client: &LspClient, expected_state: ClientState) {
    assert_eq!(client.state(), expected_state);
    assert_eq!(client.pending_request_count(), 0);
    assert_eq!(client.process_id(), None);
}

async fn run_fake_server(mode: &str) {
    let writer = Arc::new(Mutex::new(tokio::io::stdout()));
    let trace = std::env::var_os(FAKE_TRACE_ENV).map(PathBuf::from);
    let mut stdin = tokio::io::stdin();
    let mut framer = LspFramer::new(1024 * 1024, 4096).expect("fake framer");
    let mut chunk = [0u8; 5];

    loop {
        let read = stdin.read(&mut chunk).await.expect("read fake stdin");
        if read == 0 {
            framer.finish().expect("complete fake server input");
            return;
        }
        for message in framer.push(&chunk[..read]).expect("frame fake input") {
            if !handle_fake_message(message, mode, trace.as_deref(), writer.clone()).await {
                return;
            }
        }
    }
}

async fn handle_fake_message(
    message: Value,
    mode: &str,
    trace: Option<&Path>,
    writer: Arc<Mutex<tokio::io::Stdout>>,
) -> bool {
    let method = message.get("method").and_then(Value::as_str);
    if let Some(method) = method {
        append_trace(trace, method);
        if let Some(id) = message.get("id").cloned() {
            match method {
                "initialize" => {
                    send_fake(
                        &writer,
                        json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {"capabilities": {"hoverProvider": true}},
                        }),
                    )
                    .await;
                }
                "shutdown" => {
                    send_fake(&writer, json!({"jsonrpc": "2.0", "id": id, "result": null})).await;
                }
                "test/delayed" => {
                    let delay = message["params"]["delayMs"].as_u64().unwrap_or(0);
                    let value = message["params"]["value"].clone();
                    tokio::spawn(async move {
                        sleep(Duration::from_millis(delay)).await;
                        send_fake(
                            &writer,
                            json!({"jsonrpc": "2.0", "id": id, "result": value}),
                        )
                        .await;
                    });
                }
                "test/exit" => std::process::exit(17),
                _ => {
                    send_fake(
                        &writer,
                        json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": {"code": -32601, "message": "unknown fake request"},
                        }),
                    )
                    .await;
                }
            }
            return true;
        }

        match method {
            "exit" if mode != "ignore_exit" => return false,
            "test/serverRequest" => {
                send_fake(
                    &writer,
                    json!({
                        "jsonrpc": "2.0",
                        "id": 2,
                        "method": message["params"]["method"],
                        "params": {"question": message["params"]["question"]},
                    }),
                )
                .await;
            }
            "test/emitNotification" => {
                send_fake(
                    &writer,
                    json!({
                        "jsonrpc": "2.0",
                        "method": "server/notice",
                        "params": message["params"],
                    }),
                )
                .await;
            }
            "test/emitSpecialEvents" => {
                for event in [
                    json!({
                        "jsonrpc": "2.0",
                        "method": "textDocument/publishDiagnostics",
                        "params": {"uri": "file:///test.rs", "diagnostics": []},
                    }),
                    json!({
                        "jsonrpc": "2.0",
                        "method": "$/progress",
                        "params": {"token": "load", "value": {"kind": "end"}},
                    }),
                    json!({
                        "jsonrpc": "2.0",
                        "method": "window/logMessage",
                        "params": {"type": 3, "message": "fake log"},
                    }),
                ] {
                    send_fake(&writer, event).await;
                }
            }
            "$/cancelRequest" => {
                send_fake(
                    &writer,
                    json!({
                        "jsonrpc": "2.0",
                        "method": "server/cancelSeen",
                        "params": message["params"],
                    }),
                )
                .await;
            }
            method if method.starts_with("textDocument/") => {
                send_fake(
                    &writer,
                    json!({
                        "jsonrpc": "2.0",
                        "method": "server/documentEvent",
                        "params": {"method": method, "params": message["params"]},
                    }),
                )
                .await;
            }
            _ => {}
        }
        return true;
    }

    if let Some(id) = message.get("id").cloned() {
        send_fake(
            &writer,
            json!({
                "jsonrpc": "2.0",
                "method": "server/requestResult",
                "params": {"id": id, "result": message.get("result"), "error": message.get("error")},
            }),
        )
        .await;
    }
    true
}

async fn send_fake(writer: &Arc<Mutex<tokio::io::Stdout>>, message: Value) {
    let bytes = macro_lib::lsp::encode_message(&message, 1024 * 1024).expect("encode fake frame");
    let mut writer = writer.lock().await;
    writer.write_all(&bytes).await.expect("write fake frame");
    writer.flush().await.expect("flush fake frame");
}

fn append_trace(trace: Option<&Path>, method: &str) {
    let Some(trace) = trace else {
        return;
    };
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(trace)
        .expect("open trace");
    writeln!(file, "{method}").expect("write trace");
}
