use super::{command_error, get_pool, CommandError, CommandResult, DbPool};
use crate::db::pilot_tools::{self, PilotToolTraceError};
use tauri::State;

fn map_error(error: PilotToolTraceError) -> CommandError {
    command_error(error.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn pilot_tool_traces_list(
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> CommandResult<pilot_tools::PilotToolTraceList> {
    let pool = get_pool(&pool).await?;
    pilot_tools::list_tool_traces(&pool, &conversation_id)
        .await
        .map_err(map_error)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn pilot_tool_trace_read(
    pool: State<'_, DbPool>,
    conversation_id: String,
    message_id: String,
    trace_index: i64,
    expected_revision: i64,
) -> CommandResult<pilot_tools::PilotToolTraceRead> {
    let pool = get_pool(&pool).await?;
    pilot_tools::read_tool_trace(
        &pool,
        &conversation_id,
        &message_id,
        trace_index,
        expected_revision,
    )
    .await
    .map_err(map_error)
}
