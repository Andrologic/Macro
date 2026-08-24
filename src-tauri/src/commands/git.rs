// Git Commands

#[path = "git/review.rs"]
mod review;

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use chrono::{DateTime, Utc};
use git2::{
    BranchType, Commit, DiffFormat, DiffStatsFormat, Oid, Repository, RepositoryState, ResetType,
    StashFlags, Status, StatusEntry, TreeWalkMode, TreeWalkResult,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::core::error::{BackendError, Result};
use crate::core::process::background_command;
use crate::fs::validate_path;
use crate::git::repo::{get_branch_name, get_head_commit, get_status, get_status_options};
use crate::git::{GitState, TaskWorktreeEnsureStatus, TaskWorktreeStatus, MACRO_BRANCH_NAME};
use crate::project_path::{
    parse_wsl_unc_path, run_wsl_command_allow_failure, run_wsl_git_allow_failure,
    run_wsl_git_bounded_allow_failure, WslCommandOutput, WslProjectPath,
};
use crate::workspace;
use crate::workspace::metadata::{direct_checkpoint_id, WorkspaceRecoverMissingMetadataRequestDto};
use crate::{WorkspaceMetadataRoot, WorkspaceRoot};

const DEFAULT_LOG_LIMIT: usize = 50;
const DEFAULT_REMOTE_NAME: &str = "origin";
const GENERIC_CONVENTIONAL_COMMIT_MESSAGE: &str =
    "Commit message must follow Conventional Commits: type: subject";
const MAX_CONFLICT_FILE_BYTES: usize = 1_000_000;
const WSL_GIT_TIMEOUT: Duration = Duration::from_secs(8);
const WSL_GIT_MUTATION_TIMEOUT: Duration = Duration::from_secs(30);
const NATIVE_GIT_NETWORK_TIMEOUT: Duration = Duration::from_secs(30);
static REBASE_CHECK_COUNTER: AtomicU64 = AtomicU64::new(0);

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
pub struct GitLogPageDto {
    pub commits: Vec<GitCommitDto>,
    pub revision: String,
}

#[derive(Debug, Clone)]
pub(crate) struct GitLogSnapshot {
    pub revision: String,
    tip: Option<String>,
    has_staged: bool,
    has_unstaged: bool,
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

pub(crate) struct GitBranchesToolPage {
    pub local: Vec<GitBranch>,
    pub remote: Vec<GitBranch>,
    pub current: Option<String>,
    pub has_more: bool,
}

pub(crate) struct GitTreeToolPage {
    pub branch: String,
    pub structure: Vec<GitNode>,
    pub modified_files_count: u32,
    pub has_more: bool,
    pub revision: String,
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

#[derive(Debug, Serialize)]
pub struct GitRemoteDto {
    pub remote: String,
    pub url: String,
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
pub struct GitBranchWorktreeInspectionDto {
    pub worktree_key: String,
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
pub struct GitBranchWorktreeEnsureDto {
    pub worktree_key: String,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchWorktreeRemoveDto {
    pub worktree_key: String,
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
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitRebaseCheckDto {
    pub rebaseable: bool,
    pub conflict_files: Vec<String>,
    pub output: String,
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

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewDiffLineDto {
    #[serde(rename = "type")]
    pub line_type: String,
    pub content: String,
    pub old_line_number: Option<u32>,
    pub new_line_number: Option<u32>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewDiffHunkDto {
    pub header: String,
    pub old_start: u32,
    pub old_count: u32,
    pub new_start: u32,
    pub new_count: u32,
    pub lines: Vec<GitReviewDiffLineDto>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewParsedDiffDto {
    pub original_content: String,
    pub modified_content: String,
    pub additions: u32,
    pub deletions: u32,
    pub hunks: Vec<GitReviewDiffHunkDto>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewChangeDto {
    pub path: String,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub has_pending_visible_change: bool,
    pub has_validated_stage: bool,
    pub validated_removed_line_numbers: Vec<u32>,
    pub validated_added_line_numbers: Vec<u32>,
    pub is_binary: bool,
    pub too_large: bool,
    pub requires_hydration: bool,
    pub original_content: String,
    pub index_content: String,
    pub modified_content: String,
    pub language: String,
    pub hunks: Vec<GitReviewDiffHunkDto>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewSnapshotDto {
    pub branch: String,
    pub staged_paths: Vec<String>,
    pub changes: Vec<GitReviewChangeDto>,
    pub conflicted_files: Vec<String>,
    pub merge_in_progress: bool,
    pub is_clean: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DirectReviewSnapshotDto {
    #[serde(flatten)]
    pub snapshot: GitReviewSnapshotDto,
    pub has_accepted_changes: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewFileDto {
    pub path: String,
    pub status: String,
    pub head_exists: bool,
    pub index_exists: bool,
    pub worktree_exists: bool,
    pub head_content: String,
    pub index_content: String,
    pub worktree_content: String,
    pub pending_diff: GitReviewParsedDiffDto,
    pub full_diff: GitReviewParsedDiffDto,
    pub has_validated_stage: bool,
    pub validated_removed_line_numbers: Vec<u32>,
    pub validated_added_line_numbers: Vec<u32>,
    pub is_binary: bool,
    pub too_large: bool,
    pub language: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitStartMergeResolutionDto {
    pub status: String,
    pub conflict_files: Vec<String>,
    pub output: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitConflictFileSideDto {
    pub exists: bool,
    pub content: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitConflictFileDto {
    pub path: String,
    pub base: GitConflictFileSideDto,
    pub ours: GitConflictFileSideDto,
    pub theirs: GitConflictFileSideDto,
    pub worktree: GitConflictFileSideDto,
    pub is_binary: bool,
    pub too_large: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RestoreTarget {
    Worktree,
    Staged,
    StagedAndWorktree,
}

impl RestoreTarget {
    fn from_option(value: Option<&str>) -> Result<Self> {
        match value.unwrap_or("staged_and_worktree") {
            "worktree" => Ok(Self::Worktree),
            "staged" => Ok(Self::Staged),
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
    let repo = Repository::discover(cwd)?;
    ensure_safe_config(&repo)?;

    let mut command = background_command("git");
    command
        .env_clear()
        .envs(std::env::vars_os().filter(|(key, _)| !is_git_environment_variable(key.as_os_str())));
    command.current_dir(cwd).args(args);
    let output = command.output().map_err(|e| BackendError::Git {
        message: format!("Failed to run git command '{}': {}", args.join(" "), e),
    })?;

    Ok(GitCommandOutput {
        success: output.status.success(),
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn run_git_command_with_timeout(
    cwd: &Path,
    args: &[String],
    timeout_duration: Duration,
) -> Result<GitCommandOutput> {
    let repo = Repository::discover(cwd)?;
    ensure_safe_config(&repo)?;

    let mut command = background_command("git");
    command
        .env_clear()
        .envs(std::env::vars_os().filter(|(key, _)| !is_git_environment_variable(key.as_os_str())))
        // Network commands must not wait forever for an interactive credential prompt.
        .env("GIT_TERMINAL_PROMPT", "0")
        .current_dir(cwd)
        .args(args);
    let mut child = command.spawn().map_err(|error| BackendError::Git {
        message: format!("Failed to run git command '{}': {}", args.join(" "), error),
    })?;
    let started = std::time::Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|error| BackendError::Git {
            message: format!(
                "Failed while waiting for git command '{}': {}",
                args.join(" "),
                error
            ),
        })? {
            let output = child
                .wait_with_output()
                .map_err(|error| BackendError::Git {
                    message: format!(
                        "Failed to collect git command '{}': {}",
                        args.join(" "),
                        error
                    ),
                })?;
            return Ok(GitCommandOutput {
                success: status.success(),
                code: status.code(),
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            });
        }
        if started.elapsed() >= timeout_duration {
            // Reap the child after killing it so Git lock files and handles are
            // not retained by the launcher process.
            let _ = child.kill();
            let _ = child.wait();
            return Err(BackendError::Git {
                message: format!("Git command '{}' timed out.", args.join(" ")),
            });
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn is_git_environment_variable(key: &OsStr) -> bool {
    key.to_string_lossy()
        .to_ascii_uppercase()
        .starts_with("GIT_")
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

fn wsl_output_text(output: &WslCommandOutput) -> String {
    let stdout = output.stdout_text();
    let stderr = output.stderr_text();
    match (stdout.is_empty(), stderr.is_empty()) {
        (true, true) => String::new(),
        (false, true) => stdout,
        (true, false) => stderr,
        (false, false) => format!("{}\n{}", stdout, stderr),
    }
}

fn wsl_git_failure(output: &WslCommandOutput, fallback: &str) -> BackendError {
    let details = wsl_output_text(output);
    BackendError::Git {
        message: if details.is_empty() {
            fallback.to_string()
        } else {
            details
        },
    }
}

async fn run_wsl_git_checked(
    repo_path: &WslProjectPath,
    args: &[String],
    timeout: Duration,
    fallback: &str,
) -> Result<WslCommandOutput> {
    let output = run_wsl_git_allow_failure(repo_path, args, timeout).await?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(wsl_git_failure(&output, fallback))
    }
}

fn validate_git_cli_operand(value: &str, label: &str) -> Result<()> {
    if value.is_empty() || value.starts_with('-') || value.chars().any(char::is_control) {
        return Err(BackendError::Validation(format!(
            "Invalid {label}: Git option-like and control-character values are not allowed"
        )));
    }
    Ok(())
}

async fn wsl_resolve_commit_oid(
    repo_path: &WslProjectPath,
    revision: &str,
    label: &str,
) -> Result<String> {
    let revision = revision.trim();
    validate_git_cli_operand(revision, label)?;
    let peeled = format!("{revision}^{{commit}}");
    let output = run_wsl_git_checked(
        repo_path,
        &[
            "rev-parse".to_string(),
            "--verify".to_string(),
            "--end-of-options".to_string(),
            peeled,
        ],
        WSL_GIT_TIMEOUT,
        "git revision resolution WSL failed",
    )
    .await?;
    let oid = output.stdout_text();
    if !matches!(oid.len(), 40 | 64) || !oid.chars().all(|character| character.is_ascii_hexdigit())
    {
        return Err(BackendError::Validation(format!(
            "Invalid {label}: Git did not resolve it to an immutable object ID"
        )));
    }
    Ok(oid)
}

pub(crate) fn parse_wsl_repo_path(repo_path: &str) -> Option<WslProjectPath> {
    parse_wsl_unc_path(repo_path)
}

fn wsl_status_label(code: char) -> String {
    match code {
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        '?' => "untracked",
        'U' => "conflicted",
        _ => "modified",
    }
    .to_string()
}

fn parse_wsl_branch_line(line: &str) -> String {
    let value = line.strip_prefix("## ").unwrap_or(line).trim();
    if let Some(branch) = value.strip_prefix("No commits yet on ") {
        return branch.trim().to_string();
    }
    if value.starts_with("HEAD ") || value.starts_with("HEAD(") || value == "HEAD" {
        return "DETACHED".to_string();
    }
    value
        .split("...")
        .next()
        .unwrap_or(value)
        .split_whitespace()
        .next()
        .unwrap_or("DETACHED")
        .to_string()
}

struct ParsedWslPorcelainStatus {
    branch: String,
    staged_files: Vec<GitFileStatus>,
    unstaged_files: Vec<GitFileStatus>,
    untracked_files: Vec<GitFileStatus>,
    conflicted_files: Vec<String>,
}

fn parse_wsl_porcelain_v1_z(stdout: &[u8]) -> ParsedWslPorcelainStatus {
    let records = stdout.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut parsed = ParsedWslPorcelainStatus {
        branch: "DETACHED".to_string(),
        staged_files: Vec::new(),
        unstaged_files: Vec::new(),
        untracked_files: Vec::new(),
        conflicted_files: Vec::new(),
    };
    let mut index = 0usize;
    while index < records.len() {
        let record = records[index];
        index += 1;
        if record.is_empty() {
            continue;
        }
        if record.starts_with(b"## ") {
            parsed.branch = parse_wsl_branch_line(&String::from_utf8_lossy(record));
            continue;
        }
        if record.len() < 3 {
            continue;
        }

        let index_status = record[0] as char;
        let worktree_status = record[1] as char;
        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        if path.is_empty() {
            continue;
        }
        let is_rename_or_copy =
            matches!(index_status, 'R' | 'C') || matches!(worktree_status, 'R' | 'C');
        let old_path = if is_rename_or_copy && index < records.len() {
            let original = String::from_utf8_lossy(records[index]).into_owned();
            index += 1;
            Some(original)
        } else {
            None
        };
        let is_conflict = index_status == 'U'
            || worktree_status == 'U'
            || matches!((index_status, worktree_status), ('A', 'A') | ('D', 'D'));
        if is_conflict {
            parsed.conflicted_files.push(path);
            continue;
        }
        if index_status == '?' && worktree_status == '?' {
            parsed.untracked_files.push(GitFileStatus {
                path,
                status: "untracked".to_string(),
                old_path: None,
            });
            continue;
        }
        if index_status != ' ' {
            parsed.staged_files.push(GitFileStatus {
                path: path.clone(),
                status: wsl_status_label(index_status),
                old_path: old_path.clone(),
            });
        }
        if worktree_status != ' ' {
            parsed.unstaged_files.push(GitFileStatus {
                path,
                status: wsl_status_label(worktree_status),
                old_path,
            });
        }
    }
    parsed
}

fn parse_wsl_commit_line(line: &str) -> Option<GitCommitDto> {
    let parts = line.split('\x1f').collect::<Vec<_>>();
    if parts.len() < 6 {
        return None;
    }
    let id = parts[0].to_string();
    let message = parts[2].to_string();
    Some(GitCommitDto {
        id: id.clone(),
        hash: parts[1].to_string(),
        message: message.clone(),
        author: parts[3].to_string(),
        date: parts[4].to_string(),
        status: "committed".to_string(),
        parent_ids: parts[5]
            .split_whitespace()
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect(),
        graph_depth: 0,
        is_branch_point: false,
        task_id: parse_task_id(&message),
    })
}

fn annotate_commit_graph(commits: &mut [GitCommitDto]) {
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
}

async fn wsl_head_commit(repo_path: &WslProjectPath) -> Result<Option<GitCommitDto>> {
    let output = run_wsl_git_allow_failure(
        repo_path,
        &[
            "log".to_string(),
            "-1".to_string(),
            "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%P".to_string(),
        ],
        WSL_GIT_TIMEOUT,
    )
    .await?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(output
        .stdout_text()
        .lines()
        .next()
        .and_then(parse_wsl_commit_line))
}

pub(crate) async fn build_wsl_git_status(repo_path: &WslProjectPath) -> Result<GitStatusDto> {
    let status_output = run_wsl_git_checked(
        repo_path,
        &[
            "status".to_string(),
            "--porcelain=v1".to_string(),
            "-z".to_string(),
            "--branch".to_string(),
        ],
        WSL_GIT_TIMEOUT,
        "git status WSL failed",
    )
    .await?;
    let parsed_status = parse_wsl_porcelain_v1_z(&status_output.stdout);
    let branch = parsed_status.branch;
    let staged_files = parsed_status.staged_files;
    let unstaged_files = parsed_status.unstaged_files;
    let untracked_files = parsed_status.untracked_files;
    let conflicted_files = parsed_status.conflicted_files;

    let head_commit = wsl_head_commit(repo_path).await?;
    let has_origin = run_wsl_git_allow_failure(
        repo_path,
        &[
            "remote".to_string(),
            "get-url".to_string(),
            DEFAULT_REMOTE_NAME.to_string(),
        ],
        WSL_GIT_TIMEOUT,
    )
    .await?
    .status
    .success();
    let upstream = run_wsl_git_allow_failure(
        repo_path,
        &[
            "rev-parse".to_string(),
            "--abbrev-ref".to_string(),
            "--symbolic-full-name".to_string(),
            "@{u}".to_string(),
        ],
        WSL_GIT_TIMEOUT,
    )
    .await?;
    let has_upstream = upstream.status.success();
    let mut ahead = 0u32;
    let mut behind = 0u32;
    if has_upstream {
        let counts = run_wsl_git_allow_failure(
            repo_path,
            &[
                "rev-list".to_string(),
                "--left-right".to_string(),
                "--count".to_string(),
                "@{u}...HEAD".to_string(),
            ],
            WSL_GIT_TIMEOUT,
        )
        .await?;
        if counts.status.success() {
            let values = counts.stdout_text();
            let mut parts = values.split_whitespace();
            behind = parts
                .next()
                .and_then(|value| value.parse().ok())
                .unwrap_or(0);
            ahead = parts
                .next()
                .and_then(|value| value.parse().ok())
                .unwrap_or(0);
        }
    }
    let merge_in_progress = run_wsl_git_allow_failure(
        repo_path,
        &[
            "rev-parse".to_string(),
            "-q".to_string(),
            "--verify".to_string(),
            "MERGE_HEAD".to_string(),
        ],
        WSL_GIT_TIMEOUT,
    )
    .await?
    .status
    .success();
    let is_clean = !merge_in_progress
        && staged_files.is_empty()
        && unstaged_files.is_empty()
        && untracked_files.is_empty()
        && conflicted_files.is_empty();

    Ok(GitStatusDto {
        branch,
        head_commit,
        staged_files,
        unstaged_files,
        untracked_files,
        conflicted_files,
        merge_in_progress,
        is_clean,
        has_origin,
        has_upstream,
        ahead,
        behind,
    })
}

pub(crate) async fn build_wsl_git_log(
    repo_path: &WslProjectPath,
    limit: usize,
    branch: Option<&str>,
) -> Result<Vec<GitCommitDto>> {
    if let Some(branch) = branch {
        validate_refspec(branch)?;
    }
    let status = build_wsl_git_status(repo_path).await?;
    let mut commits = Vec::new();
    if !status.unstaged_files.is_empty() || !status.untracked_files.is_empty() {
        commits.push(build_virtual_commit("in-progress", "Working tree changes"));
    }
    if !status.staged_files.is_empty() {
        commits.push(build_virtual_commit("planned", "Staged changes"));
    }
    let mut args = vec![
        "log".to_string(),
        format!("--max-count={}", limit),
        "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%P".to_string(),
    ];
    if let Some(branch) = branch {
        args.push("--end-of-options".to_string());
        args.push(branch.to_string());
    }
    let output = run_wsl_git_allow_failure(repo_path, &args, WSL_GIT_TIMEOUT).await?;
    if output.status.success() {
        commits.extend(
            output
                .stdout_text()
                .lines()
                .filter_map(parse_wsl_commit_line),
        );
    }
    annotate_commit_graph(&mut commits);
    Ok(commits)
}

pub(crate) async fn build_wsl_git_log_page(
    repo_path: &WslProjectPath,
    offset: usize,
    max_items: usize,
    snapshot: &GitLogSnapshot,
) -> Result<Vec<GitCommitDto>> {
    let mut virtual_commits = Vec::new();
    if snapshot.has_unstaged {
        virtual_commits.push(build_virtual_commit("in-progress", "Working tree changes"));
    }
    if snapshot.has_staged {
        virtual_commits.push(build_virtual_commit("planned", "Staged changes"));
    }
    let virtual_count = virtual_commits.len();
    let mut commits = virtual_commits
        .into_iter()
        .skip(offset)
        .take(max_items)
        .collect::<Vec<_>>();
    let real_limit = max_items.saturating_sub(commits.len());
    if real_limit > 0 && snapshot.tip.is_some() {
        let real_offset = offset.saturating_sub(virtual_count);
        let mut args = vec![
            "log".to_string(),
            format!("--skip={real_offset}"),
            format!("--max-count={real_limit}"),
            "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%P".to_string(),
        ];
        args.push(snapshot.tip.clone().expect("checked snapshot tip"));
        let output =
            run_wsl_git_checked(repo_path, &args, WSL_GIT_TIMEOUT, "git log WSL failed").await?;
        commits.extend(
            output
                .stdout_text()
                .lines()
                .filter_map(parse_wsl_commit_line),
        );
    }
    annotate_commit_graph(&mut commits);
    Ok(commits)
}

pub(crate) async fn build_wsl_git_log_snapshot(
    repo_path: &WslProjectPath,
    branch: Option<&str>,
) -> Result<GitLogSnapshot> {
    if let Some(branch) = branch {
        validate_refspec(branch)?;
    }
    let status = build_wsl_git_status(repo_path).await?;
    let tip = if let Some(branch) = branch {
        let output = run_wsl_git_checked(
            repo_path,
            &[
                "rev-parse".to_string(),
                "--verify".to_string(),
                "--end-of-options".to_string(),
                format!("{branch}^{{commit}}"),
            ],
            WSL_GIT_TIMEOUT,
            "git log reference resolution failed",
        )
        .await?;
        Some(output.stdout_text())
    } else {
        status.head_commit.as_ref().map(|commit| commit.id.clone())
    };
    let has_staged = !status.staged_files.is_empty();
    let has_unstaged = !status.unstaged_files.is_empty() || !status.untracked_files.is_empty();
    Ok(GitLogSnapshot {
        revision: format!(
            "{}:{has_staged}:{has_unstaged}",
            tip.as_deref().unwrap_or("unborn")
        ),
        tip,
        has_staged,
        has_unstaged,
    })
}

pub(crate) async fn build_wsl_git_branches(repo_path: &WslProjectPath) -> Result<GitBranchesDto> {
    let current_output = run_wsl_git_allow_failure(
        repo_path,
        &["branch".to_string(), "--show-current".to_string()],
        WSL_GIT_TIMEOUT,
    )
    .await?;
    let current = if current_output.status.success() {
        let value = current_output.stdout_text();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    } else {
        None
    };
    let parse_refs = |stdout: String, current: Option<&String>| -> Vec<GitBranch> {
        stdout
            .lines()
            .filter_map(|line| {
                let (name, commit) = line.split_once('\t')?;
                Some(GitBranch {
                    name: name.to_string(),
                    is_head: current.is_some_and(|value| value == name),
                    commit: commit.to_string(),
                })
            })
            .collect()
    };
    let local_output = run_wsl_git_checked(
        repo_path,
        &[
            "for-each-ref".to_string(),
            "refs/heads".to_string(),
            "--format=%(refname:short)\t%(objectname:short)".to_string(),
        ],
        WSL_GIT_TIMEOUT,
        "git branch list WSL failed",
    )
    .await?;
    let remote_output = run_wsl_git_checked(
        repo_path,
        &[
            "for-each-ref".to_string(),
            "refs/remotes".to_string(),
            "--format=%(refname:short)\t%(objectname:short)".to_string(),
        ],
        WSL_GIT_TIMEOUT,
        "git branch list WSL failed",
    )
    .await?;
    Ok(GitBranchesDto {
        local: parse_refs(local_output.stdout_text(), current.as_ref()),
        remote: parse_refs(remote_output.stdout_text(), None),
        current,
    })
}

/// Paginate the concatenated local-then-remote branch listing without masking
/// failures: each source list was produced by its own checked command and is
/// already clamped to `offset + limit + 1` entries, so a full clamped list
/// proves at least one entry remains beyond the requested window.
fn paginate_wsl_branch_refs(
    local: Vec<GitBranch>,
    remote: Vec<GitBranch>,
    offset: usize,
    limit: usize,
) -> (Vec<GitBranch>, Vec<GitBranch>, bool) {
    let window_end = offset.saturating_add(limit);
    let fetch_bound = window_end.saturating_add(1);
    let has_more = if local.len() >= fetch_bound || remote.len() >= fetch_bound {
        true
    } else {
        local.len() + remote.len() > window_end
    };

    let mut local_page = Vec::new();
    let mut remote_page = Vec::new();
    for (position, (branch, is_local)) in local
        .into_iter()
        .map(|branch| (branch, true))
        .chain(remote.into_iter().map(|branch| (branch, false)))
        .enumerate()
    {
        if position >= window_end {
            break;
        }
        if position >= offset {
            if is_local {
                local_page.push(branch);
            } else {
                remote_page.push(branch);
            }
        }
    }
    (local_page, remote_page, has_more)
}

fn parse_wsl_branch_ref_lines(stdout: String) -> Vec<(String, String)> {
    stdout
        .lines()
        .filter_map(|line| {
            let (name, commit) = line.split_once('\t')?;
            (!name.is_empty()).then(|| (name.to_string(), commit.to_string()))
        })
        .collect()
}

pub(crate) async fn run_wsl_branch_ref_list(
    repo_path: &WslProjectPath,
    pattern: &str,
    fetch_bound: usize,
) -> Result<WslCommandOutput> {
    // Each for-each-ref runs as an independently checked command so a failure
    // on either side propagates instead of being swallowed by a shell
    // tail/head pipeline. --count bounds every listing to the pagination
    // window plus one sentinel entry used for has_more detection.
    let args = vec![
        "for-each-ref".to_string(),
        "--sort=refname".to_string(),
        format!("--count={fetch_bound}"),
        "--format=%(refname:short)\t%(objectname:short)".to_string(),
        pattern.to_string(),
    ];
    run_wsl_git_checked(
        repo_path,
        &args,
        WSL_GIT_TIMEOUT,
        "git branch list WSL failed",
    )
    .await
}

pub(crate) async fn build_wsl_git_branches_tool_page(
    repo_path: &WslProjectPath,
    offset: usize,
    limit: usize,
) -> Result<GitBranchesToolPage> {
    let current_output = run_wsl_git_allow_failure(
        repo_path,
        &["branch".to_string(), "--show-current".to_string()],
        WSL_GIT_TIMEOUT,
    )
    .await?;
    let current = current_output
        .status
        .success()
        .then(|| current_output.stdout_text())
        .filter(|value| !value.is_empty());

    // Each for-each-ref side is fetched independently and clamped to the
    // pagination window plus one sentinel entry used for has_more detection;
    // any git failure propagates from its checked command.
    let fetch_bound = offset.saturating_add(limit).saturating_add(1);
    let local_output = run_wsl_branch_ref_list(repo_path, "refs/heads", fetch_bound).await?;
    let remote_output = run_wsl_branch_ref_list(repo_path, "refs/remotes", fetch_bound).await?;

    let local = parse_wsl_branch_ref_lines(local_output.stdout_text())
        .into_iter()
        .take(fetch_bound)
        .map(|(name, commit)| GitBranch {
            is_head: current.as_deref() == Some(name.as_str()),
            name,
            commit,
        })
        .collect::<Vec<_>>();
    let remote = parse_wsl_branch_ref_lines(remote_output.stdout_text())
        .into_iter()
        .take(fetch_bound)
        .map(|(name, commit)| GitBranch {
            is_head: false,
            name,
            commit,
        })
        .collect::<Vec<_>>();

    let (local, remote, has_more) = paginate_wsl_branch_refs(local, remote, offset, limit);
    Ok(GitBranchesToolPage {
        local,
        remote,
        current,
        has_more,
    })
}

pub(crate) async fn wsl_git_add(repo_path: &WslProjectPath, paths: &[String]) -> Result<()> {
    let mut args = vec!["add".to_string(), "--".to_string()];
    if paths.is_empty() {
        args.push(".".to_string());
    } else {
        args.extend(paths.iter().cloned());
    }
    run_wsl_git_checked(
        repo_path,
        &args,
        WSL_GIT_MUTATION_TIMEOUT,
        "git add WSL failed",
    )
    .await?;
    Ok(())
}

pub(crate) async fn wsl_git_commit(
    repo_path: &WslProjectPath,
    message: &str,
    stage_all: bool,
) -> Result<String> {
    validate_commit_message(message)?;
    if stage_all {
        wsl_git_add(repo_path, &[".".to_string()]).await?;
    }
    run_wsl_git_checked(
        repo_path,
        &[
            "-c".to_string(),
            "user.name=Macro".to_string(),
            "-c".to_string(),
            "user.email=macro@local".to_string(),
            "commit".to_string(),
            "-m".to_string(),
            message.to_string(),
        ],
        WSL_GIT_MUTATION_TIMEOUT,
        "git commit WSL failed",
    )
    .await?;
    let hash = run_wsl_git_checked(
        repo_path,
        &[
            "rev-parse".to_string(),
            "--short=12".to_string(),
            "HEAD".to_string(),
        ],
        WSL_GIT_TIMEOUT,
        "git rev-parse WSL failed",
    )
    .await?;
    Ok(hash.stdout_text())
}

async fn wsl_git_restore_paths(
    repo_path: &WslProjectPath,
    paths: &[String],
    target: RestoreTarget,
) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args = vec!["restore".to_string()];
    match target {
        RestoreTarget::Worktree => {}
        RestoreTarget::Staged => args.push("--staged".to_string()),
        RestoreTarget::StagedAndWorktree => {
            args.push("--staged".to_string());
            args.push("--worktree".to_string());
        }
    }
    args.push("--".to_string());
    args.extend(paths.iter().cloned());
    run_wsl_git_checked(
        repo_path,
        &args,
        WSL_GIT_MUTATION_TIMEOUT,
        "git restore WSL failed",
    )
    .await?;
    Ok(())
}

pub(crate) async fn wsl_git_reset(
    repo_path: &WslProjectPath,
    mode: &str,
    commit: Option<String>,
    confirm: Option<bool>,
) -> Result<()> {
    let reset_mode = match mode {
        "soft" | "mixed" | "hard" => mode,
        other => {
            return Err(BackendError::Validation(format!(
                "Invalid reset mode: {}",
                other
            )))
        }
    };
    if reset_mode == "hard" && !confirm.unwrap_or(false) {
        return Err(BackendError::Git {
            message: "Hard reset is destructive; set confirm=true".to_string(),
        });
    }
    let resolved_commit = match commit {
        Some(commit) => Some(wsl_resolve_commit_oid(repo_path, &commit, "reset commit").await?),
        None => None,
    };
    let mut args = vec!["reset".to_string(), format!("--{}", reset_mode)];
    if let Some(commit) = resolved_commit {
        args.push(commit);
    }
    run_wsl_git_checked(
        repo_path,
        &args,
        WSL_GIT_MUTATION_TIMEOUT,
        "git reset WSL failed",
    )
    .await?;
    Ok(())
}

pub(crate) async fn wsl_git_checkout(
    repo_path: &WslProjectPath,
    branch_or_commit: &str,
    create: bool,
) -> Result<()> {
    if create {
        validate_branch_name(branch_or_commit)?;
    } else {
        validate_refspec(branch_or_commit)?;
    }
    let mut args = vec!["checkout".to_string()];
    if create {
        args.push("-b".to_string());
    }
    args.push(branch_or_commit.to_string());
    run_wsl_git_checked(
        repo_path,
        &args,
        WSL_GIT_MUTATION_TIMEOUT,
        "git checkout WSL failed",
    )
    .await?;
    Ok(())
}

async fn wsl_current_branch(repo_path: &WslProjectPath) -> Result<Option<String>> {
    let output = run_wsl_git_checked(
        repo_path,
        &["branch".to_string(), "--show-current".to_string()],
        WSL_GIT_TIMEOUT,
        "Cannot determine current WSL branch",
    )
    .await?;
    let branch = output.stdout_text();
    Ok((!branch.is_empty()).then_some(branch))
}

async fn wsl_ensure_clean(repo_path: &WslProjectPath) -> Result<()> {
    if !build_wsl_git_status(repo_path).await?.is_clean {
        return Err(BackendError::GitRepositoryNotClean {
            message: "Please commit or stash your changes first".to_string(),
        });
    }
    Ok(())
}

pub(crate) async fn wsl_git_merge(
    repo_path: &WslProjectPath,
    branch_name: &str,
    into_branch: &str,
) -> Result<String> {
    validate_branch_name(branch_name)?;
    validate_branch_name(into_branch)?;
    wsl_ensure_clean(repo_path).await?;
    let branch_oid = wsl_resolve_commit_oid(repo_path, branch_name, "merge branch").await?;
    let into_oid = wsl_resolve_commit_oid(repo_path, into_branch, "merge target").await?;
    let ancestor = run_wsl_git_allow_failure(
        repo_path,
        &[
            "merge-base".to_string(),
            "--is-ancestor".to_string(),
            branch_oid,
            into_oid,
        ],
        WSL_GIT_TIMEOUT,
    )
    .await?;
    match ancestor.status.code() {
        Some(0) => {
            return Ok(format!(
                "Branch {} is already integrated into {}",
                branch_name, into_branch
            ))
        }
        Some(1) => {}
        _ => return Err(wsl_git_failure(&ancestor, "git merge preflight WSL failed")),
    }

    let original_branch = wsl_current_branch(repo_path).await?;
    if original_branch.as_deref() != Some(into_branch) {
        wsl_git_checkout(repo_path, into_branch, false).await?;
    }
    let output = run_wsl_git_allow_failure(
        repo_path,
        &[
            "merge".to_string(),
            "--no-ff".to_string(),
            "--no-edit".to_string(),
            branch_name.to_string(),
        ],
        WSL_GIT_MUTATION_TIMEOUT,
    )
    .await?;
    if !output.status.success() {
        let merge_head = run_wsl_git_allow_failure(
            repo_path,
            &[
                "rev-parse".to_string(),
                "--verify".to_string(),
                "-q".to_string(),
                "MERGE_HEAD".to_string(),
            ],
            WSL_GIT_TIMEOUT,
        )
        .await?;
        let had_merge_head = merge_head.status.success();
        if had_merge_head {
            let abort = run_wsl_git_allow_failure(
                repo_path,
                &["merge".to_string(), "--abort".to_string()],
                WSL_GIT_MUTATION_TIMEOUT,
            )
            .await?;
            if !abort.status.success() {
                return Err(wsl_git_failure(
                    &abort,
                    "git merge WSL failed and merge --abort also failed",
                ));
            }
        } else if !matches!(merge_head.status.code(), Some(1)) {
            return Err(wsl_git_failure(
                &merge_head,
                "git merge WSL failed and merge state could not be inspected",
            ));
        }
        if let Some(original_branch) = original_branch.as_deref() {
            if original_branch != into_branch {
                wsl_git_checkout(repo_path, original_branch, false).await?;
            }
        }
        if !had_merge_head {
            return Err(wsl_git_failure(&output, "git merge WSL failed"));
        }
        let details = output.stderr_text();
        return Err(BackendError::GitMergeConflict {
            message: if details.is_empty() {
                format!("Cannot merge {} into {}", branch_name, into_branch)
            } else {
                details
            },
        });
    }
    if let Some(original_branch) = original_branch.as_deref() {
        if original_branch != into_branch {
            wsl_git_checkout(repo_path, original_branch, false).await?;
        }
    }
    let details = output.stdout_text();
    Ok(if details.is_empty() {
        format!("Merged {} into {}", branch_name, into_branch)
    } else {
        details
    })
}

pub(crate) async fn wsl_git_stash(
    repo_path: &WslProjectPath,
    message: Option<String>,
) -> Result<String> {
    let status = build_wsl_git_status(repo_path).await?;
    if status.is_clean {
        return Err(BackendError::Git {
            message: "No changes to stash".to_string(),
        });
    }
    let mut args = vec![
        "stash".to_string(),
        "push".to_string(),
        "--include-untracked".to_string(),
    ];
    args.push("--message".to_string());
    args.push(message.unwrap_or_else(|| "WIP".to_string()));
    run_wsl_git_checked(
        repo_path,
        &args,
        WSL_GIT_MUTATION_TIMEOUT,
        "git stash WSL failed",
    )
    .await?;
    let output = run_wsl_git_checked(
        repo_path,
        &[
            "rev-parse".to_string(),
            "--short".to_string(),
            "--verify".to_string(),
            "refs/stash".to_string(),
        ],
        WSL_GIT_TIMEOUT,
        "git stash revision WSL failed",
    )
    .await?;
    Ok(output.stdout_text())
}

async fn wsl_git_branch_create(
    repo_path: &WslProjectPath,
    branch_name: &str,
    from_ref: &str,
) -> Result<()> {
    validate_branch_name(branch_name)?;
    validate_refspec(from_ref)?;
    let from_oid = wsl_resolve_commit_oid(repo_path, from_ref, "branch source").await?;
    run_wsl_git_checked(
        repo_path,
        &["branch".to_string(), branch_name.to_string(), from_oid],
        WSL_GIT_MUTATION_TIMEOUT,
        "git branch WSL failed",
    )
    .await?;
    Ok(())
}

async fn wsl_git_branch_delete(
    repo_path: &WslProjectPath,
    branch_name: &str,
    force: bool,
) -> Result<()> {
    validate_branch_name(branch_name)?;
    run_wsl_git_checked(
        repo_path,
        &[
            "branch".to_string(),
            if force { "-D" } else { "-d" }.to_string(),
            branch_name.to_string(),
        ],
        WSL_GIT_MUTATION_TIMEOUT,
        "git branch delete WSL failed",
    )
    .await?;
    Ok(())
}

pub(crate) async fn wsl_git_diff(
    repo_path: &WslProjectPath,
    base: Option<&str>,
    head: Option<&str>,
    options: DiffRequestOptions,
) -> Result<String> {
    let path_filters = options.paths.clone().unwrap_or_default();
    let mut args = vec!["diff".to_string()];
    if options.mode == GitDiffMode::Stat {
        args.push("--stat".to_string());
    } else if options.mode == GitDiffMode::NameOnly {
        args.push("--name-only".to_string());
    }
    if options.mode == GitDiffMode::Patch {
        if let Some(context_lines) = options.context_lines {
            args.push(format!("--unified={}", context_lines));
        }
    }
    if options.ignore_whitespace {
        args.push("--ignore-all-space".to_string());
    }
    let resolved_base = match base {
        Some(base) => Some(wsl_resolve_commit_oid(repo_path, base, "diff base").await?),
        None => None,
    };
    let resolved_head = match head {
        Some(head) => Some(wsl_resolve_commit_oid(repo_path, head, "diff head").await?),
        None => None,
    };
    if let Some(range) = wsl_diff_range(resolved_base.as_deref(), resolved_head.as_deref()) {
        args.push(range);
    }
    if let Some(paths) = options.paths {
        if !paths.is_empty() {
            args.push("--".to_string());
            args.extend(paths);
        }
    }
    if resolved_head.is_none() {
        return wsl_git_diff_with_untracked(
            repo_path,
            &args,
            &path_filters,
            options.mode,
            options.context_lines,
            options.ignore_whitespace,
            options.max_bytes,
            options.require_complete,
        )
        .await;
    }
    let Some(max_bytes) = options.max_bytes else {
        let output =
            run_wsl_git_checked(repo_path, &args, WSL_GIT_TIMEOUT, "git diff WSL failed").await?;
        return Ok(output.stdout_text());
    };
    let output =
        run_wsl_git_bounded_allow_failure(repo_path, &args, WSL_GIT_TIMEOUT, max_bytes).await?;
    if !output.status.success() {
        let details = output.stderr.text("WSL STDERR");
        return Err(BackendError::Git {
            message: if details.is_empty() {
                "git diff WSL failed".to_string()
            } else {
                details
            },
        });
    }
    if options.require_complete && output.stdout.truncated() {
        return Err(BackendError::Git {
            message: format!(
                "Git diff output requires {} bytes and exceeds the inline limit of {} retained bytes. Narrow paths, use mode=stat or mode=name_only, or retry without require_complete.",
                output.stdout.total_bytes(), output.stdout.retained_bytes()
            ),
        });
    }
    Ok(output.stdout.text("GIT DIFF"))
}

#[allow(clippy::too_many_arguments)]
async fn wsl_git_diff_with_untracked(
    repo_path: &WslProjectPath,
    diff_args: &[String],
    path_filters: &[String],
    mode: GitDiffMode,
    context_lines: Option<u32>,
    ignore_whitespace: bool,
    max_bytes: Option<usize>,
    require_complete: bool,
) -> Result<String> {
    let script = wsl_git_diff_with_untracked_script();
    let mut args = vec![
        "-c".to_string(),
        script.to_string(),
        "macro-git-diff".to_string(),
        repo_path.linux_path.clone(),
        max_bytes.map(|value| value.max(2)).unwrap_or(0).to_string(),
        mode.as_str().to_string(),
        context_lines
            .map(|value| value.to_string())
            .unwrap_or_default(),
        if ignore_whitespace { "1" } else { "0" }.to_string(),
        diff_args.len().to_string(),
        path_filters.len().to_string(),
    ];
    args.extend(diff_args.iter().cloned());
    args.extend(path_filters.iter().cloned());
    let output = run_wsl_command_allow_failure(repo_path, "bash", &args, WSL_GIT_TIMEOUT).await?;
    if !output.status.success() {
        return Err(wsl_git_failure(&output, "git diff WSL failed"));
    }
    let Some(separator) = output.stdout.iter().position(|byte| *byte == 0) else {
        return Err(BackendError::Git {
            message: "git diff WSL returned an invalid bounded-output header".to_string(),
        });
    };
    let header = String::from_utf8_lossy(&output.stdout[..separator]);
    let mut header = header.split('\t');
    if header.next() != Some("macro-diff") {
        return Err(BackendError::Git {
            message: "git diff WSL returned an invalid output header".to_string(),
        });
    }
    let parse_size = |value: Option<&str>| {
        value
            .and_then(|value| value.parse::<usize>().ok())
            .ok_or_else(|| BackendError::Git {
                message: "git diff WSL returned an invalid output size".to_string(),
            })
    };
    let total_bytes = parse_size(header.next())?;
    let head_bytes = parse_size(header.next())?;
    let tail_bytes = parse_size(header.next())?;
    let retained = &output.stdout[separator.saturating_add(1)..];
    if retained.len() != head_bytes.saturating_add(tail_bytes) {
        return Err(BackendError::Git {
            message: "git diff WSL returned an incomplete bounded payload".to_string(),
        });
    }
    let truncated = total_bytes > retained.len();
    if truncated && require_complete {
        return Err(BackendError::Git {
            message: format!(
                "Git diff output requires {} bytes and exceeds the inline limit of {} retained bytes. Narrow paths, use mode=stat or mode=name_only, or retry without require_complete.",
                total_bytes,
                retained.len()
            ),
        });
    }
    let mut text = String::from_utf8_lossy(&retained[..head_bytes]).into_owned();
    if truncated {
        text.push_str(&format!(
            "\n\n[... GIT DIFF TRUNCATED: omitted {} bytes; retained the first {} and last {} bytes ...]\n\n",
            total_bytes.saturating_sub(retained.len()),
            head_bytes,
            tail_bytes
        ));
    }
    if tail_bytes > 0 {
        text.push_str(&String::from_utf8_lossy(&retained[head_bytes..]));
    }
    Ok(text)
}

fn wsl_git_diff_with_untracked_script() -> &'static str {
    r#"
set -u
repo=$1
max_bytes=$2
mode=$3
context=$4
ignore_whitespace=$5
diff_count=$6
path_count=$7
shift 7
diff_args=("${@:1:diff_count}")
shift "$diff_count"
paths=("${@:1:path_count}")
tmpdir=$(mktemp -d) || exit 70
trap 'rm -rf -- "$tmpdir"' EXIT
combined=$tmpdir/combined
untracked=$tmpdir/untracked

git -C "$repo" "${diff_args[@]}" >"$combined" || exit $?
ls_args=(ls-files --others --exclude-standard -z)
if (( path_count > 0 )); then ls_args+=(-- "${paths[@]}"); fi
git -C "$repo" "${ls_args[@]}" >"$untracked" || exit $?

if [[ "$mode" != name_only ]]; then
  untracked_count=0
  while IFS= read -r -d '' _path; do
    untracked_count=$((untracked_count + 1))
    if (( untracked_count > 2000 )); then
      printf 'git diff WSL found more than 2000 untracked files; narrow paths or use mode=name_only\n' >&2
      exit 74
    fi
  done <"$untracked"
fi

while IFS= read -r -d '' path; do
  if [[ "$mode" == name_only ]]; then
    printf '%s\n' "$path" >>"$combined" || exit $?
    continue
  fi
  extra=(diff --no-index)
  [[ "$mode" == stat ]] && extra+=(--stat)
  [[ "$mode" == patch && -n "$context" ]] && extra+=("--unified=$context")
  [[ "$ignore_whitespace" == 1 ]] && extra+=(--ignore-all-space)
  set +e
  git -C "$repo" "${extra[@]}" -- /dev/null "$path" >>"$combined"
  code=$?
  set -e
  [[ $code -eq 0 || $code -eq 1 ]] || exit "$code"
done <"$untracked"

total=$(wc -c <"$combined") || exit $?
total=${total//[[:space:]]/}
if [[ "$max_bytes" == 0 || "$total" -le "$max_bytes" ]]; then
  printf 'macro-diff\t%s\t%s\t0\0' "$total" "$total"
  cat -- "$combined"
else
  tail_bytes=$((max_bytes / 4))
  head_bytes=$((max_bytes - tail_bytes))
  printf 'macro-diff\t%s\t%s\t%s\0' "$total" "$head_bytes" "$tail_bytes"
  head -c "$head_bytes" -- "$combined"
  tail -c "$tail_bytes" -- "$combined"
fi
"#
}

fn wsl_diff_range(base: Option<&str>, head: Option<&str>) -> Option<String> {
    match (base, head) {
        (Some(base), Some(head)) => Some(format!("{}..{}", base, head)),
        (Some(base), None) => Some(base.to_string()),
        (None, Some(head)) => Some(format!("HEAD..{}", head)),
        (None, None) => None,
    }
}

pub(crate) async fn build_wsl_git_tree(
    repo_path: &WslProjectPath,
    branch: Option<&str>,
) -> Result<PredictedGitTreeDto> {
    let branch_name = if let Some(branch) = branch {
        validate_refspec(branch)?;
        branch.to_string()
    } else {
        wsl_current_branch(repo_path)
            .await?
            .unwrap_or_else(|| "DETACHED".to_string())
    };
    let tree_ref = if branch_name == "DETACHED" {
        wsl_resolve_commit_oid(repo_path, "HEAD", "tree reference").await?
    } else {
        wsl_resolve_commit_oid(repo_path, &branch_name, "tree reference").await?
    };
    let tree_output = run_wsl_git_allow_failure(
        repo_path,
        &[
            "ls-tree".to_string(),
            "-r".to_string(),
            "--name-only".to_string(),
            tree_ref.clone(),
        ],
        WSL_GIT_TIMEOUT,
    )
    .await?;
    let mut structure = Vec::new();
    if tree_output.status.success() {
        for path in tree_output.stdout_text().lines() {
            let parts = path.split('/').collect::<Vec<_>>();
            insert_node(&mut structure, &parts, "", "tracked");
        }
    }
    let status = build_wsl_git_status(repo_path).await?;
    let mut status_count = 0u32;
    for file in status
        .staged_files
        .iter()
        .chain(status.unstaged_files.iter())
        .chain(status.untracked_files.iter())
    {
        status_count += 1;
        let parts = file.path.split('/').collect::<Vec<_>>();
        insert_node(&mut structure, &parts, "", &file.status);
    }
    for path in status.conflicted_files {
        status_count += 1;
        let parts = path.split('/').collect::<Vec<_>>();
        insert_node(&mut structure, &parts, "", "conflicted");
    }
    Ok(PredictedGitTreeDto {
        branch: branch_name,
        structure,
        modified_files_count: status_count,
    })
}

pub(crate) async fn build_wsl_git_tree_tool_page(
    repo_path: &WslProjectPath,
    branch: Option<&str>,
    offset: usize,
    limit: usize,
) -> Result<GitTreeToolPage> {
    let branch_name = if let Some(branch) = branch {
        validate_refspec(branch)?;
        branch.to_string()
    } else {
        wsl_current_branch(repo_path)
            .await?
            .unwrap_or_else(|| "DETACHED".to_string())
    };
    let tree_ref = if branch_name == "DETACHED" {
        wsl_resolve_commit_oid(repo_path, "HEAD", "tree reference").await?
    } else {
        wsl_resolve_commit_oid(repo_path, &branch_name, "tree reference").await?
    };
    let script = wsl_git_tree_page_script();
    let output = run_wsl_command_allow_failure(
        repo_path,
        "bash",
        &[
            "-c".to_string(),
            script.to_string(),
            "macro-git-tree".to_string(),
            repo_path.linux_path.clone(),
            tree_ref.clone(),
            offset.saturating_add(1).to_string(),
            limit.saturating_add(1).to_string(),
        ],
        WSL_GIT_TIMEOUT,
    )
    .await?;
    if !output.status.success() {
        return Err(wsl_git_failure(&output, "git tree WSL failed"));
    }
    let mut records = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .collect::<Vec<_>>();
    let header = records.first().copied().unwrap_or_default();
    let header = String::from_utf8_lossy(header);
    let mut header_fields = header.splitn(3, '\t');
    if header_fields.next() != Some("macro-tree") {
        return Err(BackendError::Git {
            message: "git tree WSL returned an invalid page header".to_string(),
        });
    }
    let modified_files_count = header_fields
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(|| BackendError::Git {
            message: "git tree WSL returned an invalid status count".to_string(),
        })?;
    let status_digest = header_fields
        .next()
        .filter(|value| value.len() == 64)
        .ok_or_else(|| BackendError::Git {
            message: "git tree WSL returned an invalid status revision".to_string(),
        })?;
    records.remove(0);
    let has_more = records.len() > limit;
    let mut structure = Vec::with_capacity(limit.min(records.len()));
    for record in records.into_iter().take(limit) {
        let mut fields = record.splitn(3, |byte| *byte == b'\t');
        let hash = String::from_utf8_lossy(fields.next().unwrap_or_default()).into_owned();
        let kind = String::from_utf8_lossy(fields.next().unwrap_or_default()).into_owned();
        let path = String::from_utf8_lossy(fields.next().unwrap_or_default()).into_owned();
        if path.is_empty() {
            continue;
        }
        let name = path.rsplit('/').next().unwrap_or(path.as_str()).to_string();
        structure.push(GitNode {
            name,
            path,
            node_type: if matches!(kind.as_str(), "tree" | "commit") {
                "directory"
            } else {
                "file"
            }
            .to_string(),
            status: None,
            children: None,
            hash: (!hash.is_empty()).then_some(hash),
        });
    }
    apply_wsl_tree_page_statuses(repo_path, &mut structure).await?;
    Ok(GitTreeToolPage {
        branch: branch_name,
        structure,
        modified_files_count,
        has_more,
        revision: format!("{}:{}", tree_ref, status_digest),
    })
}

fn wsl_git_tree_page_script() -> &'static str {
    r#"
set -u
export LC_ALL=C
repo=$1
tree_ref=$2
start=$3
count=$4
tmpdir=$(mktemp -d) || exit 70
trap 'rm -rf -- "$tmpdir"' EXIT

tracked=$tmpdir/tracked
tracked_paths=$tmpdir/tracked-paths
status=$tmpdir/status
status_only=$tmpdir/status-only
status_only_sorted=$tmpdir/status-only-sorted
tracked_paths_sorted=$tmpdir/tracked-paths-sorted
new_paths=$tmpdir/new-paths
combined=$tmpdir/combined

# Finish and check each Git producer before paginating its output. This avoids
# losing an ls-tree/status failure behind a successful tail/head consumer.
git -C "$repo" ls-tree -r -z \
  --format='%(objectname)%x09%(objecttype)%x09%(path)' "$tree_ref" >"$tracked" || exit $?
git -C "$repo" status --porcelain=v1 -z --untracked-files=all >"$status" || exit $?

: >"$tracked_paths"
while IFS= read -r -d '' record; do
  rest=${record#*$'\t'}
  path=${rest#*$'\t'}
  printf '%s\0' "$path" >>"$tracked_paths" || exit $?
done <"$tracked"

: >"$status_only"
modified=0
exec 3<"$status"
while IFS= read -r -d '' record <&3; do
  modified=$((modified + 1))
  x=${record:0:1}
  y=${record:1:1}
  path=${record:3}
  if [[ "$x" == R || "$x" == C || "$y" == R || "$y" == C ]]; then
    IFS= read -r -d '' _old_path <&3 || exit 71
  fi
  if [[ "$x$y" == '??' || "$x" == A || "$x" == R || "$x" == C || "$y" == R || "$y" == C ]]; then
    printf '%s\0' "$path" >>"$status_only" || exit $?
  fi
done

sort -z -u "$tracked_paths" >"$tracked_paths_sorted" || exit $?
sort -z -u "$status_only" >"$status_only_sorted" || exit $?
comm -z -23 "$status_only_sorted" "$tracked_paths_sorted" >"$new_paths" || exit $?
cp -- "$tracked" "$combined" || exit $?
while IFS= read -r -d '' path; do
  printf '\tblob\t%s\0' "$path" >>"$combined" || exit $?
done <"$new_paths"

status_digest=$(sha256sum -- "$status") || exit $?
status_digest=${status_digest%% *}
printf 'macro-tree\t%s\t%s\0' "$modified" "$status_digest"
tail -z -n +"$start" -- "$combined" | head -z -n "$count"
pipe_status=("${PIPESTATUS[@]}")
[[ (${pipe_status[0]} -eq 0 || ${pipe_status[0]} -eq 141) && ${pipe_status[1]} -eq 0 ]] || exit 72
"#
}

async fn apply_wsl_tree_page_statuses(
    repo_path: &WslProjectPath,
    structure: &mut [GitNode],
) -> Result<()> {
    const STATUS_PATH_CHUNK_BYTES: usize = 96 * 1024;
    let mut labels = HashMap::with_capacity(structure.len());
    let mut start = 0usize;
    while start < structure.len() {
        let mut end = start;
        let mut bytes = 0usize;
        while end < structure.len() {
            let next = structure[end].path.len().saturating_add(1);
            if end > start && bytes.saturating_add(next) > STATUS_PATH_CHUNK_BYTES {
                break;
            }
            bytes = bytes.saturating_add(next);
            end += 1;
        }
        let mut args = vec![
            "--literal-pathspecs".to_string(),
            "status".to_string(),
            "--porcelain=v1".to_string(),
            "-z".to_string(),
            "--untracked-files=all".to_string(),
            "--".to_string(),
        ];
        args.extend(structure[start..end].iter().map(|node| node.path.clone()));
        let output = run_wsl_git_checked(
            repo_path,
            &args,
            WSL_GIT_TIMEOUT,
            "git tree status WSL failed",
        )
        .await?;
        let parsed = parse_wsl_porcelain_v1_z(&output.stdout);
        for file in parsed.untracked_files {
            labels
                .entry(file.path)
                .or_insert_with(|| "added".to_string());
        }
        for file in parsed.unstaged_files {
            labels.insert(file.path, file.status);
        }
        for file in parsed.staged_files {
            labels.insert(file.path, file.status);
        }
        for path in parsed.conflicted_files {
            labels.insert(path, "conflicted".to_string());
        }
        start = end;
    }
    for node in structure {
        node.status = labels.remove(&node.path);
    }
    Ok(())
}

pub(crate) async fn wsl_git_tree_revision(
    repo_path: &WslProjectPath,
    branch: Option<&str>,
) -> Result<String> {
    let tree_ref = match branch {
        Some(branch) => {
            validate_refspec(branch)?;
            wsl_resolve_commit_oid(repo_path, branch, "tree reference").await?
        }
        None => wsl_resolve_commit_oid(repo_path, "HEAD", "tree reference").await?,
    };
    let script = r#"
set -o pipefail
git -C "$1" status --porcelain=v1 -z --untracked-files=all | sha256sum
statuses=("${PIPESTATUS[@]}")
[[ ${statuses[0]} -eq 0 && ${statuses[1]} -eq 0 ]] || exit 73
"#;
    let output = run_wsl_command_allow_failure(
        repo_path,
        "bash",
        &[
            "-c".to_string(),
            script.to_string(),
            "macro-git-tree-revision".to_string(),
            repo_path.linux_path.clone(),
        ],
        WSL_GIT_TIMEOUT,
    )
    .await?;
    if !output.status.success() {
        return Err(wsl_git_failure(&output, "git tree revision WSL failed"));
    }
    let stdout = output.stdout_text();
    let digest = stdout
        .split_whitespace()
        .next()
        .filter(|value| value.len() == 64)
        .ok_or_else(|| BackendError::Git {
            message: "git tree revision WSL returned an invalid digest".to_string(),
        })?;
    Ok(format!("{}:{}", tree_ref, digest))
}

async fn wsl_resolve_target_branch(
    repo_path: &WslProjectPath,
    branch: Option<String>,
) -> Result<String> {
    if let Some(branch) = branch {
        let branch = branch.trim().to_string();
        validate_branch_name(&branch)?;
        return Ok(branch);
    }
    let output = run_wsl_git_checked(
        repo_path,
        &["branch".to_string(), "--show-current".to_string()],
        WSL_GIT_TIMEOUT,
        "Cannot determine current WSL branch",
    )
    .await?;
    let branch = output.stdout_text();
    if branch.is_empty() {
        Err(BackendError::GitBranchNotFound {
            message: "No current branch".to_string(),
        })
    } else {
        validate_branch_name(&branch)?;
        Ok(branch)
    }
}

async fn wsl_git_sync(
    repo_path: &WslProjectPath,
    operation: &str,
    remote: Option<String>,
    branch: Option<String>,
) -> Result<GitSyncDto> {
    let use_tracking_upstream = remote.is_none() && branch.is_none();
    let remote_name = remote
        .unwrap_or_else(|| DEFAULT_REMOTE_NAME.to_string())
        .trim()
        .to_string();
    validate_remote_name(&remote_name)?;
    let branch_name = wsl_resolve_target_branch(repo_path, branch).await?;
    let args = match operation {
        "fetch" => vec![
            "fetch".to_string(),
            remote_name.clone(),
            branch_name.clone(),
        ],
        "push" => vec![
            "push".to_string(),
            "-u".to_string(),
            remote_name.clone(),
            branch_name.clone(),
        ],
        "pull" if use_tracking_upstream => vec!["pull".to_string(), "--no-rebase".to_string()],
        "pull" => vec![
            "pull".to_string(),
            "--no-rebase".to_string(),
            remote_name.clone(),
            branch_name.clone(),
        ],
        other => {
            return Err(BackendError::Validation(format!(
                "Invalid Git sync operation: {}",
                other
            )))
        }
    };
    let output = run_wsl_git_checked(
        repo_path,
        &args,
        WSL_GIT_MUTATION_TIMEOUT,
        "Git WSL sync failed",
    )
    .await?;
    Ok(GitSyncDto {
        branch: branch_name,
        remote: remote_name,
        output: wsl_output_text(&output),
    })
}

async fn wsl_git_remote_add_origin(repo_path: &WslProjectPath, url: &str) -> Result<GitRemoteDto> {
    let normalized_url = normalize_remote_url(url)?;
    let exists = run_wsl_git_allow_failure(
        repo_path,
        &[
            "remote".to_string(),
            "get-url".to_string(),
            DEFAULT_REMOTE_NAME.to_string(),
        ],
        WSL_GIT_TIMEOUT,
    )
    .await?
    .status
    .success();
    if exists {
        return Err(BackendError::Validation(
            "Remote origin is already configured".to_string(),
        ));
    }
    run_wsl_git_checked(
        repo_path,
        &[
            "remote".to_string(),
            "add".to_string(),
            DEFAULT_REMOTE_NAME.to_string(),
            normalized_url.clone(),
        ],
        WSL_GIT_MUTATION_TIMEOUT,
        "git remote add WSL failed",
    )
    .await?;
    Ok(GitRemoteDto {
        remote: DEFAULT_REMOTE_NAME.to_string(),
        url: normalized_url,
    })
}

fn unsupported_wsl_git_operation(name: &str) -> BackendError {
    BackendError::Git {
        message: format!(
            "L'operation Git WSL '{}' n'est pas encore prise en charge sans fallback Windows.",
            name
        ),
    }
}

fn sanitize_temp_segment(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();

    if sanitized.is_empty() {
        "branch".to_string()
    } else {
        sanitized
    }
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

fn normalize_remote_url(url: &str) -> Result<String> {
    let normalized = url.trim().to_string();
    if normalized.is_empty() {
        return Err(BackendError::Validation(
            "Remote URL cannot be empty".to_string(),
        ));
    }
    if normalized
        .chars()
        .any(|c| c == '\n' || c == '\r' || c == '\0')
    {
        return Err(BackendError::Validation(
            "Remote URL cannot contain control characters".to_string(),
        ));
    }
    Ok(normalized)
}

fn add_origin_remote(repo: &Repository, url: &str) -> Result<GitRemoteDto> {
    let normalized_url = normalize_remote_url(url)?;
    if repo.find_remote(DEFAULT_REMOTE_NAME).is_ok() {
        return Err(BackendError::Validation(
            "Remote origin is already configured".to_string(),
        ));
    }
    repo.remote(DEFAULT_REMOTE_NAME, &normalized_url)
        .map_err(|error| BackendError::Git {
            message: format!("Failed to add remote origin: {}", error),
        })?;
    Ok(GitRemoteDto {
        remote: DEFAULT_REMOTE_NAME.to_string(),
        url: normalized_url,
    })
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
) -> Result<(PathBuf, Repository, bool)> {
    let repo = git_state.open_repo(workspace_root)?;
    let repo = repo.lock().map_err(|_| BackendError::Internal {
        message: "Failed to lock repository".to_string(),
    })?;
    let ensured = git_state.ensure_macro_metadata_worktree_with_status(&repo)?;
    let worktree_path = ensured.worktree_path;
    let repaired_after_move = ensured.repaired_after_move;
    drop(repo);

    let worktree_repo = Repository::open(&worktree_path).map_err(|e| BackendError::Git {
        message: format!(
            "Failed to open metadata worktree at {}: {}",
            worktree_path.display(),
            e
        ),
    })?;

    Ok((worktree_path, worktree_repo, repaired_after_move))
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

fn ensure_macro_workspace_not_wsl(workspace: &Path) -> Result<()> {
    if parse_wsl_unc_path(&workspace.to_string_lossy()).is_some() {
        return Err(BackendError::Git {
            message: "Les metadata @macro pour WSL doivent etre gerees via Git Linux; ce flux n'est pas encore porte sans fallback Windows.".to_string(),
        });
    }
    Ok(())
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

    if !signals.has_upstream {
        return MacroSyncDiagnostic {
            state: "pending",
            reason: Some("missing_upstream"),
            next_action: Some("push"),
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
    validate_git_cli_operand(branch, "branch name")?;
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
    validate_git_cli_operand(spec, "reference")?;
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
    let header = trimmed.lines().next().unwrap_or("").trim();

    if header.is_empty() {
        return Err(BackendError::Validation(
            GENERIC_CONVENTIONAL_COMMIT_MESSAGE.to_string(),
        ));
    }

    let Some((header, subject)) = header.split_once(": ") else {
        return Err(BackendError::Validation(
            GENERIC_CONVENTIONAL_COMMIT_MESSAGE.to_string(),
        ));
    };
    if subject.trim().is_empty() {
        return Err(BackendError::Validation(
            "Commit subject is required".to_string(),
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
        let valid_scope = scope
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
            && scope
                .chars()
                .next()
                .map(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
                .unwrap_or(false);
        if !valid_scope {
            return Err(BackendError::Validation(
                "Commit scope must be kebab-case".to_string(),
            ));
        }
    }

    let allowed = [
        "feat", "fix", "perf", "build", "chore", "ci", "docs", "refactor", "style", "test",
        "revert",
    ];
    if !allowed.contains(&commit_type) {
        return Err(BackendError::Validation(
            "Commit type must be one of: feat, fix, perf, build, chore, ci, docs, refactor, style, test, revert".to_string(),
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
    let mut index = repo.index()?;
    index.read(true)?;
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
    let mut restore_from_head_to_index_paths = Vec::new();
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
            RestoreTarget::Staged => {
                if in_index {
                    restore_from_head_to_index_paths.push(relative);
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

    if !restore_from_head_to_index_paths.is_empty() {
        let mut args = vec![
            "restore".to_string(),
            "--staged".to_string(),
            "--".to_string(),
        ];
        args.extend(
            restore_from_head_to_index_paths
                .iter()
                .map(|path| path.to_string_lossy().to_string()),
        );
        let output = run_git_command(&repo_root, &args)?;
        if !output.success {
            let details = command_output_text(&output);
            return Err(BackendError::Git {
                message: if details.is_empty() {
                    "Failed to unstage paths".to_string()
                } else {
                    details
                },
            });
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
        let mut args = vec![
            "restore".to_string(),
            "--worktree".to_string(),
            "--".to_string(),
        ];
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

pub(crate) fn abort_merge(repo: &Repository) -> Result<()> {
    if repo.state() != RepositoryState::Merge {
        return Err(BackendError::Git {
            message: "No merge in progress".to_string(),
        });
    }

    let original_head = repo
        .revparse_single("ORIG_HEAD")
        .map_err(|_| BackendError::Git {
            message: "Cannot abort merge because ORIG_HEAD is missing".to_string(),
        })?;
    repo.reset(&original_head, ResetType::Hard, None)?;
    repo.cleanup_state()?;
    Ok(())
}

pub(crate) fn abort_merge_with_confirmation(
    repo: &Repository,
    confirm: Option<bool>,
) -> Result<()> {
    if !confirm.unwrap_or(false) {
        return Err(BackendError::Git {
            message: "Abort merge requires confirm=true".to_string(),
        });
    }

    abort_merge(repo)
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
    let message = commit
        .summary()
        .ok()
        .flatten()
        .unwrap_or("(no message)")
        .to_string();
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
        entry.path().ok().map(str::to_string),
        entry.path().ok().map(str::to_string),
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GitDiffMode {
    Patch,
    Stat,
    NameOnly,
}

impl GitDiffMode {
    pub(crate) fn parse(value: Option<&str>) -> Result<Self> {
        match value.unwrap_or("patch").trim() {
            "patch" | "" => Ok(Self::Patch),
            "stat" => Ok(Self::Stat),
            "name_only" => Ok(Self::NameOnly),
            value => Err(BackendError::Validation(format!(
                "Unsupported git diff mode '{}'. Expected patch, stat, or name_only.",
                value
            ))),
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Patch => "patch",
            Self::Stat => "stat",
            Self::NameOnly => "name_only",
        }
    }
}

pub(crate) struct DiffRequestOptions {
    pub context_lines: Option<u32>,
    pub ignore_whitespace: bool,
    pub paths: Option<Vec<String>>,
    pub mode: GitDiffMode,
    pub max_bytes: Option<usize>,
    pub require_complete: bool,
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

pub(crate) fn build_git_log_page(
    repo: &Repository,
    offset: usize,
    max_items: usize,
    snapshot: &GitLogSnapshot,
) -> Result<Vec<GitCommitDto>> {
    let mut virtual_commits = Vec::new();
    if snapshot.has_unstaged {
        virtual_commits.push(build_virtual_commit("in-progress", "Working tree changes"));
    }
    if snapshot.has_staged {
        virtual_commits.push(build_virtual_commit("planned", "Staged changes"));
    }
    let virtual_count = virtual_commits.len();
    let mut commits = virtual_commits
        .into_iter()
        .skip(offset)
        .take(max_items)
        .collect::<Vec<_>>();
    let real_limit = max_items.saturating_sub(commits.len());
    if real_limit == 0 {
        annotate_commit_graph(&mut commits);
        return Ok(commits);
    }

    let Some(tip) = snapshot.tip.as_deref() else {
        annotate_commit_graph(&mut commits);
        return Ok(commits);
    };
    let mut revwalk = repo.revwalk()?;
    revwalk.push(Oid::from_str(tip).map_err(|error| BackendError::Git {
        message: format!("Invalid git log snapshot tip: {error}"),
    })?)?;

    let real_offset = offset.saturating_sub(virtual_count);
    for oid in revwalk.skip(real_offset).take(real_limit) {
        let oid = oid.map_err(|error| BackendError::Git {
            message: error.to_string(),
        })?;
        let commit = repo.find_commit(oid)?;
        commits.push(commit_to_dto(&commit));
    }
    annotate_commit_graph(&mut commits);
    Ok(commits)
}

pub(crate) fn build_git_log_snapshot(
    repo: &Repository,
    branch: Option<&str>,
) -> Result<GitLogSnapshot> {
    let (has_staged, has_unstaged) = get_working_status_flags(repo)?;
    if let Some(branch) = branch {
        validate_refspec(branch)?;
    }
    let tip = if let Some(branch) = branch {
        Some(resolve_commit(repo, branch)?.id().to_string())
    } else {
        repo.head()
            .ok()
            .and_then(|head| head.target())
            .map(|oid| oid.to_string())
    };
    Ok(GitLogSnapshot {
        revision: format!(
            "{}:{has_staged}:{has_unstaged}",
            tip.as_deref().unwrap_or("unborn")
        ),
        tip,
        has_staged,
        has_unstaged,
    })
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

pub(crate) fn build_git_branches_tool_page(
    repo: &Repository,
    offset: usize,
    limit: usize,
) -> Result<GitBranchesToolPage> {
    let current = get_branch_name(repo)?;
    let mut local = Vec::new();
    let mut remote = Vec::new();
    let mut position = 0usize;
    let mut retained = 0usize;
    let mut has_more = false;

    for (branch_type, destination) in [
        (BranchType::Local, &mut local),
        (BranchType::Remote, &mut remote),
    ] {
        for branch in repo.branches(Some(branch_type))? {
            let (branch, _) = branch?;
            if position < offset {
                position += 1;
                continue;
            }
            if retained >= limit {
                has_more = true;
                break;
            }
            let name = branch.name()?.unwrap_or("").to_string();
            let commit = branch
                .get()
                .peel_to_commit()
                .map(|commit| short_hash(commit.id()))
                .unwrap_or_default();
            destination.push(GitBranch {
                is_head: branch_type == BranchType::Local
                    && current.as_deref() == Some(name.as_str()),
                name,
                commit,
            });
            position += 1;
            retained += 1;
        }
        if has_more {
            break;
        }
    }

    Ok(GitBranchesToolPage {
        local,
        remote,
        current,
        has_more,
    })
}

pub(crate) fn checkout_repo(repo: &Repository, branch_or_commit: &str, create: bool) -> Result<()> {
    ensure_clean(repo)?;

    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.safe();

    if create {
        validate_branch_name(branch_or_commit)?;
        let head_commit = repo
            .head()
            .and_then(|head| head.peel_to_commit())
            .map_err(|_| BackendError::Git {
                message: "Cannot create branch without an initial commit".to_string(),
            })?;
        repo.branch(branch_or_commit, &head_commit, false)?;
        let ref_name = format!("refs/heads/{}", branch_or_commit);
        repo.set_head(&ref_name)?;
    } else if repo
        .find_reference(&format!("refs/heads/{}", branch_or_commit))
        .is_ok()
    {
        let ref_name = format!("refs/heads/{}", branch_or_commit);
        let object = repo.revparse_single(&ref_name)?;
        repo.checkout_tree(&object, Some(&mut checkout))
            .map_err(|e| BackendError::GitConflict {
                message: e.to_string(),
            })?;
        repo.set_head(&ref_name)?;
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
        repo.checkout_tree(commit.as_object(), Some(&mut checkout))
            .map_err(|e| BackendError::GitConflict {
                message: e.to_string(),
            })?;
        repo.set_head_detached(commit.id())?;
    }

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

    let into_commit = resolve_commit(repo, into_branch)?;
    let branch_commit = resolve_commit(repo, branch_name)?;
    let (ahead_count, behind_count) = repo
        .graph_ahead_behind(branch_commit.id(), into_commit.id())
        .map_err(|e| BackendError::Git {
            message: e.to_string(),
        })?;
    let ahead = ahead_count as u32;
    let behind = behind_count as u32;

    let diff = diff_repo(
        repo,
        Some(into_branch),
        Some(branch_name),
        DiffRequestOptions {
            context_lines: Some(0),
            ignore_whitespace: false,
            paths: None,
            mode: GitDiffMode::Patch,
            max_bytes: None,
            require_complete: false,
        },
    )?;
    let has_changes = !diff.trim().is_empty();
    if !has_changes {
        return Ok(GitMergeCheckDto {
            mergeable: true,
            conflict_files: Vec::new(),
            has_changes: false,
            ahead,
            behind,
        });
    }

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
        ahead,
        behind,
    })
}

fn collect_command_conflict_files(cwd: &Path) -> Vec<String> {
    let output = run_git_command(
        cwd,
        &[
            "diff".to_string(),
            "--name-only".to_string(),
            "--diff-filter=U".to_string(),
        ],
    );

    match output {
        Ok(output) if output.success => output
            .stdout
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(ToString::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn has_binary_marker(bytes: &[u8]) -> bool {
    bytes.contains(&0)
}

fn conflict_side_from_bytes(bytes: Option<&[u8]>) -> GitConflictFileSideDto {
    let Some(bytes) = bytes else {
        return GitConflictFileSideDto {
            exists: false,
            content: String::new(),
        };
    };

    if bytes.len() > MAX_CONFLICT_FILE_BYTES || has_binary_marker(bytes) {
        return GitConflictFileSideDto {
            exists: true,
            content: String::new(),
        };
    }

    GitConflictFileSideDto {
        exists: true,
        content: String::from_utf8_lossy(bytes).to_string(),
    }
}

fn read_conflict_entry_side(
    repo: &Repository,
    entry: Option<&git2::IndexEntry>,
) -> Result<(GitConflictFileSideDto, bool, bool)> {
    let Some(entry) = entry else {
        return Ok((
            GitConflictFileSideDto {
                exists: false,
                content: String::new(),
            },
            false,
            false,
        ));
    };

    if entry.id == Oid::ZERO_SHA1 {
        return Ok((
            GitConflictFileSideDto {
                exists: false,
                content: String::new(),
            },
            false,
            false,
        ));
    }

    let blob = repo.find_blob(entry.id)?;
    let content = blob.content();
    let too_large = content.len() > MAX_CONFLICT_FILE_BYTES;
    let is_binary = has_binary_marker(content);

    Ok((
        conflict_side_from_bytes(Some(content)),
        is_binary,
        too_large,
    ))
}

fn read_worktree_conflict_side(
    repo_root: &Path,
    relative_path: &Path,
) -> Result<(GitConflictFileSideDto, bool, bool)> {
    let absolute_path = repo_root.join(relative_path);

    match fs::read(&absolute_path) {
        Ok(bytes) => {
            let too_large = bytes.len() > MAX_CONFLICT_FILE_BYTES;
            let is_binary = has_binary_marker(&bytes);
            Ok((conflict_side_from_bytes(Some(&bytes)), is_binary, too_large))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok((
            GitConflictFileSideDto {
                exists: false,
                content: String::new(),
            },
            false,
            false,
        )),
        Err(error) => Err(BackendError::Io {
            message: format!(
                "Failed to read worktree conflict file {:?}: {}",
                absolute_path, error
            ),
            source: error,
        }),
    }
}

fn index_entry_path(entry: &git2::IndexEntry) -> PathBuf {
    PathBuf::from(String::from_utf8_lossy(&entry.path).to_string())
}

fn conflict_matches_path(conflict: &git2::IndexConflict, relative_path: &Path) -> bool {
    conflict
        .our
        .as_ref()
        .or(conflict.their.as_ref())
        .or(conflict.ancestor.as_ref())
        .map(|entry| index_entry_path(entry) == relative_path)
        .unwrap_or(false)
}

fn stage_repo_relative_path(repo: &Repository, relative_path: &Path) -> Result<()> {
    let root = repo_root(repo)?;
    let output = run_git_command(
        &root,
        &[
            "add".to_string(),
            "--".to_string(),
            relative_path.to_string_lossy().to_string(),
        ],
    )?;

    if !output.success {
        let details = command_output_text(&output);
        return Err(BackendError::Git {
            message: if details.is_empty() {
                format!("git add failed (exit code: {:?})", output.code)
            } else {
                details
            },
        });
    }

    Ok(())
}

pub(crate) fn start_merge_resolution_repo(
    repo: &Repository,
    branch_name: &str,
    into_branch: &str,
) -> Result<GitStartMergeResolutionDto> {
    validate_branch_name(branch_name)?;
    validate_branch_name(into_branch)?;
    resolve_commit(repo, branch_name)?;
    resolve_commit(repo, into_branch)?;

    if is_merge_in_progress(repo) || repo.index().map(|idx| idx.has_conflicts()).unwrap_or(false) {
        return Ok(GitStartMergeResolutionDto {
            status: "conflicted".to_string(),
            conflict_files: collect_command_conflict_files(&repo_root(repo)?),
            output: "Merge already in progress.".to_string(),
        });
    }

    ensure_clean(repo)?;

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
    let details = command_output_text(&output);

    if output.success {
        if let Some(original_branch) = original_branch.as_deref() {
            if original_branch != into_branch {
                checkout_repo(repo, original_branch, false)?;
            }
        }

        return Ok(GitStartMergeResolutionDto {
            status: "merged".to_string(),
            conflict_files: Vec::new(),
            output: if details.is_empty() {
                format!("Merged {} into {}", branch_name, into_branch)
            } else {
                details
            },
        });
    }

    let mut conflict_files = collect_command_conflict_files(&root)
        .into_iter()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    conflict_files.sort();

    if conflict_files.is_empty() && !is_merge_in_progress(repo) {
        if let Some(original_branch) = original_branch.as_deref() {
            if original_branch != into_branch {
                let _ = checkout_repo(repo, original_branch, false);
            }
        }

        return Err(BackendError::Git {
            message: if details.is_empty() {
                format!("git merge failed (exit code: {:?})", output.code)
            } else {
                details
            },
        });
    }

    Ok(GitStartMergeResolutionDto {
        status: "conflicted".to_string(),
        conflict_files,
        output: if details.is_empty() {
            "Merge stopped with file conflicts.".to_string()
        } else {
            details
        },
    })
}

fn cleanup_temp_worktree(root: &Path, worktree_path: &Path) {
    let remove_output = run_git_command(
        root,
        &[
            "worktree".to_string(),
            "remove".to_string(),
            "--force".to_string(),
            worktree_path.to_string_lossy().to_string(),
        ],
    );

    if remove_output.map(|output| output.success).unwrap_or(false) {
        return;
    }

    let _ = fs::remove_dir_all(worktree_path);
    let _ = run_git_command(root, &["worktree".to_string(), "prune".to_string()]);
}

pub(crate) fn build_git_rebase_check(
    repo: &Repository,
    branch_name: &str,
    onto_branch: &str,
) -> Result<GitRebaseCheckDto> {
    validate_branch_name(branch_name)?;
    validate_branch_name(onto_branch)?;
    resolve_commit(repo, branch_name)?;
    resolve_commit(repo, onto_branch)?;

    let root = repo_root(repo)?;
    let temp_root = std::env::temp_dir().join("macro-rebase-checks");
    fs::create_dir_all(&temp_root)?;
    let unique_id = REBASE_CHECK_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp_path = temp_root.join(format!(
        "rebase-check-{}-{}-{}-{}",
        sanitize_temp_segment(branch_name),
        std::process::id(),
        Utc::now().timestamp_micros(),
        unique_id
    ));

    let add_output = run_git_command(
        &root,
        &[
            "worktree".to_string(),
            "add".to_string(),
            "--detach".to_string(),
            temp_path.to_string_lossy().to_string(),
            branch_name.to_string(),
        ],
    )?;
    if !add_output.success {
        let details = command_output_text(&add_output);
        return Err(BackendError::Git {
            message: if details.is_empty() {
                format!("git worktree add failed (exit code: {:?})", add_output.code)
            } else {
                details
            },
        });
    }

    let rebase_output =
        match run_git_command(&temp_path, &["rebase".to_string(), onto_branch.to_string()]) {
            Ok(output) => output,
            Err(error) => {
                cleanup_temp_worktree(&root, &temp_path);
                return Err(error);
            }
        };
    let conflict_files = if rebase_output.success {
        Vec::new()
    } else {
        collect_command_conflict_files(&temp_path)
    };
    let output = command_output_text(&rebase_output);
    cleanup_temp_worktree(&root, &temp_path);

    let mut conflict_files = conflict_files
        .into_iter()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    conflict_files.sort();

    Ok(GitRebaseCheckDto {
        rebaseable: rebase_output.success,
        conflict_files,
        output,
    })
}

fn find_worktree_path_for_branch(root: &Path, branch_name: &str) -> Result<Option<PathBuf>> {
    let output = run_git_command(
        root,
        &[
            "worktree".to_string(),
            "list".to_string(),
            "--porcelain".to_string(),
        ],
    )?;
    if !output.success {
        let details = command_output_text(&output);
        return Err(BackendError::Git {
            message: if details.is_empty() {
                format!("git worktree list failed (exit code: {:?})", output.code)
            } else {
                details
            },
        });
    }

    let wanted = format!("refs/heads/{}", branch_name);
    let mut current_path: Option<PathBuf> = None;
    for line in output.stdout.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            current_path = Some(PathBuf::from(path.trim()));
            continue;
        }

        if line.trim() == format!("branch {}", wanted) {
            return Ok(current_path);
        }

        if line.trim().is_empty() {
            current_path = None;
        }
    }

    Ok(None)
}

pub(crate) fn fast_forward_repo(
    repo: &Repository,
    source_branch: &str,
    target_branch: &str,
) -> Result<String> {
    ensure_clean(repo)?;
    validate_branch_name(source_branch)?;
    validate_branch_name(target_branch)?;
    resolve_commit(repo, source_branch)?;
    resolve_commit(repo, target_branch)?;

    let original_branch = get_branch_name(repo)?;
    if original_branch.as_deref() != Some(target_branch) {
        checkout_repo(repo, target_branch, false)?;
    }

    let root = repo_root(repo)?;
    let output = run_git_command(
        &root,
        &[
            "merge".to_string(),
            "--ff-only".to_string(),
            source_branch.to_string(),
        ],
    )?;

    if let Some(original_branch) = original_branch.as_deref() {
        if original_branch != target_branch {
            let _ = checkout_repo(repo, original_branch, false);
        }
    }

    if !output.success {
        let details = command_output_text(&output);
        return Err(BackendError::GitConflict {
            message: if details.is_empty() {
                format!("git merge --ff-only failed (exit code: {:?})", output.code)
            } else {
                details
            },
        });
    }

    let details = command_output_text(&output);
    if details.is_empty() {
        Ok(format!(
            "Fast-forwarded {} to {}",
            target_branch, source_branch
        ))
    } else {
        Ok(details)
    }
}

pub(crate) fn rebase_branch_repo(
    repo: &Repository,
    branch_name: &str,
    onto_branch: &str,
    confirm: Option<bool>,
) -> Result<String> {
    if !confirm.unwrap_or(false) {
        return Err(BackendError::Git {
            message: "Rebase requires confirm=true".to_string(),
        });
    }

    ensure_clean(repo)?;
    validate_branch_name(branch_name)?;
    validate_branch_name(onto_branch)?;
    resolve_commit(repo, branch_name)?;
    resolve_commit(repo, onto_branch)?;

    let root = repo_root(repo)?;
    let branch_worktree = find_worktree_path_for_branch(&root, branch_name)?;
    let original_branch = get_branch_name(repo)?;
    let command_root = if let Some(path) = branch_worktree {
        let worktree_repo = Repository::open(&path).map_err(|e| BackendError::Git {
            message: format!(
                "Failed to open branch worktree at {}: {}",
                path.display(),
                e
            ),
        })?;
        ensure_clean(&worktree_repo)?;
        path
    } else {
        if original_branch.as_deref() != Some(branch_name) {
            checkout_repo(repo, branch_name, false)?;
        }
        root.clone()
    };

    let output = run_git_command(
        &command_root,
        &["rebase".to_string(), onto_branch.to_string()],
    )?;

    if !output.success {
        let conflict_files = collect_command_conflict_files(&command_root);
        let _ = run_git_command(
            &command_root,
            &["rebase".to_string(), "--abort".to_string()],
        );
        if command_root == root {
            if let Some(original_branch) = original_branch.as_deref() {
                if original_branch != branch_name {
                    let _ = checkout_repo(repo, original_branch, false);
                }
            }
        }
        let details = command_output_text(&output);
        let conflict_suffix = if conflict_files.is_empty() {
            String::new()
        } else {
            format!(" Conflicts: {}", conflict_files.join(", "))
        };
        return Err(BackendError::GitMergeConflict {
            message: if details.is_empty() {
                format!(
                    "git rebase failed (exit code: {:?}).{}",
                    output.code, conflict_suffix
                )
            } else {
                format!("{}{}", details, conflict_suffix)
            },
        });
    }

    if command_root == root {
        if let Some(original_branch) = original_branch.as_deref() {
            if original_branch != branch_name {
                checkout_repo(repo, original_branch, false)?;
            }
        }
    }

    let details = command_output_text(&output);
    if details.is_empty() {
        Ok(format!("Rebased {} onto {}", branch_name, onto_branch))
    } else {
        Ok(details)
    }
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

enum DiffTextSink {
    Full(String),
    Bounded(super::tool_output::BoundedTextCollector),
}

impl DiffTextSink {
    fn new(max_bytes: Option<usize>) -> Self {
        match max_bytes {
            Some(max_bytes) => {
                Self::Bounded(super::tool_output::BoundedTextCollector::new(max_bytes))
            }
            None => Self::Full(String::new()),
        }
    }

    fn push_str(&mut self, value: &str) {
        match self {
            Self::Full(output) => output.push_str(value),
            Self::Bounded(output) => output.push_str(value),
        }
    }

    fn finish(self, require_complete: bool) -> Result<String> {
        match self {
            Self::Full(output) => Ok(output),
            Self::Bounded(output) => {
                let output = output.finish("GIT DIFF");
                if require_complete && output.truncated {
                    return Err(BackendError::Git {
                        message: format!(
                            "Git diff output requires {} bytes and exceeds the inline limit of {} retained bytes. Narrow paths, use mode=stat or mode=name_only, or retry without require_complete.",
                            output.total_bytes, output.retained_bytes
                        ),
                    });
                }
                Ok(output.text)
            }
        }
    }
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
        .show_untracked_content(true)
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

    let mut output = DiffTextSink::new(options.max_bytes);
    let mut render_diff = |diff: &git2::Diff<'_>| -> Result<()> {
        match options.mode {
            GitDiffMode::Patch => {
                diff.print(
                    DiffFormat::Patch,
                    |_delta: git2::DiffDelta<'_>,
                     _hunk: Option<git2::DiffHunk<'_>>,
                     line: git2::DiffLine<'_>| {
                        let origin = line.origin();
                        if matches!(origin, '+' | '-' | ' ') {
                            output.push_str(&origin.to_string());
                        }
                        output.push_str(std::str::from_utf8(line.content()).unwrap_or(""));
                        true
                    },
                )?;
            }
            GitDiffMode::Stat => {
                let stats = diff.stats()?;
                let buffer = stats.to_buf(DiffStatsFormat::FULL, 80)?;
                output.push_str(std::str::from_utf8(buffer.as_ref()).unwrap_or(""));
            }
            GitDiffMode::NameOnly => {
                let mut previous_path = None;
                for path in diff
                    .deltas()
                    .filter_map(|delta| delta.new_file().path().or_else(|| delta.old_file().path()))
                    .map(|path| path.to_string_lossy().replace('\\', "/"))
                {
                    if previous_path.as_deref() == Some(path.as_str()) {
                        continue;
                    }
                    output.push_str(&path);
                    output.push_str("\n");
                    previous_path = Some(path);
                }
            }
        }
        Ok(())
    };

    if let Some(head) = head {
        let head_commit = resolve_commit(repo, head)?;
        let head_tree = head_commit.tree()?;
        let diff = repo.diff_tree_to_tree(base_tree.as_ref(), Some(&head_tree), Some(&mut opts))?;
        render_diff(&diff)?;
    } else {
        let diff = repo.diff_tree_to_workdir_with_index(base_tree.as_ref(), Some(&mut opts))?;
        render_diff(&diff)?;
    }

    output.finish(options.require_complete)
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
    let mut index = repo.index()?;
    index.read(true)?;
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
            message: format!(
                "Failed to read worktree file {:?}: {}",
                absolute_path, error
            ),
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

pub(crate) fn read_git_conflict_file(
    repo: &Repository,
    repo_root: &Path,
    relative_path: &Path,
) -> Result<GitConflictFileDto> {
    let mut index = repo.index()?;
    index.read(true)?;
    let conflicts = index.conflicts().map_err(|e| BackendError::Git {
        message: e.to_string(),
    })?;

    for conflict in conflicts {
        let conflict = conflict.map_err(|e| BackendError::Git {
            message: e.to_string(),
        })?;
        if !conflict_matches_path(&conflict, relative_path) {
            continue;
        }

        let (base, base_binary, base_too_large) =
            read_conflict_entry_side(repo, conflict.ancestor.as_ref())?;
        let (ours, ours_binary, ours_too_large) =
            read_conflict_entry_side(repo, conflict.our.as_ref())?;
        let (theirs, theirs_binary, theirs_too_large) =
            read_conflict_entry_side(repo, conflict.their.as_ref())?;
        let (worktree, worktree_binary, worktree_too_large) =
            read_worktree_conflict_side(repo_root, relative_path)?;

        return Ok(GitConflictFileDto {
            path: relative_path.to_string_lossy().to_string(),
            base,
            ours,
            theirs,
            worktree,
            is_binary: base_binary || ours_binary || theirs_binary || worktree_binary,
            too_large: base_too_large || ours_too_large || theirs_too_large || worktree_too_large,
        });
    }

    Err(BackendError::Git {
        message: format!(
            "No unresolved conflict found for {}",
            relative_path.to_string_lossy()
        ),
    })
}

pub(crate) fn write_git_conflict_resolution(
    repo: &Repository,
    repo_root: &Path,
    relative_path: &Path,
    content: &str,
    stage: bool,
) -> Result<()> {
    let absolute_path = repo_root.join(relative_path);
    if let Some(parent) = absolute_path.parent() {
        fs::create_dir_all(parent).map_err(|error| BackendError::Io {
            message: format!("Failed to create parent directory {:?}: {}", parent, error),
            source: error,
        })?;
    }

    fs::write(&absolute_path, content).map_err(|error| BackendError::Io {
        message: format!(
            "Failed to write conflict resolution {:?}: {}",
            absolute_path, error
        ),
        source: error,
    })?;

    if stage {
        stage_repo_relative_path(repo, relative_path)?;
    }

    Ok(())
}

pub(crate) fn accept_git_conflict_side(
    repo: &Repository,
    repo_root: &Path,
    relative_path: &Path,
    side: &str,
) -> Result<()> {
    let conflict_file = read_git_conflict_file(repo, repo_root, relative_path)?;
    let selected = match side {
        "ours" => conflict_file.ours,
        "theirs" => conflict_file.theirs,
        other => {
            return Err(BackendError::Validation(format!(
                "Invalid conflict side: {}",
                other
            )))
        }
    };
    let absolute_path = repo_root.join(relative_path);

    if selected.exists {
        write_git_conflict_resolution(repo, repo_root, relative_path, &selected.content, true)?;
    } else {
        match fs::remove_file(&absolute_path) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(BackendError::Io {
                    message: format!(
                        "Failed to remove conflict file {:?}: {}",
                        absolute_path, error
                    ),
                    source: error,
                })
            }
        }
        stage_repo_relative_path(repo, relative_path)?;
    }

    Ok(())
}

pub(crate) fn complete_merge_repo(repo: &Repository) -> Result<String> {
    if !is_merge_in_progress(repo) {
        return Err(BackendError::Git {
            message: "No merge in progress".to_string(),
        });
    }

    let mut index = repo.index()?;
    index.read(true)?;
    if index.has_conflicts() {
        let conflict_files = collect_index_conflict_paths(&index)?;
        return Err(BackendError::GitMergeConflict {
            message: if conflict_files.is_empty() {
                "Resolve all conflicts before completing the merge.".to_string()
            } else {
                format!(
                    "Resolve all conflicts before completing the merge: {}",
                    conflict_files.join(", ")
                )
            },
        });
    }

    let root = repo_root(repo)?;
    let output = run_git_command(
        &root,
        &[
            "-c".to_string(),
            "user.name=Macro".to_string(),
            "-c".to_string(),
            "user.email=macro@local".to_string(),
            "commit".to_string(),
            "--no-edit".to_string(),
        ],
    )?;
    let details = command_output_text(&output);
    if !output.success {
        return Err(BackendError::Git {
            message: if details.is_empty() {
                format!("git commit --no-edit failed (exit code: {:?})", output.code)
            } else {
                details
            },
        });
    }

    if details.is_empty() {
        Ok("Merge completed.".to_string())
    } else {
        Ok(details)
    }
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

pub(crate) fn build_git_tree_tool_page(
    repo: &Repository,
    branch: Option<&str>,
    offset: usize,
    limit: usize,
) -> Result<GitTreeToolPage> {
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
    let mut position = 0usize;
    let mut structure = Vec::with_capacity(limit.saturating_add(1));
    tree.walk(TreeWalkMode::PreOrder, |root, entry| {
        let Ok(name) = entry.name() else {
            return TreeWalkResult::Ok;
        };
        let node_type = match entry.kind() {
            Some(git2::ObjectType::Blob) => "file",
            Some(git2::ObjectType::Commit) => "directory",
            _ => return TreeWalkResult::Ok,
        };
        if position < offset {
            position += 1;
            return TreeWalkResult::Ok;
        }
        if structure.len() > limit {
            return TreeWalkResult::Abort;
        }
        let path = format!("{}{}", root, name);
        structure.push(GitNode {
            name: name.to_string(),
            status: None,
            path,
            node_type: node_type.to_string(),
            children: None,
            hash: Some(entry.id().to_string()),
        });
        position += 1;
        TreeWalkResult::Ok
    })?;
    let mut status_options = get_status_options();
    status_options.sort_case_sensitively(true);
    let statuses = repo.statuses(Some(&mut status_options))?;
    let submodule_statuses = build_submodule_status_map(repo)?;
    let revision = git_tree_revision_from_statuses(commit.id(), &statuses, &submodule_statuses);
    let mut modified_files_count = 0u32;
    let page_paths = structure
        .iter()
        .map(|node| node.path.clone())
        .collect::<HashSet<_>>();
    let mut page_statuses = HashMap::with_capacity(page_paths.len());
    for entry in statuses.iter() {
        let status = entry.status();
        let Some(label) = tree_status_label(status) else {
            continue;
        };
        let (_, path) = status_entry_paths(&entry);
        let Some(path) = path else {
            continue;
        };
        modified_files_count = modified_files_count.saturating_add(1);
        if page_paths.contains(&path) {
            page_statuses.insert(path, label.to_string());
            continue;
        }
        if tree.get_path(Path::new(&path)).is_ok() {
            continue;
        }
        if position >= offset && structure.len() <= limit {
            let name = path.rsplit('/').next().unwrap_or(path.as_str()).to_string();
            structure.push(GitNode {
                name,
                path,
                node_type: "file".to_string(),
                status: Some(label.to_string()),
                children: None,
                hash: None,
            });
        }
        position = position.saturating_add(1);
    }
    for (path, label) in &submodule_statuses {
        let already_counted = statuses
            .iter()
            .any(|entry| entry.path_bytes() == path.as_bytes());
        if !already_counted {
            modified_files_count = modified_files_count.saturating_add(1);
        }
        if page_paths.contains(path) {
            page_statuses
                .entry(path.clone())
                .or_insert_with(|| label.clone());
        }
    }
    for node in &mut structure {
        if node.status.is_none() {
            node.status = page_statuses.remove(&node.path);
        }
    }
    let has_more = structure.len() > limit;
    structure.truncate(limit);
    Ok(GitTreeToolPage {
        branch: branch_name,
        structure,
        modified_files_count,
        has_more,
        revision,
    })
}

fn tree_status_label(status: Status) -> Option<&'static str> {
    if status.is_conflicted() {
        Some("conflicted")
    } else if status.is_wt_new() || status.is_index_new() {
        Some("added")
    } else if status.is_wt_deleted() || status.is_index_deleted() {
        Some("deleted")
    } else if status.is_wt_renamed() || status.is_index_renamed() {
        Some("renamed")
    } else if status.is_wt_modified()
        || status.is_index_modified()
        || status.is_wt_typechange()
        || status.is_index_typechange()
    {
        Some("modified")
    } else {
        None
    }
}

fn git_tree_revision_from_statuses(
    commit_id: Oid,
    statuses: &git2::Statuses<'_>,
    submodule_statuses: &HashMap<String, String>,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(commit_id.as_bytes());
    for entry in statuses.iter() {
        hasher.update(entry.status().bits().to_le_bytes());
        hasher.update(entry.path_bytes());
        hasher.update([0]);
    }
    let mut submodules = submodule_statuses.iter().collect::<Vec<_>>();
    submodules.sort_unstable_by(|left, right| left.0.cmp(right.0));
    for (path, status) in submodules {
        hasher.update(path.as_bytes());
        hasher.update([0]);
        hasher.update(status.as_bytes());
        hasher.update([0]);
    }
    format!("{}:{:x}", commit_id, hasher.finalize())
}

pub(crate) fn git_tree_revision(repo: &Repository, branch: Option<&str>) -> Result<String> {
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
    let mut status_options = get_status_options();
    status_options.sort_case_sensitively(true);
    let statuses = repo.statuses(Some(&mut status_options))?;
    let submodule_statuses = build_submodule_status_map(repo)?;
    Ok(git_tree_revision_from_statuses(
        commit.id(),
        &statuses,
        &submodule_statuses,
    ))
}

#[tauri::command]
/// Get the status of a Git repository.
pub async fn git_status(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
) -> Result<GitStatusDto> {
    if let Some(wsl_repo_path) = parse_wsl_repo_path(&repo_path) {
        return build_wsl_git_status(&wsl_repo_path).await;
    }

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
    offset: Option<u32>,
    branch: Option<String>,
) -> Result<Vec<GitCommitDto>> {
    if let Some(wsl_repo_path) = parse_wsl_repo_path(&repo_path) {
        let limit = limit.map(|v| v as usize).unwrap_or(DEFAULT_LOG_LIMIT);
        return if let Some(offset) = offset {
            let snapshot = build_wsl_git_log_snapshot(&wsl_repo_path, branch.as_deref()).await?;
            build_wsl_git_log_page(&wsl_repo_path, offset as usize, limit, &snapshot).await
        } else {
            build_wsl_git_log(&wsl_repo_path, limit, branch.as_deref()).await
        };
    }

    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();
    let limit = limit.map(|v| v as usize).unwrap_or(DEFAULT_LOG_LIMIT);

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        if let Some(offset) = offset {
            let snapshot = build_git_log_snapshot(&repo, branch.as_deref())?;
            build_git_log_page(&repo, offset as usize, limit, &snapshot)
        } else {
            build_git_log(&repo, limit, branch.as_deref())
        }
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Get one commit-history page and the exact snapshot revision used to build it.
pub async fn git_log_page(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    limit: Option<u32>,
    offset: Option<u32>,
    branch: Option<String>,
) -> Result<GitLogPageDto> {
    let limit = limit
        .map(|value| value as usize)
        .unwrap_or(DEFAULT_LOG_LIMIT);
    let offset = offset.unwrap_or(0) as usize;
    if let Some(wsl_repo_path) = parse_wsl_repo_path(&repo_path) {
        let snapshot = build_wsl_git_log_snapshot(&wsl_repo_path, branch.as_deref()).await?;
        let commits = build_wsl_git_log_page(&wsl_repo_path, offset, limit, &snapshot).await?;
        return Ok(GitLogPageDto {
            commits,
            revision: snapshot.revision,
        });
    }

    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;
        let snapshot = build_git_log_snapshot(&repo, branch.as_deref())?;
        let commits = build_git_log_page(&repo, offset, limit, &snapshot)?;
        Ok(GitLogPageDto {
            commits,
            revision: snapshot.revision,
        })
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
    if let Some(wsl_repo_path) = parse_wsl_repo_path(&repo_path) {
        return build_wsl_git_branches(&wsl_repo_path).await;
    }

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
    if let Some(wsl_repo_path) = parse_wsl_repo_path(&repo_path) {
        return wsl_git_branch_create(&wsl_repo_path, &branch_name, &from_ref).await;
    }

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
    if let Some(wsl_repo_path) = parse_wsl_repo_path(&repo_path) {
        return wsl_git_branch_delete(&wsl_repo_path, &branch_name, force.unwrap_or(false)).await;
    }

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
    if let Some(wsl_repo_path) = parse_wsl_repo_path(&repo_path) {
        validate_branch_name(&branch_name)?;
        let remote_name = remote
            .unwrap_or_else(|| DEFAULT_REMOTE_NAME.to_string())
            .trim()
            .to_string();
        validate_remote_name(&remote_name)?;
        run_wsl_git_checked(
            &wsl_repo_path,
            &[
                "push".to_string(),
                remote_name,
                "--delete".to_string(),
                branch_name,
            ],
            WSL_GIT_MUTATION_TIMEOUT,
            "git push --delete WSL failed",
        )
        .await?;
        return Ok(());
    }

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
    if let Some(wsl_repo_path) = parse_wsl_repo_path(&repo_path) {
        return wsl_git_checkout(&wsl_repo_path, &branch_or_commit, create).await;
    }

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
    if parse_wsl_repo_path(&repo_path).is_some() {
        return Err(unsupported_wsl_git_operation("git_merge_check"));
    }

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
    if let Some(wsl_repo_path) = parse_wsl_repo_path(&repo_path) {
        return wsl_git_merge(&wsl_repo_path, &branch_name, &into_branch).await;
    }

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
/// Start a real merge so users can resolve materialized file conflicts manually.
pub async fn git_start_merge_resolution(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    branch_name: String,
    into_branch: String,
) -> Result<GitStartMergeResolutionDto> {
    if parse_wsl_repo_path(&repo_path).is_some() {
        return Err(unsupported_wsl_git_operation("git_start_merge_resolution"));
    }

    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        start_merge_resolution_repo(&repo, &branch_name, &into_branch)
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Fast-forward one local branch to another branch after a clean preflight.
pub async fn git_fast_forward(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    source_branch: String,
    target_branch: String,
) -> Result<String> {
    if parse_wsl_repo_path(&repo_path).is_some() {
        return Err(unsupported_wsl_git_operation("git_fast_forward"));
    }

    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        fast_forward_repo(&repo, &source_branch, &target_branch)
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Check whether a branch can be rebased onto another branch in a disposable worktree.
pub async fn git_rebase_check(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    branch_name: String,
    onto_branch: String,
) -> Result<GitRebaseCheckDto> {
    if parse_wsl_repo_path(&repo_path).is_some() {
        return Err(unsupported_wsl_git_operation("git_rebase_check"));
    }

    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        build_git_rebase_check(&repo, &branch_name, &onto_branch)
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Rebase a local branch onto another branch after explicit confirmation.
pub async fn git_rebase_branch(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    branch_name: String,
    onto_branch: String,
    confirm: Option<bool>,
) -> Result<String> {
    if parse_wsl_repo_path(&repo_path).is_some() {
        return Err(unsupported_wsl_git_operation("git_rebase_branch"));
    }

    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        rebase_branch_repo(&repo, &branch_name, &onto_branch, confirm)
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
    if let Some(wsl_repo_path) = parse_wsl_repo_path(&repo_path) {
        return wsl_git_commit(&wsl_repo_path, &message, stage_all).await;
    }

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
    if let Some(wsl_repo_path) = parse_wsl_repo_path(&repo_path) {
        return wsl_git_add(&wsl_repo_path, &paths).await;
    }

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
    if let Some(wsl_repo_path) = parse_wsl_repo_path(&repo_path) {
        return wsl_git_restore_paths(
            &wsl_repo_path,
            &paths,
            RestoreTarget::from_option(target.as_deref())?,
        )
        .await;
    }

    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        restore_paths(
            &repo,
            &paths,
            RestoreTarget::from_option(target.as_deref())?,
        )
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
    if let Some(wsl_repo_path) = parse_wsl_repo_path(&repo_path) {
        return wsl_git_reset(&wsl_repo_path, &mode, commit, confirm).await;
    }

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
/// Abort the in-progress merge in the Git repository.
pub async fn git_abort_merge(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    confirm: Option<bool>,
) -> Result<()> {
    if parse_wsl_repo_path(&repo_path).is_some() {
        return Err(unsupported_wsl_git_operation("git_abort_merge"));
    }

    if !confirm.unwrap_or(false) {
        return Err(BackendError::Git {
            message: "Abort merge requires confirm=true".to_string(),
        });
    }

    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        abort_merge_with_confirmation(&repo, confirm)
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
    if let Some(wsl_repo_path) = parse_wsl_repo_path(&repo_path) {
        return wsl_git_stash(&wsl_repo_path, message).await;
    }

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
    mode: Option<String>,
    max_bytes: Option<u32>,
    require_complete: Option<bool>,
) -> Result<String> {
    let mode = GitDiffMode::parse(mode.as_deref())?;
    let max_bytes = max_bytes.map(|value| {
        (value as usize)
            .max(1)
            .min(super::tool_output::GIT_DIFF_MAX_BYTES)
    });
    let require_complete = require_complete.unwrap_or(false);
    if let Some(wsl_repo_path) = parse_wsl_repo_path(&repo_path) {
        return wsl_git_diff(
            &wsl_repo_path,
            base.as_deref(),
            head.as_deref(),
            DiffRequestOptions {
                context_lines,
                ignore_whitespace: ignore_whitespace.unwrap_or(false),
                paths,
                mode,
                max_bytes,
                require_complete,
            },
        )
        .await;
    }

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
                mode,
                max_bytes,
                require_complete,
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
    if parse_wsl_repo_path(&repo_path).is_some() {
        return Err(unsupported_wsl_git_operation("git_read_file_pair"));
    }

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
/// Build a lightweight review snapshot for the current repository state.
pub async fn git_review_snapshot(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
) -> Result<GitReviewSnapshotDto> {
    if parse_wsl_repo_path(&repo_path).is_some() {
        return Err(unsupported_wsl_git_operation("git_review_snapshot"));
    }

    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        review::build_git_review_snapshot(&repo, &validated)
    })
    .await
    .map_err(to_join_error)?
}

const DIRECT_CHECKPOINTS_DIR: &str = "direct-checkpoints";
const DIRECT_CHECKPOINT_EXCLUDES: &str = "\
.git/\n\
.macro/\n\
node_modules/\n\
vendor/\n\
.pnpm/\n\
dist/\n\
build/\n\
coverage/\n\
.env\n\
.env.*\n\
*.pem\n\
*.key\n";

fn direct_checkpoint_key(task_id: &str, project_path: &Path) -> String {
    direct_checkpoint_id(task_id, project_path)
}

#[cfg(test)]
fn direct_checkpoint_path(app_data_dir: &Path, task_id: &str, project_path: &Path) -> PathBuf {
    app_data_dir
        .join(DIRECT_CHECKPOINTS_DIR)
        .join(direct_checkpoint_key(task_id, project_path))
}

fn validate_direct_checkpoint_id(checkpoint_id: &str) -> Result<&str> {
    let (prefix, hash) = checkpoint_id.rsplit_once('-').ok_or_else(|| {
        BackendError::Validation("Invalid direct checkpoint identifier.".to_string())
    })?;
    if prefix.is_empty()
        || checkpoint_id.len() > 256
        || !prefix.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
        || hash.len() != 16
        || !hash.chars().all(|character| character.is_ascii_hexdigit())
    {
        return Err(BackendError::Validation(
            "Invalid direct checkpoint identifier.".to_string(),
        ));
    }
    Ok(checkpoint_id)
}

fn validate_direct_checkpoint_owner<'a>(checkpoint_id: &'a str, task_id: &str) -> Result<&'a str> {
    let checkpoint_id = validate_direct_checkpoint_id(checkpoint_id)?;
    let (owner, _) = checkpoint_id.rsplit_once('-').ok_or_else(|| {
        BackendError::Validation("Invalid direct checkpoint identifier.".to_string())
    })?;
    if owner != sanitize_temp_segment(task_id) {
        return Err(BackendError::Validation(
            "Direct checkpoint does not belong to this task.".to_string(),
        ));
    }
    Ok(checkpoint_id)
}

fn direct_checkpoint_metadata_is_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    false
}

fn resolve_direct_checkpoint_root(
    app_data_dir: &Path,
    create: bool,
) -> Result<Option<(PathBuf, PathBuf)>> {
    let canonical_app_data = app_data_dir
        .canonicalize()
        .map_err(|error| BackendError::Io {
            message: format!(
                "Failed to resolve Macro application data directory: {}",
                error
            ),
            source: error,
        })?;
    let checkpoint_root = app_data_dir.join(DIRECT_CHECKPOINTS_DIR);
    match fs::symlink_metadata(&checkpoint_root) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !create => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&checkpoint_root).map_err(|error| BackendError::Io {
                message: format!("Failed to create direct checkpoint root: {}", error),
                source: error,
            })?;
        }
        Err(error) => {
            return Err(BackendError::Io {
                message: format!("Failed to inspect direct checkpoint root: {}", error),
                source: error,
            })
        }
    }
    let root_metadata =
        fs::symlink_metadata(&checkpoint_root).map_err(|error| BackendError::Io {
            message: format!("Failed to inspect direct checkpoint root: {}", error),
            source: error,
        })?;
    if direct_checkpoint_metadata_is_link(&root_metadata) || !root_metadata.is_dir() {
        return Err(BackendError::Validation(
            "Direct checkpoint root is not a managed directory.".to_string(),
        ));
    }
    let canonical_root = checkpoint_root
        .canonicalize()
        .map_err(|error| BackendError::Io {
            message: format!("Failed to resolve direct checkpoint root: {}", error),
            source: error,
        })?;
    if canonical_root != canonical_app_data.join(DIRECT_CHECKPOINTS_DIR) {
        return Err(BackendError::Validation(
            "Direct checkpoint root escapes the Macro application data directory.".to_string(),
        ));
    }
    Ok(Some((checkpoint_root, canonical_root)))
}

fn resolve_direct_checkpoint_path(
    checkpoint_root: &Path,
    canonical_root: &Path,
    checkpoint_id: &str,
    create: bool,
) -> Result<Option<(PathBuf, bool)>> {
    let checkpoint_path = checkpoint_root.join(checkpoint_id);
    let created = match fs::symlink_metadata(&checkpoint_path) {
        Ok(_) => false,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !create => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&checkpoint_path).map_err(|error| BackendError::Io {
                message: format!(
                    "Failed to create direct checkpoint directory {}: {}",
                    checkpoint_path.display(),
                    error
                ),
                source: error,
            })?;
            true
        }
        Err(error) => {
            return Err(BackendError::Io {
                message: format!("Failed to inspect direct checkpoint: {}", error),
                source: error,
            })
        }
    };
    let metadata = fs::symlink_metadata(&checkpoint_path).map_err(|error| BackendError::Io {
        message: format!("Failed to inspect direct checkpoint: {}", error),
        source: error,
    })?;
    if direct_checkpoint_metadata_is_link(&metadata) || !metadata.is_dir() {
        return Err(BackendError::Validation(format!(
            "Direct checkpoint path is not a managed directory: {}",
            checkpoint_path.display()
        )));
    }
    let canonical_checkpoint =
        checkpoint_path
            .canonicalize()
            .map_err(|error| BackendError::Io {
                message: format!("Failed to resolve direct checkpoint: {}", error),
                source: error,
            })?;
    if canonical_checkpoint.parent() != Some(canonical_root) {
        return Err(BackendError::Validation(
            "Direct checkpoint path escapes its managed root.".to_string(),
        ));
    }
    Ok(Some((canonical_checkpoint, created)))
}

fn open_direct_checkpoint(
    app: &AppHandle,
    task_id: &str,
    project_path: &Path,
    checkpoint_id: Option<&str>,
    create: bool,
) -> Result<Repository> {
    if task_id.trim().is_empty() {
        return Err(BackendError::Validation(
            "Direct checkpoint requires a task id.".to_string(),
        ));
    }

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| BackendError::Filesystem {
            message: format!(
                "Failed to resolve Macro application data directory: {}",
                error
            ),
        })?;
    let has_persisted_checkpoint_id = checkpoint_id.is_some();
    let checkpoint_id = match checkpoint_id {
        Some(checkpoint_id) => {
            let checkpoint_id = validate_direct_checkpoint_owner(checkpoint_id, task_id)?;
            checkpoint_id.to_string()
        }
        None => direct_checkpoint_key(task_id, project_path),
    };
    let Some((checkpoint_root, canonical_root)) =
        resolve_direct_checkpoint_root(&app_data_dir, create)?
    else {
        return Err(BackendError::FilesystemNotFound {
            message: format!("Direct checkpoint for task {} does not exist", task_id),
        });
    };
    let Some((checkpoint_path, checkpoint_created)) =
        resolve_direct_checkpoint_path(&checkpoint_root, &canonical_root, &checkpoint_id, create)?
    else {
        return Err(BackendError::FilesystemNotFound {
            message: format!("Direct checkpoint for task {} does not exist", task_id),
        });
    };

    if checkpoint_created {
        let repo = Repository::init_bare(&checkpoint_path).map_err(|error| BackendError::Git {
            message: format!("Failed to initialize direct checkpoint: {}", error),
        })?;
        {
            let mut config = repo.config().map_err(|error| BackendError::Git {
                message: format!("Failed to configure direct checkpoint: {}", error),
            })?;
            config
                .set_bool("core.bare", false)
                .map_err(|error| BackendError::Git {
                    message: format!("Failed to configure direct checkpoint worktree: {}", error),
                })?;
            config
                .set_str("core.worktree", &project_path.to_string_lossy())
                .map_err(|error| BackendError::Git {
                    message: format!("Failed to configure direct checkpoint path: {}", error),
                })?;
        }
        let info_dir = checkpoint_path.join("info");
        fs::create_dir_all(&info_dir).map_err(|error| BackendError::Io {
            message: format!("Failed to create direct checkpoint exclusions: {}", error),
            source: error,
        })?;
        fs::write(info_dir.join("exclude"), DIRECT_CHECKPOINT_EXCLUDES).map_err(|error| {
            BackendError::Io {
                message: format!("Failed to write direct checkpoint exclusions: {}", error),
                source: error,
            }
        })?;
    }

    let mut repo = Repository::open(&checkpoint_path).map_err(|error| BackendError::Git {
        message: format!("Failed to open direct checkpoint: {}", error),
    })?;
    if has_persisted_checkpoint_id {
        {
            let mut config = repo.config().map_err(|error| BackendError::Git {
                message: format!("Failed to open direct checkpoint configuration: {}", error),
            })?;
            config
                .set_str("core.worktree", &project_path.to_string_lossy())
                .map_err(|error| BackendError::Git {
                    message: format!("Failed to update direct checkpoint path: {}", error),
                })?;
        }
        drop(repo);
        repo = Repository::open(&checkpoint_path).map_err(|error| BackendError::Git {
            message: format!("Failed to reopen direct checkpoint: {}", error),
        })?;
    }
    let configured_worktree =
        repo.workdir()
            .map(Path::to_path_buf)
            .ok_or_else(|| BackendError::Git {
                message: "Direct checkpoint has no configured worktree.".to_string(),
            })?;
    let expected = project_path
        .canonicalize()
        .map_err(|error| BackendError::Io {
            message: format!("Failed to resolve direct project path: {}", error),
            source: error,
        })?;
    let actual = configured_worktree
        .canonicalize()
        .map_err(|error| BackendError::Io {
            message: format!("Failed to resolve direct checkpoint worktree: {}", error),
            source: error,
        })?;
    if actual != expected {
        return Err(BackendError::Validation(
            "Direct checkpoint belongs to a different project path.".to_string(),
        ));
    }
    Ok(repo)
}

fn ensure_direct_checkpoint_head(repo: &Repository) -> Result<String> {
    if let Ok(head) = repo.head() {
        if let Some(target) = head.target() {
            return Ok(target.to_string());
        }
    }

    let mut index = repo.index().map_err(|error| BackendError::Git {
        message: format!("Failed to open direct checkpoint index: {}", error),
    })?;
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .map_err(|error| BackendError::Git {
            message: format!("Failed to capture direct checkpoint files: {}", error),
        })?;
    index.write().map_err(|error| BackendError::Git {
        message: format!("Failed to write direct checkpoint index: {}", error),
    })?;
    let tree_id = index.write_tree().map_err(|error| BackendError::Git {
        message: format!("Failed to write direct checkpoint tree: {}", error),
    })?;
    let tree = repo.find_tree(tree_id).map_err(|error| BackendError::Git {
        message: format!("Failed to load direct checkpoint tree: {}", error),
    })?;
    let signature =
        git2::Signature::now("Macro", "macro@local").map_err(|error| BackendError::Git {
            message: format!("Failed to create direct checkpoint signature: {}", error),
        })?;
    let oid = repo
        .commit(
            Some("HEAD"),
            &signature,
            &signature,
            "chore(checkpoint): capture direct workspace",
            &tree,
            &[],
        )
        .map_err(|error| BackendError::Git {
            message: format!("Failed to create direct checkpoint: {}", error),
        })?;
    Ok(oid.to_string())
}

fn open_validated_direct_checkpoint(
    app: &AppHandle,
    workspace: &Path,
    task_id: &str,
    project_path: &str,
    checkpoint_id: Option<&str>,
    create: bool,
) -> Result<(Repository, PathBuf)> {
    let validated = validate_repo_path(project_path, workspace)?;
    let repo = open_direct_checkpoint(app, task_id, &validated, checkpoint_id, create)?;
    Ok((repo, validated))
}

fn remove_direct_checkpoint(app_data_dir: &Path, checkpoint_id: &str) -> Result<bool> {
    let checkpoint_id = validate_direct_checkpoint_id(checkpoint_id)?;
    let Some((checkpoint_root, canonical_root)) =
        resolve_direct_checkpoint_root(app_data_dir, false)?
    else {
        return Ok(false);
    };
    let Some((canonical_checkpoint, _)) =
        resolve_direct_checkpoint_path(&checkpoint_root, &canonical_root, checkpoint_id, false)?
    else {
        return Ok(false);
    };
    fs::remove_dir_all(&canonical_checkpoint).map_err(|error| BackendError::Io {
        message: format!("Failed to remove direct checkpoint: {}", error),
        source: error,
    })?;
    Ok(true)
}

#[tauri::command]
pub async fn direct_checkpoint_resolve_id(
    workspace_root: State<'_, WorkspaceRoot>,
    task_id: String,
    project_path: String,
) -> Result<String> {
    let workspace = workspace_root.inner().read().await.clone();
    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&project_path, &workspace)?;
        if task_id.trim().is_empty() {
            return Err(BackendError::Validation(
                "Direct checkpoint requires a task id.".to_string(),
            ));
        }
        Ok(direct_checkpoint_key(&task_id, &validated))
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
pub async fn direct_checkpoint_remove(app: AppHandle, checkpoint_id: String) -> Result<bool> {
    tokio::task::spawn_blocking(move || {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| BackendError::Filesystem {
                message: format!(
                    "Failed to resolve Macro application data directory: {}",
                    error
                ),
            })?;
        remove_direct_checkpoint(&app_data_dir, &checkpoint_id)
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
pub async fn direct_checkpoint_ensure(
    app: AppHandle,
    workspace_root: State<'_, WorkspaceRoot>,
    task_id: String,
    project_path: String,
    checkpoint_id: Option<String>,
) -> Result<String> {
    let workspace = workspace_root.inner().read().await.clone();
    tokio::task::spawn_blocking(move || {
        let (repo, _) = open_validated_direct_checkpoint(
            &app,
            &workspace,
            &task_id,
            &project_path,
            checkpoint_id.as_deref(),
            true,
        )?;
        ensure_direct_checkpoint_head(&repo)
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
pub async fn direct_review_snapshot(
    app: AppHandle,
    workspace_root: State<'_, WorkspaceRoot>,
    task_id: String,
    project_path: String,
    checkpoint_id: Option<String>,
) -> Result<DirectReviewSnapshotDto> {
    let workspace = workspace_root.inner().read().await.clone();
    tokio::task::spawn_blocking(move || {
        let (repo, validated) = open_validated_direct_checkpoint(
            &app,
            &workspace,
            &task_id,
            &project_path,
            checkpoint_id.as_deref(),
            false,
        )?;
        let snapshot = review::build_git_review_snapshot(&repo, &validated)?;
        let has_accepted_changes = repo.head()?.peel_to_commit()?.parent_count() > 0;
        Ok(DirectReviewSnapshotDto {
            snapshot,
            has_accepted_changes,
        })
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
pub async fn direct_review_file(
    app: AppHandle,
    workspace_root: State<'_, WorkspaceRoot>,
    task_id: String,
    project_path: String,
    checkpoint_id: Option<String>,
    path: String,
    status: String,
) -> Result<GitReviewFileDto> {
    let workspace = workspace_root.inner().read().await.clone();
    tokio::task::spawn_blocking(move || {
        let (repo, validated) = open_validated_direct_checkpoint(
            &app,
            &workspace,
            &task_id,
            &project_path,
            checkpoint_id.as_deref(),
            false,
        )?;
        let relative = validate_repo_relative_file_path(&path)?;
        review::build_git_review_file(&repo, &validated, &relative, &status)
    })
    .await
    .map_err(to_join_error)?
}

fn stage_direct_paths(repo: &Repository, paths: &[String]) -> Result<()> {
    let workdir = repo.workdir().ok_or_else(|| BackendError::Git {
        message: "Direct checkpoint has no worktree.".to_string(),
    })?;
    let mut index = repo.index().map_err(|error| BackendError::Git {
        message: format!("Failed to open direct checkpoint index: {}", error),
    })?;
    for path in paths {
        let relative = validate_repo_relative_file_path(path)?;
        if workdir.join(&relative).exists() {
            index
                .add_path(&relative)
                .map_err(|error| BackendError::Git {
                    message: format!("Failed to validate direct change {}: {}", path, error),
                })?;
        } else {
            let _ = index.remove_path(&relative);
        }
    }
    index.write().map_err(|error| BackendError::Git {
        message: format!("Failed to save direct change validation: {}", error),
    })?;
    Ok(())
}

fn accept_direct_changes(repo: &Repository) -> Result<String> {
    let mut index = repo.index()?;
    let tree_id = index.write_tree()?;
    let tree = repo.find_tree(tree_id)?;
    let parent = repo.head()?.peel_to_commit()?;
    let signature = git2::Signature::now("Macro", "macro@local")?;
    let oid = repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        "chore(checkpoint): accept direct workspace changes",
        &tree,
        &[&parent],
    )?;
    Ok(oid.to_string())
}

#[tauri::command]
pub async fn direct_stage_paths(
    app: AppHandle,
    workspace_root: State<'_, WorkspaceRoot>,
    task_id: String,
    project_path: String,
    checkpoint_id: Option<String>,
    paths: Vec<String>,
) -> Result<()> {
    let workspace = workspace_root.inner().read().await.clone();
    tokio::task::spawn_blocking(move || {
        let (repo, _) = open_validated_direct_checkpoint(
            &app,
            &workspace,
            &task_id,
            &project_path,
            checkpoint_id.as_deref(),
            false,
        )?;
        stage_direct_paths(&repo, &paths)
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
pub async fn direct_unstage_paths(
    app: AppHandle,
    workspace_root: State<'_, WorkspaceRoot>,
    task_id: String,
    project_path: String,
    checkpoint_id: Option<String>,
    paths: Vec<String>,
) -> Result<()> {
    let workspace = workspace_root.inner().read().await.clone();
    tokio::task::spawn_blocking(move || {
        let (repo, _) = open_validated_direct_checkpoint(
            &app,
            &workspace,
            &task_id,
            &project_path,
            checkpoint_id.as_deref(),
            false,
        )?;
        let head = repo.head()?.peel_to_commit()?;
        let object = head.as_object();
        let validated_paths = paths
            .iter()
            .map(|path| validate_repo_relative_file_path(path))
            .collect::<Result<Vec<_>>>()?;
        repo.reset_default(Some(object), validated_paths.iter())
            .map_err(|error| BackendError::Git {
                message: format!("Failed to unvalidate direct changes: {}", error),
            })?;
        Ok(())
    })
    .await
    .map_err(to_join_error)?
}

fn validate_direct_restore_target(worktree: &Path, relative: &Path) -> Result<PathBuf> {
    let canonical_worktree = worktree.canonicalize().map_err(|error| BackendError::Io {
        message: format!(
            "Failed to resolve direct-edit project root {}: {}",
            worktree.display(),
            error
        ),
        source: error,
    })?;
    let absolute = worktree.join(relative);
    let mut existing_ancestor = absolute.as_path();
    while fs::symlink_metadata(existing_ancestor).is_err() {
        existing_ancestor = existing_ancestor.parent().ok_or_else(|| {
            BackendError::Validation(format!(
                "Direct restore target escapes the project root: {}",
                relative.display()
            ))
        })?;
    }
    let canonical_ancestor =
        existing_ancestor
            .canonicalize()
            .map_err(|error| BackendError::Io {
                message: format!(
                    "Failed to resolve direct restore target {}: {}",
                    relative.display(),
                    error
                ),
                source: error,
            })?;
    if !canonical_ancestor.starts_with(&canonical_worktree) {
        return Err(BackendError::Validation(format!(
            "Direct restore target escapes the project root through a symbolic link: {}",
            relative.display()
        )));
    }
    Ok(absolute)
}

fn remove_direct_untracked_path(path: &Path, display_path: &str) -> Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(BackendError::Io {
                message: format!(
                    "Failed to inspect reverted path {}: {}",
                    display_path, error
                ),
                source: error,
            })
        }
    };

    let result = if metadata.file_type().is_symlink() {
        #[cfg(windows)]
        {
            if path.is_dir() {
                fs::remove_dir(path)
            } else {
                fs::remove_file(path)
            }
        }
        #[cfg(not(windows))]
        {
            fs::remove_file(path)
        }
    } else if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    result.map_err(|error| BackendError::Io {
        message: format!("Failed to remove reverted path {}: {}", display_path, error),
        source: error,
    })
}

#[tauri::command]
pub async fn direct_restore_worktree_paths(
    app: AppHandle,
    workspace_root: State<'_, WorkspaceRoot>,
    task_id: String,
    project_path: String,
    checkpoint_id: Option<String>,
    paths: Vec<String>,
) -> Result<()> {
    let workspace = workspace_root.inner().read().await.clone();
    tokio::task::spawn_blocking(move || {
        let (repo, validated) = open_validated_direct_checkpoint(
            &app,
            &workspace,
            &task_id,
            &project_path,
            checkpoint_id.as_deref(),
            false,
        )?;
        let mut index = repo.index()?;
        let mut checkout = git2::build::CheckoutBuilder::new();
        checkout.force();
        let mut has_checkout_paths = false;
        let validated_paths = paths
            .into_iter()
            .map(|path| {
                let relative = validate_repo_relative_file_path(&path)?;
                let absolute = validate_direct_restore_target(&validated, &relative)?;
                Ok((path, relative, absolute))
            })
            .collect::<Result<Vec<_>>>()?;
        for (path, relative, absolute) in validated_paths {
            if index.get_path(&relative, 0).is_some() {
                checkout.path(&relative);
                has_checkout_paths = true;
            } else {
                remove_direct_untracked_path(&absolute, &path)?;
            }
        }
        if has_checkout_paths {
            repo.checkout_index(Some(&mut index), Some(&mut checkout))?;
        }
        Ok(())
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
pub async fn direct_accept_changes(
    app: AppHandle,
    workspace_root: State<'_, WorkspaceRoot>,
    task_id: String,
    project_path: String,
    checkpoint_id: Option<String>,
) -> Result<String> {
    let workspace = workspace_root.inner().read().await.clone();
    tokio::task::spawn_blocking(move || {
        let (repo, _) = open_validated_direct_checkpoint(
            &app,
            &workspace,
            &task_id,
            &project_path,
            checkpoint_id.as_deref(),
            false,
        )?;
        accept_direct_changes(&repo)
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Hydrate a single review file with full HEAD/index/worktree content and diffs.
pub async fn git_review_file(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    path: String,
) -> Result<GitReviewFileDto> {
    if parse_wsl_repo_path(&repo_path).is_some() {
        return Err(unsupported_wsl_git_operation("git_review_file"));
    }

    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let relative_path = validate_repo_relative_file_path(&path)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;
        let status = build_git_status(&repo)?;
        let status_label = status
            .staged_files
            .iter()
            .chain(status.unstaged_files.iter())
            .chain(status.untracked_files.iter())
            .find(|file| file.path == path)
            .map(|file| file.status.as_str())
            .unwrap_or("modified");

        review::build_git_review_file(&repo, &validated, &relative_path, status_label)
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Read base/ours/theirs/worktree contents for an unresolved conflict file.
pub async fn git_read_conflict_file(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    path: String,
) -> Result<GitConflictFileDto> {
    if parse_wsl_repo_path(&repo_path).is_some() {
        return Err(unsupported_wsl_git_operation("git_read_conflict_file"));
    }

    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let relative_path = validate_repo_relative_file_path(&path)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        read_git_conflict_file(&repo, &validated, &relative_path)
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Write a resolved conflict file and optionally stage it.
pub async fn git_write_conflict_resolution(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    path: String,
    content: String,
    stage: Option<bool>,
) -> Result<()> {
    if parse_wsl_repo_path(&repo_path).is_some() {
        return Err(unsupported_wsl_git_operation(
            "git_write_conflict_resolution",
        ));
    }

    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let relative_path = validate_repo_relative_file_path(&path)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        write_git_conflict_resolution(
            &repo,
            &validated,
            &relative_path,
            &content,
            stage.unwrap_or(true),
        )
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Accept either the target branch version (ours) or source branch version (theirs).
pub async fn git_accept_conflict_side(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    path: String,
    side: String,
) -> Result<()> {
    if parse_wsl_repo_path(&repo_path).is_some() {
        return Err(unsupported_wsl_git_operation("git_accept_conflict_side"));
    }

    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let relative_path = validate_repo_relative_file_path(&path)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        accept_git_conflict_side(&repo, &validated, &relative_path, &side)
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
/// Complete the merge commit after all file conflicts have been resolved.
pub async fn git_complete_merge(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
) -> Result<String> {
    if parse_wsl_repo_path(&repo_path).is_some() {
        return Err(unsupported_wsl_git_operation("git_complete_merge"));
    }

    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        complete_merge_repo(&repo)
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
    if let Some(wsl_repo_path) = parse_wsl_repo_path(&repo_path) {
        return build_wsl_git_tree(&wsl_repo_path, branch.as_deref()).await;
    }

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
    if parse_wsl_repo_path(&repo_path).is_some() {
        return Err(unsupported_wsl_git_operation("git_worktree_inspect"));
    }

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
    fallback_branches: Option<Vec<String>>,
) -> Result<GitWorktreeEnsureDto> {
    if parse_wsl_repo_path(&repo_path).is_some() {
        return Err(unsupported_wsl_git_operation("git_worktree_create"));
    }

    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        let fallback_branches = fallback_branches.unwrap_or_else(|| {
            preferred_commit_branch
                .clone()
                .into_iter()
                .collect::<Vec<_>>()
        });

        let ensured = git_state.ensure_task_worktree(
            &repo,
            &task_id,
            &branch_name,
            from_ref.as_deref(),
            preferred_commit_branch.as_deref(),
            &fallback_branches,
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
/// Inspect a Git worktree for a generic branch integration target.
pub async fn git_branch_worktree_inspect(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    worktree_key: String,
    branch_name: String,
) -> Result<GitBranchWorktreeInspectionDto> {
    if parse_wsl_repo_path(&repo_path).is_some() {
        return Err(unsupported_wsl_git_operation("git_branch_worktree_inspect"));
    }

    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        let inspection = git_state.inspect_branch_worktree(&repo, &worktree_key, &branch_name)?;
        Ok(GitBranchWorktreeInspectionDto {
            worktree_key: inspection.worktree_key,
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
/// Create or repair a Git worktree for a generic branch integration target.
pub async fn git_branch_worktree_create(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    worktree_key: String,
    branch_name: String,
    from_ref: Option<String>,
    fallback_branches: Option<Vec<String>>,
) -> Result<GitBranchWorktreeEnsureDto> {
    if parse_wsl_repo_path(&repo_path).is_some() {
        return Err(unsupported_wsl_git_operation("git_branch_worktree_create"));
    }

    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        let fallback_branches = fallback_branches.unwrap_or_default();
        let ensured = git_state.ensure_branch_worktree(
            &repo,
            &worktree_key,
            &branch_name,
            from_ref.as_deref(),
            &fallback_branches,
        )?;
        Ok(GitBranchWorktreeEnsureDto {
            worktree_key: ensured.worktree_key,
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
/// Remove a Git worktree for a generic branch integration target.
pub async fn git_branch_worktree_remove(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    worktree_key: String,
    branch_name: String,
    force: Option<bool>,
) -> Result<GitBranchWorktreeRemoveDto> {
    if parse_wsl_repo_path(&repo_path).is_some() {
        return Err(unsupported_wsl_git_operation("git_branch_worktree_remove"));
    }

    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        let removed = git_state.remove_branch_worktree(
            &repo,
            &worktree_key,
            &branch_name,
            force.unwrap_or(false),
        )?;
        Ok(GitBranchWorktreeRemoveDto {
            worktree_key: removed.worktree_key,
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
/// Remove a Git worktree for a specific task.
pub async fn git_worktree_remove(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    task_id: String,
    force: Option<bool>,
    branch_name: Option<String>,
) -> Result<GitWorktreeRemoveDto> {
    if parse_wsl_repo_path(&repo_path).is_some() {
        return Err(unsupported_wsl_git_operation("git_worktree_remove"));
    }

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
    if let Some(wsl_repo_path) = parse_wsl_repo_path(&repo_path) {
        return wsl_git_sync(&wsl_repo_path, "fetch", remote, branch).await;
    }

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
        let output = run_git_command_with_timeout(&root, &args, NATIVE_GIT_NETWORK_TIMEOUT)?;
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
    if let Some(wsl_repo_path) = parse_wsl_repo_path(&repo_path) {
        return wsl_git_sync(&wsl_repo_path, "push", remote, branch).await;
    }

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
        let output = run_git_command_with_timeout(&root, &args, NATIVE_GIT_NETWORK_TIMEOUT)?;
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
pub async fn git_remote_add_origin(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
    url: String,
) -> Result<GitRemoteDto> {
    if let Some(wsl_repo_path) = parse_wsl_repo_path(&repo_path) {
        return wsl_git_remote_add_origin(&wsl_repo_path, &url).await;
    }

    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;
        add_origin_remote(&repo, &url)
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
    if let Some(wsl_repo_path) = parse_wsl_repo_path(&repo_path) {
        return wsl_git_sync(&wsl_repo_path, "pull", remote, branch).await;
    }

    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;

        let use_tracking_upstream = remote.is_none() && branch.is_none();
        let remote_name = remote
            .unwrap_or_else(|| DEFAULT_REMOTE_NAME.to_string())
            .trim()
            .to_string();
        validate_remote_name(&remote_name)?;
        let branch_name = resolve_target_branch(&repo, branch)?;
        let root = repo_root(&repo)?;
        drop(repo);

        let args = if use_tracking_upstream {
            vec!["pull".to_string(), "--no-rebase".to_string()]
        } else {
            vec![
                "pull".to_string(),
                "--no-rebase".to_string(),
                remote_name.clone(),
                branch_name.clone(),
            ]
        };
        let output = run_git_command_with_timeout(&root, &args, NATIVE_GIT_NETWORK_TIMEOUT)?;
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
    ensure_macro_workspace_not_wsl(&workspace)?;
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let (worktree_path, worktree_repo, repaired_after_move) =
            resolve_macro_worktree(&git_state, &workspace)?;
        build_macro_sync_dto(
            &worktree_repo,
            &worktree_path,
            false,
            None,
            Some(
                if repaired_after_move {
                    "Metadata worktree repaired after project move."
                } else {
                    "Metadata branch ensured"
                }
                .to_string(),
            ),
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
    ensure_macro_workspace_not_wsl(&workspace)?;
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let (worktree_path, worktree_repo, repaired_after_move) =
            resolve_macro_worktree(&git_state, &workspace)?;
        build_macro_sync_dto(
            &worktree_repo,
            &worktree_path,
            false,
            None,
            repaired_after_move
                .then(|| "Metadata worktree repaired after project move.".to_string()),
            None,
        )
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
    ensure_macro_workspace_not_wsl(&workspace)?;
    let git_state = git_state.inner().clone();
    let commit_message = message
        .unwrap_or_else(|| "chore(metadata): persist metadata updates".to_string())
        .trim()
        .to_string();

    tokio::task::spawn_blocking(move || {
        let (worktree_path, worktree_repo, _) = resolve_macro_worktree(&git_state, &workspace)?;

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
    ensure_macro_workspace_not_wsl(&workspace)?;
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let (worktree_path, worktree_repo, _) = resolve_macro_worktree(&git_state, &workspace)?;
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
    ensure_macro_workspace_not_wsl(&workspace)?;
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let (worktree_path, worktree_repo, _) = resolve_macro_worktree(&git_state, &workspace)?;
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

    #[test]
    fn test_wsl_diff_range_matches_native_four_way_contract() {
        assert_eq!(wsl_diff_range(None, None), None);
        assert_eq!(wsl_diff_range(Some("base"), None).as_deref(), Some("base"));
        assert_eq!(
            wsl_diff_range(None, Some("head")).as_deref(),
            Some("HEAD..head")
        );
        assert_eq!(
            wsl_diff_range(Some("base"), Some("head")).as_deref(),
            Some("base..head")
        );
    }

    #[test]
    fn test_wsl_git_tree_script_checks_git_producers_before_pagination() {
        let script = wsl_git_tree_page_script();
        let ls_tree = script.find("ls-tree -r -z").expect("ls-tree producer");
        let checked_redirect = script[ls_tree..]
            .find(">\"$tracked\" || exit $?")
            .expect("ls-tree checked redirect");
        let pagination = script.find("tail -z").expect("pagination");
        assert!(ls_tree + checked_redirect < pagination);
        assert!(script.contains("\"$x\" == R"));
    }

    #[test]
    fn test_wsl_untracked_diff_script_is_bounded_and_keeps_head_and_tail() {
        let script = wsl_git_diff_with_untracked_script();
        assert!(script.contains("untracked_count > 2000"));
        assert!(script.contains("tail_bytes=$((max_bytes / 4))"));
        assert!(script.contains("head -c \"$head_bytes\""));
        assert!(script.contains("tail -c \"$tail_bytes\""));
        assert!(script.contains("git -C \"$repo\" \"${diff_args[@]}\" >\"$combined\" || exit $?"));
    }

    #[test]
    fn test_parse_wsl_porcelain_v1_z_preserves_special_paths_and_renames() {
        let payload = concat!(
            "## feature/unicode...origin/feature/unicode\0",
            "?? spaces and → unicode.txt\0",
            " M tab\tand\nnewline.txt\0",
            "R  new -> literal.txt\0old\tname.txt\0",
        );
        let parsed = parse_wsl_porcelain_v1_z(payload.as_bytes());

        assert_eq!(parsed.branch, "feature/unicode");
        assert_eq!(parsed.untracked_files[0].path, "spaces and → unicode.txt");
        assert_eq!(parsed.unstaged_files[0].path, "tab\tand\nnewline.txt");
        assert_eq!(parsed.staged_files[0].path, "new -> literal.txt");
        assert_eq!(
            parsed.staged_files[0].old_path.as_deref(),
            Some("old\tname.txt")
        );
    }

    fn wsl_test_branch(name: &str) -> GitBranch {
        GitBranch {
            name: name.to_string(),
            is_head: false,
            commit: "abc1234".to_string(),
        }
    }

    #[test]
    fn test_paginate_wsl_branch_refs_spans_local_remote_boundary() {
        let local = vec![
            wsl_test_branch("main"),
            wsl_test_branch("feature"),
            wsl_test_branch("fix"),
        ];
        let remote = vec![
            wsl_test_branch("origin/main"),
            wsl_test_branch("origin/dev"),
        ];

        let (local_page, remote_page, has_more) = paginate_wsl_branch_refs(local, remote, 2, 2);

        assert_eq!(
            local_page
                .iter()
                .map(|b| b.name.as_str())
                .collect::<Vec<_>>(),
            ["fix"]
        );
        assert_eq!(
            remote_page
                .iter()
                .map(|b| b.name.as_str())
                .collect::<Vec<_>>(),
            ["origin/main"]
        );
        assert!(has_more);
    }

    #[test]
    fn test_paginate_wsl_branch_refs_reports_exact_exhaustion() {
        let local = vec![wsl_test_branch("main")];
        let remote = vec![wsl_test_branch("origin/main")];

        let (local_page, remote_page, has_more) = paginate_wsl_branch_refs(local, remote, 0, 2);

        assert_eq!(local_page.len(), 1);
        assert_eq!(remote_page.len(), 1);
        assert!(!has_more);
    }

    #[test]
    fn test_paginate_wsl_branch_refs_uses_clamped_listing_as_has_more_sentinel() {
        // A local listing clamped at offset+limit+1 entries proves another
        // page exists even though the whole window was consumed locally.
        let local = vec![
            wsl_test_branch("a"),
            wsl_test_branch("b"),
            wsl_test_branch("c"),
        ];

        let (local_page, remote_page, has_more) = paginate_wsl_branch_refs(local, Vec::new(), 1, 1);

        assert_eq!(local_page.len(), 1);
        assert_eq!(local_page[0].name, "b");
        assert!(remote_page.is_empty());
        assert!(has_more);
    }

    #[test]
    fn test_paginate_wsl_branch_refs_beyond_last_entry_is_empty() {
        let local = vec![wsl_test_branch("main")];
        let remote = vec![wsl_test_branch("origin/main")];

        let (local_page, remote_page, has_more) = paginate_wsl_branch_refs(local, remote, 5, 2);

        assert!(local_page.is_empty());
        assert!(remote_page.is_empty());
        assert!(!has_more);
    }

    #[test]
    fn test_parse_wsl_branch_ref_lines_skips_blank_names() {
        let parsed = parse_wsl_branch_ref_lines(
            "main\tabc1234\n\n\tdead000\nfeature\tdef5678\n".to_string(),
        );

        assert_eq!(
            parsed,
            vec![
                ("main".to_string(), "abc1234".to_string()),
                ("feature".to_string(), "def5678".to_string()),
            ]
        );
    }

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

    fn init_direct_checkpoint() -> (TempDir, PathBuf, Repository) {
        let temp = TempDir::new().expect("temp dir");
        let project_path = temp.path().join("project");
        let checkpoint_path = temp.path().join("checkpoint");
        fs::create_dir_all(&project_path).expect("create project");
        let repo = Repository::init_bare(&checkpoint_path).expect("init checkpoint");
        {
            let mut config = repo.config().expect("checkpoint config");
            config.set_bool("core.bare", false).expect("set non-bare");
            config
                .set_str("core.worktree", &project_path.to_string_lossy())
                .expect("set worktree");
        }
        fs::create_dir_all(checkpoint_path.join("info")).expect("create info");
        fs::write(
            checkpoint_path.join("info").join("exclude"),
            DIRECT_CHECKPOINT_EXCLUDES,
        )
        .expect("write excludes");
        let repo = Repository::open(checkpoint_path).expect("reopen checkpoint");
        (temp, project_path, repo)
    }

    #[test]
    fn direct_checkpoint_tracks_validated_files_without_touching_project_git() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        fs::write(project_path.join("README.md"), "before\n").expect("write baseline");
        fs::write(project_path.join(".env"), "SECRET=value\n").expect("write excluded file");

        let baseline = ensure_direct_checkpoint_head(&repo).expect("create baseline");
        assert!(!baseline.is_empty());
        assert!(!project_path.join(".git").exists());
        assert!(repo
            .index()
            .expect("index")
            .get_path(Path::new(".env"), 0)
            .is_none());

        fs::write(project_path.join("README.md"), "after\n").expect("edit file");
        fs::write(project_path.join("new.txt"), "new\n").expect("write new file");
        stage_direct_paths(&repo, &["README.md".to_string(), "new.txt".to_string()])
            .expect("validate changes");
        let accepted = accept_direct_changes(&repo).expect("accept changes");

        assert_ne!(baseline, accepted);
        assert_eq!(
            repo.head()
                .expect("checkpoint head")
                .peel_to_commit()
                .expect("checkpoint commit")
                .parent_count(),
            1
        );
        let snapshot = review::build_git_review_snapshot(&repo, &project_path)
            .expect("review accepted checkpoint");
        assert!(snapshot.is_clean);
        assert!(snapshot.changes.is_empty());
        let statuses = repo.statuses(None).expect("statuses");
        let status_paths = statuses
            .iter()
            .filter(|entry| entry.status() != Status::IGNORED)
            .map(|entry| {
                format!(
                    "{}:{:?}",
                    entry.path().unwrap_or("<unknown>"),
                    entry.status()
                )
            })
            .collect::<Vec<_>>();
        assert!(
            status_paths.is_empty(),
            "remaining changes: {:?}",
            status_paths
        );
    }

    #[test]
    fn direct_checkpoint_owner_requires_an_exact_task_id() {
        let checkpoint_id = direct_checkpoint_key("task-other", Path::new("/project"));

        validate_direct_checkpoint_owner(&checkpoint_id, "task-other")
            .expect("matching task owns checkpoint");
        let error = validate_direct_checkpoint_owner(&checkpoint_id, "task")
            .expect_err("task prefix must not grant checkpoint ownership");

        assert!(error.to_string().contains("does not belong to this task"));
    }

    #[test]
    fn direct_checkpoint_creation_rejects_a_linked_managed_root() {
        let temp = TempDir::new().expect("temp dir");
        let outside_root = temp.path().join("outside");
        let app_data_dir = temp.path().join("app-data");
        fs::create_dir_all(&outside_root).expect("create outside root");
        fs::create_dir_all(&app_data_dir).expect("create app data");
        let linked_root = app_data_dir.join(DIRECT_CHECKPOINTS_DIR);

        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside_root, &linked_root).expect("create root symlink");
        #[cfg(windows)]
        if std::os::windows::fs::symlink_dir(&outside_root, &linked_root).is_err() {
            return;
        }

        let error = resolve_direct_checkpoint_root(&app_data_dir, true)
            .expect_err("linked checkpoint root must be rejected before creation");

        assert!(error
            .to_string()
            .contains("root is not a managed directory"));
        assert!(fs::read_dir(&outside_root)
            .expect("read outside root")
            .next()
            .is_none());
    }

    #[test]
    fn direct_checkpoint_removal_is_scoped_and_idempotent() {
        let temp = TempDir::new().expect("temp dir");
        let project_path = temp.path().join("project");
        fs::create_dir_all(&project_path).expect("create project");
        let checkpoint_path = direct_checkpoint_path(temp.path(), "task-1", &project_path);
        fs::create_dir_all(&checkpoint_path).expect("create checkpoint");
        fs::write(checkpoint_path.join("HEAD"), "checkpoint").expect("write checkpoint");
        let sibling_path = direct_checkpoint_path(temp.path(), "task-2", &project_path);
        fs::create_dir_all(&sibling_path).expect("create sibling checkpoint");
        let checkpoint_id = direct_checkpoint_key("task-1", &project_path);

        assert!(remove_direct_checkpoint(temp.path(), &checkpoint_id).expect("remove checkpoint"));
        assert!(!checkpoint_path.exists());
        assert!(sibling_path.exists());
        assert!(!remove_direct_checkpoint(temp.path(), &checkpoint_id)
            .expect("repeat checkpoint removal"));
    }

    #[test]
    fn direct_checkpoint_removal_rejects_a_linked_managed_root() {
        let temp = TempDir::new().expect("temp dir");
        let outside_root = temp.path().join("outside");
        let app_data_dir = temp.path().join("app-data");
        fs::create_dir_all(&outside_root).expect("create outside root");
        fs::create_dir_all(&app_data_dir).expect("create app data");
        let checkpoint_id = "task-1-0000000000000001";
        let outside_checkpoint = outside_root.join(checkpoint_id);
        fs::create_dir_all(&outside_checkpoint).expect("create outside checkpoint");
        fs::write(outside_checkpoint.join("keep.txt"), "keep me").expect("write outside file");
        let linked_root = app_data_dir.join(DIRECT_CHECKPOINTS_DIR);

        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside_root, &linked_root).expect("create root symlink");
        #[cfg(windows)]
        if std::os::windows::fs::symlink_dir(&outside_root, &linked_root).is_err() {
            return;
        }

        let error = remove_direct_checkpoint(&app_data_dir, checkpoint_id)
            .expect_err("linked checkpoint root must be rejected");

        assert!(error
            .to_string()
            .contains("root is not a managed directory"));
        assert!(outside_checkpoint.join("keep.txt").exists());
    }

    #[test]
    fn direct_restore_target_stays_inside_project_root() {
        let temp = TempDir::new().expect("temp dir");
        let project_path = temp.path().join("project");
        fs::create_dir_all(project_path.join("src")).expect("create project");

        let target = validate_direct_restore_target(&project_path, Path::new("src/new.ts"))
            .expect("validate target");

        assert_eq!(target, project_path.join("src/new.ts"));
    }

    #[test]
    fn direct_restore_rejects_targets_through_symbolic_links() {
        let temp = TempDir::new().expect("temp dir");
        let project_path = temp.path().join("project");
        let outside_path = temp.path().join("outside");
        fs::create_dir_all(&project_path).expect("create project");
        fs::create_dir_all(&outside_path).expect("create outside directory");
        fs::write(outside_path.join("secret.txt"), "keep me").expect("write outside file");
        let link_path = project_path.join("linked");

        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside_path, &link_path).expect("create directory symlink");
        #[cfg(windows)]
        if std::os::windows::fs::symlink_dir(&outside_path, &link_path).is_err() {
            return;
        }

        let error = validate_direct_restore_target(&project_path, Path::new("linked/secret.txt"))
            .expect_err("outside target must be rejected");

        assert!(error.to_string().contains("escapes the project root"));
        assert_eq!(
            fs::read_to_string(outside_path.join("secret.txt")).expect("read outside file"),
            "keep me"
        );
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
    fn git_environment_filter_is_case_insensitive() {
        assert!(is_git_environment_variable(OsStr::new("GIT_DIR")));
        assert!(is_git_environment_variable(OsStr::new("git_config_count")));
        assert!(!is_git_environment_variable(OsStr::new("PATH")));
    }

    #[test]
    fn run_git_command_rejects_unsafe_hooks_path() {
        let (temp, repo) = init_repo();
        let hooks_path = temp
            .path()
            .parent()
            .expect("temp parent")
            .join("outside-hooks");
        repo.config()
            .expect("repo config")
            .set_str("core.hooksPath", hooks_path.to_string_lossy().as_ref())
            .expect("set hooks path");

        let error = match run_git_command(temp.path(), &["status".to_string()]) {
            Ok(_) => panic!("unsafe hooks path must be rejected"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("core.hooksPath"));
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
    fn test_validate_repo_path_rejects_relative_repo_through_external_directory_link() {
        let temp = TempDir::new().expect("temp dir");
        let workspace = temp.path().join("workspace");
        let outside_repo = temp.path().join("outside-repo");
        fs::create_dir_all(&workspace).expect("create workspace");
        Repository::init(&outside_repo).expect("init outside repo");
        let linked_repo = workspace.join("linked-repo");

        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside_repo, &linked_repo).expect("create repo symlink");
        #[cfg(windows)]
        if std::os::windows::fs::symlink_dir(&outside_repo, &linked_repo).is_err() {
            return;
        }

        let error = validate_repo_path("linked-repo", &workspace)
            .expect_err("agent-relative repo link must stay inside the selected workspace");

        assert!(error.to_string().contains("outside workspace"));
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
        assert!(validate_commit_message(
            "build(deps): update tauri\n\nUpgrade runtime dependencies."
        )
        .is_ok());
        assert!(validate_commit_message("ci: update release workflow").is_ok());
        assert!(validate_commit_message("revert: restore previous behavior").is_ok());
    }

    #[test]
    fn test_validate_commit_message_invalid() {
        let err = validate_commit_message("add feature").expect_err("invalid message");
        assert_eq!(
            err.to_string(),
            "Validation error: Commit message must follow Conventional Commits: type: subject"
        );
        assert!(validate_commit_message("feat: ").is_err());
        assert!(validate_commit_message("invalid: message").is_err());
        assert!(validate_commit_message("feat(scope: message").is_err());
        assert!(validate_commit_message("feat(BadScope): message").is_err());
        assert!(validate_commit_message("style:").is_err());
    }

    #[test]
    fn git_cli_operands_reject_option_injection() {
        for value in ["--force", "--hard", "--output=/tmp/out", "-n"] {
            assert!(validate_git_cli_operand(value, "test operand").is_err());
            assert!(validate_refspec(value).is_err());
            assert!(validate_branch_name(value).is_err());
        }
        assert!(validate_refspec("HEAD").is_ok());
        assert!(validate_refspec("feature/safe").is_ok());
        assert!(validate_branch_name("feature/safe").is_ok());
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
    fn test_git_log_page_skips_without_materializing_prior_commits() {
        let (temp, repo) = init_repo();
        for index in 1..=4 {
            fs::write(temp.path().join("README.md"), format!("commit {index}\n")).unwrap();
            commit_repo(&repo, &format!("test: commit {index}"), true).unwrap();
        }
        let all = build_git_log(&repo, 10, None).unwrap();
        let snapshot = build_git_log_snapshot(&repo, None).unwrap();
        let page = build_git_log_page(&repo, 1, 2, &snapshot).unwrap();
        assert_eq!(page.len(), 2);
        assert_eq!(page[0].id, all[1].id);
        assert_eq!(page[1].id, all[2].id);

        fs::write(temp.path().join("dirty.txt"), "changed\n").unwrap();
        let changed_snapshot = build_git_log_snapshot(&repo, None).unwrap();
        assert_ne!(changed_snapshot.revision, snapshot.revision);
    }

    #[test]
    fn test_git_log_snapshot_uses_the_requested_branch_tip() {
        let (temp, repo) = init_repo();
        let feature_tip = repo.head().unwrap().peel_to_commit().unwrap().id();
        repo.branch(
            "feature/snapshot",
            &repo.find_commit(feature_tip).unwrap(),
            false,
        )
        .unwrap();
        fs::write(temp.path().join("README.md"), "current branch advanced\n").unwrap();
        let current_tip = commit_repo(&repo, "test: advance current branch", true).unwrap();
        assert_ne!(current_tip, feature_tip.to_string());

        let snapshot = build_git_log_snapshot(&repo, Some("feature/snapshot")).unwrap();

        assert_eq!(
            snapshot.tip.as_deref(),
            Some(feature_tip.to_string().as_str())
        );
        assert!(snapshot.revision.starts_with(&feature_tip.to_string()));
    }

    #[test]
    fn test_git_branch_list_basic() {
        let (_temp, repo) = init_repo();
        let branches = build_git_branches(&repo).unwrap();
        assert!(branches.local.iter().any(|b| b.is_head));
    }

    #[test]
    fn test_git_branch_tool_page_is_bounded_and_resumable() {
        let (_temp, repo) = init_repo();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature/a", &head, false).unwrap();
        repo.branch("feature/b", &head, false).unwrap();

        let first = build_git_branches_tool_page(&repo, 0, 1).unwrap();
        assert_eq!(first.local.len() + first.remote.len(), 1);
        assert!(first.has_more);
        let second = build_git_branches_tool_page(&repo, 1, 1).unwrap();
        assert_eq!(second.local.len() + second.remote.len(), 1);
        assert!(second.has_more);
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
        assert_eq!(check.ahead, 1);
        assert_eq!(check.behind, 0);
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
        assert_eq!(check.ahead, 1);
        assert_eq!(check.behind, 1);
    }

    #[test]
    fn test_start_merge_resolution_materializes_conflict_stages() {
        let (temp, repo) = init_repo();
        let base_branch = get_branch_name(&repo).unwrap().expect("base branch");

        checkout_repo(&repo, "feature", true).unwrap();
        fs::write(temp.path().join("README.md"), "feature branch change").unwrap();
        commit_repo(&repo, "feat: feature readme change", true).unwrap();

        checkout_repo(&repo, &base_branch, false).unwrap();
        fs::write(temp.path().join("README.md"), "base branch change").unwrap();
        commit_repo(&repo, "feat: base readme change", true).unwrap();

        let result = start_merge_resolution_repo(&repo, "feature", &base_branch).unwrap();

        assert_eq!(result.status, "conflicted");
        assert!(result.conflict_files.iter().any(|path| path == "README.md"));

        let file = read_git_conflict_file(&repo, temp.path(), Path::new("README.md")).unwrap();
        assert_eq!(file.base.content, "hello");
        assert_eq!(file.ours.content, "base branch change");
        assert_eq!(file.theirs.content, "feature branch change");
        assert!(file.worktree.content.contains("<<<<<<<"));
        assert!(!file.is_binary);
        assert!(!file.too_large);
    }

    #[test]
    fn test_write_conflict_resolution_and_complete_merge() {
        let (temp, repo) = init_repo();
        let base_branch = get_branch_name(&repo).unwrap().expect("base branch");

        checkout_repo(&repo, "feature", true).unwrap();
        fs::write(temp.path().join("README.md"), "feature branch change").unwrap();
        commit_repo(&repo, "feat: feature readme change", true).unwrap();

        checkout_repo(&repo, &base_branch, false).unwrap();
        fs::write(temp.path().join("README.md"), "base branch change").unwrap();
        commit_repo(&repo, "feat: base readme change", true).unwrap();

        let result = start_merge_resolution_repo(&repo, "feature", &base_branch).unwrap();
        assert_eq!(result.status, "conflicted");

        write_git_conflict_resolution(
            &repo,
            temp.path(),
            Path::new("README.md"),
            "resolved merge content\n",
            true,
        )
        .unwrap();
        let status = build_git_status(&repo).unwrap();
        assert!(status.conflicted_files.is_empty());
        assert!(status.merge_in_progress);

        let output = complete_merge_repo(&repo).unwrap();
        assert!(!output.is_empty());
        let status = build_git_status(&repo).unwrap();
        assert!(status.is_clean);
        assert!(!status.merge_in_progress);
        assert_eq!(
            fs::read_to_string(temp.path().join("README.md")).unwrap(),
            "resolved merge content\n"
        );
    }

    #[test]
    fn test_accept_conflict_side_stages_selected_version() {
        let (temp, repo) = init_repo();
        let base_branch = get_branch_name(&repo).unwrap().expect("base branch");

        checkout_repo(&repo, "feature", true).unwrap();
        fs::write(temp.path().join("README.md"), "feature branch change").unwrap();
        commit_repo(&repo, "feat: feature readme change", true).unwrap();

        checkout_repo(&repo, &base_branch, false).unwrap();
        fs::write(temp.path().join("README.md"), "base branch change").unwrap();
        commit_repo(&repo, "feat: base readme change", true).unwrap();

        start_merge_resolution_repo(&repo, "feature", &base_branch).unwrap();
        accept_git_conflict_side(&repo, temp.path(), Path::new("README.md"), "theirs").unwrap();

        let status = build_git_status(&repo).unwrap();
        assert!(status.conflicted_files.is_empty());
        assert_eq!(
            fs::read_to_string(temp.path().join("README.md")).unwrap(),
            "feature branch change"
        );
    }

    #[test]
    fn test_git_fast_forward_advances_target_branch() {
        let (temp, repo) = init_repo();
        let base_branch = get_branch_name(&repo).unwrap().expect("base branch");

        checkout_repo(&repo, "feature", true).unwrap();
        fs::write(temp.path().join("README.md"), "hello\nfeature change").unwrap();
        let feature_commit = commit_repo(&repo, "feat: update readme on feature", true).unwrap();

        checkout_repo(&repo, &base_branch, false).unwrap();
        let output = fast_forward_repo(&repo, "feature", &base_branch).unwrap();

        assert!(!output.is_empty());
        let base_commit = resolve_commit(&repo, &base_branch).unwrap();
        assert_eq!(short_hash(base_commit.id()), feature_commit);
    }

    #[test]
    fn test_git_rebase_check_detects_clean_rebase() {
        let (temp, repo) = init_repo();
        let base_branch = get_branch_name(&repo).unwrap().expect("base branch");

        checkout_repo(&repo, "feature", true).unwrap();
        fs::write(temp.path().join("feature.txt"), "feature\n").unwrap();
        commit_repo(&repo, "feat: add feature file", true).unwrap();

        checkout_repo(&repo, &base_branch, false).unwrap();
        fs::write(temp.path().join("base.txt"), "base\n").unwrap();
        commit_repo(&repo, "feat: add base file", true).unwrap();

        let check = build_git_rebase_check(&repo, "feature", &base_branch).unwrap();
        assert!(check.rebaseable);
        assert!(check.conflict_files.is_empty());
    }

    #[test]
    fn test_git_rebase_check_detects_conflicting_rebase() {
        let (temp, repo) = init_repo();
        let base_branch = get_branch_name(&repo).unwrap().expect("base branch");

        checkout_repo(&repo, "feature", true).unwrap();
        fs::write(temp.path().join("README.md"), "feature branch change").unwrap();
        commit_repo(&repo, "feat: feature readme change", true).unwrap();

        checkout_repo(&repo, &base_branch, false).unwrap();
        fs::write(temp.path().join("README.md"), "base branch change").unwrap();
        commit_repo(&repo, "feat: base readme change", true).unwrap();

        let check = build_git_rebase_check(&repo, "feature", &base_branch).unwrap();
        assert!(!check.rebaseable);
        assert!(check.conflict_files.iter().any(|path| path == "README.md"));
    }

    #[test]
    fn test_git_rebase_branch_rewrites_local_branch() {
        let (temp, repo) = init_repo();
        let base_branch = get_branch_name(&repo).unwrap().expect("base branch");

        checkout_repo(&repo, "feature", true).unwrap();
        fs::write(temp.path().join("feature.txt"), "feature\n").unwrap();
        commit_repo(&repo, "feat: add feature file", true).unwrap();

        checkout_repo(&repo, &base_branch, false).unwrap();
        fs::write(temp.path().join("base.txt"), "base\n").unwrap();
        commit_repo(&repo, "feat: add base file", true).unwrap();

        let output = rebase_branch_repo(&repo, "feature", &base_branch, Some(true)).unwrap();
        assert!(!output.is_empty());
        let check = build_git_merge_check(&repo, "feature", &base_branch).unwrap();
        assert!(check.mergeable);
        assert_eq!(check.ahead, 1);
        assert_eq!(check.behind, 0);
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
                mode: GitDiffMode::Patch,
                max_bytes: None,
                require_complete: false,
            },
        )
        .unwrap();
        assert!(diff.contains("README.md"));
    }

    #[test]
    fn test_git_diff_modes_and_explicit_truncation() {
        let (temp, repo) = init_repo();
        fs::write(temp.path().join("README.md"), "updated\n".repeat(20_000)).unwrap();

        let bounded = diff_repo(
            &repo,
            None,
            None,
            DiffRequestOptions {
                context_lines: Some(3),
                ignore_whitespace: false,
                paths: None,
                mode: GitDiffMode::Patch,
                max_bytes: Some(1_024),
                require_complete: false,
            },
        )
        .unwrap();
        assert!(bounded.contains("GIT DIFF TRUNCATED"));
        assert!(bounded.contains("README.md"));

        let complete_error = diff_repo(
            &repo,
            None,
            None,
            DiffRequestOptions {
                context_lines: Some(3),
                ignore_whitespace: false,
                paths: None,
                mode: GitDiffMode::Patch,
                max_bytes: Some(1_024),
                require_complete: true,
            },
        )
        .expect_err("require_complete must reject truncated output");
        assert!(complete_error.to_string().contains("mode=stat"));

        let stat = diff_repo(
            &repo,
            None,
            None,
            DiffRequestOptions {
                context_lines: None,
                ignore_whitespace: false,
                paths: None,
                mode: GitDiffMode::Stat,
                max_bytes: Some(8_192),
                require_complete: false,
            },
        )
        .unwrap();
        assert!(stat.contains("README.md"));
        assert!(!stat.contains("@@"));

        let names = diff_repo(
            &repo,
            None,
            None,
            DiffRequestOptions {
                context_lines: None,
                ignore_whitespace: false,
                paths: None,
                mode: GitDiffMode::NameOnly,
                max_bytes: Some(8_192),
                require_complete: false,
            },
        )
        .unwrap();
        assert_eq!(names.trim(), "README.md");
    }

    #[test]
    fn test_git_diff_patch_includes_untracked_content() {
        let (temp, repo) = init_repo();
        fs::write(
            temp.path().join("new-untracked.txt"),
            "first untracked line\nsecond untracked line\n",
        )
        .unwrap();

        let patch = diff_repo(
            &repo,
            None,
            None,
            DiffRequestOptions {
                context_lines: Some(3),
                ignore_whitespace: false,
                paths: None,
                mode: GitDiffMode::Patch,
                max_bytes: Some(16 * 1024),
                require_complete: true,
            },
        )
        .unwrap();

        assert!(patch.contains("diff --git a/new-untracked.txt b/new-untracked.txt"));
        assert!(patch.contains("+first untracked line"));
        assert!(patch.contains("+second untracked line"));
    }

    #[test]
    fn test_git_get_tree_basic() {
        let (_temp, repo) = init_repo();
        let tree = build_git_tree(&repo, None).unwrap();
        assert!(tree.structure.iter().any(|n| n.path == "README.md"));
    }

    #[test]
    fn test_git_tree_tool_page_returns_flat_bounded_nodes() {
        let (_temp, repo) = init_repo();
        let page = build_git_tree_tool_page(&repo, None, 0, 1).unwrap();
        assert_eq!(page.structure.len(), 1);
        assert_eq!(page.structure[0].path, "README.md");
        assert!(page.structure[0].children.is_none());
        assert!(!page.has_more);
    }

    #[test]
    fn test_git_tree_tool_page_paginates_status_only_paths() {
        let (temp, repo) = init_repo();
        fs::write(temp.path().join("z-untracked.txt"), "z").unwrap();
        fs::write(temp.path().join("a-untracked.txt"), "a").unwrap();

        let first = build_git_tree_tool_page(&repo, None, 0, 2).unwrap();
        assert_eq!(
            first
                .structure
                .iter()
                .map(|node| node.path.as_str())
                .collect::<Vec<_>>(),
            ["README.md", "a-untracked.txt"]
        );
        assert_eq!(first.structure[1].status.as_deref(), Some("added"));
        assert!(first.structure[1].hash.is_none());
        assert!(first.has_more);
        assert_eq!(first.modified_files_count, 2);

        let second = build_git_tree_tool_page(&repo, None, 2, 2).unwrap();
        assert_eq!(second.structure.len(), 1);
        assert_eq!(second.structure[0].path, "z-untracked.txt");
        assert_eq!(second.structure[0].status.as_deref(), Some("added"));
        assert!(!second.has_more);
    }

    #[test]
    fn test_git_tree_tool_revision_changes_with_worktree_status() {
        let (temp, repo) = init_repo();
        let clean = git_tree_revision(&repo, None).unwrap();
        fs::write(temp.path().join("new.txt"), "new").unwrap();
        let dirty = git_tree_revision(&repo, None).unwrap();
        assert_ne!(clean, dirty);
    }

    #[test]
    fn test_git_tree_tool_page_includes_staged_rename_target() {
        let (temp, repo) = init_repo();
        fs::rename(
            temp.path().join("README.md"),
            temp.path().join("renamed.md"),
        )
        .unwrap();
        let mut index = repo.index().unwrap();
        index.remove_path(Path::new("README.md")).unwrap();
        index.add_path(Path::new("renamed.md")).unwrap();
        index.write().unwrap();

        let page = build_git_tree_tool_page(&repo, None, 0, 10).unwrap();
        let renamed = page
            .structure
            .iter()
            .find(|node| node.path == "renamed.md")
            .expect("renamed status-only target");
        assert_eq!(renamed.status.as_deref(), Some("renamed"));
        assert!(renamed.hash.is_none());
        assert_eq!(page.modified_files_count, 1);
    }

    #[test]
    fn test_git_tree_tool_page_marks_conflicted_path() {
        let (temp, repo) = init_repo();
        let base_branch = get_branch_name(&repo).unwrap().expect("base branch");
        checkout_repo(&repo, "feature", true).unwrap();
        fs::write(temp.path().join("README.md"), "feature\n").unwrap();
        commit_repo(&repo, "feat: feature conflict", true).unwrap();
        checkout_repo(&repo, &base_branch, false).unwrap();
        fs::write(temp.path().join("README.md"), "base\n").unwrap();
        commit_repo(&repo, "feat: base conflict", true).unwrap();
        start_merge_resolution_repo(&repo, "feature", &base_branch).unwrap();

        let page = build_git_tree_tool_page(&repo, None, 0, 10).unwrap();
        let readme = page
            .structure
            .iter()
            .find(|node| node.path == "README.md")
            .expect("conflicted tracked path");
        assert_eq!(readme.status.as_deref(), Some("conflicted"));
        assert_eq!(page.modified_files_count, 1);
        abort_merge(&repo).unwrap();
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
    fn test_restore_paths_staged_target_preserves_worktree_state() {
        let (temp, repo) = init_repo();
        let file_path = temp.path().join("README.md");

        fs::write(&file_path, "staged version").unwrap();
        add_paths(&repo, &["README.md".to_string()]).unwrap();
        fs::write(&file_path, "worktree version").unwrap();

        restore_paths(&repo, &["README.md".to_string()], RestoreTarget::Staged).unwrap();

        let pair = read_git_file_pair(&repo, temp.path(), Path::new("README.md")).unwrap();
        assert_eq!(pair.head_content, "hello");
        assert_eq!(pair.index_content, "hello");
        assert_eq!(pair.worktree_content, "worktree version");
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
    fn test_abort_merge_requires_merge_in_progress() {
        let (_temp, repo) = init_repo();
        let error = abort_merge(&repo).expect_err("expected no merge error");
        assert!(error.to_string().contains("No merge in progress"));
    }

    #[test]
    fn test_abort_merge_requires_confirmation() {
        let (_temp, repo) = init_repo();
        let error =
            abort_merge_with_confirmation(&repo, Some(false)).expect_err("expected confirm error");
        assert!(error
            .to_string()
            .contains("Abort merge requires confirm=true"));
    }

    #[test]
    fn test_abort_merge_cleans_merge_state() {
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
        assert_eq!(repo.state(), RepositoryState::Merge);

        abort_merge(&repo).unwrap();

        let status = build_git_status(&repo).unwrap();
        assert!(status.is_clean);
        assert!(!status.merge_in_progress);
        assert!(status.conflicted_files.is_empty());
        assert_eq!(
            fs::read_to_string(temp.path().join("README.md")).unwrap(),
            "base branch change"
        );
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
    fn test_derive_macro_sync_diagnostic_missing_upstream_wins_over_ahead() {
        let diagnostic = derive_macro_sync_diagnostic(
            &MacroSyncSignals {
                has_origin: true,
                has_upstream: false,
                is_dirty: false,
                ahead: 2,
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
    fn test_add_origin_remote_adds_origin() {
        let (_temp, repo) = init_repo();

        let result =
            add_origin_remote(&repo, "https://github.com/example/repo.git").expect("add origin");

        assert_eq!(result.remote, "origin");
        assert_eq!(result.url, "https://github.com/example/repo.git");
        let origin = repo.find_remote("origin").expect("origin remote");
        assert_eq!(
            origin.url().expect("origin URL should be valid UTF-8"),
            "https://github.com/example/repo.git"
        );
    }

    #[test]
    fn test_add_origin_remote_rejects_existing_origin() {
        let (_temp, repo) = init_repo();
        add_origin_remote(&repo, "https://github.com/example/repo.git").expect("add origin");

        let error = add_origin_remote(&repo, "https://github.com/example/other.git")
            .expect_err("existing origin should fail");

        assert!(error
            .to_string()
            .contains("Remote origin is already configured"));
    }

    #[test]
    fn test_add_origin_remote_rejects_empty_url() {
        let (_temp, repo) = init_repo();

        let error = add_origin_remote(&repo, "  ").expect_err("empty url should fail");

        assert!(error.to_string().contains("Remote URL cannot be empty"));
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
