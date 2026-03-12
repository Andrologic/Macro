use super::{CommandError, CommandResult, DbPool};
use crate::ai::chatgpt::{self, AiChatRequest};
use crate::ai::AiState;
use tauri::{AppHandle, State};

async fn get_pool(pool: &State<'_, DbPool>) -> CommandResult<sqlx::SqlitePool> {
    let pool_guard = pool.lock().await;
    pool_guard.as_ref().cloned().ok_or_else(|| CommandError {
        message: "Database not initialized".to_string(),
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
    pool: State<'_, DbPool>,
    provider_id: String,
) -> CommandResult<crate::db::models::ProviderConfig> {
    let pool = get_pool(&pool).await?;
    chatgpt::disconnect_auth(&pool, &provider_id)
        .await
        .map_err(|message| CommandError { message })
}

#[tauri::command]
pub async fn ai_sync_provider_models(
    pool: State<'_, DbPool>,
    provider_id: String,
) -> CommandResult<Vec<crate::db::models::AiModel>> {
    let pool = get_pool(&pool).await?;
    chatgpt::sync_models(&pool, &provider_id)
        .await
        .map_err(|message| CommandError { message })
}

#[tauri::command]
pub async fn ai_stream_chat(
    app_handle: AppHandle,
    pool: State<'_, DbPool>,
    ai_state: State<'_, AiState>,
    request: AiChatRequest,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;
    chatgpt::stream_chat(app_handle, pool, ai_state.inner().clone(), request)
        .await
        .map_err(|message| CommandError { message })
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
