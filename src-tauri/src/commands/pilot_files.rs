use super::{command_error, get_pool, CommandResult, DbPool};
use crate::db::pilot_files::{self, *};
use tauri::State;

#[tauri::command]
pub async fn pilot_files_authorize(
    pool: State<'_, DbPool>,
    input: PilotFileAuthorizeInput,
) -> CommandResult<()> {
    pilot_files::authorize(&get_pool(&pool).await?, input, &pilot_files::system_now)
        .await
        .map_err(command_error)
}

#[tauri::command]
pub async fn pilot_files_begin(
    pool: State<'_, DbPool>,
    input: PilotFileBeginInput,
) -> CommandResult<PilotFileReceipt> {
    pilot_files::begin(&get_pool(&pool).await?, input, &pilot_files::system_now)
        .await
        .map_err(command_error)
}

#[tauri::command]
pub async fn pilot_files_chunk(
    pool: State<'_, DbPool>,
    input: PilotFileChunkInput,
) -> CommandResult<PilotFileReceipt> {
    pilot_files::chunk(&get_pool(&pool).await?, input, &pilot_files::system_now)
        .await
        .map_err(command_error)
}

#[tauri::command]
pub async fn pilot_files_status(
    pool: State<'_, DbPool>,
    input: PilotFileTransferInput,
) -> CommandResult<PilotFileReceipt> {
    pilot_files::status(&get_pool(&pool).await?, input, &pilot_files::system_now)
        .await
        .map_err(command_error)
}

#[tauri::command]
pub async fn pilot_files_finalize(
    pool: State<'_, DbPool>,
    input: PilotFileTransferInput,
) -> CommandResult<PilotFileReceipt> {
    pilot_files::finalize(&get_pool(&pool).await?, input, &pilot_files::system_now)
        .await
        .map_err(command_error)
}

#[tauri::command]
pub async fn pilot_files_abort(
    pool: State<'_, DbPool>,
    input: PilotFileTransferInput,
) -> CommandResult<PilotFileReceipt> {
    pilot_files::abort(&get_pool(&pool).await?, input, &pilot_files::system_now)
        .await
        .map_err(command_error)
}

#[tauri::command]
pub async fn pilot_files_prepare_send(
    pool: State<'_, DbPool>,
    input: PilotPrepareSendInput,
) -> CommandResult<PilotPreparedSend> {
    pilot_files::prepare_send(&get_pool(&pool).await?, input, &pilot_files::system_now)
        .await
        .map_err(command_error)
}

#[tauri::command]
pub async fn pilot_files_send_read(
    pool: State<'_, DbPool>,
    input: PilotSendReadInput,
) -> CommandResult<PilotSendReceipt> {
    pilot_files::send_read(&get_pool(&pool).await?, input, &pilot_files::system_now)
        .await
        .map_err(command_error)
}

#[tauri::command]
pub async fn pilot_files_send_mark(
    pool: State<'_, DbPool>,
    input: PilotSendMarkInput,
) -> CommandResult<PilotSendReceipt> {
    pilot_files::send_mark(&get_pool(&pool).await?, input, &pilot_files::system_now)
        .await
        .map_err(command_error)
}

#[tauri::command]
pub async fn pilot_files_list(
    pool: State<'_, DbPool>,
    input: PilotFileGuard,
) -> CommandResult<Vec<PilotFileSource>> {
    pilot_files::list(&get_pool(&pool).await?, input, &pilot_files::system_now)
        .await
        .map_err(command_error)
}

#[tauri::command]
pub async fn pilot_files_read(
    pool: State<'_, DbPool>,
    input: PilotFileReadInput,
) -> CommandResult<PilotFileRead> {
    pilot_files::read(&get_pool(&pool).await?, input, &pilot_files::system_now)
        .await
        .map_err(command_error)
}

#[tauri::command]
pub async fn pilot_files_inspect_attachments(
    pool: State<'_, DbPool>,
    input: PilotInspectAttachmentsInput,
) -> CommandResult<Vec<PilotAttachmentMetadata>> {
    pilot_files::inspect_attachments(&get_pool(&pool).await?, input, &pilot_files::system_now)
        .await
        .map_err(command_error)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn db_pilot_message_images(
    pool: State<'_, DbPool>,
    message_id: String,
) -> CommandResult<Vec<PilotFileImage>> {
    pilot_files::message_images(&get_pool(&pool).await?, &message_id)
        .await
        .map_err(command_error)
}
