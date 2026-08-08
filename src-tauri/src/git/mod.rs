// Git Module

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use git2::{
    BranchType, ErrorCode, Repository, RepositoryInitOptions, Signature, WorktreeAddOptions,
};

use crate::core::error::{BackendError, Result};
use crate::core::process::background_command;

pub mod repo;
mod worktree;
pub use worktree::{
    BranchWorktreeEnsureResult, BranchWorktreeInspection, BranchWorktreeRemoveResult,
    TaskWorktreeEnsureResult, TaskWorktreeEnsureStatus, TaskWorktreeInspection,
    TaskWorktreeRemoveResult, TaskWorktreeStatus,
};

// Git does not allow branch components that start with '.', so we keep a
// dedicated metadata branch with a valid ref name and expose it as logical
// "@macro" metadata sync in the UI.
pub const MACRO_BRANCH_NAME: &str = "@macro";
pub(crate) const MACRO_WORKTREE_NAME: &str = "macro-metadata";
pub(crate) const MACRO_WORKTREE_DIR_NAME: &str = "macro-metadata-worktree";
const LEGACY_METADATA_DIR_NAME: &str = ".macro";
const TASK_WORKTREE_GITIGNORE_RULE: &str = "/.macro/";
const TASK_WORKTREE_GITIGNORE_COMMIT_MESSAGE: &str = "chore(gitignore): ignore Macro worktrees";
const PREFERRED_MAIN_BRANCHES: &[&str] = &["main", "master", "trunk", "default"];
const PREFERRED_BASE_BRANCHES: &[&str] = &[
    "develop",
    "dev",
    "development",
    "integration",
    "next",
    "staging",
    "preprod",
    "qa",
    "test",
];
const NON_BASE_BRANCH_PREFIXES: &[&str] = &[
    "feature/",
    "feature-",
    "feat/",
    "feat-",
    "fix/",
    "fix-",
    "bugfix/",
    "bugfix-",
    "hotfix/",
    "hotfix-",
    "release/",
    "release-",
    "chore/",
    "chore-",
    "docs/",
    "docs-",
    "work/",
    "work-",
    "task/",
    "task-",
    "tasks/",
    "tasks-",
    "story/",
    "story-",
    "experiment/",
    "experiment-",
    "spike/",
    "spike-",
    "wip/",
    "wip-",
    "user/",
    "user-",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GitFlowBranchDetection {
    pub main_branch: Option<String>,
    pub base_branch: Option<String>,
    pub commit_branch: Option<String>,
    pub current_branch: Option<String>,
    pub branch_candidates: Vec<String>,
    pub requires_confirmation: bool,
}

#[derive(Debug, Clone, Default)]
pub struct MacroProjectResetResult {
    pub removed_task_worktrees: usize,
    pub removed_metadata_worktree: bool,
    pub removed_macro_branch: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct MacroMetadataWorktreeEnsureResult {
    pub worktree_path: PathBuf,
    pub repaired_after_move: bool,
}

fn current_branch_name(repo: &Repository) -> Option<String> {
    if repo.head_detached().ok()? {
        return None;
    }

    repo.head()
        .ok()
        .and_then(|head| head.shorthand().map(|value| value.to_string()))
}

fn branch_exists(repo: &Repository, branch_name: &str, branch_type: BranchType) -> bool {
    repo.find_branch(branch_name, branch_type).is_ok()
}

fn distinct_branch_names(repo: &Repository) -> Vec<String> {
    let mut names = Vec::new();
    for branch_type in [BranchType::Local, BranchType::Remote] {
        if let Ok(branches) = repo.branches(Some(branch_type)) {
            for branch in branches.flatten() {
                let name = branch
                    .0
                    .name()
                    .ok()
                    .flatten()
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(|name| name.strip_prefix("origin/").unwrap_or(name).to_string());
                if let Some(name) = name {
                    if name == "HEAD" || name == "origin/HEAD" {
                        continue;
                    }
                    if !names.contains(&name) {
                        names.push(name);
                    }
                }
            }
        }
    }
    names
}

fn resolve_origin_head_branch(repo: &Repository) -> Option<String> {
    repo.find_reference("refs/remotes/origin/HEAD")
        .ok()
        .and_then(|reference| reference.symbolic_target().map(str::to_string))
        .and_then(|target| {
            target
                .strip_prefix("refs/remotes/origin/")
                .map(str::to_string)
        })
}

fn detect_preferred_branch_name(repo: &Repository, candidates: &[&str]) -> Option<String> {
    for candidate in candidates {
        if branch_exists(repo, candidate, BranchType::Local) {
            return Some((*candidate).to_string());
        }
    }

    for candidate in candidates {
        if branch_exists(repo, &format!("origin/{}", candidate), BranchType::Remote) {
            return Some((*candidate).to_string());
        }
    }

    None
}

fn matches_branch_family(branch_name: &str, candidates: &[&str]) -> bool {
    let normalized = branch_name.trim().to_lowercase();
    candidates.iter().any(|candidate| normalized == *candidate)
}

fn is_known_main_branch_name(branch_name: &str) -> bool {
    matches_branch_family(branch_name, PREFERRED_MAIN_BRANCHES)
}

fn is_known_base_branch_name(branch_name: &str) -> bool {
    is_known_main_branch_name(branch_name)
        || matches_branch_family(branch_name, PREFERRED_BASE_BRANCHES)
}

fn looks_like_work_branch(branch_name: &str) -> bool {
    let normalized = branch_name.trim().to_lowercase();
    normalized == MACRO_BRANCH_NAME.to_lowercase()
        || NON_BASE_BRANCH_PREFIXES
            .iter()
            .any(|prefix| normalized.starts_with(prefix))
}

fn is_viable_base_branch_name(branch_name: &str, main_branch: Option<&str>) -> bool {
    let normalized = branch_name.trim();
    !normalized.is_empty()
        && normalized != MACRO_BRANCH_NAME
        && Some(normalized) != main_branch
        && !looks_like_work_branch(normalized)
}

fn detect_unique_non_work_branch(
    repo: &Repository,
    excluded_branch: Option<&str>,
    current_branch: Option<&str>,
) -> Option<String> {
    let candidates = distinct_branch_names(repo)
        .into_iter()
        .filter(|branch_name| is_viable_base_branch_name(branch_name, excluded_branch))
        .filter(|branch_name| {
            Some(branch_name.as_str()) == current_branch
                || branch_exists(repo, &format!("origin/{}", branch_name), BranchType::Remote)
        })
        .collect::<Vec<_>>();

    if candidates.len() == 1 {
        candidates.into_iter().next()
    } else {
        None
    }
}

fn count_viable_branch_candidates(branch_names: &[String]) -> usize {
    branch_names
        .iter()
        .filter(|branch_name| !looks_like_work_branch(branch_name))
        .count()
}

fn should_confirm_git_flow_branch_mapping(
    main_branch: Option<&str>,
    base_branch: Option<&str>,
    branch_candidates: &[String],
) -> bool {
    let viable_branch_count = count_viable_branch_candidates(branch_candidates);
    if viable_branch_count <= 1 {
        return false;
    }

    main_branch.is_none()
        || main_branch.is_some_and(|branch_name| !is_known_main_branch_name(branch_name))
        || base_branch.is_none()
        || base_branch.is_some_and(|branch_name| !is_known_base_branch_name(branch_name))
        || matches!(
            (main_branch, base_branch),
            (Some(main_branch), Some(base_branch)) if main_branch == base_branch
        )
}

fn directory_is_empty(path: &Path) -> Result<bool> {
    let mut entries = fs::read_dir(path).map_err(|e| BackendError::Io {
        message: e.to_string(),
        source: e,
    })?;
    Ok(entries.next().is_none())
}

fn describe_metadata_gitfile(worktree_path: &Path) -> String {
    fs::read_to_string(worktree_path.join(".git"))
        .ok()
        .and_then(|content| content.lines().next().map(str::to_string))
        .filter(|line| !line.trim().is_empty())
        .unwrap_or_else(|| "missing .git pointer".to_string())
}

fn resolve_git_pointer_path(base: &Path, raw_path: &str) -> PathBuf {
    let path = PathBuf::from(raw_path.trim());
    if path.is_absolute() {
        path
    } else {
        base.join(path)
    }
}

fn canonicalize_for_cache(path: &Path) -> PathBuf {
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    std::fs::canonicalize(&candidate).unwrap_or(candidate)
}

fn collect_git_admin_dirs_without_opening(workspace_path: &Path) -> Vec<PathBuf> {
    let dot_git = workspace_path.join(".git");
    let mut dirs = Vec::new();
    if dot_git.is_dir() {
        dirs.push(dot_git);
        return dirs;
    }

    if !dot_git.is_file() {
        return dirs;
    }

    let Ok(content) = fs::read_to_string(&dot_git) else {
        return dirs;
    };
    let Some(gitdir) = content
        .lines()
        .find_map(|line| line.trim().strip_prefix("gitdir:").map(str::trim))
        .filter(|value| !value.is_empty())
        .map(|value| resolve_git_pointer_path(workspace_path, value))
    else {
        return dirs;
    };

    dirs.push(gitdir.clone());
    let commondir_path = gitdir.join("commondir");
    if let Ok(commondir) = fs::read_to_string(&commondir_path) {
        let common = resolve_git_pointer_path(&gitdir, commondir.trim());
        if !dirs.contains(&common) {
            dirs.push(common);
        }
    }
    dirs
}

pub fn find_existing_macro_metadata_worktree_root(workspace_path: &Path) -> Option<PathBuf> {
    collect_git_admin_dirs_without_opening(workspace_path)
        .into_iter()
        .map(|git_dir| git_dir.join(MACRO_WORKTREE_DIR_NAME))
        .find(|candidate| candidate.join(".git").exists())
        .map(|candidate| std::fs::canonicalize(&candidate).unwrap_or(candidate))
}

pub(crate) fn repair_existing_macro_metadata_worktree(
    repo: &Repository,
) -> Result<Option<MacroMetadataWorktreeEnsureResult>> {
    let worktree_path = repo.path().join(MACRO_WORKTREE_DIR_NAME);
    if !worktree_path.join(".git").exists() {
        return Ok(None);
    }

    let mut repaired_after_move = false;
    if Repository::open(&worktree_path).is_err() {
        repaired_after_move =
            worktree::repair_gitfile_worktree_links(repo, MACRO_WORKTREE_NAME, &worktree_path)?;
        if !repaired_after_move || Repository::open(&worktree_path).is_err() {
            return Ok(None);
        }
    }

    migrate_legacy_metadata_layout(&worktree_path)?;
    ensure_metadata_gitignore_override(&worktree_path)?;
    Ok(Some(MacroMetadataWorktreeEnsureResult {
        worktree_path,
        repaired_after_move,
    }))
}

fn resolve_commit_branch_override(
    repo: &Repository,
    preferred_commit_branch: Option<&str>,
    current_branch: Option<&str>,
) -> Option<String> {
    let preferred_commit_branch = preferred_commit_branch
        .map(str::trim)
        .filter(|branch_name| !branch_name.is_empty())?;

    if Some(preferred_commit_branch) == current_branch
        || branch_exists(repo, preferred_commit_branch, BranchType::Local)
        || branch_exists(
            repo,
            &format!("origin/{}", preferred_commit_branch),
            BranchType::Remote,
        )
    {
        return Some(preferred_commit_branch.to_string());
    }

    None
}

pub(crate) fn detect_preferred_git_flow_branches(repo: &Repository) -> GitFlowBranchDetection {
    let current = current_branch_name(repo);
    let branch_candidates = distinct_branch_names(repo);
    let main_branch = resolve_origin_head_branch(repo)
        .or_else(|| detect_preferred_branch_name(repo, PREFERRED_MAIN_BRANCHES))
        .or_else(|| detect_unique_non_work_branch(repo, None, current.as_deref()));
    let base_branch = detect_preferred_branch_name(repo, PREFERRED_BASE_BRANCHES)
        .or_else(|| {
            current.clone().filter(|branch_name| {
                is_viable_base_branch_name(branch_name, main_branch.as_deref())
            })
        })
        .or_else(|| detect_unique_non_work_branch(repo, main_branch.as_deref(), current.as_deref()))
        .or_else(|| main_branch.clone());
    let commit_branch = base_branch
        .clone()
        .or_else(|| main_branch.clone())
        .or(current.clone());
    let requires_confirmation = should_confirm_git_flow_branch_mapping(
        main_branch.as_deref(),
        base_branch.as_deref(),
        &branch_candidates,
    );

    GitFlowBranchDetection {
        main_branch,
        base_branch,
        commit_branch,
        current_branch: current,
        branch_candidates,
        requires_confirmation,
    }
}

fn task_worktree_gitignore_rule_exists(content: &str) -> bool {
    content.lines().any(|line| {
        matches!(
            line.trim_end_matches('\r').trim(),
            ".macro" | "/.macro" | "/.macro/"
        )
    })
}

fn append_task_worktree_gitignore_rule(content: &mut String) -> bool {
    if task_worktree_gitignore_rule_exists(content) {
        return false;
    }

    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }

    content.push_str(TASK_WORKTREE_GITIGNORE_RULE);
    content.push('\n');
    true
}

fn ensure_task_worktree_rule_in_file(path: &Path) -> Result<bool> {
    let mut content = if path.exists() {
        fs::read_to_string(path).map_err(|e| BackendError::Io {
            message: e.to_string(),
            source: e,
        })?
    } else {
        String::new()
    };

    let changed = append_task_worktree_gitignore_rule(&mut content);
    if !changed {
        return Ok(false);
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| BackendError::Io {
            message: e.to_string(),
            source: e,
        })?;
    }

    fs::write(path, content).map_err(|e| BackendError::Io {
        message: e.to_string(),
        source: e,
    })?;

    Ok(true)
}

