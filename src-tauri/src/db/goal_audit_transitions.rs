use super::models::{AgentRun, AgentRunStatus, AgentRunUsageInput, CreateAgentRunInput};
use super::{DbError, DbResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Row, SqlitePool};

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct GoalAuditTransition {
    pub run_id: String,
    pub parent_conversation_id: String,
    pub sequence: i64,
    pub previous_state: Option<AgentRunStatus>,
    pub state: AgentRunStatus,
    pub occurred_at: i64,
    pub snapshot: Value,
    pub result: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct RecordGoalAuditTransitionInput {
    pub descriptor: Option<CreateAgentRunInput>,
    pub transition: GoalAuditTransition,
    pub usage: AgentRunUsageInput,
}

fn invalid(message: impl Into<String>) -> DbError {
    DbError::Validation(message.into())
}

fn result_field<'a>(result: &'a Option<Value>, key: &str) -> Option<&'a Value> {
    result.as_ref().and_then(|value| value.get(key))
}

fn optional_string(result: &Option<Value>, key: &str) -> Option<String> {
    result_field(result, key)
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub async fn record_goal_audit_transition(
    pool: &SqlitePool,
    input: RecordGoalAuditTransitionInput,
) -> DbResult<AgentRun> {
    let transition = &input.transition;
    if transition.run_id.trim().is_empty()
        || transition.parent_conversation_id.trim().is_empty()
        || transition.sequence < 0
    {
        return Err(invalid("Invalid goal audit transition identity"));
    }
    if transition.snapshot.get("runId").and_then(Value::as_str) != Some(transition.run_id.as_str())
        || transition
            .snapshot
            .get("parentConversationId")
            .and_then(Value::as_str)
            != Some(transition.parent_conversation_id.as_str())
        || transition.snapshot.get("state").and_then(Value::as_str)
            != Some(transition.state.as_str())
        || transition.result.as_ref().is_some_and(|result| {
            result.get("runId").and_then(Value::as_str) != Some(transition.run_id.as_str())
                || result.get("parentConversationId").and_then(Value::as_str)
                    != Some(transition.parent_conversation_id.as_str())
        })
    {
        return Err(invalid(
            "Goal audit transition snapshot or result identity mismatch",
        ));
    }
    if [
        input.usage.input_tokens,
        input.usage.output_tokens,
        input.usage.cached_input_tokens,
        input.usage.reasoning_tokens,
        input.usage.total_tokens,
    ]
    .into_iter()
    .flatten()
    .any(|value| value < 0)
    {
        return Err(invalid("Goal audit token usage cannot be negative"));
    }
    if let Some(usage_json) = input.usage.usage_json.as_deref() {
        serde_json::from_str::<Value>(usage_json).map_err(|error| invalid(error.to_string()))?;
    }
    let occurred_at = chrono::DateTime::from_timestamp_millis(transition.occurred_at)
        .ok_or_else(|| invalid("Invalid goal audit transition time"))?
        .to_rfc3339();
    let payload = serde_json::to_string(&input).map_err(|error| invalid(error.to_string()))?;
    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;

    let existing = sqlx::query_scalar::<_, String>(
        "SELECT transition_json FROM agent_run_transitions WHERE run_id = ? AND sequence = ?",
    )
    .bind(&transition.run_id)
    .bind(transition.sequence)
    .fetch_optional(&mut *transaction)
    .await?;
    if let Some(existing) = existing {
        if existing != payload {
            return Err(invalid("Conflicting goal audit transition replay"));
        }
        transaction.commit().await?;
        let run = super::agent_runs::get_agent_run(pool, &transition.run_id)
            .await?
            .ok_or_else(|| invalid("Replayed goal audit run is missing"))?;
        return Ok(run);
    }

    let next = sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(MAX(sequence) + 1, 0) FROM agent_run_transitions WHERE run_id = ?",
    )
    .bind(&transition.run_id)
    .fetch_one(&mut *transaction)
    .await?;
    if transition.sequence != next {
        return Err(invalid(format!(
            "Expected goal audit transition {next}, received {}",
            transition.sequence
        )));
    }

    if transition.sequence == 0 {
        let descriptor = input
            .descriptor
            .as_ref()
            .ok_or_else(|| invalid("Queued goal audit requires a descriptor"))?;
        if transition.previous_state.is_some()
            || transition.state != AgentRunStatus::Queued
            || transition.result.is_some()
            || descriptor.id.as_deref() != Some(transition.run_id.as_str())
            || descriptor.parent_conversation_id != transition.parent_conversation_id
            || descriptor.agent_profile != "goal_auditor"
            || descriptor.depth != 1
            || descriptor.prompt.trim().is_empty()
            || descriptor.child_conversation_id.is_some()
        {
            return Err(invalid("Invalid queued goal audit descriptor"));
        }
        sqlx::query(
            "INSERT INTO agent_runs (id, parent_conversation_id, agent_profile, depth, status, prompt, model_metadata_json, attempt_count, created_at, updated_at) VALUES (?, ?, 'goal_auditor', 1, 'queued', ?, ?, 0, ?, ?)",
        )
        .bind(&transition.run_id)
        .bind(&transition.parent_conversation_id)
        .bind(&descriptor.prompt)
        .bind(&descriptor.model_metadata_json)
        .bind(&occurred_at)
        .bind(&occurred_at)
        .execute(&mut *transaction)
        .await?;
    } else {
        if input.descriptor.is_some() {
            return Err(invalid("Only the queued transition accepts a descriptor"));
        }
        let row = sqlx::query("SELECT status, parent_conversation_id, agent_profile, depth FROM agent_runs WHERE id = ?")
            .bind(&transition.run_id)
            .fetch_optional(&mut *transaction)
            .await?
            .ok_or_else(|| invalid("Goal audit run is missing"))?;
        let status: String = row.get("status");
        if transition.previous_state.map(AgentRunStatus::as_str) != Some(status.as_str())
            || row.get::<String, _>("parent_conversation_id") != transition.parent_conversation_id
            || row.get::<String, _>("agent_profile") != "goal_auditor"
            || row.get::<i32, _>("depth") != 1
        {
            return Err(invalid(
                "Goal audit transition does not match the durable run",
            ));
        }
        let valid = matches!(
            (transition.previous_state, transition.state),
            (
                Some(AgentRunStatus::Queued),
                AgentRunStatus::Running | AgentRunStatus::Cancelled
            ) | (
                Some(AgentRunStatus::Running),
                AgentRunStatus::Completed
                    | AgentRunStatus::Failed
                    | AgentRunStatus::Cancelled
                    | AgentRunStatus::TimedOut
            )
        );
        if !valid {
            return Err(invalid("Invalid goal audit state transition"));
        }

        if transition.state == AgentRunStatus::Running {
            if transition.result.is_some() {
                return Err(invalid("Running goal audit cannot have a terminal result"));
            }
            sqlx::query("UPDATE agent_runs SET status = 'running', attempt_count = 1, started_at = ?, updated_at = ? WHERE id = ?")
                .bind(&occurred_at).bind(&occurred_at).bind(&transition.run_id)
                .execute(&mut *transaction).await?;
        } else {
            let result = &transition.result;
            if result_field(result, "status").and_then(Value::as_str)
                != Some(transition.state.as_str())
            {
                return Err(invalid(
                    "Terminal goal audit result does not match its state",
                ));
            }
            let output = result_field(result, "output");
            let result_text = output
                .and_then(|value| value.get("text"))
                .and_then(Value::as_str);
            let result_json = output
                .and_then(|value| value.get("structured"))
                .map(serde_json::to_string)
                .transpose()
                .map_err(|error| invalid(error.to_string()))?;
            if transition.state == AgentRunStatus::Completed
                && result_text.is_some()
                && result_json.is_some()
            {
                return Err(invalid(
                    "Goal audit output cannot contain text and structured data",
                ));
            }
            let error = result_field(result, "error");
            let error_code = error
                .and_then(|value| value.get("code"))
                .and_then(Value::as_str);
            let error_message = error
                .and_then(|value| value.get("message"))
                .and_then(Value::as_str);
            if transition.state == AgentRunStatus::Failed && error_message.is_none_or(str::is_empty)
            {
                return Err(invalid("Failed goal audit requires an error message"));
            }
            let error_details = error
                .and_then(|value| value.get("details"))
                .map(serde_json::to_string)
                .transpose()
                .map_err(|error| invalid(error.to_string()))?;
            let cancellation_reason = optional_string(result, "reason");
            if transition.state == AgentRunStatus::Cancelled
                && !matches!(
                    cancellation_reason.as_deref(),
                    Some("parent_cancelled" | "child_cancelled" | "runtime_disposed")
                )
            {
                return Err(invalid("Invalid goal audit cancellation reason"));
            }
            let timeout_reason =
                (transition.state == AgentRunStatus::TimedOut).then_some("deadline_exceeded");
            let usage = &input.usage;
            sqlx::query(
                "UPDATE agent_runs SET status = ?, result_text = ?, result_json = ?, error_code = ?, error_message = ?, error_details_json = ?, cancellation_reason = ?, timeout_reason = ?, input_tokens = ?, output_tokens = ?, cached_input_tokens = ?, reasoning_tokens = ?, total_tokens = ?, usage_json = ?, finished_at = ?, updated_at = ? WHERE id = ?",
            )
            .bind(transition.state.as_str())
            .bind(if transition.state == AgentRunStatus::Completed { result_text } else { None })
            .bind(if transition.state == AgentRunStatus::Completed { result_json.as_deref() } else { None })
            .bind(if transition.state == AgentRunStatus::Failed { error_code } else { None })
            .bind(if transition.state == AgentRunStatus::Failed { error_message } else { None })
            .bind(if transition.state == AgentRunStatus::Failed { error_details.as_deref() } else { None })
            .bind(if transition.state == AgentRunStatus::Cancelled { cancellation_reason.as_deref() } else { None })
            .bind(timeout_reason)
            .bind(usage.input_tokens).bind(usage.output_tokens).bind(usage.cached_input_tokens)
            .bind(usage.reasoning_tokens).bind(usage.total_tokens).bind(&usage.usage_json)
            .bind(&occurred_at).bind(&occurred_at).bind(&transition.run_id)
            .execute(&mut *transaction).await?;
        }
    }

    sqlx::query("INSERT INTO agent_run_transitions (run_id, sequence, previous_state, state, transition_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&transition.run_id).bind(transition.sequence)
        .bind(transition.previous_state.map(AgentRunStatus::as_str))
        .bind(transition.state.as_str()).bind(payload).bind(&occurred_at)
        .execute(&mut *transaction).await?;
    transaction.commit().await?;
    super::agent_runs::get_agent_run(pool, &transition.run_id)
        .await?
        .ok_or_else(|| invalid("Recorded goal audit run is missing"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::CreateConversationInput;
    use crate::db::repository::create_conversation;

    fn transition(
        run_id: &str,
        parent: &str,
        sequence: i64,
        previous_state: Option<AgentRunStatus>,
        state: AgentRunStatus,
    ) -> GoalAuditTransition {
        let result = match state {
            AgentRunStatus::Completed => Some(serde_json::json!({
                "runId": run_id, "parentConversationId": parent, "status": "completed",
                "output": { "text": "Done" }
            })),
            _ => None,
        };
        GoalAuditTransition {
            run_id: run_id.into(),
            parent_conversation_id: parent.into(),
            sequence,
            previous_state,
            state,
            occurred_at: 1_700_000_000_000 + sequence,
            snapshot: serde_json::json!({"runId": run_id, "parentConversationId": parent, "state": state.as_str()}),
            result,
        }
    }

    fn input(transition: GoalAuditTransition) -> RecordGoalAuditTransitionInput {
        let descriptor = (transition.sequence == 0).then(|| CreateAgentRunInput {
            id: Some(transition.run_id.clone()),
            parent_conversation_id: transition.parent_conversation_id.clone(),
            child_conversation_id: None,
            agent_profile: "goal_auditor".into(),
            depth: 1,
            prompt: "Audit the goal".into(),
            model_metadata_json: None,
        });
        RecordGoalAuditTransitionInput {
            descriptor,
            transition,
            usage: AgentRunUsageInput::default(),
        }
    }

    #[tokio::test]
    async fn persists_ordered_transitions_and_child_link_across_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("macro.db");
        let pool = crate::db::create_pool(&path).await.unwrap();
        let parent = create_conversation(
            &pool,
            CreateConversationInput {
                title: Some("Parent".into()),
                scope_mode: "Chat".into(),
                task_id: None,
                group_id: None,
                project_id: None,
                provider_id: None,
                model_id: None,
                reasoning_effort: None,
            },
        )
        .await
        .unwrap()
        .id;
        let child = create_conversation(
            &pool,
            CreateConversationInput {
                title: Some("Child".into()),
                scope_mode: "Chat".into(),
                task_id: None,
                group_id: None,
                project_id: None,
                provider_id: None,
                model_id: None,
                reasoning_effort: None,
            },
        )
        .await
        .unwrap()
        .id;
        let queued = input(transition(
            "audit-1",
            &parent,
            0,
            None,
            AgentRunStatus::Queued,
        ));
        let running = input(transition(
            "audit-1",
            &parent,
            1,
            Some(AgentRunStatus::Queued),
            AgentRunStatus::Running,
        ));
        let completed = input(transition(
            "audit-1",
            &parent,
            2,
            Some(AgentRunStatus::Running),
            AgentRunStatus::Completed,
        ));
        assert!(record_goal_audit_transition(&pool, running.clone())
            .await
            .is_err());
        record_goal_audit_transition(&pool, queued.clone())
            .await
            .unwrap();
        record_goal_audit_transition(&pool, queued.clone())
            .await
            .unwrap();
        let mut conflict = queued;
        conflict.transition.occurred_at += 1;
        assert!(record_goal_audit_transition(&pool, conflict).await.is_err());
        record_goal_audit_transition(&pool, running).await.unwrap();
        let linked = crate::db::agent_runs::link_goal_audit_child_conversation(
            &pool, "audit-1", &parent, &child,
        )
        .await
        .unwrap();
        assert_eq!(
            linked.child_conversation_id.as_deref(),
            Some(child.as_str())
        );
        crate::db::agent_runs::link_goal_audit_child_conversation(
            &pool, "audit-1", &parent, &child,
        )
        .await
        .unwrap();
        record_goal_audit_transition(
            &pool,
            input(transition(
                "audit-2",
                &parent,
                0,
                None,
                AgentRunStatus::Queued,
            )),
        )
        .await
        .unwrap();
        record_goal_audit_transition(
            &pool,
            input(transition(
                "audit-2",
                &parent,
                1,
                Some(AgentRunStatus::Queued),
                AgentRunStatus::Running,
            )),
        )
        .await
        .unwrap();
        assert!(crate::db::agent_runs::link_goal_audit_child_conversation(
            &pool, "audit-2", &parent, &child
        )
        .await
        .is_err());
        assert!(crate::db::agent_runs::link_goal_audit_child_conversation(
            &pool,
            "audit-2",
            "wrong-parent",
            &child
        )
        .await
        .is_err());
        record_goal_audit_transition(
            &pool,
            input(transition(
                "audit-3",
                &parent,
                0,
                None,
                AgentRunStatus::Queued,
            )),
        )
        .await
        .unwrap();
        let mut cancelled = input(transition(
            "audit-3",
            &parent,
            1,
            Some(AgentRunStatus::Queued),
            AgentRunStatus::Cancelled,
        ));
        cancelled.transition.result = Some(serde_json::json!({
            "runId": "audit-3", "parentConversationId": parent,
            "status": "cancelled", "reason": "parent_cancelled"
        }));
        let cancelled_run = record_goal_audit_transition(&pool, cancelled)
            .await
            .unwrap();
        assert_eq!(
            cancelled_run.cancellation_reason.as_deref(),
            Some("parent_cancelled")
        );
        assert!(crate::db::agent_runs::link_goal_audit_child_conversation(
            &pool, "audit-1", &parent, &parent
        )
        .await
        .is_err());
        let finished = record_goal_audit_transition(&pool, completed.clone())
            .await
            .unwrap();
        assert_eq!(finished.result_text.as_deref(), Some("Done"));
        assert_eq!(finished.status, AgentRunStatus::Completed);
        assert!(record_goal_audit_transition(
            &pool,
            input(transition(
                "audit-1",
                &parent,
                3,
                Some(AgentRunStatus::Completed),
                AgentRunStatus::Failed
            ))
        )
        .await
        .is_err());
        pool.close().await;
        let reopened = crate::db::create_pool(&path).await.unwrap();
        assert_eq!(
            record_goal_audit_transition(&reopened, completed)
                .await
                .unwrap()
                .child_conversation_id
                .as_deref(),
            Some(child.as_str())
        );
        let sequences: Vec<i64> = sqlx::query_scalar(
            "SELECT sequence FROM agent_run_transitions WHERE run_id = 'audit-1' ORDER BY sequence",
        )
        .fetch_all(&reopened)
        .await
        .unwrap();
        assert_eq!(sequences, [0, 1, 2]);
        let migrations: Vec<i64> = sqlx::query_scalar(
            "SELECT version FROM schema_migrations WHERE version IN (7, 8) ORDER BY version",
        )
        .fetch_all(&reopened)
        .await
        .unwrap();
        assert_eq!(migrations, [7, 8]);
        let tool_table: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'tool_invocations'",
        )
        .fetch_one(&reopened)
        .await
        .unwrap();
        assert_eq!(tool_table, 1);
    }
}
