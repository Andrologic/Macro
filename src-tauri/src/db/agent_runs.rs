use super::models::*;
use super::{DbError, DbResult};
use serde_json::Value;
use sqlx::sqlite::{SqlitePool, SqliteRow};
use sqlx::Row;
use std::str::FromStr;

fn validate_json(field: &str, value: Option<&str>) -> DbResult<()> {
    if let Some(value) = value {
        serde_json::from_str::<Value>(value)
            .map_err(|error| DbError::Validation(format!("Invalid {field}: {error}")))?;
    }
    Ok(())
}

fn validate_usage(usage: &AgentRunUsageInput) -> DbResult<()> {
    for (field, value) in [
        ("input_tokens", usage.input_tokens),
        ("output_tokens", usage.output_tokens),
        ("cached_input_tokens", usage.cached_input_tokens),
        ("reasoning_tokens", usage.reasoning_tokens),
        ("total_tokens", usage.total_tokens),
    ] {
        if value.is_some_and(|value| value < 0) {
            return Err(DbError::Validation(format!(
                "Agent run {field} cannot be negative"
            )));
        }
    }
    validate_json("agent run usage JSON", usage.usage_json.as_deref())
}

fn map_agent_run(row: SqliteRow) -> DbResult<AgentRun> {
    let raw_status = row.get::<String, _>("status");
    let status = AgentRunStatus::from_str(&raw_status).map_err(DbError::Validation)?;

    Ok(AgentRun {
        id: row.get("id"),
        parent_conversation_id: row.get("parent_conversation_id"),
        child_conversation_id: row.get("child_conversation_id"),
        agent_profile: row.get("agent_profile"),
        depth: row.get("depth"),
        status,
        prompt: row.get("prompt"),
        result_text: row.get("result_text"),
        result_json: row.get("result_json"),
        error_code: row.get("error_code"),
        error_message: row.get("error_message"),
        error_details_json: row.get("error_details_json"),
        cancellation_reason: row.get("cancellation_reason"),
        interruption_reason: row.get("interruption_reason"),
        timeout_reason: row.get("timeout_reason"),
        model_metadata_json: row.get("model_metadata_json"),
        input_tokens: row.get("input_tokens"),
        output_tokens: row.get("output_tokens"),
        cached_input_tokens: row.get("cached_input_tokens"),
        reasoning_tokens: row.get("reasoning_tokens"),
        total_tokens: row.get("total_tokens"),
        usage_json: row.get("usage_json"),
        attempt_count: row.get("attempt_count"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        started_at: row.get("started_at"),
        finished_at: row.get("finished_at"),
        last_interrupted_at: row.get("last_interrupted_at"),
    })
}

async fn transition_error(pool: &SqlitePool, id: &str, transition: &str) -> DbError {
    match get_agent_run(pool, id).await {
        Ok(Some(run)) => DbError::Validation(format!(
            "Cannot {transition} agent run {id} from status {}",
            run.status
        )),
        Ok(None) => DbError::Validation(format!("Agent run not found: {id}")),
        Err(error) => error,
    }
}

async fn load_after_transition(pool: &SqlitePool, id: &str) -> DbResult<AgentRun> {
    get_agent_run(pool, id)
        .await?
        .ok_or_else(|| DbError::Validation(format!("Agent run disappeared: {id}")))
}

pub async fn create_agent_run(pool: &SqlitePool, input: CreateAgentRunInput) -> DbResult<AgentRun> {
    let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if id.trim().is_empty()
        || input.parent_conversation_id.trim().is_empty()
        || input.agent_profile.trim().is_empty()
        || input.prompt.trim().is_empty()
    {
        return Err(DbError::Validation(
            "Agent run id, parent conversation, profile and prompt are required".to_string(),
        ));
    }
    if input.depth < 1 {
        return Err(DbError::Validation(
            "Agent run depth must be at least 1".to_string(),
        ));
    }
    if input.child_conversation_id.as_deref() == Some(input.parent_conversation_id.as_str()) {
        return Err(DbError::Validation(
            "Parent and child conversations must differ".to_string(),
        ));
    }
    validate_json(
        "agent run model metadata JSON",
        input.model_metadata_json.as_deref(),
    )?;

    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        r#"
        INSERT INTO agent_runs (
            id, parent_conversation_id, child_conversation_id, agent_profile,
            depth, status, prompt, model_metadata_json, attempt_count,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, 0, ?, ?)
        "#,
    )
    .bind(&id)
    .bind(&input.parent_conversation_id)
    .bind(&input.child_conversation_id)
    .bind(&input.agent_profile)
    .bind(input.depth)
    .bind(&input.prompt)
    .bind(&input.model_metadata_json)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;

    load_after_transition(pool, &id).await
}

