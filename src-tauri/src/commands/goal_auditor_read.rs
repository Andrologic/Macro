use super::{command_error, execute_workspace_tool_controlled, get_pool, CommandResult, DbPool};
use crate::db::agent_runs;
use crate::git::GitState;
use crate::workspace;
use crate::{WorkspaceMetadataRoot, WorkspaceRoot};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;
use std::path::PathBuf;
use tauri::State;

const GOAL_AUDITOR_READ_TOOLS: &[&str] = &[
    "list",
    "read",
    "glob",
    "grep",
    "ast_grep",
    "git_status",
    "git_log",
    "git_branch_list",
    "git_diff",
    "git_get_tree",
];

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct GoalAuditorReadInput {
    pub run_id: String,
    pub parent_conversation_id: String,
    pub child_conversation_id: String,
    pub tool_id: String,
    pub args: Value,
}

async fn auditor_workspace(
    default_workspace: &PathBuf,
    metadata_workspace: &PathBuf,
    project_id: Option<&str>,
) -> CommandResult<PathBuf> {
    let Some(project_id) = project_id else {
        return Ok(default_workspace.clone());
    };
    let project = workspace::get_project_by_id(default_workspace, metadata_workspace, project_id)
        .await
        .map_err(|error| command_error(error.to_string()))?
        .ok_or_else(|| command_error("Goal auditor project is unavailable"))?;
    if let Some(wsl_path) = workspace::parse_wsl_unc_path(&project.path) {
        return Ok(PathBuf::from(wsl_path.unc_path));
    }
    let path = PathBuf::from(project.path);
    let candidate = if path.is_absolute() {
        path
    } else {
        default_workspace.join(path)
    };
    let resolved = candidate
        .canonicalize()
        .map_err(|_| command_error("Goal auditor project path is unavailable"))?;
    if !resolved.is_dir() {
        return Err(command_error(
            "Goal auditor project path is not a directory",
        ));
    }
    Ok(resolved)
}

async fn execute_goal_auditor_read(
    pool: &SqlitePool,
    workspace: PathBuf,
    metadata_workspace: PathBuf,
    git_state: GitState,
    input: GoalAuditorReadInput,
) -> CommandResult<String> {
    if !GOAL_AUDITOR_READ_TOOLS.contains(&input.tool_id.as_str()) || !input.args.is_object() {
        return Err(command_error("Goal auditor tool is not an allowed read"));
    }
    let scope = agent_runs::authorize_goal_auditor_read(
        pool,
        &input.run_id,
        &input.parent_conversation_id,
        &input.child_conversation_id,
    )
    .await?;
    let scope = scope.ok_or_else(|| command_error("Goal auditor run is not active or linked"))?;
    let scoped_workspace =
        auditor_workspace(&workspace, &metadata_workspace, scope.project_id.as_deref()).await?;

    // Architect is fixed here because Chat intentionally denies workspace reads.
    // The exact native allowlist above is the authority for this command.
    let result = execute_workspace_tool_controlled(
        scoped_workspace,
        metadata_workspace,
        git_state,
        "Architect".to_string(),
        input.tool_id,
        input.args,
        None,
        None,
        None,
        Some(false),
        None,
        None,
    )
    .await?;
    if agent_runs::authorize_goal_auditor_read(
        pool,
        &input.run_id,
        &input.parent_conversation_id,
        &input.child_conversation_id,
    )
    .await?
        != Some(scope)
    {
        return Err(command_error("Goal auditor run ended during the read"));
    }
    Ok(result)
}

