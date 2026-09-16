use std::ffi::OsString;
use std::fs;
use std::path::{Component, Path, PathBuf};

use cap_std::ambient_authority;
use cap_std::fs::{Dir as CapabilityDir, Metadata as CapabilityMetadata};
use git2::{build::CheckoutBuilder, BranchType, ErrorCode, Repository, WorktreeAddOptions};
use uuid::Uuid;

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
    let root = workdir.join(".macro").join("worktrees");
    for path in [workdir.join(".macro"), root.clone()] {
        if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err(BackendError::Git {
                message: format!(
                    "Worktree path '{}' is a symbolic link; repair refused to preserve its target.",
                    path.display()
                ),
            });
        }
    }
    Ok(root)
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

#[derive(Clone, Copy)]
enum ManagedWorktreeKind {
    Task,
    Branch,
}

fn is_managed_worktree_name(name: &str, kind: ManagedWorktreeKind) -> bool {
    match kind {
        ManagedWorktreeKind::Task => name.starts_with("task"),
        ManagedWorktreeKind::Branch => name.starts_with("macro-integration-"),
    }
}

fn canonicalize_with_missing_tail(path: &Path) -> PathBuf {
    let mut cursor = path;
    let mut missing_components = Vec::new();
    loop {
        if let Ok(mut canonical) = fs::canonicalize(cursor) {
            for component in missing_components.iter().rev() {
                canonical.push(component);
            }
            return canonical;
        }
        let Some(file_name) = cursor.file_name() else {
            return path.to_path_buf();
        };
        missing_components.push(file_name.to_os_string());
        let Some(parent) = cursor.parent() else {
            return path.to_path_buf();
        };
        cursor = parent;
    }
}

fn is_path_in_task_worktree_root(repo: &Repository, path: &Path) -> Result<bool> {
    let root = task_worktree_root(repo)?;
    if !is_macro_owned_task_worktree_root(repo, &root)? {
        return Ok(false);
    }
    let canonical_root = canonicalize_with_missing_tail(&root);
    let canonical_path = canonicalize_with_missing_tail(path);
    Ok(canonical_path.starts_with(canonical_root))
}

pub(crate) fn is_macro_owned_task_worktree_root(repo: &Repository, path: &Path) -> Result<bool> {
    let workdir = repo.workdir().ok_or_else(|| BackendError::Git {
        message: "Bare repositories are not supported for worktrees".to_string(),
    })?;
    let canonical_workdir = canonicalize_with_missing_tail(workdir);
    let canonical_expected = canonicalize_with_missing_tail(&task_worktree_root(repo)?);
    Ok(canonical_expected.starts_with(&canonical_workdir)
        && canonicalize_with_missing_tail(path) == canonical_expected)
}

pub(crate) fn is_macro_owned_project_artifact_root(repo: &Repository, path: &Path) -> Result<bool> {
    let workdir = repo.workdir().ok_or_else(|| BackendError::Git {
        message: "Bare repositories are not supported for worktrees".to_string(),
    })?;
    let canonical_workdir = canonicalize_with_missing_tail(workdir);
    let canonical_expected = canonicalize_with_missing_tail(&workdir.join(".macro"));
    Ok(canonical_expected.starts_with(&canonical_workdir)
        && canonicalize_with_missing_tail(path) == canonical_expected)
}

pub(crate) fn is_macro_owned_worktree_path(
    repo: &Repository,
    worktree_name: &str,
    path: &Path,
) -> Result<bool> {
    let root = task_worktree_root(repo)?;
    let expected_path = if is_managed_worktree_name(worktree_name, ManagedWorktreeKind::Task) {
        root.join(worktree_name)
    } else if let Some(key) = worktree_name.strip_prefix("macro-integration-") {
        root.join(format!("integration-{key}"))
    } else {
        return Ok(false);
    };

    Ok(is_path_in_task_worktree_root(repo, path)?
        && canonicalize_with_missing_tail(path) == canonicalize_with_missing_tail(&expected_path))
}

fn is_macro_metadata_worktree_path(repo: &Repository, worktree_name: &str, path: &Path) -> bool {
    if worktree_name != super::MACRO_WORKTREE_NAME {
        return false;
    }

    let canonical_git_dir = canonicalize_with_missing_tail(repo.path());
    let canonical_expected =
        canonicalize_with_missing_tail(&repo.path().join(super::MACRO_WORKTREE_DIR_NAME));
    canonical_expected.starts_with(&canonical_git_dir)
        && canonicalize_with_missing_tail(path) == canonical_expected
}

