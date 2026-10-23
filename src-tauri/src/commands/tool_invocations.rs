use super::{get_pool, CommandResult, DbPool};
use crate::db::chat_admission::{
    runtime::{ChatAdmissionContext, ChatAdmissionRuntime},
    OperationPermit,
};
use crate::db::tool_invocations::{
    self, CompleteToolInvocationInput, RecordToolInvocationInput, RecordToolInvocationResult,
    ToolInvocation, ToolInvocationIdentity,
};
use tauri::{State, WebviewWindow};

async fn admitted_parent(
    pool: &sqlx::SqlitePool,
    runtime: &ChatAdmissionRuntime,
    caller: &str,
    context: Option<&ChatAdmissionContext>,
    conversation: &str,
) -> CommandResult<Option<std::sync::Arc<OperationPermit>>> {
    let global: Option<i64> = sqlx::query_scalar("SELECT CASE WHEN scope_mode='Chat' AND project_id IS NULL AND group_id IS NULL AND task_id IS NULL THEN 1 ELSE 0 END FROM conversations WHERE id=?")
        .bind(conversation).fetch_optional(pool).await.map_err(crate::db::DbError::from)?;
    match (global, context) {
        (Some(1), Some(context)) => Ok(Some(runtime.parent(caller, context, conversation).await?)),
        (Some(0), None) => Ok(None),
        _ => Err(super::command_error("chat_admission_tool_parent_required")),
    }
}

#[tauri::command]
pub async fn db_record_tool_invocation(
    pool: State<'_, DbPool>,
    admission_runtime: State<'_, ChatAdmissionRuntime>,
    window: WebviewWindow,
    context: Option<ChatAdmissionContext>,
    input: RecordToolInvocationInput,
) -> CommandResult<RecordToolInvocationResult> {
    let pool = get_pool(&pool).await?;
    if let Some(parent) = admitted_parent(
        &pool,
        &admission_runtime,
        window.label(),
        context.as_ref(),
        &input.identity.conversation_id,
    )
    .await?
    {
        return parent.record_tool(input).await.map_err(Into::into);
    }
    tool_invocations::record(&pool, input)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_complete_tool_invocation(
    pool: State<'_, DbPool>,
    admission_runtime: State<'_, ChatAdmissionRuntime>,
    window: WebviewWindow,
    context: Option<ChatAdmissionContext>,
    input: CompleteToolInvocationInput,
) -> CommandResult<ToolInvocation> {
    let pool = get_pool(&pool).await?;
    if let Some(parent) = admitted_parent(
        &pool,
        &admission_runtime,
        window.label(),
        context.as_ref(),
        &input.identity.conversation_id,
    )
    .await?
    {
        return parent
            .finish_tool(input.identity, Some(input.receipt_id))
            .await
            .map_err(Into::into);
    }
    tool_invocations::complete(&pool, input)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_mark_tool_invocation_unknown(
    pool: State<'_, DbPool>,
    admission_runtime: State<'_, ChatAdmissionRuntime>,
    window: WebviewWindow,
    context: Option<ChatAdmissionContext>,
    identity: ToolInvocationIdentity,
) -> CommandResult<ToolInvocation> {
    let pool = get_pool(&pool).await?;
    if let Some(parent) = admitted_parent(
        &pool,
        &admission_runtime,
        window.label(),
        context.as_ref(),
        &identity.conversation_id,
    )
    .await?
    {
        return parent.finish_tool(identity, None).await.map_err(Into::into);
    }
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
