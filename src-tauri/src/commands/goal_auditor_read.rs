use super::{command_error, execute_workspace_tool_controlled, get_pool, CommandResult, DbPool};
use crate::db::agent_runs;
use crate::git::{GitState, TaskWorktreeStatus};
use crate::workspace;
use crate::workspace::metadata::{WorkspaceState, WorkspaceTaskExecutionTargetDto};
use crate::WorkspaceMetadataRoot;
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

fn has_reserved_metadata_path(path: &str) -> bool {
    path.split(['/', '\\'])
        .any(|part| matches!(part, ".macro" | ".git"))
}

fn validate_read_arguments(tool: &str, args: &Value) -> CommandResult<()> {
    let string = |key: &str| args.get(key).and_then(Value::as_str);
    let check_path = |path: &str| {
        if has_reserved_metadata_path(path) {
            Err(command_error("Goal auditor cannot read Macro metadata"))
        } else {
            Ok(())
        }
    };
    match tool {
        "list" | "read" | "ast_grep" => {
            if let Some(path) = string("path") {
                check_path(path)?;
            }
        }
        "glob" => {
            if let Some(pattern) = string("pattern") {
                check_path(pattern)?;
            }
        }
        "grep" => {
            if let Some(pattern) = string("include_pattern") {
                check_path(pattern)?;
            }
        }
        _ => {}
    }
    if matches!(tool, "list" | "glob" | "grep" | "ast_grep")
        && args.get("include_hidden").and_then(Value::as_bool) == Some(true)
    {
        return Err(command_error("Goal auditor cannot include hidden files"));
    }
    if tool.starts_with("git_") {
        if let Some(repo_path) = string("repo_path") {
            check_path(repo_path)?;
        }
        for key in ["branch", "base", "head"] {
            if string(key).is_some_and(|reference| !reference.is_empty()) {
                return Err(command_error(
                    "Goal auditor Git reads are limited to the current checkout",
                ));
            }
        }
        if tool == "git_diff" {
            if let Some(paths) = args.get("paths").and_then(Value::as_array) {
                for path in paths.iter().filter_map(Value::as_str) {
                    check_path(path)?;
                }
            }
        }
    }
    Ok(())
}

fn validate_resolved_read_path(
    tool: &str,
    args: &Value,
    workspace: &std::path::Path,
) -> CommandResult<()> {
    if !matches!(tool, "list" | "read" | "ast_grep") && !tool.starts_with("git_") {
        return Ok(());
    }
    let key = if tool.starts_with("git_") {
        "repo_path"
    } else {
        "path"
    };
    let path = args.get(key).and_then(Value::as_str).unwrap_or(".");
    let resolved = crate::fs::validate_path(std::path::Path::new(path), workspace)
        .map_err(|error| command_error(error.to_string()))?;
    let relative = resolved
        .strip_prefix(workspace)
        .map_err(|_| command_error("Goal auditor path escaped its workspace"))?;
    if relative
        .components()
        .any(|part| matches!(part.as_os_str().to_str(), Some(".macro" | ".git")))
    {
        return Err(command_error("Goal auditor cannot read Macro metadata"));
    }
    Ok(())
}

fn validate_git_checkout_scope(args: &Value, workspace: &std::path::Path) -> CommandResult<()> {
    let repo_path = args.get("repo_path").and_then(Value::as_str).unwrap_or(".");
    let requested = crate::fs::validate_path(std::path::Path::new(repo_path), workspace)
        .map_err(|error| command_error(error.to_string()))?;
    let repo = git2::Repository::discover(&requested)
        .map_err(|_| command_error("Goal auditor Git repository is unavailable"))?;
    let root = repo
        .workdir()
        .ok_or_else(|| command_error("Goal auditor cannot read a bare repository"))?
        .canonicalize()
        .map_err(|_| command_error("Goal auditor Git root is unavailable"))?;
    if !root.starts_with(workspace) {
        return Err(command_error(
            "Goal auditor Git repository extends outside the project",
        ));
    }
    if std::fs::symlink_metadata(root.join(".macro")).is_ok() {
        return Err(command_error(
            "Goal auditor cannot read a Git checkout containing Macro metadata",
        ));
    }
    let index = repo
        .index()
        .map_err(|_| command_error("Goal auditor Git index is unavailable"))?;
    if index
        .iter()
        .any(|entry| entry.path == b".macro" || entry.path.starts_with(b".macro/"))
    {
        return Err(command_error(
            "Goal auditor Git index contains Macro metadata",
        ));
    }
    if repo
        .head()
        .ok()
        .and_then(|head| head.peel_to_tree().ok())
        .is_some_and(|tree| tree.get_name(".macro").is_some())
    {
        return Err(command_error(
            "Goal auditor Git tree contains Macro metadata",
        ));
    }
    Ok(())
}