pub(crate) fn ensure_macro_metadata_worktree_ownership(
    repo: &Repository,
    path: &Path,
) -> Result<Option<MacroPathIdentity>> {
    if is_macro_metadata_worktree_path(repo, super::MACRO_WORKTREE_NAME, path) {
        return macro_owned_path_identity(repo.path(), path);
    }

    Err(BackendError::Git {
        message: format!(
            "Refusing to modify Macro metadata worktree at {} because Macro does not own that path",
            path.display()
        ),
    })
}

fn ensure_managed_worktree_ownership(
    repo: &Repository,
    worktree_name: &str,
    path: &Path,
    kind: ManagedWorktreeKind,
) -> Result<Option<MacroPathIdentity>> {
    if is_managed_worktree_name(worktree_name, kind)
        && is_macro_owned_worktree_path(repo, worktree_name, path)?
    {
        let workdir = repo.workdir().ok_or_else(|| BackendError::Git {
            message: "Bare repositories are not supported for worktrees".to_string(),
        })?;
        return macro_owned_path_identity(workdir, path);
    }

    Err(BackendError::Git {
        message: format!(
            "Refusing to modify worktree '{}' at {} because Macro does not own that path",
            worktree_name,
            path.display()
        ),
    })
}

fn repair_managed_worktree_links(
    repo: &Repository,
    worktree_name: &str,
    path: &Path,
    kind: ManagedWorktreeKind,
) -> Result<bool> {
    ensure_managed_worktree_ownership(repo, worktree_name, path, kind)?;
    repair_gitfile_worktree_links(repo, worktree_name, path)
}

fn current_branch_name(repo: &Repository) -> Option<String> {
    repo.head()
        .ok()
        .and_then(|head| head.shorthand().ok().map(str::to_string))
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

fn require_clean_removal_path(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(BackendError::Git {
                message: format!("Cannot inspect worktree {}: {error}", path.display()),
            })
        }
        Ok(_) => {}
    }
    let repository =
        Repository::open(path).map_err(|error| BackendError::GitRepositoryNotClean {
            message: format!(
                "Cannot establish cleanliness of {}: {error}",
                path.display()
            ),
        })?;
    // Ignored files can still be the only copy of local data. Non-forced
    // removal must prove the whole directory disposable, not just tracked files.
    let mut status_options = get_status_options();
    status_options
        .include_ignored(true)
        .recurse_ignored_dirs(true);
    if repository
        .workdir()
        .and_then(|root| root.canonicalize().ok())
        != path.canonicalize().ok()
        || repository.state() != git2::RepositoryState::Clean
        || !repository.statuses(Some(&mut status_options))?.is_empty()
    {
        return Err(BackendError::GitRepositoryNotClean {
            message: format!("Worktree {} is not known to be clean", path.display()),
        });
    }
    Ok(())
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
    let owned = if worktree_name == super::MACRO_WORKTREE_NAME {
        ensure_macro_metadata_worktree_ownership(repo, worktree_path).is_ok()
    } else {
        is_macro_owned_worktree_path(repo, worktree_name, worktree_path)?
    };
    if !owned {
        return Err(BackendError::Git {
            message: format!(
                "Refusing to repair worktree '{}' at {} because Macro does not own that path",
                worktree_name,
                worktree_path.display()
            ),
        });
    }

    let git_file_path = worktree_path.join(".git");
    let git_dir = repo.path();
    let admin_dir = git_dir.join("worktrees").join(worktree_name);

    if !git_file_path.is_file() || !admin_dir.is_dir() {
        return Ok(false);
    }
    for path in [
        worktree_path.to_path_buf(),
        git_file_path.clone(),
        admin_dir.clone(),
        admin_dir.join("gitdir"),
        admin_dir.join("commondir"),
    ] {
        if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err(BackendError::Git { message: format!("Worktree link repair refused for symbolic link '{}'. Preserve its target before retrying.", path.display()) });
        }
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

// Repair must never discard a directory, its Git administration, or an unknown file.
// Only an empty directory can be removed; remove_dir also rejects concurrent writes.
fn prepare_path_for_repair(path: &Path) -> Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if metadata.is_dir() && fs::remove_dir(path).is_ok() {
        return Ok(());
    }
    Err(BackendError::Git {
        message: format!(
            "Worktree repair refused to preserve data at '{}'. Move this path to a safe backup location, then retry. No worktree registration was removed.",
            path.display()
        ),
    })
}

fn require_expected_branch(actual: Option<&str>, expected: &str, path: &Path) -> Result<()> {
    if actual != Some(expected) {
        return Err(BackendError::Git {
            message: format!(
                "Worktree repair refused at '{}': expected branch '{}', found '{}'. Preserve your changes and check out the expected branch before retrying.",
                path.display(), expected, actual.unwrap_or("detached HEAD")
            ),
        });
    }
    Ok(())
}

