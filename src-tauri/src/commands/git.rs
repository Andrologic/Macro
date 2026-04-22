// Git Commands

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use chrono::{DateTime, Utc};
use git2::{
    BranchType, Commit, DiffFormat, Oid, Repository, ResetType, StashFlags, Status, StatusEntry,
};
use serde::Serialize;
use tauri::State;

use crate::core::error::{BackendError, Result};
use crate::fs::validate_path;
use crate::git::repo::{get_branch_name, get_head_commit, get_status, get_status_options};
use crate::git::{GitState, TaskWorktreeEnsureStatus, TaskWorktreeStatus, MACRO_BRANCH_NAME};
use crate::workspace;
use crate::workspace::metadata::WorkspaceRecoverMissingMetadataRequestDto;
use crate::{WorkspaceMetadataRoot, WorkspaceRoot};

const DEFAULT_LOG_LIMIT: usize = 50;
const DEFAULT_REMOTE_NAME: &str = "origin";

#[derive(Serialize)]
pub struct GitStatusDto {
    pub branch: String,
    pub head_commit: Option<GitCommitDto>,
    pub staged_files: Vec<GitFileStatus>,
    pub unstaged_files: Vec<GitFileStatus>,
    pub untracked_files: Vec<GitFileStatus>,
    pub conflicted_files: Vec<String>,
    pub merge_in_progress: bool,
    pub is_clean: bool,
    pub has_origin: bool,
    pub has_upstream: bool,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Serialize)]
pub struct GitFileStatus {
    pub path: String,
    pub status: String,
    pub old_path: Option<String>,
}

#[derive(Serialize)]
pub struct GitCommitDto {
    pub id: String,
    pub hash: String,
    pub message: String,
    pub author: String,
    pub date: String,
    pub status: String,
    pub parent_ids: Vec<String>,
    pub graph_depth: usize,
    pub is_branch_point: bool,
    pub task_id: Option<String>,
}

#[derive(Serialize)]
pub struct GitBranchesDto {
    pub local: Vec<GitBranch>,
    pub remote: Vec<GitBranch>,
    pub current: Option<String>,
}

#[derive(Serialize)]
pub struct GitBranch {
    pub name: String,
    pub is_head: bool,
    pub commit: String,
}

#[derive(Serialize)]
pub struct PredictedGitTreeDto {
    pub branch: String,
    pub structure: Vec<GitNode>,
    pub modified_files_count: u32,
}

#[derive(Serialize, Clone)]
pub struct GitNode {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub status: Option<String>,
    pub children: Option<Vec<GitNode>>,
    pub hash: Option<String>,
}

