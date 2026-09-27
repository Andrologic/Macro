use crate::core::db_state::DbPool;
use crate::core::error::Result;
use crate::git::operations::workflow::GitWorkflowSessionIdentity;
use crate::git::GitState;
use crate::WorkspaceRoot;
use tauri::State;

#[tauri::command]
pub async fn git_workflow_cleanup(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    pool: State<'_, DbPool>,
    repo_path: String,
    identity: GitWorkflowSessionIdentity,
    worktree_key: String,
    remove_remote: bool,
    expected_worktree_path: Option<String>,
) -> Result<()> {
    if crate::git::operations::parse_wsl_repo_path(&repo_path).is_some() {
        return Err(crate::git::operations::unsupported_wsl_git_operation(
            "git_workflow_cleanup",
        ));
    }
    crate::git::operations::workflow::cleanup::git_workflow_cleanup(
        workspace_root.inner().read().await.clone(),
        git_state.inner().clone(),
        pool.inner().clone(),
        repo_path,
        identity,
        worktree_key,
        remove_remote,
        expected_worktree_path,
    )
    .await
}
