use super::{get_pool, CommandResult, DbPool};
use crate::db::tool_invocations::{
    self, CompleteToolInvocationInput, RecordToolInvocationInput, RecordToolInvocationResult,
    ToolInvocation, ToolInvocationIdentity,
};
use tauri::State;

#[tauri::command]
pub async fn db_record_tool_invocation(
    pool: State<'_, DbPool>,
    input: RecordToolInvocationInput,
) -> CommandResult<RecordToolInvocationResult> {
    let pool = get_pool(&pool).await?;
    tool_invocations::record(&pool, input)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_complete_tool_invocation(
    pool: State<'_, DbPool>,
    input: CompleteToolInvocationInput,
) -> CommandResult<ToolInvocation> {
    let pool = get_pool(&pool).await?;
    tool_invocations::complete(&pool, input)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_mark_tool_invocation_unknown(
    pool: State<'_, DbPool>,
    identity: ToolInvocationIdentity,
) -> CommandResult<ToolInvocation> {
    let pool = get_pool(&pool).await?;
    tool_invocations::mark_unknown(&pool, identity)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_list_unresolved_tool_invocations(
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> CommandResult<Vec<ToolInvocation>> {
    let pool = get_pool(&pool).await?;
    tool_invocations::list_unresolved(&pool, &conversation_id)
        .await
        .map_err(Into::into)
}