// A missing worktree can still have an index and reflog containing unique work.
// Keep its complete administration outside Git's active worktree registry.
fn preserve_registration_for_repair(repo: &Repository, name: &str) -> Result<()> {
    let admin = repo.commondir().join("worktrees").join(name);
    match fs::symlink_metadata(&admin) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(BackendError::Git {
                message: format!(
                    "Invalid worktree registration '{}'; repair refused.",
                    admin.display()
                ),
            });
        }
        Ok(_) => {}
    }
    let backups = repo.commondir().join("macro-worktree-backups");
    if fs::symlink_metadata(&backups).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(BackendError::Git {
            message: "Worktree backup directory is a symbolic link; repair refused.".to_string(),
        });
    }
    fs::create_dir_all(&backups)?;
    let backup_id = format!("{}-{}", name, uuid::Uuid::new_v4());
    let backup = backups.join(&backup_id);
    // Moving administration removes it from Git's reachability roots. Pin every
    // index blob and HEAD/reflog commit before moving it so later GC cannot erase
    // unique staged work or detached commits. Failure leaves registration intact.
    let worktree_repo = Repository::open_ext(
        &admin,
        git2::RepositoryOpenFlags::BARE | git2::RepositoryOpenFlags::NO_SEARCH,
        std::iter::empty::<&Path>(),
    )?;
    let index = git2::Index::open(&admin.join("index"))?;
    let mut index_tree = repo.treebuilder(None)?;
    for (position, entry) in index.iter().enumerate() {
        // Gitlinks name objects belonging to another repository, not this ODB.
        if entry.mode == 0o160000 {
            continue;
        }
        repo.find_blob(entry.id)?;
        index_tree.insert(position.to_string(), entry.id, 0o100644)?;
    }
    let tree_id = index_tree.write()?;
    repo.reference(
        &format!("refs/macro-worktree-backups/{}/index", backup_id),
        tree_id,
        false,
        "Preserve worktree repair index objects",
    )?;
    let mut commits = std::collections::HashSet::new();
    commits.insert(worktree_repo.head()?.peel_to_commit()?.id());
    match worktree_repo.reflog("HEAD") {
        Ok(reflog) => {
            for entry in reflog.iter() {
                for oid in [entry.id_old(), entry.id_new()] {
                    if !oid.is_zero() {
                        commits.insert(oid);
                    }
                }
            }
        }
        Err(error) if error.code() == ErrorCode::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    for oid in commits {
        repo.find_commit(oid)?;
        repo.reference(
            &format!("refs/macro-worktree-backups/{}/commit-{}", backup_id, oid),
            oid,
            false,
            "Preserve worktree repair history",
        )?;
    }
    fs::rename(&admin, &backup)?;
    Ok(())
}

fn open_macro_owned_parent(root: &Path, path: &Path) -> Result<Option<(CapabilityDir, OsString)>> {
    let relative = path.strip_prefix(root).map_err(|_| BackendError::Git {
        message: format!(
            "Refusing to modify {} because it is not lexically inside {}",
            path.display(),
            root.display()
        ),
    })?;
    let file_name = relative
        .file_name()
        .map(OsString::from)
        .ok_or_else(|| BackendError::Git {
            message: format!("Refusing to modify capability root {}", root.display()),
        })?;
    let mut parent =
        CapabilityDir::open_ambient_dir(root, ambient_authority()).map_err(|error| {
            BackendError::Io {
                message: format!("Failed to open owned root {}: {error}", root.display()),
                source: error,
            }
        })?;
    if let Some(parent_path) = relative.parent() {
        for component in parent_path.components() {
            let Component::Normal(segment) = component else {
                return Err(BackendError::Git {
                    message: format!("Refusing unsafe managed path {}", path.display()),
                });
            };
            match parent.symlink_metadata(segment) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                    parent = parent.open_dir(segment).map_err(|error| BackendError::Io {
                        message: format!(
                            "Failed to open owned parent for {}: {error}",
                            path.display()
                        ),
                        source: error,
                    })?;
                }
                Ok(_) => {
                    return Err(BackendError::Git {
                        message: format!(
                            "Refusing to modify {} through a linked or non-directory parent",
                            path.display()
                        ),
                    })
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => {
                    return Err(BackendError::Io {
                        message: format!("Failed to inspect {}: {error}", path.display()),
                        source: error,
                    })
                }
            }
        }
    }
    Ok(Some((parent, file_name)))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MacroPathIdentity {
    volume: u64,
    file: u64,
}

#[cfg(unix)]
fn capability_path_identity(metadata: &CapabilityMetadata) -> Option<MacroPathIdentity> {
    use cap_fs_ext::MetadataExt;
    Some(MacroPathIdentity {
        volume: metadata.dev(),
        file: metadata.ino(),
    })
}

