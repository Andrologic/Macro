use crate::ai::chatgpt::types::{
    AiChatMessage, AiChatMessageContent, AiChatRequest, AiStreamChunkEvent, AiStreamDoneEvent,
    AiStreamErrorEvent, AiToolCall, AiToolCallFunction,
};
use crate::ai::copilot::{
    CopilotAuthCancelledEvent, CopilotAuthCompleteEvent, CopilotAuthErrorEvent,
    CopilotAuthProgressEvent, CopilotStatus,
};
use crate::ai::copilot_policy::{self, CopilotRemoteModel};
use crate::ai::reasoning_catalog::resolve_reasoning_capability;
use crate::ai::{AiState, AuthTask, CopilotModelFailureRecord};
use crate::db::models::{
    AiModel, ModelCapabilities, ModelEndpointFlavor, ProviderAuthMetadata, ProviderConfig,
    ProviderModelInput,
};
use crate::db::repository;
use crate::secrets::{self, CopilotSecret};
use chrono::{DateTime, Utc};
use futures::StreamExt;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::env;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::watch;
use tokio::time::sleep;
use tracing::{debug, info, warn};

const COPILOT_DEFAULT_BASE_URL: &str = "https://api.githubcopilot.com";
const COPILOT_MODELS_PATH: &str = "/models";
const COPILOT_CHAT_COMPLETIONS_PATH: &str = "/chat/completions";
const COPILOT_RESPONSES_PATH: &str = "/responses";
const COPILOT_GITHUB_CLIENT_ID_ENV: &str = "MACRO_COPILOT_GITHUB_CLIENT_ID";
const COPILOT_DISPLAY_NAME_ENV: &str = "MACRO_COPILOT_DISPLAY_NAME";
const COPILOT_GITHUB_DEVICE_CODE_URL_ENV: &str = "MACRO_COPILOT_GITHUB_DEVICE_CODE_URL";
const COPILOT_GITHUB_ACCESS_TOKEN_URL_ENV: &str = "MACRO_COPILOT_GITHUB_ACCESS_TOKEN_URL";
const COPILOT_USER_AGENT_ENV: &str = "MACRO_COPILOT_USER_AGENT";
const COPILOT_GITHUB_PROFILE_URL: &str = "https://api.github.com/user";
const COPILOT_OPENAI_INTENT: &str = "conversation-edits";
const COPILOT_AUTH_SOURCE: &str = "oauth_app";
const COPILOT_INDIVIDUAL_BASE_URL: &str = "https://api.individual.githubcopilot.com";
const COPILOT_DISCOVERY_INTEGRATION_ID: &str = "vscode-chat";
const COPILOT_DISCOVERY_EDITOR_VERSION: &str = "vscode/1.103.0";
const TOKEN_REFRESH_LEEWAY_SECONDS: i64 = 300;
const OAUTH_POLLING_SAFETY_MARGIN_MS: u64 = 3000;
const REQUEST_TIMEOUT_SECONDS: u64 = 30;