fn read_registry(metadata_root: &std::path::Path) -> CommandResult<WorkspaceState> {
    let bytes = std::fs::read(metadata_root.join("workspace.json"))
        .map_err(|_| command_error("Goal auditor workspace registry is unavailable"))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| command_error("Goal auditor workspace registry is invalid"))
}

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
    stable_workspace: &PathBuf,
    git_state: &GitState,
    scope: &agent_runs::GoalAuditorReadScope,
) -> CommandResult<PathBuf> {
    let stable_workspace = stable_workspace
        .canonicalize()
        .map_err(|_| command_error("Goal auditor stable workspace is unavailable"))?;
    // Do not call resolve_metadata_root here: it may create or repair a worktree.
    let metadata_root = if git2::Repository::discover(&stable_workspace).is_ok() {
        crate::git::find_existing_macro_metadata_worktree_root(&stable_workspace)
            .ok_or_else(|| command_error("Goal auditor metadata worktree is unavailable"))?
    } else {
        stable_workspace.join(".macro")
    };
    let registry = read_registry(&metadata_root)?;
    let project_id = scope
        .project_id
        .as_deref()
        .ok_or_else(|| command_error("Goal auditor has no bound project"))?;
    let project = registry
        .standalone_projects
        .iter()
        .chain(
            registry
                .project_groups
                .iter()
                .flat_map(|group| &group.projects),
        )
        .find(|project| project.id == project_id && project.archived_at.is_none())
        .ok_or_else(|| command_error("Goal auditor project is unavailable"))?;
    if workspace::parse_wsl_unc_path(&project.path).is_some() {
        return Err(command_error(
            "Goal auditor WSL project reads are unavailable",
        ));
    }
    let path = PathBuf::from(&project.path);
    let candidate = if path.is_absolute() {
        path
    } else {
        stable_workspace.join(path)
    };
    let resolved = candidate
        .canonicalize()
        .map_err(|_| command_error("Goal auditor project path is unavailable"))?;
    let canonical_metadata_root = metadata_root
        .canonicalize()
        .map_err(|_| command_error("Goal auditor metadata root is unavailable"))?;
    if resolved.starts_with(canonical_metadata_root) {
        return Err(command_error(
            "Goal auditor project points into Macro metadata",
        ));
    }
    if !resolved.is_dir() {
        return Err(command_error(
            "Goal auditor project path is not a directory",
        ));
    }
    let Some(task_id) = scope.task_id.as_deref() else {
        return Ok(resolved);
    };
    let plan_tasks = registry
        .current_plan
        .as_ref()
        .into_iter()
        .flat_map(|plan| &plan.tasks)
        .filter(|task| task.get("id").and_then(Value::as_str) == Some(task_id));
    let manual_tasks = registry
        .manual_features
        .iter()
        .filter(|task| task.id == task_id && task.archived_at.is_none());
    let mut targets = Vec::new();
    for task in plan_tasks {
        let raw_targets = task
            .get("execution_targets")
            .and_then(Value::as_array)
            .ok_or_else(|| command_error("Goal auditor task has no execution targets"))?;
        for raw_target in raw_targets {
            let target: WorkspaceTaskExecutionTargetDto =
                serde_json::from_value(raw_target.clone())
                    .map_err(|_| command_error("Goal auditor task target is invalid"))?;
            if target.project_id == project_id {
                targets.push(target);
            }
        }
    }
    for task in manual_tasks {
        targets.extend(
            task.execution_targets
                .iter()
                .filter(|target| target.project_id == project_id)
                .cloned(),
        );
    }
    if targets.len() != 1 {
        return Err(command_error("Goal auditor task project is ambiguous"));
    }
    let target = &targets[0];
    match (
        target.execution_mode.as_deref(),
        target.execution_kind.as_deref(),
    ) {
        (Some("direct"), Some("repository_root")) => return Ok(resolved),
        (Some("git") | None, Some("worktree")) => {}
        _ => {
            return Err(command_error(
                "Goal auditor task execution target is invalid",
            ))
        }
    }
    let worktree_key = Some(target.worktree_key.as_str())
        .filter(|key| !key.is_empty())
        .ok_or_else(|| command_error("Goal auditor task worktree key is missing"))?;
    let branch_name = Some(target.branch_name.as_str())
        .filter(|branch| !branch.is_empty())
        .ok_or_else(|| command_error("Goal auditor task branch is missing"))?;
    let source_repo = git2::Repository::open(&resolved)
        .map_err(|_| command_error("Goal auditor source repository is unavailable"))?;
    let inspection = git_state
        .diagnose_task_worktree(&source_repo, worktree_key, Some(branch_name))
        .map_err(|error| command_error(error.to_string()))?;
    if inspection.status != TaskWorktreeStatus::Ready
        || inspection.branch_name.as_deref() != Some(branch_name)
    {
        return Err(command_error("Goal auditor task worktree is not ready"));
    }
    let worktree = inspection
        .worktree_path
        .canonicalize()
        .map_err(|_| command_error("Goal auditor task worktree is unavailable"))?;
    let worktree_repo = git2::Repository::open(&worktree)
        .map_err(|_| command_error("Goal auditor task worktree repository is unavailable"))?;
    let source_git_dir = source_repo
        .commondir()
        .canonicalize()
        .map_err(|_| command_error("Goal auditor source Git directory is unavailable"))?;
    let worktree_git_dir = worktree_repo
        .commondir()
        .canonicalize()
        .map_err(|_| command_error("Goal auditor worktree Git directory is unavailable"))?;
    if worktree_git_dir != source_git_dir {
        return Err(command_error(
            "Goal auditor task worktree belongs to another repository",
        ));
    }
    Ok(worktree)
}

