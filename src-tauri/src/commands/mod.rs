pub mod ai;
mod external_apps;
pub mod fs;
pub mod git;
pub mod mcp;
pub mod repository_instructions;
pub mod skills;
pub mod speech;
pub mod terminal;
pub mod tool_invocations;
pub mod web_search;
pub mod workspace;
pub mod workspace_tools;

pub use crate::core::command_error::CommandError;
pub(crate) use crate::core::command_error::{command_error, CommandResult};
pub use crate::core::db_state::{DbInitializationState, DbPool};
pub use crate::core::workspace_execution::{
    execute_workspace_tool, execute_workspace_tool_controlled,
    execute_workspace_tool_controlled_with_options, validate_workspace_tool_execution,
    WorkspaceProjectMount, WorkspaceToolExecutionOptions,
};
#[doc(hidden)]
pub use external_apps::{__cmd__list_external_apps, __cmd__open_external_target};
pub use external_apps::{
    list_external_apps, open_external_target, ExternalAppCatalogDto, ExternalAppOptionDto,
};

use crate::config::{
    ConfigChangeSource, ConfigDocumentKind, ConfigManager, ConfigPatchRequest, ConfigScope,
    JsonPatchOperation,
};
use crate::core::tool_policy::{
    get_mode_policy, validate_tool_execution, ToolModePolicyResult, ToolValidationResult,
};
use crate::db::{models::*, repository};
use crate::dev_overrides::DevProviderOverridesFile;
use crate::git::GitState;
use crate::secrets;
use crate::{WorkspaceMetadataRoot, WorkspaceRoot};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use tauri::State;
static PROVIDER_MUTATION_LOCKS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn provider_mutation_lock(provider_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    PROVIDER_MUTATION_LOCKS
        .lock()
        .expect("provider mutation lock registry")
        .entry(provider_id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[derive(ts_rs::TS)]
pub struct DbInitializationStatusDto {
    pub status: String,
    pub message: Option<String>,
}

pub(crate) async fn get_pool(pool: &State<'_, DbPool>) -> CommandResult<SqlitePool> {
    pool.wait_until_ready().await
}

#[tauri::command]
pub async fn db_get_initialization_status(
    pool: State<'_, DbPool>,
) -> CommandResult<DbInitializationStatusDto> {
    let (status, message) = match pool.current() {
        DbInitializationState::Initializing => ("initializing", None),
        DbInitializationState::Ready(_) => ("ready", None),
        DbInitializationState::Failed(message) => ("failed", Some(message)),
    };
    Ok(DbInitializationStatusDto {
        status: status.to_string(),
        message,
    })
}

#[tauri::command]
pub async fn db_retry_initialize(
    app: tauri::AppHandle,
    pool: State<'_, DbPool>,
) -> CommandResult<DbInitializationStatusDto> {
    if matches!(pool.current(), DbInitializationState::Ready(_)) {
        return db_get_initialization_status(pool).await;
    }

    pool.set_initializing();
    match crate::db::init_db(&app).await {
        Ok(sqlite_pool) => {
            if let Err(error) = crate::ai::chatgpt::recover_auth_mutations(&sqlite_pool).await {
                pool.set_failed(error.clone());
                return Err(command_error(format!(
                    "Database authentication recovery failed: {error}"
                )));
            }
            pool.set_ready(sqlite_pool);
        }
        Err(error) => {
            let message = error.to_string();
            pool.set_failed(message.clone());
            return Err(command_error(format!(
                "Database initialization failed: {message}"
            )));
        }
    }

    Ok(DbInitializationStatusDto {
        status: "ready".to_string(),
        message: None,
    })
}

#[tauri::command]
pub async fn tool_get_mode_policy(mode: String) -> CommandResult<ToolModePolicyResult> {
    Ok(get_mode_policy(&mode))
}

#[tauri::command]
pub async fn tool_validate_execution(
    mode: String,
    tool_id: String,
    path: Option<String>,
) -> CommandResult<ToolValidationResult> {
    Ok(validate_tool_execution(&mode, &tool_id, path.as_deref()))
}

#[tauri::command]
pub async fn ai_get_dev_provider_overrides(
    workspace_metadata_root: State<'_, WorkspaceMetadataRoot>,
) -> CommandResult<Option<DevProviderOverridesFile>> {
    if !tauri::is_dev() {
        return Ok(None);
    }

    let workspace_root = workspace_metadata_root.0.read().await.clone();
    Ok(crate::dev_overrides::load_dev_provider_overrides_from_workspace(&workspace_root))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn tool_execute_workspace(
    workspace_root: State<'_, WorkspaceRoot>,
    workspace_metadata_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    mode: String,
    tool_id: String,
    args: Value,
    workspace_path: Option<String>,
    workspace_scope: Option<String>,
    project_mounts: Option<Vec<WorkspaceProjectMount>>,
    virtual_root_enabled: Option<bool>,
    focused_project_id: Option<String>,
    execution_id: Option<String>,
) -> CommandResult<String> {
    let workspace = workspace_root.inner().read().await.clone();
    let metadata_workspace = workspace_metadata_root.inner().0.read().await.clone();
    let git_state = git_state.inner().clone();
    execute_workspace_tool_controlled(
        workspace,
        metadata_workspace,
        git_state,
        mode,
        tool_id,
        args,
        workspace_path,
        workspace_scope,
        project_mounts,
        virtual_root_enabled,
        focused_project_id,
        execution_id,
    )
    .await
}
#[tauri::command]
pub fn tool_cancel_workspace(execution_id: String) -> bool {
    crate::core::workspace_execution::tool_cancel_workspace(execution_id)
}

// ============ CONVERSATIONS ============

#[tauri::command]
pub async fn db_list_conversations(pool: State<'_, DbPool>) -> CommandResult<Vec<Conversation>> {
    let pool = get_pool(&pool).await?;

    repository::list_conversations(&pool)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_get_chat_snapshot(pool: State<'_, DbPool>) -> CommandResult<ChatSnapshot> {
    let pool = get_pool(&pool).await?;

    repository::get_chat_snapshot(&pool)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_get_chat_bootstrap_snapshot(
    pool: State<'_, DbPool>,
    preload_conversation_ids: Option<Vec<String>>,
) -> CommandResult<ChatBootstrapSnapshot> {
    let pool = get_pool(&pool).await?;

    repository::get_chat_bootstrap_snapshot(
        &pool,
        preload_conversation_ids.as_deref().unwrap_or(&[]),
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn db_get_conversation(
    pool: State<'_, DbPool>,
    id: String,
) -> CommandResult<Option<Conversation>> {
    let pool = get_pool(&pool).await?;

    repository::get_conversation(&pool, &id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_create_conversation(
    pool: State<'_, DbPool>,
    title: Option<String>,
    scope_mode: String,
    task_id: Option<String>,
    group_id: Option<String>,
    project_id: Option<String>,
    provider_id: Option<String>,
    model_id: Option<String>,
    reasoning_effort: Option<String>,
) -> CommandResult<Conversation> {
    let pool = get_pool(&pool).await?;

    repository::create_conversation(
        &pool,
        CreateConversationInput {
            title,
            scope_mode,
            task_id,
            group_id,
            project_id,
            provider_id,
            model_id,
            reasoning_effort,
        },
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn db_update_conversation_ai_selection(
    pool: State<'_, DbPool>,
    id: String,
    provider_id: Option<String>,
    model_id: Option<String>,
    reasoning_effort: Option<String>,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::update_conversation_ai_selection(
        &pool,
        &id,
        provider_id.as_deref(),
        model_id.as_deref(),
        reasoning_effort.as_deref(),
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn db_rename_conversation(
    pool: State<'_, DbPool>,
    id: String,
    title: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::rename_conversation(&pool, &id, &title)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_update_conversation_details(
    pool: State<'_, DbPool>,
    id: String,
    title: Option<String>,
    description: Option<String>,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::update_conversation_details(&pool, &id, title.as_deref(), description.as_deref())
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_update_conversation_scope(
    pool: State<'_, DbPool>,
    id: String,
    scope_mode: String,
    task_id: Option<String>,
    group_id: Option<String>,
    project_id: Option<String>,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::update_conversation_scope(
        &pool,
        &id,
        &scope_mode,
        task_id.as_deref(),
        group_id.as_deref(),
        project_id.as_deref(),
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn db_delete_conversation_by_id(
    pool: State<'_, DbPool>,
    id: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::delete_conversation(&pool, &id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_delete_conversations_by_ids(
    pool: State<'_, DbPool>,
    ids: Vec<String>,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::delete_conversations(&pool, &ids)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_toggle_pin_conversation(
    pool: State<'_, DbPool>,
    id: String,
) -> CommandResult<bool> {
    let pool = get_pool(&pool).await?;

    repository::toggle_pin_conversation(&pool, &id)
        .await
        .map_err(Into::into)
}

// ============ MESSAGES ============

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(ts_rs::TS)]
pub struct DbCreateMessageParams {
    id: Option<String>,
    conversation_id: String,
    turn_id: Option<String>,
    role: String,
    content: String,
    token_count: Option<i32>,
    tool_traces_json: Option<String>,
    hidden_context: Option<String>,
    provider_input_items_json: Option<String>,
    provider_turn_state_json: Option<String>,
    context_refs_json: Option<String>,
    completion_reason: Option<String>,
}

#[tauri::command]
pub async fn db_list_messages(
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> CommandResult<Vec<Message>> {
    let pool = get_pool(&pool).await?;

    repository::list_messages(&pool, &conversation_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_search_messages(
    pool: State<'_, DbPool>,
    query: String,
    conversation_ids: Vec<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> CommandResult<MessageSearchPage> {
    let pool = get_pool(&pool).await?;
    repository::search_messages(
        &pool,
        &query,
        &conversation_ids,
        limit.unwrap_or(25),
        offset.unwrap_or(0),
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn db_create_message(
    pool: State<'_, DbPool>,
    params: DbCreateMessageParams,
) -> CommandResult<Message> {
    let pool = get_pool(&pool).await?;

    repository::create_message(
        &pool,
        CreateMessageInput {
            id: params.id,
            conversation_id: params.conversation_id,
            turn_id: params.turn_id,
            role: params.role,
            content: params.content,
            token_count: params.token_count,
            tool_traces_json: params.tool_traces_json,
            hidden_context: params.hidden_context,
            provider_input_items_json: params.provider_input_items_json,
            provider_turn_state_json: params.provider_turn_state_json,
            context_refs_json: params.context_refs_json,
            completion_reason: params.completion_reason,
            generation_attempts_json: None,
        },
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn db_import_messages(
    pool: State<'_, DbPool>,
    conversation_id: String,
    messages: Vec<ImportMessageInput>,
) -> CommandResult<Vec<Message>> {
    let pool = get_pool(&pool).await?;

    repository::import_messages(&pool, &conversation_id, messages)
        .await
        .map_err(Into::into)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(ts_rs::TS)]
pub struct DbUpdateMessageParams {
    id: String,
    turn_id: Option<String>,
    content: String,
    token_count: Option<i32>,
    tool_traces_json: Option<String>,
    hidden_context: Option<String>,
    provider_input_items_json: Option<String>,
    provider_turn_state_json: Option<String>,
    context_refs_json: Option<String>,
    completion_reason: Option<String>,
    generation_attempts_json: Option<String>,
}

#[tauri::command]
pub async fn db_update_message(
    pool: State<'_, DbPool>,
    params: DbUpdateMessageParams,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::update_message_content(
        &pool,
        repository::UpdateMessageContentInput {
            id: &params.id,
            turn_id: params.turn_id,
            content: &params.content,
            token_count: params.token_count,
            tool_traces_json: params.tool_traces_json,
            hidden_context: params.hidden_context,
            provider_input_items_json: params.provider_input_items_json,
            provider_turn_state_json: params.provider_turn_state_json,
            context_refs_json: params.context_refs_json,
            completion_reason: params.completion_reason,
            generation_attempts_json: params.generation_attempts_json,
        },
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn db_delete_messages_after(
    pool: State<'_, DbPool>,
    conversation_id: String,
    after_message_id: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::delete_messages_after(&pool, &conversation_id, &after_message_id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_delete_conversation_turn(
    pool: State<'_, DbPool>,
    conversation_id: String,
    turn_id: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::delete_conversation_turn(&pool, &conversation_id, &turn_id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_trim_conversation_replay(
    pool: State<'_, DbPool>,
    conversation_id: String,
    after_message_id: String,
    code_checkpoints_json: Option<String>,
    delete_context_compaction_state: bool,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;
    repository::trim_conversation_replay(
        &pool,
        &conversation_id,
        &after_message_id,
        code_checkpoints_json.as_deref(),
        delete_context_compaction_state,
    )
    .await
    .map_err(CommandError::from)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(ts_rs::TS)]
pub struct DbPrepareConversationReplayParams {
    conversation_id: String,
    message_id: String,
    session_id: String,
    turn_id: String,
    replay_id: String,
    content: String,
    hidden_context: Option<String>,
    provider_input_items_json: Option<String>,
    code_checkpoints_json: Option<String>,
    delete_context_compaction_state: bool,
}

#[tauri::command]
pub async fn db_prepare_conversation_replay(
    pool: State<'_, DbPool>,
    params: DbPrepareConversationReplayParams,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;
    repository::prepare_conversation_replay(
        &pool,
        repository::PrepareConversationReplayInput {
            conversation_id: &params.conversation_id,
            message_id: &params.message_id,
            session_id: &params.session_id,
            turn_id: &params.turn_id,
            replay_id: &params.replay_id,
            content: &params.content,
            hidden_context: params.hidden_context,
            provider_input_items_json: params.provider_input_items_json,
            code_checkpoints_json: params.code_checkpoints_json,
            delete_context_compaction_state: params.delete_context_compaction_state,
        },
    )
    .await
    .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_restore_conversation_replay(
    pool: State<'_, DbPool>,
    conversation_id: String,
    replay_id: String,
    session_id: String,
    turn_id: String,
) -> CommandResult<bool> {
    let pool = get_pool(&pool).await?;
    repository::restore_conversation_replay(
        &pool,
        &conversation_id,
        &replay_id,
        Some(&session_id),
        Some(&turn_id),
    )
    .await
    .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_complete_conversation_replay(
    pool: State<'_, DbPool>,
    conversation_id: String,
    replay_id: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;
    repository::complete_conversation_replay(&pool, &conversation_id, &replay_id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_mark_conversation_replay_launched(
    pool: State<'_, DbPool>,
    conversation_id: String,
    replay_id: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;
    repository::mark_conversation_replay_launched(&pool, &conversation_id, &replay_id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_finalize_conversation_replay(
    pool: State<'_, DbPool>,
    conversation_id: String,
    replay_id: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;
    repository::finalize_conversation_replay(&pool, &conversation_id, &replay_id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_list_conversation_citations(
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> CommandResult<Vec<ConversationCitation>> {
    let pool = get_pool(&pool).await?;

    repository::list_conversation_citations(&pool, &conversation_id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_get_conversation_citation_content(
    pool: State<'_, DbPool>,
    id: String,
) -> CommandResult<Option<String>> {
    let pool = get_pool(&pool).await?;

    repository::get_conversation_citation_content(&pool, &id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_upsert_conversation_citation(
    pool: State<'_, DbPool>,
    input: UpsertConversationCitationInput,
) -> CommandResult<ConversationCitation> {
    let pool = get_pool(&pool).await?;

    repository::upsert_conversation_citation(&pool, input)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_delete_conversation_citation(
    pool: State<'_, DbPool>,
    id: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::delete_conversation_citation(&pool, &id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_delete_conversation_citations(
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::delete_conversation_citations(&pool, &conversation_id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_get_conversation_toolbox_state(
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> CommandResult<Option<ConversationToolboxStateRecord>> {
    let pool = get_pool(&pool).await?;

    repository::get_conversation_toolbox_state(&pool, &conversation_id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_upsert_conversation_toolbox_state(
    pool: State<'_, DbPool>,
    input: UpsertConversationToolboxStateInput,
) -> CommandResult<ConversationToolboxStateRecord> {
    let pool = get_pool(&pool).await?;

    repository::upsert_conversation_toolbox_state(&pool, input)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_delete_conversation_toolbox_state(
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::delete_conversation_toolbox_state(&pool, &conversation_id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_get_architect_plan_conversation_sync(
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> CommandResult<Option<ArchitectPlanConversationSyncRecord>> {
    let pool = get_pool(&pool).await?;

    repository::get_architect_plan_conversation_sync(&pool, &conversation_id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_get_architect_plan_conversation_sync_for_plan(
    pool: State<'_, DbPool>,
    plan_id: String,
    target_branch: String,
) -> CommandResult<Option<ArchitectPlanConversationSyncRecord>> {
    let pool = get_pool(&pool).await?;

    repository::get_architect_plan_conversation_sync_for_plan(&pool, &plan_id, &target_branch)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_upsert_architect_plan_conversation_sync(
    pool: State<'_, DbPool>,
    input: UpsertArchitectPlanConversationSyncInput,
) -> CommandResult<ArchitectPlanConversationSyncRecord> {
    let pool = get_pool(&pool).await?;

    repository::upsert_architect_plan_conversation_sync(&pool, input)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_delete_architect_plan_conversation_sync(
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::delete_architect_plan_conversation_sync(&pool, &conversation_id)
        .await
        .map_err(CommandError::from)
}

// ============ PROVIDER CONFIGS ============

fn provider_is_enabled(
    configured_enabled: bool,
    provider_type: &str,
    has_api_key: bool,
    auth_status: Option<&str>,
) -> bool {
    configured_enabled
        || has_api_key
        || match provider_type {
            "chatgpt" => matches!(
                auth_status,
                Some("authenticated" | "refreshing" | "expired")
            ),
            "copilot" => auth_status == Some("connected"),
            _ => false,
        }
}

async fn configured_provider_configs(
    manager: &ConfigManager,
    pool: &SqlitePool,
) -> CommandResult<Vec<ProviderConfig>> {
    let document = manager
        .effective_user_document(ConfigDocumentKind::Providers)
        .await;
    let definitions = document
        .get("providers")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            command_error("providers.json ne contient pas de registre providers valide.")
        })?;
    let legacy_status = repository::list_provider_configs(pool)
        .await
        .map_err(CommandError::from)?
        .into_iter()
        .map(|provider| (provider.id.clone(), provider))
        .collect::<HashMap<_, _>>();
    let now = chrono::Utc::now().to_rfc3339();
    let mut providers = Vec::with_capacity(definitions.len());
    for (id, definition) in definitions {
        if definition
            .get("deleted")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        let status = legacy_status.get(id);
        let provider_type = definition
            .get("providerType")
            .and_then(Value::as_str)
            .unwrap_or("openai")
            .to_string();
        let has_stored_api_key = secrets::get_api_key(id)
            .map_err(|error| command_error(format!("Failed to inspect provider secret: {error}")))?
            .is_some();
        let is_local = definition
            .get("isLocal")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let auth_status = status.and_then(|value| value.auth_status.clone());
        let is_enabled = provider_is_enabled(
            definition
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            &provider_type,
            has_stored_api_key,
            auth_status.as_deref(),
        );
        providers.push(ProviderConfig {
            id: id.clone(),
            name: definition
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(id)
                .to_string(),
            provider_type,
            base_url: definition
                .get("baseUrl")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            api_key: None,
            has_stored_api_key,
            is_enabled,
            is_local,
            auth_status,
            auth_source: status.and_then(|value| value.auth_source.clone()),
            plan_type: status.and_then(|value| value.plan_type.clone()),
            account_label: status.and_then(|value| value.account_label.clone()),
            token_expires_at: status.and_then(|value| value.token_expires_at.clone()),
            created_at: status
                .map(|value| value.created_at.clone())
                .unwrap_or_else(|| now.clone()),
            updated_at: status
                .map(|value| value.updated_at.clone())
                .unwrap_or_else(|| now.clone()),
        });
    }
    Ok(providers)
}

fn provider_definition_patch_operations(
    document: &Value,
    provider_id: &str,
    definition: Option<Value>,
) -> Option<Vec<JsonPatchOperation>> {
    let escaped = provider_id.replace('~', "~0").replace('/', "~1");
    let provider_path = format!("/providers/{escaped}");
    let current_exists = document.pointer(&provider_path).is_some();
    let Some(value) = definition else {
        return current_exists.then(|| {
            vec![JsonPatchOperation {
                op: "remove".to_string(),
                path: provider_path,
                from: None,
                value: None,
            }]
        });
    };

    let mut operations = Vec::with_capacity(2);
    if document
        .get("providers")
        .and_then(Value::as_object)
        .is_none()
    {
        operations.push(JsonPatchOperation {
            op: "add".to_string(),
            path: "/providers".to_string(),
            from: None,
            value: Some(serde_json::json!({})),
        });
    }
    operations.push(JsonPatchOperation {
        op: "add".to_string(),
        path: provider_path,
        from: None,
        value: Some(value),
    });
    Some(operations)
}

async fn patch_provider_definition(
    manager: &ConfigManager,
    provider_id: &str,
    definition: Option<Value>,
) -> CommandResult<()> {
    let document = manager
        .get_document(ConfigDocumentKind::Providers, ConfigScope::User)
        .await
        .map_err(|error| command_error(error.message))?;
    let Some(patch) =
        provider_definition_patch_operations(&document.value, provider_id, definition)
    else {
        return Ok(());
    };
    manager
        .apply_patch(ConfigPatchRequest {
            kind: ConfigDocumentKind::Providers,
            scope: ConfigScope::User,
            expected_etag: document.etag,
            patch,
            source: ConfigChangeSource::UserInterface,
        })
        .await
        .map_err(|error| command_error(error.message))?;
    Ok(())
}

fn restore_deleted_provider_secrets(
    provider_id: &str,
    api_key: Option<&str>,
    chatgpt_secret: Option<&secrets::ChatGptSecret>,
) {
    if let Some(api_key) = api_key {
        if let Err(error) = secrets::set_api_key(provider_id, api_key) {
            tracing::error!(
                "Failed to restore API key for provider {provider_id} after failed deletion: {error}"
            );
        }
    }
    if let Some(chatgpt_secret) = chatgpt_secret {
        if let Err(error) = secrets::set_chatgpt_secret(provider_id, chatgpt_secret) {
            tracing::error!(
                "Failed to restore ChatGPT session for provider {provider_id} after failed deletion: {error}"
            );
        }
    }
}

async fn patch_provider_document_top_level(
    manager: &ConfigManager,
    key: &str,
    value: Value,
) -> CommandResult<()> {
    let document = manager
        .get_document(ConfigDocumentKind::Providers, ConfigScope::User)
        .await
        .map_err(|error| command_error(error.message))?;
    manager
        .apply_patch(ConfigPatchRequest {
            kind: ConfigDocumentKind::Providers,
            scope: ConfigScope::User,
            expected_etag: document.etag,
            patch: vec![JsonPatchOperation {
                op: "add".to_string(),
                path: format!("/{}", key.replace('~', "~0").replace('/', "~1")),
                from: None,
                value: Some(value),
            }],
            source: ConfigChangeSource::UserInterface,
        })
        .await
        .map_err(|error| command_error(error.message))?;
    Ok(())
}

async fn configured_provider_models(
    manager: &ConfigManager,
    pool: &SqlitePool,
    provider_id: &str,
) -> CommandResult<Vec<AiModel>> {
    let provider = repository::get_provider_config(pool, provider_id)
        .await
        .map_err(CommandError::from)?;
    let stored_models = if provider
        .as_ref()
        .is_some_and(|provider| provider.provider_type == "chatgpt")
    {
        crate::ai::chatgpt::available_models(pool, provider_id)
            .await
            .map_err(command_error)?
    } else {
        repository::list_models_by_provider(pool, provider_id)
            .await
            .map_err(CommandError::from)?
    };
    let mut models = stored_models
        .into_iter()
        .filter(|model| !model.is_manual)
        .collect::<Vec<_>>();
    let document = manager
        .effective_user_document(ConfigDocumentKind::Providers)
        .await;
    let now = chrono::Utc::now().to_rfc3339();
    if let Some(manual_models) = document.get("manualModels").and_then(Value::as_object) {
        for (stable_id, definition) in manual_models {
            if definition.get("providerId").and_then(Value::as_str) != Some(provider_id) {
                continue;
            }
            let Some(model_id) = definition.get("modelId").and_then(Value::as_str) else {
                continue;
            };
            models.push(AiModel {
                id: format!("config:{stable_id}"),
                provider_id: provider_id.to_string(),
                model_id: model_id.to_string(),
                name: definition
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or(model_id)
                    .to_string(),
                description: None,
                owned_by: None,
                pricing_prompt: None,
                pricing_completion: None,
                pricing_request: None,
                reasoning_efforts: definition
                    .get("reasoningEfforts")
                    .and_then(Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .map(str::to_string)
                            .collect::<Vec<_>>()
                    })
                    .filter(|values| !values.is_empty()),
                default_reasoning_effort: definition
                    .get("defaultReasoningEffort")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
                context_window_tokens: definition
                    .get("contextWindow")
                    .and_then(Value::as_i64)
                    .and_then(|value| i32::try_from(value).ok()),
                input_limit_tokens: None,
                output_limit_tokens: None,
                context_window_source: definition
                    .get("contextWindow")
                    .is_some()
                    .then(|| "user_override".to_string()),
                context_limits_updated_at: None,
                is_enabled: definition
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                is_manual: true,
                first_seen_at: now.clone(),
                last_seen_at: now.clone(),
            });
        }
    }
    if let Some(overrides) = document.get("modelOverrides").and_then(Value::as_object) {
        for model in &mut models {
            let composite = format!("{provider_id}/{}", model.model_id);
            let Some(overlay) = overrides
                .get(&composite)
                .or_else(|| overrides.get(&model.model_id))
            else {
                continue;
            };
            if let Some(name) = overlay.get("displayName").and_then(Value::as_str) {
                model.name = name.to_string();
            }
            if let Some(enabled) = overlay.get("enabled").and_then(Value::as_bool) {
                model.is_enabled = enabled;
            }
            if let Some(tokens) = overlay
                .get("contextWindow")
                .and_then(Value::as_i64)
                .and_then(|value| i32::try_from(value).ok())
            {
                model.context_window_tokens = Some(tokens);
                model.context_window_source = Some("user_override".to_string());
            }
        }
    }
    models.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(models)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(ts_rs::TS)]
pub struct ManualModelReasoningInput {
    reasoning_efforts: Vec<String>,
    default_reasoning_effort: Option<String>,
}

fn normalize_manual_model_reasoning(
    reasoning: Option<ManualModelReasoningInput>,
) -> CommandResult<Option<(Vec<String>, Option<String>)>> {
    let Some(reasoning) = reasoning else {
        return Ok(None);
    };
    let mut efforts = Vec::new();
    for effort in reasoning.reasoning_efforts {
        let effort = effort.trim().to_string();
        if !effort.is_empty() && !efforts.contains(&effort) {
            efforts.push(effort);
        }
    }
    if efforts.is_empty() {
        return Err(command_error(
            "Reasoning efforts cannot be empty when reasoning is configurable.",
        ));
    }
    let default_effort = reasoning
        .default_reasoning_effort
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(default_effort) = &default_effort {
        if !efforts.contains(default_effort) {
            return Err(command_error(
                "Default reasoning effort must be included in reasoning efforts.",
            ));
        }
    }
    Ok(Some((efforts, default_effort)))
}

#[tauri::command]
pub async fn db_list_provider_configs(
    pool: State<'_, DbPool>,
    workspace_metadata_root: State<'_, WorkspaceMetadataRoot>,
    config_manager: State<'_, ConfigManager>,
) -> CommandResult<Vec<ProviderConfig>> {
    let pool = get_pool(&pool).await?;
    if tauri::is_dev() {
        let workspace_root = workspace_metadata_root.0.read().await.clone();
        crate::dev_overrides::sync_declared_dev_providers_from_workspace(&pool, &workspace_root)
            .await
            .map_err(CommandError::from)?;
    }

    let mut configs = configured_provider_configs(config_manager.inner(), &pool).await?;

    for config in configs.iter_mut() {
        reconcile_provider_secret_metadata(&pool, config).await?;
    }

    Ok(configs)
}

async fn reconcile_provider_secret_metadata(
    pool: &SqlitePool,
    config: &mut ProviderConfig,
) -> CommandResult<()> {
    if config.provider_type == "chatgpt" {
        let has_secret = secrets::get_chatgpt_secret(&config.id)
            .map_err(|error| CommandError {
                message: format!(
                    "Failed to access local ChatGPT session for {}: {}",
                    config.id, error
                ),
            })?
            .is_some();
        let linked = matches!(
            config.auth_status.as_deref(),
            Some("authenticated" | "refreshing" | "expired")
        );

        if linked && !has_secret {
            repository::update_provider_auth_metadata(
                pool,
                &config.id,
                &ProviderAuthMetadata {
                    auth_status: Some("unauthenticated".to_string()),
                    auth_source: None,
                    plan_type: None,
                    account_label: None,
                    token_expires_at: None,
                },
            )
            .await
            .map_err(CommandError::from)?;
            config.auth_status = Some("unauthenticated".to_string());
            config.auth_source = None;
            config.plan_type = None;
            config.account_label = None;
            config.token_expires_at = None;
        }
        return Ok(());
    }

    if config.provider_type != "copilot" && !config.is_local && config.has_stored_api_key {
        let has_key = secrets::get_api_key(&config.id)
            .map_err(|error| CommandError {
                message: format!(
                    "Failed to access local provider API key for {}: {}",
                    config.id, error
                ),
            })?
            .is_some();
        if !has_key {
            repository::set_provider_has_stored_api_key(pool, &config.id, false)
                .await
                .map_err(CommandError::from)?;
            config.has_stored_api_key = false;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn db_get_provider_config(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    id: String,
) -> CommandResult<Option<ProviderConfig>> {
    let pool = get_pool(&pool).await?;
    Ok(configured_provider_configs(config_manager.inner(), &pool)
        .await?
        .into_iter()
        .find(|provider| provider.id == id))
}

#[tauri::command]
pub async fn db_reveal_provider_api_key(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    id: String,
) -> CommandResult<Option<String>> {
    let pool = get_pool(&pool).await?;
    let config = configured_provider_configs(config_manager.inner(), &pool)
        .await?
        .into_iter()
        .find(|provider| provider.id == id);

    if config.is_none() {
        return Err(CommandError {
            message: format!("Provider {} not found", id),
        });
    }

    let api_key = secrets::get_api_key(&id).map_err(|error| CommandError {
        message: format!(
            "Failed to access the local provider secret for {}: {}",
            id, error
        ),
    })?;

    Ok(api_key)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(ts_rs::TS)]
pub struct DbUpdateProviderConfigParams {
    id: String,
    name: Option<String>,
    provider_type: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    is_local: Option<bool>,
    is_enabled: Option<bool>,
}

fn validate_ai_provider_fields(
    name: &str,
    provider_type: &str,
    base_url: &str,
    is_local: bool,
) -> CommandResult<()> {
    if name.trim().is_empty() {
        return Err(command_error("Provider name is required."));
    }
    if provider_type.trim().is_empty() {
        return Err(command_error("Provider type is required."));
    }

    let provider_type = provider_type.trim();
    let linked_provider = matches!(provider_type, "chatgpt" | "copilot");
    if base_url.trim().is_empty() {
        return if linked_provider {
            Ok(())
        } else {
            Err(command_error("Provider base URL is required."))
        };
    }

    if provider_type == "copilot" {
        return if base_url.trim() == "copilot://cli" {
            Ok(())
        } else {
            Err(command_error(
                "Copilot provider base URL must use the internal copilot://cli endpoint.",
            ))
        };
    }

    let parsed = reqwest::Url::parse(base_url.trim())
        .map_err(|_| command_error("Provider base URL must be a valid URL."))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(command_error("Provider base URL must use HTTP or HTTPS."));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(command_error(
            "Provider base URLs must not contain credentials.",
        ));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(command_error(
            "Provider base URLs must not contain a query or fragment.",
        ));
    }
    if !is_local && parsed.scheme() != "https" {
        return Err(command_error("Remote provider base URLs must use HTTPS."));
    }

    Ok(())
}

#[tauri::command]
pub async fn db_update_provider_config(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    params: DbUpdateProviderConfigParams,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;
    if params.id == crate::ai::macro_ai::PROVIDER_ID {
        return Err(CommandError {
            message: "Macro AI is managed automatically and cannot be edited.".to_string(),
        });
    }

    let provider_id = params.id.clone();
    let lock = provider_mutation_lock(&provider_id);
    let _guard = lock.lock().await;
    let previous_config = configured_provider_configs(config_manager.inner(), &pool)
        .await?
        .into_iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| command_error(format!("Provider {} not found", provider_id)))?;
    let previous_api_key = if params.api_key.is_some() {
        secrets::get_api_key(&provider_id).map_err(|error| {
            command_error(format!(
                "Failed to read the local provider secret for {}: {}",
                provider_id, error
            ))
        })?
    } else {
        None
    };
    let provider_type = params
        .provider_type
        .as_deref()
        .unwrap_or(&previous_config.provider_type)
        .trim()
        .to_string();
    let is_local = params.is_local.unwrap_or(previous_config.is_local);
    let name = params
        .name
        .as_deref()
        .unwrap_or(&previous_config.name)
        .trim()
        .to_string();
    let base_url = params
        .base_url
        .as_deref()
        .unwrap_or(&previous_config.base_url)
        .trim()
        .to_string();
    validate_ai_provider_fields(&name, &provider_type, &base_url, is_local)?;

    if let Some(api_key) = params.api_key.as_deref() {
        if api_key.trim().is_empty() {
            secrets::delete_api_key(&provider_id)
        } else {
            secrets::set_api_key(&provider_id, api_key.trim())
        }
        .map_err(|error| command_error(format!("Failed to update provider secret: {error}")))?;
    }

    let has_api_key = params
        .api_key
        .as_deref()
        .map(|key| !key.trim().is_empty())
        .unwrap_or(previous_config.has_stored_api_key);
    let is_enabled = if provider_type == "chatgpt" || provider_type == "copilot" {
        params.is_enabled.unwrap_or(previous_config.is_enabled)
    } else {
        is_local || has_api_key
    };

    let definition = serde_json::json!({
        "providerType": provider_type,
        "name": name,
        "enabled": is_enabled,
        "baseUrl": base_url,
        "isLocal": is_local,
    });
    if let Err(error) =
        patch_provider_definition(config_manager.inner(), &provider_id, Some(definition)).await
    {
        if params.api_key.is_some() {
            let _ = match previous_api_key {
                Some(previous) => secrets::set_api_key(&provider_id, &previous),
                None => secrets::delete_api_key(&provider_id),
            };
        }
        return Err(error);
    }

    Ok(())
}

#[tauri::command]
pub async fn db_create_provider_config(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    name: String,
    provider_type: String,
    base_url: String,
    api_key: Option<String>,
    is_local: bool,
) -> CommandResult<ProviderConfig> {
    let pool = get_pool(&pool).await?;
    validate_ai_provider_fields(&name, &provider_type, &base_url, is_local)?;
    let name = name.trim().to_string();
    let provider_type = provider_type.trim().to_string();
    let base_url = base_url.trim().to_string();
    let id = format!("provider-{}", uuid::Uuid::new_v4().simple());
    let has_api_key = api_key.as_deref().is_some_and(|key| !key.trim().is_empty());
    let definition = serde_json::json!({
        "providerType": provider_type,
        "name": name,
        "enabled": is_local || has_api_key,
        "baseUrl": base_url,
        "isLocal": is_local,
    });
    patch_provider_definition(config_manager.inner(), &id, Some(definition)).await?;
    if let Some(key) = api_key.as_deref().filter(|key| !key.trim().is_empty()) {
        if let Err(error) = secrets::set_api_key(&id, key.trim()) {
            let _ = patch_provider_definition(config_manager.inner(), &id, None).await;
            return Err(command_error(format!(
                "Failed to persist provider secret: {error}"
            )));
        }
    }
    configured_provider_configs(config_manager.inner(), &pool)
        .await?
        .into_iter()
        .find(|provider| provider.id == id)
        .ok_or_else(|| command_error("Le fournisseur créé est introuvable dans providers.json."))
}

#[tauri::command]
pub async fn db_delete_provider_config(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    id: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;
    if id == crate::ai::macro_ai::PROVIDER_ID {
        return Err(CommandError {
            message: "Macro AI is managed automatically and cannot be deleted.".to_string(),
        });
    }

    let lock = provider_mutation_lock(&id);
    let _guard = lock.lock().await;
    let provider = configured_provider_configs(config_manager.inner(), &pool)
        .await?
        .into_iter()
        .find(|provider| provider.id == id)
        .ok_or_else(|| command_error(format!("Provider {} not found", id)))?;
    let _chatgpt_auth_guard = if provider.provider_type == "chatgpt" {
        Some(
            crate::ai::chatgpt::lock_auth_mutation(&id)
                .await
                .map_err(command_error)?,
        )
    } else {
        None
    };
    let escaped = id.replace('~', "~0").replace('/', "~1");
    let previous_api_key = secrets::get_api_key(&id)
        .map_err(|error| command_error(format!("Failed to read provider secret: {error}")))?;
    let previous_chatgpt_secret = secrets::get_chatgpt_secret(&id).map_err(|error| {
        command_error(format!("Failed to read provider ChatGPT session: {error}"))
    })?;
    if let Err(error) = secrets::delete_api_key(&id) {
        return Err(command_error(format!(
            "Failed to delete provider secret: {error}"
        )));
    }
    if let Err(error) = secrets::delete_provider_secret(&id) {
        restore_deleted_provider_secrets(
            &id,
            previous_api_key.as_deref(),
            previous_chatgpt_secret.as_ref(),
        );
        return Err(command_error(format!(
            "Failed to delete provider ChatGPT session: {error}"
        )));
    }
    let is_builtin = crate::config::default_document(ConfigDocumentKind::Providers)
        .pointer(&format!("/providers/{escaped}"))
        .is_some();
    let definition = is_builtin.then(|| serde_json::json!({ "deleted": true }));
    if let Err(error) = patch_provider_definition(config_manager.inner(), &id, definition).await {
        restore_deleted_provider_secrets(
            &id,
            previous_api_key.as_deref(),
            previous_chatgpt_secret.as_ref(),
        );
        return Err(error);
    }
    Ok(())
}

// ============ AI MODELS ============

#[tauri::command]
pub async fn db_list_provider_models(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    provider_id: String,
) -> CommandResult<Vec<AiModel>> {
    let pool = get_pool(&pool).await?;
    configured_provider_models(config_manager.inner(), &pool, &provider_id).await
}

#[tauri::command]
pub async fn db_upsert_provider_models(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    provider_id: String,
    models: Vec<ProviderModelInput>,
    replace_discovered: Option<bool>,
) -> CommandResult<Vec<AiModel>> {
    let pool = get_pool(&pool).await?;

    let document = config_manager
        .effective_user_document(ConfigDocumentKind::Providers)
        .await;
    let mut overrides = document
        .get("modelOverrides")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut overrides_changed = false;
    for model in &models {
        let key = format!("{provider_id}/{}", model.model_id);
        let mut overlay = overrides
            .remove(&key)
            .unwrap_or_else(|| serde_json::json!({}));
        if model.context_window_source.as_deref() == Some("user_override") {
            if let Some(tokens) = model.context_window_tokens {
                overlay["contextWindow"] = Value::from(tokens);
                overrides_changed = true;
            }
        } else if overlay.get("contextWindow").is_some() {
            overlay
                .as_object_mut()
                .map(|object| object.remove("contextWindow"));
            overrides_changed = true;
        }
        if overlay.as_object().is_some_and(|object| !object.is_empty()) {
            overrides.insert(key, overlay);
        }
    }
    if overrides_changed {
        patch_provider_document_top_level(
            config_manager.inner(),
            "modelOverrides",
            Value::Object(overrides),
        )
        .await?;
    }

    if replace_discovered.unwrap_or(false) {
        repository::replace_discovered_provider_models(&pool, &provider_id, &models)
            .await
            .map_err(CommandError::from)?;
    } else if repository::get_provider_config(&pool, &provider_id)
        .await
        .map_err(CommandError::from)?
        .is_some_and(|provider| provider.provider_type == "chatgpt")
    {
        crate::ai::chatgpt::persist_model_enrichments(&pool, &provider_id, &models)
            .await
            .map_err(command_error)?;
    } else {
        repository::upsert_provider_models(&pool, &provider_id, &models)
            .await
            .map_err(CommandError::from)?;
    }

    configured_provider_models(config_manager.inner(), &pool, &provider_id).await
}

#[tauri::command]
pub async fn db_get_conversation_compaction_state(
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> CommandResult<Option<ConversationCompactionStateRecord>> {
    let pool = get_pool(&pool).await?;

    repository::get_conversation_compaction_state(&pool, &conversation_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_upsert_conversation_compaction_state(
    pool: State<'_, DbPool>,
    input: UpsertConversationCompactionStateInput,
) -> CommandResult<ConversationCompactionStateRecord> {
    let pool = get_pool(&pool).await?;

    repository::upsert_conversation_compaction_state(&pool, input)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_insert_conversation_compaction_event(
    pool: State<'_, DbPool>,
    input: InsertConversationCompactionEventInput,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::insert_conversation_compaction_event(&pool, input)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_delete_conversation_compaction_state(
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::delete_conversation_compaction_state(&pool, &conversation_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_register_manual_model(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    provider_id: String,
    model_id: String,
    name: String,
    reasoning: Option<ManualModelReasoningInput>,
) -> CommandResult<Vec<AiModel>> {
    let pool = get_pool(&pool).await?;
    let reasoning = normalize_manual_model_reasoning(reasoning)?;

    let document = config_manager
        .effective_user_document(ConfigDocumentKind::Providers)
        .await;
    let mut manual_models = document
        .get("manualModels")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if manual_models.values().any(|definition| {
        definition.get("providerId").and_then(Value::as_str) == Some(provider_id.as_str())
            && definition.get("modelId").and_then(Value::as_str) == Some(model_id.as_str())
    }) {
        return Err(command_error(format!(
            "Model {model_id} already exists for provider {provider_id}."
        )));
    }
    let stable_id = format!("{}:{}", provider_id, uuid::Uuid::new_v4().simple());
    let mut definition = serde_json::json!({
        "providerId": provider_id,
        "modelId": model_id,
        "displayName": name,
        "enabled": true
    });
    if let Some((efforts, default_effort)) = reasoning {
        definition["reasoningEfforts"] = serde_json::json!(efforts);
        definition["defaultReasoningEffort"] = serde_json::json!(default_effort);
    }
    manual_models.insert(stable_id, definition);
    patch_provider_document_top_level(
        config_manager.inner(),
        "manualModels",
        Value::Object(manual_models),
    )
    .await?;
    configured_provider_models(config_manager.inner(), &pool, &provider_id).await
}

#[tauri::command]
pub async fn db_update_manual_model(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    provider_id: String,
    current_model_id: String,
    next_model_id: String,
    name: String,
    reasoning: Option<ManualModelReasoningInput>,
) -> CommandResult<Vec<AiModel>> {
    let pool = get_pool(&pool).await?;
    let reasoning = normalize_manual_model_reasoning(reasoning)?;

    let document = config_manager
        .effective_user_document(ConfigDocumentKind::Providers)
        .await;
    let mut manual_models = document
        .get("manualModels")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let target = manual_models.iter().find_map(|(id, definition)| {
        (definition.get("providerId").and_then(Value::as_str) == Some(provider_id.as_str())
            && definition.get("modelId").and_then(Value::as_str) == Some(current_model_id.as_str()))
        .then(|| id.clone())
    });
    let target = target.ok_or_else(|| command_error("Manual model not found"))?;
    if manual_models.iter().any(|(id, definition)| {
        id != &target
            && definition.get("providerId").and_then(Value::as_str) == Some(provider_id.as_str())
            && definition.get("modelId").and_then(Value::as_str) == Some(next_model_id.as_str())
    }) {
        return Err(command_error(format!(
            "Model {next_model_id} already exists for provider {provider_id}."
        )));
    }
    let enabled = manual_models[&target]
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let mut definition = serde_json::json!({
        "providerId": provider_id,
        "modelId": next_model_id,
        "displayName": name,
        "enabled": enabled
    });
    if let Some((efforts, default_effort)) = reasoning {
        definition["reasoningEfforts"] = serde_json::json!(efforts);
        definition["defaultReasoningEffort"] = serde_json::json!(default_effort);
    }
    manual_models.insert(target, definition);
    patch_provider_document_top_level(
        config_manager.inner(),
        "manualModels",
        Value::Object(manual_models),
    )
    .await?;
    configured_provider_models(config_manager.inner(), &pool, &provider_id).await
}

#[tauri::command]
pub async fn db_delete_manual_model(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    provider_id: String,
    model_id: String,
) -> CommandResult<Vec<AiModel>> {
    let pool = get_pool(&pool).await?;

    let document = config_manager
        .effective_user_document(ConfigDocumentKind::Providers)
        .await;
    let mut manual_models = document
        .get("manualModels")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    manual_models.retain(|_, definition| {
        definition.get("providerId").and_then(Value::as_str) != Some(provider_id.as_str())
            || definition.get("modelId").and_then(Value::as_str) != Some(model_id.as_str())
    });
    patch_provider_document_top_level(
        config_manager.inner(),
        "manualModels",
        Value::Object(manual_models),
    )
    .await?;
    configured_provider_models(config_manager.inner(), &pool, &provider_id).await
}

#[tauri::command]
pub async fn db_set_provider_model_enabled(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    provider_id: String,
    model_id: String,
    enabled: bool,
) -> CommandResult<()> {
    let _pool = get_pool(&pool).await?;
    let document = config_manager
        .effective_user_document(ConfigDocumentKind::Providers)
        .await;
    let mut manual_models = document
        .get("manualModels")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some((stable_id, mut definition)) = manual_models.iter().find_map(|(id, definition)| {
        (definition.get("providerId").and_then(Value::as_str) == Some(provider_id.as_str())
            && definition.get("modelId").and_then(Value::as_str) == Some(model_id.as_str()))
        .then(|| (id.clone(), definition.clone()))
    }) {
        definition["enabled"] = Value::Bool(enabled);
        manual_models.insert(stable_id, definition);
        return patch_provider_document_top_level(
            config_manager.inner(),
            "manualModels",
            Value::Object(manual_models),
        )
        .await;
    }

    let mut overrides = document
        .get("modelOverrides")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let key = format!("{provider_id}/{model_id}");
    let mut overlay = overrides
        .remove(&key)
        .unwrap_or_else(|| serde_json::json!({}));
    overlay["enabled"] = Value::Bool(enabled);
    overrides.insert(key, overlay);
    patch_provider_document_top_level(
        config_manager.inner(),
        "modelOverrides",
        Value::Object(overrides),
    )
    .await
}

#[tauri::command]
pub async fn db_set_all_provider_models_enabled(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    provider_id: String,
    enabled: bool,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;
    let models = configured_provider_models(config_manager.inner(), &pool, &provider_id).await?;
    let document = config_manager
        .effective_user_document(ConfigDocumentKind::Providers)
        .await;
    let mut manual_models = document
        .get("manualModels")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for definition in manual_models.values_mut() {
        if definition.get("providerId").and_then(Value::as_str) == Some(provider_id.as_str()) {
            definition["enabled"] = Value::Bool(enabled);
        }
    }
    let mut overrides = document
        .get("modelOverrides")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for model in models.into_iter().filter(|model| !model.is_manual) {
        let key = format!("{provider_id}/{}", model.model_id);
        let mut overlay = overrides
            .remove(&key)
            .unwrap_or_else(|| serde_json::json!({}));
        overlay["enabled"] = Value::Bool(enabled);
        overrides.insert(key, overlay);
    }
    patch_provider_document_top_level(
        config_manager.inner(),
        "manualModels",
        Value::Object(manual_models),
    )
    .await?;
    patch_provider_document_top_level(
        config_manager.inner(),
        "modelOverrides",
        Value::Object(overrides),
    )
    .await
}

// ============ PROVIDER SETTINGS ============

#[tauri::command]
pub async fn db_get_provider_settings(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    provider_id: String,
) -> CommandResult<ProviderSettings> {
    let _pool = get_pool(&pool).await?;
    let document = config_manager
        .effective_user_document(ConfigDocumentKind::Providers)
        .await;
    let definition = document
        .pointer(&format!(
            "/providers/{}",
            provider_id.replace('~', "~0").replace('/', "~1")
        ))
        .ok_or_else(|| command_error(format!("Provider {provider_id} not found")))?;
    Ok(ProviderSettings {
        provider_id,
        filter_free_models: definition
            .pointer("/options/filterFreeModels")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        copilot_send_timeout_ms: definition
            .pointer("/options/copilotSendTimeoutMs")
            .and_then(Value::as_i64),
    })
}

#[tauri::command]
pub async fn db_update_provider_settings(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    provider_id: String,
    filter_free_models: Option<bool>,
    copilot_send_timeout_ms: Option<Option<i64>>,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;
    let current = configured_provider_configs(config_manager.inner(), &pool)
        .await?
        .into_iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| command_error(format!("Provider {provider_id} not found")))?;
    let document = config_manager
        .effective_user_document(ConfigDocumentKind::Providers)
        .await;
    let escaped = provider_id.replace('~', "~0").replace('/', "~1");
    let mut options = document
        .pointer(&format!("/providers/{escaped}/options"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(value) = filter_free_models {
        options.insert("filterFreeModels".to_string(), Value::Bool(value));
    }
    if let Some(value) = copilot_send_timeout_ms {
        match value {
            Some(timeout) => {
                options.insert("copilotSendTimeoutMs".to_string(), Value::from(timeout));
            }
            None => {
                options.remove("copilotSendTimeoutMs");
            }
        }
    }
    patch_provider_definition(
        config_manager.inner(),
        &provider_id,
        Some(serde_json::json!({
            "providerType": current.provider_type,
            "name": current.name,
            "enabled": current.is_enabled,
            "baseUrl": current.base_url,
            "isLocal": current.is_local,
            "options": options
        })),
    )
    .await
}

#[tauri::command]
pub async fn db_get_setting(pool: State<'_, DbPool>, key: String) -> CommandResult<Option<String>> {
    let pool = get_pool(&pool).await?;

    let result = sqlx::query_scalar::<_, String>(
        r#"
        SELECT value
        FROM settings
        WHERE key = ?
        "#,
    )
    .bind(&key)
    .fetch_optional(&pool)
    .await
    .map_err(|error| command_error(error.to_string()))?;

    Ok(result)
}

#[tauri::command]
pub async fn db_set_setting(
    pool: State<'_, DbPool>,
    key: String,
    value: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    sqlx::query(
        r#"
        INSERT INTO settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        "#,
    )
    .bind(&key)
    .bind(&value)
    .execute(&pool)
    .await
    .map_err(|error| command_error(error.to_string()))?;

    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn configured_chatgpt_catalog_requires_provenance_and_keeps_manual_preferences() {
        let _store_guard = secrets::lock_test_store();
        let temp = tempfile::tempdir().unwrap();
        secrets::init(temp.path()).unwrap();
        let pool = crate::db::create_pool(&temp.path().join("macro.db"))
            .await
            .unwrap();
        repository::upsert_provider_config_by_id(
            &pool,
            "chatgpt",
            "ChatGPT",
            "chatgpt",
            "https://chat.invalid",
            false,
        )
        .await
        .unwrap();
        sqlx::query("UPDATE provider_configs SET auth_status = 'authenticated', plan_type = 'plus' WHERE id = 'chatgpt'").execute(&pool).await.unwrap();
        secrets::set_chatgpt_secret(
            "chatgpt",
            &secrets::ChatGptSecret {
                access_token: "synthetic-access".into(),
                refresh_token: "synthetic-refresh".into(),
                access_token_expires_at: None,
                account_id: Some("synthetic-account".into()),
                auth_source: "browser".into(),
            },
        )
        .unwrap();
        sqlx::query("INSERT INTO ai_models (id, provider_id, model_id, name, is_manual, first_seen_at, last_seen_at) VALUES ('discovered', 'chatgpt', 'catalog-model', 'Catalog', 0, 'original', 'original')").execute(&pool).await.unwrap();
        let manager = ConfigManager::initialize(temp.path().join("config"))
            .await
            .unwrap();
        patch_provider_document_top_level(&manager, "manualModels", serde_json::json!({
            "synthetic-manual": {"providerId": "chatgpt", "modelId": "manual-model", "displayName": "Manual", "enabled": true}
        })).await.unwrap();
        patch_provider_document_top_level(
            &manager,
            "modelOverrides",
            serde_json::json!({
                "chatgpt/catalog-model": {"enabled": false, "contextWindow": 12345}
            }),
        )
        .await
        .unwrap();
        let key = "chatgpt.verified_models.v1:chatgpt";
        let current = serde_json::json!({
            "account_id": "synthetic-account", "base_url": "https://chat.invalid", "plan_type": "plus",
            "collected_at": chrono::Utc::now(), "model_ids": ["catalog-model"]
        });
        let mut expired = current.clone();
        expired["collected_at"] =
            serde_json::json!(chrono::Utc::now() - chrono::Duration::hours(25));
        let mut foreign = current.clone();
        foreign["account_id"] = serde_json::json!("other-synthetic-account");
        for invalid in [None, Some(expired), Some(foreign)] {
            if let Some(value) = invalid {
                repository::set_app_setting(&pool, key, &value.to_string())
                    .await
                    .unwrap();
            }
            let available = configured_provider_models(&manager, &pool, "chatgpt")
                .await
                .unwrap();
            assert_eq!(available.len(), 1);
            assert_eq!(available[0].model_id, "manual-model");
            assert!(available[0].is_manual && available[0].is_enabled);
            assert_eq!(
                repository::list_models_by_provider(&pool, "chatgpt")
                    .await
                    .unwrap()
                    .len(),
                1
            );
        }
        repository::set_app_setting(&pool, key, &current.to_string())
            .await
            .unwrap();
        let available = configured_provider_models(&manager, &pool, "chatgpt")
            .await
            .unwrap();
        assert_eq!(available.len(), 2);
        let discovered = available
            .iter()
            .find(|model| model.model_id == "catalog-model")
            .unwrap();
        assert!(!discovered.is_enabled);
        assert_eq!(discovered.context_window_tokens, Some(12345));
    }

    #[test]
    fn ai_provider_validation_rejects_empty_and_unsafe_endpoints() {
        assert!(
            validate_ai_provider_fields("", "openai", "https://api.example.test", false).is_err()
        );
        assert!(validate_ai_provider_fields("Example", "openai", "", false).is_err());
        assert!(
            validate_ai_provider_fields("Example", "openai", "ftp://example.test", false).is_err()
        );
        assert!(
            validate_ai_provider_fields("Example", "openai", "http://example.test", false).is_err()
        );
        assert!(validate_ai_provider_fields(
            "Example",
            "openai",
            "https://user:secret@example.test",
            false
        )
        .is_err());
        assert!(validate_ai_provider_fields(
            "Example",
            "openai",
            "https://example.test?v=1",
            false
        )
        .is_err());
    }

    #[test]
    fn ai_provider_validation_accepts_remote_local_and_linked_providers() {
        assert!(validate_ai_provider_fields(
            "Example",
            "openai",
            "https://api.example.test/v1",
            false
        )
        .is_ok());
        assert!(validate_ai_provider_fields(
            "Local",
            "openai-compatible",
            "http://127.0.0.1:11434/v1",
            true
        )
        .is_ok());
        assert!(validate_ai_provider_fields("ChatGPT", "chatgpt", "", false).is_ok());
        assert!(
            validate_ai_provider_fields("GitHub Copilot", "copilot", "copilot://cli", false)
                .is_ok()
        );
        assert!(
            validate_ai_provider_fields("GitHub Copilot", "copilot", "copilot://other", false)
                .is_err()
        );
    }

    #[tokio::test]
    async fn db_pool_propagates_failure_without_polling() {
        let pool = DbPool::default();
        pool.set_failed("migration failed");

        let error = pool.wait_until_ready().await.expect_err("failed state");
        assert!(error.message.contains("migration failed"));
    }

    #[tokio::test]
    async fn db_pool_wakes_waiters_when_initialization_becomes_ready() {
        let pool = DbPool::default();
        let ready_pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("db pool");
        let state = pool.clone();
        let expected_pool = ready_pool.clone();
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            state.set_ready(ready_pool);
        });

        let resolved = pool.wait_until_ready().await.expect("ready state");
        assert_eq!(resolved.size(), expected_pool.size());
    }

    #[test]
    fn provider_definition_patch_initializes_a_sparse_provider_registry() {
        let document = json!({
            "$schema": "./schemas/v1/providers.schema.json",
            "schemaVersion": 1
        });
        let operations = provider_definition_patch_operations(
            &document,
            "opencode-go",
            Some(json!({
                "providerType": "openai",
                "name": "OpenCode Go",
                "enabled": true
            })),
        )
        .expect("provider definition patch");
        assert_eq!(operations.len(), 2);
        assert_eq!(operations[0].path, "/providers");
        assert_eq!(operations[1].path, "/providers/opencode-go");

        let patch: json_patch::Patch = serde_json::from_value(
            serde_json::to_value(&operations).expect("serialize provider patch"),
        )
        .expect("parse provider patch");
        let mut proposed = document;
        json_patch::patch(&mut proposed, &patch).expect("apply provider patch");
        assert_eq!(
            proposed
                .pointer("/providers/opencode-go/providerType")
                .and_then(Value::as_str),
            Some("openai")
        );
    }

    #[test]
    fn provider_activation_follows_credentials_without_a_manual_switch() {
        assert!(provider_is_enabled(false, "openai", true, None));
        assert!(provider_is_enabled(true, "ollama", false, None));
        assert!(provider_is_enabled(
            false,
            "chatgpt",
            false,
            Some("authenticated")
        ));
        assert!(!provider_is_enabled(false, "openai", false, None));
    }

    #[test]
    fn provider_definition_patch_removes_only_an_existing_definition() {
        let document = json!({
            "schemaVersion": 1,
            "providers": {
                "opencode-go": { "providerType": "openai" },
                "openai": { "providerType": "openai" }
            }
        });
        let operations = provider_definition_patch_operations(&document, "opencode-go", None)
            .expect("provider removal patch");
        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0].op, "remove");
        assert_eq!(operations[0].path, "/providers/opencode-go");

        let sparse = json!({ "schemaVersion": 1 });
        assert!(provider_definition_patch_operations(&sparse, "opencode-go", None).is_none());
    }

    #[test]
    fn provider_secret_compensation_restores_api_key_and_chatgpt_session() {
        let _guard = crate::secrets::lock_test_store();
        let temp = tempfile::tempdir().expect("tempdir");
        crate::secrets::init(temp.path()).expect("initialize secret store");
        let provider_id = format!("provider-{}", uuid::Uuid::new_v4());
        let chatgpt_secret = crate::secrets::ChatGptSecret {
            access_token: "access-token".to_string(),
            refresh_token: "refresh-token".to_string(),
            access_token_expires_at: Some("2026-08-22T12:00:00Z".to_string()),
            account_id: Some("account".to_string()),
            auth_source: "oauth".to_string(),
        };

        crate::secrets::set_api_key(&provider_id, "api-key").expect("set API key");
        crate::secrets::set_chatgpt_secret(&provider_id, &chatgpt_secret)
            .expect("set ChatGPT session");
        crate::secrets::delete_api_key(&provider_id).expect("delete API key");
        crate::secrets::delete_provider_secret(&provider_id).expect("delete ChatGPT session");

        restore_deleted_provider_secrets(&provider_id, Some("api-key"), Some(&chatgpt_secret));

        assert_eq!(
            crate::secrets::get_api_key(&provider_id)
                .expect("get restored API key")
                .as_deref(),
            Some("api-key")
        );
        assert_eq!(
            crate::secrets::get_chatgpt_secret(&provider_id).expect("get restored ChatGPT session"),
            Some(chatgpt_secret)
        );
    }
}

// ============ APP STATE SETTINGS ============

#[tauri::command]
pub async fn db_get_app_setting(
    pool: State<'_, DbPool>,
    key: String,
) -> CommandResult<Option<AppSettingRecord>> {
    let pool = get_pool(&pool).await?;

    repository::get_app_setting(&pool, &key)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_set_app_setting(
    pool: State<'_, DbPool>,
    key: String,
    value_json: String,
) -> CommandResult<AppSettingRecord> {
    let pool = get_pool(&pool).await?;

    repository::set_app_setting(&pool, &key, &value_json)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_delete_app_setting(pool: State<'_, DbPool>, key: String) -> CommandResult<bool> {
    let pool = get_pool(&pool).await?;
    repository::delete_app_setting(&pool, &key)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_compare_and_swap_app_setting(
    pool: State<'_, DbPool>,
    key: String,
    expected_value_json: Option<String>,
    value_json: String,
) -> CommandResult<CompareAndSwapAppSettingResult> {
    let pool = get_pool(&pool).await?;

    repository::compare_and_swap_app_setting(
        &pool,
        &key,
        expected_value_json.as_deref(),
        &value_json,
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn db_get_project_context_state(
    pool: State<'_, DbPool>,
    project_id: String,
) -> CommandResult<Option<ProjectContextStateRecord>> {
    let pool = get_pool(&pool).await?;

    repository::get_project_context_state(&pool, &project_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_upsert_project_context_state(
    pool: State<'_, DbPool>,
    input: UpsertProjectContextStateInput,
) -> CommandResult<ProjectContextStateRecord> {
    let pool = get_pool(&pool).await?;

    repository::upsert_project_context_state(&pool, input)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_delete_project_context_state(
    pool: State<'_, DbPool>,
    project_id: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::delete_project_context_state(&pool, &project_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_get_session_context_state(
    pool: State<'_, DbPool>,
) -> CommandResult<Option<SessionContextStateRecord>> {
    let pool = get_pool(&pool).await?;

    repository::get_session_context_state(&pool)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_upsert_session_context_state(
    pool: State<'_, DbPool>,
    input: UpsertSessionContextStateInput,
) -> CommandResult<SessionContextStateRecord> {
    let pool = get_pool(&pool).await?;

    repository::upsert_session_context_state(&pool, input)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_reconcile_project_registry(
    pool: State<'_, DbPool>,
    input: ReconcileProjectRegistryInput,
) -> CommandResult<ProjectRegistryDbRepairReport> {
    let pool = get_pool(&pool).await?;

    repository::reconcile_project_registry(&pool, input)
        .await
        .map_err(Into::into)
}

// ============ GIT METADATA ============

#[tauri::command]
pub async fn db_upsert_git_repository(
    pool: State<'_, DbPool>,
    input: CreateGitRepositoryInput,
) -> CommandResult<GitRepositoryRecord> {
    let pool = get_pool(&pool).await?;

    repository::upsert_git_repository(&pool, input)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_upsert_git_worktree(
    pool: State<'_, DbPool>,
    input: CreateGitWorktreeInput,
) -> CommandResult<GitWorktreeRecord> {
    let pool = get_pool(&pool).await?;

    repository::upsert_git_worktree(&pool, input)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_list_git_worktrees(
    pool: State<'_, DbPool>,
    project_id: String,
) -> CommandResult<Vec<GitWorktreeRecord>> {
    let pool = get_pool(&pool).await?;

    repository::list_git_worktrees_by_project(&pool, &project_id)
        .await
        .map_err(Into::into)
}