#[derive(Debug, Clone, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
struct AccessTokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    refresh_token_expires_in: Option<i64>,
    error: Option<String>,
    error_description: Option<String>,
    _interval: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubProfile {
    login: Option<String>,
    name: Option<String>,
    email: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct CopilotModelsEnvelope {
    data: Vec<CopilotRemoteModelRecord>,
}

#[derive(Debug, Clone, Deserialize)]
struct CopilotRemoteModelRecord {
    id: String,
    name: Option<String>,
    version: Option<String>,
    model_picker_enabled: Option<bool>,
    supported_endpoints: Option<Vec<String>>,
    capabilities: Option<CopilotRemoteCapabilities>,
}

#[derive(Debug, Clone, Deserialize)]
struct CopilotRemoteCapabilities {
    family: Option<String>,
    limits: Option<CopilotRemoteLimits>,
    supports: Option<CopilotRemoteSupports>,
}

#[derive(Debug, Clone, Deserialize)]
struct CopilotRemoteLimits {
    max_context_window_tokens: Option<i32>,
    max_output_tokens: Option<i32>,
    #[allow(dead_code)]
    max_prompt_tokens: Option<i32>,
    vision: Option<CopilotRemoteVisionLimits>,
}

#[derive(Debug, Clone, Deserialize)]
struct CopilotRemoteVisionLimits {
    supported_media_types: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
struct CopilotRemoteSupports {
    adaptive_thinking: Option<bool>,
    reasoning_effort: Option<Vec<String>>,
    structured_outputs: Option<bool>,
    tool_calls: Option<bool>,
    vision: Option<bool>,
}

#[derive(Debug, Clone, Default)]
struct ChatStreamAccumulator {
    output_text: String,
    reasoning_summary: String,
    reasoning_opaque: Option<String>,
    tool_calls: Vec<AiToolCall>,
}

#[derive(Debug, Clone, Default)]
struct ResponsesStreamAccumulator {
    output_text: String,
    reasoning_summary: String,
    output_items: Vec<Value>,
    tool_calls: Vec<AiToolCall>,
    response_id: Option<String>,
    saw_output_text_delta: bool,
    saw_reasoning_summary_delta: bool,
}

#[derive(Debug, Clone)]
struct CopilotSession {
    provider: ProviderConfig,
    secret: CopilotSecret,
}

#[derive(Debug, Clone)]
struct CopilotOAuthRuntimeConfig {
    client_id: String,
    display_name: String,
    device_code_url: String,
    access_token_url: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CopilotModelDiagnostics {
    pub auth_source: String,
    pub configured_client_kind: String,
    pub selected_profile: String,
    pub user_agent: String,
    pub base_url: String,
    pub models_status_code: Option<u16>,
    pub total_remote_models: usize,
    pub visible_model_ids: Vec<String>,
    pub displayed_model_ids: Vec<String>,
    pub raw_models: Vec<CopilotModelDiagnosticItem>,
    pub attempts: Vec<CopilotDiscoveryAttemptSummary>,
    pub last_failure: Option<CopilotModelFailureDiagnostic>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CopilotRawModelsPayload {
    pub auth_source: String,
    pub configured_client_kind: String,
    pub selected_profile: String,
    pub user_agent: String,
    pub base_url: String,
    pub status_code: Option<u16>,
    pub attempts: Vec<CopilotDiscoveryAttemptSummary>,
    pub payload: Value,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CopilotDiscoveryAttemptSummary {
    pub profile: String,
    pub base_url: String,
    pub user_agent: String,
    pub enabled_headers: Vec<String>,
    pub status_code: Option<u16>,
    pub total_remote_models: usize,
    pub visible_model_ids: Vec<String>,
    pub endpoint_capable_models: usize,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CopilotModelDiagnosticItem {
    pub id: String,
    pub name: String,
    pub model_picker_enabled: bool,
    pub supported_endpoints: Vec<String>,
    pub endpoint_flavor: String,
    pub supports_tool_calling: Option<bool>,
    pub supports_reasoning_effort: Option<bool>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CopilotModelFailureDiagnostic {
    pub model_id: String,
    pub endpoint_flavor: String,
    pub status_code: Option<u16>,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CopilotProviderTurnState {
    endpoint_flavor: ModelEndpointFlavor,
    reasoning_opaque: Option<String>,
    response_id: Option<String>,
    stored_item_refs: Vec<String>,
    provider_items_digest: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ChatSseChoiceDelta {
    content: Option<String>,
    reasoning_text: Option<String>,
    reasoning_opaque: Option<String>,
    tool_calls: Option<Vec<ChatSseToolCallDelta>>,
}

#[derive(Debug, Clone, Deserialize)]
struct ChatSseChoice {
    delta: Option<ChatSseChoiceDelta>,
    _finish_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ChatSseChunk {
    choices: Option<Vec<ChatSseChoice>>,
}

#[derive(Debug, Clone, Deserialize)]
struct ChatSseToolCallDelta {
    index: Option<usize>,
    id: Option<String>,
    function: Option<ChatSseToolFunctionDelta>,
}

#[derive(Debug, Clone, Deserialize)]
struct ChatSseToolFunctionDelta {
    name: Option<String>,
    arguments: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct PendingToolCall {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CopilotRecoveryAction {
    RetryAsChat,
    None,
}

#[derive(Debug, Clone)]
struct FetchModelsResult {
    profile: CopilotDiscoveryProfile,
    models: Vec<CopilotRemoteModelRecord>,
    payload: Value,
    user_agent: String,
    base_url: String,
    status_code: Option<u16>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CopilotDiscoveryProfile {
    MacroNative,
    MacroIdeCompat,
    MacroIdeCompatIndividual,
}

#[derive(Debug, Clone)]
struct ClassifiedCopilotRequestFailure {
    code: String,
    message: String,
    status_code: Option<u16>,
}

fn resolve_base_url(provider: &ProviderConfig) -> String {
    let raw = provider.base_url.trim();
    if raw.is_empty() || raw.starts_with("copilot://") {
        COPILOT_DEFAULT_BASE_URL.to_string()
    } else {
        raw.trim_end_matches('/').to_string()
    }
}

fn non_empty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn infer_client_id_kind(client_id: &str) -> &'static str {
    let trimmed = client_id.trim();
    if trimmed.starts_with("Ov") {
        "oauth_app"
    } else if trimmed.starts_with("Iv") {
        "github_app"
    } else {
        "unknown"
    }
}

fn load_copilot_oauth_config() -> Result<CopilotOAuthRuntimeConfig, String> {
    let config = crate::core::load_config()
        .map_err(|error| format!("Failed to load Macro configuration: {}", error))?;
    let oauth = config.ai.copilot_oauth;
    let display_name = non_empty_env(COPILOT_DISPLAY_NAME_ENV).unwrap_or(oauth.display_name);
    let device_code_url =
        non_empty_env(COPILOT_GITHUB_DEVICE_CODE_URL_ENV).unwrap_or(oauth.device_code_url);
    let access_token_url =
        non_empty_env(COPILOT_GITHUB_ACCESS_TOKEN_URL_ENV).unwrap_or(oauth.access_token_url);
    let client_id = non_empty_env(COPILOT_GITHUB_CLIENT_ID_ENV)
        .or(oauth.client_id.map(|value| value.trim().to_string()))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "GitHub Copilot OAuth App is not configured. Set MACRO_COPILOT_GITHUB_CLIENT_ID or ai.copilotOAuth.clientId to your Macro GitHub OAuth App client ID (Ov...).".to_string()
        })?;
    match infer_client_id_kind(&client_id) {
        "oauth_app" => {}
        "github_app" => {
            return Err(
                "GitHub Copilot in Macro now requires a GitHub OAuth App client ID (Ov...). The current client ID looks like a GitHub App client ID (Iv...). Replace it and reconnect GitHub Copilot.".to_string(),
            )
        }
        _ => {
            return Err(
                "GitHub Copilot in Macro requires a GitHub OAuth App client ID (Ov...). The configured client ID is not recognized as an OAuth App client ID.".to_string(),
            )
        }
    }

    Ok(CopilotOAuthRuntimeConfig {
        client_id,
        display_name,
        device_code_url,
        access_token_url,
    })
}

fn copilot_user_agent() -> String {
    non_empty_env(COPILOT_USER_AGENT_ENV)
        .unwrap_or_else(|| format!("Macro/1.0 (+https://macro.andrologic.ai)"))
}

fn copilot_compatibility_user_agent() -> &'static str {
    "Macro/1.0 (+https://macro.andrologic.ai)"
}

impl CopilotDiscoveryProfile {
    fn as_str(self) -> &'static str {
        match self {
            Self::MacroNative => "macro_native",
            Self::MacroIdeCompat => "macro_ide_compat",
            Self::MacroIdeCompatIndividual => "macro_ide_compat_individual",
        }
    }

    fn enabled_headers(self) -> Vec<String> {
        match self {
            Self::MacroNative => vec![],
            Self::MacroIdeCompat | Self::MacroIdeCompatIndividual => vec![
                "Copilot-Integration-Id".to_string(),
                "Editor-Version".to_string(),
            ],
        }
    }

    fn base_url(self, provider_base_url: &str) -> String {
        match self {
            Self::MacroIdeCompatIndividual => COPILOT_INDIVIDUAL_BASE_URL.to_string(),
            _ => provider_base_url.to_string(),
        }
    }

    fn user_agent(self) -> String {
        match self {
            Self::MacroNative => copilot_user_agent(),
            Self::MacroIdeCompat | Self::MacroIdeCompatIndividual => {
                copilot_compatibility_user_agent().to_string()
            }
        }
    }
}

fn discovery_profiles_for_base_url(provider_base_url: &str) -> Vec<CopilotDiscoveryProfile> {
    let mut profiles = vec![
        CopilotDiscoveryProfile::MacroNative,
        CopilotDiscoveryProfile::MacroIdeCompat,
    ];
    if provider_base_url == COPILOT_DEFAULT_BASE_URL {
        profiles.push(CopilotDiscoveryProfile::MacroIdeCompatIndividual);
    }
    profiles
}

#[cfg(test)]
fn looks_like_legacy_model_catalog(models: &[CopilotRemoteModelRecord]) -> bool {
    if models.len() > 7 {
        return false;
    }

    const LEGACY_MODEL_IDS: &[&str] = &[
        "gpt-4o",
        "gpt-4o-mini",
        "gpt-4o-2024-08-06",
        "gpt-4o-2024-11-20",
        "gpt-4o-mini-2024-07-18",
        "gpt-3.5-turbo",
        "gpt-3.5-turbo-0613",
    ];

    models
        .iter()
        .all(|model| LEGACY_MODEL_IDS.contains(&model.id.as_str()))
}

fn discovery_score(models: &[CopilotRemoteModelRecord]) -> (usize, usize, usize) {
    let visible = models
        .iter()
        .filter(|model| model.model_picker_enabled.unwrap_or(true))
        .count();
    let endpoint_capable = models
        .iter()
        .filter(|model| {
            model.supported_endpoints
                .as_ref()
                .map(|value| !value.is_empty())
                .unwrap_or(false)
        })
        .count();
    (models.len(), visible, endpoint_capable)
}

fn is_better_discovery_candidate(
    current: &[CopilotRemoteModelRecord],
    challenger: &[CopilotRemoteModelRecord],
) -> bool {
    discovery_score(challenger) > discovery_score(current)
}

fn build_discovery_attempt_summary(
    profile: CopilotDiscoveryProfile,
    base_url: String,
    user_agent: String,
    status_code: Option<u16>,
    models: Option<&[CopilotRemoteModelRecord]>,
    error_message: Option<String>,
) -> CopilotDiscoveryAttemptSummary {
    let models = models.unwrap_or(&[]);
    CopilotDiscoveryAttemptSummary {
        profile: profile.as_str().to_string(),
        base_url,
        user_agent,
        enabled_headers: profile.enabled_headers(),
        status_code,
        total_remote_models: models.len(),
        visible_model_ids: visible_remote_models(models)
            .iter()
            .map(|model| model.id.clone())
            .collect(),
        endpoint_capable_models: models
            .iter()
            .filter(|model| {
                model.supported_endpoints
                    .as_ref()
                    .map(|value| !value.is_empty())
                    .unwrap_or(false)
            })
            .count(),
        error_message,
    }
}

fn is_supported_oauth_session(secret: &CopilotSecret) -> bool {
    secret
        .auth_source
        .trim()
        .eq_ignore_ascii_case(COPILOT_AUTH_SOURCE)
        && secret.client_kind.as_deref() == Some(COPILOT_AUTH_SOURCE)
}

fn auth_source_label(secret: &CopilotSecret) -> String {
    if secret.auth_source.trim().is_empty() {
        "unknown".to_string()
    } else {
        secret.auth_source.clone()
    }
}

async fn cache_copilot_secret(ai_state: &AiState, provider_id: &str, secret: &CopilotSecret) {
    ai_state
        .copilot_session_cache
        .lock()
        .await
        .insert(provider_id.to_string(), secret.clone());
}

async fn clear_cached_copilot_secret(ai_state: &AiState, provider_id: &str) {
    ai_state
        .copilot_session_cache
        .lock()
        .await
        .remove(provider_id);
}

async fn get_cached_copilot_secret(ai_state: &AiState, provider_id: &str) -> Option<CopilotSecret> {
    ai_state
        .copilot_session_cache
        .lock()
        .await
        .get(provider_id)
        .cloned()
}

async fn persist_copilot_secret(
    ai_state: &AiState,
    provider_id: &str,
    secret: &CopilotSecret,
) -> Result<CopilotSecret, String> {
    secrets::set_copilot_secret(provider_id, secret).map_err(|error| error.to_string())?;

    match secrets::get_copilot_secret(provider_id).map_err(|error| error.to_string())? {
        Some(persisted) if persisted == *secret => {
            clear_cached_copilot_secret(ai_state, provider_id).await;
            Ok(persisted)
        }
        Some(persisted) => {
            warn!(
                provider_id = %provider_id,
                "Copilot secret readback differed from the just-written value; keeping an in-memory session fallback"
            );
            cache_copilot_secret(ai_state, provider_id, secret).await;
            Ok(persisted)
        }
        None => {
            warn!(
                provider_id = %provider_id,
                "Copilot secret could not be read back from secure storage; using an in-memory session fallback"
            );
            cache_copilot_secret(ai_state, provider_id, secret).await;
            Ok(secret.clone())
        }
    }
}

async fn get_effective_copilot_secret(
    ai_state: &AiState,
    provider_id: &str,
) -> Result<Option<CopilotSecret>, String> {
    if let Some(secret) =
        secrets::get_copilot_secret(provider_id).map_err(|error| error.to_string())?
    {
        return Ok(Some(secret));
    }

    Ok(get_cached_copilot_secret(ai_state, provider_id).await)
}

fn compute_expiry(expires_in: Option<i64>) -> Option<String> {
    expires_in
        .filter(|value| *value > 0)
        .and_then(|value| Utc::now().checked_add_signed(chrono::Duration::seconds(value)))
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

fn parse_rfc3339_utc(value: Option<&str>) -> Option<DateTime<Utc>> {
    value
        .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
        .map(|value| value.with_timezone(&Utc))
}

fn is_expiring_soon(secret: &CopilotSecret) -> bool {
    parse_rfc3339_utc(secret.access_token_expires_at.as_deref())
        .map(|value| value <= Utc::now() + chrono::Duration::seconds(TOKEN_REFRESH_LEEWAY_SECONDS))
        .unwrap_or(false)
}

fn build_provider_metadata(
    secret: Option<&CopilotSecret>,
    auth_status: &str,
    fallback_account_label: Option<String>,
) -> ProviderAuthMetadata {
    ProviderAuthMetadata {
        auth_status: Some(auth_status.to_string()),
        auth_source: secret.map(|value| value.auth_source.clone()),
        plan_type: None,
        account_label: secret
            .and_then(|value| value.account_label.clone())
            .or(fallback_account_label),
        token_expires_at: secret.and_then(|value| value.access_token_expires_at.clone()),
    }
}

fn provider_turn_state_to_json(state: Option<CopilotProviderTurnState>) -> Option<Value> {
    let state = state?;
    let mut payload = serde_json::Map::new();
    payload.insert("provider".to_string(), Value::String("copilot".to_string()));
    payload.insert(
        "endpoint_flavor".to_string(),
        Value::String(match state.endpoint_flavor {
            ModelEndpointFlavor::Chat => "chat".to_string(),
            ModelEndpointFlavor::Responses => "responses".to_string(),
        }),
    );
    if let Some(reasoning_opaque) = state
        .reasoning_opaque
        .filter(|value| !value.trim().is_empty())
    {
        payload.insert(
            "reasoning_opaque".to_string(),
            Value::String(reasoning_opaque),
        );
    }
    if let Some(response_id) = state.response_id.filter(|value| !value.trim().is_empty()) {
        payload.insert("response_id".to_string(), Value::String(response_id));
    }
    if !state.stored_item_refs.is_empty() {
        payload.insert(
            "stored_item_refs".to_string(),
            Value::Array(
                state
                    .stored_item_refs
                    .into_iter()
                    .map(Value::String)
                    .collect::<Vec<_>>(),
            ),
        );
    }
    if let Some(digest) = state
        .provider_items_digest
        .filter(|value| !value.trim().is_empty())
    {
        payload.insert("provider_items_digest".to_string(), Value::String(digest));
    }
    Some(Value::Object(payload))
}

fn digest_provider_items(items: &[Value]) -> Option<String> {
    if items.is_empty() {
        return None;
    }
    serde_json::to_vec(items).ok().map(|bytes| {
        let mut digest = Sha256::new();
        digest.update(bytes);
        format!("{:x}", digest.finalize())
    })
}

fn supports_reasoning(model: Option<&AiModel>, model_id: &str) -> bool {
    if let Some(capabilities) = model.and_then(|value| value.capabilities.as_ref()) {
        if capabilities.supports_reasoning_effort == Some(true) {
            return true;
        }
        if capabilities.supports_reasoning_effort == Some(false) {
            return false;
        }
    }

    model
        .and_then(|value| value.reasoning_efforts.as_ref())
        .map(|items| !items.is_empty())
        .unwrap_or_else(|| model_id.trim().to_ascii_lowercase().starts_with("gpt-5"))
}

fn supports_encrypted_reasoning(model: Option<&AiModel>, reasoning_supported: bool) -> bool {
    if !reasoning_supported {
        return false;
    }
    model
        .and_then(|value| value.capabilities.as_ref())
        .and_then(|value| value.include_encrypted_reasoning)
        == Some(true)
}

fn supports_response_storage(model: Option<&AiModel>) -> bool {
    model
        .and_then(|value| value.capabilities.as_ref())
        .and_then(|value| value.supports_response_storage)
        == Some(true)
}

fn should_use_copilot_responses_api(model_id: &str) -> bool {
    let trimmed = model_id.trim().to_ascii_lowercase();
    let Some(rest) = trimmed.strip_prefix("gpt-") else {
        return false;
    };
    let major_part = rest
        .chars()
        .take_while(|char| char.is_ascii_digit())
        .collect::<String>();

    let major = major_part.parse::<u32>().unwrap_or(0);

    major >= 5 && !trimmed.starts_with("gpt-5-mini")
}

fn resolve_endpoint_flavor(model: Option<&AiModel>, model_id: &str) -> ModelEndpointFlavor {
    let capabilities = model.and_then(|value| value.capabilities.as_ref());
    if let Some(supported) = capabilities.and_then(|value| value.supported_endpoints.as_ref()) {
        if supported.contains(&ModelEndpointFlavor::Responses) {
            return ModelEndpointFlavor::Responses;
        }
        if supported.contains(&ModelEndpointFlavor::Chat) {
            return ModelEndpointFlavor::Chat;
        }
    }

    capabilities
        .and_then(|value| value.endpoint_flavor.clone())
        .unwrap_or_else(|| {
            if should_use_copilot_responses_api(model_id) {
                ModelEndpointFlavor::Responses
            } else {
                ModelEndpointFlavor::Chat
            }
        })
}

fn endpoint_flavor_label(value: &ModelEndpointFlavor) -> String {
    match value {
        ModelEndpointFlavor::Chat => "chat".to_string(),
        ModelEndpointFlavor::Responses => "responses".to_string(),
    }
}

fn map_supported_endpoints(raw: Option<Vec<String>>, model_id: &str) -> Vec<ModelEndpointFlavor> {
    let mut endpoints = raw
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| match value.trim().to_ascii_lowercase().as_str() {
            "responses" => Some(ModelEndpointFlavor::Responses),
            "chat" | "chat_completions" | "chat/completions" => Some(ModelEndpointFlavor::Chat),
            _ => None,
        })
        .collect::<Vec<_>>();

    if endpoints.is_empty() {
        endpoints.push(resolve_endpoint_flavor(None, model_id));
    }

    endpoints
}

fn inferred_reasoning_efforts(remote: &CopilotRemoteModelRecord) -> Option<Vec<String>> {
    let supports = remote
        .capabilities
        .as_ref()
        .and_then(|value| value.supports.as_ref());
    if let Some(reasoning_effort) = supports.and_then(|value| value.reasoning_effort.clone()) {
        let filtered = reasoning_effort
            .into_iter()
            .filter(|value| !value.trim().is_empty())
            .collect::<Vec<_>>();
        if !filtered.is_empty() {
            return Some(filtered);
        }
    }

    if supports
        .and_then(|value| value.adaptive_thinking)
        .unwrap_or(false)
    {
        return Some(vec![
            "low".to_string(),
            "medium".to_string(),
            "high".to_string(),
        ]);
    }

    None
}

fn remote_model_to_input(
    remote: &CopilotRemoteModelRecord,
    existing: Option<&AiModel>,
) -> ProviderModelInput {
    let reasoning = inferred_reasoning_efforts(remote);
    let reasoning_capability = resolve_reasoning_capability(
        Some("copilot"),
        Some(&remote.id),
        None,
        reasoning.as_deref(),
        None,
    );

    let supported_endpoints =
        map_supported_endpoints(remote.supported_endpoints.clone(), &remote.id);
    let caps = remote.capabilities.as_ref();
    let supports = caps.and_then(|value| value.supports.as_ref());
    let limits = caps.and_then(|value| value.limits.as_ref());
    let supports_vision = supports.and_then(|value| value.vision).or_else(|| {
        limits
            .and_then(|value| value.vision.as_ref())
            .and_then(|vision| vision.supported_media_types.as_ref())
            .map(|items| items.iter().any(|item| item.starts_with("image/")))
    });
    let remote_capabilities = ModelCapabilities {
        tool_calling: supports.and_then(|value| value.tool_calls).or(Some(true)),
        supports_vision_input: supports_vision,
        supports_structured_outputs: supports.and_then(|value| value.structured_outputs),
        supports_reasoning_effort: Some(!reasoning_capability.reasoning_efforts.is_empty()),
        supports_reasoning_summary: Some(!reasoning_capability.reasoning_efforts.is_empty()),
        supports_response_storage: supported_endpoints
            .contains(&ModelEndpointFlavor::Responses)
            .then_some(false),
        include_encrypted_reasoning: Some(
            supported_endpoints.contains(&ModelEndpointFlavor::Responses)
                && !reasoning_capability.reasoning_efforts.is_empty(),
        ),
        supported_endpoints: Some(supported_endpoints.clone()),
        endpoint_flavor: supported_endpoints.first().cloned(),
        family: caps.and_then(|value| value.family.clone()),
        release_date: remote.version.as_ref().and_then(|version| {
            version
                .strip_prefix(&format!("{}-", remote.id))
                .map(str::to_string)
                .or_else(|| Some(version.to_string()))
        }),
        max_output_tokens: limits.and_then(|value| value.max_output_tokens),
    };

    copilot_policy::merge_remote_model(
        &CopilotRemoteModel {
            model_id: remote.id.clone(),
            name: remote.name.clone().unwrap_or_else(|| remote.id.clone()),
            description: existing.and_then(|value| value.description.clone()),
            owned_by: existing
                .and_then(|value| value.owned_by.clone())
                .or_else(|| Some("github-copilot".to_string())),
            supported_endpoints: Some(supported_endpoints),
            supported_reasoning_efforts: if reasoning_capability.reasoning_efforts.is_empty() {
                None
            } else {
                Some(reasoning_capability.reasoning_efforts.clone())
            },
            context_window_tokens: limits.and_then(|value| value.max_context_window_tokens),
            max_output_tokens: limits.and_then(|value| value.max_output_tokens),
            supports_vision_input: supports_vision,
            capabilities: Some(remote_capabilities),
        },
        existing,
        if reasoning_capability.reasoning_efforts.is_empty() {
            None
        } else {
            Some(reasoning_capability.reasoning_efforts)
        },
        reasoning_capability.default_reasoning_effort,
    )
}

fn visible_remote_models<'a>(
    remote_models: &'a [CopilotRemoteModelRecord],
) -> Vec<&'a CopilotRemoteModelRecord> {
    remote_models
        .iter()
        .filter(|model| model.model_picker_enabled.unwrap_or(true))
        .collect::<Vec<_>>()
}

fn build_model_diagnostic_item(remote: &CopilotRemoteModelRecord) -> CopilotModelDiagnosticItem {
    let supported_endpoints =
        map_supported_endpoints(remote.supported_endpoints.clone(), &remote.id);
    let reasoning = inferred_reasoning_efforts(remote);
    CopilotModelDiagnosticItem {
        id: remote.id.clone(),
        name: remote.name.clone().unwrap_or_else(|| remote.id.clone()),
        model_picker_enabled: remote.model_picker_enabled.unwrap_or(true),
        supported_endpoints: supported_endpoints
            .iter()
            .map(endpoint_flavor_label)
            .collect::<Vec<_>>(),
        endpoint_flavor: supported_endpoints
            .first()
            .map(endpoint_flavor_label)
            .unwrap_or_else(|| "chat".to_string()),
        supports_tool_calling: remote
            .capabilities
            .as_ref()
            .and_then(|value| value.supports.as_ref())
            .and_then(|value| value.tool_calls),
        supports_reasoning_effort: Some(
            !reasoning
                .unwrap_or_default()
                .into_iter()
                .filter(|entry| !entry.trim().is_empty())
                .collect::<Vec<_>>()
                .is_empty(),
        ),
    }
}

async fn persist_auth_state(
    pool: &SqlitePool,
    provider_id: &str,
    secret: Option<&CopilotSecret>,
    auth_status: &str,
    fallback_account_label: Option<String>,
) -> Result<(), String> {
    let metadata = build_provider_metadata(secret, auth_status, fallback_account_label);
    repository::update_provider_auth_metadata(pool, provider_id, &metadata)
        .await
        .map_err(|error| error.to_string())
}

async fn invalidate_session(
    pool: &SqlitePool,
    ai_state: &AiState,
    provider_id: &str,
    secret: Option<&CopilotSecret>,
    auth_status: &str,
    fallback_account_label: Option<String>,
) -> Result<(), String> {
    if let Some(secret) = secret {
        warn!(
            provider_id = %provider_id,
            auth_source = %auth_source_label(secret),
            "invalidating Copilot session"
        );
    }
    secrets::delete_copilot_secret(provider_id).map_err(|error| error.to_string())?;
    clear_cached_copilot_secret(ai_state, provider_id).await;
    persist_auth_state(pool, provider_id, None, auth_status, fallback_account_label).await
}

async fn fetch_profile(
    client: &reqwest::Client,
    secret: &CopilotSecret,
) -> Result<GitHubProfile, String> {
    client
        .get(COPILOT_GITHUB_PROFILE_URL)
        .header(USER_AGENT, copilot_user_agent())
        .header(AUTHORIZATION, format!("Bearer {}", secret.access_token))
        .send()
        .await
        .map_err(|error| format!("Failed to fetch GitHub profile: {}", error))?
        .error_for_status()
        .map_err(|error| format!("Failed to fetch GitHub profile: {}", error))?
        .json::<GitHubProfile>()
        .await
        .map_err(|error| format!("Failed to parse GitHub profile: {}", error))
}

fn derive_account_label(
    profile: Option<&GitHubProfile>,
    secret: Option<&CopilotSecret>,
) -> Option<String> {
    profile
        .and_then(|value| {
            value
                .email
                .clone()
                .or_else(|| value.name.clone())
                .or_else(|| value.login.clone())
        })
        .or_else(|| secret.and_then(|value| value.account_label.clone()))
        .filter(|value| !value.trim().is_empty())
}

async fn refresh_secret(secret: &CopilotSecret) -> Result<CopilotSecret, String> {
    let oauth = load_copilot_oauth_config()?;
    let refresh_token = secret
        .refresh_token
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "GitHub Copilot session can no longer be refreshed automatically. Reconnect GitHub Copilot.".to_string()
        })?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .post(&oauth.access_token_url)
        .header(USER_AGENT, copilot_user_agent())
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .json(&json!({
            "client_id": oauth.client_id,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        }))
        .send()
        .await
        .map_err(|error| format!("Failed to refresh GitHub Copilot token: {}", error))?;

    let payload: AccessTokenResponse = response
        .json()
        .await
        .map_err(|error| format!("Failed to parse GitHub Copilot refresh response: {}", error))?;

    let access_token = payload
        .access_token
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            payload
                .error_description
                .or(payload.error)
                .unwrap_or_else(|| "GitHub Copilot token refresh failed.".to_string())
        })?;

    Ok(CopilotSecret {
        access_token,
        refresh_token: payload
            .refresh_token
            .filter(|value| !value.trim().is_empty())
            .or_else(|| secret.refresh_token.clone()),
        access_token_expires_at: compute_expiry(payload.expires_in),
        refresh_token_expires_at: compute_expiry(payload.refresh_token_expires_in),
        account_label: secret.account_label.clone(),
        auth_source: secret.auth_source.clone(),
        client_kind: Some(COPILOT_AUTH_SOURCE.to_string()),
        enterprise_url: secret.enterprise_url.clone(),
    })
}

async fn refresh_session_secret(
    pool: &SqlitePool,
    ai_state: &AiState,
    provider_id: &str,
    secret: &CopilotSecret,
) -> Result<CopilotSecret, String> {
    match refresh_secret(secret).await {
        Ok(refreshed) => {
            let persisted = persist_copilot_secret(ai_state, provider_id, &refreshed).await?;
            persist_auth_state(
                pool,
                provider_id,
                Some(&persisted),
                "connected",
                persisted.account_label.clone(),
            )
            .await?;
            Ok(persisted)
        }
        Err(error) => {
            let _ = invalidate_session(
                pool,
                ai_state,
                provider_id,
                Some(secret),
                "login_required",
                secret.account_label.clone(),
            )
            .await;
            Err(error)
        }
    }
}

async fn ensure_session(
    pool: &SqlitePool,
    ai_state: &AiState,
    provider_id: &str,
    refresh_if_needed: bool,
) -> Result<CopilotSecret, String> {
    let secret = get_effective_copilot_secret(ai_state, provider_id)
        .await?
        .ok_or_else(|| {
            "GitHub Copilot is not connected. Use Connect GitHub Copilot first.".to_string()
        })?;

    if !is_supported_oauth_session(&secret) {
        return Err(
            "Reconnect GitHub Copilot to migrate Macro to the current OAuth sign-in flow."
                .to_string(),
        );
    }

    if !refresh_if_needed || !is_expiring_soon(&secret) {
        return Ok(secret);
    }

    refresh_session_secret(pool, ai_state, provider_id, &secret).await
}

fn build_status(
    runtime_status: &str,
    auth_status: &str,
    account_label: Option<String>,
    status_message: Option<String>,
    error_code: Option<String>,
    error_message: Option<String>,
) -> CopilotStatus {
    CopilotStatus {
        ok: runtime_status == "ready" && auth_status == "connected",
        runtime_source: "native".to_string(),
        runtime_status: runtime_status.to_string(),
        runtime_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        min_cli_version: "native".to_string(),
        auth_status: auth_status.to_string(),
        auth_source: Some(COPILOT_AUTH_SOURCE.to_string()),
        account_label,
        status_message,
        error_code,
        error_message,
    }
}

fn classify_probe_failure(
    status: u16,
    body: &str,
    fallback_account_label: Option<String>,
) -> CopilotStatus {
    let message = extract_error_message(body);
    match status {
        401 => build_status(
            "ready",
            "login_required",
            fallback_account_label,
            Some("Reconnect GitHub Copilot to continue.".to_string()),
            Some("copilot_auth_required".to_string()),
            Some(message),
        ),
        403 => {
            let lowered = message.to_ascii_lowercase();
            let auth_status = if lowered.contains("policy")
                || lowered.contains("allowlist")
                || lowered.contains("not allowed")
            {
                "policy_blocked"
            } else {
                "quota_or_auth_error"
            };
            build_status(
                "ready",
                auth_status,
                fallback_account_label,
                Some(message.clone()),
                Some("copilot_access_denied".to_string()),
                Some(message),
            )
        }
        429 => build_status(
            "ready",
            "quota_or_auth_error",
            fallback_account_label,
            Some(message.clone()),
            Some("copilot_rate_limited".to_string()),
            Some(message),
        ),
        _ => build_status(
            "error",
            "error",
            fallback_account_label,
            Some(message.clone()),
            Some("copilot_unavailable".to_string()),
            Some(message),
        ),
    }
}

fn extract_error_message(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    value
                        .get("message")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .or_else(|| {
                    value
                        .get("error")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
        })
        .unwrap_or_else(|| {
            let trimmed = body.trim();
            if trimmed.is_empty() {
                "GitHub Copilot request failed.".to_string()
            } else {
                trimmed.to_string()
            }
        })
}

fn request_has_vision_input(messages: &[AiChatMessage]) -> bool {
    messages.iter().any(|message| match &message.content {
        AiChatMessageContent::Text(_) => false,
        AiChatMessageContent::Parts(parts) => parts.iter().any(|part| part.kind == "image_url"),
    })
}

fn compute_x_initiator(messages: &[AiChatMessage]) -> &'static str {
    messages
        .iter()
        .rev()
        .find(|message| message.role != "system")
        .map(|message| {
            if message.role == "user" {
                "user"
            } else {
                "agent"
            }
        })
        .unwrap_or("user")
}

fn apply_copilot_headers(
    request: reqwest::RequestBuilder,
    access_token: &str,
    x_initiator: &str,
    vision: bool,
) -> reqwest::RequestBuilder {
    let mut request = request
        .header(USER_AGENT, copilot_user_agent())
        .header(AUTHORIZATION, format!("Bearer {}", access_token))
        .header("Openai-Intent", COPILOT_OPENAI_INTENT)
        .header("x-initiator", x_initiator);

    if vision {
        request = request.header("Copilot-Vision-Request", "true");
    }

    request
}

fn apply_copilot_model_headers(
    request: reqwest::RequestBuilder,
    access_token: &str,
    user_agent: &str,
    profile: CopilotDiscoveryProfile,
) -> reqwest::RequestBuilder {
    let request = request
        .header(USER_AGENT, user_agent)
        .header(AUTHORIZATION, format!("Bearer {}", access_token))
        .header(ACCEPT, "application/json");

    match profile {
        CopilotDiscoveryProfile::MacroNative => request,
        CopilotDiscoveryProfile::MacroIdeCompat
        | CopilotDiscoveryProfile::MacroIdeCompatIndividual => request
            .header("Copilot-Integration-Id", COPILOT_DISCOVERY_INTEGRATION_ID)
            .header("Editor-Version", COPILOT_DISCOVERY_EDITOR_VERSION),
    }
}

async fn request_device_code() -> Result<DeviceCodeResponse, String> {
    let oauth = load_copilot_oauth_config()?;
    reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| error.to_string())?
        .post(&oauth.device_code_url)
        .header(USER_AGENT, copilot_user_agent())
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .json(&json!({
            "client_id": oauth.client_id,
            "scope": "read:user",
        }))
        .send()
        .await
        .map_err(|error| format!("Failed to start GitHub Copilot login: {}", error))?
        .error_for_status()
        .map_err(|error| format!("Failed to start GitHub Copilot login: {}", error))?
        .json::<DeviceCodeResponse>()
        .await
        .map_err(|error| {
            format!(
                "Failed to parse GitHub Copilot device code response: {}",
                error
            )
        })
}