fn ensure_task_worktree_rule_in_exclude(repo: &Repository) -> Result<()> {
    let exclude_path = repo.path().join("info").join("exclude");
    let _ = ensure_task_worktree_rule_in_file(&exclude_path)?;
    Ok(())
}

fn ensure_local_branch_available(repo: &Repository, branch_name: &str) -> Result<()> {
    if branch_exists(repo, branch_name, BranchType::Local) {
        return Ok(());
    }

    let remote_name = format!("origin/{}", branch_name);
    let remote_branch = repo
        .find_branch(&remote_name, BranchType::Remote)
        .map_err(|_| BackendError::Git {
            message: format!("Cannot resolve branch '{}'", branch_name),
        })?;
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
    Ok(())
}

fn commit_gitignore_rule_with_cli(workdir: &Path) -> Result<()> {
    let mut add_command = background_command("git");
    add_command
        .current_dir(workdir)
        .args(["add", "--", ".gitignore"]);
    let add_output = add_command.output().map_err(|e| BackendError::Io {
        message: e.to_string(),
        source: e,
    })?;
    if !add_output.status.success() {
        return Err(BackendError::Git {
            message: String::from_utf8_lossy(&add_output.stderr)
                .trim()
                .to_string(),
        });
    }

    let mut diff_command = background_command("git");
    diff_command
        .current_dir(workdir)
        .args(["diff", "--cached", "--quiet", "--", ".gitignore"]);
    let diff_output = diff_command.output().map_err(|e| BackendError::Io {
        message: e.to_string(),
        source: e,
    })?;
    if diff_output.status.code() == Some(0) {
        return Ok(());
    }
    if diff_output.status.code() != Some(1) {
        return Err(BackendError::Git {
            message: String::from_utf8_lossy(&diff_output.stderr)
                .trim()
                .to_string(),
        });
    }

    let mut commit_command = background_command("git");
    commit_command.current_dir(workdir).args([
        "-c",
        "user.name=Macro",
        "-c",
        "user.email=macro@local",
        "commit",
        "-m",
        TASK_WORKTREE_GITIGNORE_COMMIT_MESSAGE,
        "--",
        ".gitignore",
    ]);
    let commit_output = commit_command.output().map_err(|e| BackendError::Io {
        message: e.to_string(),
        source: e,
    })?;

    if !commit_output.status.success() {
        return Err(BackendError::Git {
            message: String::from_utf8_lossy(&commit_output.stderr)
                .trim()
                .to_string(),
        });
    }

    Ok(())
}

fn render_gitignore_with_rule(content: &str) -> Option<String> {
    let mut next = content.to_string();
    if append_task_worktree_gitignore_rule(&mut next) {
        Some(next)
    } else {
        None
    }
}

fn read_branch_gitignore<'repo>(
    repo: &'repo Repository,
    branch_name: &str,
) -> Result<(git2::Commit<'repo>, String)> {
    ensure_local_branch_available(repo, branch_name)?;
    let branch = repo
        .find_branch(branch_name, BranchType::Local)
        .map_err(|e| BackendError::Git {
            message: format!("Failed to open branch '{}': {}", branch_name, e),
        })?;
    let commit = branch
        .get()
        .peel_to_commit()
        .map_err(|e| BackendError::Git {
            message: format!("Failed to resolve branch '{}': {}", branch_name, e),
        })?;
    let tree = commit.tree().map_err(|e| BackendError::Git {
        message: format!("Failed to read tree for branch '{}': {}", branch_name, e),
    })?;

    let content = match tree.get_name(".gitignore") {
        Some(entry) => {
            let object = entry.to_object(repo).map_err(|e| BackendError::Git {
                message: format!("Failed to read .gitignore from '{}': {}", branch_name, e),
            })?;
            let blob = object.as_blob().ok_or_else(|| BackendError::Git {
                message: format!(".gitignore on '{}' is not a blob", branch_name),
            })?;
            String::from_utf8(blob.content().to_vec())
                .map_err(|e| BackendError::Validation(e.to_string()))?
        }
        None => String::new(),
    };

    Ok((commit, content))
}

