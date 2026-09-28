use super::{get_pool, CommandResult, DbPool};
use crate::db::agent_runs;
use crate::db::conversation_goals::{
    self, ActivateConversationGoalInput, ApplyConversationGoalVerdictInput, ConversationGoal,
    ConversationGoalAudit, DeactivateConversationGoalInput, GoalCasOutcome,
    UpdateConversationGoalInput,
};
use crate::db::goal_audit_transitions::{self, RecordGoalAuditTransitionInput};
use crate::db::models::AgentRun;
use tauri::State;

#[tauri::command]
pub async fn db_get_current_conversation_goal(
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> CommandResult<Option<ConversationGoal>> {
    conversation_goals::get_current_goal(&get_pool(&pool).await?, &conversation_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_activate_conversation_goal(
    pool: State<'_, DbPool>,
    input: ActivateConversationGoalInput,
) -> CommandResult<ConversationGoal> {
    conversation_goals::activate_goal(&get_pool(&pool).await?, input)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_update_conversation_goal(
    pool: State<'_, DbPool>,
    input: UpdateConversationGoalInput,
) -> CommandResult<GoalCasOutcome> {
    conversation_goals::update_goal(&get_pool(&pool).await?, input)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_deactivate_conversation_goal(
    pool: State<'_, DbPool>,
    input: DeactivateConversationGoalInput,
) -> CommandResult<GoalCasOutcome> {
    conversation_goals::deactivate_goal(&get_pool(&pool).await?, input)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_get_conversation_goal_audit(
    pool: State<'_, DbPool>,
    audit_id: String,
) -> CommandResult<Option<ConversationGoalAudit>> {
    conversation_goals::get_audit(&get_pool(&pool).await?, &audit_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_list_recoverable_conversation_goal_audits(
    pool: State<'_, DbPool>,
) -> CommandResult<Vec<ConversationGoalAudit>> {
    conversation_goals::list_recoverable_audits(&get_pool(&pool).await?)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_apply_conversation_goal_verdict(
    pool: State<'_, DbPool>,
    input: ApplyConversationGoalVerdictInput,
) -> CommandResult<GoalCasOutcome> {
    conversation_goals::apply_verdict(&get_pool(&pool).await?, input)
        .await
        .map_err(Into::into)
}

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