#[cfg(windows)]
fn capability_path_identity(metadata: &CapabilityMetadata) -> Option<MacroPathIdentity> {
    use cap_fs_ext::MetadataExt;
    Some(MacroPathIdentity {
        volume: metadata.dev(),
        file: metadata.ino(),
    })
}

#[cfg(not(any(unix, windows)))]
fn capability_path_identity(_metadata: &CapabilityMetadata) -> Option<MacroPathIdentity> {
    None
}

pub(crate) fn macro_owned_path_identity(
    root: &Path,
    path: &Path,
) -> Result<Option<MacroPathIdentity>> {
    let Some((parent, file_name)) = open_macro_owned_parent(root, path)? else {
        return Ok(None);
    };
    match parent.symlink_metadata(&file_name) {
        Ok(metadata) => capability_path_identity(&metadata)
            .map(Some)
            .ok_or_else(|| BackendError::Git {
                message: format!("Cannot identify managed path {}", path.display()),
            }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(BackendError::Io {
            message: format!("Failed to inspect {}: {error}", path.display()),
            source: error,
        }),
    }
}

fn restore_replaced_managed_path(
    parent: &CapabilityDir,
    original_name: &OsString,
    quarantine_name: &OsString,
    original_path: &Path,
) -> Result<()> {
    match parent.symlink_metadata(original_name) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => parent
            .rename(quarantine_name, parent, original_name)
            .map_err(|error| BackendError::Io {
                message: format!(
                    "Managed path {} changed after ownership verification and could not be restored: {error}",
                    original_path.display()
                ),
                source: error,
            }),
        Ok(_) => Err(BackendError::Git {
            message: format!(
                "Managed path {} changed after ownership verification; the replacement was retained at {}",
                original_path.display(),
                original_path.with_file_name(quarantine_name).display()
            ),
        }),
        Err(error) => Err(BackendError::Io {
            message: format!(
                "Failed to inspect replaced managed path {}: {error}",
                original_path.display()
            ),
            source: error,
        }),
    }
}

pub(crate) fn remove_macro_owned_path(
    root: &Path,
    path: &Path,
    expected_identity: Option<MacroPathIdentity>,
) -> Result<bool> {
    let Some((parent, file_name)) = open_macro_owned_parent(root, path)? else {
        return Ok(false);
    };
    match parent.symlink_metadata(&file_name) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(BackendError::Io {
                message: format!("Failed to inspect {}: {error}", path.display()),
                source: error,
            })
        }
    }
    let Some(expected_identity) = expected_identity else {
        return Err(BackendError::Git {
            message: format!(
                "Refusing to remove {} because it appeared after ownership verification",
                path.display()
            ),
        });
    };
    let quarantine_name = OsString::from(format!(
        ".{}.macro-removing-{}",
        file_name.to_string_lossy(),
        Uuid::new_v4()
    ));
    parent
        .rename(&file_name, &parent, &quarantine_name)
        .map_err(|error| BackendError::Io {
            message: format!(
                "Failed to isolate {} before removal: {error}",
                path.display()
            ),
            source: error,
        })?;
    let quarantined_metadata =
        parent
            .symlink_metadata(&quarantine_name)
            .map_err(|error| BackendError::Io {
                message: format!(
                    "Failed to verify isolated managed path {}: {error}",
                    path.display()
                ),
                source: error,
            })?;
    if capability_path_identity(&quarantined_metadata) != Some(expected_identity) {
        restore_replaced_managed_path(&parent, &file_name, &quarantine_name, path)?;
        return Err(BackendError::Git {
            message: format!(
                "Refusing to remove {} because it changed after ownership verification",
                path.display()
            ),
        });
    }
    let removal = if quarantined_metadata.file_type().is_symlink() {
        #[cfg(windows)]
        {
            if quarantined_metadata.is_dir() {
                parent.remove_dir(&quarantine_name)
            } else {
                parent.remove_file(&quarantine_name)
            }
        }
        #[cfg(not(windows))]
        {
            parent.remove_file(&quarantine_name)
        }
    } else if quarantined_metadata.is_dir() {
        parent.remove_dir_all(&quarantine_name)
    } else {
        parent.remove_file(&quarantine_name)
    };
    removal.map_err(|error| BackendError::Io {
        message: format!(
            "Failed to remove {}; the isolated path was retained at {}: {error}",
            path.display(),
            path.with_file_name(&quarantine_name).display()
        ),
        source: error,
    })?;
    Ok(true)
}