pub async fn get_agent_run(pool: &SqlitePool, id: &str) -> DbResult<Option<AgentRun>> {
    sqlx::query(
        r#"
        SELECT id, parent_conversation_id, child_conversation_id, agent_profile,
               depth, status, prompt, result_text, result_json, error_code,
               error_message, error_details_json, cancellation_reason,
               interruption_reason, timeout_reason, model_metadata_json,
               input_tokens, output_tokens, cached_input_tokens, reasoning_tokens,
               total_tokens, usage_json, attempt_count, created_at, updated_at,
               started_at, finished_at, last_interrupted_at
        FROM agent_runs
        WHERE id = ?
        "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    .map(map_agent_run)
    .transpose()
}

pub async fn list_agent_runs_by_parent(
    pool: &SqlitePool,
    parent_conversation_id: &str,
) -> DbResult<Vec<AgentRun>> {
    sqlx::query(
        r#"
        SELECT id, parent_conversation_id, child_conversation_id, agent_profile,
               depth, status, prompt, result_text, result_json, error_code,
               error_message, error_details_json, cancellation_reason,
               interruption_reason, timeout_reason, model_metadata_json,
               input_tokens, output_tokens, cached_input_tokens, reasoning_tokens,
               total_tokens, usage_json, attempt_count, created_at, updated_at,
               started_at, finished_at, last_interrupted_at
        FROM agent_runs
        WHERE parent_conversation_id = ?
        ORDER BY created_at ASC, id ASC
        "#,
    )
    .bind(parent_conversation_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(map_agent_run)
    .collect()
}

pub async fn start_agent_run(
    pool: &SqlitePool,
    id: &str,
    child_conversation_id: Option<&str>,
) -> DbResult<AgentRun> {
    let now = chrono::Utc::now().to_rfc3339();
    let result = sqlx::query(
        r#"
        UPDATE agent_runs
        SET status = 'running',
            child_conversation_id = COALESCE(?, child_conversation_id),
            attempt_count = attempt_count + 1,
            started_at = COALESCE(started_at, ?),
            updated_at = ?, interruption_reason = NULL, finished_at = NULL
        WHERE id = ? AND status IN ('queued', 'interrupted')
        "#,
    )
    .bind(child_conversation_id)
    .bind(&now)
    .bind(&now)
    .bind(id)
    .execute(pool)
    .await?;
    if result.rows_affected() != 1 {
        return Err(transition_error(pool, id, "start").await);
    }
    load_after_transition(pool, id).await
}

pub async fn complete_agent_run(
    pool: &SqlitePool,
    id: &str,
    input: CompleteAgentRunInput,
) -> DbResult<AgentRun> {
    if input.result_text.is_some() && input.result_json.is_some() {
        return Err(DbError::Validation(
            "An agent run result cannot contain both text and JSON".to_string(),
        ));
    }
    validate_json("agent run result JSON", input.result_json.as_deref())?;
    validate_usage(&input.usage)?;
    finish_success(pool, id, input).await
}

async fn finish_success(
    pool: &SqlitePool,
    id: &str,
    input: CompleteAgentRunInput,
) -> DbResult<AgentRun> {
    let now = chrono::Utc::now().to_rfc3339();
    let usage = input.usage;
    let result = sqlx::query(
        r#"
        UPDATE agent_runs SET status = 'completed', result_text = ?, result_json = ?,
            input_tokens = ?, output_tokens = ?, cached_input_tokens = ?, reasoning_tokens = ?,
            total_tokens = ?, usage_json = ?, updated_at = ?, finished_at = ?
        WHERE id = ? AND status = 'running'
        "#,
    )
    .bind(&input.result_text)
    .bind(&input.result_json)
    .bind(usage.input_tokens)
    .bind(usage.output_tokens)
    .bind(usage.cached_input_tokens)
    .bind(usage.reasoning_tokens)
    .bind(usage.total_tokens)
    .bind(&usage.usage_json)
    .bind(&now)
    .bind(&now)
    .bind(id)
    .execute(pool)
    .await?;
    if result.rows_affected() != 1 {
        return Err(transition_error(pool, id, "complete").await);
    }
    load_after_transition(pool, id).await
}

pub async fn fail_agent_run(
    pool: &SqlitePool,
    id: &str,
    input: FailAgentRunInput,
) -> DbResult<AgentRun> {
    if input.error_message.trim().is_empty() {
        return Err(DbError::Validation(
            "Agent run error message cannot be empty".to_string(),
        ));
    }
    validate_json(
        "agent run error details JSON",
        input.error_details_json.as_deref(),
    )?;
    validate_usage(&input.usage)?;
    let now = chrono::Utc::now().to_rfc3339();
    let usage = input.usage;
    let result = sqlx::query(
        r#"
        UPDATE agent_runs SET status = 'failed', error_code = ?, error_message = ?,
            error_details_json = ?, input_tokens = ?, output_tokens = ?, cached_input_tokens = ?,
            reasoning_tokens = ?, total_tokens = ?, usage_json = ?, updated_at = ?, finished_at = ?
        WHERE id = ? AND status = 'running'
        "#,
    )
    .bind(&input.error_code)
    .bind(&input.error_message)
    .bind(&input.error_details_json)
    .bind(usage.input_tokens)
    .bind(usage.output_tokens)
    .bind(usage.cached_input_tokens)
    .bind(usage.reasoning_tokens)
    .bind(usage.total_tokens)
    .bind(&usage.usage_json)
    .bind(&now)
    .bind(&now)
    .bind(id)
    .execute(pool)
    .await?;
    if result.rows_affected() != 1 {
        return Err(transition_error(pool, id, "fail").await);
    }
    load_after_transition(pool, id).await
}

pub async fn cancel_agent_run(
    pool: &SqlitePool,
    id: &str,
    input: CancelAgentRunInput,
) -> DbResult<AgentRun> {
    validate_usage(&input.usage)?;
    let now = chrono::Utc::now().to_rfc3339();
    let usage = input.usage;
    let result = sqlx::query(
        r#"
        UPDATE agent_runs SET status = 'cancelled', cancellation_reason = ?,
            interruption_reason = NULL, input_tokens = ?, output_tokens = ?,
            cached_input_tokens = ?, reasoning_tokens = ?, total_tokens = ?, usage_json = ?,
            updated_at = ?, finished_at = ?
        WHERE id = ? AND status IN ('queued', 'running', 'interrupted')
        "#,
    )
    .bind(&input.reason)
    .bind(usage.input_tokens)
    .bind(usage.output_tokens)
    .bind(usage.cached_input_tokens)
    .bind(usage.reasoning_tokens)
    .bind(usage.total_tokens)
    .bind(&usage.usage_json)
    .bind(&now)
    .bind(&now)
    .bind(id)
    .execute(pool)
    .await?;
    if result.rows_affected() != 1 {
        return Err(transition_error(pool, id, "cancel").await);
    }
    load_after_transition(pool, id).await
}

pub async fn time_out_agent_run(
    pool: &SqlitePool,
    id: &str,
    input: TimeOutAgentRunInput,
) -> DbResult<AgentRun> {
    validate_usage(&input.usage)?;
    let reason = input
        .reason
        .as_deref()
        .filter(|reason| !reason.trim().is_empty())
        .unwrap_or("deadline_exceeded");
    let now = chrono::Utc::now().to_rfc3339();
    let usage = input.usage;
    let result = sqlx::query(
        r#"
        UPDATE agent_runs SET status = 'timed_out', timeout_reason = ?,
            input_tokens = ?, output_tokens = ?, cached_input_tokens = ?, reasoning_tokens = ?,
            total_tokens = ?, usage_json = ?, updated_at = ?, finished_at = ?
        WHERE id = ? AND status = 'running'
        "#,
    )
    .bind(reason)
    .bind(usage.input_tokens)
    .bind(usage.output_tokens)
    .bind(usage.cached_input_tokens)
    .bind(usage.reasoning_tokens)
    .bind(usage.total_tokens)
    .bind(&usage.usage_json)
    .bind(&now)
    .bind(&now)
    .bind(id)
    .execute(pool)
    .await?;
    if result.rows_affected() != 1 {
        return Err(transition_error(pool, id, "time out").await);
    }
    load_after_transition(pool, id).await
}

pub async fn reconcile_active_agent_runs_after_restart(pool: &SqlitePool) -> DbResult<u64> {
    let now = chrono::Utc::now().to_rfc3339();
    let result = sqlx::query(
        r#"
        UPDATE agent_runs SET status = 'interrupted',
            interruption_reason = 'application_restart', last_interrupted_at = ?, updated_at = ?
        WHERE status = 'running'
        "#,
    )
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::super::create_pool;
    use super::*;
    use crate::db::repository::{create_conversation, delete_conversation};
    use tempfile::TempDir;

    async fn test_pool() -> (TempDir, SqlitePool) {
        let temp_dir = TempDir::new().expect("temp dir");
        let db_path = temp_dir.path().join("macro.db");
        let pool = create_pool(&db_path).await.expect("db pool");
        (temp_dir, pool)
    }

    async fn conversation(pool: &SqlitePool, title: &str) -> String {
        create_conversation(
            pool,
            CreateConversationInput {
                title: Some(title.to_string()),
                scope_mode: "Chat".to_string(),
                task_id: None,
                group_id: None,
                project_id: None,
                provider_id: None,
                model_id: None,
                reasoning_effort: None,
            },
        )
        .await
        .expect("conversation")
        .id
    }

    async fn queued_run(pool: &SqlitePool, parent: &str, id: &str) -> AgentRun {
        create_agent_run(
            pool,
            CreateAgentRunInput {
                id: Some(id.to_string()),
                parent_conversation_id: parent.to_string(),
                child_conversation_id: None,
                agent_profile: "worker".to_string(),
                depth: 1,
                prompt: format!("Run {id}"),
                model_metadata_json: Some(r#"{"model":"test"}"#.to_string()),
            },
        )
        .await
        .expect("queued agent run")
    }

    #[tokio::test]
    async fn lifecycle_transitions_are_validated_and_timeout_stays_distinct() {
        let (_temp_dir, pool) = test_pool().await;
        let parent = conversation(&pool, "Parent").await;

        let completed = queued_run(&pool, &parent, "completed").await;
        assert_eq!(completed.status, AgentRunStatus::Queued);
        let completed = start_agent_run(&pool, &completed.id, None)
            .await
            .expect("start completed run");
        assert_eq!(completed.attempt_count, 1);
        let completed = complete_agent_run(
            &pool,
            &completed.id,
            CompleteAgentRunInput {
                result_text: Some("done".to_string()),
                usage: AgentRunUsageInput {
                    input_tokens: Some(10),
                    output_tokens: Some(4),
                    reasoning_tokens: Some(2),
                    total_tokens: Some(14),
                    ..Default::default()
                },
                ..Default::default()
            },
        )
        .await
        .expect("complete run");
        assert_eq!(completed.status, AgentRunStatus::Completed);
        assert_eq!(completed.reasoning_tokens, Some(2));
        assert!(fail_agent_run(
            &pool,
            &completed.id,
            FailAgentRunInput {
                error_code: None,
                error_message: "late failure".to_string(),
                error_details_json: None,
                usage: AgentRunUsageInput::default(),
            },
        )
        .await
        .is_err());

        let failed = queued_run(&pool, &parent, "failed").await;
        start_agent_run(&pool, &failed.id, None)
            .await
            .expect("start failed run");
        let failed = fail_agent_run(
            &pool,
            &failed.id,
            FailAgentRunInput {
                error_code: Some("execution_error".to_string()),
                error_message: "boom".to_string(),
                error_details_json: Some(r#"{"retryable":false}"#.to_string()),
                usage: AgentRunUsageInput::default(),
            },
        )
        .await
        .expect("fail run");
        assert_eq!(failed.status, AgentRunStatus::Failed);

        let cancelled = queued_run(&pool, &parent, "cancelled").await;
        let cancelled = cancel_agent_run(
            &pool,
            &cancelled.id,
            CancelAgentRunInput {
                reason: Some("user_request".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("cancel queued run");
        assert_eq!(cancelled.status, AgentRunStatus::Cancelled);

        let timed_out = queued_run(&pool, &parent, "timed-out").await;
        start_agent_run(&pool, &timed_out.id, None)
            .await
            .expect("start timed out run");
        let timed_out = time_out_agent_run(&pool, &timed_out.id, TimeOutAgentRunInput::default())
            .await
            .expect("time out run");
        assert_eq!(timed_out.status, AgentRunStatus::TimedOut);
        assert_eq!(
            timed_out.timeout_reason.as_deref(),
            Some("deadline_exceeded")
        );

        let listed = list_agent_runs_by_parent(&pool, &parent)
            .await
            .expect("list parent runs");
        assert_eq!(listed.len(), 4);
        assert_eq!(
            listed.into_iter().map(|run| run.id).collect::<Vec<_>>(),
            vec!["completed", "failed", "cancelled", "timed-out"]
        );
    }

    #[tokio::test]
    async fn parent_and_child_integrity_and_numeric_constraints_are_enforced() {
        let (_temp_dir, pool) = test_pool().await;
        let parent = conversation(&pool, "Parent").await;
        let child = conversation(&pool, "Child").await;
        let other_parent = conversation(&pool, "Other parent").await;

        assert!(create_agent_run(
            &pool,
            CreateAgentRunInput {
                id: Some("bad-depth".to_string()),
                parent_conversation_id: parent.clone(),
                child_conversation_id: None,
                agent_profile: "worker".to_string(),
                depth: 0,
                prompt: "bad".to_string(),
                model_metadata_json: None,
            },
        )
        .await
        .is_err());
        assert!(create_agent_run(
            &pool,
            CreateAgentRunInput {
                id: Some("orphan".to_string()),
                parent_conversation_id: "missing-parent".to_string(),
                child_conversation_id: None,
                agent_profile: "worker".to_string(),
                depth: 1,
                prompt: "orphan".to_string(),
                model_metadata_json: None,
            },
        )
        .await
        .is_err());

        let linked = create_agent_run(
            &pool,
            CreateAgentRunInput {
                id: Some("linked".to_string()),
                parent_conversation_id: parent.clone(),
                child_conversation_id: Some(child.clone()),
                agent_profile: "worker".to_string(),
                depth: 1,
                prompt: "linked".to_string(),
                model_metadata_json: None,
            },
        )
        .await
        .expect("linked run");
        assert!(
            sqlx::query("UPDATE agent_runs SET total_tokens = -1 WHERE id = ?")
                .bind(&linked.id)
                .execute(&pool)
                .await
                .is_err()
        );
        assert!(
            sqlx::query("UPDATE agent_runs SET result_text = 'illegal' WHERE id = ?")
                .bind(&linked.id)
                .execute(&pool)
                .await
                .is_err()
        );
        delete_conversation(&pool, &child)
            .await
            .expect("delete child conversation");
        assert_eq!(
            get_agent_run(&pool, &linked.id)
                .await
                .expect("get linked run")
                .expect("linked run remains")
                .child_conversation_id,
            None
        );
        assert!(list_agent_runs_by_parent(&pool, &other_parent)
            .await
            .expect("other parent list")
            .is_empty());
        delete_conversation(&pool, &parent)
            .await
            .expect("delete parent conversation");
        assert!(get_agent_run(&pool, &linked.id)
            .await
            .expect("get cascaded run")
            .is_none());
    }

    #[tokio::test]
    async fn reconciliation_is_selective_idempotent_and_resumable() {
        let (_temp_dir, pool) = test_pool().await;
        let parent = conversation(&pool, "Parent").await;
        let queued = queued_run(&pool, &parent, "queued").await;
        let running = queued_run(&pool, &parent, "running").await;
        start_agent_run(&pool, &running.id, None)
            .await
            .expect("start running run");

        assert_eq!(
            reconcile_active_agent_runs_after_restart(&pool)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            reconcile_active_agent_runs_after_restart(&pool)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            get_agent_run(&pool, &queued.id)
                .await
                .unwrap()
                .unwrap()
                .status,
            AgentRunStatus::Queued
        );
        let interrupted = get_agent_run(&pool, &running.id).await.unwrap().unwrap();
        assert_eq!(interrupted.status, AgentRunStatus::Interrupted);
        assert_eq!(
            interrupted.interruption_reason.as_deref(),
            Some("application_restart")
        );
        let resumed = start_agent_run(&pool, &running.id, None)
            .await
            .expect("resume interrupted run");
        assert_eq!(resumed.status, AgentRunStatus::Running);
        assert_eq!(resumed.attempt_count, 2);

        let complete_pool = pool.clone();
        let fail_pool = pool.clone();
        let run_id = resumed.id.clone();
        let complete_id = run_id.clone();
        let complete = tokio::spawn(async move {
            complete_agent_run(
                &complete_pool,
                &complete_id,
                CompleteAgentRunInput::default(),
            )
            .await
            .is_ok()
        });
        let fail = tokio::spawn(async move {
            fail_agent_run(
                &fail_pool,
                &run_id,
                FailAgentRunInput {
                    error_code: None,
                    error_message: "race".to_string(),
                    error_details_json: None,
                    usage: AgentRunUsageInput::default(),
                },
            )
            .await
            .is_ok()
        });
        assert_ne!(complete.await.unwrap(), fail.await.unwrap());
    }
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    use crate::db::models::{Conversation, CreateConversationInput};
    use crate::db::repository::create_conversation;
    use tempfile::TempDir;

    async fn test_pool() -> (TempDir, SqlitePool) {
        let temp_dir = TempDir::new().expect("temp dir");
        let pool = super::super::create_pool(&temp_dir.path().join("macro.db"))
            .await
            .expect("database pool");
        (temp_dir, pool)
    }

    async fn conversation(pool: &SqlitePool, title: &str) -> Conversation {
        create_conversation(
            pool,
            CreateConversationInput {
                title: Some(title.to_string()),
                scope_mode: "Chat".to_string(),
                task_id: None,
                group_id: None,
                project_id: None,
                provider_id: None,
                model_id: None,
                reasoning_effort: None,
            },
        )
        .await
        .expect("conversation")
    }

    fn create_input(id: &str, parent_id: &str) -> CreateAgentRunInput {
        CreateAgentRunInput {
            id: Some(id.to_string()),
            parent_conversation_id: parent_id.to_string(),
            child_conversation_id: None,
            agent_profile: "reviewer".to_string(),
            depth: 1,
            prompt: "Review the database contract".to_string(),
            model_metadata_json: Some(r#"{"model":"generic"}"#.to_string()),
        }
    }

    #[tokio::test]
    async fn persists_and_lists_runs_by_parent_in_stable_order() {
        let (_temp, pool) = test_pool().await;
        let parent = conversation(&pool, "Parent").await;
        let other = conversation(&pool, "Other").await;
        create_agent_run(&pool, create_input("run-b", &parent.id))
            .await
            .unwrap();
        create_agent_run(&pool, create_input("run-a", &parent.id))
            .await
            .unwrap();
        create_agent_run(&pool, create_input("other-run", &other.id))
            .await
            .unwrap();

        let runs = list_agent_runs_by_parent(&pool, &parent.id).await.unwrap();
        assert_eq!(
            runs.iter().map(|run| run.id.as_str()).collect::<Vec<_>>(),
            vec!["run-b", "run-a"]
        );
        assert_eq!(
            get_agent_run(&pool, "run-a").await.unwrap().unwrap().status,
            AgentRunStatus::Queued
        );
    }

    #[tokio::test]
    async fn validates_transitions_and_persists_structured_completion_usage() {
        let (_temp, pool) = test_pool().await;
        let parent = conversation(&pool, "Parent").await;
        let child = conversation(&pool, "Child").await;
        create_agent_run(&pool, create_input("completed-run", &parent.id))
            .await
            .unwrap();

        assert!(
            complete_agent_run(&pool, "completed-run", CompleteAgentRunInput::default())
                .await
                .is_err()
        );
        let running = start_agent_run(&pool, "completed-run", Some(&child.id))
            .await
            .unwrap();
        assert_eq!(running.status, AgentRunStatus::Running);
        assert_eq!(running.attempt_count, 1);

        let completed = complete_agent_run(
            &pool,
            "completed-run",
            CompleteAgentRunInput {
                result_text: None,
                result_json: Some(r#"{"verdict":"ok"}"#.to_string()),
                usage: AgentRunUsageInput {
                    input_tokens: Some(10),
                    output_tokens: Some(4),
                    cached_input_tokens: Some(2),
                    reasoning_tokens: Some(1),
                    total_tokens: Some(14),
                    usage_json: Some(r#"{"requests":1}"#.to_string()),
                },
            },
        )
        .await
        .unwrap();
        assert_eq!(completed.status, AgentRunStatus::Completed);
        assert_eq!(completed.total_tokens, Some(14));
        assert!(completed.finished_at.is_some());
        assert!(
            cancel_agent_run(&pool, "completed-run", CancelAgentRunInput::default())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn persists_failure_and_cancellation_terminal_states() {
        let (_temp, pool) = test_pool().await;
        let parent = conversation(&pool, "Parent").await;
        create_agent_run(&pool, create_input("failed-run", &parent.id))
            .await
            .unwrap();
        start_agent_run(&pool, "failed-run", None).await.unwrap();
        let failed = fail_agent_run(
            &pool,
            "failed-run",
            FailAgentRunInput {
                error_code: Some("runtime_error".to_string()),
                error_message: "boom".to_string(),
                error_details_json: Some(r#"{"retryable":false}"#.to_string()),
                usage: AgentRunUsageInput::default(),
            },
        )
        .await
        .unwrap();
        assert_eq!(failed.status, AgentRunStatus::Failed);

        create_agent_run(&pool, create_input("cancelled-run", &parent.id))
            .await
            .unwrap();
        let cancelled = cancel_agent_run(
            &pool,
            "cancelled-run",
            CancelAgentRunInput {
                reason: Some("parent stopped".to_string()),
                usage: AgentRunUsageInput::default(),
            },
        )
        .await
        .unwrap();
        assert_eq!(cancelled.status, AgentRunStatus::Cancelled);
        assert_eq!(
            cancelled.cancellation_reason.as_deref(),
            Some("parent stopped")
        );
    }

    #[tokio::test]
    async fn reopening_reconciles_only_running_runs_and_allows_resume() {
        let (temp, pool) = test_pool().await;
        let parent = conversation(&pool, "Parent").await;
        create_agent_run(&pool, create_input("running-run", &parent.id))
            .await
            .unwrap();
        start_agent_run(&pool, "running-run", None).await.unwrap();
        create_agent_run(&pool, create_input("queued-run", &parent.id))
            .await
            .unwrap();
        drop(pool);

        let reopened = super::super::create_pool(&temp.path().join("macro.db"))
            .await
            .unwrap();
        let interrupted = get_agent_run(&reopened, "running-run")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(interrupted.status, AgentRunStatus::Interrupted);
        assert_eq!(
            interrupted.interruption_reason.as_deref(),
            Some("application_restart")
        );
        assert!(interrupted.last_interrupted_at.is_some());
        assert_eq!(
            get_agent_run(&reopened, "queued-run")
                .await
                .unwrap()
                .unwrap()
                .status,
            AgentRunStatus::Queued
        );

        let resumed = start_agent_run(&reopened, "running-run", None)
            .await
            .unwrap();
        assert_eq!(resumed.status, AgentRunStatus::Running);
        assert_eq!(resumed.attempt_count, 2);
        assert_eq!(resumed.interruption_reason, None);
    }
}
