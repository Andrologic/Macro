use std::ffi::OsString;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use git2::{build::CheckoutBuilder, BranchType, ErrorCode, Repository, WorktreeAddOptions};

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

#[derive(Debug, Clone)]
pub struct BranchWorktreeInspection {
    pub worktree_key: String,
    pub worktree_name: String,
    pub worktree_path: PathBuf,
    pub registered_path: Option<PathBuf>,
    pub branch_name: Option<String>,
    pub status: TaskWorktreeStatus,
    pub is_dirty: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct BranchWorktreeEnsureResult {
    pub worktree_key: String,
    pub worktree_path: PathBuf,
    pub branch_name: String,
    pub status: TaskWorktreeEnsureStatus,
}

#[derive(Debug, Clone)]
pub struct BranchWorktreeRemoveResult {
    pub worktree_key: String,
    pub worktree_path: PathBuf,
    pub removed_path: bool,
    pub pruned_registration: bool,
    pub already_absent: bool,
}

fn branch_inspection_from_task(value: TaskWorktreeInspection) -> BranchWorktreeInspection {
    BranchWorktreeInspection {
        worktree_key: value.task_id,
        worktree_name: value.worktree_name,
        worktree_path: value.worktree_path,
        registered_path: value.registered_path,
        branch_name: value.branch_name,
        status: value.status,
        is_dirty: value.is_dirty,
    }
}

fn task_worktree_name(task_id: &str) -> String {
    format!("task{}", sanitize_worktree_key(task_id))
}

fn stable_hash(value: &str) -> String {
    let mut hash: u32 = 2166136261;
    for byte in value.as_bytes() {
        hash ^= *byte as u32;
        hash = hash.wrapping_mul(16777619);
    }
    format!("{:08x}", hash)
}

fn sanitize_worktree_key(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();

    if sanitized.is_empty() {
        stable_hash(value)
    } else if sanitized.len() > 48 {
        format!("{}-{}", &sanitized[..40], stable_hash(value))
    } else {
        sanitized
    }
}

fn branch_worktree_name(worktree_key: &str) -> String {
    format!("macro-integration-{}", sanitize_worktree_key(worktree_key))
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

fn branch_worktree_path(repo: &Repository, worktree_key: &str) -> Result<PathBuf> {
    Ok(task_worktree_root(repo)?.join(format!(
        "integration-{}",
        sanitize_worktree_key(worktree_key)
    )))
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

fn has_merge_conflicts(repo: &Repository) -> Result<bool> {
    repo.index()
        .map(|index| index.has_conflicts())
        .map_err(|e| BackendError::Git {
            message: format!("Failed to inspect repository index: {}", e),
        })
}

fn checkout_existing_local_branch(repo: &Repository, branch_name: &str) -> Result<()> {
    let ref_name = format!("refs/heads/{}", branch_name);
    let object = repo.revparse_single(&ref_name)?;
    let mut checkout = CheckoutBuilder::new();
    checkout.safe();
    repo.checkout_tree(&object, Some(&mut checkout))
        .map_err(|e| BackendError::GitConflict {
            message: e.to_string(),
        })?;
    repo.set_head(&ref_name)?;
    Ok(())
}

fn ensure_local_branch_from_remote(repo: &Repository, branch_name: &str) -> Result<bool> {
    if repo.find_branch(branch_name, BranchType::Local).is_ok() {
        return Ok(true);
    }

    let remote_name = format!("origin/{}", branch_name);
    let Ok(remote_branch) = repo.find_branch(&remote_name, BranchType::Remote) else {
        return Ok(false);
    };
    let commit = remote_branch
        .get()
        .peel_to_commit()
        .map_err(|e| BackendError::Git {
            message: format!(
                "Cannot create local branch '{}' from remote '{}': {}",
                branch_name, remote_name, e
            ),
        })?;
    repo.branch(branch_name, &commit, false)
        .map_err(|e| BackendError::Git {
            message: format!("Failed to create local branch '{}': {}", branch_name, e),
        })?;
    Ok(true)
}

fn checkout_first_stable_fallback(
    repo: &Repository,
    branch_name: &str,
    fallback_branches: &[String],
) -> Result<()> {
    let mut attempted = Vec::new();

    for fallback in fallback_branches
        .iter()
        .map(|branch| branch.trim())
        .filter(|branch| !branch.is_empty() && *branch != branch_name)
    {
        if attempted.iter().any(|seen| seen == fallback) {
            continue;
        }
        attempted.push(fallback.to_string());

        if !ensure_local_branch_from_remote(repo, fallback)? {
            continue;
        }

        match checkout_existing_local_branch(repo, fallback) {
            Ok(()) => return Ok(()),
            Err(BackendError::GitConflict { message }) | Err(BackendError::Git { message })
                if message.to_lowercase().contains("already checked out") =>
            {
                continue;
            }
            Err(error) => return Err(error),
        }
    }

    Err(BackendError::GitRepositoryNotClean {
        message: format!(
            "Cannot create a worktree for '{}' because that branch is checked out in the repository root and no stable fallback branch could be checked out. Fetch, create, or configure baseBranch/mainBranch, then retry. Tried: {}",
            branch_name,
            if attempted.is_empty() {
                "the project base or main branch".to_string()
            } else {
                attempted.join(", ")
            }
        ),
    })
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

fn split_lexical_path(path: &Path) -> (Option<OsString>, bool, Vec<OsString>) {
    let mut prefix = None;
    let mut rooted = false;
    let mut parts = Vec::new();

    for component in path.components() {
        match component {
            Component::Prefix(value) => prefix = Some(value.as_os_str().to_os_string()),
            Component::RootDir => rooted = true,
            Component::CurDir => {}
            Component::ParentDir => match parts.last() {
                Some(last) if last != ".." => {
                    parts.pop();
                }
                _ => parts.push(OsString::from("..")),
            },
            Component::Normal(value) => parts.push(value.to_os_string()),
        }
    }

    (prefix, rooted, parts)
}

fn lexical_relative_path(target: &Path, base: &Path) -> Option<PathBuf> {
    let target = fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());
    let base = fs::canonicalize(base).unwrap_or_else(|_| base.to_path_buf());
    let (target_prefix, target_rooted, target_parts) = split_lexical_path(&target);
    let (base_prefix, base_rooted, base_parts) = split_lexical_path(&base);

    if target_prefix != base_prefix || target_rooted != base_rooted {
        return None;
    }

    let mut common = 0;
    while common < target_parts.len()
        && common < base_parts.len()
        && target_parts[common] == base_parts[common]
    {
        common += 1;
    }

    let mut relative = PathBuf::new();
    for _ in common..base_parts.len() {
        relative.push("..");
    }
    for part in target_parts.iter().skip(common) {
        relative.push(part);
    }

    if relative.as_os_str().is_empty() {
        Some(PathBuf::from("."))
    } else {
        Some(relative)
    }
}

fn git_path_for_file(target: &Path, base: &Path) -> String {
    lexical_relative_path(target, base)
        .unwrap_or_else(|| target.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
}

fn write_if_changed(path: &Path, content: &str) -> Result<bool> {
    if fs::read_to_string(path).ok().as_deref() == Some(content) {
        return Ok(false);
    }
    fs::write(path, content).map_err(|e| BackendError::Io {
        message: e.to_string(),
        source: e,
    })?;
    Ok(true)
}

pub(crate) fn repair_gitfile_worktree_links(
    repo: &Repository,
    worktree_name: &str,
    worktree_path: &Path,
) -> Result<bool> {
    let git_file_path = worktree_path.join(".git");
    let git_dir = repo.path();
    let admin_dir = git_dir.join("worktrees").join(worktree_name);

    if !git_file_path.is_file() || !admin_dir.is_dir() {
        return Ok(false);
    }

    if Repository::open(worktree_path).is_ok() {
        return Ok(false);
    }

    let previous_git_file = fs::read_to_string(&git_file_path).ok();
    let previous_admin_gitdir = fs::read_to_string(admin_dir.join("gitdir")).ok();
    let previous_commondir = fs::read_to_string(admin_dir.join("commondir")).ok();

    let git_file_content = format!("gitdir: {}\n", git_path_for_file(&admin_dir, worktree_path));
    let admin_gitdir_content = format!("{}\n", git_path_for_file(&git_file_path, &admin_dir));
    let commondir_content = format!("{}\n", git_path_for_file(git_dir, &admin_dir));

    let mut changed = false;
    changed |= write_if_changed(&git_file_path, &git_file_content)?;
    changed |= write_if_changed(&admin_dir.join("gitdir"), &admin_gitdir_content)?;
    changed |= write_if_changed(&admin_dir.join("commondir"), &commondir_content)?;

    match Repository::open(worktree_path) {
        Ok(_) => Ok(true),
        Err(error) => {
            if let Some(content) = previous_git_file {
                let _ = fs::write(&git_file_path, content);
            }
            if let Some(content) = previous_admin_gitdir {
                let _ = fs::write(admin_dir.join("gitdir"), content);
            }
            if let Some(content) = previous_commondir {
                let _ = fs::write(admin_dir.join("commondir"), content);
            }

            Err(BackendError::Git {
                message: format!(
                    "Failed to repair worktree '{}' at {}: {}",
                    worktree_name,
                    worktree_path.display(),
                    error
                ),
            })
        }
    }
    .map(|repaired| repaired || changed)
}

fn quarantine_path(path: &Path) -> Result<PathBuf> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let file_name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "worktree".to_string());
    let mut candidate = path.with_file_name(format!("{file_name}.invalid-{stamp}"));
    let mut suffix = 0;
    while candidate.exists() {
        suffix += 1;
        candidate = path.with_file_name(format!("{file_name}.invalid-{stamp}-{suffix}"));
    }
    fs::rename(path, &candidate).map_err(|e| BackendError::Io {
        message: e.to_string(),
        source: e,
    })?;
    Ok(candidate)
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

fn remove_or_quarantine_path_for_repair(path: &Path, should_quarantine: bool) -> Result<bool> {
    if !path.exists() {
        return Ok(false);
    }
    if should_quarantine {
        let _ = quarantine_path(path)?;
        return Ok(true);
    }
    remove_path_if_present(path)
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
    repo: &Repository,
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
        RepoProbe::Invalid => {
            if repair_gitfile_worktree_links(repo, &worktree_name, &registered_path)? {
                if let RepoProbe::Ready(worktree_repo) = probe_repo_path(&registered_path) {
                    return Ok(TaskWorktreeInspection {
                        task_id: task_id.to_string(),
                        worktree_name,
                        worktree_path: registered_path.clone(),
                        registered_path: Some(registered_path),
                        branch_name: current_branch_name(&worktree_repo),
                        status: TaskWorktreeStatus::Ready,
                        is_dirty: Some(is_dirty(&worktree_repo)?),
                    });
                }
            }
            Ok(TaskWorktreeInspection {
                task_id: task_id.to_string(),
                worktree_name,
                worktree_path: registered_path.clone(),
                registered_path: Some(registered_path),
                branch_name: None,
                status: TaskWorktreeStatus::InvalidRepo,
                is_dirty: None,
            })
        }
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
            inspect_registered_worktree(repo, task_id, candidate_name.to_string(), candidate_path)?;

        if inspection.status == TaskWorktreeStatus::Ready
            && inspection.branch_name.as_deref() == Some(branch_name)
        {
            return Ok(Some(inspection));
        }
    }

    Ok(None)
}

fn release_branch_from_primary_workdir(
    repo: &Repository,
    branch_name: &str,
    fallback_branches: &[String],
) -> Result<()> {
    if current_branch_name(repo).as_deref() != Some(branch_name) {
        return Ok(());
    }

    if has_merge_conflicts(repo)? {
        return Err(BackendError::GitRepositoryNotClean {
            message: format!(
                "Cannot create a worktree for '{}' because that branch is checked out in the repository root and the root has merge conflicts. Resolve or abort the merge in the root repository, then retry.",
                branch_name
            ),
        });
    }

    if is_dirty(repo)? {
        return Err(BackendError::GitRepositoryNotClean {
            message: format!(
                "Cannot create a worktree for '{}' because that branch is checked out in the repository root and the root has uncommitted changes. Commit or stash those changes, then retry.",
                branch_name
            ),
        });
    }

    checkout_first_stable_fallback(repo, branch_name, fallback_branches)
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
                if repair_gitfile_worktree_links(repo, &worktree_name, &expected_path)? {
                    match repo.find_worktree(&worktree_name) {
                        Ok(worktree) => Some(worktree.path().to_path_buf()),
                        Err(retry_err) => {
                            return Err(BackendError::Git {
                                message: format!(
                                    "Failed to inspect worktree '{}' after repair: {}",
                                    worktree_name, retry_err
                                ),
                            });
                        }
                    }
                } else {
                    return Err(BackendError::Git {
                        message: format!("Failed to inspect worktree '{}': {}", worktree_name, err),
                    });
                }
            }
        };

