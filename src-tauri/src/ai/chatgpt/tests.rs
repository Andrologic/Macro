use super::auth::{build_authorize_url, spawn_browser_auth_callback_server};
use super::models::{build_provider_models, model_supports_plan};
use super::session::{
    build_provider_auth_metadata, build_token_claims, decode_jwt_payload,
    resolve_token_expiry_rfc3339,
};
use super::stream::{
    build_responses_request, extract_completed_reasoning_summary,
    extract_function_call_from_output_item, extract_output_text_from_output_item,
    extract_reasoning_summary_from_output_item, extract_response_id,
    normalize_provider_input_items_for_replay,
};
use super::types::{
    auth_flow_error_from_persist, AiChatMessage, AiChatMessageContent, AiChatRequest,
    ModelsCacheEntry, PersistChatGptSessionError, PkceCodes, CHATGPT_CALLBACK_PORT,
    CHATGPT_CANCEL_PATH,
};
use crate::secrets::ChatGptSecret;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::Utc;
use serde_json::json;
use std::sync::LazyLock;

static AUTH_SERVER_TEST_MUTEX: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

fn encode_jwt(payload: serde_json::Value) -> String {
    let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"none","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD.encode(payload.to_string());
    format!("{header}.{payload}.")
}

#[test]
fn decode_jwt_payload_extracts_claims() {
    let token = encode_jwt(json!({
        "exp": 1770000000,
        "https://api.openai.com/auth": {
            "chatgpt_account_id": "acct-123",
            "chatgpt_plan_type": "plus"
        }
    }));

    let decoded = decode_jwt_payload(&token).expect("decode");
    assert_eq!(
        decoded["https://api.openai.com/auth"]["chatgpt_plan_type"],
        "plus"
    );
}

#[test]
fn build_token_claims_uses_optional_id_token() {
    let future_exp = Utc::now().timestamp() + 60 * 60;
    let access_token = encode_jwt(json!({
        "exp": future_exp,
        "https://api.openai.com/auth": {
            "chatgpt_account_id": "acct-123",
            "chatgpt_plan_type": "pro"
        },
        "https://api.openai.com/profile": {
            "email": "user@example.com"
        }
    }));
    let id_token = encode_jwt(json!({
        "email": "user@example.com"
    }));

    let claims = build_token_claims(&access_token, Some(&id_token)).expect("claims");
    assert_eq!(claims.plan_type.as_deref(), Some("pro"));
    assert_eq!(claims.account_id.as_deref(), Some("acct-123"));
    assert_eq!(claims.email.as_deref(), Some("user@example.com"));
}

#[test]
fn build_provider_auth_metadata_uses_fallbacks() {
    let future_exp = Utc::now().timestamp() + 60 * 60;
    let access_token = encode_jwt(json!({
        "exp": future_exp,
        "https://api.openai.com/auth": {
            "chatgpt_account_id": "acct-123"
        }
    }));
    let metadata = build_provider_auth_metadata(
        &ChatGptSecret {
            access_token,
            refresh_token: "refresh".to_string(),
            access_token_expires_at: None,
            account_id: Some("acct-123".to_string()),
            auth_source: "browser".to_string(),
        },
        Some("plus".to_string()),
        Some("user@example.com".to_string()),
    )
    .expect("metadata");

    assert_eq!(metadata.auth_status.as_deref(), Some("authenticated"));
    assert_eq!(metadata.plan_type.as_deref(), Some("plus"));
    assert_eq!(metadata.account_label.as_deref(), Some("user@example.com"));
    assert!(metadata.token_expires_at.is_some());
}