#[derive(Serialize)]
pub struct GitSyncDto {
    pub branch: String,
    pub remote: String,
    pub output: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeInspectionDto {
    pub task_id: String,
    pub worktree_path: String,
    pub branch_name: Option<String>,
    pub status: String,
    pub is_dirty: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeEnsureDto {
    pub task_id: String,
    pub worktree_path: String,
    pub branch_name: String,
    pub status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeRemoveDto {
    pub task_id: String,
    pub worktree_path: String,
    pub removed_path: bool,
    pub pruned_registration: bool,
    pub already_absent: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitMergeCheckDto {
    pub mergeable: bool,
    pub conflict_files: Vec<String>,
    pub has_changes: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFilePairDto {
    pub head_exists: bool,
    pub head_content: String,
    pub index_exists: bool,
    pub index_content: String,
    pub worktree_exists: bool,
    pub worktree_content: String,
    pub original_content: String,
    pub modified_content: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RestoreTarget {
    Worktree,
    StagedAndWorktree,
}

impl RestoreTarget {
    fn from_option(value: Option<&str>) -> Result<Self> {
        match value.unwrap_or("staged_and_worktree") {
            "worktree" => Ok(Self::Worktree),
            "staged_and_worktree" => Ok(Self::StagedAndWorktree),
            other => Err(BackendError::Validation(format!(
                "Invalid restore target: {}",
                other
            ))),
        }
    }
}

#[derive(Serialize, Clone)]
pub struct MacroBranchSyncDto {
    pub branch: String,
    pub state: String,
    pub worktree_path: String,
    pub is_dirty: bool,
    pub has_origin: bool,
    pub has_upstream: bool,
    pub ahead: u32,
    pub behind: u32,
    pub conflicted_files: Vec<String>,
    pub committed: bool,
    pub commit_hash: Option<String>,
    pub reason: Option<String>,
    pub next_action: Option<String>,
    pub output: Option<String>,
    pub error: Option<String>,
}

pub(crate) fn to_join_error(err: tokio::task::JoinError) -> BackendError {
    BackendError::Internal {
        message: format!("Git task join error: {}", err),
    }
}

struct GitCommandOutput {
    success: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

fn run_git_command(cwd: &Path, args: &[String]) -> Result<GitCommandOutput> {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|e| BackendError::Git {
            message: format!("Failed to run git command '{}': {}", args.join(" "), e),
        })?;

    Ok(GitCommandOutput {
        success: output.status.success(),
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn command_output_text(output: &GitCommandOutput) -> String {
    let stdout = output.stdout.trim();
    let stderr = output.stderr.trim();
    if stdout.is_empty() && stderr.is_empty() {
        return String::new();
    }
    if stdout.is_empty() {
        return stderr.to_string();
    }
    if stderr.is_empty() {
        return stdout.to_string();
    }
    format!("{}\n{}", stdout, stderr)
}

fn validate_remote_name(remote: &str) -> Result<()> {
    let candidate = remote.trim();
    if candidate.is_empty() {
        return Err(BackendError::Validation(
            "Remote name cannot be empty".to_string(),
        ));
    }
    if candidate
        .chars()
        .any(|c| c.is_whitespace() || c == ':' || c == '/' || c == '\\')
    {
        return Err(BackendError::Validation(format!(
            "Invalid remote name: {}",
            remote
        )));
    }
    Ok(())
}

fn resolve_target_branch(repo: &Repository, branch: Option<String>) -> Result<String> {
    if let Some(branch) = branch {
        let normalized = branch.trim().to_string();
        if normalized.is_empty() {
            return Err(BackendError::Validation(
                "Branch cannot be empty".to_string(),
            ));
        }
        validate_branch_name(&normalized)?;
        return Ok(normalized);
    }

    get_branch_name(repo)?.ok_or_else(|| BackendError::GitBranchNotFound {
        message: "Cannot resolve branch while in detached HEAD".to_string(),
    })
}

fn resolve_macro_worktree(
    git_state: &GitState,
    workspace_root: &Path,
) -> Result<(PathBuf, Repository)> {
    let repo = git_state.open_repo(workspace_root)?;
    let repo = repo.lock().map_err(|_| BackendError::Internal {
        message: "Failed to lock repository".to_string(),
    })?;
    let worktree_path = git_state.ensure_macro_metadata_worktree(&repo)?;
    drop(repo);

    let worktree_repo = Repository::open(&worktree_path).map_err(|e| BackendError::Git {
        message: format!(
            "Failed to open metadata worktree at {}: {}",
            worktree_path.display(),
            e
        ),
    })?;

    Ok((worktree_path, worktree_repo))
}

fn resolve_macro_workspace_path(
    default_workspace_root: &Path,
    workspace_path: Option<String>,
) -> PathBuf {
    match workspace_path {
        Some(path) => {
            let candidate = PathBuf::from(path);
            if candidate.is_absolute() {
                candidate
            } else {
                default_workspace_root.join(candidate)
            }
        }
        None => default_workspace_root.to_path_buf(),
    }
}

fn gather_macro_conflicted_files(repo: &Repository) -> Result<Vec<String>> {
    let statuses = repo.statuses(Some(&mut get_status_options()))?;
    let mut conflicted = Vec::new();
    for entry in statuses.iter() {
        if !entry.status().is_conflicted() {
            continue;
        }
        let (_, path) = status_entry_paths(&entry);
        if let Some(path) = path {
            conflicted.push(path);
        }
    }
    Ok(conflicted)
}

fn is_merge_in_progress(repo: &Repository) -> bool {
    repo.path().join("MERGE_HEAD").exists()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MacroSyncSignals {
    has_origin: bool,
    has_upstream: bool,
    is_dirty: bool,
    ahead: u32,
    behind: u32,
    has_conflicts: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MacroSyncDiagnostic {
    state: &'static str,
    reason: Option<&'static str>,
    next_action: Option<&'static str>,
}

fn classify_macro_sync_failure(error: &str) -> MacroSyncDiagnostic {
    let lower = error.trim().to_lowercase();

    if lower.contains("authentication failed")
        || lower.contains("permission denied")
        || lower.contains("could not read from remote repository")
        || lower.contains("repository not found")
        || lower.contains("fatal: could not") && lower.contains("credential")
    {
        return MacroSyncDiagnostic {
            state: "failed",
            reason: Some("auth_required"),
            next_action: Some("configure_auth"),
        };
    }

    if lower.contains("could not resolve host")
        || lower.contains("failed to connect")
        || lower.contains("network is unreachable")
        || lower.contains("connection timed out")
        || lower.contains("operation timed out")
    {
        return MacroSyncDiagnostic {
            state: "failed",
            reason: Some("network_error"),
            next_action: Some("retry"),
        };
    }

    if lower.contains("no such remote")
        || lower.contains("does not appear to be a git repository")
        || lower.contains("couldn't find remote ref")
        || lower.contains("remote origin") && lower.contains("not found")
    {
        return MacroSyncDiagnostic {
            state: "failed",
            reason: Some("missing_origin"),
            next_action: Some("configure_remote"),
        };
    }

    if lower.contains("set upstream")
        || lower.contains("has no upstream branch")
        || lower.contains("no upstream configured")
    {
        return MacroSyncDiagnostic {
            state: "pending",
            reason: Some("missing_upstream"),
            next_action: Some("push"),
        };
    }

    if lower.contains("merge conflict") || lower.contains("automatic merge failed") {
        return MacroSyncDiagnostic {
            state: "conflict",
            reason: Some("merge_conflict"),
            next_action: Some("resolve_conflict"),
        };
    }

    if lower.contains("non-fast-forward")
        || lower.contains("fetch first")
        || lower.contains("rejected")
        || lower.contains("would be overwritten")
    {
        return MacroSyncDiagnostic {
            state: "pending",
            reason: Some("diverged"),
            next_action: Some("pull"),
        };
    }

    MacroSyncDiagnostic {
        state: "failed",
        reason: Some("unknown_error"),
        next_action: Some("retry"),
    }
}

fn derive_macro_sync_diagnostic(
    signals: &MacroSyncSignals,
    error: Option<&str>,
) -> MacroSyncDiagnostic {
    if signals.has_conflicts {
        return MacroSyncDiagnostic {
            state: "conflict",
            reason: Some("merge_conflict"),
            next_action: Some("resolve_conflict"),
        };
    }

    if let Some(error_message) = error {
        let trimmed = error_message.trim();
        if !trimmed.is_empty() {
            return classify_macro_sync_failure(trimmed);
        }
    }

    if !signals.has_origin {
        return MacroSyncDiagnostic {
            state: "failed",
            reason: Some("missing_origin"),
            next_action: Some("configure_remote"),
        };
    }

    if signals.is_dirty {
        return MacroSyncDiagnostic {
            state: "pending",
            reason: Some("dirty"),
            next_action: Some("commit"),
        };
    }

    if signals.ahead > 0 && signals.behind > 0 {
        return MacroSyncDiagnostic {
            state: "pending",
            reason: Some("diverged"),
            next_action: Some("pull"),
        };
    }

    if signals.behind > 0 {
        return MacroSyncDiagnostic {
            state: "pending",
            reason: Some("behind"),
            next_action: Some("pull"),
        };
    }

    if signals.ahead > 0 {
        return MacroSyncDiagnostic {
            state: "pending",
            reason: Some("ahead"),
            next_action: Some("push"),
        };
    }

    if !signals.has_upstream {
        return MacroSyncDiagnostic {
            state: "pending",
            reason: Some("missing_upstream"),
            next_action: Some("push"),
        };
    }

    MacroSyncDiagnostic {
        state: "clean",
        reason: Some("clean"),
        next_action: None,
    }
}

fn build_macro_sync_dto(
    repo: &Repository,
    worktree_path: &Path,
    committed: bool,
    commit_hash: Option<String>,
    output: Option<String>,
    error: Option<String>,
) -> Result<MacroBranchSyncDto> {
    let statuses = repo.statuses(Some(&mut get_status_options()))?;
    let conflicted_files = gather_macro_conflicted_files(repo)?;
    let is_dirty = !statuses.is_empty();
    let has_origin = repo.find_remote(DEFAULT_REMOTE_NAME).is_ok();

    let mut has_upstream = false;
    let mut ahead = 0u32;
    let mut behind = 0u32;

    if let Ok(branch) = repo.find_branch(MACRO_BRANCH_NAME, BranchType::Local) {
        if let Ok(upstream) = branch.upstream() {
            has_upstream = true;
            if let (Some(local_oid), Some(upstream_oid)) =
                (branch.get().target(), upstream.get().target())
            {
                let (ahead_count, behind_count) =
                    repo.graph_ahead_behind(local_oid, upstream_oid)?;
                ahead = ahead_count as u32;
                behind = behind_count as u32;
            }
        }
    }

    let diagnostic = derive_macro_sync_diagnostic(
        &MacroSyncSignals {
            has_origin,
            has_upstream,
            is_dirty,
            ahead,
            behind,
            has_conflicts: !conflicted_files.is_empty(),
        },
        error.as_deref(),
    );

    Ok(MacroBranchSyncDto {
        branch: get_branch_name(repo)?.unwrap_or_else(|| MACRO_BRANCH_NAME.to_string()),
        state: diagnostic.state.to_string(),
        worktree_path: worktree_path.to_string_lossy().to_string(),
        is_dirty,
        has_origin,
        has_upstream,
        ahead,
        behind,
        conflicted_files,
        committed,
        commit_hash,
        reason: diagnostic.reason.map(str::to_string),
        next_action: diagnostic.next_action.map(str::to_string),
        output,
        error,
    })
}

pub fn validate_repo_path(repo_path: &str, workspace: &Path) -> Result<PathBuf> {
    let repo_path = Path::new(repo_path);
    let validated = if repo_path.is_absolute() {
        let canonical = repo_path
            .canonicalize()
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => BackendError::FilesystemNotFound {
                    message: format!("Repository path {:?} does not exist", repo_path),
                },
                _ => BackendError::Io {
                    message: format!(
                        "Failed to canonicalize repository path {:?}: {}",
                        repo_path, error
                    ),
                    source: error,
                },
            })?;
        if !canonical.is_dir() {
            return Err(BackendError::GitRepositoryNotFound {
                message: format!("Repository path {:?} is not a directory", repo_path),
            });
        }
        canonical
    } else {
        validate_path(repo_path, workspace)?
    };
    for component in validated.components() {
        if let std::path::Component::Normal(part) = component {
            if part == ".git" {
                return Err(BackendError::GitRepositoryNotFound {
                    message: "Direct .git access is not allowed".to_string(),
                });
            }
        }
    }
    Ok(validated)
}

fn validate_branch_name(branch: &str) -> Result<()> {
    let ref_name = format!("refs/heads/{}", branch);
    if git2::Reference::is_valid_name(&ref_name) {
        Ok(())
    } else {
        Err(BackendError::GitBranchNotFound {
            message: format!("Invalid branch name: {}", branch),
        })
    }
}

fn short_hash(oid: Oid) -> String {
    oid.to_string().chars().take(12).collect()
}

fn is_glob_pattern(value: &str) -> bool {
    value.contains('*') || value.contains('?') || value.contains('[')
}

fn is_hex_oid(value: &str) -> bool {
    let len = value.len();
    if !(7..=40).contains(&len) {
        return false;
    }
    value.chars().all(|c| c.is_ascii_hexdigit())
}

fn validate_refspec(spec: &str) -> Result<()> {
    if is_hex_oid(spec) {
        return Ok(());
    }

    let branch_ref = format!("refs/heads/{}", spec);
    let tag_ref = format!("refs/tags/{}", spec);
    if git2::Reference::is_valid_name(&branch_ref) || git2::Reference::is_valid_name(&tag_ref) {
        Ok(())
    } else {
        Err(BackendError::Validation(format!(
            "Invalid reference: {}",
            spec
        )))
    }
}

fn validate_commit_message(message: &str) -> Result<()> {
    let trimmed = message.trim();
    let mut parts = trimmed.splitn(2, ':');
    let header = parts.next().unwrap_or("").trim();
    let body = parts.next().unwrap_or("").trim();

    if header.is_empty() || body.is_empty() {
        return Err(BackendError::Validation(
            "Commit message must follow Conventional Commits: type(scope)?: subject".to_string(),
        ));
    }

    let header = header.strip_suffix('!').unwrap_or(header);
    let (commit_type, scope) = if let Some(idx) = header.find('(') {
        if !header.ends_with(')') {
            return Err(BackendError::Validation(
                "Commit scope must close with ')'".to_string(),
            ));
        }
        (&header[..idx], Some(&header[idx + 1..header.len() - 1]))
    } else {
        (header, None)
    };

    if commit_type.is_empty() {
        return Err(BackendError::Validation(
            "Commit type is required".to_string(),
        ));
    }

    if let Some(scope) = scope {
        if scope.trim().is_empty() {
            return Err(BackendError::Validation(
                "Commit scope cannot be empty".to_string(),
            ));
        }
    }

    let allowed = ["feat", "fix", "chore", "refactor", "docs", "test", "perf"];
    if !allowed.contains(&commit_type) {
        return Err(BackendError::Validation(
            "Commit type must be one of: feat, fix, chore, refactor, docs, test, perf".to_string(),
        ));
    }

    Ok(())
}

fn ensure_safe_config(repo: &Repository) -> Result<()> {
    let config = repo.config()?;
    if let Ok(value) = config.get_string("core.hooksPath") {
        if !value.trim().is_empty() {
            let hooks_path = Path::new(&value);
            if hooks_path.is_absolute() {
                let repo_root = repo_root(repo)?;
                if !hooks_path.starts_with(&repo_root) {
                    return Err(BackendError::Git {
                        message: "core.hooksPath must be inside the repository".to_string(),
                    });
                }
            }
        }
    }
    Ok(())
}

fn repo_root(repo: &Repository) -> Result<PathBuf> {
    repo.workdir()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| BackendError::Git {
            message: "Bare repositories are not supported".to_string(),
        })
}

fn to_repo_relative(repo_root: &Path, path: &Path) -> Result<PathBuf> {
    path.strip_prefix(repo_root)
        .map(|p| p.to_path_buf())
        .map_err(|_| BackendError::FilesystemPathOutsideWorkspace {
            message: format!("Path is outside repository: {}", path.display()),
        })
}

fn collect_files(path: &Path) -> Result<Vec<PathBuf>> {
    if path.is_file() {
        return Ok(vec![path.to_path_buf()]);
    }

    if path.is_dir() {
        let mut files = Vec::new();
        for entry in walkdir::WalkDir::new(path) {
            let entry = entry.map_err(|e| BackendError::Io {
                message: e.to_string(),
                source: std::io::Error::other(e),
            })?;
            if entry.file_type().is_file() {
                let file_path = entry.path().to_path_buf();
                if file_path
                    .components()
                    .any(|c| matches!(c, std::path::Component::Normal(p) if p == ".git"))
                {
                    continue;
                }
                files.push(file_path);
            }
        }
        return Ok(files);
    }

    Err(BackendError::FilesystemNotFound {
        message: format!("Path not found: {}", path.display()),
    })
}

fn expand_paths(repo_root: &Path, input: &str) -> Result<Vec<PathBuf>> {
    let input_path = Path::new(input);
    let absolute = if input_path.is_absolute() {
        input_path.to_path_buf()
    } else {
        repo_root.join(input)
    };

    if is_glob_pattern(input) {
        let mut matches = Vec::new();
        for entry in
            glob::glob(absolute.to_string_lossy().as_ref()).map_err(|e| BackendError::Git {
                message: e.to_string(),
            })?
        {
            let path = entry.map_err(|e| BackendError::Git {
                message: e.to_string(),
            })?;
            matches.push(path);
        }

        if matches.is_empty() {
            return Err(BackendError::FilesystemNotFound {
                message: format!("No files matched pattern: {}", input),
            });
        }

        return Ok(matches);
    }

    Ok(vec![absolute])
}

pub(crate) fn add_paths(repo: &Repository, paths: &[String]) -> Result<()> {
    let repo_root = repo_root(repo)?;
    let mut index = repo.index()?;
    let mut added = 0usize;

    for path in paths {
        for candidate in expand_paths(&repo_root, path)? {
            for file in collect_files(&candidate)? {
                let relative = to_repo_relative(&repo_root, &file)?;
                index.add_path(&relative)?;
                added += 1;
            }
        }
    }

    if added == 0 {
        return Err(BackendError::Git {
            message: "No files were added to the index".to_string(),
        });
    }

    index.write()?;
    Ok(())
}

fn head_contains_path(repo: &Repository, path: &Path) -> Result<bool> {
    let Some(head_commit) = get_head_commit(repo)? else {
        return Ok(false);
    };
    let tree = head_commit.tree()?;
    match tree.get_path(path) {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

fn index_contains_path(repo: &Repository, path: &Path) -> Result<bool> {
    let index = repo.index()?;
    Ok(index.get_path(path, 0).is_some())
}

pub(crate) fn restore_paths(
    repo: &Repository,
    paths: &[String],
    target: RestoreTarget,
) -> Result<()> {
    if paths.is_empty() {
        return Err(BackendError::Git {
            message: "No paths were provided to restore".to_string(),
        });
    }

    let repo_root = repo_root(repo)?;
    let mut restore_from_head_paths = Vec::new();
    let mut restore_from_index_paths = Vec::new();
    let mut remove_new_paths = Vec::new();
    let mut remove_untracked_worktree_paths = Vec::new();

    for input in paths {
        let relative = if Path::new(input).is_absolute() {
            to_repo_relative(&repo_root, Path::new(input))?
        } else {
            PathBuf::from(input)
        };

        let in_head = head_contains_path(repo, &relative)?;
        let in_index = index_contains_path(repo, &relative)?;

        match target {
            RestoreTarget::Worktree => {
                if in_index {
                    restore_from_index_paths.push(relative);
                } else {
                    remove_untracked_worktree_paths.push(relative);
                }
            }
            RestoreTarget::StagedAndWorktree => {
                if in_head {
                    restore_from_head_paths.push(relative);
                } else {
                    remove_new_paths.push(relative);
                }
            }
        }
    }

    if !restore_from_head_paths.is_empty() {
        let mut args = vec![
            "restore".to_string(),
            "--source=HEAD".to_string(),
            "--staged".to_string(),
            "--worktree".to_string(),
            "--".to_string(),
        ];
        args.extend(
            restore_from_head_paths
                .iter()
                .map(|path| path.to_string_lossy().to_string()),
        );
        let output = run_git_command(&repo_root, &args)?;
        if !output.success {
            let details = command_output_text(&output);
            return Err(BackendError::Git {
                message: if details.is_empty() {
                    "Failed to restore tracked paths".to_string()
                } else {
                    details
                },
            });
        }
    }

    if !restore_from_index_paths.is_empty() {
        let mut args = vec!["restore".to_string(), "--worktree".to_string(), "--".to_string()];
        args.extend(
            restore_from_index_paths
                .iter()
                .map(|path| path.to_string_lossy().to_string()),
        );
        let output = run_git_command(&repo_root, &args)?;
        if !output.success {
            let details = command_output_text(&output);
            return Err(BackendError::Git {
                message: if details.is_empty() {
                    "Failed to restore paths from the index".to_string()
                } else {
                    details
                },
            });
        }
    }

    if !remove_new_paths.is_empty() {
        let mut rm_args = vec![
            "rm".to_string(),
            "--cached".to_string(),
            "-r".to_string(),
            "--ignore-unmatch".to_string(),
            "--".to_string(),
        ];
        rm_args.extend(
            remove_new_paths
                .iter()
                .map(|path| path.to_string_lossy().to_string()),
        );
        let output = run_git_command(&repo_root, &rm_args)?;
        if !output.success {
            let details = command_output_text(&output);
            return Err(BackendError::Git {
                message: if details.is_empty() {
                    "Failed to unstage newly added paths".to_string()
                } else {
                    details
                },
            });
        }

        for relative in &remove_new_paths {
            let absolute = repo_root.join(relative);
            if absolute.is_file() {
                fs::remove_file(&absolute).map_err(|error| BackendError::Io {
                    message: format!("Failed to remove file {}: {}", absolute.display(), error),
                    source: error,
                })?;
            } else if absolute.is_dir() {
                fs::remove_dir_all(&absolute).map_err(|error| BackendError::Io {
                    message: format!(
                        "Failed to remove directory {}: {}",
                        absolute.display(),
                        error
                    ),
                    source: error,
                })?;
            }
        }
    }

    if !remove_untracked_worktree_paths.is_empty() {
        for relative in &remove_untracked_worktree_paths {
            let absolute = repo_root.join(relative);
            if absolute.is_file() {
                fs::remove_file(&absolute).map_err(|error| BackendError::Io {
                    message: format!("Failed to remove file {}: {}", absolute.display(), error),
                    source: error,
                })?;
            } else if absolute.is_dir() {
                fs::remove_dir_all(&absolute).map_err(|error| BackendError::Io {
                    message: format!(
                        "Failed to remove directory {}: {}",
                        absolute.display(),
                        error
                    ),
                    source: error,
                })?;
            }
        }
    }

    Ok(())
}

pub(crate) fn reset_repo(repo: &Repository, mode: &str, commit: Option<String>) -> Result<()> {
    let target = if let Some(spec) = commit {
        resolve_commit(repo, &spec)?
    } else {
        get_head_commit(repo)?.ok_or_else(|| BackendError::GitInvalidCommit {
            message: "No commits found".to_string(),
        })?
    };

    let reset_type = match mode {
        "soft" => ResetType::Soft,
        "mixed" => ResetType::Mixed,
        "hard" => {
            let status = repo.statuses(Some(&mut get_status_options()))?;
            if !status.is_empty() {
                return Err(BackendError::GitRepositoryNotClean {
                    message: "Hard reset requires a clean working tree".to_string(),
                });
            }
            ResetType::Hard
        }
        other => {
            return Err(BackendError::Validation(format!(
                "Invalid reset mode: {}",
                other
            )))
        }
    };

    repo.reset(target.as_object(), reset_type, None)?;
    Ok(())
}

pub(crate) fn stash_repo(repo: &mut Repository, message: Option<String>) -> Result<String> {
    let statuses = repo.statuses(Some(&mut get_status_options()))?;
    if statuses.is_empty() {
        return Err(BackendError::Git {
            message: "No changes to stash".to_string(),
        });
    }
    drop(statuses);

    let signature = repo
        .signature()
        .unwrap_or_else(|_| git2::Signature::now("Macro", "macro@local").unwrap());
    let msg = message.unwrap_or_else(|| "WIP".to_string());
    let oid = repo.stash_save(&signature, &msg, Some(StashFlags::INCLUDE_UNTRACKED))?;
    Ok(short_hash(oid))
}

fn commit_to_dto(commit: &Commit<'_>) -> GitCommitDto {
    let message = commit.summary().unwrap_or("(no message)").to_string();
    let author = commit.author().name().unwrap_or("Unknown").to_string();
    let time = commit.time();
    let date = DateTime::<Utc>::from_timestamp(time.seconds(), 0)
        .unwrap_or_else(|| DateTime::<Utc>::from_timestamp(0, 0).unwrap())
        .to_rfc3339();

    let task_id = parse_task_id(&message);
    let parent_ids = commit.parent_ids().map(|id| id.to_string()).collect();

    GitCommitDto {
        id: commit.id().to_string(),
        hash: short_hash(commit.id()),
        message,
        author,
        date,
        status: "done".to_string(),
        parent_ids,
        graph_depth: 0,
        is_branch_point: false,
        task_id,
    }
}

fn build_virtual_commit(status: &str, message: &str) -> GitCommitDto {
    let now = Utc::now().to_rfc3339();
    GitCommitDto {
        id: format!("virtual-{}", status),
        hash: status.to_uppercase(),
        message: message.to_string(),
        author: "Working Tree".to_string(),
        date: now,
        status: status.to_string(),
        parent_ids: Vec::new(),
        graph_depth: 0,
        is_branch_point: false,
        task_id: None,
    }
}

fn get_working_status_flags(repo: &Repository) -> Result<(bool, bool)> {
    let statuses = repo.statuses(Some(&mut get_status_options()))?;
    let mut staged = false;
    let mut unstaged = false;
    for entry in statuses.iter() {
        let status = entry.status();
        if status.is_index_new()
            || status.is_index_modified()
            || status.is_index_deleted()
            || status.is_index_renamed()
        {
            staged = true;
        }
        if status.is_wt_new()
            || status.is_wt_modified()
            || status.is_wt_deleted()
            || status.is_wt_renamed()
        {
            unstaged = true;
        }
    }
    Ok((staged, unstaged))
}

fn parse_task_id(message: &str) -> Option<String> {
    let marker = "#";
    if let Some(idx) = message.find(marker) {
        let rest = &message[idx + 1..];
        let token: String = rest
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        if !token.is_empty() {
            return Some(token);
        }
    }

    if let Some(idx) = message.find("task-") {
        let rest = &message[idx..];
        let token: String = rest
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        if !token.is_empty() {
            return Some(token);
        }
    }

    None
}

fn status_to_label(status: Status) -> Option<String> {
    if status.is_wt_new() || status.is_index_new() {
        Some("added".to_string())
    } else if status.is_wt_deleted() || status.is_index_deleted() {
        Some("deleted".to_string())
    } else if status.is_wt_renamed() || status.is_index_renamed() {
        Some("renamed".to_string())
    } else if status.is_wt_modified() || status.is_index_modified() {
        Some("modified".to_string())
    } else {
        None
    }
}

fn status_entry_paths(entry: &StatusEntry<'_>) -> (Option<String>, Option<String>) {
    if let Some(delta) = entry.head_to_index() {
        let old_path = delta
            .old_file()
            .path()
            .and_then(|p| p.to_str())
            .map(|s| s.to_string());
        let new_path = delta
            .new_file()
            .path()
            .and_then(|p| p.to_str())
            .map(|s| s.to_string());
        return (old_path, new_path);
    }

    if let Some(delta) = entry.index_to_workdir() {
        let old_path = delta
            .old_file()
            .path()
            .and_then(|p| p.to_str())
            .map(|s| s.to_string());
        let new_path = delta
            .new_file()
            .path()
            .and_then(|p| p.to_str())
            .map(|s| s.to_string());
        return (old_path, new_path);
    }

    (
        entry.path().map(|s| s.to_string()),
        entry.path().map(|s| s.to_string()),
    )
}

fn build_status_map(repo: &Repository) -> Result<HashMap<String, String>> {
    let mut map = HashMap::new();
    let statuses = repo.statuses(Some(&mut get_status_options()))?;

    for entry in statuses.iter() {
        if let Some(label) = status_to_label(entry.status()) {
            let (_, path) = status_entry_paths(&entry);
            if let Some(path) = path {
                map.insert(path, label);
            }
        }
    }

    Ok(map)
}

fn build_submodule_status_map(repo: &Repository) -> Result<HashMap<String, String>> {
    let mut map = HashMap::new();
    let submodules = repo.submodules().map_err(|e| BackendError::Git {
        message: e.to_string(),
    })?;

    for submodule in submodules {
        if let Some(path) = submodule.path().to_str().map(|s| s.to_string()) {
            if let Ok(sub_repo) = submodule.open() {
                if get_status(&sub_repo)? != Status::CURRENT {
                    map.insert(path, "modified".to_string());
                }
            } else {
                map.insert(path, "modified".to_string());
            }
        }
    }

    Ok(map)
}

fn insert_node(nodes: &mut Vec<GitNode>, parts: &[&str], prefix: &str, status: &str) {
    if parts.is_empty() {
        return;
    }

    let name = parts[0];
    let path = if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", prefix, name)
    };

    if parts.len() == 1 {
        if let Some(existing) = nodes.iter_mut().find(|n| n.path == path) {
            existing.status = Some(status.to_string());
        } else {
            nodes.push(GitNode {
                name: name.to_string(),
                path,
                node_type: "file".to_string(),
                status: Some(status.to_string()),
                children: None,
                hash: None,
            });
        }
        return;
    }

    let idx = if let Some(idx) = nodes
        .iter()
        .position(|n| n.name == name && n.node_type == "directory")
    {
        idx
    } else {
        nodes.push(GitNode {
            name: name.to_string(),
            path: path.clone(),
            node_type: "directory".to_string(),
            status: None,
            children: Some(Vec::new()),
            hash: None,
        });
        nodes.len() - 1
    };

    if nodes[idx].children.is_none() {
        nodes[idx].children = Some(Vec::new());
    }

    let children = nodes[idx].children.as_mut().unwrap();
    insert_node(children, &parts[1..], &path, status);
}

fn build_tree_nodes(
    repo: &Repository,
    tree: &git2::Tree<'_>,
    prefix: &str,
    status_map: &HashMap<String, String>,
    seen_paths: &mut HashSet<String>,
) -> Vec<GitNode> {
    let mut nodes = Vec::new();

    for entry in tree.iter() {
        let name = entry.name().unwrap_or("").to_string();
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", prefix, name)
        };

        match entry.kind() {
            Some(git2::ObjectType::Tree) => {
                let child = entry.to_object(repo).ok();
                let child_tree = child.and_then(|obj| obj.as_tree().cloned());
                let children = child_tree
                    .map(|t| build_tree_nodes(repo, &t, &path, status_map, seen_paths))
                    .unwrap_or_default();

                nodes.push(GitNode {
                    name,
                    path: path.clone(),
                    node_type: "directory".to_string(),
                    status: None,
                    children: Some(children),
                    hash: Some(entry.id().to_string()),
                });
                seen_paths.insert(path);
            }
            Some(git2::ObjectType::Blob) => {
                let status = status_map.get(&path).cloned();
                nodes.push(GitNode {
                    name,
                    path: path.clone(),
                    node_type: "file".to_string(),
                    status,
                    children: None,
                    hash: Some(entry.id().to_string()),
                });
                seen_paths.insert(path);
            }
            Some(git2::ObjectType::Commit) => {
                let status = status_map.get(&path).cloned();
                nodes.push(GitNode {
                    name,
                    path: path.clone(),
                    node_type: "directory".to_string(),
                    status,
                    children: None,
                    hash: Some(entry.id().to_string()),
                });
                seen_paths.insert(path);
            }
            _ => {}
        }
    }

    nodes
}

fn resolve_commit<'repo>(repo: &'repo Repository, spec: &str) -> Result<Commit<'repo>> {
    if let Ok(reference) = repo.find_reference(&format!("refs/heads/{}", spec)) {
        return reference.peel_to_commit().map_err(|e| BackendError::Git {
            message: e.to_string(),
        });
    }

    repo.revparse_single(spec)
        .and_then(|obj| obj.peel_to_commit())
        .map_err(|e| BackendError::Git {
            message: e.to_string(),
        })
}

fn ensure_clean(repo: &Repository) -> Result<()> {
    let status = get_status(repo)?;
    if status != Status::CURRENT {
        return Err(BackendError::GitRepositoryNotClean {
            message: "Please commit or stash your changes first".to_string(),
        });
    }
    Ok(())
}

pub(crate) struct DiffRequestOptions {
    pub context_lines: Option<u32>,
    pub ignore_whitespace: bool,
    pub paths: Option<Vec<String>>,
}

pub(crate) fn build_git_status(repo: &Repository) -> Result<GitStatusDto> {
    let branch = get_branch_name(repo)?.unwrap_or_else(|| "DETACHED".to_string());
    let head_commit = get_head_commit(repo)?.map(|c| commit_to_dto(&c));
    let has_origin = repo.find_remote(DEFAULT_REMOTE_NAME).is_ok();
    let mut has_upstream = false;
    let mut ahead = 0u32;
    let mut behind = 0u32;

    if branch != "DETACHED" {
        if let Ok(local_branch) = repo.find_branch(&branch, BranchType::Local) {
            if let Ok(upstream) = local_branch.upstream() {
                has_upstream = true;
                if let (Some(local_oid), Some(upstream_oid)) =
                    (local_branch.get().target(), upstream.get().target())
                {
                    let (ahead_count, behind_count) =
                        repo.graph_ahead_behind(local_oid, upstream_oid)?;
                    ahead = ahead_count as u32;
                    behind = behind_count as u32;
                }
            }
        }
    }

    let statuses = repo.statuses(Some(&mut get_status_options()))?;
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();
    let mut conflicted_files = Vec::new();

    for entry in statuses.iter() {
        let status = entry.status();
        let (old_path, path) = status_entry_paths(&entry);

        if status.is_conflicted() {
            if let Some(path) = path.clone() {
                conflicted_files.push(path);
            }
            continue;
        }

        if status.is_index_new()
            || status.is_index_modified()
            || status.is_index_deleted()
            || status.is_index_renamed()
        {
            if let Some(path) = path.clone() {
                staged.push(GitFileStatus {
                    path,
                    status: status_to_label(status).unwrap_or_else(|| "modified".to_string()),
                    old_path,
                });
            }
        }

        if status.is_wt_modified() || status.is_wt_deleted() || status.is_wt_renamed() {
            if let Some(path) = path.clone() {
                unstaged.push(GitFileStatus {
                    path,
                    status: status_to_label(status).unwrap_or_else(|| "modified".to_string()),
                    old_path: None,
                });
            }
        }

        if status.is_wt_new() {
            if let Some(path) = path {
                untracked.push(GitFileStatus {
                    path,
                    status: "untracked".to_string(),
                    old_path: None,
                });
            }
        }
    }

    for (path, status) in build_submodule_status_map(repo)? {
        unstaged.push(GitFileStatus {
            path,
            status,
            old_path: None,
        });
    }

    conflicted_files.sort();
    conflicted_files.dedup();
    let merge_in_progress = is_merge_in_progress(repo);

    Ok(GitStatusDto {
        branch,
        head_commit,
        staged_files: staged,
        unstaged_files: unstaged,
        untracked_files: untracked,
        conflicted_files,
        merge_in_progress,
        is_clean: statuses.is_empty(),
        has_origin,
        has_upstream,
        ahead,
        behind,
    })
}

pub fn build_git_log(
    repo: &Repository,
    limit: usize,
    branch: Option<&str>,
) -> Result<Vec<GitCommitDto>> {
    let (has_staged, has_unstaged) = get_working_status_flags(repo)?;

    if let Some(branch) = branch {
        validate_refspec(branch)?;
    }

    let mut revwalk = repo.revwalk()?;

    if let Some(branch) = branch {
        let commit = resolve_commit(repo, branch)?;
        revwalk.push(commit.id())?;
    } else if let Ok(head) = repo.head() {
        if let Some(target) = head.target() {
            revwalk.push(target)?;
        } else {
            return Ok(Vec::new());
        }
    } else {
        return Ok(Vec::new());
    }

    let mut commits = Vec::new();
    if has_unstaged {
        commits.push(build_virtual_commit("in-progress", "Working tree changes"));
    }
    if has_staged {
        commits.push(build_virtual_commit("planned", "Staged changes"));
    }
    for oid in revwalk.take(limit) {
        let oid = oid.map_err(|e| BackendError::Git {
            message: e.to_string(),
        })?;
        let commit = repo.find_commit(oid)?;
        commits.push(commit_to_dto(&commit));
    }

    let mut child_counts: HashMap<String, usize> = HashMap::new();
    for commit in commits.iter() {
        for parent_id in commit.parent_ids.iter() {
            *child_counts.entry(parent_id.clone()).or_default() += 1;
        }
    }

    let mut depth_map: HashMap<String, usize> = HashMap::new();
    let mut child_seen: HashMap<String, usize> = HashMap::new();
    let mut next_depth = 0usize;
    for commit in commits.iter_mut() {
        let mut depth = 0usize;
        if let Some(parent) = commit.parent_ids.first() {
            let base_depth = depth_map.get(parent).copied().unwrap_or(0);
            let seen = child_seen.entry(parent.clone()).or_default();
            depth = if *seen == 0 {
                base_depth
            } else {
                next_depth + 1
            };
            *seen += 1;
        }
        if depth > next_depth {
            next_depth = depth;
        }
        commit.graph_depth = depth;
        commit.is_branch_point = child_counts.get(&commit.id).copied().unwrap_or(0) > 1;
        depth_map.insert(commit.id.clone(), depth);
    }

    Ok(commits)
}

pub(crate) fn build_git_branches(repo: &Repository) -> Result<GitBranchesDto> {
    let current = get_branch_name(repo)?;
    let mut local = Vec::new();
    let mut remote = Vec::new();

    for branch in repo.branches(Some(BranchType::Local))? {
        let (branch, _) = branch?;
        let name = branch.name()?.unwrap_or("").to_string();
        let is_head = current.as_deref() == Some(&name);
        let commit = branch
            .get()
            .peel_to_commit()
            .map(|c| short_hash(c.id()))
            .unwrap_or_default();
        local.push(GitBranch {
            name,
            is_head,
            commit,
        });
    }

    for branch in repo.branches(Some(BranchType::Remote))? {
        let (branch, _) = branch?;
        let name = branch.name()?.unwrap_or("").to_string();
        let commit = branch
            .get()
            .peel_to_commit()
            .map(|c| short_hash(c.id()))
            .unwrap_or_default();
        remote.push(GitBranch {
            name,
            is_head: false,
            commit,
        });
    }

    Ok(GitBranchesDto {
        local,
        remote,
        current,
    })
}

pub(crate) fn checkout_repo(repo: &Repository, branch_or_commit: &str, create: bool) -> Result<()> {
    ensure_clean(repo)?;
    let current_tree_id = repo
        .head()
        .ok()
        .and_then(|head| head.peel_to_commit().ok())
        .map(|commit| commit.tree_id());

    if create {
        validate_branch_name(branch_or_commit)?;
        let head_commit = repo
            .head()
            .and_then(|head| head.peel_to_commit())
            .map_err(|_| BackendError::Git {
                message: "Cannot create branch without an initial commit".to_string(),
            })?;
        repo.branch(branch_or_commit, &head_commit, false)?;
        repo.set_head(&format!("refs/heads/{}", branch_or_commit))?;
    } else if repo
        .find_reference(&format!("refs/heads/{}", branch_or_commit))
        .is_ok()
    {
        repo.set_head(&format!("refs/heads/{}", branch_or_commit))?;
    } else {
        validate_refspec(branch_or_commit)?;
        let ref_name = format!("refs/heads/{}", branch_or_commit);
        if git2::Reference::is_valid_name(&ref_name) {
            return Err(BackendError::GitBranchNotFound {
                message: format!("Branch not found: {}", branch_or_commit),
            });
        }

        let commit =
            resolve_commit(repo, branch_or_commit).map_err(|_| BackendError::GitInvalidCommit {
                message: format!("Commit not found: {}", branch_or_commit),
            })?;
        repo.set_head_detached(commit.id())?;
    }

    let new_tree_id = repo
        .head()
        .ok()
        .and_then(|head| head.peel_to_commit().ok())
        .map(|commit| commit.tree_id());

    if current_tree_id == new_tree_id {
        return Ok(());
    }

    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.safe();
    repo.checkout_head(Some(&mut checkout))
        .map_err(|e| BackendError::GitConflict {
            message: e.to_string(),
        })?;

    if repo.index().map(|idx| idx.has_conflicts()).unwrap_or(false) {
        return Err(BackendError::GitMergeConflict {
            message: "Checkout resulted in merge conflicts".to_string(),
        });
    }
    Ok(())
}
fn create_branch_from_ref(repo: &Repository, branch_name: &str, from_ref: &str) -> Result<()> {
    validate_branch_name(branch_name)?;
    validate_refspec(from_ref)?;

    let ref_name = format!("refs/heads/{}", branch_name);
    if repo.find_reference(&ref_name).is_ok() {
        return Ok(());
    }

    let from_commit =
        resolve_commit(repo, from_ref).map_err(|_| BackendError::GitInvalidCommit {
            message: format!("Reference not found: {}", from_ref),
        })?;

    repo.branch(branch_name, &from_commit, false)
        .map_err(|e| BackendError::Git {
            message: e.to_string(),
        })?;

    Ok(())
}

fn delete_local_branch(repo: &Repository, branch_name: &str, force: bool) -> Result<()> {
    let current = get_branch_name(repo)?;
    if current.as_deref() == Some(branch_name) {
        return Err(BackendError::Git {
            message: format!("Cannot delete checked out branch: {}", branch_name),
        });
    }

    let mut branch = repo
        .find_branch(branch_name, BranchType::Local)
        .map_err(|_| BackendError::GitBranchNotFound {
            message: format!("Branch not found: {}", branch_name),
        })?;

    if !force {
        if let Ok(head_commit) = repo.head().and_then(|head| head.peel_to_commit()) {
            let branch_commit = branch
                .get()
                .peel_to_commit()
                .map_err(|e| BackendError::Git {
                    message: e.to_string(),
                })?;
            let is_merged = repo
                .graph_descendant_of(head_commit.id(), branch_commit.id())
                .map_err(|e| BackendError::Git {
                    message: e.to_string(),
                })?;
            if !is_merged {
                return Err(BackendError::Git {
                    message: format!(
                        "Branch {} is not merged into current HEAD. Use force=true to delete it.",
                        branch_name
                    ),
                });
            }
        }
    }

    branch.delete().map_err(|e| BackendError::Git {
        message: e.to_string(),
    })?;

    Ok(())
}

fn collect_index_conflict_paths(index: &git2::Index) -> Result<Vec<String>> {
    let mut conflict_files = Vec::new();
    let conflicts = index.conflicts().map_err(|e| BackendError::Git {
        message: e.to_string(),
    })?;

    for conflict in conflicts {
        let conflict = conflict.map_err(|e| BackendError::Git {
            message: e.to_string(),
        })?;
        let path = conflict
            .our
            .as_ref()
            .or(conflict.their.as_ref())
            .or(conflict.ancestor.as_ref())
            .map(|entry| String::from_utf8_lossy(&entry.path).to_string());

        if let Some(path) = path {
            conflict_files.push(path);
        }
    }

    conflict_files.sort();
    conflict_files.dedup();
    Ok(conflict_files)
}

pub(crate) fn build_git_merge_check(
    repo: &Repository,
    branch_name: &str,
    into_branch: &str,
) -> Result<GitMergeCheckDto> {
    validate_branch_name(branch_name)?;
    validate_branch_name(into_branch)?;

    let diff = diff_repo(
        repo,
        Some(into_branch),
        Some(branch_name),
        DiffRequestOptions {
            context_lines: Some(0),
            ignore_whitespace: false,
            paths: None,
        },
    )?;
    let has_changes = !diff.trim().is_empty();
    if !has_changes {
        return Ok(GitMergeCheckDto {
            mergeable: true,
            conflict_files: Vec::new(),
            has_changes: false,
        });
    }

    let into_commit = resolve_commit(repo, into_branch)?;
    let branch_commit = resolve_commit(repo, branch_name)?;
    let index = repo
        .merge_commits(&into_commit, &branch_commit, None)
        .map_err(|e| BackendError::Git {
            message: e.to_string(),
        })?;
    let conflict_files = if index.has_conflicts() {
        collect_index_conflict_paths(&index)?
    } else {
        Vec::new()
    };

    Ok(GitMergeCheckDto {
        mergeable: conflict_files.is_empty(),
        conflict_files,
        has_changes,
    })
}

pub(crate) fn merge_repo(
    repo: &Repository,
    branch_name: &str,
    into_branch: &str,
) -> Result<String> {
    ensure_clean(repo)?;

    let merge_check = build_git_merge_check(repo, branch_name, into_branch)?;
    if !merge_check.has_changes {
        return Ok(format!(
            "Branch {} is already integrated into {}",
            branch_name, into_branch
        ));
    }
    if !merge_check.mergeable {
        let detail = if merge_check.conflict_files.is_empty() {
            format!("Cannot merge {} into {}", branch_name, into_branch)
        } else {
            format!(
                "Cannot merge {} into {} because of conflicts in: {}",
                branch_name,
                into_branch,
                merge_check.conflict_files.join(", ")
            )
        };
        return Err(BackendError::GitMergeConflict { message: detail });
    }

    let original_branch = get_branch_name(repo)?;
    if original_branch.as_deref() != Some(into_branch) {
        checkout_repo(repo, into_branch, false)?;
    }

    let root = repo_root(repo)?;
    let output = run_git_command(
        &root,
        &[
            "merge".to_string(),
            "--no-ff".to_string(),
            "--no-edit".to_string(),
            branch_name.to_string(),
        ],
    )?;

    if !output.success {
        let merge_head_path = repo.path().join("MERGE_HEAD");
        if merge_head_path.exists() {
            let abort_output =
                run_git_command(&root, &["merge".to_string(), "--abort".to_string()])?;
            if !abort_output.success {
                let abort_details = command_output_text(&abort_output);
                return Err(BackendError::Git {
                    message: if abort_details.is_empty() {
                        format!(
                            "git merge failed and merge --abort also failed (exit code: {:?})",
                            abort_output.code
                        )
                    } else {
                        abort_details
                    },
                });
            }
        }

        if let Some(original_branch) = original_branch.as_deref() {
            if original_branch != into_branch {
                let _ = checkout_repo(repo, original_branch, false);
            }
        }

        let details = command_output_text(&output);
        return Err(BackendError::Git {
            message: if details.is_empty() {
                format!("git merge failed (exit code: {:?})", output.code)
            } else {
                details
            },
        });
    }

    if let Some(original_branch) = original_branch.as_deref() {
        if original_branch != into_branch {
            checkout_repo(repo, original_branch, false)?;
        }
    }

    let details = command_output_text(&output);
    if details.is_empty() {
        Ok(format!("Merged {} into {}", branch_name, into_branch))
    } else {
        Ok(details)
    }
}

pub(crate) fn commit_repo(repo: &Repository, message: &str, stage_all: bool) -> Result<String> {
    validate_commit_message(message)?;
    ensure_safe_config(repo)?;

    if stage_all {
        let mut index = repo.index()?;
        let statuses = repo.statuses(Some(&mut get_status_options()))?;
        for entry in statuses.iter() {
            let status = entry.status();
            let (old_path, path) = status_entry_paths(&entry);
            if status.is_wt_deleted() || status.is_index_deleted() {
                if let Some(path) = path {
                    let _ = index.remove_path(Path::new(&path));
                }
                continue;
            }

            if let Some(path) = path {
                index.add_path(Path::new(&path))?;
            }

            if status.is_index_renamed() {
                if let Some(old_path) = old_path {
                    let _ = index.remove_path(Path::new(&old_path));
                }
            }
        }
        index.write()?;
    }

    let statuses = repo.statuses(Some(&mut get_status_options()))?;
    if statuses.is_empty() {
        return Err(BackendError::Git {
            message: "No changes to commit".to_string(),
        });
    }

    let mut index = repo.index()?;
    let tree_id = index.write_tree()?;
    let tree = repo.find_tree(tree_id)?;

    let signature = repo
        .signature()
        .unwrap_or_else(|_| git2::Signature::now("Macro", "macro@local").unwrap());

    let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());

    let oid = if let Some(parent) = parent {
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            message,
            &tree,
            &[&parent],
        )?
    } else {
        repo.commit(Some("HEAD"), &signature, &signature, message, &tree, &[])?
    };

    Ok(short_hash(oid))
}

pub(crate) fn diff_repo(
    repo: &Repository,
    base: Option<&str>,
    head: Option<&str>,
    options: DiffRequestOptions,
) -> Result<String> {
    let base_commit = if let Some(base) = base {
        Some(resolve_commit(repo, base)?)
    } else {
        get_head_commit(repo)?
    };

    let base_tree = if let Some(commit) = base_commit.as_ref() {
        Some(commit.tree()?)
    } else {
        None
    };

    let mut opts = git2::DiffOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_unmodified(false);

    if let Some(lines) = options.context_lines {
        opts.context_lines(lines);
    }

    if options.ignore_whitespace {
        opts.ignore_whitespace(true);
    }

    if let Some(paths) = options.paths.as_ref() {
        for path in paths {
            opts.pathspec(path);
        }
    }

    let mut output = String::new();
    let mut print_cb = |_delta: git2::DiffDelta<'_>, _hunk: Option<git2::DiffHunk<'_>>, line: git2::DiffLine<'_>| {
        let origin = line.origin();
        // Only prepend origin for content lines, not file/hunk headers
        if matches!(origin, '+' | '-' | ' ') {
            output.push(origin);
        }
        output.push_str(std::str::from_utf8(line.content()).unwrap_or(""));
        true
    };

    if let Some(head) = head {
        let head_commit = resolve_commit(repo, head)?;
        let head_tree = head_commit.tree()?;
        let diff = repo.diff_tree_to_tree(base_tree.as_ref(), Some(&head_tree), Some(&mut opts))?;
        diff.print(DiffFormat::Patch, &mut print_cb)?;
    } else {
        let diff = repo.diff_tree_to_workdir_with_index(base_tree.as_ref(), Some(&mut opts))?;
        diff.print(DiffFormat::Patch, &mut print_cb)?;
    }

    Ok(output)
}

pub(crate) fn validate_repo_relative_file_path(path: &str) -> Result<PathBuf> {
    let candidate = PathBuf::from(path);
    if candidate.as_os_str().is_empty() || candidate.is_absolute() {
        return Err(BackendError::Validation(format!(
            "Invalid repository-relative file path: {}",
            path
        )));
    }

    for component in candidate.components() {
        match component {
            std::path::Component::Normal(part) if part != ".git" => {}
            _ => {
                return Err(BackendError::Validation(format!(
                    "Invalid repository-relative file path: {}",
                    path
                )))
            }
        }
    }

    Ok(candidate)
}

fn read_head_file_content(repo: &Repository, relative_path: &Path) -> Result<Option<String>> {
    let Some(commit) = get_head_commit(repo)? else {
        return Ok(None);
    };

    let tree = commit.tree()?;
    let entry = match tree.get_path(relative_path) {
        Ok(entry) => entry,
        Err(_) => return Ok(None),
    };
    let object = entry.to_object(repo)?;
    let Some(blob) = object.as_blob() else {
        return Ok(None);
    };

    Ok(Some(String::from_utf8_lossy(blob.content()).to_string()))
}

fn read_index_file_content(repo: &Repository, relative_path: &Path) -> Result<Option<String>> {
    let index = repo.index()?;
    let Some(entry) = index.get_path(relative_path, 0) else {
        return Ok(None);
    };

    let blob = repo.find_blob(entry.id)?;
    Ok(Some(String::from_utf8_lossy(blob.content()).to_string()))
}

fn read_worktree_file_content(repo_root: &Path, relative_path: &Path) -> Result<Option<String>> {
    let absolute_path = repo_root.join(relative_path);

    match fs::read(&absolute_path) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).to_string())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(BackendError::Io {
            message: format!("Failed to read worktree file {:?}: {}", absolute_path, error),
            source: error,
        }),
    }
}

