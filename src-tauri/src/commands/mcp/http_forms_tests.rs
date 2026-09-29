//! Local HTTP -> shared broker -> IPC response -> HTTP continuation contracts.
use super::*;
use crate::commands::mcp::interaction::{
    McpElicitationAction, McpElicitationAnswer, McpInteractionBroker, McpInteractionRequest,
    McpInteractionResponse,
};
use crate::commands::mcp::runtime::McpInteractionContext;
use crate::commands::mcp::runtime_connector::run_modern_tool_call;
use crate::commands::mcp::types::McpRuntimeKey;
use axum::{
    extract::State,
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde_json::json;
use std::sync::Mutex;
use tauri::ipc::{Channel, InvokeResponseBody};

#[derive(Clone)]
struct Fixture {
    calls: Arc<Mutex<Vec<Value>>>,
    mode: &'static str,
}

async fn post_request(State(f): State<Fixture>, Json(request): Json<Value>) -> Response {
    let id = request["id"].clone();
    if request["method"] == "server/discover" {
        let result = rmcp::model::DiscoverResult::new(
            vec![ProtocolVersion::V_2026_07_28],
            rmcp::model::ServerCapabilities::builder()
                .enable_tools()
                .build(),
        );
        return Json(json!({"jsonrpc":"2.0","id":id,"result":result})).into_response();
    }
    if request["method"] != "tools/call" {
        return reqwest::StatusCode::ACCEPTED.into_response();
    }
    f.calls.lock().unwrap().push(request.clone());
    let mode = if f.mode.starts_with("continuation_") {
        if request["params"].get("inputResponses").is_some() {
            f.mode.trim_start_matches("continuation_")
        } else {
            "form"
        }
    } else {
        f.mode
    };
    match mode {
        "redirect" => {
            return (
                reqwest::StatusCode::TEMPORARY_REDIRECT,
                [("location", "/mcp")],
            )
                .into_response()
        }
        "auth" => {
            return (
                reqwest::StatusCode::UNAUTHORIZED,
                [("www-authenticate", "Bearer")],
            )
                .into_response()
        }
        "expired" => return reqwest::StatusCode::NOT_FOUND.into_response(),
        "malformed" => {
            return (
                reqwest::StatusCode::OK,
                [("content-type", "application/json")],
                "{invalid",
            )
                .into_response()
        }
        "timeout" => {
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        _ => {}
    }
    let params = &request["params"];
    let result = if params.get("inputResponses").is_some() {
        json!({"resultType":"complete","content":[{"type":"text","text":"finished"}]})
    } else if f.mode == "state" {
        json!({"resultType":"input_required","requestState":" opaque\nα "})
    } else {
        let prompt = if f.mode == "url" {
            json!({"mode":"url","message":"Open site","url":"https://example.test/verify","elicitationId":"verification"})
        } else {
            json!({"mode":"form","message":"Name","requestedSchema":{
                "type":"object","properties":{"name":{"type":"string","minLength":2}},"required":["name"]
            }})
        };
        json!({"resultType":"input_required","requestState":" opaque\nα ",
            "inputRequests":{"form":{"method":"elicitation/create","params":prompt}}})
    };
    Json(json!({"jsonrpc":"2.0","id":id,"result":result})).into_response()
}

async fn fixture(
    mode: &'static str,
) -> (
    Arc<RmcpModernHttpClient>,
    Fixture,
    tokio::task::JoinHandle<()>,
) {
    let f = Fixture {
        calls: Arc::default(),
        mode,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let app = Router::new()
        .route("/mcp", post(post_request))
        .with_state(f.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let transport = GuardedStreamableHttpClient::new(
        validate_endpoint(&url).await.unwrap(),
        HashMap::new(),
        None,
    )
    .unwrap();
    let client = RmcpModernHttpClient::connect(
        transport,
        "forms".into(),
        "Forms".into(),
        Some(Duration::from_secs(2)),
        Some(if mode.ends_with("timeout") {
            Duration::from_millis(100)
        } else {
            Duration::from_secs(2)
        }),
    )
    .await
    .unwrap();
    (Arc::new(client), f, server)
}

fn context(broker: &McpInteractionBroker, operation: &str) -> Arc<McpOperationCancellation> {
    let cancellation = Arc::new(McpOperationCancellation::default());
    cancellation.attach_interaction(McpInteractionContext {
        key: McpRuntimeKey {
            server_id: "forms".into(),
            project_id: None,
            project_ids: vec!["project".into()],
            config_generation: 7,
        },
        operation_id: operation.into(),
        broker: broker.clone(),
    });
    cancellation
}

fn host(
    broker: &McpInteractionBroker,
) -> (
    String,
    tokio::sync::mpsc::UnboundedReceiver<McpInteractionRequest>,
) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let lease = broker
        .open(Channel::new(move |body: InvokeResponseBody| {
            tx.send(body.deserialize().unwrap()).unwrap();
            Ok(())
        }))
        .unwrap();
    (lease, rx)
}

async fn call(
    client: Arc<RmcpModernHttpClient>,
    c: Arc<McpOperationCancellation>,
) -> Result<McpCallToolResponse, crate::commands::mcp::runtime::McpRuntimeError> {
    run_modern_tool_call(c.clone(), |state, answers| {
        client.call_tool_round(
            "mutate",
            json!({"original":true}),
            state,
            answers,
            c.clone(),
        )
    })
    .await
}

#[tokio::test]
async fn http_forms_accept_decline_cancel_preserve_identity_and_capabilities() {
    for action in [
        McpElicitationAction::Accept,
        McpElicitationAction::Decline,
        McpElicitationAction::Cancel,
    ] {
        let (client, f, server) = fixture("form").await;
        let broker = McpInteractionBroker::default();
        let (lease, mut rx) = host(&broker);
        let c = context(&broker, "conversation:tool:operation");
        let expected = c.interaction().unwrap();
        let task = tokio::spawn(call(client.clone(), c));
        let request = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(request.key, expected.key);
        assert_eq!(request.operation_id, expected.operation_id);
        let content = matches!(action, McpElicitationAction::Accept).then(|| json!({"name":"Ada"}));
        let response = McpInteractionResponse {
            request_id: request.request_id,
            key: request.key,
            operation_id: request.operation_id,
            answers: vec![McpElicitationAnswer {
                id: "form".into(),
                action,
                content,
            }],
        };
        let mut wrong = response.clone();
        wrong.operation_id = "other-conversation".into();
        assert!(broker.respond(&lease, wrong).is_err());
        let mut wrong = response.clone();
        wrong.key.config_generation += 1;
        assert!(broker.respond(&lease, wrong).is_err());
        broker.respond(&lease, response.clone()).unwrap();
        assert!(broker.respond(&lease, response.clone()).is_err());
        assert_eq!(task.await.unwrap().unwrap().content, "finished");
        let calls = f.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1]["params"]["requestState"], " opaque\nα ");
        assert_eq!(
            calls[1]["params"]["arguments"],
            calls[0]["params"]["arguments"]
        );
        assert_eq!(
            calls[1]["params"]["inputResponses"]["form"]["action"],
            serde_json::to_value(&response.answers[0].action).unwrap()
        );
        for call in calls.iter() {
            assert_eq!(call["params"]["name"], "mutate");
            assert_eq!(
                call["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"],
                MODERN_PROTOCOL_VERSION
            );
            assert_eq!(
                call["params"]["_meta"]["io.modelcontextprotocol/clientInfo"]["name"],
                "Macro"
            );
            assert_eq!(
                call["params"]["_meta"]["io.modelcontextprotocol/clientCapabilities"]
                    ["elicitation"],
                json!({"form":{}})
            );
        }
        drop(calls);
        broker.close(&lease).unwrap();
        server.abort();
    }
}

#[tokio::test]
async fn http_forms_fail_closed_without_host_and_for_url() {
    for mode in ["form", "url"] {
        let (client, f, server) = fixture(mode).await;
        let broker = McpInteractionBroker::default();
        let error = call(client, context(&broker, "op")).await.unwrap_err();
        assert_eq!(
            error.code,
            if mode == "url" {
                "MCP_INTERACTION_UNSUPPORTED"
            } else {
                "MCP_INTERACTION_NO_HOST"
            }
        );
        let calls = f.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert!(
            calls[0]["params"]["_meta"]["io.modelcontextprotocol/clientCapabilities"]
                ["elicitation"]
                .is_null()
        );
        server.abort();
    }
}

#[tokio::test]
async fn http_forms_cancellation_and_host_restart_prevent_continuation() {
    for restart in [false, true] {
        let (client, f, server) = fixture("form").await;
        let broker = McpInteractionBroker::default();
        let (lease, mut rx) = host(&broker);
        let c = context(&broker, "op");
        let task = tokio::spawn(call(client, c.clone()));
        let request = rx.recv().await.unwrap();
        if restart {
            broker.close(&lease).unwrap();
            let _ = host(&broker);
        } else {
            c.cancel();
        }
        assert!(task.await.unwrap().is_err());
        assert!(broker
            .respond(
                &lease,
                McpInteractionResponse {
                    request_id: request.request_id,
                    key: request.key,
                    operation_id: request.operation_id,
                    answers: vec![McpElicitationAnswer {
                        id: "form".into(),
                        action: McpElicitationAction::Cancel,
                        content: None
                    }]
                }
            )
            .is_err());
        assert_eq!(f.calls.lock().unwrap().len(), 1);
        server.abort();
    }
}

#[tokio::test]
async fn http_forms_transport_failures_never_replay_mutations() {
    for mode in ["redirect", "auth", "expired", "timeout"] {
        let (client, f, server) = fixture(mode).await;
        let broker = McpInteractionBroker::default();
        assert!(
            call(client, context(&broker, "op")).await.is_err(),
            "{mode}"
        );
        assert_eq!(f.calls.lock().unwrap().len(), 1, "{mode}");
        server.abort();
    }
}

#[tokio::test]
async fn http_forms_state_only_continuations_are_bounded_without_host() {
    let (client, f, server) = fixture("state").await;
    let broker = McpInteractionBroker::default();
    let error = call(client, context(&broker, "op")).await.unwrap_err();
    assert_eq!(error.code, "MCP_INTERACTION_ROUND_LIMIT");
    assert_eq!(f.calls.lock().unwrap().len(), 5);
    server.abort();
}

#[tokio::test]
async fn http_forms_parallel_operations_cannot_exchange_answers() {
    let (client, f, server) = fixture("form").await;
    let broker = McpInteractionBroker::default();
    let (lease, mut rx) = host(&broker);
    let first = tokio::spawn(call(client.clone(), context(&broker, "first")));
    let second = tokio::spawn(call(client, context(&broker, "second")));
    let a = rx.recv().await.unwrap();
    let b = rx.recv().await.unwrap();
    assert_ne!(a.operation_id, b.operation_id);
    assert_ne!(a.request_id, b.request_id);
    let mut mixed = McpInteractionResponse {
        request_id: a.request_id.clone(),
        key: a.key.clone(),
        operation_id: b.operation_id.clone(),
        answers: vec![McpElicitationAnswer {
            id: "form".into(),
            action: McpElicitationAction::Cancel,
            content: None,
        }],
    };
    assert!(broker.respond(&lease, mixed.clone()).is_err());
    mixed.operation_id = a.operation_id;
    broker.respond(&lease, mixed).unwrap();
    broker
        .respond(
            &lease,
            McpInteractionResponse {
                request_id: b.request_id,
                key: b.key,
                operation_id: b.operation_id,
                answers: vec![McpElicitationAnswer {
                    id: "form".into(),
                    action: McpElicitationAction::Decline,
                    content: None,
                }],
            },
        )
        .unwrap();
    assert!(first.await.unwrap().is_ok());
    assert!(second.await.unwrap().is_ok());
    assert_eq!(f.calls.lock().unwrap().len(), 4);
    server.abort();
}

#[tokio::test]
async fn http_read_requests_keep_safe_same_origin_redirects() {
    async fn redirect() -> impl IntoResponse {
        (
            reqwest::StatusCode::TEMPORARY_REDIRECT,
            [("location", "/catalog")],
        )
    }
    async fn catalog(Json(request): Json<Value>) -> impl IntoResponse {
        assert_eq!(request["method"], "tools/list");
        Json(json!({"jsonrpc":"2.0","id":request["id"],"result":{
            "resultType":"complete","tools":[],"ttlMs":0,"cacheScope":"private"
        }}))
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let app = Router::new()
        .route("/mcp", post(redirect))
        .route("/catalog", post(catalog));
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let transport = GuardedStreamableHttpClient::new(
        validate_endpoint(&url).await.unwrap(),
        HashMap::new(),
        None,
    )
    .unwrap();
    let request: ClientJsonRpcMessage =
        serde_json::from_value(json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}))
            .unwrap();
    let result = transport
        .post_message(url.into(), request, None, None, HashMap::new())
        .await
        .unwrap();
    assert!(matches!(result, StreamableHttpPostResponse::Json(_, _)));
    server.abort();
}