#[test]
fn build_responses_request_maps_system_and_history() {
    let request = build_responses_request(&AiChatRequest {
        request_id: "req-1".to_string(),
        provider_id: "chatgpt".to_string(),
        model_id: "gpt-5".to_string(),
        reasoning_effort: Some("high".to_string()),
        conversation_id: Some("conv_123".to_string()),
        messages: vec![
            AiChatMessage {
                role: "system".to_string(),
                content: AiChatMessageContent::Text("Follow instructions".to_string()),
                tool_calls: Vec::new(),
                tool_call_id: None,
                provider_input_items: None,
                provider_turn_state: None,
            },
            AiChatMessage {
                role: "user".to_string(),
                content: AiChatMessageContent::Text("Hello".to_string()),
                tool_calls: Vec::new(),
                tool_call_id: None,
                provider_input_items: None,
                provider_turn_state: None,
            },
            AiChatMessage {
                role: "assistant".to_string(),
                content: AiChatMessageContent::Text("Hi".to_string()),
                tool_calls: Vec::new(),
                tool_call_id: None,
                provider_input_items: None,
                provider_turn_state: None,
            },
        ],
        tools: Vec::new(),
        tool_choice: Some("auto".to_string()),
        parallel_tool_calls: Some(false),
        workspace_path: None,
        default_workspace_path: None,
        project_mounts: Vec::new(),
        virtual_root_enabled: None,
        focused_project_id: None,
        allowed_tool_ids: Vec::new(),
        copilot_send_timeout_ms: None,
    })
    .expect("request");

    assert_eq!(request.model, "gpt-5");
    assert_eq!(request.instructions, "Follow instructions");
    assert_eq!(request.input.len(), 2);
    assert!(request.tools.is_empty());
    assert!(!request.store);
    assert!(request.stream);
    assert_eq!(request.include, vec!["reasoning.encrypted_content"]);
    assert_eq!(request.prompt_cache_key.as_deref(), Some("conv_123"));
    assert_eq!(
        request.reasoning,
        Some(json!({ "effort": "high", "summary": "auto" }))
    );
}

#[test]
fn build_responses_request_flattens_tools_and_maps_tool_outputs() {
    let request = build_responses_request(&AiChatRequest {
        request_id: "req-2".to_string(),
        provider_id: "chatgpt".to_string(),
        model_id: "gpt-5".to_string(),
        reasoning_effort: None,
        conversation_id: None,
        messages: vec![
            AiChatMessage {
                role: "assistant".to_string(),
                content: AiChatMessageContent::Text(String::new()),
                tool_calls: vec![super::types::AiToolCall {
                    id: "call_1".to_string(),
                    kind: "function".to_string(),
                    function: super::types::AiToolCallFunction {
                        name: "read".to_string(),
                        arguments: r#"{"path":"README.md"}"#.to_string(),
                    },
                }],
                tool_call_id: None,
                provider_input_items: None,
                provider_turn_state: None,
            },
            AiChatMessage {
                role: "tool".to_string(),
                content: AiChatMessageContent::Text("FILE: README.md".to_string()),
                tool_calls: Vec::new(),
                tool_call_id: Some("call_1".to_string()),
                provider_input_items: None,
                provider_turn_state: None,
            },
        ],
        tools: vec![json!({
            "type": "function",
            "function": {
                "name": "read",
                "description": "Read a workspace file.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" }
                    },
                    "required": ["path"]
                }
            }
        })],
        tool_choice: Some("auto".to_string()),
        parallel_tool_calls: Some(false),
        workspace_path: None,
        default_workspace_path: None,
        project_mounts: Vec::new(),
        virtual_root_enabled: None,
        focused_project_id: None,
        allowed_tool_ids: Vec::new(),
        copilot_send_timeout_ms: None,
    })
    .expect("request");

    assert_eq!(request.tools.len(), 1);
    assert_eq!(request.tools[0]["name"], "read");
    assert_eq!(request.input.len(), 2);

    let serialized_input = request
        .input
        .iter()
        .map(|item| serde_json::to_value(item).expect("serialize input item"))
        .collect::<Vec<_>>();

    assert_eq!(serialized_input[0]["type"], "function_call");
    assert_eq!(serialized_input[1]["type"], "function_call_output");
    assert_eq!(serialized_input[1]["call_id"], "call_1");
}

#[test]
fn build_responses_request_is_stateless_without_previous_response_id() {
    let request = build_responses_request(&AiChatRequest {
        request_id: "req-omit-prev".to_string(),
        provider_id: "chatgpt".to_string(),
        model_id: "gpt-5".to_string(),
        reasoning_effort: None,
        conversation_id: Some("conv_stateless".to_string()),
        messages: vec![AiChatMessage {
            role: "user".to_string(),
            content: AiChatMessageContent::Text("Hello".to_string()),
            tool_calls: Vec::new(),
            tool_call_id: None,
            provider_input_items: None,
            provider_turn_state: None,
        }],
        tools: Vec::new(),
        tool_choice: Some("auto".to_string()),
        parallel_tool_calls: Some(false),
        workspace_path: None,
        default_workspace_path: None,
        project_mounts: Vec::new(),
        virtual_root_enabled: None,
        focused_project_id: None,
        allowed_tool_ids: Vec::new(),
        copilot_send_timeout_ms: None,
    })
    .expect("request");

    let serialized = serde_json::to_value(&request).expect("serialize request");
    assert!(serialized.get("previous_response_id").is_none());
    assert_eq!(serialized["prompt_cache_key"], "conv_stateless");
}