async fn poll_device_flow(
    device: &DeviceCodeResponse,
    mut cancel_rx: watch::Receiver<bool>,
) -> Result<CopilotSecret, String> {
    let oauth = load_copilot_oauth_config()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| error.to_string())?;
    let started_at = std::time::Instant::now();
    let mut interval_seconds = device.interval.unwrap_or(5).max(1);

    loop {
        if *cancel_rx.borrow() {
            return Err("GitHub Copilot login was cancelled.".to_string());
        }
        if started_at.elapsed().as_secs() >= device.expires_in {
            return Err("GitHub Copilot device code expired. Try again.".to_string());
        }

        let response = client
            .post(&oauth.access_token_url)
            .header(USER_AGENT, copilot_user_agent())
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/json")
            .json(&json!({
                "client_id": oauth.client_id,
                "device_code": device.device_code,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            }))
            .send()
            .await
            .map_err(|error| format!("Failed to complete GitHub Copilot login: {}", error))?;

        let payload: AccessTokenResponse = response
            .json()
            .await
            .map_err(|error| format!("Failed to parse GitHub Copilot login response: {}", error))?;

        if let Some(access_token) = payload
            .access_token
            .filter(|value| !value.trim().is_empty())
        {
            return Ok(CopilotSecret {
                access_token,
                refresh_token: payload
                    .refresh_token
                    .filter(|value| !value.trim().is_empty()),
                access_token_expires_at: compute_expiry(payload.expires_in),
                refresh_token_expires_at: compute_expiry(payload.refresh_token_expires_in),
                account_label: None,
                auth_source: COPILOT_AUTH_SOURCE.to_string(),
                client_kind: Some(COPILOT_AUTH_SOURCE.to_string()),
                enterprise_url: None,
            });
        }

        match payload.error.as_deref() {
            Some("authorization_pending") => {}
            Some("slow_down") => {
                interval_seconds += 5;
            }
            Some("expired_token") => {
                return Err("GitHub Copilot device code expired. Try again.".to_string());
            }
            Some("access_denied") => {
                return Err("GitHub Copilot login was cancelled in your browser.".to_string());
            }
            Some(error) => {
                return Err(payload
                    .error_description
                    .unwrap_or_else(|| format!("GitHub Copilot login failed: {}", error)));
            }
            None => {
                return Err("GitHub Copilot login failed: missing access token.".to_string());
            }
        }

        tokio::select! {
            _ = sleep(Duration::from_secs(interval_seconds) + Duration::from_millis(OAUTH_POLLING_SAFETY_MARGIN_MS)) => {}
            _ = cancel_rx.changed() => {
                if *cancel_rx.borrow() {
                    return Err("GitHub Copilot login was cancelled.".to_string());
                }
            }
        }
    }
}