pub(crate) fn read_git_file_pair(
    repo: &Repository,
    repo_root: &Path,
    relative_path: &Path,
) -> Result<GitFilePairDto> {
    let head_content = read_head_file_content(repo, relative_path)?;
    let index_content = read_index_file_content(repo, relative_path)?;
    let worktree_content = read_worktree_file_content(repo_root, relative_path)?;
    let original_content = head_content.clone().unwrap_or_default();
    let modified_content = worktree_content.clone().unwrap_or_default();

    Ok(GitFilePairDto {
        head_exists: head_content.is_some(),
        head_content: original_content.clone(),
        index_exists: index_content.is_some(),
        index_content: index_content.unwrap_or_default(),
        worktree_exists: worktree_content.is_some(),
        worktree_content: modified_content.clone(),
        original_content,
        modified_content,
    })
}

pub fn build_git_tree(repo: &Repository, branch: Option<&str>) -> Result<PredictedGitTreeDto> {
    let branch_name = if let Some(branch) = branch {
        validate_refspec(branch)?;
        branch.to_string()
    } else {
        get_branch_name(repo)?.unwrap_or_else(|| "DETACHED".to_string())
    };

    let commit = resolve_commit(repo, &branch_name).or_else(|_| {
        get_head_commit(repo)?.ok_or_else(|| BackendError::GitInvalidCommit {
            message: "No commits found".to_string(),
        })
    })?;

    let tree = commit.tree()?;
    let mut status_map = build_status_map(repo)?;
    for (path, status) in build_submodule_status_map(repo)? {
        status_map.insert(path, status);
    }
    let mut seen_paths = HashSet::new();
    let mut structure = build_tree_nodes(repo, &tree, "", &status_map, &mut seen_paths);

    for (path, status) in status_map.iter() {
        if !seen_paths.contains(path) {
            let parts: Vec<&str> = path.split('/').collect();
            insert_node(&mut structure, &parts, "", status);
        }
    }

    Ok(PredictedGitTreeDto {
        branch: branch_name,
        structure,
        modified_files_count: status_map.len() as u32,
    })
}