async fn execute_goal_auditor_read(
    pool: &SqlitePool,
    metadata_workspace: PathBuf,
    git_state: GitState,
    input: GoalAuditorReadInput,
) -> CommandResult<String> {
    if !GOAL_AUDITOR_READ_TOOLS.contains(&input.tool_id.as_str()) || !input.args.is_object() {
        return Err(command_error("Goal auditor tool is not an allowed read"));
    }
    validate_read_arguments(&input.tool_id, &input.args)?;
    let scope = agent_runs::authorize_goal_auditor_read(
        pool,
        &input.run_id,
        &input.parent_conversation_id,
        &input.child_conversation_id,
    )
    .await?;
    let scope = scope.ok_or_else(|| command_error("Goal auditor run is not active or linked"))?;
    let scoped_workspace = auditor_workspace(&metadata_workspace, &git_state, &scope).await?;
    validate_resolved_read_path(&input.tool_id, &input.args, &scoped_workspace)?;
    if input.tool_id.starts_with("git_") {
        validate_git_checkout_scope(&input.args, &scoped_workspace)?;
    }

    // Architect is fixed here because Chat intentionally denies workspace reads.
    // The exact native allowlist above is the authority for this command.
    let result = execute_workspace_tool_controlled(
        scoped_workspace.clone(),
        metadata_workspace.clone(),
        git_state.clone(),
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
        != Some(scope.clone())
    {
        return Err(command_error("Goal auditor run ended during the read"));
    }
    if auditor_workspace(&metadata_workspace, &git_state, &scope).await? != scoped_workspace {
        return Err(command_error(
            "Goal auditor workspace changed during the read",
        ));
    }
    Ok(result)
}

#[tauri::command]
pub async fn tool_execute_goal_auditor_read(
    pool: State<'_, DbPool>,
    workspace_metadata_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    input: GoalAuditorReadInput,
) -> CommandResult<String> {
    let pool = get_pool(&pool).await?;
    execute_goal_auditor_read(
        &pool,
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
        metadata_root: PathBuf,
        run_id: String,
        parent_id: String,
        child_id: String,
    }

    impl Fixture {
        async fn new() -> Self {
            Self::new_with_git_metadata(false).await
        }

        async fn new_with_git_metadata(git_metadata: bool) -> Self {
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
            let metadata_root = if git_metadata {
                let repo = git2::Repository::init(&workspace).expect("Git workspace");
                let mut index = repo.index().unwrap();
                index.add_path(std::path::Path::new("proof.txt")).unwrap();
                index.write().unwrap();
                let tree_id = index.write_tree().unwrap();
                let tree = repo.find_tree(tree_id).unwrap();
                let author = git2::Signature::now("Fixture", "fixture@example.invalid").unwrap();
                repo.commit(Some("HEAD"), &author, &author, "Initial", &tree, &[])
                    .unwrap();
                drop(tree);
                let root = crate::commands::workspace::resolve_metadata_root(
                    workspace.clone(),
                    GitState::new(),
                )
                .await
                .expect("Git metadata worktree");
                assert_ne!(root, workspace);
                assert_ne!(root, workspace.join(".macro"));
                root
            } else {
                let root = workspace.join(".macro");
                std::fs::create_dir(&root).expect("metadata root");
                root
            };
            let project = workspace::create_project(
                &workspace,
                &metadata_root,
                workspace::metadata::CreateProjectRequest {
                    name: "Audit root".into(),
                    description: String::new(),
                    group_id: None,
                    group_name: None,
                    path: Some(workspace.display().to_string()),
                    git_flow_settings: None,
                    direct_edit: true,
                },
            )
            .await
            .expect("registered root project");
            let parent_id = Self::conversation(&pool, "Parent").await;
            let child_id = Self::conversation(&pool, "Audit child").await;
            sqlx::query("UPDATE conversations SET project_id = ? WHERE id IN (?, ?)")
                .bind(&project.id)
                .bind(&parent_id)
                .bind(&child_id)
                .execute(&pool)
                .await
                .expect("bound parent project");
            sqlx::query("UPDATE conversations SET provider_id = 'auditor-provider', model_id = 'auditor-model' WHERE id = ?")
                .bind(&child_id)
                .execute(&pool)
                .await
                .expect("bound auditor selection");
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
                    model_metadata_json: Some(r#"{"auditSelection":{"providerId":"auditor-provider","modelId":"auditor-model","reasoningEffort":null}}"#.into()),
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
                metadata_root,
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
            execute_goal_auditor_read(&self.pool, self.workspace.clone(), GitState::new(), input)
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
    async fn refuses_macro_metadata_paths_and_hidden_scans() {
        let fixture = Fixture::new().await;
        let registry_path = fixture.metadata_root.join("workspace.json");
        let original = std::fs::read(&registry_path).unwrap();
        let modified = std::fs::metadata(&registry_path)
            .unwrap()
            .modified()
            .unwrap();
        for (tool, args) in [
            ("read", json!({"path": ".macro/workspace.json"})),
            ("list", json!({"path": ".macro"})),
            (
                "ast_grep",
                json!({"path": ".macro/workspace.json", "pattern": "project"}),
            ),
            ("glob", json!({"pattern": ".macro/**"})),
            (
                "grep",
                json!({"query": "project", "include_pattern": ".macro/**"}),
            ),
            ("list", json!({"path": ".", "include_hidden": true})),
            ("glob", json!({"pattern": "**/*", "include_hidden": true})),
            ("grep", json!({"query": "project", "include_hidden": true})),
            ("ast_grep", json!({"path": ".", "include_hidden": true})),
            ("git_status", json!({"repo_path": ".macro"})),
            ("git_diff", json!({"paths": [".macro/workspace.json"]})),
            ("git_log", json!({"branch": "@macro"})),
            ("git_get_tree", json!({"branch": "refs/heads/@macro"})),
        ] {
            assert!(
                fixture.execute(fixture.input(tool, args)).await.is_err(),
                "{tool}"
            );
        }
        let absolute = registry_path.display().to_string();
        assert!(fixture
            .execute(fixture.input("read", json!({"path": absolute})))
            .await
            .is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                &fixture.metadata_root,
                fixture.workspace.join("metadata-link"),
            )
            .unwrap();
            assert!(fixture
                .execute(fixture.input("read", json!({"path": "metadata-link/workspace.json"})))
                .await
                .is_err());
            assert!(fixture
                .execute(fixture.input("git_status", json!({"repo_path": "metadata-link"})))
                .await
                .is_err());
        }
        assert_eq!(std::fs::read(&registry_path).unwrap(), original);
        assert_eq!(
            std::fs::metadata(&registry_path)
                .unwrap()
                .modified()
                .unwrap(),
            modified
        );
    }

    #[tokio::test]
    async fn refuses_metadata_worktree_through_git_admin_path() {
        let fixture = Fixture::new_with_git_metadata(true).await;
        let path = fixture.workspace.join(".git/config").display().to_string();
        assert!(fixture
            .execute(fixture.input("read", json!({"path": path})))
            .await
            .is_err());
        let metadata_path = fixture.metadata_root.join("workspace.json");
        assert!(fixture
            .execute(fixture.input("read", json!({"path": metadata_path})))
            .await
            .is_err());
        assert!(fixture
            .execute(fixture.input("read", json!({"path": ".macro/workspace.json"})))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn git_reads_stay_within_the_registered_project_repository() {
        let fixture = Fixture::new_with_git_metadata(true).await;
        let inside = fixture.workspace.join("nested-project");
        std::fs::create_dir(&inside).unwrap();
        std::fs::write(inside.join("proof.txt"), "nested project evidence").unwrap();
        let project = workspace::create_project(
            &fixture.workspace,
            &fixture.metadata_root,
            workspace::metadata::CreateProjectRequest {
                name: "Nested project".into(),
                description: String::new(),
                group_id: None,
                group_name: None,
                path: Some(inside.display().to_string()),
                git_flow_settings: None,
                direct_edit: true,
            },
        )
        .await
        .unwrap();
        sqlx::query("UPDATE conversations SET project_id = ? WHERE id IN (?, ?)")
            .bind(&project.id)
            .bind(&fixture.parent_id)
            .bind(&fixture.child_id)
            .execute(&fixture.pool)
            .await
            .unwrap();
        let read = fixture
            .execute(fixture.input("read", json!({"path": "proof.txt"})))
            .await
            .unwrap();
        assert!(read.contains("nested project evidence"));
        assert!(fixture
            .execute(fixture.input("git_get_tree", json!({})))
            .await
            .is_err());
        assert!(fixture
            .execute(fixture.input("git_diff", json!({})))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn git_diff_refuses_untracked_macro_metadata_in_the_checkout() {
        let fixture = Fixture::new_with_git_metadata(true).await;
        assert!(fixture
            .execute(fixture.input("git_status", json!({})))
            .await
            .is_ok());
        let metadata = fixture.workspace.join(".macro");
        std::fs::create_dir(&metadata).unwrap();
        std::fs::write(metadata.join("workspace.json"), "private metadata marker").unwrap();
        assert!(fixture
            .execute(fixture.input("git_diff", json!({})))
            .await
            .is_err());
        assert!(fixture
            .execute(fixture.input("git_get_tree", json!({})))
            .await
            .is_err());
        let repo = git2::Repository::open(&fixture.workspace).unwrap();
        let mut index = repo.index().unwrap();
        index
            .add_path(std::path::Path::new(".macro/workspace.json"))
            .unwrap();
        index.write().unwrap();
        std::fs::remove_dir_all(&metadata).unwrap();
        assert!(fixture
            .execute(fixture.input("git_diff", json!({})))
            .await
            .is_err());
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let parent = repo.head().unwrap().peel_to_commit().unwrap();
        let author = git2::Signature::now("Fixture", "fixture@example.invalid").unwrap();
        repo.commit(
            Some("HEAD"),
            &author,
            &author,
            "Track metadata",
            &tree,
            &[&parent],
        )
        .unwrap();
        index
            .remove_path(std::path::Path::new(".macro/workspace.json"))
            .unwrap();
        index.write().unwrap();
        assert!(fixture
            .execute(fixture.input("git_diff", json!({})))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn wsl_project_is_refused_explicitly_without_a_verified_native_root() {
        let fixture = Fixture::new().await;
        let registry_path = fixture.metadata_root.join("workspace.json");
        let mut registry: Value =
            serde_json::from_slice(&std::fs::read(&registry_path).unwrap()).unwrap();
        registry["standaloneProjects"][0]["path"] = json!(r"\\wsl.localhost\Ubuntu\home\audit");
        std::fs::write(&registry_path, serde_json::to_vec(&registry).unwrap()).unwrap();
        let error = fixture
            .execute(fixture.input("read", json!({"path": "proof.txt"})))
            .await
            .unwrap_err();
        assert!(error.message.contains("WSL project reads are unavailable"));
    }

    #[tokio::test]
    async fn registered_project_cannot_point_into_macro_metadata() {
        let fixture = Fixture::new().await;
        let registry_path = fixture.metadata_root.join("workspace.json");
        let mut registry: Value =
            serde_json::from_slice(&std::fs::read(&registry_path).unwrap()).unwrap();
        registry["standaloneProjects"][0]["path"] =
            json!(fixture.metadata_root.display().to_string());
        std::fs::write(&registry_path, serde_json::to_vec(&registry).unwrap()).unwrap();
        assert!(fixture
            .execute(fixture.input("read", json!({"path": "workspace.json"})))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn rejects_a_child_with_a_changed_parent_context() {
        let fixture = Fixture::new().await;
        let input = fixture.input("read", json!({"path": "proof.txt"}));
        for (change, restore) in [
            ("UPDATE conversations SET project_id = 'other' WHERE id = ?", "UPDATE conversations SET project_id = (SELECT project_id FROM conversations WHERE id = ?) WHERE id = ?"),
            ("UPDATE conversations SET task_id = 'other' WHERE id = ?", "UPDATE conversations SET task_id = NULL WHERE id = ?"),
            ("UPDATE conversations SET group_id = 'other' WHERE id = ?", "UPDATE conversations SET group_id = NULL WHERE id = ?"),
            ("UPDATE conversations SET scope_mode = 'Architect' WHERE id = ?", "UPDATE conversations SET scope_mode = 'Chat' WHERE id = ?"),
        ] {
            sqlx::query(change).bind(&fixture.child_id).execute(&fixture.pool).await.unwrap();
            assert!(fixture.execute(input.clone()).await.is_err(), "{change}");
            let mut query = sqlx::query(restore);
            if restore.contains("SELECT project_id") {
                query = query.bind(&fixture.parent_id);
            }
            query.bind(&fixture.child_id).execute(&fixture.pool).await.unwrap();
        }
        assert!(fixture.execute(input).await.is_ok());
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
    async fn rejects_parent_lineage_changes_after_child_link() {
        let fixture = Fixture::new().await;
        let input = fixture.input("read", json!({"path": "proof.txt"}));
        fixture.execute(input.clone()).await.unwrap();
        for (column, select, update, changed) in [
            (
                "scope_mode",
                "SELECT scope_mode FROM conversations WHERE id = ?",
                "UPDATE conversations SET scope_mode = ? WHERE id = ?",
                "Architect",
            ),
            (
                "project_id",
                "SELECT project_id FROM conversations WHERE id = ?",
                "UPDATE conversations SET project_id = ? WHERE id = ?",
                "another-project",
            ),
            (
                "task_id",
                "SELECT task_id FROM conversations WHERE id = ?",
                "UPDATE conversations SET task_id = ? WHERE id = ?",
                "another-task",
            ),
            (
                "group_id",
                "SELECT group_id FROM conversations WHERE id = ?",
                "UPDATE conversations SET group_id = ? WHERE id = ?",
                "another-group",
            ),
        ] {
            let previous: Option<String> = sqlx::query_scalar(select)
                .bind(&fixture.parent_id)
                .fetch_one(&fixture.pool)
                .await
                .unwrap();
            sqlx::query(update)
                .bind(changed)
                .bind(&fixture.parent_id)
                .execute(&fixture.pool)
                .await
                .unwrap();
            assert!(fixture.execute(input.clone()).await.is_err(), "{column}");
            sqlx::query(update)
                .bind(previous)
                .bind(&fixture.parent_id)
                .execute(&fixture.pool)
                .await
                .unwrap();
            fixture.execute(input.clone()).await.unwrap();
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
            &fixture.metadata_root,
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
        sqlx::query("UPDATE conversations SET project_id = ? WHERE id IN (?, ?)")
            .bind(&project.id)
            .bind(&fixture.parent_id)
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
    async fn relative_project_path_uses_stable_metadata_root() {
        let fixture = Fixture::new().await;
        let project_path = fixture.workspace.join("relative-project");
        std::fs::create_dir(&project_path).unwrap();
        std::fs::write(project_path.join("proof.txt"), "relative project evidence").unwrap();
        let project = workspace::create_project(
            &fixture.workspace,
            &fixture.metadata_root,
            workspace::metadata::CreateProjectRequest {
                name: "Relative audit project".into(),
                description: String::new(),
                group_id: None,
                group_name: None,
                path: Some("relative-project".into()),
                git_flow_settings: None,
                direct_edit: true,
            },
        )
        .await
        .expect("registered relative project");
        assert_eq!(project.path, "relative-project");
        sqlx::query("UPDATE conversations SET project_id = ? WHERE id IN (?, ?)")
            .bind(&project.id)
            .bind(&fixture.parent_id)
            .bind(&fixture.child_id)
            .execute(&fixture.pool)
            .await
            .unwrap();
        let result = fixture
            .execute(fixture.input("read", json!({"path": "proof.txt"})))
            .await
            .expect("relative project read");
        assert!(result.contains("relative project evidence"));
        assert!(!result.contains("verified audit evidence"));
    }

    #[tokio::test]
    async fn git_metadata_worktree_keeps_relative_paths_anchored_to_stable_workspace() {
        let fixture = Fixture::new_with_git_metadata(true).await;
        assert!(fixture.metadata_root.join("workspace.json").is_file());
        assert!(!fixture.workspace.join("workspace.json").exists());
        let project_path = fixture.workspace.join("git-relative-project");
        std::fs::create_dir(&project_path).unwrap();
        std::fs::write(
            project_path.join("proof.txt"),
            "Git metadata project evidence",
        )
        .unwrap();
        let project = workspace::create_project(
            &fixture.workspace,
            &fixture.metadata_root,
            workspace::metadata::CreateProjectRequest {
                name: "Git relative project".into(),
                description: String::new(),
                group_id: None,
                group_name: None,
                path: Some("git-relative-project".into()),
                git_flow_settings: None,
                direct_edit: true,
            },
        )
        .await
        .expect("project in Git metadata worktree");
        sqlx::query("UPDATE conversations SET project_id = ? WHERE id IN (?, ?)")
            .bind(&project.id)
            .bind(&fixture.parent_id)
            .bind(&fixture.child_id)
            .execute(&fixture.pool)
            .await
            .unwrap();
        let result = fixture
            .execute(fixture.input("read", json!({"path": "proof.txt"})))
            .await
            .expect("Git metadata project read");
        assert!(result.contains("Git metadata project evidence"));
        assert!(!result.contains("verified audit evidence"));
    }

    #[tokio::test]
    async fn git_metadata_worktree_exposes_the_task_execution_target() {
        let fixture = Fixture::new_with_git_metadata(true).await;
        let project_id: String =
            sqlx::query_scalar("SELECT project_id FROM conversations WHERE id = ?")
                .bind(&fixture.parent_id)
                .fetch_one(&fixture.pool)
                .await
                .unwrap();
        let task = workspace::create_manual_feature_draft(
            &fixture.workspace,
            &fixture.metadata_root,
            "git-metadata-task",
            &fixture.parent_id,
            &[project_id],
            &[],
            None,
            Some("Git metadata task"),
            Some("Verify the native worktree"),
            "feature",
            Some("feature/git-metadata-task"),
            None,
        )
        .await
        .expect("task stored in Git metadata worktree");
        let key = &task.execution_targets[0].worktree_key;
        let repo = git2::Repository::open(&fixture.workspace).unwrap();
        let ensured = GitState::new()
            .ensure_task_worktree(&repo, key, "feature/git-metadata-task", None, None, &[])
            .expect("task worktree from Git metadata");
        std::fs::write(
            ensured.worktree_path.join("proof.txt"),
            "Git metadata task worktree evidence",
        )
        .unwrap();
        sqlx::query("UPDATE conversations SET task_id = 'git-metadata-task' WHERE id IN (?, ?)")
            .bind(&fixture.parent_id)
            .bind(&fixture.child_id)
            .execute(&fixture.pool)
            .await
            .unwrap();
        let result = fixture
            .execute(fixture.input("read", json!({"path": "proof.txt"})))
            .await
            .expect("Git metadata task read");
        assert!(result.contains("Git metadata task worktree evidence"));
        assert!(!result.contains("verified audit evidence"));
    }

    #[tokio::test]
    async fn direct_edit_task_reads_its_project_root_from_metadata() {
        let fixture = Fixture::new().await;
        let project_id: String =
            sqlx::query_scalar("SELECT project_id FROM conversations WHERE id = ?")
                .bind(&fixture.parent_id)
                .fetch_one(&fixture.pool)
                .await
                .unwrap();
        workspace::create_manual_feature_draft(
            &fixture.workspace,
            &fixture.metadata_root,
            "direct-audit-task",
            &fixture.parent_id,
            &[project_id.clone()],
            &[],
            None,
            Some("Direct audit task"),
            Some("Verify direct changes"),
            "direct",
            None,
            None,
        )
        .await
        .expect("direct task target");
        let catalog = workspace::list_tasks(&fixture.workspace, &fixture.metadata_root)
            .await
            .unwrap();
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.get("id").and_then(Value::as_str) == Some("direct-audit-task"))
            .unwrap();
        let target = &task["execution_targets"][0];
        assert_eq!(target["projectId"], project_id);
        assert_eq!(target["executionMode"], "direct");
        assert_eq!(target["executionKind"], "repository_root");
        sqlx::query("UPDATE conversations SET task_id = 'direct-audit-task' WHERE id IN (?, ?)")
            .bind(&fixture.parent_id)
            .bind(&fixture.child_id)
            .execute(&fixture.pool)
            .await
            .unwrap();
        let result = fixture
            .execute(fixture.input("read", json!({"path": "proof.txt"})))
            .await
            .expect("direct project read");
        assert!(result.contains("verified audit evidence"));
    }

    #[tokio::test]
    async fn task_audit_reads_the_native_task_worktree() {
        let fixture = Fixture::new().await;
        let project_path = fixture.workspace.join("source-repo");
        std::fs::create_dir(&project_path).unwrap();
        std::fs::write(project_path.join("proof.txt"), "source checkout evidence").unwrap();
        let repo = git2::Repository::init(&project_path).expect("source repository");
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("proof.txt")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let author = git2::Signature::now("Fixture", "fixture@example.invalid").unwrap();
        repo.commit(Some("HEAD"), &author, &author, "Initial", &tree, &[])
            .unwrap();
        drop(tree);
        let project = workspace::create_project(
            &fixture.workspace,
            &fixture.metadata_root,
            workspace::metadata::CreateProjectRequest {
                name: "Task source".into(),
                description: String::new(),
                group_id: None,
                group_name: None,
                path: Some(project_path.display().to_string()),
                git_flow_settings: None,
                direct_edit: false,
            },
        )
        .await
        .expect("registered source repository");
        let task_id = "audit-task";
        sqlx::query("UPDATE conversations SET project_id = ?, task_id = ? WHERE id IN (?, ?)")
            .bind(&project.id)
            .bind(task_id)
            .bind(&fixture.parent_id)
            .bind(&fixture.child_id)
            .execute(&fixture.pool)
            .await
            .unwrap();
        let task = workspace::create_manual_feature_draft(
            &fixture.workspace,
            &fixture.metadata_root,
            task_id,
            &fixture.parent_id,
            &[project.id.clone()],
            &[],
            None,
            Some("Audit task"),
            Some("Verify the worktree"),
            "feature",
            Some("feature/audit-task"),
            None,
        )
        .await
        .expect("registered task execution target");
        let catalog = workspace::list_tasks(&fixture.workspace, &fixture.metadata_root)
            .await
            .unwrap();
        let catalog_task = catalog
            .tasks
            .iter()
            .find(|entry| entry.get("id").and_then(Value::as_str) == Some(task_id))
            .unwrap();
        let catalog_target = &catalog_task["execution_targets"][0];
        assert_eq!(catalog_target["projectId"], project.id);
        assert_eq!(catalog_target["executionKind"], "worktree");
        assert_eq!(
            catalog_target["worktreeKey"],
            task.execution_targets[0].worktree_key
        );
        let key = &task.execution_targets[0].worktree_key;
        let git_state = GitState::new();
        let ensured = git_state
            .ensure_task_worktree(&repo, key, "feature/audit-task", None, None, &[])
            .expect("managed task worktree");
        std::fs::write(
            ensured.worktree_path.join("proof.txt"),
            "task worktree evidence",
        )
        .unwrap();
        let result = fixture
            .execute(fixture.input("read", json!({"path": "proof.txt"})))
            .await
            .expect("task worktree read");
        assert!(result.contains("task worktree evidence"));
        assert!(!result.contains("source checkout evidence"));
    }

    #[tokio::test]
    async fn missing_project_binding_fails_closed() {
        let fixture = Fixture::new().await;
        sqlx::query("UPDATE conversations SET project_id = NULL WHERE id = ?")
            .bind(&fixture.parent_id)
            .execute(&fixture.pool)
            .await
            .unwrap();
        assert!(fixture
            .execute(fixture.input("read", json!({"path": "proof.txt"})))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn missing_task_target_or_workspace_registry_fails_closed() {
        let fixture = Fixture::new().await;
        let input = fixture.input("read", json!({"path": "proof.txt"}));
        sqlx::query("UPDATE conversations SET task_id = 'unknown-task' WHERE id = ?")
            .bind(&fixture.parent_id)
            .execute(&fixture.pool)
            .await
            .unwrap();
        assert!(fixture.execute(input.clone()).await.is_err());
        sqlx::query("UPDATE conversations SET task_id = NULL WHERE id = ?")
            .bind(&fixture.parent_id)
            .execute(&fixture.pool)
            .await
            .unwrap();
        std::fs::remove_file(fixture.metadata_root.join("workspace.json")).unwrap();
        assert!(fixture.execute(input).await.is_err());
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
