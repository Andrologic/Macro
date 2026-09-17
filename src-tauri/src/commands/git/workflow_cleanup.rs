use std::path::Path;

use git2::{Oid, Repository, Transaction};
use tauri::State;

use crate::commands::{get_pool, DbPool};
use crate::core::error::{BackendError, Result};
use crate::git::{GitState, TaskWorktreeStatus};
use crate::workspace;
use crate::WorkspaceRoot;

use super::*;

fn cleanup_ref(branch_name: &str) -> String {
    format!("refs/heads/{branch_name}")
}

fn source_commit(journal: &GitWorkflowJournal) -> Result<Oid> {
    parse_oid(&journal.session.source_commit, "source")
}

fn source_is_expected_or_absent(repo: &Repository, journal: &GitWorkflowJournal) -> Result<bool> {
    let expected = source_commit(journal)?;
    match local_branch_commit(repo, &journal.session.source_branch) {
        Ok(actual) if actual == expected => Ok(true),
        Ok(actual) => Err(workflow_error(format!(
            "Refusing workflow cleanup because source branch {} changed from {} to {}.",
            journal.session.source_branch, expected, actual
        ))),
        Err(BackendError::GitBranchNotFound { .. }) => Ok(false),
        Err(error) => Err(error),
    }
}

fn verify_cleanup_session(
    repo: &Repository,
    journal: &GitWorkflowJournal,
    identity: &GitWorkflowSessionIdentity,
) -> Result<()> {
    validate_journal_repository(repo, journal)?;
    session_matches(
        &journal.session,
        &identity.task_id,
        &identity.source_branch,
        &identity.target_branch,
    )?;
    if journal.session.session_id != identity.session_id {
        return Err(workflow_error(
            "The supplied Git workflow session is not the journaled session.",
        ));
    }
    if journal.pending_abort || journal.pending_rebase.is_some() {
        return Err(workflow_error(
            "Refusing workflow cleanup while a journaled Git operation is unresolved.",
        ));
    }
    if journal.session.status != WorkflowStatus::Integrated.as_str() {
        return Err(workflow_error(
            "Workflow cleanup requires an integrated Git workflow session.",
        ));
    }
    validate_integrated_state(repo, journal)?;
    Ok(())
}

fn lock_cleanup_refs<'repo>(
    repo: &'repo Repository,
    journal: &GitWorkflowJournal,
) -> Result<Transaction<'repo>> {
    let mut transaction = repo
        .transaction()
        .map_err(|error| workflow_error(error.to_string()))?;
    transaction
        .lock_ref(&cleanup_ref(&journal.session.source_branch))
        .map_err(|error| workflow_error(error.to_string()))?;
    transaction
        .lock_ref(&cleanup_ref(&journal.session.target_branch))
        .map_err(|error| workflow_error(error.to_string()))?;
    Ok(transaction)
}

fn ensure_source_is_not_checked_out(repo: &Repository, branch_name: &str) -> Result<()> {
    if super::super::get_branch_name(repo)?.as_deref() == Some(branch_name)
        || super::super::find_worktree_path_for_branch(
            &super::super::repo_root(repo)?,
            branch_name,
        )?
        .is_some()
    {
        return Err(workflow_error(format!(
            "Refusing to delete checked out branch: {branch_name}"
        )));
    }
    Ok(())
}

fn remote_branch_oid<F>(
    repo_root: &Path,
    branch_name: &str,
    run_network: &mut F,
) -> Result<Option<String>>
where
    F: FnMut(&Path, &[String]) -> Result<super::super::GitCommandOutput>,
{
    let output = run_network(
        repo_root,
        &[
            "ls-remote".to_string(),
            "--heads".to_string(),
            "origin".to_string(),
            format!("refs/heads/{branch_name}"),
        ],
    )?;
    if !output.success {
        return Err(workflow_error(format!(
            "git ls-remote failed: {}",
            super::super::command_output_text(&output)
        )));
    }
    Ok(output
        .stdout
        .lines()
        .find_map(|line| line.split_whitespace().next())
        .filter(|oid| !oid.is_empty())
        .map(str::to_owned))
}

fn delete_remote_branch_if_present<F>(
    repo: &Repository,
    journal: &GitWorkflowJournal,
    run_network: &mut F,
) -> Result<()>
where
    F: FnMut(&Path, &[String]) -> Result<super::super::GitCommandOutput>,
{
    match repo.find_remote("origin") {
        Ok(_) => {}
        Err(error) if error.code() == git2::ErrorCode::NotFound => return Ok(()),
        Err(error) => {
            return Err(BackendError::Git {
                message: format!("Failed to inspect origin remote: {error}"),
            });
        }
    }

    let root = super::super::repo_root(repo)?;
    let branch_name = &journal.session.source_branch;
    let expected = journal.session.source_commit.as_str();
    let Some(actual) = remote_branch_oid(&root, branch_name, run_network)? else {
        return Ok(());
    };
    if actual != expected {
        return Err(workflow_error(format!(
            "Refusing remote branch deletion because origin/{branch_name} changed from {expected} to {actual}."
        )));
    }

    let output = run_network(
        &root,
        &[
            "push".to_string(),
            "origin".to_string(),
            "--delete".to_string(),
            format!("--force-with-lease=refs/heads/{branch_name}:{expected}"),
            branch_name.clone(),
        ],
    )?;
    if !output.success {
        return Err(workflow_error(format!(
            "git push --delete failed: {}",
            super::super::command_output_text(&output)
        )));
    }
    Ok(())
}

