use super::{get_pool, CommandResult, DbPool};
use crate::db::agent_runs;
use crate::db::goal_audit_transitions::{self, RecordGoalAuditTransitionInput};
use crate::db::models::AgentRun;
use tauri::State;

#[tauri::command]
pub async fn db_record_goal_audit_transition(
    pool: State<'_, DbPool>,
    input: RecordGoalAuditTransitionInput,
) -> CommandResult<AgentRun> {
    let pool = get_pool(&pool).await?;
    goal_audit_transitions::record_goal_audit_transition(&pool, input)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_link_goal_audit_child_conversation(
    pool: State<'_, DbPool>,
    run_id: String,
    parent_conversation_id: String,
    child_conversation_id: String,
) -> CommandResult<AgentRun> {
    let pool = get_pool(&pool).await?;
    agent_runs::link_goal_audit_child_conversation(
        &pool,
        &run_id,
        &parent_conversation_id,
        &child_conversation_id,
    )
    .await
    .map_err(Into::into)
}
