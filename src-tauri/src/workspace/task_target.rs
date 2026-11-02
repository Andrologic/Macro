//! Physical resolution shared by scoped native Task consumers. Never creates a worktree.
use crate::core::command_error::{command_error, CommandResult};
use crate::git::{GitState, TaskWorktreeStatus};
use crate::workspace::metadata::WorkspaceTaskExecutionTargetDto;
use std::path::PathBuf;
pub(crate) fn resolve_task_execution_root(
    resolved: PathBuf,
    target: &WorkspaceTaskExecutionTargetDto,
    git_state: &GitState,
) -> CommandResult<PathBuf> {
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