pub async fn disconnect_auth(
    pool: &SqlitePool,
    ai_state: &AiState,
    provider_id: &str,
) -> Result<ProviderConfig, String> {
    secrets::delete_copilot_secret(provider_id).map_err(|error| error.to_string())?;
    clear_cached_copilot_secret(ai_state, provider_id).await;
    persist_auth_state(pool, provider_id, None, "login_required", None).await?;
    repository::get_provider_config(pool, provider_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Provider {provider_id} not found."))
}

pub async fn get_status(
    _app_handle: &AppHandle,
    pool: &SqlitePool,
    ai_state: &AiState,
    provider_id: &str,
) -> Result<CopilotStatus, String> {
    let provider = repository::get_provider_config(pool, provider_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Provider {provider_id} not found."))?;
    let fallback_account_label = provider.account_label.clone();
    let oauth_config_error = load_copilot_oauth_config().err();

    if let Some(message) = oauth_config_error.clone() {
        if let Ok(Some(secret)) = get_effective_copilot_secret(ai_state, provider_id).await {
            let _ = invalidate_session(
                pool,
                ai_state,
                provider_id,
                Some(&secret),
                "login_required",
                fallback_account_label.clone(),
            )
            .await;
        } else {
            let _ = persist_auth_state(pool, provider_id, None, "login_required", None).await;
        }

        return Ok(build_status(
            "ready",
            "login_required",
            fallback_account_label,
            Some(message.clone()),
            Some("copilot_oauth_app_required".to_string()),
            Some(message),
        ));
    }

    let Some(secret) = get_effective_copilot_secret(ai_state, provider_id).await? else {
        let status = build_status(
            "ready",
            "login_required",
            fallback_account_label,
            Some("Connect GitHub Copilot with Macro's OAuth App to finish setup.".to_string()),
            None,
            None,
        );
        persist_auth_state(pool, provider_id, None, "login_required", None).await?;
        return Ok(status);
    };

    if !is_supported_oauth_session(&secret) {
        let _ = invalidate_session(
            pool,
            ai_state,
            provider_id,
            Some(&secret),
            "login_required",
            fallback_account_label.clone(),
        )
        .await;
        return Ok(build_status(
            "ready",
            "login_required",
            fallback_account_label,
            Some(
                "Reconnect GitHub Copilot to finish migrating Macro to the OAuth App sign-in flow."
                    .to_string(),
            ),
            Some("copilot_reauth_required".to_string()),
            None,
        ));
    }

    let session = match if is_expiring_soon(&secret) {
        refresh_session_secret(pool, ai_state, provider_id, &secret).await
    } else {
        Ok(secret.clone())
    } {
        Ok(secret) => {
            let _ = persist_copilot_secret(ai_state, provider_id, &secret).await;
            let _ = persist_auth_state(
                pool,
                provider_id,
                Some(&secret),
                "connected",
                secret.account_label.clone(),
            )
            .await;
            CopilotSession { provider, secret }
        }
        Err(message) => {
            let status = build_status(
                "ready",
                "login_required",
                fallback_account_label,
                Some(message.clone()),
                Some("copilot_session_expired".to_string()),
                Some(message),
            );
            let _ = invalidate_session(
                pool,
                ai_state,
                provider_id,
                Some(&secret),
                "login_required",
                None,
            )
            .await;
            return Ok(status);
        }
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| error.to_string())?;
    let models_url = format!(
        "{}{}",
        resolve_base_url(&session.provider),
        COPILOT_MODELS_PATH
    );
    let mut active_secret = session.secret.clone();
    let probe = {
        let mut response = apply_copilot_model_headers(
            client.get(models_url.clone()),
            &active_secret.access_token,
            &copilot_user_agent(),
            CopilotDiscoveryProfile::MacroNative,
        )
        .send()
        .await;
        if matches!(
            response.as_ref().ok().map(|item| item.status()),
            Some(StatusCode::UNAUTHORIZED)
        ) {
            match refresh_session_secret(pool, ai_state, provider_id, &active_secret).await {
                Ok(refreshed) => {
                    active_secret = refreshed;
                    response = apply_copilot_model_headers(
                        client.get(models_url),
                        &active_secret.access_token,
                        &copilot_user_agent(),
                        CopilotDiscoveryProfile::MacroNative,
                    )
                    .send()
                    .await;
                }
                Err(message) => {
                    let status = build_status(
                        "ready",
                        "login_required",
                        fallback_account_label.clone(),
                        Some(message.clone()),
                        Some("copilot_session_expired".to_string()),
                        Some(message),
                    );
                    let _ = invalidate_session(
                        pool,
                        ai_state,
                        provider_id,
                        Some(&active_secret),
                        "login_required",
                        fallback_account_label.clone(),
                    )
                    .await;
                    return Ok(status);
                }
            }
        }
        response
    };

    match probe {
        Ok(response) if response.status().is_success() => {
            let oauth = load_copilot_oauth_config()?;
            let client_kind = infer_client_id_kind(&oauth.client_id);
            let profile = fetch_profile(&client, &active_secret).await.ok();
            let account_label = derive_account_label(profile.as_ref(), Some(&active_secret));
            let persisted_secret = CopilotSecret {
                account_label: account_label.clone(),
                ..active_secret.clone()
            };
            let _ = secrets::set_copilot_secret(provider_id, &persisted_secret);
            let status = build_status(
                "ready",
                "connected",
                account_label.clone(),
                Some(if client_kind == "github_app" {
                    "GitHub Copilot connected. Macro is currently using a GitHub App client; if model visibility differs from OpenCode, migrate to a GitHub OAuth App client ID and reconnect.".to_string()
                } else {
                    "GitHub Copilot connected.".to_string()
                }),
                None,
                None,
            );
            persist_auth_state(
                pool,
                provider_id,
                Some(&persisted_secret),
                "connected",
                account_label,
            )
            .await?;
            Ok(status)
        }
        Ok(response) => {
            let status_code = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            let status =
                classify_probe_failure(status_code, &body, session.secret.account_label.clone());
            let _ = persist_auth_state(
                pool,
                provider_id,
                Some(&active_secret),
                &status.auth_status,
                status.account_label.clone(),
            )
            .await;
            Ok(status)
        }
        Err(error) => {
            let message = format!("Failed to reach GitHub Copilot: {}", error);
            let status = build_status(
                "error",
                "error",
                session.secret.account_label.clone(),
                Some(message.clone()),
                Some("copilot_network_error".to_string()),
                Some(message),
            );
            let _ = persist_auth_state(
                pool,
                provider_id,
                Some(&active_secret),
                "error",
                status.account_label.clone(),
            )
            .await;
            Ok(status)
        }
    }
}

pub async fn start_auth(
    app_handle: AppHandle,
    pool: SqlitePool,
    ai_state: AiState,
    request_id: String,
    provider_id: String,
) -> Result<(), String> {
    {
        let mut tasks = ai_state.auth_tasks.lock().await;
        let stale_ids = tasks
            .iter()
            .filter_map(|(id, task)| (task.provider_id == provider_id).then_some(id.clone()))
            .collect::<Vec<_>>();
        for stale_id in stale_ids {
            if let Some(task) = tasks.remove(&stale_id) {
                let _ = task.cancel_sender.send(true);
                task.handle.abort();
            }
        }
    }

    let app_for_task = app_handle.clone();
    let pool_for_task = pool.clone();
    let ai_state_for_task = ai_state.clone();
    let provider_for_task = provider_id.clone();
    let request_for_task = request_id.clone();
    let (cancel_tx, cancel_rx) = watch::channel(false);

    let handle = tokio::spawn(async move {
        let result = async {
            let oauth = load_copilot_oauth_config()?;
            let device = request_device_code().await?;
            app_for_task
                .emit(
                    "ai:copilot-auth-progress",
                    CopilotAuthProgressEvent {
                        request_id: request_for_task.clone(),
                        provider_id: provider_for_task.clone(),
                        phase: "waiting_for_browser".to_string(),
                        message: format!(
                            "Open GitHub and authorize {} with the device code {}.",
                            oauth.display_name, device.user_code
                        ),
                        verification_url: Some(device.verification_uri.clone()),
                        user_code: Some(device.user_code.clone()),
                    },
                )
                .map_err(|error| error.to_string())?;
            app_for_task
                .opener()
                .open_url(device.verification_uri.as_str(), None::<&str>)
                .map_err(|error| format!("Failed to open your browser: {}", error))?;

            let mut secret = poll_device_flow(&device, cancel_rx).await?;
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECONDS))
                .build()
                .map_err(|error| error.to_string())?;
            let profile = fetch_profile(&client, &secret).await.ok();
            secret.account_label = derive_account_label(profile.as_ref(), Some(&secret));
            let persisted_secret =
                persist_copilot_secret(&ai_state_for_task, &provider_for_task, &secret).await?;
            let status = get_status(
                &app_for_task,
                &pool_for_task,
                &ai_state_for_task,
                &provider_for_task,
            )
            .await?;
            if status.auth_status != "connected" || status.runtime_status != "ready" {
                let _ = invalidate_session(
                    &pool_for_task,
                    &ai_state_for_task,
                    &provider_for_task,
                    Some(&persisted_secret),
                    "login_required",
                    persisted_secret.account_label.clone(),
                )
                .await;
                return Err(
                    status
                        .error_message
                        .or(status.status_message)
                        .unwrap_or_else(|| {
                            "GitHub Copilot authorization finished, but Macro could not validate the session."
                                .to_string()
                        }),
                );
            }
            ai_state_for_task
                .copilot_model_failures
                .lock()
                .await
                .remove(&provider_for_task);
            app_for_task
                .emit(
                    "ai:copilot-auth-complete",
                    CopilotAuthCompleteEvent {
                        request_id: request_for_task.clone(),
                        provider_id: provider_for_task.clone(),
                    },
                )
                .map_err(|error| error.to_string())?;
            Ok::<(), String>(())
        }
        .await;

        if let Err(message) = result {
            let _ = app_for_task.emit(
                "ai:copilot-auth-error",
                CopilotAuthErrorEvent {
                    request_id: request_for_task.clone(),
                    provider_id: provider_for_task.clone(),
                    code: "copilot_auth_failed".to_string(),
                    message,
                },
            );
        }

        let mut tasks = ai_state_for_task.auth_tasks.lock().await;
        tasks.remove(&request_for_task);
    });

    let mut tasks = ai_state.auth_tasks.lock().await;
    tasks.insert(
        request_id,
        AuthTask {
            provider_id,
            handle,
            cancel_sender: cancel_tx,
        },
    );
    Ok(())
}

pub async fn cancel_auth(
    app_handle: &AppHandle,
    ai_state: &AiState,
    request_id: &str,
) -> Result<(), String> {
    let mut tasks = ai_state.auth_tasks.lock().await;
    if let Some(task) = tasks.remove(request_id) {
        let _ = task.cancel_sender.send(true);
        task.handle.abort();
        app_handle
            .emit(
                "ai:copilot-auth-cancelled",
                CopilotAuthCancelledEvent {
                    request_id: request_id.to_string(),
                    provider_id: task.provider_id,
                },
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

async fn execute_request_with_refresh<F>(
    pool: &SqlitePool,
    ai_state: &AiState,
    provider_id: &str,
    secret: &CopilotSecret,
    mut build: F,
) -> Result<(reqwest::Response, CopilotSecret), String>
where
    F: FnMut(&CopilotSecret) -> reqwest::RequestBuilder,
{
    let mut active_secret = secret.clone();

    for attempt in 0..=1 {
        let response = build(&active_secret)
            .send()
            .await
            .map_err(|error| format!("GitHub Copilot request failed: {}", error))?;

        if response.status() != StatusCode::UNAUTHORIZED || attempt > 0 {
            return Ok((response, active_secret));
        }

        active_secret = refresh_session_secret(pool, ai_state, provider_id, &active_secret).await?;
    }

    Err("GitHub Copilot request retry exhausted.".to_string())
}

async fn fetch_models_remote(
    pool: &SqlitePool,
    ai_state: &AiState,
    provider_id: &str,
    provider: &ProviderConfig,
    secret: &CopilotSecret,
) -> Result<(FetchModelsResult, Vec<CopilotDiscoveryAttemptSummary>), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| error.to_string())?;
    let provider_base_url = resolve_base_url(provider);
    let mut best_result: Option<FetchModelsResult> = None;
    let mut attempts = Vec::new();

    for profile in discovery_profiles_for_base_url(&provider_base_url) {
        let base_url = profile.base_url(&provider_base_url);
        let user_agent = profile.user_agent();
        let url = format!("{}{}", base_url, COPILOT_MODELS_PATH);

        match execute_request_with_refresh(pool, ai_state, provider_id, secret, |active_secret| {
            apply_copilot_model_headers(
                client.get(url.clone()),
                &active_secret.access_token,
                &user_agent,
                profile,
            )
        })
        .await
        {
            Ok((response, _)) => match parse_models_response(
                response,
                profile,
                user_agent.clone(),
                base_url.clone(),
            )
            .await
            {
                Ok(result) => {
                    attempts.push(build_discovery_attempt_summary(
                        profile,
                        base_url,
                        user_agent,
                        result.status_code,
                        Some(&result.models),
                        None,
                    ));

                    let replace_best = best_result
                        .as_ref()
                        .map(|current| is_better_discovery_candidate(&current.models, &result.models))
                        .unwrap_or(true);
                    if replace_best {
                        best_result = Some(result);
                    }
                }
                Err(error) => {
                    let status_code = error
                        .rsplit_once('(')
                        .and_then(|(_, suffix)| suffix.trim_end_matches(')').parse::<u16>().ok());
                    attempts.push(build_discovery_attempt_summary(
                        profile,
                        base_url,
                        user_agent,
                        status_code,
                        None,
                        Some(error),
                    ));
                }
            },
            Err(error) => {
                attempts.push(build_discovery_attempt_summary(
                    profile,
                    base_url,
                    user_agent,
                    None,
                    None,
                    Some(error),
                ));
            }
        }
    }

    let best = best_result.ok_or_else(|| {
        attempts
            .iter()
            .find_map(|attempt| attempt.error_message.clone())
            .unwrap_or_else(|| "GitHub Copilot model discovery failed.".to_string())
    })?;

    info!(
        provider_id = %provider_id,
        selected_profile = %best.profile.as_str(),
        attempts = ?attempts.iter().map(|attempt| format!("{}:{} models={} visible={}", attempt.profile, attempt.status_code.unwrap_or_default(), attempt.total_remote_models, attempt.visible_model_ids.len())).collect::<Vec<_>>(),
        "selected Copilot discovery profile"
    );

    Ok((best, attempts))
}

async fn parse_models_response(
    response: reqwest::Response,
    profile: CopilotDiscoveryProfile,
    user_agent: String,
    base_url: String,
) -> Result<FetchModelsResult, String> {
    let status_code = Some(response.status().as_u16());
    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "{} ({})",
            extract_error_message(&body),
            status_code.unwrap_or_default()
        ));
    }

    let payload = response
        .json::<Value>()
        .await
        .map_err(|error| format!("Failed to parse GitHub Copilot models payload: {}", error))?;
    let envelope = serde_json::from_value::<CopilotModelsEnvelope>(payload.clone())
        .map_err(|error| format!("Failed to parse GitHub Copilot models: {}", error))?;

    Ok(FetchModelsResult {
        profile,
        models: envelope.data,
        payload,
        user_agent,
        base_url,
        status_code,
    })
}

pub async fn sync_models(
    _app_handle: &AppHandle,
    pool: &SqlitePool,
    ai_state: &AiState,
    provider_id: &str,
) -> Result<Vec<AiModel>, String> {
    let provider = repository::get_provider_config(pool, provider_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Provider {provider_id} not found."))?;
    let oauth = load_copilot_oauth_config()?;
    let secret = ensure_session(pool, ai_state, provider_id, true).await?;
    let (remote, attempts) =
        fetch_models_remote(pool, ai_state, provider_id, &provider, &secret).await?;
    let remote_models = remote.models;
    let existing_models = repository::list_models_by_provider(pool, provider_id)
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|model| (model.model_id.clone(), model))
        .collect::<HashMap<_, _>>();

    let models = remote_models
        .iter()
        .map(|model| remote_model_to_input(model, existing_models.get(&model.id)))
        .collect::<Vec<_>>();

    info!(
        provider_id = %provider_id,
        configured_client_kind = infer_client_id_kind(&oauth.client_id),
        selected_profile = %remote.profile.as_str(),
        user_agent = %remote.user_agent,
        base_url = %remote.base_url,
        models_status_code = remote.status_code,
        total_remote_models = remote_models.len(),
        synced_model_ids = ?models.iter().map(|model| model.model_id.clone()).collect::<Vec<_>>(),
        visible_model_ids = ?visible_remote_models(&remote_models)
            .iter()
            .map(|model| model.id.clone())
            .collect::<Vec<_>>(),
        remote_models = ?remote_models
            .iter()
            .map(|model| format!(
                "{} picker={} endpoints={:?}",
                model.id,
                model.model_picker_enabled.unwrap_or(true),
                model.supported_endpoints.clone().unwrap_or_default()
            ))
            .collect::<Vec<_>>(),
        discovery_attempts = ?attempts.iter().map(|attempt| format!("{}:{} models={} visible={}", attempt.profile, attempt.status_code.unwrap_or_default(), attempt.total_remote_models, attempt.visible_model_ids.len())).collect::<Vec<_>>(),
        "synced Copilot models from native provider"
    );

    repository::upsert_provider_models(pool, provider_id, &models)
        .await
        .map_err(|error| error.to_string())?;
    let keep_model_ids = models
        .iter()
        .map(|model| model.model_id.clone())
        .collect::<Vec<_>>();
    repository::prune_provider_models(pool, provider_id, &keep_model_ids)
        .await
        .map_err(|error| error.to_string())?;
    repository::list_models_by_provider(pool, provider_id)
        .await
        .map_err(|error| error.to_string())
}

pub async fn get_model_diagnostics(
    pool: &SqlitePool,
    ai_state: &AiState,
    provider_id: &str,
) -> Result<CopilotModelDiagnostics, String> {
    let provider = repository::get_provider_config(pool, provider_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Provider {provider_id} not found."))?;
    let oauth = load_copilot_oauth_config()?;
    let secret = ensure_session(pool, ai_state, provider_id, true).await?;
    let (remote, attempts) =
        fetch_models_remote(pool, ai_state, provider_id, &provider, &secret).await?;
    let remote_models = remote.models;
    let visible_models = visible_remote_models(&remote_models);
    let visible_model_ids = visible_models
        .iter()
        .map(|model| model.id.clone())
        .collect::<Vec<_>>();
    let displayed_model_ids = repository::list_models_by_provider(pool, provider_id)
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|model| model.model_id)
        .collect::<Vec<_>>();
    let last_failure = ai_state
        .copilot_model_failures
        .lock()
        .await
        .get(provider_id)
        .cloned()
        .map(|failure| CopilotModelFailureDiagnostic {
            model_id: failure.model_id,
            endpoint_flavor: failure.endpoint_flavor,
            status_code: failure.status_code,
            code: failure.code,
            message: failure.message,
        });

    Ok(CopilotModelDiagnostics {
        auth_source: auth_source_label(&secret),
        configured_client_kind: infer_client_id_kind(&oauth.client_id).to_string(),
        selected_profile: remote.profile.as_str().to_string(),
        user_agent: remote.user_agent,
        base_url: remote.base_url,
        models_status_code: remote.status_code,
        total_remote_models: remote_models.len(),
        visible_model_ids,
        displayed_model_ids,
        raw_models: remote_models
            .iter()
            .map(build_model_diagnostic_item)
            .collect::<Vec<_>>(),
        attempts,
        last_failure,
    })
}