fn create_macro_owned_directories(root: &Path, path: &Path) -> Result<()> {
    let relative = path.strip_prefix(root).map_err(|_| BackendError::Git {
        message: format!(
            "Refusing to create {} because it is not lexically inside {}",
            path.display(),
            root.display()
        ),
    })?;
    let mut directory =
        CapabilityDir::open_ambient_dir(root, ambient_authority()).map_err(|error| {
            BackendError::Io {
                message: format!("Failed to open owned root {}: {error}", root.display()),
                source: error,
            }
        })?;
    for component in relative.components() {
        let Component::Normal(segment) = component else {
            return Err(BackendError::Git {
                message: format!("Refusing unsafe managed path {}", path.display()),
            });
        };
        match directory.symlink_metadata(segment) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(BackendError::Git {
                    message: format!(
                        "Refusing to create {} through a linked or non-directory parent",
                        path.display()
                    ),
                })
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                match directory.create_dir(segment) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => {
                        return Err(BackendError::Io {
                            message: format!("Failed to create {}: {error}", path.display()),
                            source: error,
                        })
                    }
                }
            }
            Err(error) => {
                return Err(BackendError::Io {
                    message: format!("Failed to inspect {}: {error}", path.display()),
                    source: error,
                })
            }
        }
        directory = directory
            .open_dir(segment)
            .map_err(|error| BackendError::Io {
                message: format!(
                    "Failed to open created directory {}: {error}",
                    path.display()
                ),
                source: error,
            })?;
    }
    Ok(())
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
    allow_repair: bool,
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
        RepoProbe::Missing | RepoProbe::Invalid => {
            if allow_repair
                && is_macro_owned_worktree_path(repo, &worktree_name, &registered_path)?
                && repair_gitfile_worktree_links(repo, &worktree_name, &registered_path)?
            {
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
    allow_repair: bool,
    kind: ManagedWorktreeKind,
) -> Result<Option<TaskWorktreeInspection>> {
    let worktree_names = repo.worktrees().map_err(|e| BackendError::Git {
        message: format!("Failed to list registered worktrees: {}", e),
    })?;

    for candidate_name in worktree_names.iter().flatten().flatten() {
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
        if !is_managed_worktree_name(candidate_name, kind)
            || !is_path_in_task_worktree_root(repo, &candidate_path)?
        {
            continue;
        }
        let inspection = inspect_registered_worktree(
            repo,
            task_id,
            candidate_name.to_string(),
            candidate_path,
            allow_repair,
        )?;

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
        allow_repair: bool,
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
                if allow_repair
                    && repair_managed_worktree_links(
                        repo,
                        &worktree_name,
                        &expected_path,
                        ManagedWorktreeKind::Task,
                    )?
                {
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
                && allow_repair
                && repair_managed_worktree_links(
                    repo,
                    &worktree_name,
                    &expected_path,
                    ManagedWorktreeKind::Task,
                )?
            {
                if let Ok(worktree) = repo.find_worktree(&worktree_name) {
                    return inspect_registered_worktree(
                        repo,
                        task_id,
                        worktree_name,
                        worktree.path().to_path_buf(),
                        allow_repair,
                    );
                }
                return inspect_registered_worktree(
                    repo,
                    task_id,
                    worktree_name,
                    expected_path,
                    allow_repair,
                );
            }
            return inspect_registered_worktree(repo, task_id, worktree_name, path, allow_repair);
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
                    if allow_repair
                        && repair_managed_worktree_links(
                            repo,
                            &worktree_name,
                            &expected_path,
                            ManagedWorktreeKind::Task,
                        )?
                    {
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
            if let Some(branch_worktree) = find_ready_worktree_for_branch(
                repo,
                task_id,
                branch_name,
                &absent.worktree_name,
                allow_repair,
                ManagedWorktreeKind::Task,
            )? {
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
        self.inspect_task_worktree_internal(repo, task_id, None, true)
    }

    #[allow(dead_code)]
    pub fn inspect_task_worktree_for_branch(
        &self,
        repo: &Repository,
        task_id: &str,
        branch_name: &str,
    ) -> Result<TaskWorktreeInspection> {
        self.inspect_task_worktree_internal(repo, task_id, Some(branch_name), true)
    }

    /// Read-only inspection for the user diagnostic; link repair requires an explicit action.
    pub fn diagnose_task_worktree(
        &self,
        repo: &Repository,
        task_id: &str,
        branch_name: Option<&str>,
    ) -> Result<TaskWorktreeInspection> {
        self.inspect_task_worktree_internal(repo, task_id, branch_name, false)
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
            self.inspect_task_worktree_internal(repo, task_id, Some(branch_name), true)?;
        let mut repaired = false;

        match inspection.status {
            TaskWorktreeStatus::Ready => {
                require_expected_branch(
                    inspection.branch_name.as_deref(),
                    branch_name,
                    &inspection.worktree_path,
                )?;
                ensure_managed_worktree_ownership(
                    repo,
                    &inspection.worktree_name,
                    &inspection.worktree_path,
                    ManagedWorktreeKind::Task,
                )?;
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
                    ensure_managed_worktree_ownership(
                        repo,
                        &inspection.worktree_name,
                        path,
                        ManagedWorktreeKind::Task,
                    )?;
                    prepare_path_for_repair(path)?;
                }
                if inspection.worktree_path
                    != inspection.registered_path.clone().unwrap_or_default()
                {
                    ensure_managed_worktree_ownership(
                        repo,
                        &inspection.worktree_name,
                        &inspection.worktree_path,
                        ManagedWorktreeKind::Task,
                    )?;
                    prepare_path_for_repair(&inspection.worktree_path)?;
                }
                preserve_registration_for_repair(repo, &inspection.worktree_name)?;
                self.clear_worktree_cache(task_id);
                repaired = true;
            }
            TaskWorktreeStatus::Absent => {}
        }

        if repaired {
            inspection =
                self.inspect_task_worktree_internal(repo, task_id, Some(branch_name), true)?;
            if inspection.status == TaskWorktreeStatus::Ready {
                require_expected_branch(
                    inspection.branch_name.as_deref(),
                    branch_name,
                    &inspection.worktree_path,
                )?;
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

        let worktree_path = task_worktree_path(repo, task_id)?;
        ensure_managed_worktree_ownership(
            repo,
            &inspection.worktree_name,
            &worktree_path,
            ManagedWorktreeKind::Task,
        )?;
        let worktree_root = task_worktree_root(repo)?;
        create_macro_owned_directories(workdir, &worktree_root)?;

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
                if repair_managed_worktree_links(
                    repo,
                    &worktree_name,
                    &expected_path,
                    ManagedWorktreeKind::Branch,
                )? {
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
                && repair_managed_worktree_links(
                    repo,
                    &worktree_name,
                    &expected_path,
                    ManagedWorktreeKind::Branch,
                )?
            {
                if let Ok(worktree) = repo.find_worktree(&worktree_name) {
                    return inspect_registered_worktree(
                        repo,
                        worktree_key,
                        worktree_name,
                        worktree.path().to_path_buf(),
                        true,
                    )
                    .map(branch_inspection_from_task);
                }
                return inspect_registered_worktree(
                    repo,
                    worktree_key,
                    worktree_name,
                    expected_path,
                    true,
                )
                .map(branch_inspection_from_task);
            }
            return inspect_registered_worktree(repo, worktree_key, worktree_name, path, true)
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
                    if repair_managed_worktree_links(
                        repo,
                        &worktree_name,
                        &expected_path,
                        ManagedWorktreeKind::Branch,
                    )? {
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

        if let Some(branch_worktree) = find_ready_worktree_for_branch(
            repo,
            worktree_key,
            branch_name,
            &worktree_name,
            true,
            ManagedWorktreeKind::Branch,
        )? {
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
                ensure_managed_worktree_ownership(
                    repo,
                    &inspection.worktree_name,
                    &inspection.worktree_path,
                    ManagedWorktreeKind::Branch,
                )?;
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
            TaskWorktreeStatus::Ready => {
                require_expected_branch(
                    inspection.branch_name.as_deref(),
                    branch_name,
                    &inspection.worktree_path,
                )?;
                unreachable!("matching branch handled above");
            }
            TaskWorktreeStatus::StaleRegistration
            | TaskWorktreeStatus::OrphanPath
            | TaskWorktreeStatus::InvalidRepo => {
                if let Some(path) = inspection.registered_path.as_ref() {
                    ensure_managed_worktree_ownership(
                        repo,
                        &inspection.worktree_name,
                        path,
                        ManagedWorktreeKind::Branch,
                    )?;
                    prepare_path_for_repair(path)?;
                }
                if inspection.worktree_path
                    != inspection.registered_path.clone().unwrap_or_default()
                {
                    ensure_managed_worktree_ownership(
                        repo,
                        &inspection.worktree_name,
                        &inspection.worktree_path,
                        ManagedWorktreeKind::Branch,
                    )?;
                    prepare_path_for_repair(&inspection.worktree_path)?;
                }
                preserve_registration_for_repair(repo, &inspection.worktree_name)?;
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

        let worktree_path = branch_worktree_path(repo, worktree_key)?;
        ensure_managed_worktree_ownership(
            repo,
            &inspection.worktree_name,
            &worktree_path,
            ManagedWorktreeKind::Branch,
        )?;
        let worktree_root = task_worktree_root(repo)?;
        create_macro_owned_directories(workdir, &worktree_root)?;

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
        let workdir = repo.workdir().ok_or_else(|| BackendError::Git {
            message: "Bare repositories are not supported for worktrees".to_string(),
        })?;
        if !force {
            require_clean_removal_path(&branch_worktree_path(repo, worktree_key)?)?;
        }
        let inspection = self.inspect_branch_worktree(repo, worktree_key, branch_name)?;
        if !force
            && inspection.is_dirty != Some(false)
            && (inspection.worktree_path.try_exists().unwrap_or(true)
                || inspection
                    .registered_path
                    .as_ref()
                    .is_some_and(|path| path.try_exists().unwrap_or(true)))
        {
            return Err(BackendError::GitRepositoryNotClean {
                message: format!(
                    "Worktree {} is dirty or its cleanliness could not be established",
                    inspection.worktree_path.display()
                ),
            });
        }

        if !force {
            require_clean_removal_path(&inspection.worktree_path)?;
            if let Some(path) = inspection.registered_path.as_ref() {
                require_clean_removal_path(path)?;
            }
        }

        let mut removed_path = false;
        if let Some(path) = inspection.registered_path.as_ref() {
            let expected_identity = ensure_managed_worktree_ownership(
                repo,
                &inspection.worktree_name,
                path,
                ManagedWorktreeKind::Branch,
            )?;
            removed_path =
                remove_macro_owned_path(workdir, path, expected_identity)? || removed_path;
        }
        if inspection.worktree_path != inspection.registered_path.clone().unwrap_or_default() {
            let expected_identity = ensure_managed_worktree_ownership(
                repo,
                &inspection.worktree_name,
                &inspection.worktree_path,
                ManagedWorktreeKind::Branch,
            )?;
            removed_path =
                remove_macro_owned_path(workdir, &inspection.worktree_path, expected_identity)?
                    || removed_path;
        }

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
        let workdir = repo.workdir().ok_or_else(|| BackendError::Git {
            message: "Bare repositories are not supported for worktrees".to_string(),
        })?;
        if !force {
            require_clean_removal_path(&task_worktree_path(repo, task_id)?)?;
        }
        let inspection = self.inspect_task_worktree_internal(repo, task_id, branch_name, false)?;
        if !force
            && inspection.is_dirty != Some(false)
            && (inspection.worktree_path.try_exists().unwrap_or(true)
                || inspection
                    .registered_path
                    .as_ref()
                    .is_some_and(|path| path.try_exists().unwrap_or(true)))
        {
            return Err(BackendError::GitRepositoryNotClean {
                message: format!(
                    "Worktree {} is dirty or its cleanliness could not be established",
                    inspection.worktree_path.display()
                ),
            });
        }

        if !force {
            require_clean_removal_path(&inspection.worktree_path)?;
            if let Some(path) = inspection.registered_path.as_ref() {
                require_clean_removal_path(path)?;
            }
        }

        let mut removed_path = false;
        if let Some(path) = inspection.registered_path.as_ref() {
            let expected_identity = ensure_managed_worktree_ownership(
                repo,
                &inspection.worktree_name,
                path,
                ManagedWorktreeKind::Task,
            )?;
            removed_path =
                remove_macro_owned_path(workdir, path, expected_identity)? || removed_path;
        }
        if inspection.worktree_path != inspection.registered_path.clone().unwrap_or_default() {
            let expected_identity = ensure_managed_worktree_ownership(
                repo,
                &inspection.worktree_name,
                &inspection.worktree_path,
                ManagedWorktreeKind::Task,
            )?;
            removed_path =
                remove_macro_owned_path(workdir, &inspection.worktree_path, expected_identity)?
                    || removed_path;
        }

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

    #[cfg(windows)]
    fn link_directory(link: &Path, target: &Path) {
        let link = PathBuf::from(link.to_string_lossy().replace('/', "\\"));
        let target = PathBuf::from(target.to_string_lossy().replace('/', "\\"));
        let status = crate::core::process::background_command("cmd")
            .args(["/d", "/c", "mklink /J"])
            .arg(&link)
            .arg(&target)
            .status()
            .expect("create Windows junction");
        assert!(status.success(), "mklink /J must create the test junction");
    }

    #[cfg(unix)]
    fn link_directory(link: &Path, target: &Path) {
        std::os::unix::fs::symlink(target, link).expect("create directory symlink");
    }

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

    #[test]
    fn managed_path_removal_never_follows_a_linked_parent() {
        let root = TempDir::new().expect("managed root");
        let outside = TempDir::new().expect("outside root");
        fs::create_dir_all(outside.path().join("worktrees/task-owned")).expect("outside worktree");
        fs::write(
            outside.path().join("worktrees/task-owned/sentinel.txt"),
            "preserve",
        )
        .expect("outside sentinel");
        link_directory(&root.path().join(".macro"), outside.path());

        remove_macro_owned_path(
            root.path(),
            &root.path().join(".macro/worktrees/task-owned"),
            None,
        )
        .expect_err("linked parent must be rejected");

        assert_eq!(
            fs::read_to_string(outside.path().join("worktrees/task-owned/sentinel.txt"))
                .expect("outside sentinel survives"),
            "preserve"
        );
    }

    #[test]
    fn managed_path_removal_refuses_a_replacement_after_ownership_verification() {
        let root = TempDir::new().expect("managed root");
        let managed_path = root.path().join(".macro/worktrees/task-owned");
        fs::create_dir_all(&managed_path).expect("managed worktree");
        fs::write(managed_path.join("owned.txt"), "owned").expect("owned sentinel");
        let expected_identity =
            macro_owned_path_identity(root.path(), &managed_path).expect("managed identity");

        let original_path = root.path().join(".macro/worktrees/original-owned");
        fs::rename(&managed_path, &original_path).expect("move original worktree");
        fs::create_dir_all(&managed_path).expect("replacement worktree");
        fs::write(managed_path.join("user.txt"), "preserve").expect("replacement sentinel");

        remove_macro_owned_path(root.path(), &managed_path, expected_identity)
            .expect_err("replacement must not be removed");

        assert_eq!(
            fs::read_to_string(managed_path.join("user.txt")).expect("replacement survives"),
            "preserve"
        );
        assert_eq!(
            fs::read_to_string(original_path.join("owned.txt")).expect("original survives"),
            "owned"
        );
    }

    #[test]
    fn managed_worktree_repair_rejects_a_root_linked_outside_the_repository() {
        let temp = TempDir::new().expect("temp dir");
        let external = TempDir::new().expect("external temp dir");
        let repo = Repository::init(temp.path()).expect("init repo");
        fs::create_dir_all(temp.path().join(".macro")).expect("create Macro directory");
        link_directory(
            &temp.path().join(".macro").join("worktrees"),
            external.path(),
        );
        let worktree_name = "tasklinked-root";
        let worktree_path = temp
            .path()
            .join(".macro")
            .join("worktrees")
            .join(worktree_name);
        fs::create_dir_all(&worktree_path).expect("create external worktree path");
        fs::write(worktree_path.join(".git"), "gitdir: preserve-external\n")
            .expect("write external gitfile");
        let admin_dir = repo.path().join("worktrees").join(worktree_name);
        fs::create_dir_all(&admin_dir).expect("create admin directory");
        fs::write(admin_dir.join("gitdir"), "preserve-admin\n").expect("write admin gitdir");
        fs::write(admin_dir.join("commondir"), "preserve-common\n").expect("write admin commondir");

        let error = repair_gitfile_worktree_links(&repo, worktree_name, &worktree_path)
            .expect_err("linked external root must not be repaired");

        assert!(matches!(error, BackendError::Git { .. }));
        assert_eq!(
            fs::read_to_string(worktree_path.join(".git")).expect("preserved external gitfile"),
            "gitdir: preserve-external\n"
        );
        assert_eq!(
            fs::read_to_string(admin_dir.join("gitdir")).expect("preserved admin gitdir"),
            "preserve-admin\n"
        );
        assert_eq!(
            fs::read_to_string(admin_dir.join("commondir")).expect("preserved admin commondir"),
            "preserve-common\n"
        );
    }

    #[test]
    fn metadata_worktree_repair_rejects_a_path_linked_outside_the_git_directory() {
        let temp = TempDir::new().expect("temp dir");
        let external = TempDir::new().expect("external temp dir");
        let repo = Repository::init(temp.path()).expect("init repo");
        let worktree_name = super::super::MACRO_WORKTREE_NAME;
        let worktree_path = repo.path().join(super::super::MACRO_WORKTREE_DIR_NAME);
        link_directory(&worktree_path, external.path());
        fs::write(external.path().join(".git"), "gitdir: preserve-external\n")
            .expect("write external gitfile");
        let admin_dir = repo.path().join("worktrees").join(worktree_name);
        fs::create_dir_all(&admin_dir).expect("create admin directory");
        fs::write(admin_dir.join("gitdir"), "preserve-admin\n").expect("write admin gitdir");
        fs::write(admin_dir.join("commondir"), "preserve-common\n").expect("write admin commondir");

        let error = repair_gitfile_worktree_links(&repo, worktree_name, &worktree_path)
            .expect_err("linked external metadata path must not be repaired");

        assert!(matches!(error, BackendError::Git { .. }));
        assert_eq!(
            fs::read_to_string(external.path().join(".git")).expect("preserved external gitfile"),
            "gitdir: preserve-external\n"
        );
        assert_eq!(
            fs::read_to_string(admin_dir.join("gitdir")).expect("preserved admin gitdir"),
            "preserve-admin\n"
        );
        assert_eq!(
            fs::read_to_string(admin_dir.join("commondir")).expect("preserved admin commondir"),
            "preserve-common\n"
        );
    }
}
