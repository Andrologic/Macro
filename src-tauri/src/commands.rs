#[path = "commands/fs.rs"]
pub mod fs;
#[path = "commands/git.rs"]
pub mod git;

use crate::db::{models::*, repository, DbError};
use crate::secrets;
use serde::Serialize;
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;

pub type DbPool = Arc<Mutex<Option<SqlitePool>>>;

#[derive(Debug, Serialize)]
pub struct CommandError {
    pub message: String,
}

impl From<DbError> for CommandError {
    fn from(err: DbError) -> Self {
        CommandError {
            message: err.to_string(),
        }
    }
}

type CommandResult<T> = Result<T, CommandError>;

// ============ CONVERSATIONS ============

#[tauri::command]
pub async fn db_list_conversations(
    pool: State<'_, DbPool>,
) -> CommandResult<Vec<Conversation>> {
    let pool_guard = pool.lock().await;
    let pool = pool_guard
        .as_ref()
        .ok_or_else(|| CommandError {
            message: "Database not initialized".to_string(),
        })?;

    repository::list_conversations(pool)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_get_conversation(
    pool: State<'_, DbPool>,
    id: String,
) -> CommandResult<Option<Conversation>> {
    let pool_guard = pool.lock().await;
    let pool = pool_guard.as_ref().ok_or_else(|| CommandError {
        message: "Database not initialized".to_string(),
    })?;

    repository::get_conversation(pool, &id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_create_conversation(
    pool: State<'_, DbPool>,
    title: Option<String>,
) -> CommandResult<Conversation> {
    let pool_guard = pool.lock().await;
    let pool = pool_guard.as_ref().ok_or_else(|| CommandError {
        message: "Database not initialized".to_string(),
    })?;

    repository::create_conversation(pool, CreateConversationInput { title })
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_rename_conversation(
    pool: State<'_, DbPool>,
    id: String,
    title: String,
) -> CommandResult<()> {
    let pool_guard = pool.lock().await;
    let pool = pool_guard.as_ref().ok_or_else(|| CommandError {
        message: "Database not initialized".to_string(),
    })?;

    repository::rename_conversation(pool, &id, &title)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_delete_conversation_by_id(
    pool: State<'_, DbPool>,
    id: String,
) -> CommandResult<()> {
    let pool_guard = pool.lock().await;
    let pool = pool_guard.as_ref().ok_or_else(|| CommandError {
        message: "Database not initialized".to_string(),
    })?;

    repository::delete_conversation(pool, &id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_toggle_pin_conversation(
    pool: State<'_, DbPool>,
    id: String,
) -> CommandResult<bool> {
    let pool_guard = pool.lock().await;
    let pool = pool_guard.as_ref().ok_or_else(|| CommandError {
        message: "Database not initialized".to_string(),
    })?;

    repository::toggle_pin_conversation(pool, &id)
        .await
        .map_err(Into::into)
}

// ============ MESSAGES ============

#[tauri::command]
pub async fn db_list_messages(
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> CommandResult<Vec<Message>> {
    let pool_guard = pool.lock().await;
    let pool = pool_guard.as_ref().ok_or_else(|| CommandError {
        message: "Database not initialized".to_string(),
    })?;

    repository::list_messages(pool, &conversation_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_create_message(
    pool: State<'_, DbPool>,
    conversation_id: String,
    role: String,
    content: String,
    token_count: Option<i32>,
) -> CommandResult<Message> {
    let pool_guard = pool.lock().await;
    let pool = pool_guard.as_ref().ok_or_else(|| CommandError {
        message: "Database not initialized".to_string(),
    })?;

    repository::create_message(
        pool,
        CreateMessageInput {
            conversation_id,
            role,
            content,
            token_count,
        },
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn db_update_message(
    pool: State<'_, DbPool>,
    id: String,
    content: String,
    token_count: Option<i32>,
) -> CommandResult<()> {
    let pool_guard = pool.lock().await;
    let pool = pool_guard.as_ref().ok_or_else(|| CommandError {
        message: "Database not initialized".to_string(),
    })?;

    repository::update_message_content(pool, &id, &content, token_count)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_delete_messages_after(
    pool: State<'_, DbPool>,
    conversation_id: String,
    after_message_id: String,
) -> CommandResult<()> {
    let pool_guard = pool.lock().await;
    let pool = pool_guard.as_ref().ok_or_else(|| CommandError {
        message: "Database not initialized".to_string(),
    })?;

    repository::delete_messages_after(pool, &conversation_id, &after_message_id)
        .await
        .map_err(CommandError::from)
}

// ============ PROVIDER CONFIGS ============

#[tauri::command]
pub async fn db_list_provider_configs(
    pool: State<'_, DbPool>,
) -> CommandResult<Vec<ProviderConfig>> {
    let pool_guard = pool.lock().await;
    let pool = pool_guard.as_ref().ok_or_else(|| CommandError {
        message: "Database not initialized".to_string(),
    })?;

    let mut configs = repository::list_provider_configs(pool)
        .await
        .map_err(CommandError::from)?;

    for config in configs.iter_mut() {
        match secrets::get_api_key(&config.id) {
            Ok(api_key) => config.api_key = api_key,
            Err(e) => eprintln!("Failed to read key for {}: {}", config.id, e),
        }
    }

    Ok(configs)
}

#[tauri::command]
pub async fn db_get_provider_config(
    pool: State<'_, DbPool>,
    id: String,
) -> CommandResult<Option<ProviderConfig>> {
    let pool_guard = pool.lock().await;
    let pool = pool_guard.as_ref().ok_or_else(|| CommandError {
        message: "Database not initialized".to_string(),
    })?;

    let mut config = repository::get_provider_config(pool, &id)
        .await
        .map_err(CommandError::from)?;

    if let Some(ref mut cfg) = config {
        match secrets::get_api_key(&cfg.id) {
            Ok(api_key) => cfg.api_key = api_key,
            Err(e) => eprintln!("Failed to read key for {}: {}", cfg.id, e),
        }
    }

    Ok(config)
}

#[tauri::command]
pub async fn db_update_provider_config(
    pool: State<'_, DbPool>,
    id: String,
    name: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    is_enabled: Option<bool>,
) -> CommandResult<()> {
    let pool_guard = pool.lock().await;
    let pool = pool_guard.as_ref().ok_or_else(|| CommandError {
        message: "Database not initialized".to_string(),
    })?;

    let provider_id = id.clone();
    let api_key_for_store = api_key.clone();

    repository::update_provider_config(
        pool,
        UpdateProviderConfigInput {
            id,
            name,
            base_url,
            api_key,
            is_enabled,
        },
    )
    .await
    .map_err(CommandError::from)?;

    if let Some(key) = api_key_for_store {
        if key.trim().is_empty() {
            secrets::delete_api_key(&provider_id).ok();
        } else {
            secrets::set_api_key(&provider_id, &key)
                .map_err(|e| CommandError { message: e.to_string() })?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn db_create_provider_config(
    pool: State<'_, DbPool>,
    name: String,
    provider_type: String,
    base_url: String,
    api_key: Option<String>,
    is_local: bool,
) -> CommandResult<ProviderConfig> {
    let pool_guard = pool.lock().await;
    let pool = pool_guard.as_ref().ok_or_else(|| CommandError {
        message: "Database not initialized".to_string(),
    })?;

    let created = repository::create_provider_config(
        pool,
        &name,
        &provider_type,
        &base_url,
        api_key.as_deref(),
        is_local,
    )
    .await
    .map_err(CommandError::from)?;

    if let Some(key) = api_key {
        if !key.trim().is_empty() {
            secrets::set_api_key(&created.id, &key)
                .map_err(|e| CommandError { message: e.to_string() })?;
        }
    }

    Ok(created)
}

#[tauri::command]
pub async fn db_delete_provider_config(
    pool: State<'_, DbPool>,
    id: String,
) -> CommandResult<()> {
    let pool_guard = pool.lock().await;
    let pool = pool_guard.as_ref().ok_or_else(|| CommandError {
        message: "Database not initialized".to_string(),
    })?;

    repository::delete_provider_config(pool, &id)
        .await
        .map_err(Into::into)
}

// ============ AI MODELS ============

#[tauri::command]
pub async fn db_list_provider_models(
    pool: State<'_, DbPool>,
    provider_id: String,
) -> CommandResult<Vec<AiModel>> {
    let pool_guard = pool.lock().await;
    let pool = pool_guard.as_ref().ok_or_else(|| CommandError {
        message: "Database not initialized".to_string(),
    })?;

    repository::list_models_by_provider(pool, &provider_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_upsert_provider_models(
    pool: State<'_, DbPool>,
    provider_id: String,
    models: Vec<ProviderModelInput>,
) -> CommandResult<Vec<AiModel>> {
    let pool_guard = pool.lock().await;
    let pool = pool_guard.as_ref().ok_or_else(|| CommandError {
        message: "Database not initialized".to_string(),
    })?;

    repository::upsert_provider_models(pool, &provider_id, &models)
        .await
        .map_err(CommandError::from)?;

    repository::list_models_by_provider(pool, &provider_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_register_manual_model(
    pool: State<'_, DbPool>,
    provider_id: String,
    model_id: String,
    name: String,
) -> CommandResult<Vec<AiModel>> {
    let pool_guard = pool.lock().await;
    let pool = pool_guard.as_ref().ok_or_else(|| CommandError {
        message: "Database not initialized".to_string(),
    })?;

    repository::register_manual_model(pool, &provider_id, &model_id, &name)
        .await
        .map_err(CommandError::from)?;

    repository::list_models_by_provider(pool, &provider_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_set_provider_model_enabled(
    pool: State<'_, DbPool>,
    provider_id: String,
    model_id: String,
    enabled: bool,
) -> CommandResult<()> {
    let pool_guard = pool.lock().await;
    let pool = pool_guard.as_ref().ok_or_else(|| CommandError {
        message: "Database not initialized".to_string(),
    })?;

    repository::set_model_enabled(pool, &provider_id, &model_id, enabled)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_set_all_provider_models_enabled(
    pool: State<'_, DbPool>,
    provider_id: String,
    enabled: bool,
) -> CommandResult<()> {
    let pool_guard = pool.lock().await;
    let pool = pool_guard.as_ref().ok_or_else(|| CommandError {
        message: "Database not initialized".to_string(),
    })?;

    repository::set_all_models_enabled(pool, &provider_id, enabled)
        .await
        .map_err(Into::into)
}

// ============ PROVIDER SETTINGS ============

#[tauri::command]
pub async fn db_get_provider_settings(
    pool: State<'_, DbPool>,
    provider_id: String,
) -> CommandResult<ProviderSettings> {
    let pool_guard = pool.lock().await;
    let pool = pool_guard.as_ref().ok_or_else(|| CommandError {
        message: "Database not initialized".to_string(),
    })?;

    repository::get_provider_settings(pool, &provider_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_update_provider_settings(
    pool: State<'_, DbPool>,
    provider_id: String,
    filter_free_models: bool,
) -> CommandResult<()> {
    let pool_guard = pool.lock().await;
    let pool = pool_guard.as_ref().ok_or_else(|| CommandError {
        message: "Database not initialized".to_string(),
    })?;

    repository::update_provider_settings(pool, &provider_id, filter_free_models)
        .await
        .map_err(Into::into)
}

// ============ GIT METADATA ============

#[tauri::command]
pub async fn db_upsert_git_repository(
    pool: State<'_, DbPool>,
    input: CreateGitRepositoryInput,
) -> CommandResult<GitRepositoryRecord> {
    let pool_guard = pool.lock().await;
    let pool = pool_guard.as_ref().ok_or_else(|| CommandError {
        message: "Database not initialized".to_string(),
    })?;

    repository::upsert_git_repository(pool, input)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_upsert_git_worktree(
    pool: State<'_, DbPool>,
    input: CreateGitWorktreeInput,
) -> CommandResult<GitWorktreeRecord> {
    let pool_guard = pool.lock().await;
    let pool = pool_guard.as_ref().ok_or_else(|| CommandError {
        message: "Database not initialized".to_string(),
    })?;

    repository::upsert_git_worktree(pool, input)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_list_git_worktrees(
    pool: State<'_, DbPool>,
    project_id: String,
) -> CommandResult<Vec<GitWorktreeRecord>> {
    let pool_guard = pool.lock().await;
    let pool = pool_guard.as_ref().ok_or_else(|| CommandError {
        message: "Database not initialized".to_string(),
    })?;

    repository::list_git_worktrees_by_project(pool, &project_id)
        .await
        .map_err(Into::into)
}