pub async fn get_raw_models_payload(
    pool: &SqlitePool,
    ai_state: &AiState,
    provider_id: &str,
) -> Result<CopilotRawModelsPayload, String> {
    let provider = repository::get_provider_config(pool, provider_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Provider {provider_id} not found."))?;
    let oauth = load_copilot_oauth_config()?;
    let secret = ensure_session(pool, ai_state, provider_id, true).await?;
    let (remote, attempts) =
        fetch_models_remote(pool, ai_state, provider_id, &provider, &secret).await?;

    Ok(CopilotRawModelsPayload {
        auth_source: auth_source_label(&secret),
        configured_client_kind: infer_client_id_kind(&oauth.client_id).to_string(),
        selected_profile: remote.profile.as_str().to_string(),
        user_agent: remote.user_agent,
        base_url: remote.base_url,
        status_code: remote.status_code,
        attempts,
        payload: remote.payload,
    })
}

fn content_to_plain_text(content: &AiChatMessageContent) -> String {
    match content {
        AiChatMessageContent::Text(value) => value.clone(),
        AiChatMessageContent::Parts(parts) => parts
            .iter()
            .filter_map(|part| part.text.clone())
            .collect::<Vec<_>>()
            .join(""),
    }
}

fn build_chat_content(content: &AiChatMessageContent) -> Value {
    match content {
        AiChatMessageContent::Text(value) => Value::String(value.clone()),
        AiChatMessageContent::Parts(parts) => Value::Array(
            parts
                .iter()
                .map(|part| {
                    if part.kind == "image_url" {
                        json!({
                            "type": "image_url",
                            "image_url": {
                                "url": part
                                    .image_url
                                    .as_ref()
                                    .map(|value| value.url.clone())
                                    .unwrap_or_default(),
                            }
                        })
                    } else {
                        json!({
                            "type": "text",
                            "text": part.text.clone().unwrap_or_default(),
                        })
                    }
                })
                .collect::<Vec<_>>(),
        ),
    }
}

fn build_responses_content(content: &AiChatMessageContent, assistant: bool) -> Vec<Value> {
    match content {
        AiChatMessageContent::Text(value) => vec![json!({
            "type": if assistant { "output_text" } else { "input_text" },
            "text": value,
        })],
        AiChatMessageContent::Parts(parts) => parts
            .iter()
            .filter_map(|part| {
                if part.kind == "image_url" {
                    part.image_url.as_ref().map(|image| {
                        json!({
                            "type": if assistant { "input_image" } else { "input_image" },
                            "image_url": image.url.clone(),
                        })
                    })
                } else {
                    Some(json!({
                        "type": if assistant { "output_text" } else { "input_text" },
                        "text": part.text.clone().unwrap_or_default(),
                    }))
                }
            })
            .collect::<Vec<_>>(),
    }
}

fn parse_copilot_turn_state(value: Option<&Value>) -> Option<CopilotProviderTurnState> {
    let value = value?;
    if value.get("provider").and_then(Value::as_str) != Some("copilot") {
        return None;
    }

    let endpoint_flavor = match value.get("endpoint_flavor").and_then(Value::as_str) {
        Some("chat") => ModelEndpointFlavor::Chat,
        Some("responses") => ModelEndpointFlavor::Responses,
        _ => return None,
    };
    let stored_item_refs = value
        .get("stored_item_refs")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Some(CopilotProviderTurnState {
        endpoint_flavor,
        reasoning_opaque: value
            .get("reasoning_opaque")
            .and_then(Value::as_str)
            .map(str::to_string),
        response_id: value
            .get("response_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        stored_item_refs,
        provider_items_digest: value
            .get("provider_items_digest")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn build_chat_message_from_provider_items(message: &AiChatMessage) -> Option<Value> {
    let items = message.provider_input_items.as_ref()?;
    let mut content = String::new();
    let mut reasoning_text = String::new();
    let mut reasoning_opaque: Option<String> = None;
    let mut tool_calls = Vec::new();

    for item in items {
        let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();
        match kind {
            "message" => {
                if item.get("role").and_then(Value::as_str) != Some("assistant") {
                    continue;
                }
                reasoning_opaque = reasoning_opaque.or_else(|| {
                    item.get("reasoning_opaque")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                });
                if let Some(parts) = item.get("content").and_then(Value::as_array) {
                    for part in parts {
                        match part.get("type").and_then(Value::as_str).unwrap_or_default() {
                            "output_text" | "text" => {
                                if let Some(text) = part.get("text").and_then(Value::as_str) {
                                    content.push_str(text);
                                }
                            }
                            "reasoning_text" => {
                                if let Some(text) = part.get("text").and_then(Value::as_str) {
                                    reasoning_text.push_str(text);
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            "reasoning" => {
                reasoning_opaque = reasoning_opaque.or_else(|| {
                    item.get("encrypted_content")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                });
                if let Some(summary) = item.get("summary").and_then(Value::as_array) {
                    for part in summary {
                        if let Some(text) = part.get("text").and_then(Value::as_str) {
                            reasoning_text.push_str(text);
                        }
                    }
                }
            }
            "function_call" => {
                let Some(id) = item.get("call_id").and_then(Value::as_str) else {
                    continue;
                };
                let Some(name) = item.get("name").and_then(Value::as_str) else {
                    continue;
                };
                let arguments = item
                    .get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or("{}");
                tool_calls.push(json!({
                    "id": id,
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": arguments,
                    }
                }));
            }
            _ => {}
        }
    }

    if content.trim().is_empty() && reasoning_text.trim().is_empty() && tool_calls.is_empty() {
        return None;
    }

    Some(json!({
        "role": "assistant",
        "content": if content.trim().is_empty() { Value::Null } else { Value::String(content) },
        "reasoning_text": if reasoning_text.trim().is_empty() { Value::Null } else { Value::String(reasoning_text) },
        "reasoning_opaque": reasoning_opaque,
        "tool_calls": if tool_calls.is_empty() { Value::Null } else { Value::Array(tool_calls) },
    }))
}

fn build_chat_messages(request: &AiChatRequest) -> Result<Vec<Value>, String> {
    let mut messages = Vec::new();

    for message in &request.messages {
        match message.role.as_str() {
            "system" | "user" => {
                messages.push(json!({
                    "role": message.role,
                    "content": build_chat_content(&message.content),
                }));
            }
            "assistant" => {
                if let Some(provider_message) = build_chat_message_from_provider_items(message) {
                    messages.push(provider_message);
                    continue;
                }

                let tool_calls = message
                    .tool_calls
                    .iter()
                    .filter(|tool_call| tool_call.kind == "function")
                    .map(|tool_call| {
                        json!({
                            "id": tool_call.id,
                            "type": "function",
                            "function": {
                                "name": tool_call.function.name,
                                "arguments": tool_call.function.arguments,
                            }
                        })
                    })
                    .collect::<Vec<_>>();
                messages.push(json!({
                    "role": "assistant",
                    "content": content_to_plain_text(&message.content),
                    "tool_calls": if tool_calls.is_empty() { Value::Null } else { Value::Array(tool_calls) },
                }));
            }
            "tool" => {
                let tool_call_id = message
                    .tool_call_id
                    .clone()
                    .ok_or_else(|| "Tool message is missing tool_call_id.".to_string())?;
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": content_to_plain_text(&message.content),
                }));
            }
            _ => {
                messages.push(json!({
                    "role": "user",
                    "content": content_to_plain_text(&message.content),
                }));
            }
        }
    }

    Ok(drop_orphaned_chat_tool_calls(messages))
}

fn drop_orphaned_chat_tool_calls(messages: Vec<Value>) -> Vec<Value> {
    let available_tool_outputs = messages
        .iter()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("tool"))
        .filter_map(|message| message.get("tool_call_id").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<std::collections::HashSet<_>>();

    messages
        .into_iter()
        .filter_map(|mut message| {
            if message.get("role").and_then(Value::as_str) != Some("assistant") {
                return Some(message);
            }

            let Some(tool_calls) = message.get_mut("tool_calls").and_then(Value::as_array_mut)
            else {
                return Some(message);
            };

            tool_calls.retain(|tool_call| {
                tool_call
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|id| available_tool_outputs.contains(id))
                    .unwrap_or(false)
            });

            if tool_calls.is_empty() {
                message
                    .as_object_mut()
                    .map(|object| object.insert("tool_calls".to_string(), Value::Null));
            }

            let has_content = message
                .get("content")
                .and_then(Value::as_str)
                .map(|content| !content.trim().is_empty())
                .unwrap_or(false);
            let has_reasoning = message
                .get("reasoning_text")
                .and_then(Value::as_str)
                .map(|content| !content.trim().is_empty())
                .unwrap_or(false);
            let has_tool_calls = message
                .get("tool_calls")
                .and_then(Value::as_array)
                .map(|items| !items.is_empty())
                .unwrap_or(false);

            if has_content || has_reasoning || has_tool_calls {
                Some(message)
            } else {
                None
            }
        })
        .collect()
}

fn normalize_provider_items_for_responses(items: &[Value]) -> Vec<Value> {
    let mut normalized = Vec::new();

    for item in items {
        match item.get("type").and_then(Value::as_str).unwrap_or_default() {
            "item_reference" => {
                if item.get("id").and_then(Value::as_str).is_some() {
                    normalized.push(item.clone());
                }
            }
            "function_call" => {
                if item.get("call_id").and_then(Value::as_str).is_some()
                    && item.get("name").and_then(Value::as_str).is_some()
                {
                    normalized.push(item.clone());
                }
            }
            "function_call_output" => {
                if item.get("call_id").and_then(Value::as_str).is_some() {
                    normalized.push(item.clone());
                }
            }
            "reasoning" => {
                if item.get("id").and_then(Value::as_str).is_some() {
                    normalized.push(item.clone());
                }
            }
            "message" => {
                if item.get("role").and_then(Value::as_str) != Some("assistant") {
                    continue;
                }
                let content = item
                    .get("content")
                    .and_then(Value::as_array)
                    .map(|parts| {
                        parts
                            .iter()
                            .filter_map(|part| {
                                let kind =
                                    part.get("type").and_then(Value::as_str).unwrap_or_default();
                                match kind {
                                    "output_text" | "text" => {
                                        part.get("text").and_then(Value::as_str).map(|text| {
                                            json!({
                                                "type": "output_text",
                                                "text": text,
                                            })
                                        })
                                    }
                                    _ => None,
                                }
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();

                if !content.is_empty() {
                    normalized.push(json!({
                        "type": "message",
                        "role": "assistant",
                        "content": content,
                    }));
                }
            }
            _ => {}
        }
    }

    normalized
}

fn build_responses_input(
    request: &AiChatRequest,
    allow_stored_item_refs: bool,
) -> Result<(String, Vec<Value>), String> {
    let mut instructions = Vec::new();
    let mut input = Vec::new();

    for message in &request.messages {
        match message.role.as_str() {
            "system" => instructions.push(content_to_plain_text(&message.content)),
            "user" => {
                input.push(json!({
                    "type": "message",
                    "role": "user",
                    "content": build_responses_content(&message.content, false),
                }));
            }
            "assistant" => {
                let turn_state = parse_copilot_turn_state(message.provider_turn_state.as_ref());
                if let Some(turn_state) = turn_state {
                    if turn_state.endpoint_flavor == ModelEndpointFlavor::Responses
                        && allow_stored_item_refs
                        && !turn_state.stored_item_refs.is_empty()
                    {
                        input.extend(
                            turn_state
                                .stored_item_refs
                                .into_iter()
                                .map(|id| json!({ "type": "item_reference", "id": id })),
                        );
                        continue;
                    }
                }

                if let Some(provider_items) = message.provider_input_items.as_ref() {
                    let normalized = normalize_provider_items_for_responses(provider_items);
                    if !normalized.is_empty() {
                        input.extend(normalized);
                        continue;
                    }
                }

                if !content_to_plain_text(&message.content).trim().is_empty() {
                    input.push(json!({
                        "type": "message",
                        "role": "assistant",
                        "content": build_responses_content(&message.content, true),
                    }));
                }
                for tool_call in &message.tool_calls {
                    if tool_call.kind != "function" {
                        continue;
                    }
                    input.push(json!({
                        "type": "function_call",
                        "call_id": tool_call.id,
                        "name": tool_call.function.name,
                        "arguments": tool_call.function.arguments,
                    }));
                }
            }
            "tool" => {
                if let Some(provider_items) = message.provider_input_items.as_ref() {
                    let normalized = normalize_provider_items_for_responses(provider_items);
                    if !normalized.is_empty() {
                        input.extend(normalized);
                        continue;
                    }
                }
                let tool_call_id = message
                    .tool_call_id
                    .clone()
                    .ok_or_else(|| "Tool message is missing tool_call_id.".to_string())?;
                input.push(json!({
                    "type": "function_call_output",
                    "call_id": tool_call_id,
                    "output": content_to_plain_text(&message.content),
                }));
            }
            _ => {}
        }
    }

    if input.is_empty() {
        return Err("No chat messages were provided.".to_string());
    }

    Ok((instructions.join("\n\n").trim().to_string(), input))
}

fn build_chat_request_body(
    request: &AiChatRequest,
    model: Option<&AiModel>,
) -> Result<Value, String> {
    let messages = build_chat_messages(request)?;
    let reasoning_supported = supports_reasoning(model, &request.model_id);
    let reasoning_effort = if reasoning_supported {
        request
            .reasoning_effort
            .clone()
            .or_else(|| model.and_then(|value| value.default_reasoning_effort.clone()))
    } else {
        None
    };

    let mut payload = serde_json::Map::new();
    payload.insert("model".to_string(), Value::String(request.model_id.clone()));
    payload.insert("stream".to_string(), Value::Bool(true));
    payload.insert("messages".to_string(), Value::Array(messages));
    payload.insert("tools".to_string(), Value::Array(request.tools.clone()));
    payload.insert(
        "tool_choice".to_string(),
        Value::String(
            request
                .tool_choice
                .clone()
                .unwrap_or_else(|| "auto".to_string()),
        ),
    );
    payload.insert(
        "parallel_tool_calls".to_string(),
        Value::Bool(request.parallel_tool_calls.unwrap_or(false)),
    );
    if let Some(reasoning_effort) = reasoning_effort.filter(|value| !value.trim().is_empty()) {
        payload.insert(
            "reasoning_effort".to_string(),
            Value::String(reasoning_effort),
        );
    }

    Ok(Value::Object(payload))
}

fn build_responses_request_body(
    request: &AiChatRequest,
    model: Option<&AiModel>,
) -> Result<Value, String> {
    let allow_stored_item_refs = supports_response_storage(model);
    let (instructions, input) = build_responses_input(request, allow_stored_item_refs)?;
    let reasoning_supported = supports_reasoning(model, &request.model_id);
    let include_encrypted_reasoning = supports_encrypted_reasoning(model, reasoning_supported);
    let reasoning = if reasoning_supported {
        Some(json!({
            "effort": request
                .reasoning_effort
                .clone()
                .or_else(|| model.and_then(|value| value.default_reasoning_effort.clone()))
                .unwrap_or_else(|| "medium".to_string()),
            "summary": "auto",
        }))
    } else {
        None
    };

    let mut payload = serde_json::Map::new();
    payload.insert("model".to_string(), Value::String(request.model_id.clone()));
    payload.insert("instructions".to_string(), Value::String(instructions));
    payload.insert("input".to_string(), Value::Array(input));
    payload.insert("tools".to_string(), Value::Array(request.tools.clone()));
    payload.insert(
        "tool_choice".to_string(),
        Value::String(
            request
                .tool_choice
                .clone()
                .unwrap_or_else(|| "auto".to_string()),
        ),
    );
    payload.insert(
        "parallel_tool_calls".to_string(),
        Value::Bool(request.parallel_tool_calls.unwrap_or(false)),
    );
    payload.insert("stream".to_string(), Value::Bool(true));
    if allow_stored_item_refs {
        payload.insert("store".to_string(), Value::Bool(true));
    }
    if let Some(reasoning) = reasoning {
        payload.insert("reasoning".to_string(), reasoning);
    }
    if include_encrypted_reasoning {
        payload.insert(
            "include".to_string(),
            Value::Array(vec![Value::String(
                "reasoning.encrypted_content".to_string(),
            )]),
        );
    }

    Ok(Value::Object(payload))
}

fn merge_text(target: &mut String, delta: &str) {
    if delta.is_empty() {
        return;
    }
    target.push_str(delta);
}

fn upsert_tool_call(tool_calls: &mut Vec<AiToolCall>, tool_call: AiToolCall) {
    if let Some(existing) = tool_calls.iter_mut().find(|entry| entry.id == tool_call.id) {
        *existing = tool_call;
    } else {
        tool_calls.push(tool_call);
    }
}

fn build_chat_provider_input_items(accumulator: &ChatStreamAccumulator) -> Vec<Value> {
    let mut items = Vec::new();
    let mut content = Vec::new();
    if !accumulator.reasoning_summary.trim().is_empty() {
        content.push(json!({
            "type": "reasoning_text",
            "text": accumulator.reasoning_summary,
        }));
    }
    if !accumulator.output_text.trim().is_empty() {
        content.push(json!({
            "type": "output_text",
            "text": accumulator.output_text,
        }));
    }
    if !content.is_empty() {
        items.push(json!({
            "type": "message",
            "role": "assistant",
            "content": content,
            "reasoning_opaque": accumulator.reasoning_opaque,
        }));
    }
    for tool_call in &accumulator.tool_calls {
        items.push(json!({
            "type": "function_call",
            "call_id": tool_call.id,
            "name": tool_call.function.name,
            "arguments": tool_call.function.arguments,
        }));
    }
    items
}

fn extract_response_id(value: &Value) -> Option<String> {
    value
        .get("response")
        .and_then(|item| item.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            value
                .get("response_id")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .or_else(|| value.get("id").and_then(Value::as_str).map(str::to_string))
}

fn extract_output_text_from_output_item(item: &Value) -> String {
    match item.get("type").and_then(Value::as_str).unwrap_or_default() {
        "message" => item
            .get("content")
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|part| match part.get("type").and_then(Value::as_str) {
                        Some("output_text") | Some("text") => {
                            part.get("text").and_then(Value::as_str).map(str::to_string)
                        }
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default(),
        "output_text" => item
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        _ => String::new(),
    }
}

fn extract_reasoning_summary_from_output_item(item: &Value) -> String {
    if item.get("type").and_then(Value::as_str) != Some("reasoning") {
        return String::new();
    }
    item.get("summary")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

fn extract_function_call(item: &Value) -> Option<AiToolCall> {
    if item.get("type").and_then(Value::as_str) != Some("function_call") {
        return None;
    }
    let id = item
        .get("call_id")
        .and_then(Value::as_str)
        .or_else(|| item.get("id").and_then(Value::as_str))?;
    let name = item.get("name").and_then(Value::as_str)?;
    let arguments = item
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or("{}");
    Some(AiToolCall {
        id: id.to_string(),
        kind: "function".to_string(),
        function: AiToolCallFunction {
            name: name.to_string(),
            arguments: arguments.to_string(),
        },
    })
}

fn upsert_output_item(output_items: &mut Vec<Value>, item: Value) {
    let key = item
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| item.get("call_id").and_then(Value::as_str))
        .map(str::to_string);

    if let Some(key) = key {
        if let Some(existing) = output_items.iter_mut().find(|value| {
            value
                .get("id")
                .and_then(Value::as_str)
                .or_else(|| value.get("call_id").and_then(Value::as_str))
                == Some(key.as_str())
        }) {
            *existing = item;
            return;
        }
    }

    output_items.push(item);
}

fn parse_chat_chunk(
    app_handle: &AppHandle,
    request_id: &str,
    payload: &str,
    accumulator: &mut ChatStreamAccumulator,
    pending_tool_calls: &mut Vec<PendingToolCall>,
) -> Result<(), String> {
    let value: ChatSseChunk = serde_json::from_str(payload)
        .map_err(|error| format!("Invalid Copilot chat chunk: {}", error))?;
    for choice in value.choices.unwrap_or_default() {
        let Some(delta) = choice.delta else {
            continue;
        };
        if let Some(reasoning_opaque) = delta.reasoning_opaque {
            accumulator.reasoning_opaque = Some(reasoning_opaque);
        }
        if let Some(reasoning_text) = delta.reasoning_text {
            merge_text(&mut accumulator.reasoning_summary, &reasoning_text);
        }
        if let Some(content) = delta.content {
            merge_text(&mut accumulator.output_text, &content);
            app_handle
                .emit(
                    "ai:stream",
                    AiStreamChunkEvent {
                        request_id: request_id.to_string(),
                        delta: content,
                    },
                )
                .map_err(|error| error.to_string())?;
        }
        if let Some(tool_call_deltas) = delta.tool_calls {
            for tool_delta in tool_call_deltas {
                let index = tool_delta.index.unwrap_or_else(|| pending_tool_calls.len());
                if pending_tool_calls.len() <= index {
                    pending_tool_calls.resize_with(index + 1, PendingToolCall::default);
                }
                let pending = &mut pending_tool_calls[index];
                pending.id = pending.id.take().or(tool_delta.id);
                if let Some(function) = tool_delta.function {
                    pending.name = pending.name.take().or(function.name);
                    if let Some(arguments) = function.arguments {
                        pending.arguments.push_str(&arguments);
                    }
                }
            }
        }
    }
    Ok(())
}

fn finalize_chat_tool_calls(
    pending_tool_calls: Vec<PendingToolCall>,
    accumulator: &mut ChatStreamAccumulator,
) {
    for (index, pending) in pending_tool_calls.into_iter().enumerate() {
        let Some(name) = pending.name else {
            continue;
        };
        let id = pending
            .id
            .unwrap_or_else(|| format!("copilot_tool_call_{}", index));
        upsert_tool_call(
            &mut accumulator.tool_calls,
            AiToolCall {
                id,
                kind: "function".to_string(),
                function: AiToolCallFunction {
                    name,
                    arguments: if pending.arguments.trim().is_empty() {
                        "{}".to_string()
                    } else {
                        pending.arguments
                    },
                },
            },
        );
    }
}

fn process_responses_chunk(
    app_handle: &AppHandle,
    request_id: &str,
    payload: &str,
    accumulator: &mut ResponsesStreamAccumulator,
) -> Result<bool, String> {
    let value: Value = serde_json::from_str(payload)
        .map_err(|error| format!("Invalid Copilot responses chunk: {}", error))?;
    if let Some(response_id) = extract_response_id(&value) {
        accumulator.response_id = Some(response_id);
    }

    match value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "response.output_text.delta" => {
            if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                accumulator.saw_output_text_delta = true;
                merge_text(&mut accumulator.output_text, delta);
                app_handle
                    .emit(
                        "ai:stream",
                        AiStreamChunkEvent {
                            request_id: request_id.to_string(),
                            delta: delta.to_string(),
                        },
                    )
                    .map_err(|error| error.to_string())?;
            }
            Ok(false)
        }
        "response.output_item.added" | "response.output_item.done" => {
            if let Some(item) = value.get("item").cloned() {
                if !accumulator.saw_output_text_delta {
                    merge_text(
                        &mut accumulator.output_text,
                        &extract_output_text_from_output_item(&item),
                    );
                }
                if !accumulator.saw_reasoning_summary_delta {
                    merge_text(
                        &mut accumulator.reasoning_summary,
                        &extract_reasoning_summary_from_output_item(&item),
                    );
                }
                if let Some(tool_call) = extract_function_call(&item) {
                    upsert_tool_call(&mut accumulator.tool_calls, tool_call);
                }
                upsert_output_item(&mut accumulator.output_items, item);
            }
            Ok(false)
        }
        "response.function_call_arguments.done" => {
            let call_id = value
                .get("call_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let name = value
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let arguments = value
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}");
            if !call_id.is_empty() && !name.is_empty() {
                let tool_call = AiToolCall {
                    id: call_id.to_string(),
                    kind: "function".to_string(),
                    function: AiToolCallFunction {
                        name: name.to_string(),
                        arguments: arguments.to_string(),
                    },
                };
                upsert_tool_call(&mut accumulator.tool_calls, tool_call.clone());
                upsert_output_item(
                    &mut accumulator.output_items,
                    json!({
                        "type": "function_call",
                        "call_id": tool_call.id,
                        "name": tool_call.function.name,
                        "arguments": tool_call.function.arguments,
                    }),
                );
            }
            Ok(false)
        }
        "response.reasoning_summary_text.delta" => {
            if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                accumulator.saw_reasoning_summary_delta = true;
                merge_text(&mut accumulator.reasoning_summary, delta);
            }
            Ok(false)
        }
        "response.completed" => {
            if let Some(output) = value
                .get("response")
                .and_then(|item| item.get("output"))
                .and_then(Value::as_array)
            {
                for item in output {
                    upsert_output_item(&mut accumulator.output_items, item.clone());
                    if let Some(tool_call) = extract_function_call(item) {
                        upsert_tool_call(&mut accumulator.tool_calls, tool_call);
                    }
                }
            }
            Ok(true)
        }
        "response.failed" | "response.incomplete" => Err(extract_error_message(payload)),
        _ => Ok(false),
    }
}

fn backfill_responses_output_if_needed(accumulator: &mut ResponsesStreamAccumulator) {
    if accumulator.output_text.trim().is_empty() {
        accumulator.output_text = accumulator
            .output_items
            .iter()
            .map(extract_output_text_from_output_item)
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("");
    }

    if accumulator.reasoning_summary.trim().is_empty() {
        accumulator.reasoning_summary = accumulator
            .output_items
            .iter()
            .map(extract_reasoning_summary_from_output_item)
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("");
    }
}

fn finish_responses_state(
    accumulator: &ResponsesStreamAccumulator,
    supports_response_storage: bool,
) -> Option<CopilotProviderTurnState> {
    let stored_item_refs = if supports_response_storage {
        accumulator
            .output_items
            .iter()
            .filter_map(|item| item.get("id").and_then(Value::as_str))
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    Some(CopilotProviderTurnState {
        endpoint_flavor: ModelEndpointFlavor::Responses,
        reasoning_opaque: None,
        response_id: accumulator.response_id.clone(),
        stored_item_refs,
        provider_items_digest: digest_provider_items(&accumulator.output_items),
    })
}

fn classify_copilot_request_failure(
    endpoint_flavor: ModelEndpointFlavor,
    status: u16,
    body: &str,
) -> CopilotRecoveryAction {
    if endpoint_flavor != ModelEndpointFlavor::Responses {
        return CopilotRecoveryAction::None;
    }

    if !matches!(status, 400 | 403 | 404 | 422) {
        return CopilotRecoveryAction::None;
    }

    let message = extract_error_message(body).to_ascii_lowercase();
    if [
        "store is not supported",
        "unsupported parameter: store",
        "unknown parameter: store",
        "responses is not supported",
        "not supported via responses api",
        "requested model is not supported",
        "the requested model is not supported",
        "this model is not supported",
        "model is not supported",
        "model not supported",
    ]
    .iter()
    .any(|needle| message.contains(needle))
    {
        CopilotRecoveryAction::RetryAsChat
    } else {
        CopilotRecoveryAction::None
    }
}

fn classify_model_request_failure(
    model_id: &str,
    endpoint_flavor: &ModelEndpointFlavor,
    status: u16,
    body: &str,
) -> ClassifiedCopilotRequestFailure {
    let provider_message = extract_error_message(body);
    let lowered = provider_message.to_ascii_lowercase();
    let endpoint_label = endpoint_flavor_label(endpoint_flavor);

    if matches!(status, 400 | 403 | 404 | 422)
        && (lowered.contains("model")
            || lowered.contains("not allowed")
            || lowered.contains("not supported")
            || lowered.contains("access")
            || lowered.contains("permission"))
    {
        return ClassifiedCopilotRequestFailure {
            code: "copilot_model_unusable".to_string(),
            message: format!(
                "GitHub Copilot exposed the model \"{}\" but rejected the {} request for this account. {}",
                model_id, endpoint_label, provider_message
            ),
            status_code: Some(status),
        };
    }

    ClassifiedCopilotRequestFailure {
        code: "copilot_request_failed".to_string(),
        message: format!("{} ({})", provider_message, status),
        status_code: Some(status),
    }
}

async fn record_model_failure(
    ai_state: &AiState,
    provider_id: &str,
    model_id: &str,
    endpoint_flavor: &ModelEndpointFlavor,
    failure: &ClassifiedCopilotRequestFailure,
) {
    ai_state.copilot_model_failures.lock().await.insert(
        provider_id.to_string(),
        CopilotModelFailureRecord {
            provider_id: provider_id.to_string(),
            model_id: model_id.to_string(),
            endpoint_flavor: endpoint_flavor_label(endpoint_flavor),
            status_code: failure.status_code,
            code: failure.code.clone(),
            message: failure.message.clone(),
        },
    );
}

async fn send_native_request(
    pool: &SqlitePool,
    ai_state: &AiState,
    provider_id: &str,
    provider: &ProviderConfig,
    secret: &CopilotSecret,
    request: &AiChatRequest,
    endpoint: &str,
    body: &Value,
) -> Result<reqwest::Response, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| error.to_string())?;
    let url = format!("{}{}", resolve_base_url(provider), endpoint);
    let (response, _) =
        execute_request_with_refresh(pool, ai_state, provider_id, secret, |active_secret| {
            let builder = client
                .post(url.clone())
                .header(CONTENT_TYPE, "application/json")
                .header(ACCEPT, "text/event-stream")
                .json(body);
            apply_copilot_headers(
                builder,
                &active_secret.access_token,
                compute_x_initiator(&request.messages),
                request_has_vision_input(&request.messages),
            )
        })
        .await?;
    Ok(response)
}

pub async fn stream_chat(
    app_handle: AppHandle,
    pool: SqlitePool,
    ai_state: AiState,
    request: AiChatRequest,
) -> Result<(), String> {
    crate::ai::chatgpt::cancel_stream(&ai_state, &request.request_id).await?;

    let request_id = request.request_id.clone();
    let task_request_id = request.request_id.clone();
    let app_for_task = app_handle.clone();
    let state_for_task = ai_state.clone();

    let handle = tokio::spawn(async move {
        let result =
            stream_chat_inner(app_for_task.clone(), pool, state_for_task.clone(), request).await;
        if let Err(message) = result {
            let _ = app_for_task.emit(
                "ai:error",
                AiStreamErrorEvent {
                    request_id: task_request_id.clone(),
                    message,
                },
            );
        }

        let mut tasks = state_for_task.stream_tasks.lock().await;
        tasks.remove(&task_request_id);
    });

    let mut tasks = ai_state.stream_tasks.lock().await;
    tasks.insert(request_id, handle);
    Ok(())
}

async fn stream_chat_inner(
    app_handle: AppHandle,
    pool: SqlitePool,
    ai_state: AiState,
    request: AiChatRequest,
) -> Result<(), String> {
    let provider = repository::get_provider_config(&pool, &request.provider_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Provider {} not found.", request.provider_id))?;
    let model = repository::get_model_by_provider_and_model_id(
        &pool,
        &request.provider_id,
        &request.model_id,
    )
    .await
    .map_err(|error| error.to_string())?;
    let mut endpoint_flavor = resolve_endpoint_flavor(model.as_ref(), &request.model_id);
    let secret = ensure_session(&pool, &ai_state, &request.provider_id, true).await?;
    let body = match endpoint_flavor {
        ModelEndpointFlavor::Chat => build_chat_request_body(&request, model.as_ref())?,
        ModelEndpointFlavor::Responses => build_responses_request_body(&request, model.as_ref())?,
    };
    let endpoint = match endpoint_flavor {
        ModelEndpointFlavor::Chat => COPILOT_CHAT_COMPLETIONS_PATH,
        ModelEndpointFlavor::Responses => COPILOT_RESPONSES_PATH,
    };

    let mut response = send_native_request(
        &pool,
        &ai_state,
        &request.provider_id,
        &provider,
        &secret,
        &request,
        endpoint,
        &body,
    )
    .await?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        match classify_copilot_request_failure(endpoint_flavor.clone(), status, &body) {
            CopilotRecoveryAction::RetryAsChat => {
                endpoint_flavor = ModelEndpointFlavor::Chat;
                let retry_body = build_chat_request_body(&request, model.as_ref())?;
                response = send_native_request(
                    &pool,
                    &ai_state,
                    &request.provider_id,
                    &provider,
                    &secret,
                    &request,
                    COPILOT_CHAT_COMPLETIONS_PATH,
                    &retry_body,
                )
                .await?;
                if !response.status().is_success() {
                    let retry_status = response.status().as_u16();
                    let retry_body = response.text().await.unwrap_or_default();
                    let failure = classify_model_request_failure(
                        &request.model_id,
                        &endpoint_flavor,
                        retry_status,
                        &retry_body,
                    );
                    record_model_failure(
                        &ai_state,
                        &request.provider_id,
                        &request.model_id,
                        &endpoint_flavor,
                        &failure,
                    )
                    .await;
                    return Err(failure.message);
                }
            }
            CopilotRecoveryAction::None => {
                let failure = classify_model_request_failure(
                    &request.model_id,
                    &endpoint_flavor,
                    status,
                    &body,
                );
                record_model_failure(
                    &ai_state,
                    &request.provider_id,
                    &request.model_id,
                    &endpoint_flavor,
                    &failure,
                )
                .await;
                return Err(failure.message);
            }
        }
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    match endpoint_flavor {
        ModelEndpointFlavor::Chat => {
            let mut accumulator = ChatStreamAccumulator::default();
            let mut pending_tool_calls = Vec::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk
                    .map_err(|error| format!("Failed to read GitHub Copilot stream: {}", error))?;
                buffer.push_str(&String::from_utf8_lossy(&chunk));
                if buffer.contains("\r\n") {
                    buffer = buffer.replace("\r\n", "\n");
                }
                while let Some(index) = buffer.find("\n\n") {
                    let event = buffer[..index].to_string();
                    buffer = buffer[index + 2..].to_string();
                    if let Some(payload) = parse_sse_payload(&event) {
                        if payload == "[DONE]" {
                            continue;
                        }
                        parse_chat_chunk(
                            &app_handle,
                            &request.request_id,
                            &payload,
                            &mut accumulator,
                            &mut pending_tool_calls,
                        )?;
                    }
                }
            }
            if let Some(payload) = parse_sse_payload(&buffer) {
                if payload != "[DONE]" {
                    parse_chat_chunk(
                        &app_handle,
                        &request.request_id,
                        &payload,
                        &mut accumulator,
                        &mut pending_tool_calls,
                    )?;
                }
            }
            finalize_chat_tool_calls(pending_tool_calls, &mut accumulator);
            let provider_input_items = build_chat_provider_input_items(&accumulator);
            let provider_turn_state = provider_turn_state_to_json(Some(CopilotProviderTurnState {
                endpoint_flavor: ModelEndpointFlavor::Chat,
                reasoning_opaque: accumulator.reasoning_opaque.clone(),
                response_id: None,
                stored_item_refs: Vec::new(),
                provider_items_digest: digest_provider_items(&provider_input_items),
            }));
            app_handle
                .emit(
                    "ai:done",
                    AiStreamDoneEvent {
                        request_id: request.request_id,
                        output_text: accumulator.output_text,
                        tool_calls: accumulator.tool_calls,
                        response_id: None,
                        output_items: None,
                        provider_input_items: if provider_input_items.is_empty() {
                            None
                        } else {
                            Some(provider_input_items)
                        },
                        provider_turn_state,
                        reasoning_summary: if accumulator.reasoning_summary.trim().is_empty() {
                            None
                        } else {
                            Some(accumulator.reasoning_summary)
                        },
                        tool_traces: None,
                        hidden_context: None,
                    },
                )
                .map_err(|error| error.to_string())?;
        }
        ModelEndpointFlavor::Responses => {
            let response_storage_supported = supports_response_storage(model.as_ref());
            let mut accumulator = ResponsesStreamAccumulator::default();
            let mut saw_completed = false;
            while let Some(chunk) = stream.next().await {
                let chunk = chunk
                    .map_err(|error| format!("Failed to read GitHub Copilot stream: {}", error))?;
                buffer.push_str(&String::from_utf8_lossy(&chunk));
                if buffer.contains("\r\n") {
                    buffer = buffer.replace("\r\n", "\n");
                }
                while let Some(index) = buffer.find("\n\n") {
                    let event = buffer[..index].to_string();
                    buffer = buffer[index + 2..].to_string();
                    if let Some(payload) = parse_sse_payload(&event) {
                        if payload == "[DONE]" {
                            continue;
                        }
                        if process_responses_chunk(
                            &app_handle,
                            &request.request_id,
                            &payload,
                            &mut accumulator,
                        )? {
                            saw_completed = true;
                        }
                    }
                }
            }
            if let Some(payload) = parse_sse_payload(&buffer) {
                if payload != "[DONE]" {
                    saw_completed |= process_responses_chunk(
                        &app_handle,
                        &request.request_id,
                        &payload,
                        &mut accumulator,
                    )?;
                }
            }
            if !saw_completed {
                debug!(request_id = %request.request_id, "Copilot responses stream ended without explicit completed event");
            }
            backfill_responses_output_if_needed(&mut accumulator);
            let provider_turn_state = provider_turn_state_to_json(finish_responses_state(
                &accumulator,
                response_storage_supported,
            ));
            app_handle
                .emit(
                    "ai:done",
                    AiStreamDoneEvent {
                        request_id: request.request_id,
                        output_text: accumulator.output_text,
                        tool_calls: accumulator.tool_calls,
                        response_id: accumulator.response_id,
                        output_items: Some(accumulator.output_items.clone()),
                        provider_input_items: if accumulator.output_items.is_empty() {
                            None
                        } else {
                            Some(accumulator.output_items.clone())
                        },
                        provider_turn_state,
                        reasoning_summary: if accumulator.reasoning_summary.trim().is_empty() {
                            None
                        } else {
                            Some(accumulator.reasoning_summary)
                        },
                        tool_traces: None,
                        hidden_context: None,
                    },
                )
                .map_err(|error| error.to_string())?;
        }
    }

    ai_state
        .copilot_model_failures
        .lock()
        .await
        .remove(&request.provider_id);

    Ok(())
}

fn parse_sse_payload(event: &str) -> Option<String> {
    let mut payload = String::new();
    for line in event.lines() {
        if let Some(rest) = line.trim_end().strip_prefix("data:") {
            payload.push_str(rest.trim_start());
        }
    }
    if payload.trim().is_empty() {
        None
    } else {
        Some(payload)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn oauth_env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn base_request() -> AiChatRequest {
        AiChatRequest {
            request_id: "req_1".to_string(),
            provider_id: "copilot".to_string(),
            model_id: "gpt-5".to_string(),
            reasoning_effort: Some("high".to_string()),
            conversation_id: Some("conv_1".to_string()),
            messages: vec![AiChatMessage {
                role: "user".to_string(),
                content: AiChatMessageContent::Text("Hello".to_string()),
                tool_calls: Vec::new(),
                tool_call_id: None,
                provider_input_items: None,
                provider_turn_state: None,
            }],
            tools: Vec::new(),
            tool_choice: None,
            parallel_tool_calls: None,
            workspace_path: None,
            default_workspace_path: None,
            project_mounts: Vec::new(),
            virtual_root_enabled: None,
            focused_project_id: None,
            allowed_tool_ids: Vec::new(),
        }
    }

    fn copilot_model_with_capabilities(capabilities: ModelCapabilities) -> AiModel {
        AiModel {
            id: "model_1".to_string(),
            provider_id: "copilot".to_string(),
            model_id: "gpt-5".to_string(),
            name: "GPT-5".to_string(),
            description: None,
            owned_by: None,
            pricing_prompt: None,
            pricing_completion: None,
            pricing_request: None,
            reasoning_efforts: Some(vec![
                "low".to_string(),
                "medium".to_string(),
                "high".to_string(),
            ]),
            default_reasoning_effort: Some("medium".to_string()),
            context_window_tokens: None,
            capabilities: Some(capabilities),
            is_enabled: true,
            is_manual: false,
            first_seen_at: "2026-04-06T00:00:00Z".to_string(),
            last_seen_at: "2026-04-06T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn resolve_base_url_maps_legacy_cli_scheme_to_native_api() {
        let provider = ProviderConfig {
            id: "copilot".to_string(),
            name: "GitHub Copilot".to_string(),
            provider_type: "copilot".to_string(),
            base_url: "copilot://cli".to_string(),
            api_key: None,
            has_stored_api_key: false,
            is_enabled: true,
            is_local: false,
            auth_status: None,
            auth_source: None,
            plan_type: None,
            account_label: None,
            token_expires_at: None,
            created_at: "2026-04-06T00:00:00Z".to_string(),
            updated_at: "2026-04-06T00:00:00Z".to_string(),
        };

        assert_eq!(resolve_base_url(&provider), COPILOT_DEFAULT_BASE_URL);
    }

    #[test]
    fn build_chat_provider_input_items_keeps_reasoning_and_tools() {
        let items = build_chat_provider_input_items(&ChatStreamAccumulator {
            output_text: "Hello".to_string(),
            reasoning_summary: "Thinking".to_string(),
            reasoning_opaque: Some("opaque-token".to_string()),
            tool_calls: vec![AiToolCall {
                id: "call_1".to_string(),
                kind: "function".to_string(),
                function: AiToolCallFunction {
                    name: "read".to_string(),
                    arguments: "{\"path\":\"src\"}".to_string(),
                },
            }],
        });

        assert_eq!(items.len(), 2);
        assert_eq!(
            items[0].get("type").and_then(Value::as_str),
            Some("message")
        );
        assert_eq!(
            items[1].get("type").and_then(Value::as_str),
            Some("function_call")
        );
    }

    #[test]
    fn build_responses_input_prefers_item_references_from_turn_state() {
        let request = AiChatRequest {
            messages: vec![AiChatMessage {
                role: "assistant".to_string(),
                content: AiChatMessageContent::Text("".to_string()),
                tool_calls: Vec::new(),
                tool_call_id: None,
                provider_input_items: None,
                provider_turn_state: Some(json!({
                    "provider": "copilot",
                    "endpoint_flavor": "responses",
                    "stored_item_refs": ["resp-item-1", "resp-item-2"],
                })),
            }],
            ..base_request()
        };

        let (_, input) = build_responses_input(&request, true).expect("responses input");
        assert_eq!(input.len(), 2);
        assert_eq!(
            input[0].get("type").and_then(Value::as_str),
            Some("item_reference")
        );
    }

    #[test]
    fn build_responses_input_ignores_item_references_when_storage_is_disabled() {
        let request = AiChatRequest {
            messages: vec![AiChatMessage {
                role: "assistant".to_string(),
                content: AiChatMessageContent::Text("Fallback answer".to_string()),
                tool_calls: Vec::new(),
                tool_call_id: None,
                provider_input_items: Some(vec![json!({
                    "type": "message",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "Fallback answer" }],
                })]),
                provider_turn_state: Some(json!({
                    "provider": "copilot",
                    "endpoint_flavor": "responses",
                    "stored_item_refs": ["resp-item-1"],
                })),
            }],
            ..base_request()
        };

        let (_, input) = build_responses_input(&request, false).expect("responses input");
        assert_eq!(input.len(), 1);
        assert_eq!(
            input[0].get("type").and_then(Value::as_str),
            Some("message")
        );
    }

    #[test]
    fn build_responses_request_body_omits_reasoning_fields_for_non_reasoning_models() {
        let request = AiChatRequest {
            request_id: "req_1".to_string(),
            provider_id: "copilot".to_string(),
            model_id: "claude-sonnet-4".to_string(),
            reasoning_effort: Some("high".to_string()),
            conversation_id: None,
            messages: vec![AiChatMessage {
                role: "user".to_string(),
                content: AiChatMessageContent::Text("Hello".to_string()),
                tool_calls: Vec::new(),
                tool_call_id: None,
                provider_input_items: None,
                provider_turn_state: None,
            }],
            tools: Vec::new(),
            tool_choice: None,
            parallel_tool_calls: None,
            workspace_path: None,
            default_workspace_path: None,
            project_mounts: Vec::new(),
            virtual_root_enabled: None,
            focused_project_id: None,
            allowed_tool_ids: Vec::new(),
        };
        let model = AiModel {
            id: "model_1".to_string(),
            provider_id: "copilot".to_string(),
            model_id: "claude-sonnet-4".to_string(),
            name: "Claude Sonnet 4".to_string(),
            description: None,
            owned_by: None,
            pricing_prompt: None,
            pricing_completion: None,
            pricing_request: None,
            reasoning_efforts: None,
            default_reasoning_effort: None,
            context_window_tokens: None,
            capabilities: Some(ModelCapabilities {
                supports_reasoning_effort: Some(false),
                include_encrypted_reasoning: Some(false),
                ..ModelCapabilities::default()
            }),
            is_enabled: true,
            is_manual: false,
            first_seen_at: "2026-04-06T00:00:00Z".to_string(),
            last_seen_at: "2026-04-06T00:00:00Z".to_string(),
        };

        let body = build_responses_request_body(&request, Some(&model)).expect("responses body");

        assert!(body.get("reasoning").is_none());
        assert!(body.get("include").is_none());
        assert!(body.get("store").is_none());
    }

    #[test]
    fn build_responses_request_body_omits_store_when_storage_is_unsupported() {
        let request = base_request();
        let model = copilot_model_with_capabilities(ModelCapabilities {
            endpoint_flavor: Some(ModelEndpointFlavor::Responses),
            supported_endpoints: Some(vec![ModelEndpointFlavor::Responses]),
            supports_reasoning_effort: Some(true),
            include_encrypted_reasoning: Some(false),
            supports_response_storage: Some(false),
            ..ModelCapabilities::default()
        });

        let body = build_responses_request_body(&request, Some(&model)).expect("responses body");

        assert!(body.get("store").is_none());
    }

    #[test]
    fn build_responses_request_body_includes_store_when_storage_is_supported() {
        let request = base_request();
        let model = copilot_model_with_capabilities(ModelCapabilities {
            endpoint_flavor: Some(ModelEndpointFlavor::Responses),
            supported_endpoints: Some(vec![ModelEndpointFlavor::Responses]),
            supports_reasoning_effort: Some(true),
            include_encrypted_reasoning: Some(false),
            supports_response_storage: Some(true),
            ..ModelCapabilities::default()
        });

        let body = build_responses_request_body(&request, Some(&model)).expect("responses body");

        assert_eq!(body.get("store").and_then(Value::as_bool), Some(true));
    }

    #[test]
    fn backfill_responses_output_if_needed_uses_output_items_once() {
        let mut accumulator = ResponsesStreamAccumulator {
            output_items: vec![
                json!({
                    "type": "message",
                    "id": "msg_1",
                    "content": [
                        { "type": "output_text", "text": "Hello" }
                    ]
                }),
                json!({
                    "type": "reasoning",
                    "id": "rs_1",
                    "summary": [
                        { "text": "Thinking" }
                    ]
                }),
            ],
            ..ResponsesStreamAccumulator::default()
        };

        backfill_responses_output_if_needed(&mut accumulator);
        backfill_responses_output_if_needed(&mut accumulator);

        assert_eq!(accumulator.output_text, "Hello");
        assert_eq!(accumulator.reasoning_summary, "Thinking");
    }

    #[test]
    fn finish_responses_state_drops_item_refs_when_storage_is_unsupported() {
        let accumulator = ResponsesStreamAccumulator {
            output_items: vec![json!({
                "type": "message",
                "id": "msg_1",
                "content": [{ "type": "output_text", "text": "Hello" }]
            })],
            response_id: Some("resp_1".to_string()),
            ..ResponsesStreamAccumulator::default()
        };

        let state = finish_responses_state(&accumulator, false).expect("turn state");

        assert!(state.stored_item_refs.is_empty());
        assert_eq!(state.response_id.as_deref(), Some("resp_1"));
    }

    #[test]
    fn normalize_provider_items_for_responses_strips_chat_only_reasoning_parts() {
        let normalized = normalize_provider_items_for_responses(&[json!({
            "type": "message",
            "role": "assistant",
            "content": [
                { "type": "reasoning_text", "text": "Think" },
                { "type": "output_text", "text": "Answer" }
            ],
            "reasoning_opaque": "opaque-token"
        })]);

        assert_eq!(normalized.len(), 1);
        assert_eq!(
            normalized[0].get("type").and_then(Value::as_str),
            Some("message")
        );
        assert_eq!(
            normalized[0]
                .pointer("/content/0/type")
                .and_then(Value::as_str),
            Some("output_text")
        );
        assert_eq!(
            normalized[0]
                .pointer("/content/0/text")
                .and_then(Value::as_str),
            Some("Answer")
        );
        assert!(normalized[0].get("reasoning_opaque").is_none());
    }

    #[test]
    fn build_chat_message_from_provider_items_reads_responses_reasoning_items() {
        let message = AiChatMessage {
            role: "assistant".to_string(),
            content: AiChatMessageContent::Text(String::new()),
            tool_calls: Vec::new(),
            tool_call_id: None,
            provider_input_items: Some(vec![
                json!({
                    "type": "reasoning",
                    "id": "rs_1",
                    "encrypted_content": "opaque-token",
                    "summary": [{ "text": "Thinking" }]
                }),
                json!({
                    "type": "message",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "Answer" }]
                }),
            ]),
            provider_turn_state: None,
        };

        let rebuilt = build_chat_message_from_provider_items(&message).expect("chat replay");

        assert_eq!(
            rebuilt.get("reasoning_text").and_then(Value::as_str),
            Some("Thinking")
        );
        assert_eq!(
            rebuilt.get("reasoning_opaque").and_then(Value::as_str),
            Some("opaque-token")
        );
        assert_eq!(
            rebuilt.get("content").and_then(Value::as_str),
            Some("Answer")
        );
    }

    #[test]
    fn build_chat_messages_drops_orphaned_tool_calls_from_assistant_replay() {
        let request = AiChatRequest {
            messages: vec![
                AiChatMessage {
                    role: "user".to_string(),
                    content: AiChatMessageContent::Text("hello".to_string()),
                    tool_calls: Vec::new(),
                    tool_call_id: None,
                    provider_input_items: None,
                    provider_turn_state: None,
                },
                AiChatMessage {
                    role: "assistant".to_string(),
                    content: AiChatMessageContent::Text(String::new()),
                    tool_calls: Vec::new(),
                    tool_call_id: None,
                    provider_input_items: Some(vec![json!({
                        "type": "function_call",
                        "call_id": "call_missing",
                        "name": "read_file",
                        "arguments": "{\"path\":\"README.md\"}",
                    })]),
                    provider_turn_state: None,
                },
            ],
            ..base_request()
        };

        let messages = build_chat_messages(&request).expect("chat messages");
        assert_eq!(messages.len(), 1);
        assert_eq!(
            messages[0].get("role").and_then(Value::as_str),
            Some("user")
        );
    }

    #[test]
    fn classify_copilot_request_failure_retries_store_related_responses_errors() {
        assert_eq!(
            classify_copilot_request_failure(
                ModelEndpointFlavor::Responses,
                400,
                r#"{"error":{"message":"store is not supported for this model"}}"#
            ),
            CopilotRecoveryAction::RetryAsChat
        );
    }

    #[test]
    fn classify_copilot_request_failure_retries_unsupported_model_responses_errors() {
        assert_eq!(
            classify_copilot_request_failure(
                ModelEndpointFlavor::Responses,
                400,
                r#"{"error":{"message":"The requested model is not supported."}}"#,
            ),
            CopilotRecoveryAction::RetryAsChat
        );
    }

    #[test]
    fn classify_copilot_request_failure_retries_responses_api_rejections() {
        assert_eq!(
            classify_copilot_request_failure(
                ModelEndpointFlavor::Responses,
                400,
                r#"{"error":{"message":"model gpt-4o is not supported via Responses API."}}"#,
            ),
            CopilotRecoveryAction::RetryAsChat
        );
    }

    #[test]
    fn classify_copilot_request_failure_ignores_unrelated_errors() {
        assert_eq!(
            classify_copilot_request_failure(
                ModelEndpointFlavor::Responses,
                400,
                r#"{"error":{"message":"invalid tool schema"}}"#
            ),
            CopilotRecoveryAction::None
        );
    }

    #[test]
    fn apply_copilot_model_headers_keeps_models_requests_minimal() {
        let client = reqwest::Client::new();
        let request = apply_copilot_model_headers(
            client.get("https://api.githubcopilot.com/models"),
            "token-123",
            &copilot_user_agent(),
            CopilotDiscoveryProfile::MacroNative,
        )
        .build()
        .expect("request");

        assert_eq!(
            request
                .headers()
                .get(USER_AGENT)
                .and_then(|value| value.to_str().ok()),
            Some(copilot_user_agent().as_str())
        );
        assert_eq!(
            request
                .headers()
                .get(AUTHORIZATION)
                .and_then(|value| value.to_str().ok()),
            Some("Bearer token-123")
        );
        assert_eq!(
            request
                .headers()
                .get(ACCEPT)
                .and_then(|value| value.to_str().ok()),
            Some("application/json")
        );
        assert!(request.headers().get("Openai-Intent").is_none());
        assert!(request.headers().get("x-initiator").is_none());
        assert!(request.headers().get("Copilot-Vision-Request").is_none());
    }

    #[test]
    fn apply_copilot_model_headers_adds_ide_compat_headers() {
        let client = reqwest::Client::new();
        let request = apply_copilot_model_headers(
            client.get("https://api.githubcopilot.com/models"),
            "token-123",
            copilot_compatibility_user_agent(),
            CopilotDiscoveryProfile::MacroIdeCompat,
        )
        .build()
        .expect("request");

        assert_eq!(
            request
                .headers()
                .get("Copilot-Integration-Id")
                .and_then(|value| value.to_str().ok()),
            Some(COPILOT_DISCOVERY_INTEGRATION_ID)
        );
        assert_eq!(
            request
                .headers()
                .get("Editor-Version")
                .and_then(|value| value.to_str().ok()),
            Some(COPILOT_DISCOVERY_EDITOR_VERSION)
        );
    }

    #[test]
    fn looks_like_legacy_model_catalog_detects_old_copilot_set() {
        let remote_models = vec![
            CopilotRemoteModelRecord {
                id: "gpt-4o".to_string(),
                name: Some("GPT-4o".to_string()),
                version: None,
                model_picker_enabled: Some(true),
                supported_endpoints: Some(vec!["chat".to_string()]),
                capabilities: None,
            },
            CopilotRemoteModelRecord {
                id: "gpt-4o-mini".to_string(),
                name: Some("GPT-4o Mini".to_string()),
                version: None,
                model_picker_enabled: Some(false),
                supported_endpoints: Some(vec!["chat".to_string()]),
                capabilities: None,
            },
        ];

        assert!(looks_like_legacy_model_catalog(&remote_models));
    }

    #[test]
    fn is_better_discovery_candidate_prefers_more_models_then_visibility_then_endpoints() {
        let legacy = vec![CopilotRemoteModelRecord {
            id: "gpt-4o".to_string(),
            name: Some("GPT-4o".to_string()),
            version: None,
            model_picker_enabled: Some(true),
            supported_endpoints: Some(vec![]),
            capabilities: None,
        }];
        let richer = vec![
            CopilotRemoteModelRecord {
                id: "gpt-4o".to_string(),
                name: Some("GPT-4o".to_string()),
                version: None,
                model_picker_enabled: Some(true),
                supported_endpoints: Some(vec![]),
                capabilities: None,
            },
            CopilotRemoteModelRecord {
                id: "gpt-5".to_string(),
                name: Some("GPT-5".to_string()),
                version: None,
                model_picker_enabled: Some(false),
                supported_endpoints: Some(vec!["responses".to_string()]),
                capabilities: None,
            },
        ];

        assert!(is_better_discovery_candidate(&legacy, &richer));
        assert!(!is_better_discovery_candidate(&richer, &legacy));
    }

    #[test]
    fn visible_remote_models_matches_model_picker_enabled_filter() {
        let remote_models = vec![
            CopilotRemoteModelRecord {
                id: "gpt-4o".to_string(),
                name: Some("GPT-4o".to_string()),
                version: None,
                model_picker_enabled: Some(true),
                supported_endpoints: Some(vec!["chat".to_string()]),
                capabilities: None,
            },
            CopilotRemoteModelRecord {
                id: "hidden-model".to_string(),
                name: Some("Hidden".to_string()),
                version: None,
                model_picker_enabled: Some(false),
                supported_endpoints: Some(vec!["responses".to_string()]),
                capabilities: None,
            },
            CopilotRemoteModelRecord {
                id: "legacy-default-visible".to_string(),
                name: Some("Legacy".to_string()),
                version: None,
                model_picker_enabled: None,
                supported_endpoints: Some(vec!["chat".to_string()]),
                capabilities: None,
            },
        ];

        let visible = visible_remote_models(&remote_models);
        let ids = visible
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(ids, vec!["gpt-4o", "legacy-default-visible"]);
    }

    #[test]
    fn classify_model_request_failure_marks_visible_but_rejected_models() {
        let failure = classify_model_request_failure(
            "gpt-5",
            &ModelEndpointFlavor::Responses,
            403,
            r#"{"error":{"message":"This model is not allowed for your account"}}"#,
        );

        assert_eq!(failure.code, "copilot_model_unusable");
        assert!(failure.message.contains("gpt-5"));
        assert!(failure.message.contains("responses"));
    }

    #[test]
    fn load_copilot_oauth_config_reads_macro_env_overrides() {
        let _guard = oauth_env_lock().lock().expect("env lock");
        let original_client_id = env::var(COPILOT_GITHUB_CLIENT_ID_ENV).ok();
        let original_display_name = env::var(COPILOT_DISPLAY_NAME_ENV).ok();
        let original_config = env::var("MACRO_CONFIG").ok();

        unsafe {
            env::set_var(COPILOT_GITHUB_CLIENT_ID_ENV, "Ov23macroclientid");
            env::set_var(COPILOT_DISPLAY_NAME_ENV, "Macro");
            env::remove_var("MACRO_CONFIG");
        }

        let config = load_copilot_oauth_config().expect("oauth config");
        assert_eq!(config.client_id, "Ov23macroclientid");
        assert_eq!(config.display_name, "Macro");

        unsafe {
            if let Some(value) = original_client_id {
                env::set_var(COPILOT_GITHUB_CLIENT_ID_ENV, value);
            } else {
                env::remove_var(COPILOT_GITHUB_CLIENT_ID_ENV);
            }
            if let Some(value) = original_display_name {
                env::set_var(COPILOT_DISPLAY_NAME_ENV, value);
            } else {
                env::remove_var(COPILOT_DISPLAY_NAME_ENV);
            }
            if let Some(value) = original_config {
                env::set_var("MACRO_CONFIG", value);
            } else {
                env::remove_var("MACRO_CONFIG");
            }
        }
    }

    #[test]
    fn load_copilot_oauth_config_uses_macro_default_oauth_app_client_id() {
        let _guard = oauth_env_lock().lock().expect("env lock");
        let original_client_id = env::var(COPILOT_GITHUB_CLIENT_ID_ENV).ok();
        let original_display_name = env::var(COPILOT_DISPLAY_NAME_ENV).ok();
        let original_config = env::var("MACRO_CONFIG").ok();

        unsafe {
            env::remove_var(COPILOT_GITHUB_CLIENT_ID_ENV);
            env::remove_var(COPILOT_DISPLAY_NAME_ENV);
            env::remove_var("MACRO_CONFIG");
        }

        let config = load_copilot_oauth_config().expect("default oauth app config");
        assert_eq!(config.client_id, "Ov23liDvVdfyEW8rml19");
        assert_eq!(config.display_name, "Macro");

        unsafe {
            if let Some(value) = original_client_id {
                env::set_var(COPILOT_GITHUB_CLIENT_ID_ENV, value);
            } else {
                env::remove_var(COPILOT_GITHUB_CLIENT_ID_ENV);
            }
            if let Some(value) = original_display_name {
                env::set_var(COPILOT_DISPLAY_NAME_ENV, value);
            } else {
                env::remove_var(COPILOT_DISPLAY_NAME_ENV);
            }
            if let Some(value) = original_config {
                env::set_var("MACRO_CONFIG", value);
            } else {
                env::remove_var("MACRO_CONFIG");
            }
        }
    }

    #[test]
    fn load_copilot_oauth_config_rejects_github_app_client_id() {
        let _guard = oauth_env_lock().lock().expect("env lock");
        let original_client_id = env::var(COPILOT_GITHUB_CLIENT_ID_ENV).ok();
        let original_display_name = env::var(COPILOT_DISPLAY_NAME_ENV).ok();
        let original_config = env::var("MACRO_CONFIG").ok();

        unsafe {
            env::set_var(COPILOT_GITHUB_CLIENT_ID_ENV, "Iv23likawVtFVfQCEhc2");
            env::set_var(COPILOT_DISPLAY_NAME_ENV, "Macro");
            env::remove_var("MACRO_CONFIG");
        }

        let error =
            load_copilot_oauth_config().expect_err("github app client id should be rejected");
        assert!(error.contains("GitHub App client ID"));

        unsafe {
            if let Some(value) = original_client_id {
                env::set_var(COPILOT_GITHUB_CLIENT_ID_ENV, value);
            } else {
                env::remove_var(COPILOT_GITHUB_CLIENT_ID_ENV);
            }
            if let Some(value) = original_display_name {
                env::set_var(COPILOT_DISPLAY_NAME_ENV, value);
            } else {
                env::remove_var(COPILOT_DISPLAY_NAME_ENV);
            }
            if let Some(value) = original_config {
                env::set_var("MACRO_CONFIG", value);
            } else {
                env::remove_var("MACRO_CONFIG");
            }
        }
    }
}
