use super::{get_pool, CommandError, CommandResult, DbPool};
use crate::ai::AiState;
use crate::ai::{
    chatgpt::{self, AiChatRequest},
    copilot,
};
use crate::db::repository;
use tauri::{AppHandle, State};

async fn get_provider_type(
    pool: &sqlx::SqlitePool,
    provider_id: &str,
) -> Result<String, CommandError> {
    repository::get_provider_config(pool, provider_id)
        .await
        .map_err(|error| CommandError {
            message: error.to_string(),
        })?
        .map(|provider| provider.provider_type)
        .ok_or_else(|| CommandError {
            message: format!("Provider {} not found", provider_id),
        })
}

#[tauri::command]
pub async fn ai_start_chatgpt_auth(
    app_handle: AppHandle,
    pool: State<'_, DbPool>,
    ai_state: State<'_, AiState>,
    request_id: String,
    provider_id: Option<String>,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;
    let provider_id = provider_id.unwrap_or_else(|| "chatgpt".to_string());
    chatgpt::start_browser_auth(
        app_handle,
        pool,
        ai_state.inner().clone(),
        request_id,
        provider_id,
    )
    .await
    .map_err(|message| CommandError { message })
}

#[tauri::command]
pub async fn ai_get_copilot_status(
    app_handle: AppHandle,
    pool: State<'_, DbPool>,
    ai_state: State<'_, AiState>,
    provider_id: Option<String>,
) -> CommandResult<copilot::CopilotStatus> {
    let pool = get_pool(&pool).await?;
    let provider_id = provider_id.unwrap_or_else(|| "copilot".to_string());
    match get_provider_type(&pool, &provider_id).await?.as_str() {
        "copilot" => {}
        provider_type => {
            return Err(CommandError {
                message: format!("Copilot status is not supported for {}.", provider_type),
            })
        }
    }
    copilot::get_status(&app_handle, &pool, ai_state.inner(), &provider_id)
        .await
        .map_err(|message| CommandError { message })
}

#[tauri::command]
pub async fn ai_download_copilot_runtime(
    app_handle: AppHandle,
    pool: State<'_, DbPool>,
    ai_state: State<'_, AiState>,
    request_id: String,
    provider_id: Option<String>,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;
    let provider_id = provider_id.unwrap_or_else(|| "copilot".to_string());
    match get_provider_type(&pool, &provider_id).await?.as_str() {
        "copilot" => {}
        provider_type => {
            return Err(CommandError {
                message: format!(
                    "Copilot runtime download is not supported for {}.",
                    provider_type
                ),
            })
        }
    }
    copilot::start_runtime_download(
        app_handle,
        pool,
        ai_state.inner().clone(),
        request_id,
        provider_id,
    )
    .await
    .map_err(|message| CommandError { message })
}

#[tauri::command]
pub async fn ai_cancel_copilot_runtime_download(
    app_handle: AppHandle,
    ai_state: State<'_, AiState>,
    request_id: String,
) -> CommandResult<()> {
    copilot::cancel_runtime_download(&app_handle, ai_state.inner(), &request_id)
        .await
        .map_err(|message| CommandError { message })
}

#[tauri::command]
pub async fn ai_start_copilot_auth(
    app_handle: AppHandle,
    pool: State<'_, DbPool>,
    ai_state: State<'_, AiState>,
    request_id: String,
    provider_id: Option<String>,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;
    let provider_id = provider_id.unwrap_or_else(|| "copilot".to_string());
    match get_provider_type(&pool, &provider_id).await?.as_str() {
        "copilot" => {}
        provider_type => {
            return Err(CommandError {
                message: format!("Copilot auth is not supported for {}.", provider_type),
            })
        }
    }
    copilot::start_auth(
        app_handle,
        pool,
        ai_state.inner().clone(),
        request_id,
        provider_id,
    )
    .await
    .map_err(|message| CommandError { message })
}

#[tauri::command]
pub async fn ai_cancel_copilot_auth(
    app_handle: AppHandle,
    ai_state: State<'_, AiState>,
    request_id: String,
) -> CommandResult<()> {
    copilot::cancel_auth(&app_handle, ai_state.inner(), &request_id)
        .await
        .map_err(|message| CommandError { message })
}

#[tauri::command]
pub async fn ai_cancel_chatgpt_auth(
    app_handle: AppHandle,
    ai_state: State<'_, AiState>,
    request_id: String,
) -> CommandResult<()> {
    chatgpt::cancel_auth(app_handle, ai_state.inner(), &request_id)
        .await
        .map_err(|message| CommandError { message })
}

#[tauri::command]
pub async fn ai_disconnect_provider_auth(
    _app_handle: AppHandle,
    pool: State<'_, DbPool>,
    provider_id: String,
) -> CommandResult<crate::db::models::ProviderConfig> {
    let pool = get_pool(&pool).await?;
    match get_provider_type(&pool, &provider_id).await?.as_str() {
        "chatgpt" => chatgpt::disconnect_auth(&pool, &provider_id)
            .await
            .map_err(|message| CommandError { message }),
        "copilot" => Err(CommandError {
            message: "GitHub Copilot account switching is not available in Macro yet. Use Copilot CLI to switch accounts.".to_string(),
        }),
        provider_type => Err(CommandError {
            message: format!(
                "Provider auth disconnect is not supported for {}.",
                provider_type
            ),
        }),
    }
}

#[tauri::command]
pub async fn ai_sync_provider_models(
    app_handle: AppHandle,
    pool: State<'_, DbPool>,
    ai_state: State<'_, AiState>,
    provider_id: String,
) -> CommandResult<Vec<crate::db::models::AiModel>> {
    let pool = get_pool(&pool).await?;
    match get_provider_type(&pool, &provider_id).await?.as_str() {
        "chatgpt" => chatgpt::sync_models(&pool, &provider_id)
            .await
            .map_err(|message| CommandError { message }),
        "copilot" => copilot::sync_models(&app_handle, &pool, ai_state.inner(), &provider_id)
            .await
            .map_err(|message| CommandError { message }),
        provider_type => Err(CommandError {
            message: format!("Model sync is not supported for {}.", provider_type),
        }),
    }
}

#[tauri::command]
pub async fn ai_stream_chat(
    app_handle: AppHandle,
    pool: State<'_, DbPool>,
    ai_state: State<'_, AiState>,
    request: AiChatRequest,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;
    match get_provider_type(&pool, &request.provider_id)
        .await?
        .as_str()
    {
        "chatgpt" => chatgpt::stream_chat(app_handle, pool, ai_state.inner().clone(), request)
            .await
            .map_err(|message| CommandError { message }),
        "copilot" => copilot::stream_chat(app_handle, pool, ai_state.inner().clone(), request)
            .await
            .map_err(|message| CommandError { message }),
        provider_type => Err(CommandError {
            message: format!("Native streaming is not supported for {}.", provider_type),
        }),
    }
}

#[tauri::command]
pub async fn ai_cancel_stream(
    ai_state: State<'_, AiState>,
    request_id: String,
) -> CommandResult<()> {
    chatgpt::cancel_stream(ai_state.inner(), &request_id)
        .await
        .map_err(|message| CommandError { message })
}