fn commit_gitignore_rule_to_branch(repo: &Repository, branch_name: &str) -> Result<bool> {
    let (parent_commit, existing_content) = read_branch_gitignore(repo, branch_name)?;
    let Some(next_content) = render_gitignore_with_rule(&existing_content) else {
        return Ok(false);
    };

    let parent_tree = parent_commit.tree().map_err(|e| BackendError::Git {
        message: format!("Failed to read tree for branch '{}': {}", branch_name, e),
    })?;
    let blob_id = repo
        .blob(next_content.as_bytes())
        .map_err(|e| BackendError::Git {
            message: format!(
                "Failed to write .gitignore blob for '{}': {}",
                branch_name, e
            ),
        })?;
    let mut treebuilder = repo
        .treebuilder(Some(&parent_tree))
        .map_err(|e| BackendError::Git {
            message: format!("Failed to create treebuilder for '{}': {}", branch_name, e),
        })?;
    treebuilder
        .insert(".gitignore", blob_id, 0o100644)
        .map_err(|e| BackendError::Git {
            message: format!("Failed to update .gitignore for '{}': {}", branch_name, e),
        })?;
    let tree_id = treebuilder.write().map_err(|e| BackendError::Git {
        message: format!("Failed to write tree for '{}': {}", branch_name, e),
    })?;
    let tree = repo.find_tree(tree_id).map_err(|e| BackendError::Git {
        message: format!("Failed to open new tree for '{}': {}", branch_name, e),
    })?;
    let signature = repo
        .signature()
        .or_else(|_| Signature::now("Macro", "macro@local"))
        .map_err(|e| BackendError::Git {
            message: format!("Failed to build signature for '{}': {}", branch_name, e),
        })?;

    repo.commit(
        Some(&format!("refs/heads/{}", branch_name)),
        &signature,
        &signature,
        TASK_WORKTREE_GITIGNORE_COMMIT_MESSAGE,
        &tree,
        &[&parent_commit],
    )
    .map_err(|e| BackendError::Git {
        message: format!("Failed to commit .gitignore on '{}': {}", branch_name, e),
    })?;

    Ok(true)
}

fn ensure_metadata_branch_exists(repo: &Repository) -> Result<()> {
    if repo
        .find_branch(MACRO_BRANCH_NAME, BranchType::Local)
        .is_ok()
    {
        return Ok(());
    }

    let tree_id = repo.treebuilder(None)?.write()?;
    let tree = repo.find_tree(tree_id)?;
    let signature = repo
        .signature()
        .or_else(|_| Signature::now("Macro", "macro@local"))?;
    repo.commit(
        Some(&format!("refs/heads/{}", MACRO_BRANCH_NAME)),
        &signature,
        &signature,
        "chore(metadata): initialize @macro branch",
        &tree,
        &[],
    )?;
    Ok(())
}

fn migrate_legacy_metadata_layout(worktree_path: &Path) -> Result<()> {
    let legacy_root = worktree_path.join(LEGACY_METADATA_DIR_NAME);
    if !legacy_root.is_dir() {
        return Ok(());
    }

    for entry in fs::read_dir(&legacy_root).map_err(|e| BackendError::Io {
        message: e.to_string(),
        source: e,
    })? {
        let entry = entry.map_err(|e| BackendError::Io {
            message: e.to_string(),
            source: e,
        })?;
        let source = entry.path();
        let target = worktree_path.join(entry.file_name());

        if target.exists() {
            continue;
        }

        fs::rename(&source, &target).map_err(|e| BackendError::Io {
            message: format!(
                "Failed to migrate legacy metadata item {} to {}: {}",
                source.display(),
                target.display(),
                e
            ),
            source: e,
        })?;
    }

    let _ = fs::remove_dir(&legacy_root);
    Ok(())
}

fn ensure_metadata_gitignore_override(worktree_path: &Path) -> Result<()> {
    let gitignore_path = worktree_path.join(".gitignore");
    if !gitignore_path.exists() {
        return Ok(());
    }

    let mut content = fs::read_to_string(&gitignore_path).map_err(|e| BackendError::Io {
        message: e.to_string(),
        source: e,
    })?;

    const MARKER: &str = "# macro metadata branch overrides";
    const REQUIRED_LINES: &[&str] = &["!workspace.json", "!branches", "!branches/**"];

    if !content.ends_with('\n') {
        content.push('\n');
    }

    let mut changed = false;
    if !content.contains(MARKER) {
        content.push_str(MARKER);
        content.push('\n');
        changed = true;
    }

    for line in REQUIRED_LINES {
        let needle = format!("{}\n", line);
        if !content.contains(&needle) {
            content.push_str(line);
            content.push('\n');
            changed = true;
        }
    }

    if !changed {
        return Ok(());
    }

    fs::write(&gitignore_path, content).map_err(|e| BackendError::Io {
        message: e.to_string(),
        source: e,
    })?;

    Ok(())
}

fn ensure_task_worktree_gitignore_rule(
    repo: &Repository,
    workdir: &Path,
    preferred_commit_branch: Option<&str>,
) -> Result<()> {
    ensure_task_worktree_rule_in_exclude(repo)?;

    let detection = detect_preferred_git_flow_branches(repo);
    let commit_branch = resolve_commit_branch_override(
        repo,
        preferred_commit_branch,
        detection.current_branch.as_deref(),
    )
    .or_else(|| {
        if detection.requires_confirmation {
            None
        } else {
            detection.commit_branch.clone()
        }
    });
    let Some(commit_branch) = commit_branch else {
        return Ok(());
    };

    if detection.current_branch.as_deref() == Some(commit_branch.as_str()) {
        if ensure_task_worktree_rule_in_file(&workdir.join(".gitignore"))? {
            commit_gitignore_rule_with_cli(workdir)?;
        }
        return Ok(());
    }

    let _ = commit_gitignore_rule_to_branch(repo, &commit_branch)?;
    Ok(())
}

#[derive(Clone)]
/// Shared Git state with repository/worktree caches.
pub struct GitState {
    inner: Arc<GitStateInner>,
}

#[allow(dead_code)]
struct GitStateInner {
    repos: Mutex<HashMap<PathBuf, Arc<Mutex<Repository>>>>,
    worktrees: Mutex<HashMap<String, PathBuf>>,
    metadata_roots: Mutex<HashMap<PathBuf, MacroMetadataWorktreeEnsureResult>>,
}

