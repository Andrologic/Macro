use super::{DbError, DbResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct ReserveGoalAuditChildSelection {
    pub provider_id: String,
    pub model_id: String,
    pub reasoning_effort: Option<String>,
}

fn invalid(message: &str) -> DbError {
    DbError::Validation(message.to_owned())
}

/// Reserve the only child for a current running v9 goal audit. The write lock
/// serializes replays with cancellation, goal replacement, and competing calls.
pub async fn reserve_goal_audit_child_conversation(
    pool: &SqlitePool,
    run_id: &str,
    parent_conversation_id: &str,
    selection: &ReserveGoalAuditChildSelection,
) -> DbResult<String> {
    if [run_id, parent_conversation_id]
        .iter()
        .any(|value| value.is_empty() || value.trim() != *value)
    {
        return Err(invalid("Invalid goal audit run or parent conversation"));
    }
    if [&selection.provider_id, &selection.model_id]
        .into_iter()
        .any(|value| value.is_empty() || value.trim() != value)
        || selection
            .reasoning_effort
            .as_ref()
            .is_some_and(|value| value.is_empty() || value.trim() != value)
    {
        return Err(invalid("Invalid goal audit provider selection"));
    }

    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
    let row = sqlx::query(
        r#"
        SELECT run.child_conversation_id, run.model_metadata_json,
               parent.scope_mode, parent.task_id,
               parent.group_id, parent.project_id
        FROM agent_runs AS run
        JOIN conversations AS parent ON parent.id = run.parent_conversation_id
        JOIN conversation_goal_audit_runs AS link ON link.run_id = run.id
        JOIN conversation_goal_audits AS audit
          ON audit.audit_id = link.audit_id
         AND audit.current_run_id = run.id
         AND audit.conversation_id = parent.id
         AND audit.status = 'running'
        JOIN conversation_goals AS goal
          ON goal.conversation_id = parent.id
         AND goal.goal_id = audit.goal_id
         AND goal.revision = audit.goal_revision
         AND goal.is_current = 1
         AND goal.status = 'auditing'
        WHERE run.id = ? AND run.parent_conversation_id = ?
          AND run.agent_profile = 'goal_auditor' AND run.depth = 1
          AND run.status = 'running' AND run.attempt_count > 0
          AND run.started_at IS NOT NULL AND run.finished_at IS NULL
        "#,
    )
    .bind(run_id)
    .bind(parent_conversation_id)
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or_else(|| invalid("Goal audit run is no longer current and running"))?;

    let scope: String = row.get("scope_mode");
    let task: Option<String> = row.get("task_id");
    let group: Option<String> = row.get("group_id");
    let project: Option<String> = row.get("project_id");
    let mut metadata: serde_json::Value = row
        .get::<Option<String>, _>("model_metadata_json")
        .map(|raw| serde_json::from_str(&raw))
        .transpose()
        .map_err(|_| invalid("Invalid goal audit run metadata"))?
        .unwrap_or_else(|| serde_json::json!({}));
    let metadata_object = metadata
        .as_object_mut()
        .ok_or_else(|| invalid("Invalid goal audit run metadata"))?;
    let selected = serde_json::to_value(selection)
        .map_err(|_| invalid("Invalid goal audit provider selection"))?;
    let valid_reference = |value: &Option<String>| {
        value
            .as_ref()
            .is_none_or(|value| !value.is_empty() && value.trim() == value)
    };
    if ![&task, &group, &project].into_iter().all(valid_reference)
        || !matches!(scope.as_str(), "Chat" | "Architect" | "Implement")
        || project.is_none()
        || scope == "Implement" && task.is_none()
        || scope != "Implement" && task.is_some()
    {
        return Err(invalid(
            "Goal audit parent has an invalid scope or selection",
        ));
    }

    // The run identity is already unique. A fixed child identity makes replay
    // distinguish our reservation from an unrelated, pre-linked conversation.
    let child_id = format!("goal-audit-{:x}", Sha256::digest(run_id.as_bytes()));
    if child_id == parent_conversation_id {
        return Err(invalid(
            "Goal audit child identity conflicts with its parent",
        ));
    }
    if let Some(existing) = row.get::<Option<String>, _>("child_conversation_id") {
        if metadata_object.get("auditSelection") != Some(&selected) {
            return Err(invalid("Goal audit run selection changed on replay"));
        }
        if existing != child_id {
            return Err(invalid("Goal audit run already has another child"));
        }
        let child = sqlx::query(
            "SELECT scope_mode, task_id, group_id, project_id, provider_id, model_id, reasoning_effort FROM conversations WHERE id = ?",
        )
        .bind(&child_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| invalid("Goal audit child link is dangling"))?;
        if child.get::<String, _>("scope_mode") != scope
            || child.get::<Option<String>, _>("task_id") != task
            || child.get::<Option<String>, _>("group_id") != group
            || child.get::<Option<String>, _>("project_id") != project
            || child.get::<Option<String>, _>("provider_id").as_deref()
                != Some(&selection.provider_id)
            || child.get::<Option<String>, _>("model_id").as_deref() != Some(&selection.model_id)
            || child.get::<Option<String>, _>("reasoning_effort") != selection.reasoning_effort
        {
            return Err(invalid("Goal audit child reservation is inconsistent"));
        }
        super::agent_runs::validate_lineage(
            &mut transaction,
            parent_conversation_id,
            Some(&child_id),
            1,
        )
        .await?;
        transaction.commit().await?;
        return Ok(child_id);
    }

    if metadata_object.contains_key("auditSelection") {
        return Err(invalid("Goal audit run selection was already recorded"));
    }
    metadata_object.insert("auditSelection".into(), selected);

    // A pre-existing deterministic ID cannot be adopted: its origin is unknown.
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        r#"INSERT INTO conversations (
            id, title, description, scope_mode, task_id, group_id, project_id,
            provider_id, model_id, reasoning_effort, created_at, updated_at,
            message_count, is_pinned
        ) VALUES (?, 'Goal audit', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)"#,
    )
    .bind(&child_id)
    .bind(&scope)
    .bind(&task)
    .bind(&group)
    .bind(&project)
    .bind(&selection.provider_id)
    .bind(&selection.model_id)
    .bind(&selection.reasoning_effort)
    .bind(&now)
    .bind(&now)
    .execute(&mut *transaction)
    .await?;
    super::agent_runs::validate_lineage(
        &mut transaction,
        parent_conversation_id,
        Some(&child_id),
        1,
    )
    .await?;
    let updated = sqlx::query(
        "UPDATE agent_runs SET child_conversation_id = ?, updated_at = ? WHERE id = ? AND child_conversation_id IS NULL AND status = 'running'",
    )
    .bind(&child_id)
    .bind(&now)
    .bind(run_id)
    .execute(&mut *transaction)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(invalid("Goal audit child link changed during reservation"));
    }
    sqlx::query("UPDATE agent_runs SET model_metadata_json = ? WHERE id = ?")
        .bind(metadata.to_string())
        .bind(run_id)
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await?;
    Ok(child_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::CreateConversationInput;
    use crate::db::repository::create_conversation;

    fn selection() -> ReserveGoalAuditChildSelection {
        ReserveGoalAuditChildSelection {
            provider_id: "provider-2".into(),
            model_id: "model-2".into(),
            reasoning_effort: Some("medium".into()),
        }
    }

    async fn fixture(
        pool: &SqlitePool,
        scope: &str,
        project: Option<&str>,
        task: Option<&str>,
    ) -> String {
        let parent = create_conversation(
            pool,
            CreateConversationInput {
                title: Some("Parent".into()),
                scope_mode: scope.into(),
                task_id: task.map(str::to_owned),
                group_id: Some("group-1".into()),
                project_id: project.map(str::to_owned),
                provider_id: Some("provider-1".into()),
                model_id: Some("model-1".into()),
                reasoning_effort: Some("high".into()),
            },
        )
        .await
        .unwrap()
        .id;
        sqlx::query("INSERT INTO conversation_goals (goal_id, conversation_id, revision, objective, success_criteria_json, status, created_at, updated_at) VALUES ('goal-1', ?, 1, 'Finish', '[]', 'auditing', 'now', 'now')")
            .bind(&parent).execute(pool).await.unwrap();
        sqlx::query("INSERT INTO agent_runs (id, parent_conversation_id, agent_profile, depth, status, prompt, attempt_count, created_at, updated_at, started_at) VALUES ('run-1', ?, 'goal_auditor', 1, 'running', 'Audit', 1, 'now', 'now', 'now')")
            .bind(&parent).execute(pool).await.unwrap();
        sqlx::query("INSERT INTO conversation_goal_audits (audit_id, conversation_id, goal_id, goal_revision, executor_turn_id, current_run_id, status, created_at, updated_at) VALUES ('audit-1', ?, 'goal-1', 1, 'turn-1', 'run-1', 'running', 'now', 'now')")
            .bind(&parent).execute(pool).await.unwrap();
        sqlx::query("INSERT INTO conversation_goal_audit_runs (audit_id, run_id, attempt, linked_at) VALUES ('audit-1', 'run-1', 1, 'now')")
            .execute(pool).await.unwrap();
        parent
    }

    async fn pool() -> (tempfile::TempDir, SqlitePool) {
        let temp = tempfile::tempdir().unwrap();
        let pool = crate::db::create_pool(&temp.path().join("child.db"))
            .await
            .unwrap();
        (temp, pool)
    }

    async fn child_count(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM conversations WHERE title = 'Goal audit'")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn reserves_once_under_concurrent_replay_with_effective_selection() {
        let (_temp, pool) = pool().await;
        let parent = fixture(&pool, "Implement", Some("project-1"), Some("task-1")).await;
        let selected = selection();
        let (first, second) = tokio::join!(
            reserve_goal_audit_child_conversation(&pool, "run-1", &parent, &selected),
            reserve_goal_audit_child_conversation(&pool, "run-1", &parent, &selected)
        );
        let child = first.unwrap();
        assert_eq!(second.unwrap(), child);
        assert_eq!(child_count(&pool).await, 1);
        let row = sqlx::query("SELECT scope_mode, task_id, group_id, project_id, provider_id, model_id, reasoning_effort FROM conversations WHERE id = ?")
            .bind(&child).fetch_one(&pool).await.unwrap();
        for (field, expected) in [
            ("task_id", "task-1"),
            ("group_id", "group-1"),
            ("project_id", "project-1"),
            ("provider_id", "provider-2"),
            ("model_id", "model-2"),
            ("reasoning_effort", "medium"),
        ] {
            assert_eq!(row.get::<&str, _>(field), expected);
        }
        assert_eq!(row.get::<&str, _>("scope_mode"), "Implement");
        let linked: String =
            sqlx::query_scalar("SELECT child_conversation_id FROM agent_runs WHERE id = 'run-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(linked, child);
        let run_metadata: String =
            sqlx::query_scalar("SELECT model_metadata_json FROM agent_runs WHERE id = 'run-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(!run_metadata.contains("apiKey"));
        assert!(!run_metadata.contains("secret"));
        assert!(super::super::agent_runs::authorize_goal_auditor_read(
            &pool, "run-1", &parent, &child,
        )
        .await
        .unwrap()
        .is_some());
        sqlx::query("UPDATE conversations SET provider_id = 'changed' WHERE id = ?")
            .bind(&child)
            .execute(&pool)
            .await
            .unwrap();
        assert!(super::super::agent_runs::authorize_goal_auditor_read(
            &pool, "run-1", &parent, &child,
        )
        .await
        .unwrap()
        .is_none());
    }

    #[tokio::test]
    async fn reuses_child_after_its_title_is_edited() {
        let (_temp, pool) = pool().await;
        let parent = fixture(&pool, "Chat", Some("project-1"), None).await;
        let child = reserve_goal_audit_child_conversation(&pool, "run-1", &parent, &selection())
            .await
            .unwrap();
        sqlx::query("UPDATE conversations SET title = 'Renamed audit' WHERE id = ?")
            .bind(&child)
            .execute(&pool)
            .await
            .unwrap();

        assert_eq!(
            reserve_goal_audit_child_conversation(&pool, "run-1", &parent, &selection())
                .await
                .unwrap(),
            child
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM conversations WHERE id = ?")
                .bind(&child)
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
        for _ in 0..2 {
            let linked = super::super::agent_runs::link_goal_audit_child_conversation(
                &pool, "run-1", &parent, &child,
            )
            .await
            .unwrap();
            assert_eq!(
                linked.child_conversation_id.as_deref(),
                Some(child.as_str())
            );
        }
    }

    #[tokio::test]
    async fn rejects_replay_after_parent_lineage_changes() {
        let (_temp, pool) = pool().await;
        let parent = fixture(&pool, "Chat", Some("project-1"), None).await;
        reserve_goal_audit_child_conversation(&pool, "run-1", &parent, &selection())
            .await
            .unwrap();
        for (column, change_query, reset_query, changed) in [
            (
                "scope_mode",
                "UPDATE conversations SET scope_mode = ? WHERE id = ?",
                "UPDATE conversations SET scope_mode = 'Chat' WHERE id = ?",
                "Architect",
            ),
            (
                "project_id",
                "UPDATE conversations SET project_id = ? WHERE id = ?",
                "UPDATE conversations SET project_id = 'project-1' WHERE id = ?",
                "project-2",
            ),
            (
                "task_id",
                "UPDATE conversations SET task_id = ? WHERE id = ?",
                "UPDATE conversations SET task_id = NULL WHERE id = ?",
                "task-2",
            ),
        ] {
            sqlx::query(change_query)
                .bind(changed)
                .bind(&parent)
                .execute(&pool)
                .await
                .unwrap();
            assert!(
                reserve_goal_audit_child_conversation(&pool, "run-1", &parent, &selection())
                    .await
                    .is_err(),
                "{column}"
            );
            sqlx::query(reset_query)
                .bind(&parent)
                .execute(&pool)
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn rejects_replay_with_different_effective_selection_without_mutating_child() {
        let (_temp, pool) = pool().await;
        let parent = fixture(&pool, "Chat", Some("project-1"), None).await;
        let child = reserve_goal_audit_child_conversation(&pool, "run-1", &parent, &selection())
            .await
            .unwrap();
        for changed in [
            ReserveGoalAuditChildSelection {
                provider_id: "other".into(),
                ..selection()
            },
            ReserveGoalAuditChildSelection {
                model_id: "other".into(),
                ..selection()
            },
            ReserveGoalAuditChildSelection {
                reasoning_effort: None,
                ..selection()
            },
        ] {
            assert!(
                reserve_goal_audit_child_conversation(&pool, "run-1", &parent, &changed)
                    .await
                    .is_err()
            );
        }
        let row = sqlx::query(
            "SELECT provider_id, model_id, reasoning_effort FROM conversations WHERE id = ?",
        )
        .bind(&child)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.get::<&str, _>("provider_id"), "provider-2");
        assert_eq!(row.get::<&str, _>("model_id"), "model-2");
        assert_eq!(row.get::<&str, _>("reasoning_effort"), "medium");
        assert_eq!(child_count(&pool).await, 1);
    }

    #[tokio::test]
    async fn rolls_back_child_when_lineage_validation_fails() {
        let (_temp, pool) = pool().await;
        let parent = fixture(&pool, "Chat", Some("project-1"), None).await;
        let ancestor = create_conversation(
            &pool,
            CreateConversationInput {
                title: None,
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
        sqlx::query("INSERT INTO agent_runs (id, parent_conversation_id, child_conversation_id, agent_profile, depth, status, prompt, created_at, updated_at) VALUES ('ancestor', ?, ?, 'worker', 1, 'queued', 'Work', 'now', 'now')")
            .bind(ancestor).bind(&parent).execute(&pool).await.unwrap();
        assert!(
            reserve_goal_audit_child_conversation(&pool, "run-1", &parent, &selection())
                .await
                .is_err()
        );
        assert_eq!(child_count(&pool).await, 0);
        let linked: Option<String> =
            sqlx::query_scalar("SELECT child_conversation_id FROM agent_runs WHERE id = 'run-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(linked.is_none());
    }

    #[tokio::test]
    async fn rejects_stale_cancelled_and_inconsistent_parent() {
        let (_temp, pool) = pool().await;
        let parent = fixture(&pool, "Implement", Some("project-1"), Some("task-1")).await;
        sqlx::query("UPDATE conversation_goals SET revision = 2 WHERE goal_id = 'goal-1'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            reserve_goal_audit_child_conversation(&pool, "run-1", &parent, &selection())
                .await
                .is_err()
        );
        sqlx::query("UPDATE conversation_goals SET revision = 1 WHERE goal_id = 'goal-1'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE conversations SET task_id = NULL WHERE id = ?")
            .bind(&parent)
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            reserve_goal_audit_child_conversation(&pool, "run-1", &parent, &selection())
                .await
                .is_err()
        );
        sqlx::query("UPDATE conversations SET task_id = 'task-1' WHERE id = ?")
            .bind(&parent)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE conversations SET project_id = NULL WHERE id = ?")
            .bind(&parent)
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            reserve_goal_audit_child_conversation(&pool, "run-1", &parent, &selection())
                .await
                .is_err()
        );
        sqlx::query("UPDATE conversations SET project_id = 'project-1' WHERE id = ?")
            .bind(&parent)
            .execute(&pool)
            .await
            .unwrap();
        let child = reserve_goal_audit_child_conversation(&pool, "run-1", &parent, &selection())
            .await
            .unwrap();
        sqlx::query(
            "UPDATE agent_runs SET status = 'cancelled', finished_at = 'now' WHERE id = 'run-1'",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert!(
            reserve_goal_audit_child_conversation(&pool, "run-1", &parent, &selection())
                .await
                .is_err()
        );
        assert_eq!(child_count(&pool).await, 1);
        assert!(child.starts_with("goal-audit-"));
        assert_eq!(child.len(), "goal-audit-".len() + 64);
    }

    #[tokio::test]
    async fn rejects_parent_without_project_even_in_chat_scope() {
        let (_temp, pool) = pool().await;
        let parent = fixture(&pool, "Chat", None, None).await;
        sqlx::query("UPDATE conversations SET group_id = NULL WHERE id = ?")
            .bind(&parent)
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            reserve_goal_audit_child_conversation(&pool, "run-1", &parent, &selection())
                .await
                .is_err()
        );
        assert_eq!(child_count(&pool).await, 0);
    }

    #[tokio::test]
    async fn rejects_wrong_parent_and_prelinked_child() {
        let (_temp, pool) = pool().await;
        let parent = fixture(&pool, "Chat", Some("project-1"), None).await;
        assert!(reserve_goal_audit_child_conversation(
            &pool,
            "run-1",
            "other-parent",
            &selection()
        )
        .await
        .is_err());
        let other = create_conversation(
            &pool,
            CreateConversationInput {
                title: Some("Existing child".into()),
                scope_mode: "Chat".into(),
                task_id: None,
                group_id: None,
                project_id: Some("project-1".into()),
                provider_id: None,
                model_id: None,
                reasoning_effort: None,
            },
        )
        .await
        .unwrap()
        .id;
        sqlx::query("UPDATE agent_runs SET child_conversation_id = ? WHERE id = 'run-1'")
            .bind(&other)
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            reserve_goal_audit_child_conversation(&pool, "run-1", &parent, &selection())
                .await
                .is_err()
        );
        assert_eq!(child_count(&pool).await, 0);
    }
}