pub(crate) fn cleanup_integrated_repo(
    repo: &Repository,
    git_state: &GitState,
    journal: &GitWorkflowJournal,
    identity: &GitWorkflowSessionIdentity,
    worktree_key: &str,
    remove_remote: bool,
    expected_worktree_path: Option<&str>,
) -> Result<()> {
    cleanup_integrated_repo_with_network(
        repo,
        git_state,
        journal,
        identity,
        worktree_key,
        remove_remote,
        expected_worktree_path,
        |root, args| {
            super::super::run_git_command_with_timeout(
                root,
                args,
                super::super::NATIVE_GIT_NETWORK_TIMEOUT,
            )
        },
    )
}

fn cleanup_integrated_repo_with_network<F>(
    repo: &Repository,
    git_state: &GitState,
    journal: &GitWorkflowJournal,
    identity: &GitWorkflowSessionIdentity,
    worktree_key: &str,
    remove_remote: bool,
    expected_worktree_path: Option<&str>,
    mut run_network: F,
) -> Result<()>
where
    F: FnMut(&Path, &[String]) -> Result<super::super::GitCommandOutput>,
{
    verify_cleanup_session(repo, journal, identity)?;
    let mut transaction = lock_cleanup_refs(repo, journal)?;

    // The target ref stays locked while ancestry is checked. An external
    // update-ref therefore fails instead of racing the cleanup decision.
    verify_cleanup_session(repo, journal, identity)?;
    let inspection = git_state.diagnose_task_worktree(
        repo,
        worktree_key,
        Some(&journal.session.source_branch),
    )?;
    match inspection.status {
        TaskWorktreeStatus::Ready => {
            super::super::verify_expected_worktree_identity(
                repo,
                &journal.session.source_branch,
                &inspection.worktree_path,
                inspection.branch_name.as_deref(),
                Some(&journal.session.source_commit),
                expected_worktree_path,
            )?;
        }
        TaskWorktreeStatus::Absent => {}
        TaskWorktreeStatus::StaleRegistration => {
            // A crash can happen after removing the directory but before
            // pruning registration. Verify the surviving admin state before
            // allowing the normal managed-worktree helper to finish pruning.
            let admin = repo
                .commondir()
                .join("worktrees")
                .join(&inspection.worktree_name);
            let worktree_repo = Repository::open_ext(
                &admin,
                git2::RepositoryOpenFlags::BARE | git2::RepositoryOpenFlags::NO_SEARCH,
                std::iter::empty::<&Path>(),
            )?;
            if inspection.worktree_path.try_exists()?
                || super::super::get_branch_name(&worktree_repo)?.as_deref()
                    != Some(journal.session.source_branch.as_str())
            {
                return Err(workflow_error(
                    "Stale worktree registration no longer belongs to the integrated source.",
                ));
            }
            let mut index = git2::Index::open(&admin.join("index"))?;
            if index.has_conflicts()
                || index.write_tree_to(repo)?
                    != repo.find_commit(source_commit(journal)?)?.tree_id()
            {
                return Err(workflow_error(
                    "Stale worktree contains unintegrated staged data.",
                ));
            }
            super::super::verify_expected_worktree_identity(
                repo,
                &journal.session.source_branch,
                &inspection.worktree_path,
                Some(&journal.session.source_branch),
                Some(&journal.session.source_commit),
                expected_worktree_path,
            )?;
        }
        TaskWorktreeStatus::OrphanPath | TaskWorktreeStatus::InvalidRepo => {
            return Err(workflow_error(format!(
                "Refusing workflow cleanup because worktree {worktree_key} is not a managed ready worktree."
            )));
        }
    }

    // This helper performs the same clean, managed-path and root checks as the
    // regular worktree command. It never force-removes user files.
    git_state.remove_task_worktree(
        repo,
        worktree_key,
        false,
        Some(&journal.session.source_branch),
    )?;

    let source_exists_after_worktree = source_is_expected_or_absent(repo, journal)?;
    if source_exists_after_worktree {
        ensure_source_is_not_checked_out(repo, &journal.session.source_branch)?;
    }

    // Keep the source ref untouched when the remote lease fails. A retry can
    // then remove the remote and finish the local transaction idempotently.
    if remove_remote {
        delete_remote_branch_if_present(repo, journal, &mut run_network)?;
    }

    if source_exists_after_worktree {
        transaction
            .remove(&cleanup_ref(&journal.session.source_branch))
            .map_err(|error| workflow_error(error.to_string()))?;
    }
    transaction
        .commit()
        .map_err(|error| workflow_error(error.to_string()))?;
    Ok(())
}

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
    if super::super::parse_wsl_repo_path(&repo_path).is_some() {
        return Err(super::super::unsupported_wsl_git_operation(
            "git_workflow_cleanup",
        ));
    }

    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();
    let validated = super::super::validate_repo_path(&repo_path, &workspace)?;
    let _repo_guard = workspace::lock_git_repository(&validated).await?;
    let pool = get_pool(&pool)
        .await
        .map_err(|error| BackendError::Database {
            message: error.message,
        })?;
    let request_repo = git_state.open_repo(&validated)?;
    let key = {
        let repo = request_repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;
        workflow_key(
            &repo,
            &identity.task_id,
            &identity.source_branch,
            &identity.target_branch,
        )?
    };
    let journal = load_journal_for_key(&pool, &key).await?;
    session_guard::verify_requested_session(Some(&journal), Some(&identity.session_id), "cleanup")?;
    ensure_workflow_exclusive(&pool, Path::new(&journal.common_dir), &key).await?;

    tokio::task::spawn_blocking(move || {
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;
        cleanup_integrated_repo(
            &repo,
            &git_state,
            &journal,
            &identity,
            &worktree_key,
            remove_remote,
            expected_worktree_path.as_deref(),
        )
    })
    .await
    .map_err(to_join_error)?
}

#[cfg(test)]
#[path = "workflow_cleanup_tests.rs"]
mod tests;