#[test]
fn build_responses_request_replays_chatgpt_provider_turn_output_items() {
    let request = build_responses_request(&AiChatRequest {
        request_id: "req-replay".to_string(),
        provider_id: "chatgpt".to_string(),
        model_id: "gpt-5".to_string(),
        reasoning_effort: None,
        conversation_id: None,
        messages: vec![
            AiChatMessage {
                role: "assistant".to_string(),
                content: AiChatMessageContent::Text(
                    "<think>Resume UI</think>\nVisible only".to_string(),
                ),
                tool_calls: Vec::new(),
                tool_call_id: None,
                provider_input_items: None,
                provider_turn_state: Some(json!({
                    "provider": "chatgpt",
                    "response_id": "resp_prev",
                    "output_items": [
                        {
                            "id": "rs_123",
                            "status": "completed",
                            "type": "reasoning",
                            "summary": [
                                {
                                    "type": "summary_text",
                                    "text": "Native reasoning summary."
                                }
                            ],
                            "encrypted_content": "enc_123"
                        },
                        {
                            "id": "fc_123",
                            "status": "completed",
                            "type": "function_call",
                            "call_id": "call_123",
                            "name": "read",
                            "arguments": "{\"path\":\"README.md\"}"
                        }
                    ]
                })),
            },
            AiChatMessage {
                role: "tool".to_string(),
                content: AiChatMessageContent::Text("FILE: README.md".to_string()),
                tool_calls: Vec::new(),
                tool_call_id: Some("call_123".to_string()),
                provider_input_items: None,
                provider_turn_state: None,
            },
        ],
        tools: Vec::new(),
        tool_choice: Some("auto".to_string()),
        parallel_tool_calls: Some(false),
        workspace_path: None,
        default_workspace_path: None,
        project_mounts: Vec::new(),
        virtual_root_enabled: None,
        focused_project_id: None,
        allowed_tool_ids: Vec::new(),
        copilot_send_timeout_ms: None,
    })
    .expect("request");

    assert_eq!(request.input.len(), 3);
    assert_eq!(request.input[0]["type"], "reasoning");
    assert!(request.input[0].get("id").is_none());
    assert!(request.input[0].get("status").is_none());
    assert_eq!(request.input[0]["encrypted_content"], "enc_123");
    assert_eq!(request.input[1]["type"], "function_call");
    assert!(request.input[1].get("id").is_none());
    assert_eq!(request.input[2]["type"], "function_call_output");
    assert_eq!(request.input[2]["call_id"], "call_123");
}

#[test]
fn build_responses_request_drops_unreplayable_reasoning_items_without_encrypted_content() {
    let request = build_responses_request(&AiChatRequest {
        request_id: "req-replay-drop".to_string(),
        provider_id: "chatgpt".to_string(),
        model_id: "gpt-5".to_string(),
        reasoning_effort: None,
        conversation_id: None,
        messages: vec![AiChatMessage {
            role: "assistant".to_string(),
            content: AiChatMessageContent::Text(String::new()),
            tool_calls: Vec::new(),
            tool_call_id: None,
            provider_input_items: None,
            provider_turn_state: Some(json!({
                "provider": "chatgpt",
                "output_items": [
                    {
                        "id": "rs_legacy",
                        "type": "reasoning",
                        "summary": [
                            {
                                "type": "summary_text",
                                "text": "Legacy reasoning summary."
                            }
                        ]
                    },
                    {
                        "id": "msg_123",
                        "type": "message",
                        "role": "assistant",
                        "status": "completed",
                        "content": [
                            {
                                "type": "output_text",
                                "text": "Visible assistant text."
                            }
                        ]
                    }
                ]
            })),
        }],
        tools: Vec::new(),
        tool_choice: Some("auto".to_string()),
        parallel_tool_calls: Some(false),
        workspace_path: None,
        default_workspace_path: None,
        project_mounts: Vec::new(),
        virtual_root_enabled: None,
        focused_project_id: None,
        allowed_tool_ids: Vec::new(),
        copilot_send_timeout_ms: None,
    })
    .expect("request");

    assert_eq!(request.input.len(), 1);
    assert_eq!(request.input[0]["type"], "message");
    assert_eq!(
        request.input[0]["content"][0]["text"],
        "Visible assistant text."
    );
}

