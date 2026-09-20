use crate::commands::{get_pool, DbPool};
use crate::core::error::{BackendError, Result};
pub use crate::git::operations::workflow::*;
use crate::git::GitState;
use crate::WorkspaceRoot;
use std::path::Path;
use tauri::State;
#[path = "workflow_cleanup.rs"]
pub(crate) mod cleanup;

/// Legacy merge commands may operate on ordinary Git merges, but must not
/// bypass the owner of a prepared/conflicted workflow, even after a restart.
pub(crate) async fn ensure_unowned_merge_access(
    pool: &State<'_, DbPool>,
    git_state: &GitState,
    path: &Path,
) -> Result<()> {
    let pool = get_pool(pool)
        .await
        .map_err(|error| BackendError::Database {
            message: error.message,
        })?;
    crate::git::operations::workflow::ensure_unowned_merge_access(&pool, git_state, path).await
}

#[tauri::command]
pub async fn git_workflow(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    pool: State<'_, DbPool>,
    repo_path: String,
    task_id: String,
    source_branch: String,
    target_branch: String,
    action: String,
    plan_id: Option<String>,
    storage_branch: Option<String>,
    expected_session_id: Option<String>,
) -> Result<Option<GitWorkflowSessionDto>> {
    let workspace = workspace_root.inner().read().await.clone();
    let pool = get_pool(&pool)
        .await
        .map_err(|error| BackendError::Database {
            message: error.message,
        })?;
    dispatch_workflow(
        &workspace,
        git_state.inner().clone(),
        pool,
        repo_path,
        task_id,
        source_branch,
        target_branch,
        action,
        plan_id,
        storage_branch,
        expected_session_id,
    )
    .await
}
