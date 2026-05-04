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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiChatRequest {
    pub request_id: String,
    pub provider_id: String,
    pub model_id: String,
    pub reasoning_effort: Option<String>,
    pub conversation_id: Option<String>,
    pub messages: Vec<AiChatMessage>,
    #[serde(default)]
    pub tools: Vec<Value>,
    pub tool_choice: Option<String>,
    pub parallel_tool_calls: Option<bool>,
    pub workspace_path: Option<String>,
    pub default_workspace_path: Option<String>,
    #[serde(default)]
    pub project_mounts: Vec<AiProjectMount>,
    pub virtual_root_enabled: Option<bool>,
    pub focused_project_id: Option<String>,
    #[serde(default)]
    pub allowed_tool_ids: Vec<String>,
    #[serde(default)]
    pub copilot_send_timeout_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiChatMessage {
    pub role: String,
    pub content: AiChatMessageContent,
    #[serde(default)]
    pub tool_calls: Vec<AiToolCall>,
    pub tool_call_id: Option<String>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_input_items: Option<Vec<Value>>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_turn_state: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub function: AiToolCallFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiToolCallFunction {
    pub name: String,
    pub arguments: String,
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
pub struct AiStreamToolTraceEvent {
    pub request_id: String,
    pub tool_trace: AiToolTrace,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiStreamDoneEvent {
    pub request_id: String,
    pub output_text: String,
    pub tool_calls: Vec<AiToolCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_items: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_input_items: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_turn_state: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_traces: Option<Vec<AiToolTrace>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden_context: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiStreamErrorEvent {
    pub request_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiStreamTimelineEvent {
    pub request_id: String,
    pub provider_id: String,
    pub provider_type: String,
    pub phase: String,
    pub elapsed_ms: u64,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiProjectMount {
    pub project_id: String,
    pub mount_name: String,
    pub workspace_path: Option<String>,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiToolTrace {
    pub tool_call_id: String,
    pub tool_name: String,
    pub detail: Option<String>,
    pub status: String,
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
    pub(super) input: Vec<Value>,
    pub(super) tools: Vec<Value>,
    pub(super) tool_choice: String,
    pub(super) parallel_tool_calls: bool,
    pub(super) reasoning: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) prompt_cache_key: Option<String>,
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
    FunctionCall {
        call_id: String,
        name: String,
        arguments: String,
    },
    FunctionCallOutput {
        call_id: String,
        output: String,
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
    pub(super) result_sender: BrowserAuthResultSender,
    pub(super) shutdown_sender: Arc<Mutex<Option<oneshot::Sender<()>>>>,
}

type BrowserAuthResult = Result<String, AuthFlowError>;
type BrowserAuthResultSender = Arc<Mutex<Option<oneshot::Sender<BrowserAuthResult>>>>;

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

fn auth_copy(
    language: &str,
) -> (
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
) {
    match language {
        "fr" => (
            "Macro - Autorisation ChatGPT réussie",
            "Autorisation réussie",
            "Vous pouvez fermer cette fenêtre et revenir dans Macro.",
            "Macro - Autorisation ChatGPT annulée",
            "Autorisation annulée",
            "Macro - Autorisation ChatGPT échouée",
        ),
        "es" => (
            "Macro - Autorización de ChatGPT correcta",
            "Autorización completada",
            "Puedes cerrar esta ventana y volver a Macro.",
            "Macro - Autorización de ChatGPT cancelada",
            "Autorización cancelada",
            "Macro - Error de autorización de ChatGPT",
        ),
        "de" => (
            "Macro - ChatGPT-Autorisierung erfolgreich",
            "Autorisierung erfolgreich",
            "Du kannst dieses Fenster schließen und zu Macro zurückkehren.",
            "Macro - ChatGPT-Autorisierung abgebrochen",
            "Autorisierung abgebrochen",
            "Macro - ChatGPT-Autorisierung fehlgeschlagen",
        ),
        "ja" => (
            "Macro - ChatGPT 認証に成功しました",
            "認証に成功しました",
            "このウィンドウを閉じて Macro に戻ってください。",
            "Macro - ChatGPT 認証がキャンセルされました",
            "認証がキャンセルされました",
            "Macro - ChatGPT 認証に失敗しました",
        ),
        "ko" => (
            "Macro - ChatGPT 인증 성공",
            "인증이 완료되었습니다",
            "이 창을 닫고 Macro로 돌아가세요.",
            "Macro - ChatGPT 인증 취소됨",
            "인증이 취소되었습니다",
            "Macro - ChatGPT 인증 실패",
        ),
        _ => (
            "Macro - ChatGPT Authorization Successful",
            "Authorization successful",
            "You can close this window and return to Macro.",
            "Macro - ChatGPT Authorization Cancelled",
            "Authorization cancelled",
            "Macro - ChatGPT Authorization Failed",
        ),
    }
}

pub(super) fn resolve_browser_language(accept_language: Option<&str>) -> &'static str {
    let Some(value) = accept_language else {
        return "en";
    };

    let normalized = value
        .split(',')
        .find_map(|entry| entry.split(';').next())
        .map(str::trim)
        .unwrap_or("en")
        .to_ascii_lowercase();

    match normalized.as_str() {
        value if value.starts_with("fr") => "fr",
        value if value.starts_with("es") => "es",
        value if value.starts_with("de") => "de",
        value if value.starts_with("ja") => "ja",
        value if value.starts_with("ko") => "ko",
        _ => "en",
    }
}

pub(super) fn build_auth_success_html(language: &str) -> String {
    let (title, heading, body, _, _, _) = auth_copy(language);
    format!(
        "<!doctype html><html lang=\"{language}\"><head><meta charset=\"utf-8\" /><title>{title}</title></head><body><h1>{heading}</h1><p>{body}</p></body></html>"
    )
}

pub(super) fn build_auth_cancelled_html(language: &str) -> String {
    let (_, _, body, title, heading, _) = auth_copy(language);
    format!(
        "<!doctype html><html lang=\"{language}\"><head><meta charset=\"utf-8\" /><title>{title}</title></head><body><h1>{heading}</h1><p>{body}</p></body></html>"
    )
}

pub(super) fn build_auth_failure_html(language: &str, message: &str) -> String {
    let (_, _, _, _, _, title) = auth_copy(language);
    let heading = match language {
        "fr" => "Échec de l'autorisation",
        "es" => "La autorización ha fallado",
        "de" => "Autorisierung fehlgeschlagen",
        "ja" => "認証に失敗しました",
        "ko" => "인증에 실패했습니다",
        _ => "Authorization failed",
    };

    format!(
        "<!doctype html><html lang=\"{language}\"><head><meta charset=\"utf-8\" /><title>{title}</title></head><body><h1>{heading}</h1><p>{}</p></body></html>",
        html_escape(message)
    )
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
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