#[test]
fn normalize_provider_input_items_strips_ids_and_normalizes_message_parts() {
    let normalized = normalize_provider_input_items_for_replay(&[
        json!({
            "id": "msg_123",
            "status": "completed",
            "type": "message",
            "role": "user",
            "content": [
                {
                    "type": "output_text",
                    "text": "Hello"
                },
                {
                    "type": "image_url",
                    "image_url": {
                        "url": "data:image/png;base64,abc"
                    }
                }
            ]
        }),
        json!({
            "id": "fc_out_123",
            "status": "completed",
            "type": "function_call_output",
            "call_id": "call_123",
            "output": "done"
        }),
        json!({
            "id": "orphan_out_1",
            "status": "completed",
            "type": "output_text",
            "text": "Assistant fallback."
        }),
    ])
    .expect("normalized");

    assert_eq!(normalized.len(), 3);
    assert_eq!(normalized[0]["type"], "message");
    assert_eq!(normalized[0]["role"], "user");
    assert_eq!(normalized[0]["content"][0]["type"], "input_text");
    assert_eq!(normalized[0]["content"][0]["text"], "Hello");
    assert_eq!(normalized[0]["content"][1]["type"], "input_image");
    assert_eq!(
        normalized[0]["content"][1]["image_url"],
        "data:image/png;base64,abc"
    );
    assert!(normalized[0].get("id").is_none());
    assert!(normalized[1].get("id").is_none());
    assert_eq!(normalized[1]["type"], "function_call_output");
    assert_eq!(normalized[1]["call_id"], "call_123");
    assert_eq!(normalized[2]["type"], "message");
    assert_eq!(normalized[2]["role"], "assistant");
    assert_eq!(normalized[2]["content"][0]["text"], "Assistant fallback.");
}

#[test]
fn extract_output_text_from_output_item_reads_completed_message_items() {
    let item = json!({
        "id": "msg_123",
        "status": "completed",
        "type": "message",
        "role": "assistant",
        "content": [
            {
                "type": "output_text",
                "text": "Point sur les deux projets."
            }
        ]
    });

    assert_eq!(
        extract_output_text_from_output_item(&item),
        "Point sur les deux projets."
    );
}

#[test]
fn extract_output_text_from_output_item_reads_message_text_parts_with_nested_value() {
    let item = json!({
        "id": "msg_456",
        "status": "completed",
        "type": "message",
        "role": "assistant",
        "content": [
            {
                "type": "text",
                "text": {
                    "value": "Texte final depuis message.content."
                }
            }
        ]
    });

    assert_eq!(
        extract_output_text_from_output_item(&item),
        "Texte final depuis message.content."
    );
}

#[test]
fn extract_output_text_from_output_item_reads_direct_output_text_items() {
    let item = json!({
        "id": "out_123",
        "status": "completed",
        "type": "output_text",
        "text": "Synthese finale."
    });

    assert_eq!(
        extract_output_text_from_output_item(&item),
        "Synthese finale."
    );
}

#[test]
fn extract_reasoning_summary_from_output_item_reads_summary_text() {
    let item = json!({
        "id": "rs_123",
        "status": "completed",
        "type": "reasoning",
        "summary": [
            {
                "type": "summary_text",
                "text": "Le modele a compare les besoins puis choisi un plan."
            }
        ]
    });

    assert_eq!(
        extract_reasoning_summary_from_output_item(&item),
        "Le modele a compare les besoins puis choisi un plan."
    );
}

#[test]
fn extract_completed_reasoning_summary_and_response_id_from_completed_payload() {
    let payload = json!({
        "response": {
            "id": "resp_456",
            "output": [
                {
                    "id": "rs_123",
                    "type": "reasoning",
                    "summary": [
                        {
                            "type": "summary_text",
                            "text": "Resume de raisonnement."
                        }
                    ]
                },
                {
                    "id": "msg_123",
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "output_text",
                            "text": "Texte final."
                        }
                    ]
                }
            ]
        }
    });

    assert_eq!(
        extract_completed_reasoning_summary(&payload).as_deref(),
        Some("Resume de raisonnement.")
    );
    assert_eq!(extract_response_id(&payload).as_deref(), Some("resp_456"));
}

