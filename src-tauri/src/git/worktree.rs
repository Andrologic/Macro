use std::fs;
use std::path::{Path, PathBuf};

use git2::{BranchType, ErrorCode, Repository, WorktreeAddOptions};

use crate::core::error::{BackendError, Result};
use crate::git::repo::get_status_options;

use super::{ensure_task_worktree_gitignore_rule, GitState};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskWorktreeStatus {
    Absent,
    Ready,
    StaleRegistration,
    OrphanPath,
    InvalidRepo,
}

impl TaskWorktreeStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::Ready => "ready",
            Self::StaleRegistration => "stale_registration",
            Self::OrphanPath => "orphan_path",
            Self::InvalidRepo => "invalid_repo",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskWorktreeEnsureStatus {
    Created,
    Reused,
    Repaired,
}

impl TaskWorktreeEnsureStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Reused => "reused",
            Self::Repaired => "repaired",
        }
    }
}

#[derive(Debug, Clone)]
pub struct TaskWorktreeInspection {
    pub task_id: String,
    pub worktree_name: String,
    pub worktree_path: PathBuf,
    pub registered_path: Option<PathBuf>,
    pub branch_name: Option<String>,
    pub status: TaskWorktreeStatus,
    pub is_dirty: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct TaskWorktreeEnsureResult {
    pub task_id: String,
    pub worktree_path: PathBuf,
    pub branch_name: String,
    pub status: TaskWorktreeEnsureStatus,
}

#[derive(Debug, Clone)]
pub struct TaskWorktreeRemoveResult {
    pub task_id: String,
    pub worktree_path: PathBuf,
    pub removed_path: bool,
    pub pruned_registration: bool,
    pub already_absent: bool,
}

fn task_worktree_name(task_id: &str) -> String {
    format!("task{}", task_id)
}

fn task_worktree_root(repo: &Repository) -> Result<PathBuf> {
    let workdir = repo.workdir().ok_or_else(|| BackendError::Git {
        message: "Bare repositories are not supported for worktrees".to_string(),
    })?;
    Ok(workdir.join(".macro").join("worktrees"))
}

fn task_worktree_path(repo: &Repository, task_id: &str) -> Result<PathBuf> {
    Ok(task_worktree_root(repo)?.join(task_worktree_name(task_id)))
}

fn current_branch_name(repo: &Repository) -> Option<String> {
    repo.head()
        .ok()
        .and_then(|head| head.shorthand().map(|value| value.to_string()))
}

fn is_dirty(repo: &Repository) -> Result<bool> {
    let statuses = repo.statuses(Some(&mut get_status_options()))?;
    Ok(!statuses.is_empty())
}

enum RepoProbe {
    Missing,
    Ready(Repository),
    Invalid,
}

fn probe_repo_path(path: &Path) -> RepoProbe {
    if !path.exists() {
        return RepoProbe::Missing;
    }

    match Repository::open(path) {
        Ok(repo) => RepoProbe::Ready(repo),
        Err(err) if err.code() == ErrorCode::NotFound => RepoProbe::Missing,
        Err(_) => RepoProbe::Invalid,
    }
}

fn remove_path_if_present(path: &Path) -> Result<bool> {
    if !path.exists() {
        return Ok(false);
    }

    let metadata = fs::symlink_metadata(path).map_err(|e| BackendError::Io {
        message: e.to_string(),
        source: e,
    })?;
    if metadata.is_dir() {
        fs::remove_dir_all(path).map_err(|e| BackendError::Io {
            message: e.to_string(),
            source: e,
        })?;
    } else {
        fs::remove_file(path).map_err(|e| BackendError::Io {
            message: e.to_string(),
            source: e,
        })?;
    }

    Ok(true)
}

fn prune_worktree(repo: &Repository, worktree_name: &str) -> Result<bool> {
    let worktree = match repo.find_worktree(worktree_name) {
        Ok(worktree) => worktree,
        Err(err) if err.code() == ErrorCode::NotFound => return Ok(false),
        Err(err) => {
            return Err(BackendError::Git {
                message: format!("Failed to inspect worktree '{}': {}", worktree_name, err),
            });
        }
    };

    let mut opts = git2::WorktreePruneOptions::new();
    opts.valid(true);
    worktree
        .prune(Some(&mut opts))
        .map_err(|e| BackendError::Git {
            message: format!("Failed to prune worktree '{}': {}", worktree_name, e),
        })?;
    Ok(true)
}

fn inspect_registered_worktree(
    task_id: &str,
    worktree_name: String,
    registered_path: PathBuf,
) -> Result<TaskWorktreeInspection> {
    if !registered_path.exists() {
        return Ok(TaskWorktreeInspection {
            task_id: task_id.to_string(),
            worktree_name,
            worktree_path: registered_path.clone(),
            registered_path: Some(registered_path),
            branch_name: None,
            status: TaskWorktreeStatus::StaleRegistration,
            is_dirty: None,
        });
    }

    match probe_repo_path(&registered_path) {
        RepoProbe::Ready(worktree_repo) => Ok(TaskWorktreeInspection {
            task_id: task_id.to_string(),
            worktree_name,
            worktree_path: registered_path.clone(),
            registered_path: Some(registered_path),
            branch_name: current_branch_name(&worktree_repo),
            status: TaskWorktreeStatus::Ready,
            is_dirty: Some(is_dirty(&worktree_repo)?),
        }),
        RepoProbe::Missing => Ok(TaskWorktreeInspection {
            task_id: task_id.to_string(),
            worktree_name,
            worktree_path: registered_path.clone(),
            registered_path: Some(registered_path),
            branch_name: None,
            status: TaskWorktreeStatus::StaleRegistration,
            is_dirty: None,
        }),
        RepoProbe::Invalid => Ok(TaskWorktreeInspection {
            task_id: task_id.to_string(),
            worktree_name,
            worktree_path: registered_path.clone(),
            registered_path: Some(registered_path),
            branch_name: None,
            status: TaskWorktreeStatus::InvalidRepo,
            is_dirty: None,
        }),
    }
}

fn find_ready_worktree_for_branch(
    repo: &Repository,
    task_id: &str,
    branch_name: &str,
    excluded_worktree_name: &str,
) -> Result<Option<TaskWorktreeInspection>> {
    let worktree_names = repo.worktrees().map_err(|e| BackendError::Git {
        message: format!("Failed to list registered worktrees: {}", e),
    })?;

    for candidate_name in worktree_names.iter().flatten() {
        if candidate_name == excluded_worktree_name {
            continue;
        }

        let worktree = match repo.find_worktree(candidate_name) {
            Ok(worktree) => worktree,
            Err(err) if err.code() == ErrorCode::NotFound => continue,
            Err(err) => {
                return Err(BackendError::Git {
                    message: format!(
                        "Failed to inspect candidate worktree '{}': {}",
                        candidate_name, err
                    ),
                });
            }
        };

        let candidate_path = worktree.path().to_path_buf();
        let inspection =
            inspect_registered_worktree(task_id, candidate_name.to_string(), candidate_path)?;

        if inspection.status == TaskWorktreeStatus::Ready
            && inspection.branch_name.as_deref() == Some(branch_name)
        {
            return Ok(Some(inspection));
        }
    }

    Ok(None)
}

fn release_branch_from_primary_workdir(repo: &Repository, branch_name: &str) -> Result<()> {
    if current_branch_name(repo).as_deref() != Some(branch_name) {
        return Ok(());
    }

    if is_dirty(repo)? {
        return Err(BackendError::GitRepositoryNotClean {
            message: format!(
                "Cannot create a task worktree for '{}' because that branch is still checked out in the primary repository and has uncommitted changes",
                branch_name
            ),
        });
    }

    let current_commit = repo
        .head()
        .and_then(|head| head.peel_to_commit())
        .map_err(|_| BackendError::Git {
            message: format!(
                "Cannot release branch '{}' from the primary repository without a valid HEAD commit",
                branch_name
            ),
        })?;

    repo.set_head_detached(current_commit.id())?;

    Ok(())
}

impl GitState {
    fn clear_worktree_cache(&self, task_id: &str) {
        if let Ok(mut map) = self.inner.worktrees.lock() {
            map.remove(task_id);
        }
    }

