use super::{command_error, get_pool, CommandResult, DbPool};
use crate::db::conversation_management::{
    self as management, ConversationActionInput, ConversationActionResult, ConversationMetadata,
};
use tauri::State;
#[tauri::command]
pub async fn db_conversation_metadata(
    pool: State<'_, DbPool>,
) -> CommandResult<Vec<ConversationMetadata>> {
    management::metadata(&get_pool(&pool).await?)
        .await
        .map_err(command_error)
}
#[tauri::command(rename_all = "camelCase")]
pub async fn db_conversation_response_version(
    pool: State<'_, DbPool>,
    message_id: String,
    content: String,
    completion_reason: Option<String>,
) -> CommandResult<i64> {
    management::response_version(
        &get_pool(&pool).await?,
        &message_id,
        &content,
        completion_reason.as_deref(),
    )
    .await
    .map_err(command_error)
}
#[tauri::command(rename_all = "camelCase")]
pub async fn db_conversation_acknowledge(
    pool: State<'_, DbPool>,
    conversation_id: String,
    observed: Vec<i64>,
    execute_before: Option<String>,
) -> CommandResult<()> {
    management::acknowledge(
        &get_pool(&pool).await?,
        &conversation_id,
        &observed,
        execute_before.as_deref(),
    )
    .await
    .map_err(command_error)
}
#[tauri::command]
pub async fn db_conversation_action(
    pool: State<'_, DbPool>,
    input: ConversationActionInput,
) -> CommandResult<ConversationActionResult> {
    management::action(&get_pool(&pool).await?, input)
        .await
        .map_err(command_error)
}
#[tauri::command]
pub async fn db_conversation_import_archives(
    pool: State<'_, DbPool>,
    ids: Vec<String>,
) -> CommandResult<()> {
    management::import_archives(&get_pool(&pool).await?, &ids)
        .await
        .map_err(command_error)
}
#[tauri::command(rename_all = "camelCase")]
pub async fn db_list_messages_bounded(
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> CommandResult<Vec<crate::db::models::Message>> {
    let pool = get_pool(&pool).await?;
    crate::db::repository::list_messages_bounded(&pool, &conversation_id)
        .await
        .map_err(|error| match error {
            crate::db::DbError::Validation(code) if code == "resource_limit" => {
                command_error("resource_limit")
            }
            _ => command_error("unavailable"),
        })
}
#[tauri::command(rename_all = "camelCase")]
pub async fn db_get_message(
    pool: State<'_, DbPool>,
    message_id: String,
) -> CommandResult<Option<crate::db::models::Message>> {
    let pool = get_pool(&pool).await?;
    crate::db::repository::get_message(&pool, &message_id)
        .await
        .map_err(|error| match error {
            crate::db::DbError::Validation(code) if code == "resource_limit" => {
                command_error("resource_limit")
            }
            _ => command_error("unavailable"),
        })
}

#[tauri::command]
pub async fn db_conversation_set_archives(
    pool: State<'_, DbPool>,
    ids: Vec<String>,
    archived: bool,
) -> CommandResult<()> {
    management::set_archives(&get_pool(&pool).await?, &ids, archived)
        .await
        .map_err(command_error)
}