#[test]
fn extract_completed_output_text_prefers_output_text_helper_when_present() {
    let payload = json!({
        "response": {
            "id": "resp_789",
            "output_text": "Texte helper final.",
            "output": [
                {
                    "id": "msg_123",
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "output_text",
                            "text": "Texte helper final."
                        }
                    ]
                }
            ]
        }
    });

    assert_eq!(
        super::stream::extract_completed_output_text(&payload),
        "Texte helper final."
    );
}

#[test]
fn extract_function_call_from_output_item_reads_completed_function_calls() {
    let item = json!({
        "id": "fc_123",
        "call_id": "call_123",
        "status": "completed",
        "type": "function_call",
        "name": "list",
        "arguments": "{\"path\":\".\"}"
    });

    let tool_call = extract_function_call_from_output_item(&item)
        .expect("tool call parse")
        .expect("function call");

    assert_eq!(tool_call.id, "call_123");
    assert_eq!(tool_call.function.name, "list");
    assert_eq!(tool_call.function.arguments, "{\"path\":\".\"}");
}

#[test]
fn authorize_url_contains_pkce_and_state() {
    let pkce = PkceCodes {
        verifier: "verifier".to_string(),
        challenge: "challenge".to_string(),
    };
    let url = build_authorize_url("http://localhost:1455/auth/callback", &pkce, "state-123")
        .expect("url");
    let params = url.query_pairs().collect::<Vec<_>>();
    assert!(params
        .iter()
        .any(|(key, value)| key == "state" && value == "state-123"));
    assert!(params
        .iter()
        .any(|(key, value)| key == "code_challenge" && value == "challenge"));
    assert!(params.iter().any(|(key, value)| {
        key == "redirect_uri" && value == "http://localhost:1455/auth/callback"
    }));
    assert!(params
        .iter()
        .any(|(key, value)| key == "originator" && value == "codex_cli_rs"));
    assert!(params.iter().any(|(key, value)| {
        key == "scope"
            && value
                == "openid profile email offline_access api.connectors.read api.connectors.invoke"
    }));
}

#[test]
fn persist_secret_errors_map_to_secret_persist_failed() {
    let error = auth_flow_error_from_persist(PersistChatGptSessionError::Secret(
        "Secret write failed".to_string(),
    ));

    assert_eq!(error.code, "secret_persist_failed");
    assert_eq!(error.message, "Secret write failed");
}

#[tokio::test]
async fn browser_auth_callback_server_returns_authorization_code() {
    let _guard = AUTH_SERVER_TEST_MUTEX.lock().await;
    let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    let (redirect_uri, callback_rx) =
        spawn_browser_auth_callback_server("state-123".to_string(), cancel_rx)
            .await
            .expect("server");

    assert_eq!(redirect_uri, "http://localhost:1455/auth/callback");

    let response = reqwest::Client::new()
        .get(format!("{redirect_uri}?code=auth-code&state=state-123"))
        .send()
        .await
        .expect("response");
    assert!(response.status().is_success());

    let code = tokio::time::timeout(std::time::Duration::from_secs(2), callback_rx)
        .await
        .expect("callback timeout")
        .expect("callback sender")
        .expect("authorization code");
    assert_eq!(code, "auth-code");
}

#[tokio::test]
async fn browser_auth_cancel_route_shuts_down_server() {
    let _guard = AUTH_SERVER_TEST_MUTEX.lock().await;
    let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    let (_redirect_uri, callback_rx) =
        spawn_browser_auth_callback_server("state-cancel".to_string(), cancel_rx)
            .await
            .expect("server");

    let response = reqwest::Client::new()
        .get(format!(
            "http://127.0.0.1:{}{}",
            CHATGPT_CALLBACK_PORT, CHATGPT_CANCEL_PATH
        ))
        .send()
        .await
        .expect("response");
    assert!(response.status().is_success());

    let result = tokio::time::timeout(std::time::Duration::from_secs(2), callback_rx)
        .await
        .expect("callback receiver");
    assert!(result.is_err());
}