#[tokio::test]
async fn http_forms_failed_continuations_are_sent_once_and_never_restart_the_tool() {
    for mode in [
        "continuation_redirect",
        "continuation_auth",
        "continuation_expired",
        "continuation_timeout",
        "continuation_malformed",
    ] {
        let (client, f, server) = fixture(mode).await;
        let broker = McpInteractionBroker::default();
        let (lease, mut rx) = host(&broker);
        let task = tokio::spawn(call(client, context(&broker, "op")));
        let request = rx.recv().await.unwrap();
        broker
            .respond(
                &lease,
                McpInteractionResponse {
                    request_id: request.request_id,
                    key: request.key,
                    operation_id: request.operation_id,
                    answers: vec![McpElicitationAnswer {
                        id: "form".into(),
                        action: McpElicitationAction::Accept,
                        content: Some(json!({"name":"Ada"})),
                    }],
                },
            )
            .unwrap();
        assert!(task.await.unwrap().is_err(), "{mode}");
        let calls = f.calls.lock().unwrap();
        assert_eq!(calls.len(), 2, "{mode}");
        assert!(calls[0]["params"].get("inputResponses").is_none());
        assert_eq!(
            calls[1]["params"]["inputResponses"]["form"]["content"],
            json!({"name":"Ada"})
        );
        assert!(broker.pending_request_ids(&lease).unwrap().is_empty());
        server.abort();
    }
}

#[tokio::test]
async fn modern_final_response_loses_to_cancellation_on_initial_or_continuation_round() {
    for cancel_on_round in [0, 1] {
        let broker = McpInteractionBroker::default();
        let cancellation = context(&broker, "cancel-final");
        let mut sent = 0;
        let result = run_modern_tool_call(cancellation.clone(), |_, _| {
            let outcome = if sent == cancel_on_round {
                // Deterministically model both the final response and cancellation
                // being ready when the transport hands its result to the runtime.
                cancellation.cancel();
                McpModernToolCallOutcome::Complete(normalize_tool_call_result(json!({
                    "content":[{"type":"text","text":"must not publish"}]
                })))
            } else {
                McpModernToolCallOutcome::InputRequired {
                    raw_result: json!({"resultType":"input_required","requestState":"opaque"}),
                }
            };
            sent += 1;
            std::future::ready(Ok(outcome))
        })
        .await;
        assert_eq!(result.unwrap_err().code, "MCP_RUNTIME_OPERATION_CANCELLED");
        assert_eq!(sent, cancel_on_round + 1);
    }
}