impl GitState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(GitStateInner {
                repos: Mutex::new(HashMap::new()),
                worktrees: Mutex::new(HashMap::new()),
                metadata_roots: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Open a repository and cache its handle.
    pub fn open_repo(&self, path: &Path) -> Result<Arc<Mutex<Repository>>> {
        let canonical = canonicalize_for_cache(path);
        let mut repos = self
            .inner
            .repos
            .lock()
            .map_err(|_| BackendError::Internal {
                message: "Failed to lock git repository cache".to_string(),
            })?;

        if let Some(repo) = repos.get(&canonical) {
            return Ok(repo.clone());
        }

        let repo = Repository::discover(&canonical)
            .or_else(|_| Repository::open(&canonical))
            .map_err(|e| BackendError::GitRepositoryNotFound {
                message: format!("{}", e),
            })?;
        let repo_arc = Arc::new(Mutex::new(repo));
        repos.insert(canonical, repo_arc.clone());
        Ok(repo_arc)
    }

    #[allow(dead_code)]
    pub fn get_worktree(&self, task_id: &str) -> Option<PathBuf> {
        self.inner
            .worktrees
            .lock()
            .ok()
            .and_then(|map| map.get(task_id).cloned())
    }

    #[allow(dead_code)]
    pub fn register_worktree(&self, task_id: &str, worktree_path: PathBuf) {
        if let Ok(mut map) = self.inner.worktrees.lock() {
            map.insert(task_id.to_string(), worktree_path);
        }
    }

    pub fn ensure_macro_metadata_worktree_with_status(
        &self,
        repo: &Repository,
    ) -> Result<MacroMetadataWorktreeEnsureResult> {
        ensure_metadata_branch_exists(repo)?;
        let workdir = repo.workdir().ok_or_else(|| BackendError::Git {
            message: "Bare repositories are not supported for worktrees".to_string(),
        })?;
        ensure_task_worktree_gitignore_rule(repo, workdir, None)?;

        let git_dir = repo.path();
        let worktree_path = git_dir.join(MACRO_WORKTREE_DIR_NAME);

        if worktree_path.join(".git").exists() {
            let mut repaired_after_move = false;
            if Repository::open(&worktree_path).is_err() {
                repaired_after_move = worktree::repair_gitfile_worktree_links(
                    repo,
                    MACRO_WORKTREE_NAME,
                    &worktree_path,
                )?;
                if !repaired_after_move || Repository::open(&worktree_path).is_err() {
                    return Err(BackendError::Git {
                        message: format!(
                            "Failed to open metadata worktree at {} after repair attempt. {}. Retry the @macro sync after repairing or removing the stale Git worktree pointer.",
                            worktree_path.display(),
                            describe_metadata_gitfile(&worktree_path)
                        ),
                    });
                }
            }
            migrate_legacy_metadata_layout(&worktree_path)?;
            ensure_metadata_gitignore_override(&worktree_path)?;
            return Ok(MacroMetadataWorktreeEnsureResult {
                worktree_path,
                repaired_after_move,
            });
        }

        if worktree_path.exists() {
            if !worktree_path.is_dir() || !directory_is_empty(&worktree_path)? {
                return Err(BackendError::Git {
                    message: format!(
                        "Metadata worktree path {} exists but is not an openable Git worktree. Macro left it untouched to avoid losing @macro files. Move it aside or repair its .git pointer, then retry @macro sync.",
                        worktree_path.display()
                    ),
                });
            }
            fs::remove_dir_all(&worktree_path).map_err(|e| BackendError::Io {
                message: e.to_string(),
                source: e,
            })?;
        }

        match repo.find_worktree(MACRO_WORKTREE_NAME) {
            Ok(worktree) => {
                let mut prune_opts = git2::WorktreePruneOptions::new();
                prune_opts.valid(true);
                let _ = worktree.prune(Some(&mut prune_opts));
            }
            Err(err) if err.code() == ErrorCode::NotFound => {}
            Err(err) => {
                let admin_path = git_dir.join("worktrees").join(MACRO_WORKTREE_NAME);
                if admin_path.exists() {
                    fs::remove_dir_all(&admin_path).map_err(|e| BackendError::Io {
                        message: e.to_string(),
                        source: e,
                    })?;
                } else {
                    return Err(BackendError::Git {
                        message: format!(
                            "Failed to inspect metadata worktree registration '{}': {}",
                            MACRO_WORKTREE_NAME, err
                        ),
                    });
                }
            }
        }

        let reference = repo
            .find_reference(&format!("refs/heads/{}", MACRO_BRANCH_NAME))
            .map_err(|e| BackendError::Git {
                message: format!(
                    "Failed to find metadata branch '{}': {}",
                    MACRO_BRANCH_NAME, e
                ),
            })?;

        let mut opts = WorktreeAddOptions::new();
        opts.reference(Some(&reference));

        repo.worktree(MACRO_WORKTREE_NAME, &worktree_path, Some(&opts))
            .map_err(|e| BackendError::Git {
                message: format!("Failed to create metadata worktree: {}", e),
            })?;

        migrate_legacy_metadata_layout(&worktree_path)?;
        ensure_metadata_gitignore_override(&worktree_path)?;
        Ok(MacroMetadataWorktreeEnsureResult {
            worktree_path,
            repaired_after_move: false,
        })
    }

    pub fn ensure_macro_metadata_worktree(&self, repo: &Repository) -> Result<PathBuf> {
        let ensured = self.ensure_macro_metadata_worktree_with_status(repo)?;
        Ok(ensured.worktree_path)
    }

    pub fn resolve_macro_metadata_root_with_status(
        &self,
        workspace_path: &Path,
    ) -> Result<MacroMetadataWorktreeEnsureResult> {
        let cache_key = canonicalize_for_cache(workspace_path);
        let mut metadata_roots =
            self.inner
                .metadata_roots
                .lock()
                .map_err(|_| BackendError::Internal {
                    message: "Failed to lock git metadata root cache".to_string(),
                })?;
        if let Some(cached) = metadata_roots.get(&cache_key).cloned() {
            return Ok(cached);
        }

        let repo = match self.open_repo(workspace_path) {
            Ok(repo) => repo,
            Err(error) => {
                if let Some(worktree_path) =
                    find_existing_macro_metadata_worktree_root(workspace_path)
                {
                    migrate_legacy_metadata_layout(&worktree_path)?;
                    ensure_metadata_gitignore_override(&worktree_path)?;
                    let ensured = MacroMetadataWorktreeEnsureResult {
                        worktree_path,
                        repaired_after_move: false,
                    };
                    metadata_roots.insert(cache_key, ensured.clone());
                    tracing::debug!(
                        action = "macro_metadata_root_existing_worktree_without_repo_open",
                        workspace_path = %workspace_path.display(),
                        metadata_root = %ensured.worktree_path.display(),
                        reason = %error
                    );
                    return Ok(ensured);
                }
                return Err(error);
            }
        };
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;
        let ensured = self.ensure_macro_metadata_worktree_with_status(&repo)?;
        metadata_roots.insert(cache_key, ensured.clone());
        Ok(ensured)
    }

    pub fn resolve_macro_metadata_root(&self, workspace_path: &Path) -> Result<PathBuf> {
        let ensured = self.resolve_macro_metadata_root_with_status(workspace_path)?;
        Ok(ensured.worktree_path)
    }

    pub fn debug_reset_macro_project_artifacts(
        &self,
        project_path: &Path,
    ) -> Result<MacroProjectResetResult> {
        let repo = self.open_repo(project_path)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;
        let mut result = MacroProjectResetResult::default();

        let workdir = repo.workdir().ok_or_else(|| BackendError::Git {
            message: "Bare repositories are not supported for Macro project reset".to_string(),
        })?;
        let task_worktree_root = workdir.join(LEGACY_METADATA_DIR_NAME).join("worktrees");
        let canonical_task_root =
            std::fs::canonicalize(&task_worktree_root).unwrap_or(task_worktree_root.clone());

        let worktree_names = repo.worktrees().map_err(|e| BackendError::Git {
            message: format!("Failed to list registered worktrees: {}", e),
        })?;
        for worktree_name in worktree_names.iter().flatten() {
            let worktree = match repo.find_worktree(worktree_name) {
                Ok(worktree) => worktree,
                Err(err) if err.code() == ErrorCode::NotFound => continue,
                Err(err) => {
                    result.warnings.push(format!(
                        "Failed to inspect worktree '{}': {}",
                        worktree_name, err
                    ));
                    continue;
                }
            };
            let worktree_path = worktree.path().to_path_buf();
            let canonical_worktree_path =
                std::fs::canonicalize(&worktree_path).unwrap_or(worktree_path.clone());
            if canonical_worktree_path.starts_with(&canonical_task_root) {
                if remove_macro_path_if_present(&worktree_path)? {
                    result.removed_task_worktrees += 1;
                }
                let mut prune_opts = git2::WorktreePruneOptions::new();
                prune_opts.valid(true);
                if let Err(err) = worktree.prune(Some(&mut prune_opts)) {
                    result.warnings.push(format!(
                        "Failed to prune worktree '{}': {}",
                        worktree_name, err
                    ));
                }
            }
        }

        if remove_macro_path_if_present(&task_worktree_root)? && result.removed_task_worktrees == 0
        {
            result.removed_task_worktrees = 1;
        }

        if let Ok(mut cache) = self.inner.worktrees.lock() {
            cache.retain(|_, path| {
                let canonical_path =
                    std::fs::canonicalize(path.as_path()).unwrap_or_else(|_| path.clone());
                !canonical_path.starts_with(&canonical_task_root)
            });
        }

        let metadata_worktree_path = repo.path().join(MACRO_WORKTREE_DIR_NAME);
        match repo.find_worktree(MACRO_WORKTREE_NAME) {
            Ok(metadata_worktree) => {
                let registered_path = metadata_worktree.path().to_path_buf();
                let removed_registered_path = remove_macro_path_if_present(&registered_path)?;
                let mut prune_opts = git2::WorktreePruneOptions::new();
                prune_opts.valid(true);
                if let Err(err) = metadata_worktree.prune(Some(&mut prune_opts)) {
                    result.warnings.push(format!(
                        "Failed to prune Macro metadata worktree '{}': {}",
                        MACRO_WORKTREE_NAME, err
                    ));
                }
                result.removed_metadata_worktree = removed_registered_path;
            }
            Err(err) if err.code() == ErrorCode::NotFound => {}
            Err(err) => {
                result.warnings.push(format!(
                    "Failed to inspect Macro metadata worktree '{}': {}",
                    MACRO_WORKTREE_NAME, err
                ));
            }
        }

        if remove_macro_path_if_present(&metadata_worktree_path)? {
            result.removed_metadata_worktree = true;
        }

        if remove_macro_path_if_present(&workdir.join(LEGACY_METADATA_DIR_NAME))? {
            result.removed_metadata_worktree = true;
        }

        match repo.find_branch(MACRO_BRANCH_NAME, BranchType::Local) {
            Ok(mut branch) => match branch.delete() {
                Ok(()) => {
                    result.removed_macro_branch = true;
                }
                Err(err) => {
                    result.warnings.push(format!(
                        "Failed to delete local Macro metadata branch '{}': {}",
                        MACRO_BRANCH_NAME, err
                    ));
                }
            },
            Err(err) if err.code() == ErrorCode::NotFound => {}
            Err(err) => {
                result.warnings.push(format!(
                    "Failed to inspect local Macro metadata branch '{}': {}",
                    MACRO_BRANCH_NAME, err
                ));
            }
        }

        if let Ok(mut metadata_roots) = self.inner.metadata_roots.lock() {
            metadata_roots.remove(&canonicalize_for_cache(workdir));
        }

        Ok(result)
    }
}

fn remove_macro_path_if_present(path: &Path) -> Result<bool> {
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

impl Default for GitState {
    fn default() -> Self {
        Self::new()
    }
}

#[allow(dead_code)]
pub struct GitRepository {
    pub repo: Arc<Mutex<Repository>>,
    pub path: PathBuf,
}

impl GitRepository {
    /// Open an existing Git repository from a path.
    #[allow(dead_code)]
    pub fn open(path: &Path) -> Result<Self> {
        let repo = Repository::discover(path).or_else(|_| Repository::open(path))?;
        let repo_path = repo
            .workdir()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| path.to_path_buf());

        Ok(Self {
            repo: Arc::new(Mutex::new(repo)),
            path: repo_path,
        })
    }

    /// Initialize a new Git repository at the given path.
    #[allow(dead_code)]
    pub fn init(path: &Path) -> Result<Self> {
        if path.join(".git").exists() {
            return Err(BackendError::Git {
                message: "Repository already exists".to_string(),
            });
        }

        let mut opts = RepositoryInitOptions::new();
        opts.initial_head("main");
        let repo = Repository::init_opts(path, &opts)?;

        Ok(Self {
            repo: Arc::new(Mutex::new(repo)),
            path: path.to_path_buf(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::build::CheckoutBuilder;
    use std::fs;
    use tempfile::TempDir;

    fn init_repo(path: &Path) -> Repository {
        let mut opts = RepositoryInitOptions::new();
        opts.initial_head("main");
        let repo = Repository::init_opts(path, &opts).expect("init repo");
        let file_path = path.join("README.md");
        fs::write(&file_path, "hello").expect("write file");

        let mut index = repo.index().expect("index");
        index.add_path(Path::new("README.md")).expect("add");
        let tree_id = index.write_tree().expect("write tree");
        {
            let tree = repo.find_tree(tree_id).expect("tree");
            let sig = git2::Signature::now("Tester", "tester@example.com").expect("sig");
            repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[])
                .expect("commit");
        }

        repo
    }

    fn checkout_branch(repo: &Repository, branch_name: &str) {
        let head_commit = repo
            .head()
            .and_then(|head| head.peel_to_commit())
            .expect("head commit");
        if repo
            .find_branch(branch_name, git2::BranchType::Local)
            .is_err()
        {
            repo.branch(branch_name, &head_commit, false)
                .expect("create branch");
        }
        repo.set_head(&format!("refs/heads/{}", branch_name))
            .expect("set head");
        repo.checkout_head(Some(CheckoutBuilder::new().force()))
            .expect("checkout head");
    }

    fn current_branch_name_for_test(repo: &Repository) -> Option<String> {
        if repo.head_detached().ok()? {
            return None;
        }
        repo.head()
            .ok()
            .and_then(|head| head.shorthand().map(|value| value.to_string()))
    }

    fn read_branch_file(repo: &Repository, branch_name: &str, path: &str) -> Option<String> {
        let branch = repo.find_branch(branch_name, BranchType::Local).ok()?;
        let commit = branch.get().peel_to_commit().ok()?;
        let tree = commit.tree().ok()?;
        let entry = tree.get_name(path)?;
        let object = entry.to_object(repo).ok()?;
        let blob = object.as_blob()?;
        String::from_utf8(blob.content().to_vec()).ok()
    }

    fn set_origin_head(repo: &Repository, branch_name: &str) {
        let commit_id = repo
            .find_branch(branch_name, BranchType::Local)
            .expect("find local branch")
            .get()
            .target()
            .expect("branch target");
        repo.reference(
            &format!("refs/remotes/origin/{}", branch_name),
            commit_id,
            true,
            "set remote branch",
        )
        .expect("create remote branch ref");
        repo.reference_symbolic(
            "refs/remotes/origin/HEAD",
            &format!("refs/remotes/origin/{}", branch_name),
            true,
            "set origin head",
        )
        .expect("set origin head");
    }

    #[test]
    fn test_ensure_task_worktree_creates_path() {
        let temp = TempDir::new().expect("temp dir");
        let repo = init_repo(temp.path());
        let state = GitState::new();

        let ensured = state
            .ensure_task_worktree(&repo, "123", "task-123", None, None, &[])
            .expect("worktree");
        let worktree_path = ensured.worktree_path;

        assert!(worktree_path.ends_with(Path::new(".macro/worktrees/task123")));
        assert!(worktree_path.join(".git").exists());
        assert_eq!(ensured.status, TaskWorktreeEnsureStatus::Created);
        assert_eq!(
            fs::read_to_string(temp.path().join(".gitignore")).expect("read gitignore"),
            format!("{TASK_WORKTREE_GITIGNORE_RULE}\n")
        );
    }

    #[test]
    fn test_ensure_task_worktree_appends_gitignore_rule() {
        let temp = TempDir::new().expect("temp dir");
        let repo = init_repo(temp.path());
        let state = GitState::new();

        fs::write(temp.path().join(".gitignore"), "node_modules").expect("write gitignore");

        state
            .ensure_task_worktree(&repo, "124", "task-124", None, None, &[])
            .expect("worktree");

        assert_eq!(
            fs::read_to_string(temp.path().join(".gitignore")).expect("read gitignore"),
            format!("node_modules\n{TASK_WORKTREE_GITIGNORE_RULE}\n")
        );
    }

    #[test]
    fn test_ensure_task_worktree_reuses_existing_gitignore_rule_variants() {
        for (index, existing_rule) in [".macro", "/.macro", "/.macro/"].iter().enumerate() {
            let temp = TempDir::new().expect("temp dir");
            let repo = init_repo(temp.path());
            let state = GitState::new();

            fs::write(
                temp.path().join(".gitignore"),
                format!("node_modules\n{}\n", existing_rule),
            )
            .expect("write gitignore");

            state
                .ensure_task_worktree(
                    &repo,
                    &format!("reuse-{index}"),
                    &format!("task-reuse-{index}"),
                    None,
                    None,
                    &[],
                )
                .expect("worktree");

            assert_eq!(
                fs::read_to_string(temp.path().join(".gitignore")).expect("read gitignore"),
                format!("node_modules\n{}\n", existing_rule)
            );
        }
    }

    #[test]
    fn test_ensure_task_worktree_is_idempotent_for_gitignore() {
        let temp = TempDir::new().expect("temp dir");
        let repo = init_repo(temp.path());
        let state = GitState::new();

        let first_path = state
            .ensure_task_worktree(&repo, "125", "task-125", None, None, &[])
            .expect("first worktree")
            .worktree_path;
        let second_path = state
            .ensure_task_worktree(&repo, "125", "task-125", None, None, &[])
            .expect("second worktree")
            .worktree_path;

        assert_eq!(first_path, second_path);
        assert_eq!(
            fs::read_to_string(temp.path().join(".gitignore")).expect("read gitignore"),
            format!("{TASK_WORKTREE_GITIGNORE_RULE}\n")
        );
    }

    #[test]
    fn test_ensure_macro_metadata_worktree_applies_gitignore_rule_retroactively() {
        let temp = TempDir::new().expect("temp dir");
        let repo = init_repo(temp.path());
        let state = GitState::new();

        fs::write(temp.path().join(".gitignore"), "node_modules").expect("write gitignore");

        let worktree_path = state
            .ensure_macro_metadata_worktree(&repo)
            .expect("metadata worktree");

        assert!(worktree_path.join(".git").exists());
        assert_eq!(
            fs::read_to_string(temp.path().join(".gitignore")).expect("read gitignore"),
            format!("node_modules\n{TASK_WORKTREE_GITIGNORE_RULE}\n")
        );
    }

    #[test]
    fn test_ensure_macro_metadata_worktree_repairs_after_project_rename() {
        let temp = TempDir::new().expect("temp dir");
        let original_path = temp.path().join("lplr-app");
        let renamed_path = temp.path().join("octan_sales");
        fs::create_dir(&original_path).expect("create original project dir");

        {
            let repo = init_repo(&original_path);
            let state = GitState::new();
            let worktree_path = state
                .ensure_macro_metadata_worktree(&repo)
                .expect("metadata worktree");
            fs::write(worktree_path.join("plan.txt"), "kept metadata")
                .expect("write metadata file");
            assert!(Repository::open(&worktree_path).is_ok());
        }

        fs::rename(&original_path, &renamed_path).expect("rename project dir");
        let repo = Repository::open(&renamed_path).expect("open renamed repo");
        let state = GitState::new();

        let ensured = state
            .ensure_macro_metadata_worktree_with_status(&repo)
            .expect("repair metadata worktree");

        assert!(ensured.repaired_after_move);
        assert!(Repository::open(&ensured.worktree_path).is_ok());
        assert_eq!(
            fs::read_to_string(ensured.worktree_path.join("plan.txt")).expect("read metadata file"),
            "kept metadata"
        );
        let gitfile =
            fs::read_to_string(ensured.worktree_path.join(".git")).expect("read repaired gitfile");
        assert!(!gitfile.contains("lplr-app"));
        assert!(!gitfile.contains(&original_path.to_string_lossy().to_string()));
    }

    #[test]
    fn test_find_existing_macro_metadata_worktree_from_linked_worktree() {
        let temp = TempDir::new().expect("temp dir");
        let primary_path = temp.path().join("octan_sales");
        let linked_path = temp.path().join("octan_sales-linked");
        fs::create_dir(&primary_path).expect("create primary project dir");

        let repo = init_repo(&primary_path);
        let state = GitState::new();
        let metadata_root = state
            .ensure_macro_metadata_worktree(&repo)
            .expect("metadata worktree");
        fs::write(metadata_root.join("plan.txt"), "metadata from common repo")
            .expect("write metadata file");
        repo.worktree("octan_sales-linked", &linked_path, None)
            .expect("create linked worktree");

        let found = find_existing_macro_metadata_worktree_root(&linked_path)
            .expect("find metadata from linked worktree");

        assert_eq!(
            found.canonicalize().expect("canonical found metadata"),
            metadata_root
                .canonicalize()
                .expect("canonical original metadata")
        );
        assert_eq!(
            fs::read_to_string(found.join("plan.txt")).expect("read metadata file"),
            "metadata from common repo"
        );
    }

    #[test]
    fn test_resolve_macro_metadata_root_uses_existing_worktree_when_repo_extension_is_unsupported()
    {
        let temp = TempDir::new().expect("temp dir");
        let repo = init_repo(temp.path());
        let state = GitState::new();
        let metadata_root = state
            .ensure_macro_metadata_worktree(&repo)
            .expect("metadata worktree");
        fs::write(
            metadata_root.join("plan.txt"),
            "metadata survives unsupported extension",
        )
        .expect("write metadata file");
        drop(repo);

        let config_path = temp.path().join(".git").join("config");
        let mut config = fs::read_to_string(&config_path).expect("read git config");
        config.push_str("\n[extensions]\n\trelativeworktrees = true\n");
        fs::write(&config_path, config).expect("write unsupported extension");

        let resolved = state
            .resolve_macro_metadata_root(temp.path())
            .expect("resolve existing metadata root");

        assert_eq!(
            resolved
                .canonicalize()
                .expect("canonical resolved metadata"),
            metadata_root
                .canonicalize()
                .expect("canonical original metadata")
        );
        assert_eq!(
            fs::read_to_string(resolved.join("plan.txt")).expect("read metadata file"),
            "metadata survives unsupported extension"
        );
    }

    #[test]
    fn test_ensure_task_worktree_repairs_git_pointers_after_project_rename() {
        let temp = TempDir::new().expect("temp dir");
        let original_path = temp.path().join("lplr-app");
        let renamed_path = temp.path().join("octan_sales");
        fs::create_dir(&original_path).expect("create original project dir");

        {
            let repo = init_repo(&original_path);
            let state = GitState::new();
            let worktree_path = state
                .ensure_task_worktree(&repo, "rename-task", "feature/rename-task", None, None, &[])
                .expect("task worktree")
                .worktree_path;
            fs::write(worktree_path.join("local-note.txt"), "kept task worktree")
                .expect("write task worktree file");
            assert!(Repository::open(&worktree_path).is_ok());
        }

        fs::rename(&original_path, &renamed_path).expect("rename project dir");
        let repo = Repository::open(&renamed_path).expect("open renamed repo");
        let state = GitState::new();

        let ensured = state
            .ensure_task_worktree(&repo, "rename-task", "feature/rename-task", None, None, &[])
            .expect("repair task worktree");

        assert_eq!(ensured.status, TaskWorktreeEnsureStatus::Reused);
        assert!(Repository::open(&ensured.worktree_path).is_ok());
        assert_eq!(
            fs::read_to_string(ensured.worktree_path.join("local-note.txt"))
                .expect("read task worktree file"),
            "kept task worktree"
        );
        let gitfile =
            fs::read_to_string(ensured.worktree_path.join(".git")).expect("read repaired gitfile");
        assert!(!gitfile.contains("lplr-app"));
        assert!(!gitfile.contains(&original_path.to_string_lossy().to_string()));
    }

    #[test]
    fn test_ensure_task_worktree_commits_gitignore_to_develop_from_another_branch() {
        let temp = TempDir::new().expect("temp dir");
        let repo = init_repo(temp.path());
        let head_commit = repo
            .head()
            .and_then(|head| head.peel_to_commit())
            .expect("head commit");
        repo.branch("develop", &head_commit, false)
            .expect("create develop branch");
        checkout_branch(&repo, "feature/active");

        let state = GitState::new();
        state
            .ensure_task_worktree(&repo, "cross-branch", "task-cross-branch", None, None, &[])
            .expect("worktree");

        assert_eq!(
            current_branch_name_for_test(&repo).as_deref(),
            Some("feature/active")
        );
        assert!(!temp.path().join(".gitignore").exists());
        assert_eq!(
            read_branch_file(&repo, "develop", ".gitignore").as_deref(),
            Some("/.macro/\n")
        );
        assert!(fs::read_to_string(repo.path().join("info").join("exclude"))
            .expect("read exclude")
            .contains(TASK_WORKTREE_GITIGNORE_RULE));
    }

    #[test]
    fn test_ensure_task_worktree_skips_gitignore_commit_for_rare_conventions_without_confirmation()
    {
        let temp = TempDir::new().expect("temp dir");
        let mut opts = RepositoryInitOptions::new();
        opts.initial_head("stable");
        let repo = Repository::init_opts(temp.path(), &opts).expect("init repo");
        let file_path = temp.path().join("README.md");
        fs::write(&file_path, "hello").expect("write file");

        let mut index = repo.index().expect("index");
        index.add_path(Path::new("README.md")).expect("add");
        let tree_id = index.write_tree().expect("write tree");
        {
            let tree = repo.find_tree(tree_id).expect("tree");
            let sig = git2::Signature::now("Tester", "tester@example.com").expect("sig");
            repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[])
                .expect("commit");
        }

        let head_commit = repo
            .head()
            .and_then(|head| head.peel_to_commit())
            .expect("head commit");
        repo.branch("integration-ready", &head_commit, false)
            .expect("create integration branch");

        let state = GitState::new();
        state
            .ensure_task_worktree(&repo, "rare-skip", "task-rare-skip", None, None, &[])
            .expect("worktree");

        assert!(!temp.path().join(".gitignore").exists());
        assert_eq!(read_branch_file(&repo, "stable", ".gitignore"), None);
        assert_eq!(
            read_branch_file(&repo, "integration-ready", ".gitignore"),
            None
        );
        assert!(fs::read_to_string(repo.path().join("info").join("exclude"))
            .expect("read exclude")
            .contains(TASK_WORKTREE_GITIGNORE_RULE));
    }

    #[test]
    fn test_ensure_task_worktree_uses_explicit_preferred_commit_branch_for_rare_conventions() {
        let temp = TempDir::new().expect("temp dir");
        let mut opts = RepositoryInitOptions::new();
        opts.initial_head("stable");
        let repo = Repository::init_opts(temp.path(), &opts).expect("init repo");
        let file_path = temp.path().join("README.md");
        fs::write(&file_path, "hello").expect("write file");

        let mut index = repo.index().expect("index");
        index.add_path(Path::new("README.md")).expect("add");
        let tree_id = index.write_tree().expect("write tree");
        {
            let tree = repo.find_tree(tree_id).expect("tree");
            let sig = git2::Signature::now("Tester", "tester@example.com").expect("sig");
            repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[])
                .expect("commit");
        }

        let head_commit = repo
            .head()
            .and_then(|head| head.peel_to_commit())
            .expect("head commit");
        repo.branch("integration-ready", &head_commit, false)
            .expect("create integration branch");
        checkout_branch(&repo, "feature/active");

        let state = GitState::new();
        state
            .ensure_task_worktree(
                &repo,
                "rare-confirmed",
                "task-rare-confirmed",
                None,
                Some("integration-ready"),
                &[],
            )
            .expect("worktree");

        assert!(!temp.path().join(".gitignore").exists());
        assert_eq!(
            read_branch_file(&repo, "integration-ready", ".gitignore").as_deref(),
            Some("/.macro/\n")
        );
        assert_eq!(read_branch_file(&repo, "stable", ".gitignore"), None);
    }

    #[test]
    fn test_detect_preferred_git_flow_branches_supports_custom_conventions() {
        let temp = TempDir::new().expect("temp dir");
        let mut opts = RepositoryInitOptions::new();
        opts.initial_head("trunk");
        let repo = Repository::init_opts(temp.path(), &opts).expect("init repo");
        let file_path = temp.path().join("README.md");
        fs::write(&file_path, "hello").expect("write file");

        let mut index = repo.index().expect("index");
        index.add_path(Path::new("README.md")).expect("add");
        let tree_id = index.write_tree().expect("write tree");
        {
            let tree = repo.find_tree(tree_id).expect("tree");
            let sig = git2::Signature::now("Tester", "tester@example.com").expect("sig");
            repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[])
                .expect("commit");
        }

        let head_commit = repo
            .head()
            .and_then(|head| head.peel_to_commit())
            .expect("head commit");
        repo.branch("integration", &head_commit, false)
            .expect("create integration branch");
        set_origin_head(&repo, "trunk");

        let detection = detect_preferred_git_flow_branches(&repo);
        assert_eq!(detection.main_branch.as_deref(), Some("trunk"));
        assert_eq!(detection.base_branch.as_deref(), Some("integration"));
        assert_eq!(detection.commit_branch.as_deref(), Some("integration"));
        assert_eq!(detection.current_branch.as_deref(), Some("trunk"));
        assert!(detection.branch_candidates.contains(&"trunk".to_string()));
        assert!(detection
            .branch_candidates
            .contains(&"integration".to_string()));
        assert!(!detection.requires_confirmation);
    }

    #[test]
    fn test_detect_preferred_git_flow_branches_flags_rare_conventions_for_confirmation() {
        let temp = TempDir::new().expect("temp dir");
        let mut opts = RepositoryInitOptions::new();
        opts.initial_head("stable");
        let repo = Repository::init_opts(temp.path(), &opts).expect("init repo");
        let file_path = temp.path().join("README.md");
        fs::write(&file_path, "hello").expect("write file");

        let mut index = repo.index().expect("index");
        index.add_path(Path::new("README.md")).expect("add");
        let tree_id = index.write_tree().expect("write tree");
        {
            let tree = repo.find_tree(tree_id).expect("tree");
            let sig = git2::Signature::now("Tester", "tester@example.com").expect("sig");
            repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[])
                .expect("commit");
        }

        let head_commit = repo
            .head()
            .and_then(|head| head.peel_to_commit())
            .expect("head commit");
        repo.branch("integration-ready", &head_commit, false)
            .expect("create integration-ready branch");

        let detection = detect_preferred_git_flow_branches(&repo);
        assert_eq!(detection.main_branch.as_deref(), Some("stable"));
        assert_eq!(detection.base_branch.as_deref(), Some("stable"));
        assert!(detection.requires_confirmation);
        assert!(detection.branch_candidates.contains(&"stable".to_string()));
        assert!(detection
            .branch_candidates
            .contains(&"integration-ready".to_string()));
    }

    #[test]
    fn test_remove_task_worktree_cleans_up() {
        let temp = TempDir::new().expect("temp dir");
        let repo = init_repo(temp.path());
        let state = GitState::new();

        let worktree_path = state
            .ensure_task_worktree(&repo, "456", "task-456", None, None, &[])
            .expect("worktree")
            .worktree_path;

        assert!(worktree_path.exists());

        let removed = state
            .remove_task_worktree(&repo, "456", false, None)
            .expect("remove worktree");

        assert!(!worktree_path.exists());
        assert!(repo.find_worktree("task456").is_err());
        assert!(removed.removed_path);
        assert!(removed.pruned_registration);
        assert!(!removed.already_absent);
    }

    #[test]
    fn test_remove_task_worktree_rejects_dirty_worktree() {
        let temp = TempDir::new().expect("temp dir");
        let repo = init_repo(temp.path());
        let state = GitState::new();

        let worktree_path = state
            .ensure_task_worktree(&repo, "789", "task-789", None, None, &[])
            .expect("worktree")
            .worktree_path;

        fs::write(worktree_path.join("README.md"), "dirty").expect("write dirty file");

        let err = state
            .remove_task_worktree(&repo, "789", false, None)
            .expect_err("dirty worktree should fail");

        match err {
            BackendError::GitRepositoryNotClean { .. } => {}
            other => panic!("expected GitRepositoryNotClean, got {other:?}"),
        }

        assert!(worktree_path.exists());
        assert!(repo.find_worktree("task789").is_ok());
    }

    #[test]
    fn test_remove_task_worktree_force_removes_dirty_worktree() {
        let temp = TempDir::new().expect("temp dir");
        let repo = init_repo(temp.path());
        let state = GitState::new();

        let worktree_path = state
            .ensure_task_worktree(&repo, "790", "task-790", None, None, &[])
            .expect("worktree")
            .worktree_path;

        fs::write(worktree_path.join("README.md"), "dirty").expect("write dirty file");

        state
            .remove_task_worktree(&repo, "790", true, None)
            .expect("force remove worktree");

        assert!(!worktree_path.exists());
        assert!(repo.find_worktree("task790").is_err());
    }

    #[test]
    fn test_debug_reset_macro_project_artifacts_removes_local_macro_metadata() {
        let temp = TempDir::new().expect("temp dir");
        let repo = init_repo(temp.path());
        let state = GitState::new();

        let task_worktree = state
            .ensure_task_worktree(&repo, "debug-reset", "task-debug-reset", None, None, &[])
            .expect("task worktree")
            .worktree_path;
        fs::write(task_worktree.join("dirty.txt"), "dirty").expect("dirty worktree");
        let metadata_worktree = state
            .ensure_macro_metadata_worktree(&repo)
            .expect("metadata worktree");
        fs::write(temp.path().join(".macro").join("legacy.txt"), "legacy")
            .expect("write legacy metadata");

        assert!(task_worktree.exists());
        assert!(metadata_worktree.exists());
        assert!(repo.find_worktree("taskdebug-reset").is_ok());
        assert!(repo
            .find_branch(MACRO_BRANCH_NAME, BranchType::Local)
            .is_ok());

        let report = state
            .debug_reset_macro_project_artifacts(temp.path())
            .expect("debug reset");

        assert!(report.removed_task_worktrees > 0);
        assert!(report.removed_metadata_worktree);
        assert!(report.removed_macro_branch);
        assert!(!task_worktree.exists());
        assert!(!metadata_worktree.exists());
        assert!(!temp.path().join(".macro").exists());
        assert!(repo.find_worktree("taskdebug-reset").is_err());
        assert!(repo.find_worktree(MACRO_WORKTREE_NAME).is_err());
        assert!(repo
            .find_branch(MACRO_BRANCH_NAME, BranchType::Local)
            .is_err());
        assert!(temp.path().join("README.md").exists());
    }

    #[test]
    fn test_ensure_task_worktree_recovers_stale_cached_path() {
        let temp = TempDir::new().expect("temp dir");
        let repo = init_repo(temp.path());
        let state = GitState::new();

        let ensured = state
            .ensure_task_worktree(&repo, "stale-cache", "task-stale-cache", None, None, &[])
            .expect("worktree");
        let worktree_path = ensured.worktree_path.clone();
        fs::remove_dir_all(&worktree_path).expect("remove worktree path");

        let repaired = state
            .ensure_task_worktree(&repo, "stale-cache", "task-stale-cache", None, None, &[])
            .expect("repaired worktree");

        assert_eq!(repaired.status, TaskWorktreeEnsureStatus::Repaired);
        assert!(repaired.worktree_path.exists());
        assert!(repaired.worktree_path.join(".git").exists());
    }

    #[test]
    fn test_ensure_task_worktree_repairs_registered_missing_path() {
        let temp = TempDir::new().expect("temp dir");
        let repo = init_repo(temp.path());
        let state = GitState::new();

        let worktree_path = state
            .ensure_task_worktree(
                &repo,
                "registered-missing",
                "task-registered-missing",
                None,
                None,
                &[],
            )
            .expect("worktree")
            .worktree_path;

        fs::remove_dir_all(&worktree_path).expect("remove worktree path");
        assert!(repo.find_worktree("taskregistered-missing").is_ok());

        let repaired = state
            .ensure_task_worktree(
                &repo,
                "registered-missing",
                "task-registered-missing",
                None,
                None,
                &[],
            )
            .expect("repaired worktree");

        assert_eq!(repaired.status, TaskWorktreeEnsureStatus::Repaired);
        assert!(repaired.worktree_path.exists());
        assert!(repo.find_worktree("taskregistered-missing").is_ok());
    }

    #[test]
    fn test_ensure_task_worktree_repairs_orphan_path_without_registration() {
        let temp = TempDir::new().expect("temp dir");
        let repo = init_repo(temp.path());
        let state = GitState::new();
        let workdir = repo.workdir().expect("workdir");
        let orphan_path = workdir.join(".macro").join("worktrees").join("taskorphan");
        fs::create_dir_all(&orphan_path).expect("create orphan path");
        fs::write(orphan_path.join("README.md"), "orphan").expect("write orphan file");

        let repaired = state
            .ensure_task_worktree(&repo, "orphan", "task-orphan", None, None, &[])
            .expect("repaired worktree");

        assert_eq!(repaired.status, TaskWorktreeEnsureStatus::Repaired);
        assert!(repaired.worktree_path.join(".git").exists());
        assert!(repo.find_worktree("taskorphan").is_ok());
    }

    #[test]
    fn test_ensure_task_worktree_reuses_existing_branch_worktree_with_legacy_name() {
        let temp = TempDir::new().expect("temp dir");
        let repo = init_repo(temp.path());
        let state = GitState::new();

        let legacy = state
            .ensure_task_worktree(&repo, "legacy-key", "feature-legacy", None, None, &[])
            .expect("legacy worktree");

        let reused = state
            .ensure_task_worktree(&repo, "current-key", "feature-legacy", None, None, &[])
            .expect("reused worktree");

        assert_eq!(reused.status, TaskWorktreeEnsureStatus::Repaired);
        assert_eq!(reused.worktree_path, legacy.worktree_path);
        assert!(repo.find_worktree("tasklegacy-key").is_ok());
        assert!(repo.find_worktree("taskcurrent-key").is_err());
    }

    #[test]
    fn test_remove_task_worktree_cleans_branch_matched_legacy_worktree() {
        let temp = TempDir::new().expect("temp dir");
        let repo = init_repo(temp.path());
        let state = GitState::new();

        let legacy_path = state
            .ensure_task_worktree(
                &repo,
                "legacy-remove",
                "feature-legacy-remove",
                None,
                None,
                &[],
            )
            .expect("legacy worktree")
            .worktree_path;

        let removed = state
            .remove_task_worktree(
                &repo,
                "current-remove",
                false,
                Some("feature-legacy-remove"),
            )
            .expect("remove legacy worktree");

        assert_eq!(removed.worktree_path, legacy_path);
        assert!(removed.removed_path);
        assert!(removed.pruned_registration);
        assert!(!legacy_path.exists());
        assert!(repo.find_worktree("tasklegacy-remove").is_err());
    }

    #[test]
    fn test_ensure_task_worktree_checks_out_stable_branch_when_primary_branch_checked_out() {
        let temp = TempDir::new().expect("temp dir");
        let repo = init_repo(temp.path());
        let state = GitState::new();

        checkout_branch(&repo, "feature-detach");

        let ensured = state
            .ensure_task_worktree(
                &repo,
                "detach",
                "feature-detach",
                None,
                None,
                &["main".to_string()],
            )
            .expect("worktree");
        let worktree_repo = Repository::open(&ensured.worktree_path).expect("open worktree repo");

        assert!(!repo.head_detached().expect("head detached state"));
        assert_eq!(current_branch_name_for_test(&repo).as_deref(), Some("main"));
        assert_eq!(
            current_branch_name_for_test(&worktree_repo).as_deref(),
            Some("feature-detach")
        );
    }

    #[test]
    fn test_ensure_branch_worktree_creates_plan_worktree_without_changing_root() {
        let temp = TempDir::new().expect("temp dir");
        let repo = init_repo(temp.path());
        let state = GitState::new();

        checkout_branch(&repo, "plan/example");
        checkout_branch(&repo, "main");

        let ensured = state
            .ensure_branch_worktree(
                &repo,
                "integration-web-plan-example",
                "plan/example",
                None,
                &["main".to_string()],
            )
            .expect("branch worktree");
        let worktree_repo = Repository::open(&ensured.worktree_path).expect("open worktree repo");

        assert!(ensured.worktree_path.ends_with(Path::new(
            ".macro/worktrees/integration-integration-web-plan-example"
        )));
        assert_eq!(current_branch_name_for_test(&repo).as_deref(), Some("main"));
        assert_eq!(
            current_branch_name_for_test(&worktree_repo).as_deref(),
            Some("plan/example")
        );
    }

    #[test]
    fn test_ensure_branch_worktree_checks_out_stable_branch_when_plan_branch_is_root() {
        let temp = TempDir::new().expect("temp dir");
        let repo = init_repo(temp.path());
        let state = GitState::new();

        checkout_branch(&repo, "plan/root");

        state
            .ensure_branch_worktree(
                &repo,
                "integration-web-plan-root",
                "plan/root",
                None,
                &["main".to_string()],
            )
            .expect("branch worktree");

        assert!(!repo.head_detached().expect("head detached state"));
        assert_eq!(current_branch_name_for_test(&repo).as_deref(), Some("main"));
    }

    #[test]
    fn test_ensure_branch_worktree_rejects_dirty_root_when_plan_branch_is_root() {
        let temp = TempDir::new().expect("temp dir");
        let repo = init_repo(temp.path());
        let state = GitState::new();

        checkout_branch(&repo, "plan/dirty-root");
        fs::write(temp.path().join("README.md"), "dirty primary").expect("write dirty file");

        let err = state
            .ensure_branch_worktree(
                &repo,
                "integration-web-plan-dirty",
                "plan/dirty-root",
                None,
                &["main".to_string()],
            )
            .expect_err("dirty primary checkout should fail");

        match err {
            BackendError::GitRepositoryNotClean { .. } => {}
            other => panic!("expected GitRepositoryNotClean, got {other:?}"),
        }
    }

    #[test]
    fn test_ensure_branch_worktree_creates_local_fallback_from_origin() {
        let temp = TempDir::new().expect("temp dir");
        let repo = init_repo(temp.path());
        let state = GitState::new();
        let main_commit = repo
            .find_branch("main", BranchType::Local)
            .expect("main branch")
            .get()
            .target()
            .expect("main target");
        repo.reference(
            "refs/remotes/origin/develop",
            main_commit,
            true,
            "set remote develop",
        )
        .expect("create remote develop");

        checkout_branch(&repo, "plan/remote-fallback");

        state
            .ensure_branch_worktree(
                &repo,
                "integration-web-plan-remote",
                "plan/remote-fallback",
                None,
                &["develop".to_string(), "main".to_string()],
            )
            .expect("branch worktree");

        assert!(repo.find_branch("develop", BranchType::Local).is_ok());
        assert_eq!(
            current_branch_name_for_test(&repo).as_deref(),
            Some("develop")
        );
    }

    #[test]
    fn test_ensure_task_worktree_rejects_dirty_primary_branch_checkout() {
        let temp = TempDir::new().expect("temp dir");
        let repo = init_repo(temp.path());
        let state = GitState::new();

        checkout_branch(&repo, "feature-dirty-primary");
        fs::write(temp.path().join("README.md"), "dirty primary").expect("write dirty file");

        let err = state
            .ensure_task_worktree(
                &repo,
                "dirty-primary",
                "feature-dirty-primary",
                None,
                None,
                &[],
            )
            .expect_err("dirty primary checkout should fail");

        match err {
            BackendError::GitRepositoryNotClean { .. } => {}
            other => panic!("expected GitRepositoryNotClean, got {other:?}"),
        }
    }

    #[test]
    fn test_remove_task_worktree_cleans_orphan_without_registration() {
        let temp = TempDir::new().expect("temp dir");
        let repo = init_repo(temp.path());
        let state = GitState::new();
        let workdir = repo.workdir().expect("workdir");
        let orphan_path = workdir
            .join(".macro")
            .join("worktrees")
            .join("taskorphan-remove");
        fs::create_dir_all(&orphan_path).expect("create orphan path");
        fs::write(orphan_path.join("README.md"), "orphan").expect("write orphan file");

        let removed = state
            .remove_task_worktree(&repo, "orphan-remove", false, None)
            .expect("remove orphan");

        assert!(removed.removed_path);
        assert!(!removed.pruned_registration);
        assert!(!removed.already_absent);
        assert!(!orphan_path.exists());
    }

    #[test]
    fn test_remove_task_worktree_reports_already_absent() {
        let temp = TempDir::new().expect("temp dir");
        let repo = init_repo(temp.path());
        let state = GitState::new();

        let removed = state
            .remove_task_worktree(&repo, "already-absent", false, None)
            .expect("remove absent worktree");

        assert!(removed.already_absent);
        assert!(!removed.removed_path);
        assert!(!removed.pruned_registration);
    }

    #[test]
    fn test_git_repository_open() {
        let temp = TempDir::new().expect("temp dir");
        let _repo = init_repo(temp.path());

        let opened = GitRepository::open(temp.path()).expect("open repo");
        assert!(opened.path.exists());
    }

    #[test]
    fn test_git_repository_open_not_git() {
        let temp = TempDir::new().expect("temp dir");
        assert!(GitRepository::open(temp.path()).is_err());
    }

    #[test]
    fn test_git_repository_open_missing_path() {
        let temp = TempDir::new().expect("temp dir");
        let missing = temp.path().join("missing");
        assert!(GitRepository::open(&missing).is_err());
    }

    #[test]
    fn test_git_repository_init() {
        let temp = TempDir::new().expect("temp dir");
        let repo_path = temp.path().join("repo");
        std::fs::create_dir_all(&repo_path).unwrap();

        let created = GitRepository::init(&repo_path).expect("init repo");
        assert!(created.path.join(".git").exists());

        assert!(GitRepository::init(&repo_path).is_err());
    }
}