    fn inspect_task_worktree_internal(
        &self,
        repo: &Repository,
        task_id: &str,
        branch_name: Option<&str>,
    ) -> Result<TaskWorktreeInspection> {
        let worktree_name = task_worktree_name(task_id);
        let expected_path = task_worktree_path(repo, task_id)?;

        if self
            .get_worktree(task_id)
            .is_some_and(|cached| cached != expected_path || !cached.exists())
        {
            self.clear_worktree_cache(task_id);
        }

        let registered_path = match repo.find_worktree(&worktree_name) {
            Ok(worktree) => Some(worktree.path().to_path_buf()),
            Err(err) if err.code() == ErrorCode::NotFound => None,
            Err(err) => {
                return Err(BackendError::Git {
                    message: format!("Failed to inspect worktree '{}': {}", worktree_name, err),
                });
            }
        };

        if let Some(path) = registered_path.clone() {
            return inspect_registered_worktree(task_id, worktree_name, path);
        }

        if expected_path.exists() {
            match probe_repo_path(&expected_path) {
                RepoProbe::Ready(worktree_repo) => {
                    return Ok(TaskWorktreeInspection {
                        task_id: task_id.to_string(),
                        worktree_name,
                        worktree_path: expected_path.clone(),
                        registered_path: None,
                        branch_name: current_branch_name(&worktree_repo),
                        status: TaskWorktreeStatus::OrphanPath,
                        is_dirty: Some(is_dirty(&worktree_repo)?),
                    });
                }
                RepoProbe::Missing => {}
                RepoProbe::Invalid => {
                    return Ok(TaskWorktreeInspection {
                        task_id: task_id.to_string(),
                        worktree_name,
                        worktree_path: expected_path,
                        registered_path: None,
                        branch_name: None,
                        status: TaskWorktreeStatus::InvalidRepo,
                        is_dirty: None,
                    });
                }
            }

            return Ok(TaskWorktreeInspection {
                task_id: task_id.to_string(),
                worktree_name,
                worktree_path: expected_path,
                registered_path: None,
                branch_name: None,
                status: TaskWorktreeStatus::OrphanPath,
                is_dirty: None,
            });
        }

        let absent = TaskWorktreeInspection {
            task_id: task_id.to_string(),
            worktree_name,
            worktree_path: expected_path,
            registered_path: None,
            branch_name: None,
            status: TaskWorktreeStatus::Absent,
            is_dirty: None,
        };

        if let Some(branch_name) = branch_name {
            if let Some(branch_worktree) =
                find_ready_worktree_for_branch(repo, task_id, branch_name, &absent.worktree_name)?
            {
                return Ok(branch_worktree);
            }
        }

        Ok(absent)
    }