        if let Some(path) = registered_path.clone() {
            if path != expected_path
                && !path.exists()
                && expected_path.exists()
                && repair_gitfile_worktree_links(repo, &worktree_name, &expected_path)?
            {
                if let Ok(worktree) = repo.find_worktree(&worktree_name) {
                    return inspect_registered_worktree(
                        repo,
                        task_id,
                        worktree_name,
                        worktree.path().to_path_buf(),
                    );
                }
                return inspect_registered_worktree(repo, task_id, worktree_name, expected_path);
            }
            return inspect_registered_worktree(repo, task_id, worktree_name, path);
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
                    if repair_gitfile_worktree_links(repo, &worktree_name, &expected_path)? {
                        if let RepoProbe::Ready(worktree_repo) = probe_repo_path(&expected_path) {
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
                    }
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
        fallback_branches: &[String],
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
                let should_quarantine = inspection.status == TaskWorktreeStatus::InvalidRepo;
                if let Some(path) = inspection.registered_path.as_ref() {
                    let _ = remove_or_quarantine_path_for_repair(path, should_quarantine)?;
                }
                if inspection.worktree_path
                    != inspection.registered_path.clone().unwrap_or_default()
                {
                    let _ = remove_or_quarantine_path_for_repair(
                        &inspection.worktree_path,
                        should_quarantine,
                    )?;
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

        release_branch_from_primary_workdir(repo, branch_name, fallback_branches)?;
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
    pub fn inspect_branch_worktree(
        &self,
        repo: &Repository,
        worktree_key: &str,
        branch_name: &str,
    ) -> Result<BranchWorktreeInspection> {
        let worktree_name = branch_worktree_name(worktree_key);
        let expected_path = branch_worktree_path(repo, worktree_key)?;

        let registered_path = match repo.find_worktree(&worktree_name) {
            Ok(worktree) => Some(worktree.path().to_path_buf()),
            Err(err) if err.code() == ErrorCode::NotFound => None,
            Err(err) => {
                if repair_gitfile_worktree_links(repo, &worktree_name, &expected_path)? {
                    match repo.find_worktree(&worktree_name) {
                        Ok(worktree) => Some(worktree.path().to_path_buf()),
                        Err(retry_err) => {
                            return Err(BackendError::Git {
                                message: format!(
                                    "Failed to inspect worktree '{}' after repair: {}",
                                    worktree_name, retry_err
                                ),
                            });
                        }
                    }
                } else {
                    return Err(BackendError::Git {
                        message: format!("Failed to inspect worktree '{}': {}", worktree_name, err),
                    });
                }
            }
        };

        if let Some(path) = registered_path.clone() {
            if path != expected_path
                && !path.exists()
                && expected_path.exists()
                && repair_gitfile_worktree_links(repo, &worktree_name, &expected_path)?
            {
                if let Ok(worktree) = repo.find_worktree(&worktree_name) {
                    return inspect_registered_worktree(
                        repo,
                        worktree_key,
                        worktree_name,
                        worktree.path().to_path_buf(),
                    )
                    .map(branch_inspection_from_task);
                }
                return inspect_registered_worktree(
                    repo,
                    worktree_key,
                    worktree_name,
                    expected_path,
                )
                .map(branch_inspection_from_task);
            }
            return inspect_registered_worktree(repo, worktree_key, worktree_name, path)
                .map(branch_inspection_from_task);
        }

        if expected_path.exists() {
            match probe_repo_path(&expected_path) {
                RepoProbe::Ready(worktree_repo) => {
                    return Ok(BranchWorktreeInspection {
                        worktree_key: worktree_key.to_string(),
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
                    if repair_gitfile_worktree_links(repo, &worktree_name, &expected_path)? {
                        if let RepoProbe::Ready(worktree_repo) = probe_repo_path(&expected_path) {
                            return Ok(BranchWorktreeInspection {
                                worktree_key: worktree_key.to_string(),
                                worktree_name,
                                worktree_path: expected_path.clone(),
                                registered_path: None,
                                branch_name: current_branch_name(&worktree_repo),
                                status: TaskWorktreeStatus::OrphanPath,
                                is_dirty: Some(is_dirty(&worktree_repo)?),
                            });
                        }
                    }
                    return Ok(BranchWorktreeInspection {
                        worktree_key: worktree_key.to_string(),
                        worktree_name,
                        worktree_path: expected_path,
                        registered_path: None,
                        branch_name: None,
                        status: TaskWorktreeStatus::InvalidRepo,
                        is_dirty: None,
                    });
                }
            }

            return Ok(BranchWorktreeInspection {
                worktree_key: worktree_key.to_string(),
                worktree_name,
                worktree_path: expected_path,
                registered_path: None,
                branch_name: None,
                status: TaskWorktreeStatus::OrphanPath,
                is_dirty: None,
            });
        }

        if let Some(branch_worktree) =
            find_ready_worktree_for_branch(repo, worktree_key, branch_name, &worktree_name)?
        {
            return Ok(branch_inspection_from_task(branch_worktree));
        }

        Ok(BranchWorktreeInspection {
            worktree_key: worktree_key.to_string(),
            worktree_name,
            worktree_path: expected_path,
            registered_path: None,
            branch_name: None,
            status: TaskWorktreeStatus::Absent,
            is_dirty: None,
        })
    }

    #[allow(dead_code)]
    pub fn ensure_branch_worktree(
        &self,
        repo: &Repository,
        worktree_key: &str,
        branch_name: &str,
        from_ref: Option<&str>,
        fallback_branches: &[String],
    ) -> Result<BranchWorktreeEnsureResult> {
        let workdir = repo.workdir().ok_or_else(|| BackendError::Git {
            message: "Bare repositories are not supported for worktrees".to_string(),
        })?;

        let expected_worktree_name = branch_worktree_name(worktree_key);
        let mut inspection = self.inspect_branch_worktree(repo, worktree_key, branch_name)?;
        let mut repaired = false;

        match inspection.status {
            TaskWorktreeStatus::Ready if inspection.branch_name.as_deref() == Some(branch_name) => {
                ensure_task_worktree_gitignore_rule(
                    repo,
                    workdir,
                    fallback_branches.first().map(String::as_str),
                )?;
                return Ok(BranchWorktreeEnsureResult {
                    worktree_key: worktree_key.to_string(),
                    worktree_path: inspection.worktree_path,
                    branch_name: branch_name.to_string(),
                    status: if inspection.worktree_name == expected_worktree_name {
                        TaskWorktreeEnsureStatus::Reused
                    } else {
                        TaskWorktreeEnsureStatus::Repaired
                    },
                });
            }
            TaskWorktreeStatus::Ready
            | TaskWorktreeStatus::StaleRegistration
            | TaskWorktreeStatus::OrphanPath
            | TaskWorktreeStatus::InvalidRepo => {
                let should_quarantine = inspection.status == TaskWorktreeStatus::InvalidRepo;
                if let Some(path) = inspection.registered_path.as_ref() {
                    let _ = remove_or_quarantine_path_for_repair(path, should_quarantine)?;
                }
                if inspection.worktree_path
                    != inspection.registered_path.clone().unwrap_or_default()
                {
                    let _ = remove_or_quarantine_path_for_repair(
                        &inspection.worktree_path,
                        should_quarantine,
                    )?;
                }
                let _ = prune_worktree(repo, &inspection.worktree_name)?;
                repaired = true;
            }
            TaskWorktreeStatus::Absent => {}
        }

        if repaired {
            inspection = self.inspect_branch_worktree(repo, worktree_key, branch_name)?;
            if inspection.status == TaskWorktreeStatus::Ready
                && inspection.branch_name.as_deref() == Some(branch_name)
            {
                ensure_task_worktree_gitignore_rule(
                    repo,
                    workdir,
                    fallback_branches.first().map(String::as_str),
                )?;
                return Ok(BranchWorktreeEnsureResult {
                    worktree_key: worktree_key.to_string(),
                    worktree_path: inspection.worktree_path,
                    branch_name: branch_name.to_string(),
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
            let branch_commit = if let Some(from_ref) =
                from_ref.map(str::trim).filter(|value| !value.is_empty())
            {
                repo.revparse_single(from_ref)
                        .and_then(|object| object.peel_to_commit())
                        .map_err(|_| BackendError::Git {
                            message: format!(
                                "Cannot create plan integration branch '{}' from reference '{}'. Fetch the source branch or configure a valid baseBranch/mainBranch, then retry.",
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

        release_branch_from_primary_workdir(repo, branch_name, fallback_branches)?;
        ensure_task_worktree_gitignore_rule(
            repo,
            workdir,
            fallback_branches.first().map(String::as_str),
        )?;

        let worktree_path = branch_worktree_path(repo, worktree_key)?;
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
                "Failed to verify created branch worktree {}: {}",
                worktree_path.display(),
                e
            ),
        })?;
        let created_branch_name =
            current_branch_name(&created_repo).unwrap_or_else(|| branch_name.to_string());

        Ok(BranchWorktreeEnsureResult {
            worktree_key: worktree_key.to_string(),
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
    pub fn remove_branch_worktree(
        &self,
        repo: &Repository,
        worktree_key: &str,
        branch_name: &str,
        force: bool,
    ) -> Result<BranchWorktreeRemoveResult> {
        let inspection = self.inspect_branch_worktree(repo, worktree_key, branch_name)?;
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

        Ok(BranchWorktreeRemoveResult {
            worktree_key: worktree_key.to_string(),
            worktree_path: inspection.worktree_path,
            removed_path,
            pruned_registration,
            already_absent: !removed_path && !pruned_registration,
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn task_worktree_name_sanitizes_path_components() {
        let name = task_worktree_name("../../..");

        assert!(name.starts_with("task"));
        assert!(!name.contains(".."));
        assert!(!name.contains('/'));
        assert!(!name.contains('\\'));
    }

    #[test]
    fn task_worktree_name_preserves_supported_identifiers() {
        assert_eq!(task_worktree_name("task-123_alpha"), "tasktask-123_alpha");
    }

    #[test]
    fn task_worktree_path_stays_under_worktree_root() {
        let temp = TempDir::new().expect("temp dir");
        let repo = Repository::init(temp.path()).expect("init repo");
        let root = task_worktree_root(&repo).expect("worktree root");

        let path = task_worktree_path(&repo, "../../..").expect("task worktree path");

        assert!(path.starts_with(&root));
        assert_eq!(path.parent(), Some(root.as_path()));
    }
}