#[tokio::test]
async fn browser_auth_reclaims_fixed_port_after_cancel() {
    let _guard = AUTH_SERVER_TEST_MUTEX.lock().await;
    let (_first_cancel_tx, first_cancel_rx) = tokio::sync::watch::channel(false);
    let (first_redirect_uri, first_callback_rx) =
        spawn_browser_auth_callback_server("state-first".to_string(), first_cancel_rx)
            .await
            .expect("first server");

    let (_second_cancel_tx, second_cancel_rx) = tokio::sync::watch::channel(false);
    let (second_redirect_uri, second_callback_rx) =
        spawn_browser_auth_callback_server("state-second".to_string(), second_cancel_rx)
            .await
            .expect("second server");

    assert_eq!(first_redirect_uri, "http://localhost:1455/auth/callback");
    assert_eq!(second_redirect_uri, first_redirect_uri);

    let first_result = tokio::time::timeout(std::time::Duration::from_secs(2), first_callback_rx)
        .await
        .expect("first callback receiver");
    assert!(first_result.is_err());

    let response = reqwest::Client::new()
        .get(format!(
            "{second_redirect_uri}?code=second-code&state=state-second"
        ))
        .send()
        .await
        .expect("response");
    assert!(response.status().is_success());

    let second_code = tokio::time::timeout(std::time::Duration::from_secs(2), second_callback_rx)
        .await
        .expect("second callback timeout")
        .expect("second callback sender")
        .expect("second authorization code");
    assert_eq!(second_code, "second-code");
}

#[test]
fn token_expiry_prefers_claims_then_expires_in() {
    let explicit = resolve_token_expiry_rfc3339(Some(Utc::now()), Some(30));
    assert!(explicit.is_some());
    let fallback = resolve_token_expiry_rfc3339(None, Some(30));
    assert!(fallback.is_some());
}

#[test]
fn model_supports_plan_matches_case_insensitively() {
    let entry = ModelsCacheEntry {
        slug: "gpt-5.4".to_string(),
        display_name: None,
        description: None,
        visibility: Some("list".to_string()),
        available_in_plans: Some(vec!["Plus".to_string(), "Pro".to_string()]),
    };

    assert!(model_supports_plan(&entry, "plus"));
    assert!(model_supports_plan(&entry, "PRO"));
    assert!(!model_supports_plan(&entry, "team"));
}

#[test]
fn build_provider_models_filters_hidden_and_prefers_matching_plan() {
    let entries = vec![
        ModelsCacheEntry {
            slug: "visible-plus".to_string(),
            display_name: Some("Visible Plus".to_string()),
            description: Some("Included for Plus".to_string()),
            visibility: Some("list".to_string()),
            available_in_plans: Some(vec!["plus".to_string()]),
        },
        ModelsCacheEntry {
            slug: "visible-team".to_string(),
            display_name: Some("Visible Team".to_string()),
            description: Some("Included for Team".to_string()),
            visibility: Some("list".to_string()),
            available_in_plans: Some(vec!["team".to_string()]),
        },
        ModelsCacheEntry {
            slug: "hidden-model".to_string(),
            display_name: Some("Hidden".to_string()),
            description: None,
            visibility: Some("hidden".to_string()),
            available_in_plans: Some(vec!["plus".to_string()]),
        },
    ];

    let plus_models = build_provider_models(&entries, Some("plus"));
    assert_eq!(plus_models.len(), 1);
    assert_eq!(plus_models[0].model_id, "visible-plus");

    let fallback_models = build_provider_models(&entries, Some("enterprise"));
    assert_eq!(fallback_models.len(), 2);
    assert_eq!(fallback_models[0].model_id, "visible-plus");
    assert_eq!(fallback_models[1].model_id, "visible-team");
}

#[test]
fn build_provider_models_assigns_reasoning_to_cached_chatgpt_gpt5_families() {
    let entries = vec![
        ModelsCacheEntry {
            slug: "gpt-5.4-mini".to_string(),
            display_name: Some("GPT-5.4-Mini".to_string()),
            description: None,
            visibility: Some("list".to_string()),
            available_in_plans: None,
        },
        ModelsCacheEntry {
            slug: "gpt-5.3-codex".to_string(),
            display_name: Some("gpt-5.3-codex".to_string()),
            description: None,
            visibility: Some("list".to_string()),
            available_in_plans: None,
        },
    ];

    let models = build_provider_models(&entries, None);
    assert_eq!(
        models[0].reasoning_efforts.clone().unwrap_or_default(),
        vec![
            "low".to_string(),
            "medium".to_string(),
            "high".to_string(),
            "xhigh".to_string()
        ]
    );
    assert_eq!(
        models[0].default_reasoning_effort.as_deref(),
        Some("medium")
    );
    assert_eq!(
        models[1].reasoning_efforts.clone().unwrap_or_default(),
        vec![
            "low".to_string(),
            "medium".to_string(),
            "high".to_string(),
            "xhigh".to_string()
        ]
    );
    assert_eq!(
        models[1].default_reasoning_effort.as_deref(),
        Some("medium")
    );
}