    #[allow(dead_code)]
    pub fn inspect_task_worktree(
        &self,
        repo: &Repository,
        task_id: &str,
    ) -> Result<TaskWorktreeInspection> {
        self.inspect_task_worktree_internal(repo, task_id, None)
    }

    #[allow(dead_code)]
    pub fn inspect_task_worktree_for_branch(
        &self,
        repo: &Repository,
        task_id: &str,
        branch_name: &str,
    ) -> Result<TaskWorktreeInspection> {
        self.inspect_task_worktree_internal(repo, task_id, Some(branch_name))
    }

    #[allow(dead_code)]
    pub fn ensure_task_worktree(
        &self,
        repo: &Repository,
        task_id: &str,
        branch_name: &str,
        from_ref: Option<&str>,
        preferred_commit_branch: Option<&str>,
    ) -> Result<TaskWorktreeEnsureResult> {
        let workdir = repo.workdir().ok_or_else(|| BackendError::Git {
            message: "Bare repositories are not supported for worktrees".to_string(),
        })?;

        let expected_worktree_name = task_worktree_name(task_id);
        let mut inspection =
            self.inspect_task_worktree_internal(repo, task_id, Some(branch_name))?;
        let mut repaired = false;

        match inspection.status {
            TaskWorktreeStatus::Ready => {
                ensure_task_worktree_gitignore_rule(repo, workdir, preferred_commit_branch)?;
                self.register_worktree(task_id, inspection.worktree_path.clone());
                return Ok(TaskWorktreeEnsureResult {
                    task_id: task_id.to_string(),
                    worktree_path: inspection.worktree_path,
                    branch_name: inspection
                        .branch_name
                        .unwrap_or_else(|| branch_name.to_string()),
                    status: if inspection.worktree_name == expected_worktree_name {
                        TaskWorktreeEnsureStatus::Reused
                    } else {
                        TaskWorktreeEnsureStatus::Repaired
                    },
                });
            }
            TaskWorktreeStatus::StaleRegistration
            | TaskWorktreeStatus::OrphanPath
            | TaskWorktreeStatus::InvalidRepo => {
                if let Some(path) = inspection.registered_path.as_ref() {
                    let _ = remove_path_if_present(path)?;
                }
                if inspection.worktree_path
                    != inspection.registered_path.clone().unwrap_or_default()
                {
                    let _ = remove_path_if_present(&inspection.worktree_path)?;
                }
                let _ = prune_worktree(repo, &inspection.worktree_name)?;
                self.clear_worktree_cache(task_id);
                repaired = true;
            }
            TaskWorktreeStatus::Absent => {}
        }

        if repaired {
            inspection = self.inspect_task_worktree_internal(repo, task_id, Some(branch_name))?;
            if inspection.status == TaskWorktreeStatus::Ready {
                ensure_task_worktree_gitignore_rule(repo, workdir, preferred_commit_branch)?;
                self.register_worktree(task_id, inspection.worktree_path.clone());
                return Ok(TaskWorktreeEnsureResult {
                    task_id: task_id.to_string(),
                    worktree_path: inspection.worktree_path,
                    branch_name: inspection
                        .branch_name
                        .unwrap_or_else(|| branch_name.to_string()),
                    status: TaskWorktreeEnsureStatus::Repaired,
                });
            }
        }

        let worktree_root = task_worktree_root(repo)?;
        fs::create_dir_all(&worktree_root).map_err(|e| BackendError::Io {
            message: e.to_string(),
            source: e,
        })?;

        if repo.find_branch(branch_name, BranchType::Local).is_err() {
            let branch_commit =
                if let Some(from_ref) = from_ref.map(str::trim).filter(|value| !value.is_empty()) {
                    repo.revparse_single(from_ref)
                        .and_then(|object| object.peel_to_commit())
                        .map_err(|_| BackendError::Git {
                            message: format!(
                                "Cannot create branch '{}' from reference '{}'",
                                branch_name, from_ref
                            ),
                        })?
                } else {
                    repo.head()
                        .and_then(|head| head.peel_to_commit())
                        .map_err(|_| BackendError::Git {
                            message: "Cannot create branch without an initial commit".to_string(),
                        })?
                };
            repo.branch(branch_name, &branch_commit, false)?;
        }

        release_branch_from_primary_workdir(repo, branch_name)?;
        ensure_task_worktree_gitignore_rule(repo, workdir, preferred_commit_branch)?;

        let worktree_path = task_worktree_path(repo, task_id)?;
        let reference = repo
            .find_reference(&format!("refs/heads/{}", branch_name))
            .map_err(|e| BackendError::Git {
                message: format!("Failed to find branch '{}': {}", branch_name, e),
            })?;

        let mut opts = WorktreeAddOptions::new();
        opts.reference(Some(&reference));

        repo.worktree(&inspection.worktree_name, &worktree_path, Some(&opts))
            .map_err(|e| BackendError::Git {
                message: format!(
                    "Failed to create worktree '{}': {}",
                    inspection.worktree_name, e
                ),
            })?;

        let created_repo = Repository::open(&worktree_path).map_err(|e| BackendError::Git {
            message: format!(
                "Failed to verify created task worktree {}: {}",
                worktree_path.display(),
                e
            ),
        })?;
        let created_branch_name =
            current_branch_name(&created_repo).unwrap_or_else(|| branch_name.to_string());

        self.register_worktree(task_id, worktree_path.clone());

        Ok(TaskWorktreeEnsureResult {
            task_id: task_id.to_string(),
            worktree_path,
            branch_name: created_branch_name,
            status: if repaired {
                TaskWorktreeEnsureStatus::Repaired
            } else {
                TaskWorktreeEnsureStatus::Created
            },
        })
    }

    #[allow(dead_code)]
    pub fn remove_task_worktree(
        &self,
        repo: &Repository,
        task_id: &str,
        force: bool,
        branch_name: Option<&str>,
    ) -> Result<TaskWorktreeRemoveResult> {
        let inspection = self.inspect_task_worktree_internal(repo, task_id, branch_name)?;
        if !force && inspection.is_dirty.unwrap_or(false) {
            return Err(BackendError::GitRepositoryNotClean {
                message: format!(
                    "Worktree {} has uncommitted changes",
                    inspection.worktree_path.display()
                ),
            });
        }

        let mut removed_path = false;
        if let Some(path) = inspection.registered_path.as_ref() {
            removed_path = remove_path_if_present(path)? || removed_path;
        }
        removed_path = remove_path_if_present(&inspection.worktree_path)? || removed_path;

        let pruned_registration = prune_worktree(repo, &inspection.worktree_name)?;
        self.clear_worktree_cache(task_id);

        Ok(TaskWorktreeRemoveResult {
            task_id: task_id.to_string(),
            worktree_path: inspection.worktree_path,
            removed_path,
            pruned_registration,
            already_absent: !removed_path && !pruned_registration,
        })
    }
}