#[tauri::command]
/// Get the status of a Git repository.
pub async fn git_status(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
) -> Result<GitStatusDto> {
    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        build_git_status(&repo)
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Get commit history for a Git repository.
pub async fn git_log(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    limit: Option<u32>,
    branch: Option<String>,
) -> Result<Vec<GitCommitDto>> {
    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();
    let limit = limit.map(|v| v as usize).unwrap_or(DEFAULT_LOG_LIMIT);

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        build_git_log(&repo, limit, branch.as_deref())
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// List local and remote branches for a Git repository.
pub async fn git_branch_list(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
) -> Result<GitBranchesDto> {
    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        build_git_branches(&repo)
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Create a local branch from a specific source ref (branch/tag/commit).
pub async fn git_branch_create(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    branch_name: String,
    from_ref: String,
) -> Result<()> {
    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        create_branch_from_ref(&repo, &branch_name, &from_ref)
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Delete a local branch. When force=false, branch must be merged into HEAD.
pub async fn git_branch_delete(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    branch_name: String,
    force: Option<bool>,
) -> Result<()> {
    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        delete_local_branch(&repo, &branch_name, force.unwrap_or(false))
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Delete a remote branch if it exists on the target remote.
pub async fn git_branch_delete_remote(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    branch_name: String,
    remote: Option<String>,
) -> Result<()> {
    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        validate_branch_name(&branch_name)?;
        let remote_name = remote
            .unwrap_or_else(|| DEFAULT_REMOTE_NAME.to_string())
            .trim()
            .to_string();
        validate_remote_name(&remote_name)?;

        let root = repo_root(&repo)?;
        drop(repo);

        let output = run_git_command(
            &root,
            &[
                "push".to_string(),
                remote_name.clone(),
                "--delete".to_string(),
                branch_name.clone(),
            ],
        )?;
        if !output.success {
            let details = command_output_text(&output);
            let message = if details.is_empty() {
                format!("git push --delete failed (exit code: {:?})", output.code)
            } else {
                details
            };
            return Err(BackendError::Git { message });
        }

        Ok(())
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Checkout an existing branch/commit or create a new branch.
pub async fn git_checkout(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    branch_or_commit: String,
    create: bool,
) -> Result<()> {
    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        checkout_repo(&repo, &branch_or_commit, create)
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Check whether a merge can be performed without conflicts.
pub async fn git_merge_check(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    branch_name: String,
    into_branch: String,
) -> Result<GitMergeCheckDto> {
    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        build_git_merge_check(&repo, &branch_name, &into_branch)
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Merge one local branch into another after a conflict preflight.
pub async fn git_merge(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    branch_name: String,
    into_branch: String,
) -> Result<String> {
    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        merge_repo(&repo, &branch_name, &into_branch)
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Create a commit in a Git repository.
pub async fn git_commit(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    message: String,
    stage_all: bool,
) -> Result<String> {
    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        commit_repo(&repo, &message, stage_all)
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Stage files into the Git index.
pub async fn git_add(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    paths: Vec<String>,
) -> Result<()> {
    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        add_paths(&repo, &paths)
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Restore specific paths in the Git repository back to HEAD.
pub async fn git_restore_paths(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    paths: Vec<String>,
    target: Option<String>,
) -> Result<()> {
    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        restore_paths(&repo, &paths, RestoreTarget::from_option(target.as_deref())?)
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Reset the repository to a given commit.
pub async fn git_reset(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    mode: String,
    commit: Option<String>,
    confirm: Option<bool>,
) -> Result<()> {
    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        if mode == "hard" && !confirm.unwrap_or(false) {
            return Err(BackendError::Git {
                message: "Hard reset is destructive; set confirm=true".to_string(),
            });
        }

        reset_repo(&repo, &mode, commit)
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Stash local changes in the Git repository.
pub async fn git_stash(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    message: Option<String>,
) -> Result<String> {
    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let mut repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        stash_repo(&mut repo, message)
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Generate a diff between commits or working tree.
#[allow(clippy::too_many_arguments)]
pub async fn git_diff(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    base: Option<String>,
    head: Option<String>,
    context_lines: Option<u32>,
    ignore_whitespace: Option<bool>,
    paths: Option<Vec<String>>,
) -> Result<String> {
    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        diff_repo(
            &repo,
            base.as_deref(),
            head.as_deref(),
            DiffRequestOptions {
                context_lines,
                ignore_whitespace: ignore_whitespace.unwrap_or(false),
                paths,
            },
        )
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Read the HEAD/index/worktree contents for a repository-relative path.
pub async fn git_read_file_pair(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    path: String,
) -> Result<GitFilePairDto> {
    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let relative_path = validate_repo_relative_file_path(&path)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        read_git_file_pair(&repo, &validated, &relative_path)
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Build a predicted Git tree structure.
pub async fn git_get_tree(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    branch: Option<String>,
) -> Result<PredictedGitTreeDto> {
    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        build_git_tree(&repo, branch.as_deref())
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Inspect a Git worktree for a specific task.
pub async fn git_worktree_inspect(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    task_id: String,
    branch_name: Option<String>,
) -> Result<GitWorktreeInspectionDto> {
    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        let inspection = if let Some(branch_name) = branch_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            git_state.inspect_task_worktree_for_branch(&repo, &task_id, branch_name)?
        } else {
            git_state.inspect_task_worktree(&repo, &task_id)?
        };
        Ok(GitWorktreeInspectionDto {
            task_id: inspection.task_id,
            worktree_path: inspection.worktree_path.to_string_lossy().into_owned(),
            branch_name: inspection.branch_name,
            status: match inspection.status {
                TaskWorktreeStatus::Absent => TaskWorktreeStatus::Absent.as_str(),
                TaskWorktreeStatus::Ready => TaskWorktreeStatus::Ready.as_str(),
                TaskWorktreeStatus::StaleRegistration => {
                    TaskWorktreeStatus::StaleRegistration.as_str()
                }
                TaskWorktreeStatus::OrphanPath => TaskWorktreeStatus::OrphanPath.as_str(),
                TaskWorktreeStatus::InvalidRepo => TaskWorktreeStatus::InvalidRepo.as_str(),
            }
            .to_string(),
            is_dirty: inspection.is_dirty,
        })
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Create a Git worktree for a specific task.
pub async fn git_worktree_create(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    task_id: String,
    branch_name: String,
    from_ref: Option<String>,
    preferred_commit_branch: Option<String>,
) -> Result<GitWorktreeEnsureDto> {
    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        let ensured = git_state.ensure_task_worktree(
            &repo,
            &task_id,
            &branch_name,
            from_ref.as_deref(),
            preferred_commit_branch.as_deref(),
        )?;
        Ok(GitWorktreeEnsureDto {
            task_id: ensured.task_id,
            worktree_path: ensured.worktree_path.to_string_lossy().into_owned(),
            branch_name: ensured.branch_name,
            status: match ensured.status {
                TaskWorktreeEnsureStatus::Created => TaskWorktreeEnsureStatus::Created.as_str(),
                TaskWorktreeEnsureStatus::Reused => TaskWorktreeEnsureStatus::Reused.as_str(),
                TaskWorktreeEnsureStatus::Repaired => TaskWorktreeEnsureStatus::Repaired.as_str(),
            }
            .to_string(),
        })
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Remove a Git worktree for a specific task.
pub async fn git_worktree_remove(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    task_id: String,
    force: Option<bool>,
    branch_name: Option<String>,
) -> Result<GitWorktreeRemoveDto> {
    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        let removed = git_state.remove_task_worktree(
            &repo,
            &task_id,
            force.unwrap_or(false),
            branch_name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty()),
        )?;
        Ok(GitWorktreeRemoveDto {
            task_id: removed.task_id,
            worktree_path: removed.worktree_path.to_string_lossy().into_owned(),
            removed_path: removed.removed_path,
            pruned_registration: removed.pruned_registration,
            already_absent: removed.already_absent,
        })
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Fetch updates for current branch (or provided branch) from remote.
pub async fn git_fetch(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    remote: Option<String>,
    branch: Option<String>,
) -> Result<GitSyncDto> {
    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        let remote_name = remote
            .unwrap_or_else(|| DEFAULT_REMOTE_NAME.to_string())
            .trim()
            .to_string();
        validate_remote_name(&remote_name)?;
        let branch_name = resolve_target_branch(&repo, branch)?;
        let root = repo_root(&repo)?;
        drop(repo);

        let mut args = vec!["fetch".to_string(), remote_name.clone()];
        if !branch_name.trim().is_empty() {
            args.push(branch_name.clone());
        }
        let output = run_git_command(&root, &args)?;
        if !output.success {
            let details = command_output_text(&output);
            let message = if details.is_empty() {
                format!("git fetch failed (exit code: {:?})", output.code)
            } else {
                details
            };
            return Err(BackendError::Git { message });
        }

        Ok(GitSyncDto {
            branch: branch_name,
            remote: remote_name,
            output: command_output_text(&output),
        })
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Push the current branch (or provided branch) to remote.
pub async fn git_push(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    remote: Option<String>,
    branch: Option<String>,
) -> Result<GitSyncDto> {
    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        let remote_name = remote
            .unwrap_or_else(|| DEFAULT_REMOTE_NAME.to_string())
            .trim()
            .to_string();
        validate_remote_name(&remote_name)?;
        let branch_name = resolve_target_branch(&repo, branch)?;
        let root = repo_root(&repo)?;
        drop(repo);

        let args = vec![
            "push".to_string(),
            "-u".to_string(),
            remote_name.clone(),
            branch_name.clone(),
        ];
        let output = run_git_command(&root, &args)?;
        if !output.success {
            let details = command_output_text(&output);
            let message = if details.is_empty() {
                format!("git push failed (exit code: {:?})", output.code)
            } else {
                details
            };
            return Err(BackendError::Git { message });
        }

        Ok(GitSyncDto {
            branch: branch_name,
            remote: remote_name,
            output: command_output_text(&output),
        })
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Pull updates for current branch (or provided branch) from remote.
pub async fn git_pull(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    remote: Option<String>,
    branch: Option<String>,
) -> Result<GitSyncDto> {
    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        let remote_name = remote
            .unwrap_or_else(|| DEFAULT_REMOTE_NAME.to_string())
            .trim()
            .to_string();
        validate_remote_name(&remote_name)?;
        let branch_name = resolve_target_branch(&repo, branch)?;
        let root = repo_root(&repo)?;
        drop(repo);

        let args = vec![
            "pull".to_string(),
            "--no-rebase".to_string(),
            remote_name.clone(),
            branch_name.clone(),
        ];
        let output = run_git_command(&root, &args)?;
        if !output.success {
            let details = command_output_text(&output);
            let message = if details.is_empty() {
                format!("git pull failed (exit code: {:?})", output.code)
            } else {
                details
            };
            return Err(BackendError::GitConflict { message });
        }

        Ok(GitSyncDto {
            branch: branch_name,
            remote: remote_name,
            output: command_output_text(&output),
        })
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Ensure @macro branch and metadata worktree exist.
pub async fn macro_branch_ensure(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    workspace_path: Option<String>,
) -> Result<MacroBranchSyncDto> {
    let workspace = resolve_macro_workspace_path(
        &workspace_root.inner().0.read().await.clone(),
        workspace_path,
    );
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let (worktree_path, worktree_repo) = resolve_macro_worktree(&git_state, &workspace)?;
        build_macro_sync_dto(
            &worktree_repo,
            &worktree_path,
            false,
            None,
            Some("Metadata branch ensured".to_string()),
            None,
        )
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Read current sync status of @macro metadata branch.
pub async fn macro_branch_status(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    workspace_path: Option<String>,
) -> Result<MacroBranchSyncDto> {
    let workspace = resolve_macro_workspace_path(
        &workspace_root.inner().0.read().await.clone(),
        workspace_path,
    );
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let (worktree_path, worktree_repo) = resolve_macro_worktree(&git_state, &workspace)?;
        build_macro_sync_dto(&worktree_repo, &worktree_path, false, None, None, None)
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Commit metadata changes on the @macro branch if dirty.
pub async fn macro_branch_commit_if_dirty(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    message: Option<String>,
    workspace_path: Option<String>,
) -> Result<MacroBranchSyncDto> {
    let workspace = resolve_macro_workspace_path(
        &workspace_root.inner().0.read().await.clone(),
        workspace_path,
    );
    let git_state = git_state.inner().clone();
    let commit_message = message
        .unwrap_or_else(|| "chore(metadata): persist metadata updates".to_string())
        .trim()
        .to_string();

    tokio::task::spawn_blocking(move || {
        let (worktree_path, worktree_repo) = resolve_macro_worktree(&git_state, &workspace)?;

        let add_output = run_git_command(
            &worktree_path,
            &["add".to_string(), "-A".to_string(), ".".to_string()],
        )?;
        if !add_output.success {
            let details = command_output_text(&add_output);
            return build_macro_sync_dto(
                &worktree_repo,
                &worktree_path,
                false,
                None,
                Some(details.clone()),
                Some(if details.is_empty() {
                    format!(
                        "Failed to stage metadata changes (exit code: {:?})",
                        add_output.code
                    )
                } else {
                    details
                }),
            );
        }

        let staged_check = run_git_command(
            &worktree_path,
            &[
                "diff".to_string(),
                "--cached".to_string(),
                "--quiet".to_string(),
            ],
        )?;

        if staged_check.success {
            return build_macro_sync_dto(
                &worktree_repo,
                &worktree_path,
                false,
                None,
                Some("Metadata branch is already up to date".to_string()),
                None,
            );
        }

        if staged_check.code != Some(1) {
            let details = command_output_text(&staged_check);
            return build_macro_sync_dto(
                &worktree_repo,
                &worktree_path,
                false,
                None,
                Some(details.clone()),
                Some(if details.is_empty() {
                    format!(
                        "Failed to inspect staged metadata changes (exit code: {:?})",
                        staged_check.code
                    )
                } else {
                    details
                }),
            );
        }

        let commit_output = run_git_command(
            &worktree_path,
            &[
                "-c".to_string(),
                "user.name=Macro".to_string(),
                "-c".to_string(),
                "user.email=macro@local".to_string(),
                "commit".to_string(),
                "-m".to_string(),
                commit_message,
            ],
        )?;

        if !commit_output.success {
            let details = command_output_text(&commit_output);
            return build_macro_sync_dto(
                &worktree_repo,
                &worktree_path,
                false,
                None,
                Some(details.clone()),
                Some(if details.is_empty() {
                    format!(
                        "Failed to commit metadata changes (exit code: {:?})",
                        commit_output.code
                    )
                } else {
                    details
                }),
            );
        }

        let commit_hash = worktree_repo
            .head()
            .ok()
            .and_then(|head| head.target())
            .map(short_hash);

        build_macro_sync_dto(
            &worktree_repo,
            &worktree_path,
            true,
            commit_hash,
            Some(command_output_text(&commit_output)),
            None,
        )
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Push metadata branch to remote origin.
pub async fn macro_branch_push(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    workspace_path: Option<String>,
) -> Result<MacroBranchSyncDto> {
    let workspace = resolve_macro_workspace_path(
        &workspace_root.inner().0.read().await.clone(),
        workspace_path,
    );
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let (worktree_path, worktree_repo) = resolve_macro_worktree(&git_state, &workspace)?;
        let push_output = run_git_command(
            &worktree_path,
            &[
                "push".to_string(),
                "-u".to_string(),
                DEFAULT_REMOTE_NAME.to_string(),
                MACRO_BRANCH_NAME.to_string(),
            ],
        )?;

        let details = command_output_text(&push_output);
        if !push_output.success {
            return build_macro_sync_dto(
                &worktree_repo,
                &worktree_path,
                false,
                None,
                Some(details.clone()),
                Some(if details.is_empty() {
                    format!(
                        "Failed to push metadata branch (exit code: {:?})",
                        push_output.code
                    )
                } else {
                    details
                }),
            );
        }

        let recovery_report = workspace::recover_missing_metadata_sync(
            &workspace,
            &worktree_path,
            &WorkspaceRecoverMissingMetadataRequestDto {
                attempt_pull: false,
                projects: Vec::new(),
            },
        )?;
        let recovery_message = match recovery_report.status.as_str() {
            "restored_from_history" => recovery_report
                .restored_commit
                .as_ref()
                .map(|commit| format!("@macro metadata restored from history ({commit})."))
                .or(Some("@macro metadata restored from history.".to_string())),
            "reconstructed_from_hints" => {
                Some("@macro metadata was reconfigured from local project hints.".to_string())
            }
            _ => recovery_report.message,
        };
        let output = if details.trim().is_empty() {
            recovery_message
        } else if let Some(recovery_message) = recovery_message {
            Some(format!("{}\n{}", details, recovery_message))
        } else {
            Some(details)
        };

        build_macro_sync_dto(&worktree_repo, &worktree_path, false, None, output, None)
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Pull metadata branch from remote origin.
pub async fn macro_branch_pull(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    workspace_path: Option<String>,
) -> Result<MacroBranchSyncDto> {
    let workspace = resolve_macro_workspace_path(
        &workspace_root.inner().0.read().await.clone(),
        workspace_path,
    );
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let (worktree_path, worktree_repo) = resolve_macro_worktree(&git_state, &workspace)?;
        let pull_output = run_git_command(
            &worktree_path,
            &[
                "pull".to_string(),
                "--no-rebase".to_string(),
                DEFAULT_REMOTE_NAME.to_string(),
                MACRO_BRANCH_NAME.to_string(),
            ],
        )?;

        let details = command_output_text(&pull_output);
        if !pull_output.success {
            let conflict_files = gather_macro_conflicted_files(&worktree_repo)?;
            if !conflict_files.is_empty() {
                return build_macro_sync_dto(
                    &worktree_repo,
                    &worktree_path,
                    false,
                    None,
                    Some(details),
                    None,
                );
            }

            return build_macro_sync_dto(
                &worktree_repo,
                &worktree_path,
                false,
                None,
                Some(details.clone()),
                Some(if details.is_empty() {
                    format!(
                        "Failed to pull metadata branch (exit code: {:?})",
                        pull_output.code
                    )
                } else {
                    details
                }),
            );
        }

        build_macro_sync_dto(
            &worktree_repo,
            &worktree_path,
            false,
            None,
            Some(details),
            None,
        )
    })
    .await
    .map_err(to_join_error)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn init_repo() -> (TempDir, Repository) {
        let temp = TempDir::new().expect("temp dir");
        let repo = Repository::init(temp.path()).expect("init repo");

        let file_path = temp.path().join("README.md");
        fs::write(&file_path, "hello").expect("write file");

        let mut index = repo.index().expect("index");
        index.add_path(Path::new("README.md")).expect("add");
        let tree_id = index.write_tree().expect("write tree");
        {
            let tree = repo.find_tree(tree_id).expect("tree");
            let sig = git2::Signature::now("Tester", "tester@example.com").expect("sig");
            repo.commit(Some("HEAD"), &sig, &sig, "initial commit", &tree, &[])
                .expect("commit");
        }

        (temp, repo)
    }

    fn init_macro_repo() -> (TempDir, Repository) {
        let (temp, repo) = init_repo();
        let head_oid = repo.head().unwrap().target().unwrap();
        {
            let head = repo.find_commit(head_oid).unwrap();
            repo.branch(MACRO_BRANCH_NAME, &head, false)
                .expect("create @macro branch");
        }
        let branch_ref = format!("refs/heads/{}", MACRO_BRANCH_NAME);
        {
            let object = repo
                .revparse_single(&branch_ref)
                .expect("resolve @macro branch");
            repo.checkout_tree(&object, Some(git2::build::CheckoutBuilder::new().force()))
                .expect("checkout @macro branch");
        }
        repo.set_head(&branch_ref).expect("set HEAD to @macro");
        (temp, repo)
    }

    #[test]
    fn test_resolve_macro_workspace_path_prefers_explicit_repo_path() {
        let default_root = PathBuf::from("/workspace/default");

        let resolved =
            resolve_macro_workspace_path(&default_root, Some("/workspace/project-a".to_string()));

        assert_eq!(resolved, PathBuf::from("/workspace/project-a"));
    }

    #[test]
    fn test_validate_repo_path_allows_absolute_repo_outside_workspace() {
        let workspace = TempDir::new().expect("workspace");
        let repo_dir = TempDir::new().expect("repo dir");
        Repository::init(repo_dir.path()).expect("init external repo");

        let validated = validate_repo_path(
            repo_dir.path().to_str().expect("repo path"),
            workspace.path(),
        )
        .expect("validate repo path");

        assert_eq!(
            validated,
            repo_dir.path().canonicalize().expect("canonical repo")
        );
    }

    #[test]
    fn test_parse_task_id_hash() {
        let msg = "feat: add feature #task-123";
        assert_eq!(parse_task_id(msg), Some("task-123".to_string()));
    }

    #[test]
    fn test_parse_task_id_prefix() {
        let msg = "feat: add feature task-999";
        assert_eq!(parse_task_id(msg), Some("task-999".to_string()));
    }

    #[test]
    fn test_validate_commit_message_ok() {
        assert!(validate_commit_message("feat: add feature").is_ok());
        assert!(validate_commit_message("fix(scope): correct bug").is_ok());
        assert!(validate_commit_message("chore!: breaking change").is_ok());
    }

    #[test]
    fn test_validate_commit_message_invalid() {
        assert!(validate_commit_message("add feature").is_err());
        assert!(validate_commit_message("feat: ").is_err());
        assert!(validate_commit_message("invalid: message").is_err());
    }

    #[test]
    fn test_git_status_clean_repo() {
        let (_temp, repo) = init_repo();
        let status = build_git_status(&repo).unwrap();
        assert!(status.is_clean);
        assert!(status.staged_files.is_empty());
        assert!(status.unstaged_files.is_empty());
        assert!(status.conflicted_files.is_empty());
        assert!(!status.merge_in_progress);
    }

    #[test]
    fn test_git_status_untracked_repo() {
        let (temp, repo) = init_repo();
        fs::write(temp.path().join("new.txt"), "data").unwrap();
        let status = build_git_status(&repo).unwrap();
        assert!(status.untracked_files.iter().any(|f| f.path == "new.txt"));
        assert!(status.conflicted_files.is_empty());
        assert!(!status.merge_in_progress);
    }

    #[test]
    fn test_git_status_detects_conflicted_files_and_merge_in_progress() {
        let (temp, repo) = init_repo();
        let base_branch = get_branch_name(&repo).unwrap().expect("base branch");

        checkout_repo(&repo, "feature", true).unwrap();
        fs::write(temp.path().join("README.md"), "feature branch change").unwrap();
        commit_repo(&repo, "feat: feature readme change", true).unwrap();

        checkout_repo(&repo, &base_branch, false).unwrap();
        fs::write(temp.path().join("README.md"), "base branch change").unwrap();
        commit_repo(&repo, "feat: base readme change", true).unwrap();

        let output = run_git_command(
            temp.path(),
            &[
                "merge".to_string(),
                "--no-ff".to_string(),
                "--no-edit".to_string(),
                "feature".to_string(),
            ],
        )
        .unwrap();
        assert!(!output.success);

        let status = build_git_status(&repo).unwrap();
        assert!(!status.is_clean);
        assert!(status.merge_in_progress);
        assert!(status
            .conflicted_files
            .iter()
            .any(|path| path == "README.md"));
    }

    #[test]
    fn test_git_log_for_branch() {
        let (_temp, repo) = init_repo();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &head, false).unwrap();
        let commits = build_git_log(&repo, 10, Some("feature")).unwrap();
        assert!(!commits.is_empty());
    }

    #[test]
    fn test_git_branch_list_basic() {
        let (_temp, repo) = init_repo();
        let branches = build_git_branches(&repo).unwrap();
        assert!(branches.local.iter().any(|b| b.is_head));
    }

    #[test]
    fn test_git_checkout_branch() {
        let (_temp, repo) = init_repo();
        checkout_repo(&repo, "feature", true).unwrap();
        let current = get_branch_name(&repo).unwrap();
        assert_eq!(current.as_deref(), Some("feature"));
    }

    #[test]
    fn test_git_merge_check_detects_mergeable_branch() {
        let (temp, repo) = init_repo();
        let base_branch = get_branch_name(&repo).unwrap().expect("base branch");

        checkout_repo(&repo, "feature", true).unwrap();
        fs::write(temp.path().join("README.md"), "hello\nfeature change").unwrap();
        commit_repo(&repo, "feat: update readme on feature", true).unwrap();

        checkout_repo(&repo, &base_branch, false).unwrap();

        let check = build_git_merge_check(&repo, "feature", &base_branch).unwrap();
        assert!(check.has_changes);
        assert!(check.mergeable);
        assert!(check.conflict_files.is_empty());
    }

    #[test]
    fn test_git_merge_check_detects_conflicts() {
        let (temp, repo) = init_repo();
        let base_branch = get_branch_name(&repo).unwrap().expect("base branch");

        checkout_repo(&repo, "feature", true).unwrap();
        fs::write(temp.path().join("README.md"), "feature branch change").unwrap();
        commit_repo(&repo, "feat: feature readme change", true).unwrap();

        checkout_repo(&repo, &base_branch, false).unwrap();
        fs::write(temp.path().join("README.md"), "base branch change").unwrap();
        commit_repo(&repo, "feat: base readme change", true).unwrap();

        let check = build_git_merge_check(&repo, "feature", &base_branch).unwrap();
        assert!(check.has_changes);
        assert!(!check.mergeable);
        assert!(check.conflict_files.iter().any(|path| path == "README.md"));
    }

    #[test]
    fn test_git_commit_new_file() {
        let (temp, repo) = init_repo();
        fs::write(temp.path().join("notes.txt"), "notes").unwrap();
        let hash = commit_repo(&repo, "feat: add notes", true).unwrap();
        assert!(!hash.is_empty());
    }

    #[test]
    fn test_git_diff_working_tree() {
        let (temp, repo) = init_repo();
        fs::write(temp.path().join("README.md"), "updated").unwrap();
        let diff = diff_repo(
            &repo,
            None,
            None,
            DiffRequestOptions {
                context_lines: Some(3),
                ignore_whitespace: false,
                paths: None,
            },
        )
        .unwrap();
        assert!(diff.contains("README.md"));
    }

    #[test]
    fn test_git_get_tree_basic() {
        let (_temp, repo) = init_repo();
        let tree = build_git_tree(&repo, None).unwrap();
        assert!(tree.structure.iter().any(|n| n.path == "README.md"));
    }

    #[test]
    fn test_resolve_commit_branch() {
        let (_temp, repo) = init_repo();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &head, false).unwrap();
        let commit = resolve_commit(&repo, "feature").unwrap();
        assert_eq!(commit.id(), head.id());
    }

    #[test]
    fn test_build_status_map_untracked() {
        let (temp, repo) = init_repo();
        let new_file = temp.path().join("new.txt");
        fs::write(&new_file, "data").unwrap();

        let map = build_status_map(&repo).unwrap();
        assert_eq!(map.get("new.txt"), Some(&"added".to_string()));
    }

    #[test]
    fn test_ensure_clean_detects_changes() {
        let (temp, repo) = init_repo();
        let new_file = temp.path().join("dirty.txt");
        fs::write(&new_file, "dirty").unwrap();

        let err = ensure_clean(&repo).unwrap_err();
        match err {
            BackendError::GitRepositoryNotClean { .. } => {}
            other => panic!("expected git not clean error, got {other:?}"),
        }
    }

    #[test]
    fn test_build_tree_nodes_with_status() {
        let (_temp, repo) = init_repo();
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        let tree = commit.tree().unwrap();
        let mut status_map = HashMap::new();
        status_map.insert("README.md".to_string(), "modified".to_string());
        let mut seen = HashSet::new();

        let nodes = build_tree_nodes(&repo, &tree, "", &status_map, &mut seen);
        let readme = nodes.iter().find(|n| n.path == "README.md").unwrap();
        assert_eq!(readme.status.as_deref(), Some("modified"));
    }

    #[test]
    fn test_add_paths_stages_file() {
        let (temp, repo) = init_repo();
        let new_file = temp.path().join("notes.txt");
        fs::write(&new_file, "notes").unwrap();

        add_paths(&repo, &["notes.txt".to_string()]).unwrap();
        let statuses = repo.statuses(Some(&mut get_status_options())).unwrap();
        let mut found = false;
        for entry in statuses.iter() {
            let (.., path) = status_entry_paths(&entry);
            if path.as_deref() == Some("notes.txt") {
                found = entry.status().is_index_new();
            }
        }
        assert!(found);
    }

    #[test]
    fn test_read_git_file_pair_returns_head_index_and_worktree_versions() {
        let (temp, repo) = init_repo();
        let file_path = temp.path().join("README.md");

        fs::write(&file_path, "staged version").unwrap();
        add_paths(&repo, &["README.md".to_string()]).unwrap();
        fs::write(&file_path, "worktree version").unwrap();

        let pair = read_git_file_pair(&repo, temp.path(), Path::new("README.md")).unwrap();

        assert!(pair.head_exists);
        assert!(pair.index_exists);
        assert!(pair.worktree_exists);
        assert_eq!(pair.head_content, "hello");
        assert_eq!(pair.index_content, "staged version");
        assert_eq!(pair.worktree_content, "worktree version");
    }

    #[test]
    fn test_restore_paths_worktree_target_preserves_index_state() {
        let (temp, repo) = init_repo();
        let file_path = temp.path().join("README.md");

        fs::write(&file_path, "staged version").unwrap();
        add_paths(&repo, &["README.md".to_string()]).unwrap();
        fs::write(&file_path, "worktree version").unwrap();

        restore_paths(&repo, &["README.md".to_string()], RestoreTarget::Worktree).unwrap();

        let pair = read_git_file_pair(&repo, temp.path(), Path::new("README.md")).unwrap();
        assert_eq!(pair.head_content, "hello");
        assert_eq!(pair.index_content, "staged version");
        assert_eq!(pair.worktree_content, "staged version");
    }

    #[test]
    fn test_reset_repo_hard() {
        let (temp, repo) = init_repo();
        let initial_commit = repo.head().unwrap().target().unwrap().to_string();

        let file_path = temp.path().join("README.md");
        fs::write(&file_path, "updated").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("README.md")).unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let sig = git2::Signature::now("Tester", "tester@example.com").unwrap();
        let parent = repo.head().unwrap().peel_to_commit().unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "second", &tree, &[&parent])
            .unwrap();

        reset_repo(&repo, "hard", Some(initial_commit)).unwrap();
        let contents = fs::read_to_string(&file_path).unwrap();
        assert_eq!(contents, "hello");
    }

    #[test]
    fn test_stash_repo_clears_changes() {
        let (temp, mut repo) = init_repo();
        let file_path = temp.path().join("README.md");
        fs::write(&file_path, "dirty").unwrap();

        let stash_id = stash_repo(&mut repo, None).unwrap();
        assert!(!stash_id.is_empty());
        let statuses = repo.statuses(Some(&mut get_status_options())).unwrap();
        assert!(statuses.is_empty());
    }

    #[test]
    fn test_classify_macro_sync_failure_auth_required() {
        let diagnostic =
            classify_macro_sync_failure("fatal: could not read from remote repository");

        assert_eq!(diagnostic.state, "failed");
        assert_eq!(diagnostic.reason, Some("auth_required"));
        assert_eq!(diagnostic.next_action, Some("configure_auth"));
    }

    #[test]
    fn test_derive_macro_sync_diagnostic_dirty_requires_commit() {
        let diagnostic = derive_macro_sync_diagnostic(
            &MacroSyncSignals {
                has_origin: true,
                has_upstream: true,
                is_dirty: true,
                ahead: 0,
                behind: 0,
                has_conflicts: false,
            },
            None,
        );

        assert_eq!(diagnostic.state, "pending");
        assert_eq!(diagnostic.reason, Some("dirty"));
        assert_eq!(diagnostic.next_action, Some("commit"));
    }

    #[test]
    fn test_derive_macro_sync_diagnostic_diverged_requires_pull() {
        let diagnostic = derive_macro_sync_diagnostic(
            &MacroSyncSignals {
                has_origin: true,
                has_upstream: true,
                is_dirty: false,
                ahead: 2,
                behind: 3,
                has_conflicts: false,
            },
            None,
        );

        assert_eq!(diagnostic.state, "pending");
        assert_eq!(diagnostic.reason, Some("diverged"));
        assert_eq!(diagnostic.next_action, Some("pull"));
    }

    #[test]
    fn test_derive_macro_sync_diagnostic_missing_origin_is_failed() {
        let diagnostic = derive_macro_sync_diagnostic(
            &MacroSyncSignals {
                has_origin: false,
                has_upstream: false,
                is_dirty: false,
                ahead: 0,
                behind: 0,
                has_conflicts: false,
            },
            None,
        );

        assert_eq!(diagnostic.state, "failed");
        assert_eq!(diagnostic.reason, Some("missing_origin"));
        assert_eq!(diagnostic.next_action, Some("configure_remote"));
    }

    #[test]
    fn test_build_macro_sync_dto_detects_missing_origin_from_repo_state() {
        let (temp, repo) = init_macro_repo();

        let dto = build_macro_sync_dto(&repo, temp.path(), false, None, None, None).unwrap();

        assert_eq!(dto.branch, MACRO_BRANCH_NAME);
        assert!(!dto.has_origin);
        assert!(!dto.has_upstream);
        assert_eq!(dto.reason.as_deref(), Some("missing_origin"));
        assert_eq!(dto.next_action.as_deref(), Some("configure_remote"));
    }

    #[test]
    fn test_derive_macro_sync_diagnostic_missing_upstream_requires_push() {
        let diagnostic = derive_macro_sync_diagnostic(
            &MacroSyncSignals {
                has_origin: true,
                has_upstream: false,
                is_dirty: false,
                ahead: 0,
                behind: 0,
                has_conflicts: false,
            },
            None,
        );

        assert_eq!(diagnostic.state, "pending");
        assert_eq!(diagnostic.reason, Some("missing_upstream"));
        assert_eq!(diagnostic.next_action, Some("push"));
    }

    #[test]
    fn test_build_macro_sync_dto_detects_missing_upstream_from_repo_state() {
        let (temp, repo) = init_macro_repo();
        let remote_dir = TempDir::new().expect("remote dir");
        Repository::init_bare(remote_dir.path()).expect("init bare remote");
        repo.remote(
            DEFAULT_REMOTE_NAME,
            remote_dir.path().to_str().expect("remote path"),
        )
        .expect("configure origin");

        let dto = build_macro_sync_dto(&repo, temp.path(), false, None, None, None).unwrap();

        assert_eq!(dto.branch, MACRO_BRANCH_NAME);
        assert!(dto.has_origin);
        assert!(!dto.has_upstream);
        assert_eq!(dto.reason.as_deref(), Some("missing_upstream"));
        assert_eq!(dto.next_action.as_deref(), Some("push"));
    }

    #[test]
    fn test_derive_macro_sync_diagnostic_conflict_has_conflict_state() {
        let diagnostic = derive_macro_sync_diagnostic(
            &MacroSyncSignals {
                has_origin: true,
                has_upstream: true,
                is_dirty: false,
                ahead: 0,
                behind: 0,
                has_conflicts: true,
            },
            None,
        );

        assert_eq!(diagnostic.state, "conflict");
        assert_eq!(diagnostic.reason, Some("merge_conflict"));
        assert_eq!(diagnostic.next_action, Some("resolve_conflict"));
    }
}
