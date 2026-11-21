//! Internal bounded conversation reads. Authority remains with the content host.
use super::{command_error, get_pool, CommandResult, DbPool};
use crate::db::{models::*, repository};
use tauri::State;
pub(super) fn error(e: crate::db::DbError) -> super::CommandError {
    match e {
        crate::db::DbError::Validation(code) => command_error(code),
        _ => command_error("unavailable"),
    }
}
#[tauri::command(rename_all = "camelCase")]
pub async fn db_conversation_content_version(
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> CommandResult<ConversationContentToken> {
    repository::conversation_content_version(&get_pool(&pool).await?, &conversation_id)
        .await
        .map_err(error)
}
#[tauri::command]
pub async fn db_conversation_content_metadata(
    pool: State<'_, DbPool>,
    input: ConversationContentMetadataInput,
) -> CommandResult<ConversationContentMetadataPage> {
    repository::conversation_content_metadata(&get_pool(&pool).await?, &input)
        .await
        .map_err(error)
}
#[tauri::command]
pub async fn db_conversation_content_window(
    pool: State<'_, DbPool>,
    input: ConversationContentWindowInput,
) -> CommandResult<ConversationContentWindow> {
    repository::conversation_content_window(&get_pool(&pool).await?, &input)
        .await
        .map_err(error)
}