#[tauri::command]
pub async fn tool_execute_goal_auditor_read(
    pool: State<'_, DbPool>,
    workspace_root: State<'_, WorkspaceRoot>,
    workspace_metadata_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    input: GoalAuditorReadInput,
) -> CommandResult<String> {
    let pool = get_pool(&pool).await?;
    execute_goal_auditor_read(
        &pool,
        workspace_root.inner().read().await.clone(),
        workspace_metadata_root.inner().0.read().await.clone(),
        git_state.inner().clone(),
        input,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::{
        AgentRunStatus, CompleteAgentRunInput, CreateAgentRunInput, CreateConversationInput,
    };
    use crate::db::repository::create_conversation;
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn native_allowlist_matches_the_fixed_executor_policy() {
        for tool in GOAL_AUDITOR_READ_TOOLS {
            assert!(
                crate::core::tool_policy::validate_tool_execution("Architect", tool, None).allowed,
                "{tool} must remain executable after the native allowlist check"
            );
            assert!(
                !crate::core::tool_policy::validate_tool_execution("Chat", tool, None).allowed,
                "{tool} must not be dispatched through Chat mode"
            );
        }
    }

    struct Fixture {
        _temp: TempDir,
        pool: SqlitePool,
        workspace: PathBuf,
        run_id: String,
        parent_id: String,
        child_id: String,
    }

    impl Fixture {
        async fn new() -> Self {
            let temp = tempfile::tempdir().expect("fixture directory");
            let pool = crate::db::create_pool(&temp.path().join("macro.db"))
                .await
                .expect("fixture database");
            let workspace = temp.path().join("workspace");
            std::fs::create_dir(&workspace).expect("workspace");
            std::fs::write(workspace.join("proof.txt"), "verified audit evidence")
                .expect("proof file");
            std::fs::write(temp.path().join("outside.txt"), "outside audit secret")
                .expect("outside file");
            let parent_id = Self::conversation(&pool, "Parent").await;
            let child_id = Self::conversation(&pool, "Audit child").await;
            let run_id = "audit-run".to_owned();
            agent_runs::create_agent_run(
                &pool,
                CreateAgentRunInput {
                    id: Some(run_id.clone()),
                    parent_conversation_id: parent_id.clone(),
                    child_conversation_id: None,
                    agent_profile: "goal_auditor".into(),
                    depth: 1,
                    prompt: "Verify the goal".into(),
                    model_metadata_json: None,
                },
            )
            .await
            .expect("create run");
            agent_runs::start_agent_run(&pool, &run_id, None)
                .await
                .expect("start run");
            agent_runs::link_goal_audit_child_conversation(&pool, &run_id, &parent_id, &child_id)
                .await
                .expect("link child");
            let now = chrono::Utc::now().to_rfc3339();
            sqlx::query("INSERT INTO conversation_goals (goal_id, conversation_id, revision, objective, success_criteria_json, status, created_at, updated_at) VALUES ('goal-1', ?, 1, 'Verify the goal', '[\"evidence\"]', 'auditing', ?, ?)")
                .bind(&parent_id)
                .bind(&now)
                .bind(&now)
                .execute(&pool)
                .await
                .expect("current auditing goal");
            sqlx::query("INSERT INTO conversation_goal_audits (audit_id, conversation_id, goal_id, goal_revision, executor_turn_id, current_run_id, status, created_at, updated_at) VALUES ('audit-1', ?, 'goal-1', 1, 'turn-1', ?, 'running', ?, ?)")
                .bind(&parent_id)
                .bind(&run_id)
                .bind(&now)
                .bind(&now)
                .execute(&pool)
                .await
                .expect("active audit");
            sqlx::query("INSERT INTO conversation_goal_audit_runs (audit_id, run_id, attempt, linked_at) VALUES ('audit-1', ?, 1, ?)")
                .bind(&run_id)
                .bind(&now)
                .execute(&pool)
                .await
                .expect("linked audit run");
            Self {
                _temp: temp,
                pool,
                workspace,
                run_id,
                parent_id,
                child_id,
            }
        }

        async fn conversation(pool: &SqlitePool, title: &str) -> String {
            create_conversation(
                pool,
                CreateConversationInput {
                    title: Some(title.into()),
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
            .expect("conversation")
            .id
        }

        fn input(&self, tool_id: &str, args: Value) -> GoalAuditorReadInput {
            GoalAuditorReadInput {
                run_id: self.run_id.clone(),
                parent_conversation_id: self.parent_id.clone(),
                child_conversation_id: self.child_id.clone(),
                tool_id: tool_id.into(),
                args,
            }
        }

        async fn execute(&self, input: GoalAuditorReadInput) -> CommandResult<String> {
            execute_goal_auditor_read(
                &self.pool,
                self.workspace.clone(),
                self.workspace.clone(),
                GitState::new(),
                input,
            )
            .await
        }
    }

    #[tokio::test]
    async fn reads_a_real_file_only_for_the_running_linked_auditor() {
        let fixture = Fixture::new().await;
        let result = fixture
            .execute(fixture.input("read", json!({"path": "proof.txt"})))
            .await
            .expect("allowed read");
        assert!(result.contains("verified audit evidence"));
        assert_eq!(
            agent_runs::get_agent_run(&fixture.pool, &fixture.run_id)
                .await
                .unwrap()
                .unwrap()
                .status,
            AgentRunStatus::Running,
        );
    }

    #[tokio::test]
    async fn read_path_cannot_escape_the_authorized_workspace() {
        let fixture = Fixture::new().await;
        let absolute = fixture.workspace.parent().unwrap().join("outside.txt");
        for path in ["../outside.txt".to_owned(), absolute.display().to_string()] {
            let result = fixture
                .execute(fixture.input("read", json!({"path": path})))
                .await;
            assert!(
                result.is_err(),
                "a path outside the audit workspace must fail"
            );
            let message = result.unwrap_or_else(|error| error.message);
            assert!(!message.contains("outside audit secret"));
        }
        let outside_repo = fixture.workspace.parent().unwrap().display().to_string();
        assert!(fixture
            .execute(fixture.input("git_status", json!({"repo_path": outside_repo})))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn rejects_every_non_read_tool_before_execution() {
        let fixture = Fixture::new().await;
        for tool in [
            "terminal_run",
            "mcp__server__tool",
            "write",
            "apply_patch",
            "git_commit",
            "read_file",
            " read",
        ] {
            assert!(
                fixture
                    .execute(fixture.input(tool, json!({})))
                    .await
                    .is_err(),
                "{tool}"
            );
        }
        assert!(fixture
            .execute(fixture.input("read", json!("not an argument object")))
            .await
            .is_err());
    }

    #[test]
    fn caller_cannot_supply_a_workspace_mode_or_profile() {
        for field in ["workspacePath", "mode", "profile"] {
            let mut input = json!({
                "runId": "audit-run",
                "parentConversationId": "parent",
                "childConversationId": "child",
                "toolId": "read",
                "args": {"path": "proof.txt"},
            });
            input[field] = json!("/another/workspace");
            assert!(serde_json::from_value::<GoalAuditorReadInput>(input).is_err());
        }
    }

    #[tokio::test]
    async fn rejects_foreign_stale_and_unlinked_identities() {
        let fixture = Fixture::new().await;
        for (run_id, parent_id, child_id) in [
            (
                "missing",
                fixture.parent_id.as_str(),
                fixture.child_id.as_str(),
            ),
            (
                fixture.run_id.as_str(),
                "foreign-parent",
                fixture.child_id.as_str(),
            ),
            (
                fixture.run_id.as_str(),
                fixture.parent_id.as_str(),
                "foreign-child",
            ),
            (
                fixture.run_id.as_str(),
                fixture.parent_id.as_str(),
                fixture.parent_id.as_str(),
            ),
        ] {
            let mut input = fixture.input("read", json!({"path": "proof.txt"}));
            input.run_id = run_id.into();
            input.parent_conversation_id = parent_id.into();
            input.child_conversation_id = child_id.into();
            assert!(fixture.execute(input).await.is_err());
        }

        let input = fixture.input("read", json!({"path": "proof.txt"}));
        sqlx::query("UPDATE agent_runs SET agent_profile = 'repo_auditor' WHERE id = ?")
            .bind(&fixture.run_id)
            .execute(&fixture.pool)
            .await
            .unwrap();
        assert!(fixture.execute(input.clone()).await.is_err());
        sqlx::query("UPDATE agent_runs SET agent_profile = 'goal_auditor', depth = 2 WHERE id = ?")
            .bind(&fixture.run_id)
            .execute(&fixture.pool)
            .await
            .unwrap();
        assert!(fixture.execute(input.clone()).await.is_err());
        sqlx::query("UPDATE agent_runs SET depth = 1, child_conversation_id = NULL WHERE id = ?")
            .bind(&fixture.run_id)
            .execute(&fixture.pool)
            .await
            .unwrap();
        assert!(fixture.execute(input).await.is_err());
    }

    #[tokio::test]
    async fn missing_parent_project_does_not_fall_back_to_the_global_workspace() {
        let fixture = Fixture::new().await;
        sqlx::query("UPDATE conversations SET project_id = 'missing-project' WHERE id = ?")
            .bind(&fixture.parent_id)
            .execute(&fixture.pool)
            .await
            .unwrap();
        let result = fixture
            .execute(fixture.input("read", json!({"path": "proof.txt"})))
            .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn rejects_parent_selection_changes_after_child_link() {
        let fixture = Fixture::new().await;
        let input = fixture.input("read", json!({"path": "proof.txt"}));
        fixture.execute(input.clone()).await.unwrap();
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
                "UPDATE conversations SET project_id = NULL WHERE id = ?",
                "another-project",
            ),
            (
                "task_id",
                "UPDATE conversations SET task_id = ? WHERE id = ?",
                "UPDATE conversations SET task_id = NULL WHERE id = ?",
                "another-task",
            ),
        ] {
            sqlx::query(change_query)
                .bind(changed)
                .bind(&fixture.parent_id)
                .execute(&fixture.pool)
                .await
                .unwrap();
            assert!(fixture.execute(input.clone()).await.is_err(), "{column}");
            sqlx::query(reset_query)
                .bind(&fixture.parent_id)
                .execute(&fixture.pool)
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn parent_project_selects_its_native_registered_root() {
        let fixture = Fixture::new().await;
        let project_path = fixture.workspace.join("project");
        std::fs::create_dir(&project_path).unwrap();
        std::fs::write(project_path.join("proof.txt"), "project audit evidence").unwrap();
        let project = workspace::create_project(
            &fixture.workspace,
            &fixture.workspace,
            workspace::metadata::CreateProjectRequest {
                name: "Audit project".into(),
                description: String::new(),
                group_id: None,
                group_name: None,
                path: Some(project_path.display().to_string()),
                git_flow_settings: None,
                direct_edit: true,
            },
        )
        .await
        .expect("registered project");
        sqlx::query("UPDATE conversations SET project_id = ? WHERE id = ?")
            .bind(&project.id)
            .bind(&fixture.parent_id)
            .execute(&fixture.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE conversations SET project_id = ? WHERE id = ?")
            .bind(&project.id)
            .bind(&fixture.child_id)
            .execute(&fixture.pool)
            .await
            .unwrap();

        let result = fixture
            .execute(fixture.input("read", json!({"path": "proof.txt"})))
            .await
            .expect("project-scoped read");
        assert!(result.contains("project audit evidence"));
        assert!(!result.contains("verified audit evidence"));
    }

    #[tokio::test]
    async fn rejects_a_finished_run_and_a_failed_database() {
        let fixture = Fixture::new().await;
        let input = fixture.input("read", json!({"path": "proof.txt"}));
        agent_runs::complete_agent_run(
            &fixture.pool,
            &fixture.run_id,
            CompleteAgentRunInput::default(),
        )
        .await
        .expect("finish run");
        assert!(fixture.execute(input).await.is_err());

        let unavailable = Fixture::new().await;
        let active_input = unavailable.input("read", json!({"path": "proof.txt"}));
        unavailable.pool.close().await;
        assert!(unavailable.execute(active_input).await.is_err());
    }

    #[tokio::test]
    async fn rejects_a_run_without_its_audit_link() {
        let fixture = Fixture::new().await;
        sqlx::query("DELETE FROM conversation_goal_audit_runs WHERE run_id = ?")
            .bind(&fixture.run_id)
            .execute(&fixture.pool)
            .await
            .unwrap();
        assert!(fixture
            .execute(fixture.input("read", json!({"path": "proof.txt"})))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn rejects_a_historical_run_even_while_it_is_running() {
        let fixture = Fixture::new().await;
        agent_runs::create_agent_run(
            &fixture.pool,
            CreateAgentRunInput {
                id: Some("replacement-run".into()),
                parent_conversation_id: fixture.parent_id.clone(),
                child_conversation_id: None,
                agent_profile: "goal_auditor".into(),
                depth: 1,
                prompt: "Retry the audit".into(),
                model_metadata_json: None,
            },
        )
        .await
        .expect("replacement run");
        sqlx::query("UPDATE conversation_goal_audits SET current_run_id = 'replacement-run' WHERE audit_id = 'audit-1'")
            .execute(&fixture.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO conversation_goal_audit_runs (audit_id, run_id, attempt, linked_at) VALUES ('audit-1', 'replacement-run', 2, ?)")
            .bind(chrono::Utc::now().to_rfc3339())
            .execute(&fixture.pool)
            .await
            .unwrap();
        assert!(fixture
            .execute(fixture.input("read", json!({"path": "proof.txt"})))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn rejects_interrupted_or_missing_active_audit() {
        let fixture = Fixture::new().await;
        let input = fixture.input("read", json!({"path": "proof.txt"}));
        sqlx::query(
            "UPDATE conversation_goal_audits SET status = 'interrupted' WHERE audit_id = 'audit-1'",
        )
        .execute(&fixture.pool)
        .await
        .unwrap();
        assert!(fixture.execute(input.clone()).await.is_err());
        sqlx::query("DELETE FROM conversation_goal_audits WHERE audit_id = 'audit-1'")
            .execute(&fixture.pool)
            .await
            .unwrap();
        assert!(fixture.execute(input).await.is_err());
    }

    #[tokio::test]
    async fn rejects_a_changed_or_inactive_goal_revision() {
        let fixture = Fixture::new().await;
        let input = fixture.input("read", json!({"path": "proof.txt"}));
        for change in [
            "UPDATE conversation_goals SET revision = 2 WHERE goal_id = 'goal-1'",
            "UPDATE conversation_goals SET revision = 1, status = 'paused' WHERE goal_id = 'goal-1'",
            "UPDATE conversation_goals SET status = 'auditing', is_current = 0 WHERE goal_id = 'goal-1'",
        ] {
            sqlx::query(change).execute(&fixture.pool).await.unwrap();
            assert!(fixture.execute(input.clone()).await.is_err(), "{change}");
        }
    }
}
