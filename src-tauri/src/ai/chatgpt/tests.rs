use super::auth::{build_authorize_url, spawn_browser_auth_callback_server};
use super::models::{build_provider_models, model_supports_plan};
use super::session::{
    build_provider_auth_metadata, build_token_claims, decode_jwt_payload,
    resolve_token_expiry_rfc3339,
};
use super::stream::build_responses_request;
use super::types::{
    auth_flow_error_from_persist, AiChatMessage, AiChatMessageContent, ModelsCacheEntry,
    PersistChatGptSessionError, PkceCodes, CHATGPT_CALLBACK_PORT, CHATGPT_CANCEL_PATH,
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
    let request = build_responses_request(
        "gpt-5",
        &[
            AiChatMessage {
                role: "system".to_string(),
                content: AiChatMessageContent::Text("Follow instructions".to_string()),
            },
            AiChatMessage {
                role: "user".to_string(),
                content: AiChatMessageContent::Text("Hello".to_string()),
            },
            AiChatMessage {
                role: "assistant".to_string(),
                content: AiChatMessageContent::Text("Hi".to_string()),
            },
        ],
    )
    .expect("request");

    assert_eq!(request.model, "gpt-5");
    assert_eq!(request.instructions, "Follow instructions");
    assert_eq!(request.input.len(), 2);
    assert!(request.tools.is_empty());
    assert!(!request.store);
    assert!(request.stream);
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
        "Keyring write failed".to_string(),
    ));

    assert_eq!(error.code, "secret_persist_failed");
    assert_eq!(error.message, "Keyring write failed");
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
