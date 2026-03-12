use crate::db::DbError;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::{oneshot, Mutex};

pub(super) const CHATGPT_BROWSER_SOURCE: &str = "browser";
pub(super) const CHATGPT_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub(super) const CHATGPT_AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
pub(super) const CHATGPT_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
pub(super) const CHATGPT_CALLBACK_PATH: &str = "/auth/callback";
pub(super) const CHATGPT_CANCEL_PATH: &str = "/cancel";
pub(super) const CHATGPT_CALLBACK_BIND_HOST: &str = "127.0.0.1";
pub(super) const CHATGPT_CALLBACK_PUBLIC_HOST: &str = "localhost";
pub(super) const CHATGPT_CALLBACK_PORT: u16 = 1455;
pub(super) const DEFAULT_ORIGINATOR: &str = "codex_cli_rs";
pub(super) const DEFAULT_CODEX_CLIENT_VERSION: &str = "0.112.0";
pub(super) const TOKEN_REFRESH_LEEWAY_SECONDS: i64 = 300;
pub(super) const AUTH_TIMEOUT_SECONDS: u64 = 180;
pub(super) const CALLBACK_BIND_RETRY_ATTEMPTS: u32 = 10;
pub(super) const CALLBACK_BIND_RETRY_DELAY_MS: u64 = 200;

pub(super) const HTML_SUCCESS: &str = r#"<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Macro - ChatGPT Authorization Successful</title>
  </head>
  <body>
    <h1>Authorization successful</h1>
    <p>You can close this window and return to Macro.</p>
  </body>
</html>"#;

pub(super) const HTML_CANCELLED: &str = r#"<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Macro - ChatGPT Authorization Cancelled</title>
  </head>
  <body>
    <h1>Authorization cancelled</h1>
    <p>You can close this window and return to Macro.</p>
  </body>
</html>"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiChatRequest {
    pub request_id: String,
    pub provider_id: String,
    pub model_id: String,
    pub messages: Vec<AiChatMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiChatMessage {
    pub role: String,
    pub content: AiChatMessageContent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AiChatMessageContent {
    Text(String),
    Parts(Vec<AiChatMessagePart>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiChatMessagePart {
    #[serde(rename = "type")]
    pub kind: String,
    pub text: Option<String>,
    pub image_url: Option<AiChatImageUrl>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiChatImageUrl {
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiStreamChunkEvent {
    pub request_id: String,
    pub delta: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiStreamDoneEvent {
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiStreamErrorEvent {
    pub request_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiAuthStartedEvent {
    pub request_id: String,
    pub provider_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiAuthSuccessEvent {
    pub request_id: String,
    pub provider_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiAuthCancelledEvent {
    pub request_id: String,
    pub provider_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiAuthErrorEvent {
    pub request_id: String,
    pub provider_id: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct ModelsCacheFile {
    pub(super) client_version: Option<String>,
    pub(super) models: Vec<ModelsCacheEntry>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct ModelsCacheEntry {
    pub(super) slug: String,
    pub(super) display_name: Option<String>,
    pub(super) description: Option<String>,
    pub(super) visibility: Option<String>,
    pub(super) available_in_plans: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub(super) struct CodexVersionFile {
    pub(super) latest_version: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct RemoteModelsResponse {
    pub(super) models: Vec<ModelsCacheEntry>,
}

#[derive(Debug, Deserialize)]
pub(super) struct TokenResponse {
    pub(super) access_token: Option<String>,
    pub(super) refresh_token: Option<String>,
    pub(super) id_token: Option<String>,
    pub(super) expires_in: Option<i64>,
}

#[derive(Debug, Serialize)]
pub(super) struct ChatGptResponsesRequest {
    pub(super) model: String,
    pub(super) instructions: String,
    pub(super) input: Vec<ResponsesMessageItem>,
    pub(super) tools: Vec<Value>,
    pub(super) tool_choice: String,
    pub(super) parallel_tool_calls: bool,
    pub(super) reasoning: Option<Value>,
    pub(super) store: bool,
    pub(super) stream: bool,
    pub(super) include: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum ResponsesMessageItem {
    Message {
        role: String,
        content: Vec<ResponsesContentItem>,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum ResponsesContentItem {
    InputText { text: String },
    InputImage { image_url: String },
    OutputText { text: String },
}

#[derive(Clone)]
pub(super) struct BrowserAuthServerState {
    pub(super) expected_state: String,
    pub(super) result_sender: Arc<Mutex<Option<oneshot::Sender<Result<String, AuthFlowError>>>>>,
    pub(super) shutdown_sender: Arc<Mutex<Option<oneshot::Sender<()>>>>,
}

#[derive(Debug, Deserialize)]
pub(super) struct BrowserAuthCallbackQuery {
    pub(super) code: Option<String>,
    pub(super) state: Option<String>,
    pub(super) error: Option<String>,
    pub(super) error_description: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) struct AuthFlowError {
    pub(super) code: String,
    pub(super) message: String,
}

impl AuthFlowError {
    pub(super) fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub(super) enum PersistChatGptSessionError {
    Secret(String),
    Metadata(String),
}

impl PersistChatGptSessionError {
    pub(super) fn code(&self) -> &'static str {
        match self {
            Self::Secret(_) => "secret_persist_failed",
            Self::Metadata(_) => "token_exchange_failed",
        }
    }

    pub(super) fn message(self) -> String {
        match self {
            Self::Secret(message) | Self::Metadata(message) => message,
        }
    }
}

pub(super) fn auth_flow_error_from_persist(error: PersistChatGptSessionError) -> AuthFlowError {
    AuthFlowError::new(error.code(), error.message())
}

#[derive(Debug, Clone)]
pub(super) struct TokenClaims {
    pub(super) expires_at: Option<DateTime<Utc>>,
    pub(super) plan_type: Option<String>,
    pub(super) account_id: Option<String>,
    pub(super) email: Option<String>,
}

pub(super) struct PkceCodes {
    pub(super) verifier: String,
    pub(super) challenge: String,
}

pub(super) fn extract_response_error(status: u16, body: &str) -> String {
    if body.trim().is_empty() {
        return format!("ChatGPT request failed with status {}.", status);
    }

    if let Ok(value) = serde_json::from_str::<Value>(body) {
        if let Some(message) = value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
        {
            return message.to_string();
        }

        if let Some(message) = value.get("message").and_then(Value::as_str) {
            return message.to_string();
        }
    }

    format!("ChatGPT request failed with status {}: {}", status, body)
}

pub(super) fn db_error_to_string(error: DbError) -> String {
    error.to_string()
}
