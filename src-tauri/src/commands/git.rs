// Git Commands

#[path = "git/review.rs"]
mod review;

use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use cap_std::ambient_authority;
use cap_std::fs::{Dir as CapabilityDir, OpenOptions as CapabilityOpenOptions};
use chrono::{DateTime, Utc};
use git2::{
    BranchType, Commit, ConfigLevel, DiffFormat, DiffStatsFormat, Oid, Repository, RepositoryState,
    ResetType, StashFlags, Status, StatusEntry, TreeWalkMode, TreeWalkResult,
};
use serde::Serialize;
use sha1::Sha1;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::core::error::{BackendError, Result};
use crate::core::process::{
    background_command, background_contained_tokio_command, ContainedBackgroundProcess,
};
use crate::fs::{normalize_path, validate_path};
use crate::git::repo::{get_branch_name, get_head_commit, get_status, get_status_options};
use crate::git::{
    GitState, TaskWorktreeEnsureStatus, TaskWorktreeStatus, MACRO_BRANCH_NAME,
    MACRO_WORKTREE_DIR_NAME,
};
use crate::project_path::{
    parse_wsl_unc_path, run_wsl_command_allow_failure, run_wsl_git_allow_failure,
    run_wsl_git_bounded_allow_failure, WslCommandOutput, WslProjectPath,
};
use crate::workspace;
use crate::workspace::metadata::{
    direct_checkpoint_id, direct_checkpoint_task_segment, WorkspaceRecoverMissingMetadataRequestDto,
};
use crate::{WorkspaceMetadataRoot, WorkspaceRoot};

const DEFAULT_LOG_LIMIT: usize = 50;
const DEFAULT_REMOTE_NAME: &str = "origin";
const GENERIC_CONVENTIONAL_COMMIT_MESSAGE: &str =
    "Commit message must follow Conventional Commits: type: subject";
const MAX_CONFLICT_FILE_BYTES: usize = 1_000_000;
const WSL_GIT_TIMEOUT: Duration = Duration::from_secs(8);
const WSL_GIT_MUTATION_TIMEOUT: Duration = Duration::from_secs(30);
const NATIVE_GIT_NETWORK_TIMEOUT: Duration = Duration::from_secs(30);
const GIT_COMMAND_OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_GIT_COMMAND_OUTPUT_BYTES: u64 = 256 * 1024;
static REBASE_CHECK_COUNTER: AtomicU64 = AtomicU64::new(0);
#[derive(Default)]
struct GitReviewCancellationRegistry {
    active: HashMap<String, Arc<AtomicBool>>,
    pre_cancelled: HashMap<String, Instant>,
}

static GIT_REVIEW_CANCELLATIONS: OnceLock<Mutex<GitReviewCancellationRegistry>> = OnceLock::new();
const GIT_REVIEW_PRE_CANCEL_TTL: Duration = Duration::from_secs(60);
const MAX_GIT_REVIEW_PRE_CANCELLED: usize = 256;
const DIRECT_REVIEW_SNAPSHOT_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_DIRECT_REVIEW_SNAPSHOTS: usize = 256;
const MAX_DIRECT_REVIEW_PATHS: usize = 4_096;
const MAX_DIRECT_REVIEW_REVISION_BYTES: usize = 256 * 1024 * 1024;
const MAX_DIRECT_CHECKPOINT_VERIFICATION_OBJECTS: usize = 100_000;

struct DirectCheckpointVerificationBudget {
    remaining_bytes: usize,
    remaining_objects: usize,
}

impl DirectCheckpointVerificationBudget {
    fn new() -> Self {
        Self {
            remaining_bytes: MAX_DIRECT_REVIEW_REVISION_BYTES,
            remaining_objects: MAX_DIRECT_CHECKPOINT_VERIFICATION_OBJECTS,
        }
    }

    fn consume_object(&mut self) -> Result<()> {
        if self.remaining_objects == 0 {
            return Err(BackendError::FilesystemFileTooLarge {
                message: "Direct checkpoint verification object limit exceeded.".to_string(),
            });
        }
        self.remaining_objects -= 1;
        Ok(())
    }
}

#[derive(Clone)]
struct DirectReviewAuthorization {
    task_id: String,
    project_key: String,
    checkpoint_id: String,
    checkpoint_revision: String,
    restore_revisions: HashMap<String, String>,
    created_at: Instant,
}

static DIRECT_REVIEW_AUTHORIZATIONS: OnceLock<Mutex<HashMap<String, DirectReviewAuthorization>>> =
    OnceLock::new();

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

pub(crate) fn git_branch_snapshot_revision(repo: &Repository) -> Result<String> {
    let mut reference_digests = Vec::<[u8; 32]>::new();
    for pattern in ["refs/heads/*", "refs/remotes/*"] {
        for reference in repo.references_glob(pattern)? {
            let reference = reference?;
            let mut hasher = Sha256::new();
            hasher.update(reference.name_bytes());
            hasher.update([0]);
            if let Some(target) = reference.target() {
                hasher.update(target.as_bytes());
            }
            hasher.update([0]);
            if let Some(symbolic_target) = reference.symbolic_target()? {
                hasher.update(symbolic_target.as_bytes());
            }
            reference_digests.push(hasher.finalize().into());
        }
    }
    reference_digests.sort_unstable();

    let mut hasher = Sha256::new();
    hasher.update(b"macro-git-branches-v1\0");
    for digest in reference_digests {
        hasher.update(digest);
    }
    hasher.update([0]);
    if let Some(current) = get_branch_name(repo)? {
        hasher.update(current.as_bytes());
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub(crate) async fn wsl_git_branch_snapshot_revision(repo_path: &WslProjectPath) -> Result<String> {
    let script = r#"
tmp=$(mktemp) || exit $?
trap 'rm -f -- "$tmp"' EXIT
git -C "$1" for-each-ref --sort=refname \
  --format='%(refname)%00%(objectname)%00%(symref)' \
  refs/heads refs/remotes >"$tmp" || exit $?
current=$(git -C "$1" symbolic-ref -q --short HEAD)
symbolic_status=$?
if [[ $symbolic_status -gt 1 ]]; then exit $symbolic_status; fi
printf 'HEAD\0%s\n' "$current" >>"$tmp" || exit $?
sha256sum -- "$tmp"
"#;
    let output = run_wsl_command_allow_failure(
        repo_path,
        "bash",
        &[
            "-c".to_string(),
            script.to_string(),
            "macro-git-branch-revision".to_string(),
            repo_path.linux_path.clone(),
        ],
        WSL_GIT_TIMEOUT,
    )
    .await?;
    if !output.status.success() {
        return Err(wsl_git_failure(
            &output,
            "git branch snapshot revision WSL failed",
        ));
    }
    output
        .stdout_text()
        .split_whitespace()
        .next()
        .filter(|value| value.len() == 64 && value.chars().all(|ch| ch.is_ascii_hexdigit()))
        .map(str::to_string)
        .ok_or_else(|| BackendError::Git {
            message: "git branch snapshot revision WSL returned an invalid digest".to_string(),
        })
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
pub struct GitAvailableWorktreeDto {
    pub name: String,
    pub path: String,
    pub branch_name: String,
    pub is_dirty: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitAvailableTaskBranchDto {
    pub name: String,
    pub commit: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTaskStartPointsDto {
    pub worktrees: Vec<GitAvailableWorktreeDto>,
    pub branches: Vec<GitAvailableTaskBranchDto>,
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
    pub snapshot_id: String,
    pub restore_revisions: HashMap<String, String>,
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
    run_contained_git_command_with_timeout(cwd, args, timeout_duration, false)
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

#[derive(Debug, Default, PartialEq, Eq)]
struct PartialCloneConfig {
    extension_remote: Option<String>,
    promisor_remotes: Vec<String>,
    filters: Vec<(String, String)>,
}

impl PartialCloneConfig {
    fn is_partial(&self) -> bool {
        self.extension_remote.is_some()
            || !self.promisor_remotes.is_empty()
            || !self.filters.is_empty()
    }
}

fn config_value_is_true(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "true" | "yes" | "on" | "1"
        )
    })
}

fn detect_partial_clone(repo: &Repository) -> Result<PartialCloneConfig> {
    let config = repo.config()?;
    let mut detected = PartialCloneConfig::default();
    let mut entries = config.entries(None)?;
    while let Some(entry) = entries.next() {
        let entry = entry?;
        let name = entry.name()?;
        let lower_name = name.to_ascii_lowercase();
        let value = entry
            .value()
            .ok()
            .map(str::trim)
            .filter(|value| !value.is_empty());

        if lower_name == "extensions.partialclone" {
            detected.extension_remote = value.map(str::to_string);
            continue;
        }

        let Some(remote_setting) = lower_name.strip_prefix("remote.") else {
            continue;
        };
        if let Some(remote_name) = remote_setting.strip_suffix(".promisor") {
            if config_value_is_true(value) {
                detected.promisor_remotes.push(remote_name.to_string());
            }
        } else if let Some(remote_name) = remote_setting.strip_suffix(".partialclonefilter") {
            if let Some(filter) = value {
                detected
                    .filters
                    .push((remote_name.to_string(), filter.to_string()));
            }
        }
    }
    detected.promisor_remotes.sort();
    detected.promisor_remotes.dedup();
    detected.filters.sort();
    detected.filters.dedup();
    Ok(detected)
}

fn hydrate_review_objects_with_git(
    repo_root: &Path,
    object_id: &str,
    cancellation: Option<Arc<AtomicBool>>,
) -> std::result::Result<String, String> {
    let repo = Repository::discover(repo_root).map_err(|error| error.to_string())?;
    ensure_safe_automatic_hydration_config(&repo).map_err(|error| error.to_string())?;
    let diagnostic_redactions = git_remote_diagnostic_redactions(&repo);
    let args = vec![
        "cat-file".to_string(),
        "-e".to_string(),
        object_id.to_string(),
    ];
    let output = run_contained_git_command_with_timeout_and_cancellation(
        repo_root,
        &args,
        NATIVE_GIT_NETWORK_TIMEOUT,
        true,
        cancellation,
    )
    .map_err(|error| error.to_string())?;
    if output.success {
        return Ok(format!("git {} completed successfully", args.join(" ")));
    }
    let diagnostic = sanitize_git_diagnostic(
        &command_output_text(&output),
        repo_root,
        &diagnostic_redactions,
    );
    Err(format!(
        "git {} exited with code {:?}{}",
        args.join(" "),
        output.code,
        if diagnostic.is_empty() {
            String::new()
        } else {
            format!(": {diagnostic}")
        }
    ))
}

fn git_review_is_cancelled(cancellation: &Option<Arc<AtomicBool>>) -> bool {
    cancellation
        .as_ref()
        .is_some_and(|flag| flag.load(Ordering::Acquire))
}

fn git_remote_diagnostic_redactions(repo: &Repository) -> Vec<String> {
    let Ok(config) = repo.config() else {
        return Vec::new();
    };
    let Ok(mut entries) = config.entries(None) else {
        return Vec::new();
    };
    let mut redactions = HashSet::new();
    while let Some(Ok(entry)) = entries.next() {
        let Ok(name) = entry.name() else {
            continue;
        };
        let lower_name = name.to_ascii_lowercase();
        if !lower_name.starts_with("remote.")
            || (!lower_name.ends_with(".url") && !lower_name.ends_with(".pushurl"))
        {
            continue;
        }
        let Ok(value) = entry.value() else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        redactions.insert(value.to_string());
        if let Ok(url) = url::Url::parse(value) {
            if let Some(host) = url.host_str() {
                redactions.insert(host.to_string());
            }
        } else if let Some((authority, _)) = value.split_once(':') {
            let host = authority
                .rsplit_once('@')
                .map_or(authority, |(_, host)| host);
            if !host.is_empty() && !host.contains('/') && !host.contains('\\') {
                redactions.insert(host.to_string());
            }
        }
    }
    redactions.into_iter().collect()
}

fn sanitize_git_diagnostic(output: &str, repo_root: &Path, redactions: &[String]) -> String {
    let mut sensitive = redactions
        .iter()
        .map(|value| value.to_ascii_lowercase().replace('\\', "/"))
        .collect::<Vec<_>>();
    for path in [Some(repo_root.to_path_buf()), repo_root.canonicalize().ok()]
        .into_iter()
        .flatten()
    {
        sensitive.push(
            path.to_string_lossy()
                .to_ascii_lowercase()
                .replace('\\', "/"),
        );
    }
    output
        .split_whitespace()
        .map(|part| {
            let normalized = part.to_ascii_lowercase().replace('\\', "/");
            if sensitive
                .iter()
                .any(|value| !value.is_empty() && normalized.contains(value))
            {
                return "[redacted]";
            }
            let scp_remote = part.split_once(':').is_some_and(|(authority, path)| {
                authority.contains('@')
                    && !authority.contains('/')
                    && !authority.contains('\\')
                    && !path.is_empty()
            });
            if part.contains("://") || scp_remote {
                "[remote URL]"
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn run_contained_git_command_with_timeout(
    cwd: &Path,
    args: &[String],
    timeout_duration: Duration,
    fail_on_truncated_output: bool,
) -> Result<GitCommandOutput> {
    run_contained_git_command_with_timeout_and_cancellation(
        cwd,
        args,
        timeout_duration,
        fail_on_truncated_output,
        None,
    )
}

fn run_contained_git_command_with_timeout_and_cancellation(
    cwd: &Path,
    args: &[String],
    timeout_duration: Duration,
    fail_on_truncated_output: bool,
    cancellation: Option<Arc<AtomicBool>>,
) -> Result<GitCommandOutput> {
    let repo = Repository::discover(cwd)?;
    ensure_safe_config(&repo)?;
    let cwd = cwd.to_path_buf();
    let args = args.to_vec();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| BackendError::Git {
            message: format!("Failed to create Git command runtime: {error}"),
        })?;

    runtime.block_on(async move {
        let mut command = background_contained_tokio_command("git");
        command.env_clear().envs(
            std::env::vars_os().filter(|(key, _)| !is_git_environment_variable(key.as_os_str())),
        );
        configure_noninteractive_git_command(&mut command);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .current_dir(&cwd)
            .args(&args);
        let mut process =
            ContainedBackgroundProcess::spawn(command).map_err(|error| BackendError::Git {
                message: format!("Failed to run git command '{}': {error}", args.join(" ")),
            })?;
        let stdout = process.take_stdout().ok_or_else(|| BackendError::Git {
            message: format!(
                "Failed to capture stdout for git command '{}'.",
                args.join(" ")
            ),
        })?;
        let stderr = process.take_stderr().ok_or_else(|| BackendError::Git {
            message: format!(
                "Failed to capture stderr for git command '{}'.",
                args.join(" ")
            ),
        })?;
        let stdout_reader =
            tokio::spawn(async move { read_bounded_git_command_output(stdout).await });
        let stderr_reader =
            tokio::spawn(async move { read_bounded_git_command_output(stderr).await });

        enum WaitOutcome {
            Completed(std::io::Result<std::process::ExitStatus>),
            Cancelled,
            TimedOut,
        }
        let wait_for_cancellation = async {
            if let Some(cancellation) = cancellation {
                loop {
                    if cancellation.load(Ordering::Acquire) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            } else {
                std::future::pending::<()>().await;
            }
        };
        let outcome = tokio::select! {
            status = process.wait() => WaitOutcome::Completed(status),
            _ = wait_for_cancellation => WaitOutcome::Cancelled,
            _ = tokio::time::sleep(timeout_duration) => WaitOutcome::TimedOut,
        };
        let status = match outcome {
            WaitOutcome::Completed(status) => status.map_err(|error| BackendError::Git {
                message: format!(
                    "Failed while waiting for git command '{}': {error}",
                    args.join(" ")
                ),
            })?,
            WaitOutcome::Cancelled => {
                let _ = process.terminate_bounded().await;
                stdout_reader.abort();
                stderr_reader.abort();
                return Err(BackendError::Git {
                    message: "Git review was cancelled.".to_string(),
                });
            }
            WaitOutcome::TimedOut => {
                let _ = process.terminate_bounded().await;
                stdout_reader.abort();
                stderr_reader.abort();
                return Err(BackendError::Git {
                    message: format!("Git command '{}' timed out.", args.join(" ")),
                });
            }
        };
        let _ = process.terminate_with_grace(Duration::ZERO).await;
        let ((stdout, stdout_truncated), (stderr, stderr_truncated)) =
            tokio::time::timeout(GIT_COMMAND_OUTPUT_DRAIN_TIMEOUT, async {
                let stdout = stdout_reader.await.map_err(|error| BackendError::Git {
                    message: format!("Git stdout reader failed for '{}': {error}", args.join(" ")),
                })??;
                let stderr = stderr_reader.await.map_err(|error| BackendError::Git {
                    message: format!("Git stderr reader failed for '{}': {error}", args.join(" ")),
                })??;
                Ok::<_, BackendError>((stdout, stderr))
            })
            .await
            .map_err(|_| BackendError::Git {
                message: format!(
                    "Git command '{}' did not close its output streams.",
                    args.join(" ")
                ),
            })??;
        if fail_on_truncated_output && (stdout_truncated || stderr_truncated) {
            return Err(BackendError::Git {
                message: format!("Git command '{}' produced too much output.", args.join(" ")),
            });
        }
        let append_truncation_notice = |bytes: &[u8], truncated: bool| {
            let mut value = String::from_utf8_lossy(bytes).to_string();
            if truncated {
                value.push_str("\n[Git output truncated by Macro]");
            }
            value
        };
        Ok(GitCommandOutput {
            success: status.success(),
            code: status.code(),
            stdout: append_truncation_notice(&stdout, stdout_truncated),
            stderr: append_truncation_notice(&stderr, stderr_truncated),
        })
    })
}

fn configure_noninteractive_git_command(command: &mut tokio::process::Command) {
    command
        .env_remove("GIT_ASKPASS")
        .env_remove("SSH_ASKPASS")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "0")
        .env("GCM_GUI_PROMPT", "0")
        .env("GIT_ALLOW_PROTOCOL", "git:http:https:ssh")
        .env("GIT_CONFIG_COUNT", "3")
        .env("GIT_CONFIG_KEY_0", "core.askPass")
        .env("GIT_CONFIG_VALUE_0", "")
        .env("GIT_CONFIG_KEY_1", "maintenance.auto")
        .env("GIT_CONFIG_VALUE_1", "false")
        .env("GIT_CONFIG_KEY_2", "gc.recentObjectsHook")
        .env("GIT_CONFIG_VALUE_2", "")
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes");
}

async fn read_bounded_git_command_output<R>(mut reader: R) -> std::io::Result<(Vec<u8>, bool)>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;

    let mut retained = Vec::new();
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        let remaining = (MAX_GIT_COMMAND_OUTPUT_BYTES as usize).saturating_sub(retained.len());
        let keep = remaining.min(read);
        retained.extend_from_slice(&buffer[..keep]);
        truncated |= keep < read;
    }
    Ok((retained, truncated))
}

fn run_review_with_missing_object_retry<T, F>(
    git_state: &GitState,
    repo_root: &Path,
    cancellation: Option<Arc<AtomicBool>>,
    operation: F,
) -> Result<T>
where
    F: Fn(&Repository) -> Result<T>,
{
    run_review_with_missing_object_retry_and_hydrator(
        git_state,
        repo_root,
        cancellation,
        operation,
        hydrate_review_objects_with_git,
    )
}

fn run_review_with_missing_object_retry_and_hydrator<T, F, H>(
    git_state: &GitState,
    repo_root: &Path,
    cancellation: Option<Arc<AtomicBool>>,
    operation: F,
    hydrate: H,
) -> Result<T>
where
    F: Fn(&Repository) -> Result<T>,
    H: Fn(&Path, &str, Option<Arc<AtomicBool>>) -> std::result::Result<String, String>,
{
    if git_review_is_cancelled(&cancellation) {
        return Err(BackendError::Git {
            message: "Git review was cancelled.".to_string(),
        });
    }
    let repo = git_state.open_repo(repo_root)?;
    let (first_result, partial_clone) = {
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;
        if git_review_is_cancelled(&cancellation) {
            return Err(BackendError::Git {
                message: "Git review was cancelled.".to_string(),
            });
        }
        let result = operation(&repo);
        let partial_clone = if result
            .as_ref()
            .err()
            .is_some_and(BackendError::is_git_object_missing)
        {
            detect_partial_clone(&repo).unwrap_or_default()
        } else {
            PartialCloneConfig::default()
        };
        if result
            .as_ref()
            .err()
            .is_some_and(BackendError::is_git_object_missing)
        {
            if let Ok(odb) = repo.odb() {
                let _ = odb.refresh();
            }
        }
        (result, partial_clone)
    };

    let first_error = match first_result {
        Ok(_) if git_review_is_cancelled(&cancellation) => {
            return Err(BackendError::Git {
                message: "Git review was cancelled.".to_string(),
            });
        }
        Ok(value) => return Ok(value),
        Err(error) if error.is_git_object_missing() => error,
        Err(error) => return Err(error),
    };
    let object_id = first_error.git_object_id().map(str::to_string);
    if git_review_is_cancelled(&cancellation) {
        return Err(BackendError::Git {
            message: "Git review was cancelled.".to_string(),
        });
    }
    let git_output = if partial_clone.is_partial() && object_id.is_some() {
        match hydrate(
            repo_root,
            object_id.as_deref().unwrap_or_default(),
            cancellation.clone(),
        ) {
            Ok(output) => Some(output),
            Err(_) if git_review_is_cancelled(&cancellation) => {
                return Err(BackendError::Git {
                    message: "Git review was cancelled.".to_string(),
                });
            }
            Err(error) => Some(error),
        }
    } else {
        None
    };
    if git_review_is_cancelled(&cancellation) {
        return Err(BackendError::Git {
            message: "Git review was cancelled.".to_string(),
        });
    }

    // Other commands may already hold a clone of this cached Arc. Refresh the
    // shared handle after Git CLI hydration before replacing the cache entry.
    {
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;
        if git_review_is_cancelled(&cancellation) {
            return Err(BackendError::Git {
                message: "Git review was cancelled.".to_string(),
            });
        }
        if let Ok(odb) = repo.odb() {
            let _ = odb.refresh();
        };
    }

    git_state.invalidate_repo_if_same(repo_root, &repo)?;
    if git_review_is_cancelled(&cancellation) {
        return Err(BackendError::Git {
            message: "Git review was cancelled.".to_string(),
        });
    }
    let refreshed_repo = git_state.open_repo(repo_root)?;
    let retry_result = {
        let refreshed_repo = refreshed_repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;
        if git_review_is_cancelled(&cancellation) {
            return Err(BackendError::Git {
                message: "Git review was cancelled.".to_string(),
            });
        }
        refreshed_repo.odb()?.refresh()?;
        if git_review_is_cancelled(&cancellation) {
            return Err(BackendError::Git {
                message: "Git review was cancelled.".to_string(),
            });
        }
        operation(&refreshed_repo)
    };

    if retry_result.is_ok() && git_review_is_cancelled(&cancellation) {
        return Err(BackendError::Git {
            message: "Git review was cancelled.".to_string(),
        });
    }
    retry_result.map_err(|retry_error| {
        if retry_error.is_git_object_missing() {
            retry_error.with_git_object_diagnostics(
                repo_root,
                partial_clone.is_partial(),
                true,
                git_output,
            )
        } else {
            retry_error
        }
    })
}

struct GitReviewCancellationGuard {
    request_id: String,
}

impl Drop for GitReviewCancellationGuard {
    fn drop(&mut self) {
        if let Some(cancellations) = GIT_REVIEW_CANCELLATIONS.get() {
            if let Ok(mut cancellations) = cancellations.lock() {
                cancellations.active.remove(&self.request_id);
            }
        }
    }
}

fn validate_git_review_request_id(request_id: &str) -> Result<()> {
    if request_id.is_empty()
        || request_id.len() > 128
        || !request_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(BackendError::Validation(
            "Invalid Git review request identifier.".to_string(),
        ));
    }
    Ok(())
}

fn register_git_review_cancellation(
    request_id: Option<&str>,
) -> Result<(Option<Arc<AtomicBool>>, Option<GitReviewCancellationGuard>)> {
    let Some(request_id) = request_id else {
        return Ok((None, None));
    };
    validate_git_review_request_id(request_id)?;
    let cancellation = Arc::new(AtomicBool::new(false));
    let cancellations = GIT_REVIEW_CANCELLATIONS
        .get_or_init(|| Mutex::new(GitReviewCancellationRegistry::default()));
    let mut cancellations = cancellations.lock().map_err(|_| BackendError::Internal {
        message: "Failed to lock Git review cancellation registry".to_string(),
    })?;
    cancellations
        .pre_cancelled
        .retain(|_, cancelled_at| cancelled_at.elapsed() <= GIT_REVIEW_PRE_CANCEL_TTL);
    if cancellations.active.contains_key(request_id) {
        return Err(BackendError::Validation(
            "Git review request identifier is already active.".to_string(),
        ));
    }
    if cancellations.pre_cancelled.remove(request_id).is_some() {
        cancellation.store(true, Ordering::Release);
    }
    cancellations
        .active
        .insert(request_id.to_string(), cancellation.clone());
    Ok((
        Some(cancellation),
        Some(GitReviewCancellationGuard {
            request_id: request_id.to_string(),
        }),
    ))
}

#[tauri::command]
pub async fn git_cancel_review(request_id: String) -> Result<()> {
    validate_git_review_request_id(&request_id)?;
    let cancellations = GIT_REVIEW_CANCELLATIONS
        .get_or_init(|| Mutex::new(GitReviewCancellationRegistry::default()));
    let mut cancellations = cancellations.lock().map_err(|_| BackendError::Internal {
        message: "Failed to lock Git review cancellation registry".to_string(),
    })?;
    if let Some(cancellation) = cancellations.active.get(&request_id) {
        cancellation.store(true, Ordering::Release);
        return Ok(());
    }
    cancellations
        .pre_cancelled
        .retain(|_, cancelled_at| cancelled_at.elapsed() <= GIT_REVIEW_PRE_CANCEL_TTL);
    if cancellations.pre_cancelled.len() >= MAX_GIT_REVIEW_PRE_CANCELLED {
        if let Some(oldest) = cancellations
            .pre_cancelled
            .iter()
            .min_by_key(|(_, cancelled_at)| **cancelled_at)
            .map(|(request_id, _)| request_id.clone())
        {
            cancellations.pre_cancelled.remove(&oldest);
        }
    }
    cancellations
        .pre_cancelled
        .insert(request_id, Instant::now());
    Ok(())
}

pub(crate) fn cancel_all_git_reviews() {
    if let Some(cancellations) = GIT_REVIEW_CANCELLATIONS.get() {
        if let Ok(mut cancellations) = cancellations.lock() {
            for cancellation in cancellations.active.values() {
                cancellation.store(true, Ordering::Release);
            }
            cancellations.pre_cancelled.clear();
        }
    }
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
            let repo_root = repo_root(repo)?;
            let configured_hooks_path = if hooks_path.is_absolute() {
                hooks_path.to_path_buf()
            } else {
                repo_root.join(hooks_path)
            };
            let resolved_hooks_path = normalize_path(&configured_hooks_path);
            let lexical_escape = !resolved_hooks_path.starts_with(&repo_root);
            let linked_escape = resolved_hooks_path
                .canonicalize()
                .is_ok_and(|canonical| !canonical.starts_with(&repo_root));
            if lexical_escape || linked_escape {
                return Err(BackendError::Git {
                    message: "core.hooksPath must be inside the repository".to_string(),
                });
            }
        }
    }
    Ok(())
}

fn ensure_safe_automatic_hydration_config(repo: &Repository) -> Result<()> {
    ensure_safe_config(repo)?;
    let config = repo.config()?;
    let mut entries = config.entries(None)?;
    while let Some(entry) = entries.next() {
        let entry = entry?;
        if !matches!(entry.level(), ConfigLevel::Local | ConfigLevel::Worktree) {
            continue;
        }
        let name = entry.name()?.to_ascii_lowercase();
        let value = entry.value().unwrap_or("").trim();
        if value.is_empty() {
            continue;
        }
        let executable_setting = name == "credential.helper"
            || (name.starts_with("credential.") && name.ends_with(".helper"))
            || name == "core.sshcommand"
            || name == "core.gitproxy"
            || name == "core.alternaterefscommand"
            || name == "gc.recentobjectshook"
            || (name.starts_with("remote.") && name.ends_with(".uploadpack"))
            || (name.starts_with("remote.") && name.ends_with(".vcs"))
            || (name.starts_with("url.")
                && (name.ends_with(".insteadof") || name.ends_with(".pushinsteadof")));
        let local_remote =
            name.starts_with("remote.") && name.ends_with(".url") && is_local_git_remote_url(value);
        if executable_setting || local_remote {
            return Err(BackendError::Git {
                message: format!(
                    "Automatic Git object hydration refused unsafe repository setting '{name}'."
                ),
            });
        }
    }
    Ok(())
}

fn is_local_git_remote_url(value: &str) -> bool {
    let value = value.trim();
    let lower = value.to_ascii_lowercase();
    let windows_drive = value.as_bytes().get(1) == Some(&b':')
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic);
    let scp_remote = value.split_once(':').is_some_and(|(host, path)| {
        !host.is_empty()
            && !host.contains('/')
            && !host.contains('\\')
            && !path.is_empty()
            && !windows_drive
    });
    lower.starts_with("file:")
        || value.starts_with('.')
        || value.starts_with('/')
        || value.starts_with('\\')
        || Path::new(value).is_absolute()
        || windows_drive
        || (!value.contains("://") && !scp_remote)
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
                    old_path: old_path.clone(),
                });
            }
        }

        if status.is_wt_modified() || status.is_wt_deleted() || status.is_wt_renamed() {
            if let Some(path) = path.clone() {
                unstaged.push(GitFileStatus {
                    path,
                    status: status_to_label(status).unwrap_or_else(|| "modified".to_string()),
                    old_path,
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
    request_id: Option<String>,
) -> Result<GitReviewSnapshotDto> {
    let (cancellation, _cancellation_guard) =
        register_git_review_cancellation(request_id.as_deref())?;
    if parse_wsl_repo_path(&repo_path).is_some() {
        return Err(unsupported_wsl_git_operation("git_review_snapshot"));
    }

    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let operation_cancellation = cancellation.clone();
        run_review_with_missing_object_retry(&git_state, &validated, cancellation, |repo| {
            review::build_git_review_snapshot_with_cancellation(repo, &validated, || {
                git_review_is_cancelled(&operation_cancellation)
            })
            .map_err(|error| error.with_git_object_context(None, "git_review_snapshot"))
        })
    })
    .await
    .map_err(to_join_error)?
}

const DIRECT_CHECKPOINTS_DIR: &str = "direct-checkpoints";
const DIRECT_CHECKPOINT_STORAGE_LOCK_KEY: &str = "__direct_checkpoint_storage__";
static DIRECT_CHECKPOINT_LOCKS: OnceLock<Mutex<HashMap<String, Weak<Mutex<()>>>>> = OnceLock::new();
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
.envrc\n\
.dev.vars\n\
*.pem\n\
*.key\n\
*.p12\n\
*.pfx\n\
*.jks\n\
*.ppk\n\
id_rsa\n\
id_ed25519\n\
id_ecdsa\n\
.npmrc\n\
.pypirc\n\
.netrc\n\
.git-credentials\n\
.ssh/\n\
.aws/credentials\n\
.docker/config.json\n\
.kube/config\n\
kubeconfig\n\
terraform.tfstate\n\
terraform.tfstate.*\n\
*service-account*.json\n\
credentials.json\n\
client_secret_*.json\n\
.streamlit/secrets.toml\n";

fn is_direct_checkpoint_excluded_path(path: &Path) -> bool {
    let components = path
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => Some(value.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>();
    if components.iter().any(|component| {
        let component = component.to_ascii_lowercase();
        matches!(
            component.as_str(),
            ".git" | ".macro" | "node_modules" | "vendor" | ".pnpm" | "dist" | "build" | "coverage"
        ) || component == ".env"
            || component.starts_with(".env.")
            || component == ".envrc"
            || component == ".dev.vars"
            || component.ends_with(".pem")
            || component.ends_with(".key")
            || component.ends_with(".p12")
            || component.ends_with(".pfx")
            || component.ends_with(".jks")
            || component.ends_with(".ppk")
            || matches!(component.as_str(), "id_rsa" | "id_ed25519" | "id_ecdsa")
            || component == "kubeconfig"
            || component == "terraform.tfstate"
            || component.starts_with("terraform.tfstate.")
            || (component.ends_with(".json") && component.contains("service-account"))
            || component == "credentials.json"
            || (component.ends_with(".json") && component.starts_with("client_secret_"))
            || matches!(
                component.as_str(),
                ".npmrc" | ".pypirc" | ".netrc" | ".git-credentials"
            )
    }) {
        return true;
    }
    let lower = components
        .iter()
        .map(|component| component.to_ascii_lowercase())
        .collect::<Vec<_>>();
    lower.iter().enumerate().any(|(index, component)| {
        component == ".ssh"
            || (component == ".aws"
                && lower
                    .get(index + 1)
                    .is_some_and(|next| next == "credentials"))
            || (component == ".docker"
                && lower
                    .get(index + 1)
                    .is_some_and(|next| next == "config.json"))
            || (component == ".kube" && lower.get(index + 1).is_some_and(|next| next == "config"))
            || (component == ".streamlit"
                && lower
                    .get(index + 1)
                    .is_some_and(|next| next == "secrets.toml"))
    })
}

fn direct_worktree_path_has_linked_parent(root: &Path, relative: &Path) -> Result<bool> {
    let component_count = relative.components().count();
    let mut current = root.to_path_buf();
    for (index, component) in relative.components().enumerate() {
        let std::path::Component::Normal(segment) = component else {
            return Err(BackendError::Validation(
                "Direct checkpoint path must remain relative.".to_string(),
            ));
        };
        if index + 1 == component_count {
            break;
        }
        current.push(segment);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if direct_checkpoint_metadata_is_link(&metadata) => return Ok(true),
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => return Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(BackendError::Io {
                    message: format!("Failed to inspect direct checkpoint path: {error}"),
                    source: error,
                });
            }
        }
    }
    Ok(false)
}

fn collect_direct_checkpoint_files(
    repo: &Repository,
    root: &Path,
    current: &Path,
    output: &mut Vec<PathBuf>,
    scanned_entries: &mut usize,
) -> Result<()> {
    for entry in fs::read_dir(current).map_err(|error| BackendError::Io {
        message: format!("Failed to inspect direct checkpoint worktree: {error}"),
        source: error,
    })? {
        let entry = entry.map_err(|error| BackendError::Io {
            message: format!("Failed to inspect direct checkpoint entry: {error}"),
            source: error,
        })?;
        *scanned_entries = scanned_entries.saturating_add(1);
        if *scanned_entries > MAX_DIRECT_REVIEW_PATHS {
            return Err(BackendError::FilesystemFileTooLarge {
                message: "Direct checkpoint contains too many filesystem entries.".to_string(),
            });
        }
        let path = entry.path();
        let relative = path.strip_prefix(root).map_err(|_| {
            BackendError::Validation(
                "Direct checkpoint scan escaped the project directory.".to_string(),
            )
        })?;
        if is_direct_checkpoint_excluded_path(relative) {
            continue;
        }
        let metadata = fs::symlink_metadata(&path).map_err(|error| BackendError::Io {
            message: format!("Failed to inspect direct checkpoint entry: {error}"),
            source: error,
        })?;
        if direct_checkpoint_metadata_is_link(&metadata) {
            #[cfg(unix)]
            {
                output.push(relative.to_path_buf());
            }
            #[cfg(windows)]
            if metadata.file_type().is_symlink()
                && !fs::metadata(&path).is_ok_and(|target| target.is_dir())
            {
                output.push(relative.to_path_buf());
            }
            continue;
        }
        if metadata.is_dir() {
            if fs::symlink_metadata(path.join(".git")).is_ok() {
                return Err(BackendError::DirectCheckpointCorrupt {
                    message:
                        "Macro cannot checkpoint a nested Git repository in direct review mode."
                            .to_string(),
                    checkpoint_id: direct_checkpoint_repo_id(repo),
                    object_id: None,
                    operation: Some("direct_checkpoint_init_gitlink".to_string()),
                    retry_attempted: false,
                    accepted_history_at_risk: false,
                    git_output: None,
                });
            }
            collect_direct_checkpoint_files(repo, root, &path, output, scanned_entries)?;
        } else if metadata.is_file() {
            output.push(relative.to_path_buf());
        }
    }
    Ok(())
}

fn reject_direct_checkpoint_excluded_path(path: &Path) -> Result<()> {
    if is_direct_checkpoint_excluded_path(path) {
        return Err(BackendError::Validation(
            "This path is excluded from Macro's internal review checkpoint.".to_string(),
        ));
    }
    Ok(())
}

fn filter_direct_checkpoint_snapshot(snapshot: &mut GitReviewSnapshotDto) {
    snapshot
        .changes
        .retain(|change| !is_direct_checkpoint_excluded_path(Path::new(&change.path)));
    snapshot
        .staged_paths
        .retain(|path| !is_direct_checkpoint_excluded_path(Path::new(path)));
    snapshot
        .conflicted_files
        .retain(|path| !is_direct_checkpoint_excluded_path(Path::new(path)));
    snapshot.is_clean = snapshot.changes.is_empty() && snapshot.conflicted_files.is_empty();
}

fn direct_checkpoint_key(task_id: &str, project_path: &Path) -> String {
    let identity_path = project_path
        .canonicalize()
        .unwrap_or_else(|_| project_path.to_path_buf());
    direct_checkpoint_id(task_id, &identity_path)
}

fn direct_checkpoint_known_marker(checkpoint_root: &Path, checkpoint_id: &str) -> PathBuf {
    checkpoint_root.join(format!(".known-{checkpoint_id}"))
}

fn direct_checkpoint_known_marker_exists(marker_path: &Path, checkpoint_id: &str) -> Result<bool> {
    match fs::symlink_metadata(marker_path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(BackendError::Io {
            message: format!("Failed to inspect direct checkpoint marker: {error}"),
            source: error,
        }),
        Ok(metadata) if metadata.is_file() && !direct_checkpoint_metadata_is_link(&metadata) => {
            Ok(true)
        }
        Ok(_) => Err(direct_checkpoint_storage_corruption(
            checkpoint_id,
            "direct_checkpoint_marker",
        )),
    }
}

fn direct_checkpoint_storage_corruption(checkpoint_id: &str, operation: &str) -> BackendError {
    BackendError::DirectCheckpointCorrupt {
        message: "Macro's internal review checkpoint storage is invalid.".to_string(),
        checkpoint_id: checkpoint_id.to_string(),
        object_id: None,
        operation: Some(operation.to_string()),
        retry_attempted: false,
        accepted_history_at_risk: true,
        git_output: None,
    }
}

fn ensure_direct_checkpoint_exclusions(checkpoint_path: &Path, checkpoint_id: &str) -> Result<()> {
    let checkpoint_root = checkpoint_path.parent().ok_or_else(|| {
        direct_checkpoint_storage_corruption(checkpoint_id, "direct_checkpoint_exclusions")
    })?;
    let checkpoint_name = checkpoint_path.file_name().ok_or_else(|| {
        direct_checkpoint_storage_corruption(checkpoint_id, "direct_checkpoint_exclusions")
    })?;
    let checkpoint_root = CapabilityDir::open_ambient_dir(checkpoint_root, ambient_authority())
        .map_err(|error| BackendError::Io {
            message: format!("Failed to retain direct checkpoint storage: {error}"),
            source: error,
        })?;
    let checkpoint =
        checkpoint_root
            .open_dir(checkpoint_name)
            .map_err(|error| BackendError::Io {
                message: format!("Failed to retain direct checkpoint directory: {error}"),
                source: error,
            })?;
    let info_path = Path::new("info");
    match checkpoint.symlink_metadata(info_path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => {
            return Err(direct_checkpoint_storage_corruption(
                checkpoint_id,
                "direct_checkpoint_exclusions",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            checkpoint
                .create_dir(info_path)
                .map_err(|error| BackendError::Io {
                    message: format!("Failed to create direct checkpoint exclusions: {error}"),
                    source: error,
                })?;
        }
        Err(error) => {
            return Err(BackendError::Io {
                message: format!("Failed to inspect direct checkpoint exclusions: {error}"),
                source: error,
            });
        }
    }
    let info = checkpoint.open_dir(info_path).map_err(|_| {
        direct_checkpoint_storage_corruption(checkpoint_id, "direct_checkpoint_exclusions")
    })?;

    let exclude_path = Path::new("exclude");
    let existing = match info.symlink_metadata(exclude_path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => true,
        Ok(_) => {
            return Err(direct_checkpoint_storage_corruption(
                checkpoint_id,
                "direct_checkpoint_exclusions",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            return Err(BackendError::Io {
                message: format!("Failed to inspect direct checkpoint exclude file: {error}"),
                source: error,
            });
        }
    };
    if existing
        && info
            .read_to_string(exclude_path)
            .is_ok_and(|contents| contents == DIRECT_CHECKPOINT_EXCLUDES)
    {
        return Ok(());
    }

    let temporary_name = format!("exclude.macro-{}.tmp", std::process::id());
    let temporary_path = Path::new(&temporary_name);
    if let Ok(metadata) = info.symlink_metadata(temporary_path) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(direct_checkpoint_storage_corruption(
                checkpoint_id,
                "direct_checkpoint_exclusions",
            ));
        }
        info.remove_file(temporary_path)
            .map_err(|error| BackendError::Io {
                message: format!("Failed to clear stale checkpoint exclude file: {error}"),
                source: error,
            })?;
    }
    let mut options = CapabilityOpenOptions::new();
    options.write(true).create_new(true);
    let mut temporary =
        info.open_with(temporary_path, &options)
            .map_err(|error| BackendError::Io {
                message: format!("Failed to create checkpoint exclude file: {error}"),
                source: error,
            })?;
    use std::io::Write;
    temporary
        .write_all(DIRECT_CHECKPOINT_EXCLUDES.as_bytes())
        .and_then(|_| temporary.sync_all())
        .map_err(|error| BackendError::Io {
            message: format!("Failed to persist checkpoint exclusions: {error}"),
            source: error,
        })?;
    drop(temporary);
    #[cfg(windows)]
    if existing {
        info.remove_file(exclude_path)
            .map_err(|error| BackendError::Io {
                message: format!("Failed to replace checkpoint exclusions: {error}"),
                source: error,
            })?;
    }
    info.rename(temporary_path, &info, exclude_path)
        .map_err(|error| BackendError::Io {
            message: format!("Failed to publish checkpoint exclusions: {error}"),
            source: error,
        })?;
    Ok(())
}

fn direct_checkpoint_operation_lock(checkpoint_id: &str) -> Result<Arc<Mutex<()>>> {
    let locks = DIRECT_CHECKPOINT_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks.lock().map_err(|_| BackendError::Internal {
        message: "Failed to lock direct checkpoint registry".to_string(),
    })?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(checkpoint_id).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(checkpoint_id.to_string(), Arc::downgrade(&lock));
    Ok(lock)
}

fn direct_project_operation_lock_key(project_path: &Path) -> String {
    let canonical = project_path
        .canonicalize()
        .unwrap_or_else(|_| project_path.to_path_buf());
    let key = canonical.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    return key.to_ascii_lowercase();
    #[cfg(not(windows))]
    key
}

fn register_direct_review_authorization(
    task_id: &str,
    project_path: &Path,
    checkpoint_id: &str,
    checkpoint_revision: &str,
    restore_revisions: &HashMap<String, String>,
) -> Result<String> {
    let snapshot_id = uuid::Uuid::new_v4().simple().to_string();
    let registry = DIRECT_REVIEW_AUTHORIZATIONS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut registry = registry.lock().map_err(|_| BackendError::Internal {
        message: "Failed to lock direct review snapshot registry".to_string(),
    })?;
    registry.retain(|_, entry| entry.created_at.elapsed() <= DIRECT_REVIEW_SNAPSHOT_TTL);
    while registry.len() >= MAX_DIRECT_REVIEW_SNAPSHOTS {
        let Some(oldest) = registry
            .iter()
            .min_by_key(|(_, entry)| entry.created_at)
            .map(|(id, _)| id.clone())
        else {
            break;
        };
        registry.remove(&oldest);
    }
    registry.insert(
        snapshot_id.clone(),
        DirectReviewAuthorization {
            task_id: task_id.to_string(),
            project_key: direct_project_operation_lock_key(project_path),
            checkpoint_id: checkpoint_id.to_string(),
            checkpoint_revision: checkpoint_revision.to_string(),
            restore_revisions: restore_revisions.clone(),
            created_at: Instant::now(),
        },
    );
    Ok(snapshot_id)
}

fn register_direct_review_authorization_if_checkpoint_unchanged(
    repo: &Repository,
    expected_checkpoint_revision: &str,
    task_id: &str,
    project_path: &Path,
    checkpoint_id: &str,
    restore_revisions: &HashMap<String, String>,
) -> Result<String> {
    if direct_checkpoint_revision(repo)? != expected_checkpoint_revision {
        return Err(BackendError::RevisionConflict {
            message: "The direct checkpoint changed while its review snapshot was loaded."
                .to_string(),
        });
    }
    register_direct_review_authorization(
        task_id,
        project_path,
        checkpoint_id,
        expected_checkpoint_revision,
        restore_revisions,
    )
}

fn resolve_direct_review_authorization(
    snapshot_id: &str,
    task_id: &str,
    project_path: &Path,
    checkpoint_id: &str,
    checkpoint_revision: &str,
    paths: &[String],
) -> Result<HashMap<String, String>> {
    let registry = DIRECT_REVIEW_AUTHORIZATIONS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut registry = registry.lock().map_err(|_| BackendError::Internal {
        message: "Failed to lock direct review snapshot registry".to_string(),
    })?;
    registry.retain(|_, entry| entry.created_at.elapsed() <= DIRECT_REVIEW_SNAPSHOT_TTL);
    let authorization =
        registry
            .get(snapshot_id)
            .ok_or_else(|| BackendError::RevisionConflict {
                message: "The direct-review snapshot is absent or expired.".to_string(),
            })?;
    if authorization.task_id != task_id
        || authorization.project_key != direct_project_operation_lock_key(project_path)
        || authorization.checkpoint_id != checkpoint_id
        || authorization.checkpoint_revision != checkpoint_revision
    {
        return Err(BackendError::RevisionConflict {
            message: "The direct-review snapshot belongs to another task or project.".to_string(),
        });
    }
    paths
        .iter()
        .map(|path| {
            authorization
                .restore_revisions
                .get(path)
                .cloned()
                .map(|revision| (path.clone(), revision))
                .ok_or_else(|| BackendError::RevisionConflict {
                    message: format!(
                        "The direct-review snapshot does not authorize the selected path: {path}"
                    ),
                })
        })
        .collect()
}

fn direct_checkpoint_revision(repo: &Repository) -> Result<String> {
    let head = repo
        .head()?
        .target()
        .ok_or_else(|| BackendError::DirectCheckpointCorrupt {
            message: "Macro's internal review checkpoint HEAD has no target.".to_string(),
            checkpoint_id: direct_checkpoint_repo_id(repo),
            object_id: None,
            operation: Some("direct_checkpoint_revision".to_string()),
            retry_attempted: false,
            accepted_history_at_risk: true,
            git_output: None,
        })?;
    let mut index = repo.index()?;
    index.read(true)?;
    let mut hasher = Sha256::new();
    hasher.update(head.as_bytes());
    for (entry_count, entry) in index.iter().enumerate() {
        if entry_count >= MAX_DIRECT_REVIEW_PATHS {
            return Err(BackendError::FilesystemFileTooLarge {
                message: "Direct checkpoint index path limit exceeded.".to_string(),
            });
        }
        hasher.update((entry.path.len() as u64).to_le_bytes());
        hasher.update(&entry.path);
        hasher.update(entry.id.as_bytes());
        hasher.update(entry.mode.to_le_bytes());
        hasher.update(entry.flags.to_le_bytes());
        hasher.update(entry.flags_extended.to_le_bytes());
    }
    Ok(encode_direct_restore_digest(&hasher.finalize().into()))
}

fn invalidate_direct_review_authorizations(checkpoint_id: &str) {
    if let Some(registry) = DIRECT_REVIEW_AUTHORIZATIONS.get() {
        if let Ok(mut registry) = registry.lock() {
            registry.retain(|_, entry| entry.checkpoint_id != checkpoint_id);
        }
    }
}

fn with_direct_project_operation_lock<T, F>(project_path: &Path, operation: F) -> Result<T>
where
    F: FnOnce() -> Result<T>,
{
    let lock = direct_checkpoint_operation_lock(&direct_project_operation_lock_key(project_path))?;
    let _guard = lock.lock().map_err(|_| BackendError::Internal {
        message: "Failed to lock direct checkpoint project".to_string(),
    })?;
    operation()
}

fn with_direct_checkpoint_storage_lock<T, F>(operation: F) -> Result<T>
where
    F: FnOnce() -> Result<T>,
{
    let lock = direct_checkpoint_operation_lock(DIRECT_CHECKPOINT_STORAGE_LOCK_KEY)?;
    let _guard = lock.lock().map_err(|_| BackendError::Internal {
        message: "Failed to lock direct checkpoint storage".to_string(),
    })?;
    operation()
}

fn with_locked_direct_checkpoint<T, F>(
    app: &AppHandle,
    workspace: &Path,
    task_id: &str,
    project_path: &str,
    checkpoint_id: Option<&str>,
    create: bool,
    operation: F,
) -> Result<T>
where
    F: FnOnce(&Repository, &Path) -> Result<T>,
{
    reject_unsupported_direct_project_path(project_path)?;
    let validated = validate_repo_path(project_path, workspace)?;
    with_direct_project_operation_lock(&validated, || {
        let repo = open_direct_checkpoint(app, task_id, &validated, checkpoint_id, create)?;
        operation(&repo, &validated)
    })
}

fn reject_unsupported_direct_project_path(project_path: &str) -> Result<()> {
    if parse_wsl_unc_path(project_path).is_some() {
        return Err(BackendError::Validation(
            "Direct review for WSL projects is unavailable until Macro can preserve Linux file modes safely."
                .to_string(),
        ));
    }
    Ok(())
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
    if owner != direct_checkpoint_task_segment(task_id) {
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
            if let Err(error) = fs::create_dir(&checkpoint_root) {
                if error.kind() != std::io::ErrorKind::AlreadyExists {
                    return Err(BackendError::Io {
                        message: format!("Failed to create direct checkpoint root: {error}"),
                        source: error,
                    });
                }
            }
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
            match fs::create_dir(&checkpoint_path) {
                Ok(()) => true,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
                Err(error) => {
                    return Err(BackendError::Io {
                        message: format!("Failed to create direct checkpoint directory: {error}"),
                        source: error,
                    });
                }
            }
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
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| BackendError::Filesystem {
            message: format!(
                "Failed to resolve Macro application data directory: {}",
                error
            ),
        })?;
    open_direct_checkpoint_at(&app_data_dir, task_id, project_path, checkpoint_id, create)
}

fn initialize_created_direct_checkpoint<F>(
    checkpoint_path: &Path,
    checkpoint_id: &str,
    initialize: F,
) -> Result<()>
where
    F: FnOnce() -> Result<()>,
{
    if let Err(initialization_error) = initialize() {
        if fs::remove_dir_all(checkpoint_path).is_err() {
            return Err(BackendError::DirectCheckpointCorrupt {
                message: "Macro could not finish or roll back the new internal review checkpoint. The incomplete checkpoint was preserved for diagnosis.".to_string(),
                checkpoint_id: checkpoint_id.to_string(),
                object_id: None,
                operation: Some("direct_checkpoint_initialize".to_string()),
                retry_attempted: false,
                accepted_history_at_risk: false,
                git_output: None,
            });
        }
        return Err(initialization_error);
    }
    Ok(())
}

fn open_direct_checkpoint_at(
    app_data_dir: &Path,
    task_id: &str,
    project_path: &Path,
    checkpoint_id: Option<&str>,
    create: bool,
) -> Result<Repository> {
    with_direct_checkpoint_storage_lock(|| {
        open_direct_checkpoint_at_locked(app_data_dir, task_id, project_path, checkpoint_id, create)
    })
}

fn open_direct_checkpoint_at_locked(
    app_data_dir: &Path,
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
    let expected = project_path
        .canonicalize()
        .map_err(|error| BackendError::Io {
            message: format!("Failed to resolve direct project path: {}", error),
            source: error,
        })?;

    let has_persisted_checkpoint_id = checkpoint_id.is_some();
    let checkpoint_id =
        match checkpoint_id {
            Some(checkpoint_id) => {
                let checkpoint_id = validate_direct_checkpoint_owner(checkpoint_id, task_id)
                    .map_err(|error| BackendError::DirectCheckpointMissing {
                        message: format!(
                            "Macro's internal checkpoint identifier is invalid: {error}"
                        ),
                        checkpoint_id: checkpoint_id.to_string(),
                        project_path: project_path.display().to_string(),
                    })?;
                checkpoint_id.to_string()
            }
            None => direct_checkpoint_key(task_id, &expected),
        };
    let Some((checkpoint_root, canonical_root)) =
        resolve_direct_checkpoint_root(app_data_dir, create).map_err(|error| match error {
            BackendError::Validation(_) => {
                direct_checkpoint_storage_corruption(&checkpoint_id, "direct_checkpoint_root")
            }
            other => other,
        })?
    else {
        return Err(BackendError::DirectCheckpointMissing {
            message: "Macro's internal review checkpoint does not exist.".to_string(),
            checkpoint_id,
            project_path: project_path.display().to_string(),
        });
    };
    let checkpoint_path = checkpoint_root.join(&checkpoint_id);
    let marker_path = direct_checkpoint_known_marker(&canonical_root, &checkpoint_id);
    let marker_exists = direct_checkpoint_known_marker_exists(&marker_path, &checkpoint_id)?;
    let checkpoint_is_missing = fs::symlink_metadata(&checkpoint_path)
        .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound);
    if create && checkpoint_is_missing && marker_exists {
        return Err(BackendError::DirectCheckpointMissing {
            message: "Macro's internal review checkpoint was removed after initialization."
                .to_string(),
            checkpoint_id,
            project_path: project_path.display().to_string(),
        });
    }
    let Some((checkpoint_path, checkpoint_created)) =
        resolve_direct_checkpoint_path(&checkpoint_root, &canonical_root, &checkpoint_id, create)
            .map_err(|error| match error {
            BackendError::Validation(_) => {
                direct_checkpoint_storage_corruption(&checkpoint_id, "direct_checkpoint_path")
            }
            other => other,
        })?
    else {
        return Err(BackendError::DirectCheckpointMissing {
            message: "Macro's internal review checkpoint does not exist.".to_string(),
            checkpoint_id,
            project_path: project_path.display().to_string(),
        });
    };

    if checkpoint_created {
        initialize_created_direct_checkpoint(&checkpoint_path, &checkpoint_id, || {
            let repo =
                Repository::init_bare(&checkpoint_path).map_err(|error| BackendError::Git {
                    message: format!("Failed to initialize direct checkpoint: {}", error),
                })?;
            {
                let mut config = repo.config().map_err(|error| BackendError::Git {
                    message: format!("Failed to configure direct checkpoint: {}", error),
                })?;
                config
                    .set_bool("core.bare", false)
                    .map_err(|error| BackendError::Git {
                        message: format!(
                            "Failed to configure direct checkpoint worktree: {}",
                            error
                        ),
                    })?;
                config
                    .set_str("core.worktree", &expected.to_string_lossy())
                    .map_err(|error| BackendError::Git {
                        message: format!("Failed to configure direct checkpoint path: {}", error),
                    })?;
                config
                    .set_str("macro.taskId", task_id)
                    .map_err(|error| BackendError::Git {
                        message: format!("Failed to bind direct checkpoint task: {}", error),
                    })?;
            }
            ensure_direct_checkpoint_exclusions(&checkpoint_path, &checkpoint_id)
        })?;
    } else {
        ensure_direct_checkpoint_exclusions(&checkpoint_path, &checkpoint_id)?;
    }

    let repo = match Repository::open(&checkpoint_path) {
        Ok(repo) => repo,
        Err(_open_error) if has_persisted_checkpoint_id => {
            let bare = Repository::open_bare(&checkpoint_path).map_err(|_| {
                BackendError::DirectCheckpointCorrupt {
                    message: "Macro's internal review checkpoint cannot be opened.".to_string(),
                    checkpoint_id: checkpoint_id.clone(),
                    object_id: None,
                    operation: Some("direct_checkpoint_open".to_string()),
                    retry_attempted: false,
                    accepted_history_at_risk: true,
                    git_output: None,
                }
            })?;
            let configured = bare
                .config()
                .and_then(|config| config.get_path("core.worktree"));
            if configured.as_ref().is_ok_and(|configured| {
                configured != project_path
                    && (!cfg!(windows)
                        || !configured
                            .to_string_lossy()
                            .eq_ignore_ascii_case(&project_path.to_string_lossy()))
            }) {
                return Err(BackendError::DirectCheckpointProjectMismatch {
                    message: "Macro's internal review checkpoint belongs to another project path."
                        .to_string(),
                    checkpoint_id,
                });
            }
            return Err(BackendError::DirectCheckpointCorrupt {
                message: "Macro's internal review checkpoint cannot be opened.".to_string(),
                checkpoint_id,
                object_id: None,
                operation: Some("direct_checkpoint_open".to_string()),
                retry_attempted: false,
                accepted_history_at_risk: true,
                git_output: None,
            });
        }
        Err(_error) => {
            return Err(BackendError::DirectCheckpointCorrupt {
                message: "Macro's internal review checkpoint cannot be opened.".to_string(),
                checkpoint_id,
                object_id: None,
                operation: Some("direct_checkpoint_open".to_string()),
                retry_attempted: false,
                accepted_history_at_risk: true,
                git_output: None,
            })
        }
    };
    {
        let config = repo.config().map_err(|_| {
            direct_checkpoint_storage_corruption(&checkpoint_id, "direct_checkpoint_config")
        })?;
        let configured_worktree = match config.get_path("core.worktree") {
            Ok(path) => path,
            Err(error) if error.code() == git2::ErrorCode::NotFound => {
                return Err(direct_checkpoint_storage_corruption(
                    &checkpoint_id,
                    "direct_checkpoint_worktree",
                ));
            }
            Err(_) => {
                return Err(direct_checkpoint_storage_corruption(
                    &checkpoint_id,
                    "direct_checkpoint_worktree",
                ));
            }
        };
        let configured_matches = configured_worktree
            .canonicalize()
            .map(|actual| actual == expected)
            .unwrap_or(false);
        if !configured_matches {
            return Err(BackendError::DirectCheckpointProjectMismatch {
                message: "Macro's internal review checkpoint belongs to another project path."
                    .to_string(),
                checkpoint_id,
            });
        }
        match config.get_string("macro.taskId") {
            Ok(owner) if owner != task_id => {
                return Err(BackendError::DirectCheckpointProjectMismatch {
                    message: "Macro's internal review checkpoint belongs to another task."
                        .to_string(),
                    checkpoint_id,
                });
            }
            Err(error) if error.code() == git2::ErrorCode::NotFound => {
                return Err(BackendError::DirectCheckpointCorrupt {
                    message: "Macro cannot prove who owns this legacy internal review checkpoint; it was preserved.".to_string(),
                    checkpoint_id,
                    object_id: None,
                    operation: Some("direct_checkpoint_owner".to_string()),
                    retry_attempted: false,
                    accepted_history_at_risk: true,
                    git_output: None,
                });
            }
            Err(_) => {
                return Err(direct_checkpoint_storage_corruption(
                    &checkpoint_id,
                    "direct_checkpoint_owner",
                ));
            }
            Ok(_) => {}
        }
    }
    if create && !direct_checkpoint_known_marker_exists(&marker_path, &checkpoint_id)? {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker_path)
            .and_then(|file| file.sync_all())
            .map_err(|error| BackendError::Io {
                message: format!("Failed to record direct checkpoint identity: {error}"),
                source: error,
            })?;
    }
    Ok(repo)
}

fn direct_checkpoint_repo_id(repo: &Repository) -> String {
    repo.path()
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("unknown")
        .to_string()
}

fn verify_direct_checkpoint_blob(
    repo: &Repository,
    oid: Oid,
    operation: &str,
    cancellation: Option<&Arc<AtomicBool>>,
    budget: &mut DirectCheckpointVerificationBudget,
) -> Result<()> {
    budget.consume_object()?;
    let odb = repo.odb().map_err(|error| {
        BackendError::git_object_missing(error, Some(oid.to_string()), Some(operation.to_string()))
    })?;
    let (mut reader, size, kind) = odb.reader(oid).map_err(|error| {
        BackendError::git_object_missing(error, Some(oid.to_string()), Some(operation.to_string()))
    })?;
    if kind != git2::ObjectType::Blob {
        return Err(BackendError::DirectCheckpointCorrupt {
            message: "Macro's internal review checkpoint contains an invalid file object."
                .to_string(),
            checkpoint_id: direct_checkpoint_repo_id(repo),
            object_id: Some(oid.to_string()),
            operation: Some(operation.to_string()),
            retry_attempted: false,
            accepted_history_at_risk: true,
            git_output: None,
        });
    }
    if size > budget.remaining_bytes {
        return Err(BackendError::FilesystemFileTooLarge {
            message: "Direct checkpoint verification budget exceeded.".to_string(),
        });
    }
    budget.remaining_bytes -= size;
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {size}\0").as_bytes());
    let mut bytes_read_total = 0usize;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return Err(BackendError::Git {
                message: "Git review was cancelled.".to_string(),
            });
        }
        let bytes_read = reader.read(&mut buffer).map_err(|error| BackendError::Io {
            message: format!("Failed to verify direct checkpoint object: {error}"),
            source: error,
        })?;
        if bytes_read == 0 {
            break;
        }
        bytes_read_total = bytes_read_total.saturating_add(bytes_read);
        hasher.update(&buffer[..bytes_read]);
    }
    let actual_oid =
        Oid::from_bytes(hasher.finalize().as_slice()).map_err(|error| BackendError::Git {
            message: format!("Failed to verify direct checkpoint object identity: {error}"),
        })?;
    if bytes_read_total != size || actual_oid != oid {
        return Err(BackendError::DirectCheckpointCorrupt {
            message: "Macro's internal review checkpoint contains an altered file object."
                .to_string(),
            checkpoint_id: direct_checkpoint_repo_id(repo),
            object_id: Some(oid.to_string()),
            operation: Some(operation.to_string()),
            retry_attempted: false,
            accepted_history_at_risk: true,
            git_output: None,
        });
    }
    Ok(())
}

fn verify_direct_checkpoint_tree(
    repo: &Repository,
    tree_id: Oid,
    visited_trees: &mut HashSet<Oid>,
    visited_blobs: &mut HashSet<Oid>,
    cancellation: Option<&Arc<AtomicBool>>,
    budget: &mut DirectCheckpointVerificationBudget,
) -> Result<()> {
    if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err(BackendError::Git {
            message: "Git review was cancelled.".to_string(),
        });
    }
    if !visited_trees.insert(tree_id) {
        return Ok(());
    }
    budget.consume_object()?;
    let tree = repo.find_tree(tree_id).map_err(|error| {
        BackendError::git_object_missing(
            error,
            Some(tree_id.to_string()),
            Some("direct_checkpoint_head_tree".to_string()),
        )
    })?;
    for entry in tree.iter() {
        if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return Err(BackendError::Git {
                message: "Git review was cancelled.".to_string(),
            });
        }
        if entry.filemode() == 0o160000 {
            return Err(BackendError::DirectCheckpointCorrupt {
                message: "Macro's internal review checkpoint contains an unsupported nested Git repository.".to_string(),
                checkpoint_id: direct_checkpoint_repo_id(repo),
                object_id: Some(entry.id().to_string()),
                operation: Some("direct_checkpoint_head_gitlink".to_string()),
                retry_attempted: false,
                accepted_history_at_risk: true,
                git_output: None,
            });
        }
        match entry.kind() {
            Some(git2::ObjectType::Tree) => verify_direct_checkpoint_tree(
                repo,
                entry.id(),
                visited_trees,
                visited_blobs,
                cancellation,
                budget,
            )?,
            Some(git2::ObjectType::Blob) => {
                if !visited_blobs.insert(entry.id()) {
                    continue;
                }
                verify_direct_checkpoint_blob(
                    repo,
                    entry.id(),
                    "direct_checkpoint_head_blob",
                    cancellation,
                    budget,
                )?;
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
fn verify_direct_checkpoint_history(repo: &Repository) -> Result<Oid> {
    verify_direct_checkpoint_history_with_cancellation(repo, None)
}

#[cfg(test)]
fn verify_direct_checkpoint_history_with_cancellation(
    repo: &Repository,
    cancellation: Option<&Arc<AtomicBool>>,
) -> Result<Oid> {
    let mut budget = DirectCheckpointVerificationBudget::new();
    verify_direct_checkpoint_history_with_budget(repo, cancellation, &mut budget)
}

fn verify_direct_checkpoint_history_with_budget(
    repo: &Repository,
    cancellation: Option<&Arc<AtomicBool>>,
    budget: &mut DirectCheckpointVerificationBudget,
) -> Result<Oid> {
    let head = repo.head().map_err(|error| {
        BackendError::git_object_missing(
            error,
            None,
            Some("direct_checkpoint_head_reference".to_string()),
        )
    })?;
    let head_id = head
        .target()
        .ok_or_else(|| BackendError::DirectCheckpointCorrupt {
            message: "Macro's internal review checkpoint HEAD has no target.".to_string(),
            checkpoint_id: direct_checkpoint_repo_id(repo),
            object_id: None,
            operation: Some("direct_checkpoint_head_reference".to_string()),
            retry_attempted: false,
            accepted_history_at_risk: true,
            git_output: None,
        })?;
    let mut pending = vec![head_id];
    let mut visited = HashSet::new();
    let mut visited_trees = HashSet::new();
    let mut visited_blobs = HashSet::new();
    while let Some(commit_id) = pending.pop() {
        if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return Err(BackendError::Git {
                message: "Git review was cancelled.".to_string(),
            });
        }
        if !visited.insert(commit_id) {
            continue;
        }
        budget.consume_object()?;
        let commit = repo.find_commit(commit_id).map_err(|error| {
            BackendError::git_object_missing(
                error,
                Some(commit_id.to_string()),
                Some("direct_checkpoint_head_commit".to_string()),
            )
        })?;
        verify_direct_checkpoint_tree(
            repo,
            commit.tree_id(),
            &mut visited_trees,
            &mut visited_blobs,
            cancellation,
            budget,
        )?;
        pending.extend(commit.parent_ids());
    }
    Ok(head_id)
}

fn verify_direct_checkpoint_index_with_budget(
    repo: &Repository,
    cancellation: Option<&Arc<AtomicBool>>,
    budget: &mut DirectCheckpointVerificationBudget,
) -> Result<()> {
    match fs::symlink_metadata(repo.path().join("index")) {
        Ok(metadata) if metadata.is_file() && !direct_checkpoint_metadata_is_link(&metadata) => {}
        Ok(_) => {
            return Err(BackendError::DirectCheckpointCorrupt {
                message: "Macro's internal review checkpoint index is invalid.".to_string(),
                checkpoint_id: direct_checkpoint_repo_id(repo),
                object_id: None,
                operation: Some("direct_checkpoint_index".to_string()),
                retry_attempted: false,
                accepted_history_at_risk: false,
                git_output: None,
            });
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(BackendError::DirectCheckpointCorrupt {
                message: "Macro's internal review checkpoint index is missing.".to_string(),
                checkpoint_id: direct_checkpoint_repo_id(repo),
                object_id: None,
                operation: Some("direct_checkpoint_index".to_string()),
                retry_attempted: false,
                accepted_history_at_risk: false,
                git_output: None,
            });
        }
        Err(error) => {
            return Err(BackendError::Io {
                message: format!("Failed to inspect direct checkpoint index: {error}"),
                source: error,
            });
        }
    }
    let mut index = repo.index().map_err(|error| BackendError::Git {
        message: format!("Failed to open direct checkpoint index: {error}"),
    })?;
    index.read(true).map_err(|error| BackendError::Git {
        message: format!("Failed to refresh direct checkpoint index: {error}"),
    })?;
    reject_direct_checkpoint_gitlinks(repo, &index, "direct_checkpoint_index_gitlink")?;
    for entry in index.iter() {
        if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return Err(BackendError::Git {
                message: "Git review was cancelled.".to_string(),
            });
        }
        if entry.flags & 0x3000 != 0 {
            return Err(BackendError::DirectCheckpointCorrupt {
                message: "Macro's internal review checkpoint index contains unresolved entries."
                    .to_string(),
                checkpoint_id: direct_checkpoint_repo_id(repo),
                object_id: Some(entry.id.to_string()),
                operation: Some("direct_checkpoint_index_conflict".to_string()),
                retry_attempted: false,
                accepted_history_at_risk: false,
                git_output: None,
            });
        }
        verify_direct_checkpoint_blob(
            repo,
            entry.id,
            "direct_checkpoint_index_blob",
            cancellation,
            budget,
        )?;
    }
    Ok(())
}

fn reject_direct_checkpoint_gitlinks(
    repo: &Repository,
    index: &git2::Index,
    operation: &str,
) -> Result<()> {
    if let Some(entry) = index.iter().find(|entry| entry.mode & 0o170000 == 0o160000) {
        return Err(BackendError::DirectCheckpointCorrupt {
            message: "Macro cannot checkpoint a nested Git repository in direct review mode."
                .to_string(),
            checkpoint_id: direct_checkpoint_repo_id(repo),
            object_id: Some(entry.id.to_string()),
            operation: Some(operation.to_string()),
            retry_attempted: false,
            accepted_history_at_risk: false,
            git_output: None,
        });
    }
    Ok(())
}

fn ensure_direct_checkpoint_integrity(repo: &Repository) -> Result<()> {
    let mut budget = DirectCheckpointVerificationBudget::new();
    verify_direct_checkpoint_history_with_budget(repo, None, &mut budget)
        .and_then(|_| verify_direct_checkpoint_index_with_budget(repo, None, &mut budget))
        .map_err(|error| direct_checkpoint_corruption(repo, error, false))
}

fn ensure_direct_checkpoint_integrity_with_cancellation(
    repo: &Repository,
    cancellation: Option<&Arc<AtomicBool>>,
) -> Result<()> {
    if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err(BackendError::Git {
            message: "Git review was cancelled.".to_string(),
        });
    }
    let mut budget = DirectCheckpointVerificationBudget::new();
    verify_direct_checkpoint_history_with_budget(repo, cancellation, &mut budget)
        .and_then(|_| verify_direct_checkpoint_index_with_budget(repo, cancellation, &mut budget))
        .map_err(|error| {
            if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
                error
            } else {
                direct_checkpoint_corruption(repo, error, false)
            }
        })
}

fn direct_checkpoint_corruption(
    repo: &Repository,
    error: BackendError,
    retry_attempted: bool,
) -> BackendError {
    let accepted_history_at_risk = match &error {
        BackendError::GitObjectMissing { operation, .. }
        | BackendError::DirectCheckpointCorrupt { operation, .. } => operation
            .as_deref()
            .is_none_or(|operation| operation.contains("head")),
        _ => true,
    };
    match error {
        BackendError::GitObjectMissing { .. } => error.into_direct_checkpoint_corrupt(
            direct_checkpoint_repo_id(repo),
            retry_attempted,
            accepted_history_at_risk,
        ),
        BackendError::DirectCheckpointCorrupt {
            message,
            checkpoint_id,
            object_id,
            operation,
            accepted_history_at_risk: existing_risk,
            git_output,
            ..
        } => BackendError::DirectCheckpointCorrupt {
            message,
            checkpoint_id,
            object_id,
            operation,
            retry_attempted,
            accepted_history_at_risk: existing_risk || accepted_history_at_risk,
            git_output,
        },
        _other => BackendError::DirectCheckpointCorrupt {
            message: "Macro's internal review checkpoint cannot be read.".to_string(),
            checkpoint_id: direct_checkpoint_repo_id(repo),
            object_id: None,
            operation: Some("direct_checkpoint_integrity".to_string()),
            retry_attempted,
            accepted_history_at_risk,
            git_output: None,
        },
    }
}

fn direct_checkpoint_initialization_error(repo: &Repository, operation: &str) -> BackendError {
    BackendError::DirectCheckpointCorrupt {
        message: "Macro could not initialize its internal review checkpoint.".to_string(),
        checkpoint_id: direct_checkpoint_repo_id(repo),
        object_id: None,
        operation: Some(operation.to_string()),
        retry_attempted: false,
        accepted_history_at_risk: false,
        git_output: None,
    }
}

fn ensure_direct_checkpoint_head(repo: &Repository) -> Result<String> {
    match repo.head() {
        Ok(_) => {
            let mut budget = DirectCheckpointVerificationBudget::new();
            let head_id = verify_direct_checkpoint_history_with_budget(repo, None, &mut budget)
                .and_then(|head_id| {
                    verify_direct_checkpoint_index_with_budget(repo, None, &mut budget)
                        .map(|_| head_id)
                })
                .map_err(|error| direct_checkpoint_corruption(repo, error, false))?;
            return Ok(head_id.to_string());
        }
        Err(error)
            if error.code() == git2::ErrorCode::UnbornBranch
                && repo.is_empty().unwrap_or(false) => {}
        Err(error) => {
            let error = BackendError::git_object_missing(
                error,
                None,
                Some("direct_checkpoint_head_reference".to_string()),
            );
            return Err(direct_checkpoint_corruption(repo, error, false));
        }
    }

    let mut index = repo.index().map_err(|_| {
        direct_checkpoint_initialization_error(repo, "direct_checkpoint_init_index")
    })?;
    index.clear().map_err(|_| {
        direct_checkpoint_initialization_error(repo, "direct_checkpoint_init_index_clear")
    })?;
    let configured_worktree = repo
        .workdir()
        .map(Path::to_path_buf)
        .or_else(|| repo.config().ok()?.get_path("core.worktree").ok())
        .ok_or_else(|| {
            direct_checkpoint_initialization_error(repo, "direct_checkpoint_init_worktree")
        })?;
    let mut files = Vec::new();
    let mut scanned_entries = 0usize;
    collect_direct_checkpoint_files(
        repo,
        &configured_worktree,
        &configured_worktree,
        &mut files,
        &mut scanned_entries,
    )?;
    let retained_worktree = open_direct_restore_capability(&configured_worktree).map_err(|_| {
        direct_checkpoint_initialization_error(repo, "direct_checkpoint_init_worktree")
    })?;
    let mut remaining_bytes = MAX_DIRECT_REVIEW_REVISION_BYTES;
    let mut prepared = Vec::new();
    for relative in files {
        if repo.status_should_ignore(&relative).unwrap_or(true) {
            continue;
        }
        let display_path = relative.to_string_lossy().replace('\\', "/");
        let expected_revision =
            direct_worktree_revision(&retained_worktree, &relative, &display_path).map_err(
                |_| direct_checkpoint_initialization_error(repo, "direct_checkpoint_init_capture"),
            )?;
        prepared.push(
            prepare_direct_stage_path(
                &retained_worktree,
                &relative,
                &display_path,
                &expected_revision,
                &mut remaining_bytes,
            )
            .map_err(|_| {
                direct_checkpoint_initialization_error(repo, "direct_checkpoint_init_capture")
            })?,
        );
    }
    apply_prepared_direct_stage_changes(repo, &mut index, prepared).map_err(|_| {
        direct_checkpoint_initialization_error(repo, "direct_checkpoint_init_capture")
    })?;
    reject_direct_checkpoint_gitlinks(repo, &index, "direct_checkpoint_init_gitlink")?;
    index.write().map_err(|_| {
        direct_checkpoint_initialization_error(repo, "direct_checkpoint_init_index_write")
    })?;
    let tree_id = index.write_tree().map_err(|_| {
        direct_checkpoint_initialization_error(repo, "direct_checkpoint_init_tree_write")
    })?;
    let tree = repo.find_tree(tree_id).map_err(|_| {
        direct_checkpoint_initialization_error(repo, "direct_checkpoint_init_tree_read")
    })?;
    let signature = git2::Signature::now("Macro", "macro@local").map_err(|_| {
        direct_checkpoint_initialization_error(repo, "direct_checkpoint_init_signature")
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
        .map_err(|_| {
            direct_checkpoint_initialization_error(repo, "direct_checkpoint_init_commit")
        })?;
    Ok(oid.to_string())
}

fn run_direct_checkpoint_review<T, O, F>(
    open: O,
    cancellation: Option<Arc<AtomicBool>>,
    operation: F,
) -> Result<T>
where
    O: Fn() -> Result<(Repository, PathBuf)>,
    F: Fn(&Repository, &Path) -> Result<T>,
{
    if git_review_is_cancelled(&cancellation) {
        return Err(BackendError::Git {
            message: "Git review was cancelled.".to_string(),
        });
    }
    let (repo, project_path) = open()?;
    let execute = |repo: &Repository, project_path: &Path| {
        if git_review_is_cancelled(&cancellation) {
            return Err(BackendError::Git {
                message: "Git review was cancelled.".to_string(),
            });
        }
        let mut budget = DirectCheckpointVerificationBudget::new();
        let integrity =
            verify_direct_checkpoint_history_with_budget(repo, cancellation.as_ref(), &mut budget)
                .and_then(|_| {
                    verify_direct_checkpoint_index_with_budget(
                        repo,
                        cancellation.as_ref(),
                        &mut budget,
                    )
                });
        match integrity {
            Ok(()) if git_review_is_cancelled(&cancellation) => Err(BackendError::Git {
                message: "Git review was cancelled.".to_string(),
            }),
            Ok(()) => operation(repo, project_path),
            Err(error) if error.is_git_object_missing() => Err(error),
            Err(error) if git_review_is_cancelled(&cancellation) => Err(error),
            Err(error) => Err(direct_checkpoint_corruption(repo, error, false)),
        }
    };
    let first_result = execute(&repo, &project_path);
    match first_result {
        Ok(value) => return Ok(value),
        Err(error) if error.is_git_object_missing() => {}
        Err(error) => return Err(error),
    }
    if let Ok(odb) = repo.odb() {
        let _ = odb.refresh();
    }
    drop(repo);

    if git_review_is_cancelled(&cancellation) {
        return Err(BackendError::Git {
            message: "Git review was cancelled.".to_string(),
        });
    }

    let (reopened, reopened_project_path) = open()?;
    if let Ok(odb) = reopened.odb() {
        let _ = odb.refresh();
    }
    execute(&reopened, &reopened_project_path).map_err(|error| {
        if error.is_git_object_missing() {
            direct_checkpoint_corruption(&reopened, error, true)
        } else {
            error
        }
    })
}

fn run_locked_direct_checkpoint_review<T, F>(
    app: &AppHandle,
    workspace: &Path,
    task_id: &str,
    project_path: &str,
    checkpoint_id: Option<&str>,
    cancellation: Option<Arc<AtomicBool>>,
    operation: F,
) -> Result<T>
where
    F: Fn(&Repository, &Path) -> Result<T>,
{
    let validated = validate_repo_path(project_path, workspace)?;
    with_direct_project_operation_lock(&validated, || {
        run_direct_checkpoint_review(
            || {
                let repo = open_direct_checkpoint(app, task_id, &validated, checkpoint_id, false)?;
                Ok((repo, validated.clone()))
            },
            cancellation,
            operation,
        )
    })
}

fn remove_direct_checkpoint(
    app_data_dir: &Path,
    task_id: &str,
    checkpoint_id: &str,
    project_path: &Path,
) -> Result<bool> {
    with_direct_checkpoint_storage_lock(|| {
        remove_direct_checkpoint_locked(app_data_dir, task_id, checkpoint_id, project_path)
    })
}

fn remove_direct_checkpoint_locked(
    app_data_dir: &Path,
    task_id: &str,
    checkpoint_id: &str,
    project_path: &Path,
) -> Result<bool> {
    let checkpoint_id = validate_direct_checkpoint_owner(checkpoint_id, task_id)?;
    let Some((checkpoint_root, canonical_root)) =
        resolve_direct_checkpoint_root(app_data_dir, false)?
    else {
        return Ok(false);
    };
    let retained_app_data = CapabilityDir::open_ambient_dir(
        app_data_dir
            .canonicalize()
            .map_err(|error| BackendError::Io {
                message: format!("Failed to retain Macro application data: {error}"),
                source: error,
            })?,
        ambient_authority(),
    )
    .map_err(|error| BackendError::Io {
        message: format!("Failed to retain Macro application data: {error}"),
        source: error,
    })?;
    let retained_checkpoint_root =
        retained_app_data
            .open_dir(DIRECT_CHECKPOINTS_DIR)
            .map_err(|error| BackendError::Io {
                message: format!("Failed to retain direct checkpoint storage: {error}"),
                source: error,
            })?;
    let checkpoint_path =
        resolve_direct_checkpoint_path(&checkpoint_root, &canonical_root, checkpoint_id, false)?;
    if let Some((canonical_checkpoint, _)) = checkpoint_path {
        let owner_repo = Repository::open_bare(&canonical_checkpoint).map_err(|_| {
            BackendError::Validation(
                "Cannot verify the owner of this direct checkpoint; it was preserved.".to_string(),
            )
        })?;
        let configured_project_path = owner_repo
            .config()
            .and_then(|config| config.get_path("core.worktree"))
            .map_err(|_| {
                BackendError::Validation(
                    "Cannot verify the owner of this direct checkpoint; it was preserved."
                        .to_string(),
                )
            })?;
        let configured_task_id = owner_repo
            .config()
            .and_then(|config| config.get_string("macro.taskId"))
            .map_err(|_| {
                BackendError::Validation(
                    "Cannot verify the owner of this legacy direct checkpoint; it was preserved. Reopen the task before removing it."
                        .to_string(),
                )
            })?;
        if configured_task_id != task_id {
            return Err(BackendError::Validation(
                "Direct checkpoint does not belong to this task.".to_string(),
            ));
        }
        let expected_project_path =
            project_path
                .canonicalize()
                .map_err(|error| BackendError::Io {
                    message: format!("Failed to resolve direct project path: {error}"),
                    source: error,
                })?;
        let configured_project_path = configured_project_path.canonicalize().map_err(|_| {
            BackendError::Validation(
                "Cannot verify the project owner of this direct checkpoint; it was preserved."
                    .to_string(),
            )
        })?;
        if configured_project_path != expected_project_path
            && (!cfg!(windows)
                || !configured_project_path
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&expected_project_path.to_string_lossy()))
        {
            return Err(BackendError::Validation(
                "Direct checkpoint does not belong to this project.".to_string(),
            ));
        }
        if direct_checkpoint_key(task_id, &configured_project_path) != checkpoint_id {
            return Err(BackendError::Validation(
                "Direct checkpoint does not belong to this task.".to_string(),
            ));
        }
        let marker_name = format!(".known-{checkpoint_id}");
        match retained_checkpoint_root.symlink_metadata(&marker_name) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(direct_checkpoint_storage_corruption(
                    checkpoint_id,
                    "direct_checkpoint_marker",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let mut options = CapabilityOpenOptions::new();
                options.write(true).create_new(true);
                retained_checkpoint_root
                    .open_with(&marker_name, &options)
                    .and_then(|file| file.sync_all())
                    .map_err(|error| BackendError::Io {
                        message: format!("Failed to record direct checkpoint removal: {error}"),
                        source: error,
                    })?;
            }
            Err(error) => {
                return Err(BackendError::Io {
                    message: format!("Failed to inspect direct checkpoint marker: {error}"),
                    source: error,
                });
            }
        }
        retained_checkpoint_root
            .remove_dir_all(checkpoint_id)
            .map_err(|error| BackendError::Io {
                message: format!("Failed to remove direct checkpoint: {}", error),
                source: error,
            })?;
        invalidate_direct_review_authorizations(checkpoint_id);
        return Ok(true);
    }
    // Keep the marker as a tombstone. A stale activation must never turn the
    // current project files into a replacement accepted baseline.
    Ok(false)
}

fn remove_locked_direct_checkpoint_at(
    app_data_dir: &Path,
    task_id: &str,
    checkpoint_id: &str,
    project_path: &Path,
) -> Result<bool> {
    with_direct_project_operation_lock(project_path, || {
        remove_direct_checkpoint(app_data_dir, task_id, checkpoint_id, project_path)
    })
}

fn resolve_direct_checkpoint_id_at(
    app_data_dir: &Path,
    task_id: &str,
    project_path: &Path,
) -> Result<String> {
    with_direct_checkpoint_storage_lock(|| {
        resolve_direct_checkpoint_id_at_locked(app_data_dir, task_id, project_path)
    })
}

fn resolve_direct_checkpoint_id_at_locked(
    app_data_dir: &Path,
    task_id: &str,
    project_path: &Path,
) -> Result<String> {
    let derived = direct_checkpoint_key(task_id, project_path);
    let Some((_checkpoint_root, canonical_root)) =
        resolve_direct_checkpoint_root(app_data_dir, false)?
    else {
        return Ok(derived);
    };
    let expected = project_path
        .canonicalize()
        .map_err(|error| BackendError::Io {
            message: format!("Failed to resolve direct project path: {error}"),
            source: error,
        })?;
    let mut found_other_path = false;
    for entry in fs::read_dir(&canonical_root).map_err(|error| BackendError::Io {
        message: format!("Failed to inspect direct checkpoint storage: {error}"),
        source: error,
    })? {
        let entry = entry.map_err(|error| BackendError::Io {
            message: format!("Failed to inspect direct checkpoint entry: {error}"),
            source: error,
        })?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| BackendError::Io {
            message: format!("Failed to inspect direct checkpoint entry: {error}"),
            source: error,
        })?;
        if !metadata.is_dir() || direct_checkpoint_metadata_is_link(&metadata) {
            continue;
        }
        let Some(checkpoint_id) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let filename_claims_task =
            validate_direct_checkpoint_owner(&checkpoint_id, task_id).is_ok();
        let repo = match Repository::open_bare(entry.path()) {
            Ok(repo) => repo,
            Err(_) if filename_claims_task => {
                return Err(direct_checkpoint_storage_corruption(
                    &checkpoint_id,
                    "direct_checkpoint_resolve",
                ));
            }
            Err(_) => continue,
        };
        let config = match repo.config() {
            Ok(config) => config,
            Err(_) if filename_claims_task => {
                return Err(direct_checkpoint_storage_corruption(
                    &checkpoint_id,
                    "direct_checkpoint_owner",
                ));
            }
            Err(_) => continue,
        };
        match config.get_string("macro.taskId") {
            Ok(owner) if owner == task_id => {}
            Err(error) if error.code() == git2::ErrorCode::NotFound && filename_claims_task => {
                return Err(direct_checkpoint_storage_corruption(
                    &checkpoint_id,
                    "direct_checkpoint_owner",
                ));
            }
            _ => continue,
        }
        let configured_path = config.get_path("core.worktree").map_err(|_| {
            direct_checkpoint_storage_corruption(&checkpoint_id, "direct_checkpoint_worktree")
        })?;
        if configured_path
            .canonicalize()
            .is_ok_and(|actual| actual == expected)
        {
            validate_direct_checkpoint_owner(&checkpoint_id, task_id)?;
            return Ok(checkpoint_id);
        }
        found_other_path = true;
    }
    if found_other_path {
        return Err(BackendError::DirectCheckpointProjectMismatch {
            message: "Macro's internal review checkpoint belongs to another project path."
                .to_string(),
            checkpoint_id: derived,
        });
    }
    Ok(derived)
}

#[tauri::command]
pub async fn direct_checkpoint_resolve_id(
    app: AppHandle,
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
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| BackendError::Filesystem {
                message: format!("Failed to resolve Macro application data directory: {error}"),
            })?;
        resolve_direct_checkpoint_id_at(&app_data_dir, &task_id, &validated)
    })
    .await
    .map_err(to_join_error)?
}

#[tauri::command]
pub async fn direct_checkpoint_remove(
    app: AppHandle,
    workspace_root: State<'_, WorkspaceRoot>,
    task_id: String,
    checkpoint_id: String,
    project_path: String,
) -> Result<bool> {
    let workspace = workspace_root.inner().read().await.clone();
    tokio::task::spawn_blocking(move || {
        validate_direct_checkpoint_owner(&checkpoint_id, &task_id)?;
        let validated = validate_repo_path(&project_path, &workspace)?;
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| BackendError::Filesystem {
                message: format!(
                    "Failed to resolve Macro application data directory: {}",
                    error
                ),
            })?;
        remove_locked_direct_checkpoint_at(&app_data_dir, &task_id, &checkpoint_id, &validated)
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
        with_locked_direct_checkpoint(
            &app,
            &workspace,
            &task_id,
            &project_path,
            checkpoint_id.as_deref(),
            true,
            |repo, _| ensure_direct_checkpoint_head(repo),
        )
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
    request_id: Option<String>,
) -> Result<DirectReviewSnapshotDto> {
    let workspace = workspace_root.inner().read().await.clone();
    let (cancellation, cancellation_guard) =
        register_git_review_cancellation(request_id.as_deref())?;
    tokio::task::spawn_blocking(move || {
        let _cancellation_guard = cancellation_guard;
        let operation_cancellation = cancellation.clone();
        run_locked_direct_checkpoint_review(
            &app,
            &workspace,
            &task_id,
            &project_path,
            checkpoint_id.as_deref(),
            cancellation,
            |repo, validated| {
                let checkpoint_revision = direct_checkpoint_revision(repo)?;
                let status = build_git_status(repo)?;
                let mut visible_paths = HashSet::new();
                for path in status
                    .staged_files
                    .iter()
                    .chain(status.unstaged_files.iter())
                    .chain(status.untracked_files.iter())
                    .map(|change| change.path.clone())
                {
                    visible_paths.insert(path);
                    if visible_paths.len() > MAX_DIRECT_REVIEW_PATHS {
                        return Err(BackendError::FilesystemFileTooLarge {
                            message: "Direct review contains too many changed paths.".to_string(),
                        });
                    }
                }
                let mut visible_paths = visible_paths.into_iter().collect::<Vec<_>>();
                visible_paths.sort();
                let restore_paths =
                    expand_direct_rename_paths(repo, &visible_paths, DirectRenameAxis::Worktree)?;
                if restore_paths.len() > MAX_DIRECT_REVIEW_PATHS {
                    return Err(BackendError::FilesystemFileTooLarge {
                        message: "Direct review contains too many changed paths.".to_string(),
                    });
                }
                let restore_root = open_direct_restore_capability(validated)?;
                let mut restore_revisions = HashMap::new();
                let mut remaining_revision_bytes = MAX_DIRECT_REVIEW_REVISION_BYTES;
                for path in restore_paths {
                    if git_review_is_cancelled(&operation_cancellation) {
                        return Err(BackendError::Git {
                            message: "Git review was cancelled.".to_string(),
                        });
                    }
                    let relative = validate_repo_relative_file_path(&path)?;
                    if is_direct_checkpoint_excluded_path(&relative) {
                        continue;
                    }
                    restore_revisions.insert(
                        path.clone(),
                        direct_worktree_revision_bounded(
                            &restore_root,
                            &relative,
                            &path,
                            operation_cancellation.as_ref(),
                            &mut remaining_revision_bytes,
                        )?,
                    );
                }
                let snapshot =
                    review::build_git_review_snapshot_with_cancellation(repo, validated, || {
                        git_review_is_cancelled(&operation_cancellation)
                    })
                    .map_err(|error| {
                        error.with_git_object_context(None, "direct_review_snapshot")
                    })?;
                let mut snapshot = snapshot;
                filter_direct_checkpoint_snapshot(&mut snapshot);
                let has_accepted_changes = repo
                    .head()
                    .and_then(|head| head.peel_to_commit())
                    .map_err(|error| {
                        BackendError::git_object_missing(
                            error,
                            None,
                            Some("direct_review_accepted_state".to_string()),
                        )
                    })?
                    .parent_count()
                    > 0;
                let snapshot_id = register_direct_review_authorization_if_checkpoint_unchanged(
                    repo,
                    &checkpoint_revision,
                    &task_id,
                    validated,
                    &direct_checkpoint_repo_id(repo),
                    &restore_revisions,
                )?;
                Ok(DirectReviewSnapshotDto {
                    snapshot,
                    has_accepted_changes,
                    snapshot_id,
                    restore_revisions,
                })
            },
        )
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
    request_id: Option<String>,
) -> Result<GitReviewFileDto> {
    let workspace = workspace_root.inner().read().await.clone();
    let (cancellation, cancellation_guard) =
        register_git_review_cancellation(request_id.as_deref())?;
    tokio::task::spawn_blocking(move || {
        let _cancellation_guard = cancellation_guard;
        let operation_cancellation = cancellation.clone();
        run_locked_direct_checkpoint_review(
            &app,
            &workspace,
            &task_id,
            &project_path,
            checkpoint_id.as_deref(),
            cancellation,
            |repo, validated| {
                if git_review_is_cancelled(&operation_cancellation) {
                    return Err(BackendError::Git {
                        message: "Git review was cancelled.".to_string(),
                    });
                }
                let relative = validate_repo_relative_file_path(&path)?;
                reject_direct_checkpoint_excluded_path(&relative)?;
                let result = review::build_git_review_file_with_cancellation(
                    repo,
                    validated,
                    &relative,
                    &status,
                    || git_review_is_cancelled(&operation_cancellation),
                )
                .map_err(|error| error.with_git_object_context(None, "direct_review_file"))?;
                Ok(result)
            },
        )
    })
    .await
    .map_err(to_join_error)?
}

enum PreparedDirectStageChange {
    Remove {
        relative: PathBuf,
    },
    Upsert {
        relative: PathBuf,
        bytes: Vec<u8>,
        mode: u32,
    },
}

fn stage_direct_paths_with_revisions(
    repo: &Repository,
    paths: &[String],
    expected_revisions: &HashMap<String, String>,
) -> Result<()> {
    ensure_direct_checkpoint_integrity(repo)?;
    let paths = expand_direct_rename_paths(repo, paths, DirectRenameAxis::Worktree)?;
    if paths.len() > MAX_DIRECT_REVIEW_PATHS {
        return Err(BackendError::FilesystemFileTooLarge {
            message: "Direct validation contains too many changed paths.".to_string(),
        });
    }
    let workdir = repo.workdir().ok_or_else(|| BackendError::Git {
        message: "Direct checkpoint has no worktree.".to_string(),
    })?;
    let retained_worktree = open_direct_restore_capability(workdir)?;
    let mut validated_paths = Vec::with_capacity(paths.len());
    for path in &paths {
        let relative = validate_repo_relative_file_path(path)?;
        reject_direct_checkpoint_excluded_path(&relative)?;
        if direct_worktree_path_has_linked_parent(workdir, &relative)? {
            return Err(BackendError::Validation(format!(
                "Direct checkpoint path crosses a linked parent: {path}"
            )));
        }
        let expected_revision =
            expected_revisions
                .get(path)
                .ok_or_else(|| BackendError::RevisionConflict {
                    message: format!(
                        "The direct-review snapshot does not authorize the selected path: {path}"
                    ),
                })?;
        validated_paths.push((path.clone(), relative, expected_revision.clone()));
    }
    let mut remaining_bytes = MAX_DIRECT_REVIEW_REVISION_BYTES;
    let prepared = validated_paths
        .iter()
        .map(|(path, relative, expected_revision)| {
            prepare_direct_stage_path(
                &retained_worktree,
                relative,
                path,
                expected_revision,
                &mut remaining_bytes,
            )
        })
        .collect::<Result<Vec<_>>>()?;
    let mut index = repo.index().map_err(|error| BackendError::Git {
        message: format!("Failed to open direct checkpoint index: {}", error),
    })?;
    apply_prepared_direct_stage_changes(repo, &mut index, prepared)?;
    reject_direct_checkpoint_gitlinks(repo, &index, "direct_checkpoint_stage_gitlink")?;
    index.write().map_err(|error| BackendError::Git {
        message: format!("Failed to save direct change validation: {}", error),
    })?;
    Ok(())
}

fn apply_prepared_direct_stage_changes(
    repo: &Repository,
    index: &mut git2::Index,
    prepared: Vec<PreparedDirectStageChange>,
) -> Result<()> {
    let odb = repo.odb()?;
    for change in prepared {
        match change {
            PreparedDirectStageChange::Remove { relative } => {
                let _ = index.remove_path(&relative);
            }
            PreparedDirectStageChange::Upsert {
                relative,
                bytes,
                mode,
            } => {
                let oid = odb.write(git2::ObjectType::Blob, &bytes)?;
                let entry = git2::IndexEntry {
                    ctime: git2::IndexTime::new(0, 0),
                    mtime: git2::IndexTime::new(0, 0),
                    dev: 0,
                    ino: 0,
                    mode,
                    uid: 0,
                    gid: 0,
                    file_size: u32::try_from(bytes.len()).unwrap_or(u32::MAX),
                    id: oid,
                    flags: 0,
                    flags_extended: 0,
                    path: direct_checkpoint_index_path_bytes(&relative),
                };
                index.add(&entry).map_err(|_error| BackendError::Git {
                    message: "Failed to validate a direct change.".to_string(),
                })?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
fn stage_direct_paths(repo: &Repository, paths: &[String]) -> Result<()> {
    let workdir = repo.workdir().ok_or_else(|| BackendError::Git {
        message: "Direct checkpoint has no worktree.".to_string(),
    })?;
    let root = open_direct_restore_capability(workdir)?;
    let expanded = expand_direct_rename_paths(repo, paths, DirectRenameAxis::Worktree)?;
    let revisions = expanded
        .iter()
        .map(|path| {
            let relative = validate_repo_relative_file_path(path)?;
            Ok((
                path.clone(),
                direct_worktree_revision(&root, &relative, path)?,
            ))
        })
        .collect::<Result<HashMap<_, _>>>()?;
    stage_direct_paths_with_revisions(repo, paths, &revisions)
}

#[derive(Clone, Copy)]
enum DirectRenameAxis {
    Index,
    Worktree,
}

fn expand_direct_rename_paths(
    repo: &Repository,
    paths: &[String],
    axis: DirectRenameAxis,
) -> Result<Vec<String>> {
    if paths.len() > MAX_DIRECT_REVIEW_PATHS {
        return Err(BackendError::FilesystemFileTooLarge {
            message: "Direct review path limit exceeded.".to_string(),
        });
    }
    let selected = paths.iter().cloned().collect::<HashSet<_>>();
    let statuses = repo.statuses(Some(&mut get_status_options()))?;
    let mut expanded = paths.to_vec();
    for entry in statuses.iter() {
        let status = entry.status();
        let delta = match axis {
            DirectRenameAxis::Index if status.is_index_renamed() => entry.head_to_index(),
            DirectRenameAxis::Worktree if status.is_wt_renamed() => entry.index_to_workdir(),
            _ => None,
        };
        let Some(delta) = delta else {
            continue;
        };
        let Some(new_path) = delta.new_file().path().and_then(Path::to_str) else {
            continue;
        };
        if selected.contains(new_path) {
            if let Some(old_path) = delta.old_file().path().and_then(Path::to_str) {
                expanded.push(old_path.to_string());
            }
        }
    }
    expanded.sort();
    expanded.dedup();
    Ok(expanded)
}

fn prepare_direct_stage_path(
    worktree: &CapabilityDir,
    relative: &Path,
    display_path: &str,
    expected_revision: &str,
    remaining_bytes: &mut usize,
) -> Result<PreparedDirectStageChange> {
    let file_name = relative.file_name().ok_or_else(|| {
        BackendError::Validation(format!("Invalid direct checkpoint path: {display_path}"))
    })?;
    let mut parent = worktree.try_clone().map_err(|error| BackendError::Io {
        message: format!("Failed to retain direct checkpoint root: {error}"),
        source: error,
    })?;
    if let Some(parent_path) = relative.parent() {
        for component in parent_path.components() {
            let std::path::Component::Normal(segment) = component else {
                return Err(BackendError::Validation(format!(
                    "Invalid direct checkpoint path: {display_path}"
                )));
            };
            match parent.symlink_metadata(segment) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                Ok(_) => {
                    return Err(BackendError::Validation(format!(
                        "Direct checkpoint path crosses a linked parent: {display_path}"
                    )));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    if expected_revision != "v1:absent" {
                        return Err(BackendError::RevisionConflict {
                            message: format!(
                                "The direct-review file changed after the snapshot was loaded: {display_path}"
                            ),
                        });
                    }
                    return Ok(PreparedDirectStageChange::Remove {
                        relative: relative.to_path_buf(),
                    });
                }
                Err(error) => {
                    return Err(BackendError::Io {
                        message: format!("Failed to inspect direct checkpoint path: {error}"),
                        source: error,
                    });
                }
            }
            parent = parent.open_dir(segment).map_err(|error| BackendError::Io {
                message: format!("Failed to retain direct checkpoint parent: {error}"),
                source: error,
            })?;
        }
    }
    let metadata = match parent.symlink_metadata(file_name) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if expected_revision != "v1:absent" {
                return Err(BackendError::RevisionConflict {
                    message: format!(
                        "The direct-review file changed after the snapshot was loaded: {display_path}"
                    ),
                });
            }
            return Ok(PreparedDirectStageChange::Remove {
                relative: relative.to_path_buf(),
            });
        }
        Err(error) => {
            return Err(BackendError::Io {
                message: format!("Failed to inspect direct change {display_path}: {error}"),
                source: error,
            });
        }
    };
    let (bytes, mode, actual_revision): (Vec<u8>, u32, String) = if metadata
        .file_type()
        .is_symlink()
    {
        #[cfg(windows)]
        {
            return Err(BackendError::Validation(format!(
                "Validating a linked path is not supported safely on Windows: {display_path}"
            )));
        }
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            let target =
                parent
                    .read_link_contents(file_name)
                    .map_err(|error| BackendError::Io {
                        message: format!(
                            "Failed to read direct linked path {display_path}: {error}"
                        ),
                        source: error,
                    })?;
            let bytes = target.as_os_str().as_bytes().to_vec();
            if bytes.len() > *remaining_bytes {
                return Err(BackendError::FilesystemFileTooLarge {
                    message: "Direct validation revision budget exceeded.".to_string(),
                });
            }
            *remaining_bytes -= bytes.len();
            let digest = Sha256::digest(&bytes).into();
            let fingerprint = direct_restore_metadata_fingerprint(&metadata, digest, display_path)?;
            let revision = direct_restore_revision_from_fingerprint(fingerprint);
            (bytes, 0o120000, revision)
        }
    } else if metadata.is_file() {
        let mut file = open_direct_regular_file_no_follow(&parent, file_name).map_err(|error| {
            BackendError::Io {
                message: format!("Failed to open direct change {display_path}: {error}"),
                source: error,
            }
        })?;
        let handle_metadata = file.metadata().map_err(|error| BackendError::Io {
            message: format!("Failed to inspect direct change handle {display_path}: {error}"),
            source: error,
        })?;
        let size = usize::try_from(handle_metadata.len()).map_err(|_| {
            BackendError::Validation(format!(
                "Direct change is too large to checkpoint: {display_path}"
            ))
        })?;
        if size > *remaining_bytes {
            return Err(BackendError::FilesystemFileTooLarge {
                message: "Direct validation revision budget exceeded.".to_string(),
            });
        }
        *remaining_bytes -= size;
        let mut bytes = Vec::with_capacity(size);
        file.read_to_end(&mut bytes)
            .map_err(|error| BackendError::Io {
                message: format!("Failed to read direct change {display_path}: {error}"),
                source: error,
            })?;
        if bytes.len() != size {
            return Err(BackendError::RevisionConflict {
                message: format!(
                    "The direct-review file changed after the snapshot was loaded: {display_path}"
                ),
            });
        }
        #[cfg(unix)]
        let mode = {
            use cap_std::fs::PermissionsExt;
            if handle_metadata.permissions().mode() & 0o111 != 0 {
                0o100755
            } else {
                0o100644
            }
        };
        #[cfg(not(unix))]
        let mode = 0o100644;
        let digest = Sha256::digest(&bytes).into();
        let fingerprint =
            direct_restore_metadata_fingerprint(&handle_metadata, digest, display_path)?;
        let revision = direct_restore_revision_from_fingerprint(fingerprint);
        (bytes, mode, revision)
    } else {
        return Err(BackendError::Validation(format!(
            "Unsupported direct checkpoint entry: {display_path}"
        )));
    };
    if actual_revision != expected_revision {
        return Err(BackendError::RevisionConflict {
            message: format!(
                "The direct-review file changed after the snapshot was loaded: {display_path}"
            ),
        });
    }
    Ok(PreparedDirectStageChange::Upsert {
        relative: relative.to_path_buf(),
        bytes,
        mode,
    })
}

#[cfg(windows)]
fn direct_capability_metadata_is_reparse_point(metadata: &cap_std::fs::Metadata) -> bool {
    use cap_std::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn direct_capability_metadata_is_reparse_point(_metadata: &cap_std::fs::Metadata) -> bool {
    false
}

fn open_direct_regular_file_no_follow(
    parent: &CapabilityDir,
    file_name: &OsStr,
) -> std::io::Result<cap_std::fs::File> {
    let mut options = CapabilityOpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use cap_std::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = parent.open_with(file_name, &options)?;
    let metadata = file.metadata()?;
    if metadata.file_type().is_symlink()
        || direct_capability_metadata_is_reparse_point(&metadata)
        || !metadata.is_file()
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "Direct checkpoint path changed to a linked or unsupported entry.",
        ));
    }
    Ok(file)
}

#[cfg(unix)]
fn direct_checkpoint_index_path_bytes(relative: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    relative.as_os_str().as_bytes().to_vec()
}

#[cfg(not(unix))]
fn direct_checkpoint_index_path_bytes(relative: &Path) -> Vec<u8> {
    relative.to_string_lossy().replace('\\', "/").into_bytes()
}

fn accept_direct_changes(repo: &Repository) -> Result<String> {
    ensure_direct_checkpoint_integrity(repo)?;
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
    snapshot_id: String,
    paths: Vec<String>,
) -> Result<()> {
    if paths.len() > MAX_DIRECT_REVIEW_PATHS {
        return Err(BackendError::FilesystemFileTooLarge {
            message: "Direct validation path limit exceeded.".to_string(),
        });
    }
    let workspace = workspace_root.inner().read().await.clone();
    tokio::task::spawn_blocking(move || {
        with_locked_direct_checkpoint(
            &app,
            &workspace,
            &task_id,
            &project_path,
            checkpoint_id.as_deref(),
            false,
            |repo, validated| {
                let expanded =
                    expand_direct_rename_paths(repo, &paths, DirectRenameAxis::Worktree)?;
                let revisions = resolve_direct_review_authorization(
                    &snapshot_id,
                    &task_id,
                    validated,
                    &direct_checkpoint_repo_id(repo),
                    &direct_checkpoint_revision(repo)?,
                    &expanded,
                )?;
                stage_direct_paths_with_revisions(repo, &paths, &revisions)?;
                invalidate_direct_review_authorizations(&direct_checkpoint_repo_id(repo));
                Ok(())
            },
        )
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
        with_locked_direct_checkpoint(
            &app,
            &workspace,
            &task_id,
            &project_path,
            checkpoint_id.as_deref(),
            false,
            |repo, _| {
                unstage_direct_paths(repo, &paths)?;
                invalidate_direct_review_authorizations(&direct_checkpoint_repo_id(repo));
                Ok(())
            },
        )
    })
    .await
    .map_err(to_join_error)?
}

fn unstage_direct_paths(repo: &Repository, paths: &[String]) -> Result<()> {
    ensure_direct_checkpoint_integrity(repo)?;
    let paths = expand_direct_rename_paths(repo, paths, DirectRenameAxis::Index)?;
    let head = repo.head()?.peel_to_commit()?;
    let object = head.as_object();
    let validated_paths = paths
        .iter()
        .map(|path| {
            let relative = validate_repo_relative_file_path(path)?;
            reject_direct_checkpoint_excluded_path(&relative)?;
            Ok(relative)
        })
        .collect::<Result<Vec<_>>>()?;
    repo.reset_default(Some(object), validated_paths.iter())
        .map_err(|error| BackendError::Git {
            message: format!("Failed to unvalidate direct changes: {}", error),
        })?;
    Ok(())
}

fn open_direct_restore_capability(worktree: &Path) -> Result<CapabilityDir> {
    let canonical_worktree = worktree.canonicalize().map_err(|error| BackendError::Io {
        message: format!(
            "Failed to resolve direct-edit project root {}: {}",
            worktree.display(),
            error
        ),
        source: error,
    })?;
    CapabilityDir::open_ambient_dir(&canonical_worktree, ambient_authority()).map_err(|error| {
        BackendError::Io {
            message: format!(
                "Failed to retain direct-edit project root {}: {}",
                worktree.display(),
                error
            ),
            source: error,
        }
    })
}

fn remove_direct_untracked_path(
    worktree: &CapabilityDir,
    relative: &Path,
    display_path: &str,
) -> Result<()> {
    let metadata = match worktree.symlink_metadata(relative) {
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
            if metadata.is_dir() {
                worktree.remove_dir(relative)
            } else {
                worktree.remove_file(relative)
            }
        }
        #[cfg(not(windows))]
        {
            worktree.remove_file(relative)
        }
    } else if metadata.is_dir() {
        worktree.remove_dir_all(relative)
    } else {
        worktree.remove_file(relative)
    };
    result.map_err(|error| BackendError::Io {
        message: format!("Failed to remove reverted path {}: {}", display_path, error),
        source: error,
    })
}

fn open_direct_restore_parent(
    worktree: &CapabilityDir,
    relative: &Path,
    display_path: &str,
) -> Result<(CapabilityDir, OsString, DirectRestoreCreatedParents)> {
    let file_name = relative.file_name().ok_or_else(|| {
        BackendError::Validation(format!("Invalid direct restore path: {display_path}"))
    })?;
    let cleanup_root = worktree.try_clone().map_err(|error| BackendError::Io {
        message: format!("Failed to retain direct restore root: {error}"),
        source: error,
    })?;
    let mut parent = worktree.try_clone().map_err(|error| BackendError::Io {
        message: format!("Failed to retain direct restore root: {error}"),
        source: error,
    })?;
    let mut current_path = PathBuf::new();
    let mut created_parents = DirectRestoreCreatedParents {
        root: cleanup_root,
        paths: Vec::new(),
    };
    if let Some(parent_path) = relative.parent() {
        for component in parent_path.components() {
            let std::path::Component::Normal(segment) = component else {
                return Err(BackendError::Validation(format!(
                    "Invalid direct restore path: {display_path}"
                )));
            };
            match parent.symlink_metadata(segment) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                Ok(_) => {
                    return Err(BackendError::Validation(format!(
                        "Direct restore path crosses a linked or non-directory entry: {display_path}"
                    )));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    parent
                        .create_dir(segment)
                        .map_err(|error| BackendError::Io {
                            message: format!(
                            "Failed to create a parent for reverted path {display_path}: {error}"
                        ),
                            source: error,
                        })?;
                    created_parents.paths.push(current_path.join(segment));
                }
                Err(error) => {
                    return Err(BackendError::Io {
                        message: format!(
                            "Failed to inspect a parent for reverted path {display_path}: {error}"
                        ),
                        source: error,
                    });
                }
            }
            parent = parent.open_dir(segment).map_err(|error| BackendError::Io {
                message: format!(
                    "Failed to retain a parent for reverted path {display_path}: {error}"
                ),
                source: error,
            })?;
            current_path.push(segment);
        }
    }
    Ok((parent, file_name.to_os_string(), created_parents))
}

fn remove_direct_restore_entry(
    parent: &CapabilityDir,
    file_name: &OsStr,
    display_path: &str,
) -> Result<()> {
    let metadata = match parent.symlink_metadata(file_name) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(BackendError::Io {
                message: format!("Failed to inspect reverted path {display_path}: {error}"),
                source: error,
            });
        }
    };
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        return Err(BackendError::RevisionConflict {
            message: "A concurrent directory replaced a direct restore artifact.".to_string(),
        });
    }
    let result = parent.remove_file(file_name);
    result.map_err(|error| BackendError::Io {
        message: format!("Failed to replace reverted path {display_path}: {error}"),
        source: error,
    })
}

fn remove_direct_restore_entry_if_matches(
    parent: &CapabilityDir,
    file_name: &OsStr,
    display_path: &str,
    expected_fingerprint: DirectRestoreFingerprint,
) -> Result<()> {
    let actual =
        direct_restore_entry_fingerprint(parent, file_name, display_path).map_err(|_| {
            BackendError::RevisionConflict {
                message: "A concurrent edit replaced a direct restore artifact.".to_string(),
            }
        })?;
    if actual != expected_fingerprint {
        return Err(BackendError::RevisionConflict {
            message: "A concurrent edit replaced a direct restore artifact.".to_string(),
        });
    }
    remove_direct_restore_entry(parent, file_name, display_path)
}

fn reserve_direct_restore_backup_name(
    parent: &CapabilityDir,
    file_name: &OsStr,
    display_path: &str,
) -> Result<OsString> {
    loop {
        let candidate = OsString::from(format!(
            ".{}.macro-restore-backup-{}",
            file_name.to_string_lossy(),
            uuid::Uuid::new_v4().simple()
        ));
        match parent.symlink_metadata(&candidate) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
            Ok(_) => continue,
            Err(error) => {
                return Err(BackendError::Io {
                    message: format!(
                        "Failed to reserve a backup for reverted path {display_path}: {error}"
                    ),
                    source: error,
                });
            }
        }
    }
}

fn move_direct_restore_entry_to_backup(
    parent: &CapabilityDir,
    file_name: &OsStr,
    display_path: &str,
) -> Result<Option<OsString>> {
    match parent.symlink_metadata(file_name) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(BackendError::Io {
                message: format!("Failed to inspect reverted path {display_path}: {error}"),
                source: error,
            });
        }
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            return Err(BackendError::Validation(format!(
                "Cannot safely replace a directory while reverting {display_path}."
            )));
        }
        Ok(_) => {}
    }
    let backup_name = reserve_direct_restore_backup_name(parent, file_name, display_path)?;
    parent
        .rename(file_name, parent, &backup_name)
        .map_err(|error| BackendError::Io {
            message: format!("Failed to preserve reverted path {display_path}: {error}"),
            source: error,
        })?;
    Ok(Some(backup_name))
}

#[cfg(windows)]
fn atomic_replace_direct_restore_entry(
    parent: &CapabilityDir,
    source_name: &OsStr,
    target_name: &OsStr,
    absolute_parent: &Path,
) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, MoveFileExW, BY_HANDLE_FILE_INFORMATION,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        FILE_SHARE_WRITE, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let metadata = fs::symlink_metadata(absolute_parent)?;
    if direct_checkpoint_metadata_is_link(&metadata) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "Direct restore parent is a Windows reparse point.",
        ));
    }
    let retained_parent = fs::OpenOptions::new()
        .access_mode(0)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(absolute_parent)?;
    let identity = |handle| -> std::io::Result<(u32, u64)> {
        let mut information = BY_HANDLE_FILE_INFORMATION::default();
        if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok((
            information.dwVolumeSerialNumber,
            ((information.nFileIndexHigh as u64) << u32::BITS) | information.nFileIndexLow as u64,
        ))
    };
    if identity(parent.as_raw_handle() as _)? != identity(retained_parent.as_raw_handle() as _)? {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "Direct restore parent changed during the operation.",
        ));
    }
    let source = absolute_parent
        .join(source_name)
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = absolute_parent
        .join(target_name)
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_replace_direct_restore_entry(
    parent: &CapabilityDir,
    source_name: &OsStr,
    target_name: &OsStr,
    _absolute_parent: &Path,
) -> std::io::Result<()> {
    parent.rename(source_name, parent, target_name)
}

#[cfg(windows)]
fn atomic_publish_direct_restore_entry(
    parent: &CapabilityDir,
    source_name: &OsStr,
    target_name: &OsStr,
    absolute_parent: &Path,
) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, MoveFileExW, BY_HANDLE_FILE_INFORMATION,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        FILE_SHARE_WRITE, MOVEFILE_WRITE_THROUGH,
    };
    let metadata = fs::symlink_metadata(absolute_parent)?;
    if direct_checkpoint_metadata_is_link(&metadata) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "Direct restore parent is a Windows reparse point.",
        ));
    }
    let retained_parent = fs::OpenOptions::new()
        .access_mode(0)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(absolute_parent)?;
    let identity = |handle| -> std::io::Result<(u32, u64)> {
        let mut information = BY_HANDLE_FILE_INFORMATION::default();
        if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok((
            information.dwVolumeSerialNumber,
            ((information.nFileIndexHigh as u64) << u32::BITS) | information.nFileIndexLow as u64,
        ))
    };
    if identity(parent.as_raw_handle() as _)? != identity(retained_parent.as_raw_handle() as _)? {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "Direct restore parent changed during the operation.",
        ));
    }
    let source = absolute_parent
        .join(source_name)
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = absolute_parent
        .join(target_name)
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    if parent.symlink_metadata(target_name).is_ok() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "Direct restore target changed during the operation.",
        ));
    }
    let result = unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), MOVEFILE_WRITE_THROUGH) };
    if result == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_publish_direct_restore_entry(
    parent: &CapabilityDir,
    source_name: &OsStr,
    target_name: &OsStr,
    _absolute_parent: &Path,
) -> std::io::Result<()> {
    parent.hard_link(source_name, parent, target_name)?;
    parent.remove_file(source_name)
}

fn restore_direct_restore_backup(
    parent: &CapabilityDir,
    file_name: &OsStr,
    backup_name: Option<&OsStr>,
    absolute_parent: &Path,
) -> Result<()> {
    if let Some(backup_name) = backup_name {
        atomic_publish_direct_restore_entry(parent, backup_name, file_name, absolute_parent)
            .map_err(|error| BackendError::Io {
                message: format!("Failed to restore preserved direct-edit content: {error}"),
                source: error,
            })?;
    }
    Ok(())
}

struct DirectRestoreBackup {
    parent: CapabilityDir,
    file_name: OsString,
    backup_name: Option<OsString>,
    backup_fingerprint: Option<DirectRestoreFingerprint>,
    display_path: String,
    absolute_parent: PathBuf,
    expected_fingerprint: Option<DirectRestoreFingerprint>,
    _created_parents: Option<DirectRestoreCreatedParents>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DirectRestoreEntryKind {
    File,
    Symlink,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DirectRestoreFingerprint {
    digest: [u8; 32],
    kind: DirectRestoreEntryKind,
    mode: u32,
}

fn direct_restore_metadata_fingerprint(
    metadata: &cap_std::fs::Metadata,
    digest: [u8; 32],
    display_path: &str,
) -> Result<DirectRestoreFingerprint> {
    let kind = if metadata.file_type().is_symlink() {
        DirectRestoreEntryKind::Symlink
    } else if metadata.is_file() {
        DirectRestoreEntryKind::File
    } else {
        return Err(BackendError::Validation(format!(
            "Cannot fingerprint a non-file path while reverting {display_path}."
        )));
    };
    #[cfg(unix)]
    let mode = {
        use cap_std::fs::MetadataExt;
        metadata.mode() & 0o7777
    };
    #[cfg(windows)]
    let mode = {
        use cap_std::fs::MetadataExt;
        const FILE_ATTRIBUTE_READONLY: u32 = 0x0001;
        metadata.file_attributes() & FILE_ATTRIBUTE_READONLY
    };
    Ok(DirectRestoreFingerprint { digest, kind, mode })
}

fn direct_restore_published_fingerprint(
    parent: &CapabilityDir,
    file_name: &OsStr,
    digest: [u8; 32],
    display_path: &str,
) -> Result<DirectRestoreFingerprint> {
    let metadata = parent
        .symlink_metadata(file_name)
        .map_err(|error| BackendError::Io {
            message: format!("Failed to inspect reverted path {display_path}: {error}"),
            source: error,
        })?;
    direct_restore_metadata_fingerprint(&metadata, digest, display_path)
}

struct DirectRestoreCreatedParents {
    root: CapabilityDir,
    paths: Vec<PathBuf>,
}

impl Drop for DirectRestoreCreatedParents {
    fn drop(&mut self) {
        for path in self.paths.iter().rev() {
            match self.root.remove_dir(path) {
                Ok(()) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
                    ) => {}
                Err(error) => tracing::warn!(
                    path = %path.display(),
                    %error,
                    "Failed to remove a direct restore directory created by a rolled-back operation"
                ),
            }
        }
    }
}

fn restore_direct_tracked_path(
    repo: &Repository,
    worktree: &CapabilityDir,
    worktree_path: &Path,
    entry: &git2::IndexEntry,
    relative: &Path,
    display_path: &str,
    expected_revision: &str,
) -> Result<DirectRestoreBackup> {
    let odb = repo.odb().map_err(|error| {
        BackendError::git_object_missing(
            error,
            Some(entry.id.to_string()),
            Some("direct_restore_index_blob".to_string()),
        )
    })?;
    let (mut object_reader, object_size, object_type) = odb.reader(entry.id).map_err(|error| {
        BackendError::git_object_missing(
            error,
            Some(entry.id.to_string()),
            Some("direct_restore_index_blob".to_string()),
        )
    })?;
    if object_type != git2::ObjectType::Blob {
        return Err(BackendError::Validation(format!(
            "Direct checkpoint entry is not a blob: {display_path}"
        )));
    }
    let (parent, file_name, created_parents) =
        open_direct_restore_parent(worktree, relative, display_path)?;
    let absolute_parent = relative.parent().map_or_else(
        || worktree_path.to_path_buf(),
        |path| worktree_path.join(path),
    );
    let file_mode = entry.mode & 0o170000;
    if file_mode == 0o120000 {
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            if object_size > MAX_REVIEW_INLINE_BYTES {
                return Err(BackendError::Validation(format!(
                    "Direct checkpoint link target is too large: {display_path}"
                )));
            }
            let mut link_target = Vec::with_capacity(object_size);
            object_reader
                .read_to_end(&mut link_target)
                .map_err(|error| BackendError::Io {
                    message: format!("Failed to read linked path {display_path}: {error}"),
                    source: error,
                })?;
            let mut git_hasher = Sha1::new();
            git_hasher.update(format!("blob {object_size}\0").as_bytes());
            git_hasher.update(&link_target);
            if Oid::from_bytes(git_hasher.finalize().as_slice()).ok() != Some(entry.id) {
                return Err(BackendError::DirectCheckpointCorrupt {
                    message: "Macro's internal review checkpoint contains an altered file object."
                        .to_string(),
                    checkpoint_id: direct_checkpoint_repo_id(repo),
                    object_id: Some(entry.id.to_string()),
                    operation: Some("direct_restore_index_blob".to_string()),
                    retry_attempted: false,
                    accepted_history_at_risk: true,
                    git_output: None,
                });
            }
            let expected_digest: [u8; 32] = Sha256::digest(&link_target).into();
            let temporary_name = OsString::from(format!(
                ".{}.macro-restore-link-{}",
                file_name.to_string_lossy(),
                uuid::Uuid::new_v4().simple()
            ));
            parent
                .symlink_contents(OsString::from_vec(link_target), &temporary_name)
                .map_err(|error| BackendError::Io {
                    message: format!("Failed to create linked path {display_path}: {error}"),
                    source: error,
                })?;
            let backup =
                match move_direct_restore_entry_to_backup(&parent, &file_name, display_path) {
                    Ok(backup) => backup,
                    Err(error) => {
                        let _ = parent.remove_file(&temporary_name);
                        return Err(error);
                    }
                };
            if let Err(error) = verify_direct_restore_backup_revision(
                &parent,
                &file_name,
                backup.as_deref(),
                &absolute_parent,
                display_path,
                expected_revision,
            ) {
                let _ = parent.remove_file(&temporary_name);
                return Err(error);
            }
            if let Err(error) = atomic_publish_direct_restore_entry(
                &parent,
                &temporary_name,
                &file_name,
                &absolute_parent,
            ) {
                let _ = parent.remove_file(&temporary_name);
                let _ = restore_direct_restore_backup(
                    &parent,
                    &file_name,
                    backup.as_deref(),
                    &absolute_parent,
                );
                return Err(BackendError::Io {
                    message: format!("Failed to publish linked path {display_path}: {error}"),
                    source: error,
                });
            }
            let backup_fingerprint = backup
                .as_deref()
                .map(|name| direct_restore_entry_fingerprint(&parent, name, display_path))
                .transpose()?;
            let expected_fingerprint = direct_restore_published_fingerprint(
                &parent,
                &file_name,
                expected_digest,
                display_path,
            )?;
            return Ok(DirectRestoreBackup {
                parent,
                file_name,
                backup_name: backup,
                backup_fingerprint,
                display_path: display_path.to_string(),
                absolute_parent,
                expected_fingerprint: Some(expected_fingerprint),
                _created_parents: Some(created_parents),
            });
        }
        #[cfg(windows)]
        {
            return Err(BackendError::Validation(format!(
                "Restoring a linked path is not supported safely on Windows: {display_path}"
            )));
        }
    }
    #[cfg(unix)]
    let supported_regular_mode = file_mode == 0o100000;
    #[cfg(windows)]
    let supported_regular_mode = file_mode == 0o100000;
    if !supported_regular_mode {
        return Err(BackendError::Validation(format!(
            "Unsupported direct checkpoint entry for restore: {display_path}"
        )));
    }

    let temporary_name = format!(
        ".{}.macro-restore-{}-{}",
        file_name.to_string_lossy(),
        std::process::id(),
        REBASE_CHECK_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let mut options = CapabilityOpenOptions::new();
    options.write(true).create_new(true);
    let mut temporary = parent
        .open_with(&temporary_name, &options)
        .map_err(|error| BackendError::Io {
            message: format!("Failed to create reverted path {display_path}: {error}"),
            source: error,
        })?;
    let mut hasher = Sha256::new();
    let mut git_hasher = Sha1::new();
    git_hasher.update(format!("blob {object_size}\0").as_bytes());
    let mut buffer = [0u8; 64 * 1024];
    let write_result = loop {
        match object_reader.read(&mut buffer) {
            Ok(0) => break temporary.sync_all(),
            Ok(bytes_read) => {
                hasher.update(&buffer[..bytes_read]);
                git_hasher.update(&buffer[..bytes_read]);
                if let Err(error) = temporary.write_all(&buffer[..bytes_read]) {
                    break Err(error);
                }
            }
            Err(error) => break Err(error),
        }
    };
    if let Err(error) = write_result {
        drop(temporary);
        let _ = parent.remove_file(&temporary_name);
        return Err(BackendError::Io {
            message: format!("Failed to persist reverted path {display_path}: {error}"),
            source: error,
        });
    }
    if Oid::from_bytes(git_hasher.finalize().as_slice()).ok() != Some(entry.id) {
        drop(temporary);
        let _ = parent.remove_file(&temporary_name);
        return Err(BackendError::DirectCheckpointCorrupt {
            message: "Macro's internal review checkpoint contains an altered file object."
                .to_string(),
            checkpoint_id: direct_checkpoint_repo_id(repo),
            object_id: Some(entry.id.to_string()),
            operation: Some("direct_restore_index_blob".to_string()),
            retry_attempted: false,
            accepted_history_at_risk: true,
            git_output: None,
        });
    }
    let expected_digest: [u8; 32] = hasher.finalize().into();
    #[cfg(unix)]
    {
        use cap_std::fs::PermissionsExt;
        let mode = if entry.mode & 0o111 != 0 {
            0o755
        } else {
            0o644
        };
        if let Err(error) = temporary.set_permissions(cap_std::fs::Permissions::from_mode(mode)) {
            drop(temporary);
            let _ = parent.remove_file(&temporary_name);
            return Err(BackendError::Io {
                message: format!("Failed to set reverted path permissions {display_path}: {error}"),
                source: error,
            });
        }
    }
    drop(temporary);
    #[cfg(test)]
    if display_path == "macro-test-save-before-backup.txt" {
        let mut concurrent_options = CapabilityOpenOptions::new();
        concurrent_options.write(true).truncate(true);
        let mut concurrent = parent
            .open_with(&file_name, &concurrent_options)
            .expect("open concurrent save target");
        concurrent
            .write_all(b"save during restore\n")
            .expect("write concurrent save");
        concurrent.sync_all().expect("persist concurrent save");
    }
    let backup = match move_direct_restore_entry_to_backup(&parent, &file_name, display_path) {
        Ok(backup) => backup,
        Err(error) => {
            let _ = parent.remove_file(&temporary_name);
            return Err(error);
        }
    };
    if let Err(error) = verify_direct_restore_backup_revision(
        &parent,
        &file_name,
        backup.as_deref(),
        &absolute_parent,
        display_path,
        expected_revision,
    ) {
        let _ = parent.remove_file(&temporary_name);
        return Err(error);
    }
    #[cfg(test)]
    if display_path == "macro-test-concurrent-save.txt" {
        let mut concurrent_options = CapabilityOpenOptions::new();
        concurrent_options.write(true).create_new(true);
        let mut concurrent = parent
            .open_with(&file_name, &concurrent_options)
            .expect("inject concurrent save");
        concurrent
            .write_all(b"concurrent save\n")
            .expect("write concurrent save");
        concurrent.sync_all().expect("persist concurrent save");
    }
    #[cfg(test)]
    if display_path == "macro-test-fail-after-backup.txt" {
        let _ = parent.remove_file(&temporary_name);
        restore_direct_restore_backup(&parent, &file_name, backup.as_deref(), &absolute_parent)?;
        let concurrent_name = OsStr::new("macro-test-concurrent-rollback.txt");
        if parent.symlink_metadata(concurrent_name).is_ok() {
            parent
                .remove_file(concurrent_name)
                .expect("replace published file with a concurrent directory");
            parent
                .create_dir(concurrent_name)
                .expect("create concurrent directory");
            let concurrent_dir = parent
                .open_dir(concurrent_name)
                .expect("open concurrent directory");
            let mut options = CapabilityOpenOptions::new();
            options.write(true).create_new(true);
            let mut marker = concurrent_dir
                .open_with("keep.txt", &options)
                .expect("create concurrent marker");
            marker
                .write_all(b"concurrent directory\n")
                .expect("write concurrent marker");
            marker.sync_all().expect("persist concurrent marker");
        }
        let concurrent_file_name = OsStr::new("macro-test-concurrent-file-rollback.txt");
        if parent.symlink_metadata(concurrent_file_name).is_ok() {
            let mut options = CapabilityOpenOptions::new();
            options.write(true).truncate(true);
            let mut concurrent = parent
                .open_with(concurrent_file_name, &options)
                .expect("open concurrent rollback file");
            concurrent
                .write_all(b"concurrent file save\n")
                .expect("write concurrent rollback file");
            concurrent
                .sync_all()
                .expect("persist concurrent rollback file");
        }
        return Err(BackendError::Validation(
            "Injected direct restore failure after backup.".to_string(),
        ));
    }
    if let Err(error) = atomic_publish_direct_restore_entry(
        &parent,
        OsStr::new(&temporary_name),
        &file_name,
        &absolute_parent,
    ) {
        let _ = parent.remove_file(&temporary_name);
        let _ =
            restore_direct_restore_backup(&parent, &file_name, backup.as_deref(), &absolute_parent);
        return Err(BackendError::Io {
            message: format!("Failed to publish reverted path {display_path}: {error}"),
            source: error,
        });
    }
    let backup_fingerprint = backup
        .as_deref()
        .map(|name| direct_restore_entry_fingerprint(&parent, name, display_path))
        .transpose()?;
    let expected_fingerprint =
        direct_restore_published_fingerprint(&parent, &file_name, expected_digest, display_path)?;
    Ok(DirectRestoreBackup {
        parent,
        file_name,
        backup_name: backup,
        backup_fingerprint,
        display_path: display_path.to_string(),
        absolute_parent,
        expected_fingerprint: Some(expected_fingerprint),
        _created_parents: Some(created_parents),
    })
}

fn direct_restore_entry_fingerprint(
    parent: &CapabilityDir,
    file_name: &OsStr,
    display_path: &str,
) -> Result<DirectRestoreFingerprint> {
    let mut budget = usize::MAX;
    direct_restore_entry_fingerprint_bounded(parent, file_name, display_path, None, &mut budget)
}

fn direct_restore_entry_fingerprint_bounded(
    parent: &CapabilityDir,
    file_name: &OsStr,
    display_path: &str,
    cancellation: Option<&Arc<AtomicBool>>,
    remaining_bytes: &mut usize,
) -> Result<DirectRestoreFingerprint> {
    if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err(BackendError::Git {
            message: "Git review was cancelled.".to_string(),
        });
    }
    let metadata = parent
        .symlink_metadata(file_name)
        .map_err(|error| BackendError::Io {
            message: format!("Failed to inspect preserved path {display_path}: {error}"),
            source: error,
        })?;
    let mut hasher = Sha256::new();
    if metadata.file_type().is_symlink() {
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            let target =
                parent
                    .read_link_contents(file_name)
                    .map_err(|error| BackendError::Io {
                        message: format!(
                            "Failed to inspect preserved link {display_path}: {error}"
                        ),
                        source: error,
                    })?;
            if target.as_os_str().as_bytes().len() > *remaining_bytes {
                return Err(BackendError::FilesystemFileTooLarge {
                    message: "Direct review revision budget exceeded.".to_string(),
                });
            }
            *remaining_bytes -= target.as_os_str().as_bytes().len();
            hasher.update(target.as_os_str().as_bytes());
        }
        #[cfg(windows)]
        return Err(BackendError::Validation(format!(
            "Cannot verify a native linked path safely on Windows: {display_path}"
        )));
    } else if metadata.is_file() {
        let mut file = open_direct_regular_file_no_follow(parent, file_name).map_err(|error| {
            BackendError::Io {
                message: format!("Failed to inspect preserved path {display_path}: {error}"),
                source: error,
            }
        })?;
        let size = usize::try_from(
            file.metadata()
                .map_err(|error| BackendError::Io {
                    message: format!("Failed to inspect preserved path {display_path}: {error}"),
                    source: error,
                })?
                .len(),
        )
        .map_err(|_| BackendError::FilesystemFileTooLarge {
            message: "Direct review file exceeds the supported size.".to_string(),
        })?;
        if size > *remaining_bytes {
            return Err(BackendError::FilesystemFileTooLarge {
                message: "Direct review revision budget exceeded.".to_string(),
            });
        }
        *remaining_bytes -= size;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
                return Err(BackendError::Git {
                    message: "Git review was cancelled.".to_string(),
                });
            }
            let bytes_read = file.read(&mut buffer).map_err(|error| BackendError::Io {
                message: format!("Failed to inspect preserved path {display_path}: {error}"),
                source: error,
            })?;
            if bytes_read == 0 {
                break;
            }
            hasher.update(&buffer[..bytes_read]);
            #[cfg(test)]
            if display_path == "macro-test-cancel-revision.bin" {
                if let Some(flag) = cancellation {
                    flag.store(true, Ordering::Release);
                }
            }
        }
    } else {
        return Err(BackendError::Validation(format!(
            "Cannot verify a non-file path while reverting {display_path}."
        )));
    }
    let digest = hasher.finalize().into();
    direct_restore_metadata_fingerprint(&metadata, digest, display_path)
}

fn encode_direct_restore_digest(digest: &[u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn direct_restore_revision_from_fingerprint(fingerprint: DirectRestoreFingerprint) -> String {
    let kind = match fingerprint.kind {
        DirectRestoreEntryKind::File => "file",
        DirectRestoreEntryKind::Symlink => "symlink",
    };
    format!(
        "v1:{kind}:{:o}:{}",
        fingerprint.mode,
        encode_direct_restore_digest(&fingerprint.digest)
    )
}

fn direct_worktree_revision(
    worktree: &CapabilityDir,
    relative: &Path,
    display_path: &str,
) -> Result<String> {
    let mut budget = usize::MAX;
    direct_worktree_revision_bounded(worktree, relative, display_path, None, &mut budget)
}

fn direct_worktree_revision_bounded(
    worktree: &CapabilityDir,
    relative: &Path,
    display_path: &str,
    cancellation: Option<&Arc<AtomicBool>>,
    remaining_bytes: &mut usize,
) -> Result<String> {
    if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err(BackendError::Git {
            message: "Git review was cancelled.".to_string(),
        });
    }
    let file_name = relative.file_name().ok_or_else(|| {
        BackendError::Validation(format!("Invalid direct review path: {display_path}"))
    })?;
    let mut parent = worktree.try_clone().map_err(|error| BackendError::Io {
        message: format!("Failed to retain direct review root: {error}"),
        source: error,
    })?;
    if let Some(parent_path) = relative.parent() {
        for component in parent_path.components() {
            let std::path::Component::Normal(segment) = component else {
                return Err(BackendError::Validation(format!(
                    "Invalid direct review path: {display_path}"
                )));
            };
            match parent.symlink_metadata(segment) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                Ok(_) => {
                    return Err(BackendError::Validation(format!(
                        "Direct review path crosses a linked parent: {display_path}"
                    )));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok("v1:absent".to_string());
                }
                Err(error) => {
                    return Err(BackendError::Io {
                        message: format!("Failed to inspect direct review path: {error}"),
                        source: error,
                    });
                }
            }
            parent = parent.open_dir(segment).map_err(|error| BackendError::Io {
                message: format!("Failed to retain direct review parent: {error}"),
                source: error,
            })?;
        }
    }
    match parent.symlink_metadata(file_name) {
        Ok(_) => direct_restore_entry_fingerprint_bounded(
            &parent,
            file_name,
            display_path,
            cancellation,
            remaining_bytes,
        )
        .map(direct_restore_revision_from_fingerprint),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok("v1:absent".to_string()),
        Err(error) => Err(BackendError::Io {
            message: format!("Failed to inspect direct review path: {error}"),
            source: error,
        }),
    }
}

fn verify_direct_restore_backup_revision(
    parent: &CapabilityDir,
    file_name: &OsStr,
    backup_name: Option<&OsStr>,
    absolute_parent: &Path,
    display_path: &str,
    expected_revision: &str,
) -> Result<()> {
    let actual_revision = match backup_name {
        Some(backup_name) => {
            match direct_restore_entry_fingerprint(parent, backup_name, display_path) {
                Ok(fingerprint) => direct_restore_revision_from_fingerprint(fingerprint),
                Err(error) => {
                    if let Err(restore_error) = restore_direct_restore_backup(
                        parent,
                        file_name,
                        Some(backup_name),
                        absolute_parent,
                    ) {
                        tracing::warn!(
                            path = %display_path,
                            %restore_error,
                            "Retained an unreadable direct restore backup"
                        );
                    }
                    return Err(error);
                }
            }
        }
        None => "v1:absent".to_string(),
    };
    if actual_revision == expected_revision {
        return Ok(());
    }
    if let Err(error) =
        restore_direct_restore_backup(parent, file_name, backup_name, absolute_parent)
    {
        tracing::warn!(
            path = %display_path,
            %error,
            "Retained a stale direct restore backup after a revision conflict"
        );
    }
    Err(BackendError::RevisionConflict {
        message: format!(
            "The direct-review file changed after the snapshot was loaded: {display_path}"
        ),
    })
}

fn prepare_direct_untracked_removal(
    worktree: &CapabilityDir,
    worktree_path: &Path,
    relative: &Path,
    display_path: &str,
    expected_revision: &str,
) -> Result<Option<DirectRestoreBackup>> {
    let file_name = relative.file_name().ok_or_else(|| {
        BackendError::Validation(format!("Invalid direct restore path: {display_path}"))
    })?;
    let mut parent = worktree.try_clone().map_err(|error| BackendError::Io {
        message: format!("Failed to retain direct restore root: {error}"),
        source: error,
    })?;
    if let Some(parent_path) = relative.parent() {
        for component in parent_path.components() {
            let std::path::Component::Normal(segment) = component else {
                return Err(BackendError::Validation(format!(
                    "Invalid direct restore path: {display_path}"
                )));
            };
            match parent.symlink_metadata(segment) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                Ok(_) => {
                    return Err(BackendError::Validation(format!(
                        "Direct restore path crosses a linked or non-directory entry: {display_path}"
                    )));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => {
                    return Err(BackendError::Io {
                        message: format!(
                            "Failed to inspect a parent for reverted path {display_path}: {error}"
                        ),
                        source: error,
                    });
                }
            }
            parent = parent.open_dir(segment).map_err(|error| BackendError::Io {
                message: format!(
                    "Failed to retain a parent for reverted path {display_path}: {error}"
                ),
                source: error,
            })?;
        }
    }
    let backup_name = move_direct_restore_entry_to_backup(&parent, &file_name, display_path)?;
    verify_direct_restore_backup_revision(
        &parent,
        &file_name,
        backup_name.as_deref(),
        &relative.parent().map_or_else(
            || worktree_path.to_path_buf(),
            |path| worktree_path.join(path),
        ),
        display_path,
        expected_revision,
    )?;
    let Some(backup_name) = backup_name else {
        return Ok(None);
    };
    let backup_fingerprint = direct_restore_entry_fingerprint(&parent, &backup_name, display_path)?;
    Ok(Some(DirectRestoreBackup {
        parent,
        file_name: file_name.to_os_string(),
        backup_name: Some(backup_name),
        backup_fingerprint: Some(backup_fingerprint),
        display_path: display_path.to_string(),
        absolute_parent: relative.parent().map_or_else(
            || worktree_path.to_path_buf(),
            |path| worktree_path.join(path),
        ),
        expected_fingerprint: None,
        _created_parents: None,
    }))
}

fn rollback_direct_restore(entry: &DirectRestoreBackup) -> Result<()> {
    let current = match entry.parent.symlink_metadata(&entry.file_name) {
        Ok(_) => Some(direct_restore_entry_fingerprint(
            &entry.parent,
            &entry.file_name,
            &entry.display_path,
        )?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(BackendError::Io {
                message: format!("Failed to inspect a direct restore rollback: {error}"),
                source: error,
            });
        }
    };
    if current != entry.expected_fingerprint {
        return Err(BackendError::RevisionConflict {
            message: "A concurrent edit was preserved while the direct restore rolled back."
                .to_string(),
        });
    }
    let displaced_name = if current.is_some() {
        move_direct_restore_entry_to_backup(&entry.parent, &entry.file_name, &entry.display_path)?
    } else {
        None
    };
    if let Some(displaced_name) = displaced_name.as_deref() {
        if direct_restore_entry_fingerprint(&entry.parent, displaced_name, &entry.display_path)?
            != entry.expected_fingerprint.expect("checked above")
        {
            restore_direct_restore_backup(
                &entry.parent,
                &entry.file_name,
                Some(displaced_name),
                &entry.absolute_parent,
            )?;
            return Err(BackendError::RevisionConflict {
                message: "A concurrent edit was preserved while the direct restore rolled back."
                    .to_string(),
            });
        }
    }
    restore_direct_restore_backup(
        &entry.parent,
        &entry.file_name,
        entry.backup_name.as_deref(),
        &entry.absolute_parent,
    )?;
    if let Some(displaced_name) = displaced_name.as_deref() {
        #[cfg(test)]
        if entry.display_path == "macro-test-concurrent-displaced-rollback.txt" {
            entry
                .parent
                .remove_file(displaced_name)
                .expect("replace displaced rollback artifact");
            entry
                .parent
                .create_dir(displaced_name)
                .expect("create concurrent displaced directory");
            let directory = entry
                .parent
                .open_dir(displaced_name)
                .expect("open concurrent displaced directory");
            let mut options = CapabilityOpenOptions::new();
            options.write(true).create_new(true);
            let mut marker = directory
                .open_with("keep.txt", &options)
                .expect("create concurrent displaced marker");
            marker.write_all(b"keep\n").expect("write displaced marker");
        }
        remove_direct_restore_entry_if_matches(
            &entry.parent,
            displaced_name,
            &entry.display_path,
            entry.expected_fingerprint.expect("checked above"),
        )?;
    }
    Ok(())
}

fn commit_direct_restore(entry: &DirectRestoreBackup) {
    if let Some(backup_name) = entry.backup_name.as_deref() {
        #[cfg(test)]
        if entry.display_path == "macro-test-keep-backup-on-cleanup-failure.txt" {
            return;
        }
        #[cfg(test)]
        if entry.display_path == "macro-test-concurrent-backup-cleanup.txt" {
            entry
                .parent
                .remove_file(backup_name)
                .expect("replace backup before cleanup");
            entry
                .parent
                .create_dir(backup_name)
                .expect("create concurrent backup directory");
            let directory = entry
                .parent
                .open_dir(backup_name)
                .expect("open concurrent backup directory");
            let mut options = CapabilityOpenOptions::new();
            options.write(true).create_new(true);
            let mut marker = directory
                .open_with("keep.txt", &options)
                .expect("create concurrent backup marker");
            marker.write_all(b"keep\n").expect("write backup marker");
        }
        let Some(backup_fingerprint) = entry.backup_fingerprint else {
            tracing::warn!(
                path = %entry.display_path,
                "Retained a direct restore backup without a verified identity"
            );
            return;
        };
        if let Err(error) = remove_direct_restore_entry_if_matches(
            &entry.parent,
            backup_name,
            &entry.display_path,
            backup_fingerprint,
        ) {
            tracing::warn!(
                path = %entry.display_path,
                %error,
                "Retained a direct restore backup because cleanup failed"
            );
        }
    }
}

#[cfg(test)]
fn restore_direct_worktree_paths(
    repo: &Repository,
    validated: &Path,
    paths: Vec<String>,
) -> Result<()> {
    let expanded = expand_direct_rename_paths(repo, &paths, DirectRenameAxis::Worktree)?;
    let root = open_direct_restore_capability(validated)?;
    let revisions = expanded
        .iter()
        .map(|path| {
            let relative = validate_repo_relative_file_path(path)?;
            Ok((
                path.clone(),
                direct_worktree_revision(&root, &relative, path)?,
            ))
        })
        .collect::<Result<HashMap<_, _>>>()?;
    restore_direct_worktree_paths_with_revisions(repo, validated, paths, &revisions, None)
}

fn restore_direct_worktree_paths_with_revisions(
    repo: &Repository,
    validated: &Path,
    paths: Vec<String>,
    expected_revisions: &HashMap<String, String>,
    cancellation: Option<&Arc<AtomicBool>>,
) -> Result<()> {
    ensure_direct_checkpoint_integrity_with_cancellation(repo, cancellation)?;
    let paths = expand_direct_rename_paths(repo, &paths, DirectRenameAxis::Worktree)?;
    if paths.len() > MAX_DIRECT_REVIEW_PATHS {
        return Err(BackendError::FilesystemFileTooLarge {
            message: "Direct restore contains too many changed paths.".to_string(),
        });
    }
    let mut index = repo.index()?;
    index.read(true)?;
    let restore_root = open_direct_restore_capability(validated)?;
    let mut remaining_revision_bytes = MAX_DIRECT_REVIEW_REVISION_BYTES;
    let validated_paths = paths
        .into_iter()
        .map(|path| {
            let relative = validate_repo_relative_file_path(&path)?;
            reject_direct_checkpoint_excluded_path(&relative)?;
            if direct_worktree_path_has_linked_parent(validated, &relative)? {
                return Err(BackendError::Validation(format!(
                    "Direct restore path crosses a linked parent: {path}"
                )));
            }
            let expected_revision = expected_revisions.get(&path).cloned().ok_or_else(|| {
                BackendError::RevisionConflict {
                    message: format!(
                        "The direct-review snapshot has no revision for the selected path: {path}"
                    ),
                }
            })?;
            let actual_revision = direct_worktree_revision_bounded(
                &restore_root,
                &relative,
                &path,
                cancellation,
                &mut remaining_revision_bytes,
            )?;
            if actual_revision != expected_revision {
                return Err(BackendError::RevisionConflict {
                    message: format!(
                        "The direct-review file changed after the snapshot was loaded: {path}"
                    ),
                });
            }
            Ok((path, relative, expected_revision))
        })
        .collect::<Result<Vec<_>>>()?;
    let mut applied = Vec::new();
    for (path, relative, expected_revision) in validated_paths {
        let result = if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            Err(BackendError::Git {
                message: "Git review was cancelled.".to_string(),
            })
        } else if let Some(entry) = index.get_path(&relative, 0) {
            restore_direct_tracked_path(
                repo,
                &restore_root,
                validated,
                &entry,
                &relative,
                &path,
                &expected_revision,
            )
            .map(Some)
        } else {
            prepare_direct_untracked_removal(
                &restore_root,
                validated,
                &relative,
                &path,
                &expected_revision,
            )
        };
        match result {
            Ok(Some(backup)) => applied.push(backup),
            Ok(None) => {}
            Err(error) => {
                let mut rollback_errors = Vec::new();
                for backup in applied.iter().rev() {
                    if let Err(rollback_error) = rollback_direct_restore(backup) {
                        rollback_errors.push(format!("{}: {rollback_error}", backup.display_path));
                    }
                }
                if !rollback_errors.is_empty() {
                    return Err(BackendError::Validation(format!(
                        "Direct restore failed and Macro could not restore every preserved file: {error}; rollback: {}",
                        rollback_errors.join("; ")
                    )));
                }
                return Err(error);
            }
        }
    }
    if cancellation.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        let mut rollback_errors = Vec::new();
        for backup in applied.iter().rev() {
            if let Err(error) = rollback_direct_restore(backup) {
                rollback_errors.push(error.to_string());
            }
        }
        if !rollback_errors.is_empty() {
            return Err(BackendError::Validation(
                "Direct restore was cancelled and at least one concurrent edit prevented a complete rollback."
                    .to_string(),
            ));
        }
        return Err(BackendError::Git {
            message: "Git review was cancelled.".to_string(),
        });
    }
    for backup in &applied {
        commit_direct_restore(backup);
    }
    Ok(())
}

#[tauri::command]
pub async fn direct_restore_worktree_paths(
    app: AppHandle,
    workspace_root: State<'_, WorkspaceRoot>,
    task_id: String,
    project_path: String,
    checkpoint_id: Option<String>,
    snapshot_id: String,
    paths: Vec<String>,
    request_id: String,
) -> Result<()> {
    if paths.len() > MAX_DIRECT_REVIEW_PATHS {
        return Err(BackendError::FilesystemFileTooLarge {
            message: "Direct restore path limit exceeded.".to_string(),
        });
    }
    let workspace = workspace_root.inner().read().await.clone();
    let (cancellation, cancellation_guard) = register_git_review_cancellation(Some(&request_id))?;
    tokio::task::spawn_blocking(move || {
        let _cancellation_guard = cancellation_guard;
        with_locked_direct_checkpoint(
            &app,
            &workspace,
            &task_id,
            &project_path,
            checkpoint_id.as_deref(),
            false,
            |repo, validated| {
                let expanded =
                    expand_direct_rename_paths(repo, &paths, DirectRenameAxis::Worktree)?;
                let expected_revisions = resolve_direct_review_authorization(
                    &snapshot_id,
                    &task_id,
                    validated,
                    &direct_checkpoint_repo_id(repo),
                    &direct_checkpoint_revision(repo)?,
                    &expanded,
                )?;
                restore_direct_worktree_paths_with_revisions(
                    repo,
                    validated,
                    paths,
                    &expected_revisions,
                    cancellation.as_ref(),
                )
            },
        )
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
        with_locked_direct_checkpoint(
            &app,
            &workspace,
            &task_id,
            &project_path,
            checkpoint_id.as_deref(),
            false,
            |repo, _| {
                let commit = accept_direct_changes(repo)?;
                invalidate_direct_review_authorizations(&direct_checkpoint_repo_id(repo));
                Ok(commit)
            },
        )
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
    request_id: Option<String>,
) -> Result<GitReviewFileDto> {
    let (cancellation, _cancellation_guard) =
        register_git_review_cancellation(request_id.as_deref())?;
    if parse_wsl_repo_path(&repo_path).is_some() {
        return Err(unsupported_wsl_git_operation("git_review_file"));
    }

    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let relative_path = validate_repo_relative_file_path(&path)?;
        let operation_cancellation = cancellation.clone();
        run_review_with_missing_object_retry(&git_state, &validated, cancellation, |repo| {
            if git_review_is_cancelled(&operation_cancellation) {
                return Err(BackendError::Git {
                    message: "Git review was cancelled.".to_string(),
                });
            }
            let status = build_git_status(repo)?;
            let status_label = status
                .staged_files
                .iter()
                .chain(status.unstaged_files.iter())
                .chain(status.untracked_files.iter())
                .find(|file| file.path == path)
                .map(|file| file.status.as_str())
                .unwrap_or("modified");

            review::build_git_review_file_with_cancellation(
                repo,
                &validated,
                &relative_path,
                status_label,
                || git_review_is_cancelled(&operation_cancellation),
            )
            .map_err(|error| error.with_git_object_context(None, "git_review_file"))
        })
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

fn build_git_task_start_points(repo: &Repository) -> Result<GitTaskStartPointsDto> {
    let names = repo.worktrees().map_err(|error| BackendError::Git {
        message: format!("Failed to list registered worktrees: {error}"),
    })?;
    let mut worktrees = Vec::new();
    let mut occupied_branches = std::collections::HashSet::new();
    if let Ok(head) = repo.head() {
        if head.is_branch() {
            if let Ok(branch_name) = head.shorthand() {
                occupied_branches.insert(branch_name.to_string());
            }
        }
    }
    let macro_worktree_root = repo
        .workdir()
        .map(|workdir| workdir.join(".macro").join("worktrees"));
    let macro_metadata_worktree = repo.path().join(MACRO_WORKTREE_DIR_NAME);
    for name in names.iter().flatten().flatten() {
        let Ok(worktree) = repo.find_worktree(name) else {
            continue;
        };
        let path = worktree.path().to_path_buf();
        let Ok(worktree_repo) = git2::Repository::open(&path) else {
            continue;
        };
        let Ok(head) = worktree_repo.head() else {
            continue;
        };
        let Ok(branch_name) = head.shorthand().map(str::to_string) else {
            continue;
        };
        if !head.is_branch() {
            continue;
        }
        occupied_branches.insert(branch_name.clone());
        if branch_name == MACRO_BRANCH_NAME
            || path == macro_metadata_worktree
            || macro_worktree_root
                .as_ref()
                .is_some_and(|root| path.starts_with(root))
        {
            continue;
        }
        let is_dirty = worktree_repo
            .statuses(None)
            .map(|statuses| !statuses.is_empty())
            .unwrap_or(false);
        worktrees.push(GitAvailableWorktreeDto {
            name: name.to_string(),
            path: path.to_string_lossy().into_owned(),
            branch_name,
            is_dirty,
        });
    }
    worktrees.sort_by(|left, right| left.branch_name.cmp(&right.branch_name));

    let mut branches = Vec::new();
    for branch in repo.branches(Some(git2::BranchType::Local))? {
        let (branch, _) = branch?;
        let Some(name) = branch.name()?.map(str::to_string) else {
            continue;
        };
        if name == MACRO_BRANCH_NAME || occupied_branches.contains(&name) {
            continue;
        }
        let commit = branch
            .get()
            .peel_to_commit()
            .map(|commit| short_hash(commit.id()))
            .unwrap_or_default();
        branches.push(GitAvailableTaskBranchDto { name, commit });
    }
    branches.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(GitTaskStartPointsDto {
        worktrees,
        branches,
    })
}

#[tauri::command]
/// List external worktrees and local branches that can start a new task.
pub async fn git_task_start_points(
    workspace_root: State<'_, WorkspaceRoot>,
    git_state: State<'_, GitState>,
    repo_path: String,
) -> Result<GitTaskStartPointsDto> {
    if parse_wsl_repo_path(&repo_path).is_some() {
        return Err(unsupported_wsl_git_operation("git_task_start_points"));
    }

    let workspace = workspace_root.inner().read().await.clone();
    let git_state = git_state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let validated = validate_repo_path(&repo_path, &workspace)?;
        let repo = git_state.open_repo(&validated)?;
        let repo = repo.lock().map_err(|_| BackendError::Internal {
            message: "Failed to lock repository".to_string(),
        })?;
        build_git_task_start_points(&repo)
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
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use tempfile::TempDir;

    fn run_test_git(args: &[String]) {
        let output = background_command("git")
            .args(args)
            .output()
            .expect("run git for test");
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(windows)]
    fn create_windows_junction(link: &Path, target: &Path) {
        let status = background_command("cmd")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .status()
            .expect("create Windows junction");
        assert!(status.success(), "mklink /J must create the test junction");
    }

    #[test]
    fn detects_every_supported_partial_clone_configuration() {
        let temp = TempDir::new().expect("temp dir");
        let repo = Repository::init(temp.path()).expect("init repo");
        {
            let mut config = repo.config().expect("repo config");
            config
                .set_str("extensions.partialClone", "origin")
                .expect("partial clone extension");
            config
                .set_bool("remote.cache.promisor", true)
                .expect("promisor remote");
            config
                .set_str("remote.origin.partialCloneFilter", "blob:none")
                .expect("partial clone filter");
        }

        let detected = detect_partial_clone(&repo).expect("detect partial clone");
        assert_eq!(detected.extension_remote.as_deref(), Some("origin"));
        assert_eq!(detected.promisor_remotes, vec!["cache"]);
        assert_eq!(
            detected.filters,
            vec![("origin".to_string(), "blob:none".to_string())]
        );
        assert!(detected.is_partial());
    }

    #[test]
    fn direct_review_rejects_wsl_paths_until_linux_modes_are_preserved() {
        for path in [
            r"\\wsl$\Ubuntu\home\user\project",
            r"\\wsl.localhost\Ubuntu\home\user\project",
        ] {
            assert!(matches!(
                reject_unsupported_direct_project_path(path),
                Err(BackendError::Validation(message))
                    if message.contains("preserve Linux file modes safely")
            ));
        }
        assert!(reject_unsupported_direct_project_path(r"C:\work\project").is_ok());
    }

    #[test]
    fn official_git_hydrates_one_promised_blob_without_checkout() {
        let temp = TempDir::new().expect("temp dir");
        let source = temp.path().join("source");
        let origin = temp.path().join("origin.git");
        let partial = temp.path().join("partial");
        fs::create_dir_all(&source).expect("create source");
        run_test_git(&[
            "init".to_string(),
            "-q".to_string(),
            source.display().to_string(),
        ]);
        for (key, value) in [
            ("user.email", "tester@example.com"),
            ("user.name", "Tester"),
        ] {
            run_test_git(&[
                "-C".to_string(),
                source.display().to_string(),
                "config".to_string(),
                key.to_string(),
                value.to_string(),
            ]);
        }
        fs::write(source.join("promised.txt"), "promised\n".repeat(4096))
            .expect("write promised blob");
        run_test_git(&[
            "-C".to_string(),
            source.display().to_string(),
            "add".to_string(),
            "promised.txt".to_string(),
        ]);
        run_test_git(&[
            "-C".to_string(),
            source.display().to_string(),
            "commit".to_string(),
            "-qm".to_string(),
            "base".to_string(),
        ]);
        run_test_git(&[
            "clone".to_string(),
            "-q".to_string(),
            "--bare".to_string(),
            source.display().to_string(),
            origin.display().to_string(),
        ]);
        for (key, value) in [
            ("uploadpack.allowFilter", "true"),
            ("uploadpack.allowAnySHA1InWant", "true"),
        ] {
            run_test_git(&[
                format!("--git-dir={}", origin.display()),
                "config".to_string(),
                key.to_string(),
                value.to_string(),
            ]);
        }
        struct GitDaemon(std::process::Child);
        impl Drop for GitDaemon {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("reserve Git port");
        let port = listener.local_addr().expect("Git listener address").port();
        drop(listener);
        let mut daemon_command = background_command("git");
        daemon_command
            .args([
                "daemon".to_string(),
                "--reuseaddr".to_string(),
                "--export-all".to_string(),
                format!("--base-path={}", temp.path().display()),
                "--listen=127.0.0.1".to_string(),
                format!("--port={port}"),
                temp.path().display().to_string(),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let _daemon = GitDaemon(daemon_command.spawn().expect("start local Git daemon"));
        let daemon_address = ("127.0.0.1", port);
        let mut ready = false;
        for _ in 0..50 {
            if std::net::TcpStream::connect(daemon_address).is_ok() {
                ready = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(ready, "local Git daemon did not start");
        let origin_url = format!("git://127.0.0.1:{port}/origin.git");
        run_test_git(&[
            "clone".to_string(),
            "-q".to_string(),
            "--filter=blob:none".to_string(),
            "--no-checkout".to_string(),
            origin_url,
            partial.display().to_string(),
        ]);
        run_test_git(&[
            "-C".to_string(),
            partial.display().to_string(),
            "read-tree".to_string(),
            "HEAD".to_string(),
        ]);

        let repo = Repository::open(&partial).expect("open partial clone");
        let mut index = repo.index().expect("partial index");
        index.read(true).expect("refresh partial index");
        let object_id = index
            .get_path(Path::new("promised.txt"), 0)
            .expect("promised index entry")
            .id;
        let missing = repo
            .find_blob(object_id)
            .expect_err("blob must start as promised and absent");
        assert_eq!(missing.class(), git2::ErrorClass::Odb);
        assert_eq!(missing.code(), git2::ErrorCode::NotFound);
        assert!(detect_partial_clone(&repo)
            .expect("detect partial clone")
            .is_partial());
        assert!(!partial.join("promised.txt").exists());

        drop(index);
        drop(repo);
        let git_state = GitState::new();
        let snapshot = run_review_with_missing_object_retry(&git_state, &partial, None, |repo| {
            review::build_git_review_snapshot(repo, &partial)
                .map_err(|error| error.with_git_object_context(None, "git_review_snapshot"))
        })
        .expect("the full review snapshot should hydrate the promised blob with official Git");
        assert!(snapshot
            .changes
            .iter()
            .any(|change| change.path == "promised.txt"));
        assert!(GitState::new()
            .open_repo(&partial)
            .expect("reopen hydrated partial clone")
            .lock()
            .expect("lock hydrated partial clone")
            .find_blob(object_id)
            .is_ok());
        assert!(!partial.join("promised.txt").exists());
    }

    #[test]
    fn contained_git_command_bounds_descendants_that_keep_output_open() {
        let temp = TempDir::new().expect("temp dir");
        Repository::init(temp.path()).expect("init repo");
        let args = vec![
            "-c".to_string(),
            "alias.macro-pipe=!sh -c 'sleep 30 &'".to_string(),
            "macro-pipe".to_string(),
        ];
        let started = std::time::Instant::now();
        let output = run_contained_git_command_with_timeout(
            temp.path(),
            &args,
            Duration::from_secs(8),
            true,
        )
        .expect("the completed Git parent must terminate descendants and drain both pipes");
        assert!(output.success);
        assert!(
            started.elapsed() < Duration::from_secs(12),
            "contained Git command or its output readers outlived their bounds"
        );
    }

    #[test]
    fn contained_git_command_timeout_terminates_the_process_group() {
        let temp = TempDir::new().expect("temp dir");
        Repository::init(temp.path()).expect("init repo");
        let args = vec![
            "-c".to_string(),
            "alias.macro-timeout=!sh -c 'sleep 30 & wait'".to_string(),
            "macro-timeout".to_string(),
        ];
        let started = std::time::Instant::now();
        let error = match run_contained_git_command_with_timeout(
            temp.path(),
            &args,
            Duration::from_millis(200),
            true,
        ) {
            Ok(_) => panic!("the Git command must exceed its deadline"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("timed out"));
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "the timed-out Git process group or its output readers outlived their bounds"
        );
    }

    #[test]
    fn contained_git_review_cancellation_terminates_the_process_group() {
        let temp = TempDir::new().expect("temp dir");
        Repository::init(temp.path()).expect("init repo");
        let cancellation = Arc::new(AtomicBool::new(false));
        let worker_cancellation = cancellation.clone();
        let repo_path = temp.path().to_path_buf();
        let started = std::time::Instant::now();
        let worker = std::thread::spawn(move || {
            run_contained_git_command_with_timeout_and_cancellation(
                &repo_path,
                &[
                    "-c".to_string(),
                    "alias.macro-wait=!sh -c 'sleep 30'".to_string(),
                    "macro-wait".to_string(),
                ],
                Duration::from_secs(30),
                true,
                Some(worker_cancellation),
            )
        });
        std::thread::sleep(Duration::from_millis(150));
        cancellation.store(true, Ordering::Release);

        let error = match worker.join().expect("cancellation worker") {
            Ok(_) => panic!("cancelled Git review must stop"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("cancelled"));
        assert!(started.elapsed() < Duration::from_secs(4));
    }

    #[test]
    fn cancelled_hydration_does_not_retry_the_review_operation() {
        let temp = TempDir::new().expect("temporary repository");
        let repo = Repository::init(temp.path()).expect("initialize repository");
        repo.config()
            .and_then(|mut config| {
                config.set_bool("remote.origin.promisor", true)?;
                config.set_str("remote.origin.partialCloneFilter", "blob:none")?;
                config.set_str("remote.origin.url", "https://example.test/repository.git")
            })
            .expect("configure partial repository");
        drop(repo);

        let cancellation = Arc::new(AtomicBool::new(false));
        let operation_calls = AtomicUsize::new(0);
        let error = run_review_with_missing_object_retry_and_hydrator(
            &GitState::new(),
            temp.path(),
            Some(cancellation.clone()),
            |_repo| {
                operation_calls.fetch_add(1, AtomicOrdering::SeqCst);
                Err::<(), _>(BackendError::GitObjectMissing {
                    message: "missing promised object".to_string(),
                    object_id: Some("0123456789abcdef0123456789abcdef01234567".to_string()),
                    operation: Some("test_review".to_string()),
                    repository_path: None,
                    partial_clone: false,
                    retry_attempted: false,
                    worktree_modified: Some(false),
                    git_output: None,
                })
            },
            |_repo_root, _object_id, hydration_cancellation| {
                hydration_cancellation
                    .expect("hydration cancellation flag")
                    .store(true, Ordering::Release);
                Err("Git review was cancelled.".to_string())
            },
        )
        .expect_err("cancelled hydration must stop the review");

        assert!(error.to_string().contains("cancelled"));
        assert_eq!(operation_calls.load(AtomicOrdering::SeqCst), 1);
    }

    #[test]
    fn pre_cancelled_review_does_not_run_a_successful_operation() {
        let temp = TempDir::new().expect("temporary repository");
        Repository::init(temp.path()).expect("initialize repository");
        let cancellation = Arc::new(AtomicBool::new(true));
        let operation_calls = AtomicUsize::new(0);

        let error = run_review_with_missing_object_retry(
            &GitState::new(),
            temp.path(),
            Some(cancellation),
            |_repo| {
                operation_calls.fetch_add(1, AtomicOrdering::SeqCst);
                Ok(())
            },
        )
        .expect_err("pre-cancelled review must not start");

        assert!(error.to_string().contains("cancelled"));
        assert_eq!(operation_calls.load(AtomicOrdering::SeqCst), 0);
    }

    #[test]
    fn cancellation_arriving_during_the_first_review_discards_its_success() {
        let temp = TempDir::new().expect("temporary repository");
        Repository::init(temp.path()).expect("initialize repository");
        let cancellation = Arc::new(AtomicBool::new(false));
        let operation_calls = AtomicUsize::new(0);

        let error = run_review_with_missing_object_retry(
            &GitState::new(),
            temp.path(),
            Some(cancellation.clone()),
            |_repo| {
                operation_calls.fetch_add(1, AtomicOrdering::SeqCst);
                cancellation.store(true, Ordering::Release);
                Ok(())
            },
        )
        .expect_err("a cancellation during the first read must win over success");

        assert!(error.to_string().contains("cancelled"));
        assert_eq!(operation_calls.load(AtomicOrdering::SeqCst), 1);
    }

    #[test]
    fn cancellation_arriving_during_the_retried_review_discards_its_success() {
        let temp = TempDir::new().expect("temporary repository");
        let repo = Repository::init(temp.path()).expect("initialize repository");
        repo.config()
            .and_then(|mut config| {
                config.set_bool("remote.origin.promisor", true)?;
                config.set_str("remote.origin.partialCloneFilter", "blob:none")?;
                config.set_str("remote.origin.url", "https://example.test/repository.git")
            })
            .expect("configure partial repository");
        drop(repo);
        let cancellation = Arc::new(AtomicBool::new(false));
        let operation_calls = AtomicUsize::new(0);

        let error = run_review_with_missing_object_retry_and_hydrator(
            &GitState::new(),
            temp.path(),
            Some(cancellation.clone()),
            |_repo| {
                let call = operation_calls.fetch_add(1, AtomicOrdering::SeqCst);
                if call == 0 {
                    Err(BackendError::GitObjectMissing {
                        message: "missing promised object".to_string(),
                        object_id: Some("0123456789abcdef0123456789abcdef01234567".to_string()),
                        operation: Some("test_review".to_string()),
                        repository_path: None,
                        partial_clone: false,
                        retry_attempted: false,
                        worktree_modified: Some(false),
                        git_output: None,
                    })
                } else {
                    cancellation.store(true, Ordering::Release);
                    Ok(())
                }
            },
            |_repo_root, _object_id, _cancellation| Ok("hydrated".to_string()),
        )
        .expect_err("a cancellation during the retry must win over success");

        assert!(error.to_string().contains("cancelled"));
        assert_eq!(operation_calls.load(AtomicOrdering::SeqCst), 2);
    }

    #[tokio::test]
    async fn cancellation_arriving_before_registration_is_preserved() {
        let request_id = format!("pre-register-cancel-{}", std::process::id());
        git_cancel_review(request_id.clone())
            .await
            .expect("pre-cancel review");

        let (cancellation, guard) = register_git_review_cancellation(Some(&request_id))
            .expect("register pre-cancelled review");

        assert!(cancellation
            .expect("cancellation flag")
            .load(Ordering::Acquire));
        drop(guard);
    }

    #[test]
    fn app_shutdown_cancels_every_registered_git_review() {
        let (first, first_guard) = register_git_review_cancellation(Some("review-shutdown-first"))
            .expect("register first review");
        let (second, second_guard) =
            register_git_review_cancellation(Some("review-shutdown-second"))
                .expect("register second review");

        cancel_all_git_reviews();

        assert!(first.expect("first cancellation").load(Ordering::Acquire));
        assert!(second.expect("second cancellation").load(Ordering::Acquire));
        drop(first_guard);
        drop(second_guard);
    }

    #[test]
    fn contained_git_command_disables_ssh_askpass_and_uses_batch_mode() {
        let mut command = background_contained_tokio_command("git");
        command.env("SSH_ASKPASS", "askpass-sentinel");
        command.env("GIT_ASKPASS", "git-askpass-sentinel");
        configure_noninteractive_git_command(&mut command);
        let environment = command
            .as_std()
            .get_envs()
            .filter_map(|(key, value)| {
                value.map(|value| {
                    (
                        key.to_string_lossy().to_string(),
                        value.to_string_lossy().to_string(),
                    )
                })
            })
            .collect::<HashMap<_, _>>();

        assert_eq!(
            environment.get("SSH_ASKPASS_REQUIRE").map(String::as_str),
            Some("never")
        );
        assert_eq!(
            environment.get("GIT_SSH_COMMAND").map(String::as_str),
            Some("ssh -oBatchMode=yes")
        );
        assert_eq!(
            environment.get("GIT_TERMINAL_PROMPT").map(String::as_str),
            Some("0")
        );
        assert_eq!(
            environment.get("GIT_ALLOW_PROTOCOL").map(String::as_str),
            Some("git:http:https:ssh")
        );
        assert_eq!(
            environment.get("GIT_CONFIG_KEY_0").map(String::as_str),
            Some("core.askPass")
        );
        assert_eq!(
            environment.get("GIT_CONFIG_VALUE_0").map(String::as_str),
            Some("")
        );
        assert_eq!(
            environment.get("GIT_CONFIG_COUNT").map(String::as_str),
            Some("3")
        );
        assert_eq!(
            environment.get("GIT_CONFIG_KEY_1").map(String::as_str),
            Some("maintenance.auto")
        );
        assert_eq!(
            environment.get("GIT_CONFIG_VALUE_1").map(String::as_str),
            Some("false")
        );
        assert_eq!(
            environment.get("GIT_CONFIG_KEY_2").map(String::as_str),
            Some("gc.recentObjectsHook")
        );
        assert_eq!(
            environment.get("GIT_CONFIG_VALUE_2").map(String::as_str),
            Some("")
        );
        for key in ["GIT_ASKPASS", "SSH_ASKPASS"] {
            assert!(command
                .as_std()
                .get_envs()
                .any(|(candidate, value)| candidate == key && value.is_none()));
        }
    }

    #[test]
    fn automatic_hydration_rejects_repository_defined_executable_settings() {
        for setting in [
            "credential.helper",
            "credential.https://example.test.helper",
            "core.sshCommand",
            "core.gitProxy",
            "core.alternateRefsCommand",
            "gc.recentObjectsHook",
            "remote.origin.uploadpack",
            "remote.origin.vcs",
            "url.https://mirror.example.test/.insteadOf",
        ] {
            let temp = TempDir::new().expect("temporary repository");
            let repo = Repository::init(temp.path()).expect("initialize repository");
            let sentinel = temp.path().join("unsafe-setting-ran");
            repo.config()
                .and_then(|mut config| {
                    config.set_str(setting, &format!("!echo unsafe > {}", sentinel.display()))
                })
                .unwrap_or_else(|error| panic!("configure unsafe setting {setting}: {error}"));

            let error = hydrate_review_objects_with_git(
                temp.path(),
                "0123456789abcdef0123456789abcdef01234567",
                None,
            )
            .expect_err("automatic hydration must reject repository-defined executables");

            assert!(error.contains(&setting.to_ascii_lowercase()), "{error}");
            assert!(!sentinel.exists(), "unsafe setting ran: {setting}");
        }
    }

    #[test]
    fn automatic_hydration_rejects_a_local_promisor_remote() {
        let temp = TempDir::new().expect("temporary repository");
        let repo_path = temp.path().join("partial");
        let outside_path = temp.path().join("outside.git");
        let repo = Repository::init(&repo_path).expect("initialize partial repository");
        Repository::init_bare(&outside_path).expect("initialize outside repository");
        let outside_url = format!(
            "file:///{}",
            outside_path.to_string_lossy().replace('\\', "/")
        );
        repo.config()
            .and_then(|mut config| {
                config.set_bool("remote.origin.promisor", true)?;
                config.set_str("remote.origin.partialCloneFilter", "blob:none")?;
                config.set_str("remote.origin.url", &outside_url)
            })
            .expect("configure local promisor");

        let error = hydrate_review_objects_with_git(
            &repo_path,
            "0123456789abcdef0123456789abcdef01234567",
            None,
        )
        .expect_err("automatic hydration must not read another local repository");

        assert!(error.contains("remote.origin.url"), "{error}");
    }

    #[test]
    fn git_diagnostics_redact_repository_paths_and_remote_urls() {
        let root = Path::new("C:/Users/example/private-project");
        let redactions = vec![
            "https://token@example.test/repo.git".to_string(),
            "example.test".to_string(),
            "git@forge.internal:private/team.git".to_string(),
            "forge.internal".to_string(),
        ];
        let sanitized = sanitize_git_diagnostic(
            "fatal: C:/Users/example/private-project https://token@example.test/repo.git failed",
            root,
            &redactions,
        );
        assert_eq!(sanitized, "fatal: [redacted] [redacted] failed");

        let scp_sanitized = sanitize_git_diagnostic(
            "fatal: git@forge.internal:private/team.git host forge.internal failed",
            root,
            &redactions,
        );
        assert_eq!(scp_sanitized, "fatal: [redacted] host [redacted] failed");

        let windows_variant = sanitize_git_diagnostic(
            "fatal: c:\\users\\EXAMPLE\\private-project\\.git failed",
            root,
            &redactions,
        );
        assert_eq!(windows_variant, "fatal: [redacted] failed");
    }

    #[test]
    fn contained_git_command_rejects_output_above_the_memory_limit() {
        let (temp, _repo) = init_repo();
        fs::write(temp.path().join("before.txt"), "before\n".repeat(50_000))
            .expect("write first large file");
        fs::write(temp.path().join("after.txt"), "after\n".repeat(50_000))
            .expect("write second large file");
        let args = vec![
            "diff".to_string(),
            "--no-index".to_string(),
            "before.txt".to_string(),
            "after.txt".to_string(),
        ];

        let drained = run_contained_git_command_with_timeout(
            temp.path(),
            &args,
            Duration::from_secs(5),
            false,
        )
        .expect("mutating command mode must drain and truncate diagnostics");
        assert!(drained.stdout.contains("[Git output truncated by Macro]"));

        let error = match run_contained_git_command_with_timeout(
            temp.path(),
            &args,
            Duration::from_secs(5),
            true,
        ) {
            Ok(_) => panic!("oversized Git output must not be retained"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("produced too much output"));
    }

    #[test]
    fn missing_object_refresh_retries_once_and_can_recover() {
        let temp = TempDir::new().expect("temp dir");
        Repository::init(temp.path()).expect("init repo");
        let git_state = GitState::new();
        let attempts = AtomicUsize::new(0);

        let result = run_review_with_missing_object_retry(&git_state, temp.path(), None, |_| {
            let attempt = attempts.fetch_add(1, AtomicOrdering::SeqCst);
            if attempt == 0 {
                return Err(BackendError::GitObjectMissing {
                    message: "missing".to_string(),
                    object_id: Some("0123456789abcdef0123456789abcdef01234567".to_string()),
                    operation: Some("test_review".to_string()),
                    repository_path: None,
                    partial_clone: false,
                    retry_attempted: false,
                    worktree_modified: Some(false),
                    git_output: None,
                });
            }
            Ok("recovered")
        })
        .expect("single retry should recover");

        assert_eq!(result, "recovered");
        assert_eq!(attempts.load(AtomicOrdering::SeqCst), 2);
    }

    #[test]
    fn missing_object_refresh_never_retries_more_than_once() {
        let temp = TempDir::new().expect("temp dir");
        Repository::init(temp.path()).expect("init repo");
        let git_state = GitState::new();
        let attempts = AtomicUsize::new(0);

        let error = run_review_with_missing_object_retry(&git_state, temp.path(), None, |_| {
            attempts.fetch_add(1, AtomicOrdering::SeqCst);
            Err::<(), _>(BackendError::GitObjectMissing {
                message: "missing".to_string(),
                object_id: Some("0123456789abcdef0123456789abcdef01234567".to_string()),
                operation: Some("test_review".to_string()),
                repository_path: None,
                partial_clone: false,
                retry_attempted: false,
                worktree_modified: Some(false),
                git_output: None,
            })
        })
        .expect_err("persistent missing object must remain an error");

        assert_eq!(attempts.load(AtomicOrdering::SeqCst), 2);
        assert!(matches!(
            error,
            BackendError::GitObjectMissing {
                retry_attempted: true,
                ..
            }
        ));
    }

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
        {
            let mut config = repo.config().expect("repo config");
            config
                .set_str("user.name", "Tester")
                .expect("set user name");
            config
                .set_str("user.email", "tester@example.com")
                .expect("set user email");
        }

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

    fn remove_loose_checkpoint_object(repo: &Repository, object_id: Oid) {
        let object_id = object_id.to_string();
        let object_path = repo
            .path()
            .join("objects")
            .join(&object_id[..2])
            .join(&object_id[2..]);
        assert!(object_path.is_file(), "test requires a loose object");
        fs::remove_file(object_path).expect("remove temporary checkpoint object");
    }

    fn expect_checkpoint_open_error(result: Result<Repository>, message: &str) -> BackendError {
        match result {
            Ok(_) => panic!("{message}"),
            Err(error) => error,
        }
    }

    fn assert_direct_checkpoint_corrupt(error: BackendError, accepted_history_at_risk: bool) {
        assert!(matches!(
            error,
            BackendError::DirectCheckpointCorrupt {
                accepted_history_at_risk: actual_risk,
                ..
            } if actual_risk == accepted_history_at_risk
        ));
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
    fn direct_checkpoint_rejects_a_nested_git_repository_before_initialization() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        let nested = project_path.join("nested");
        fs::create_dir_all(&nested).expect("create nested project");
        let nested_repo = Repository::init(&nested).expect("create nested Git repository");
        fs::write(nested.join("README.md"), "nested content\n").expect("write nested file");
        let mut nested_index = nested_repo.index().expect("nested index");
        nested_index
            .add_path(Path::new("README.md"))
            .expect("stage nested file");
        let nested_tree_id = nested_index.write_tree().expect("nested tree");
        let nested_tree = nested_repo
            .find_tree(nested_tree_id)
            .expect("find nested tree");
        let signature = git2::Signature::now("Tester", "tester@example.com").expect("signature");
        nested_repo
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "nested baseline",
                &nested_tree,
                &[],
            )
            .expect("commit nested baseline");
        drop(nested_tree);
        drop(nested_index);
        drop(nested_repo);

        let error = ensure_direct_checkpoint_head(&repo)
            .expect_err("a nested Git repository cannot become an accepted checkpoint gitlink");

        assert!(
            matches!(
                &error,
                BackendError::DirectCheckpointCorrupt {
                    operation: Some(operation),
                    accepted_history_at_risk: false,
                    ..
            } if operation == "direct_checkpoint_init_capture"
                || operation == "direct_checkpoint_init_gitlink"
            ),
            "unexpected error: {error:?}"
        );
        assert!(repo.head().is_err());
        assert!(!project_path.join(".git").exists());
        assert!(nested.join(".git").exists());
        assert_eq!(
            fs::read_to_string(nested.join("README.md")).expect("nested file"),
            "nested content\n"
        );
    }

    #[test]
    fn direct_checkpoint_rejects_an_accepted_tree_containing_a_gitlink() {
        let (_temp, _project_path, repo) = init_direct_checkpoint();
        let gitlink_id =
            Oid::from_str("0123456789abcdef0123456789abcdef01234567").expect("gitlink id");
        let mut builder = repo.treebuilder(None).expect("tree builder");
        builder
            .insert("nested", gitlink_id, 0o160000)
            .expect("insert gitlink");
        let tree_id = builder.write().expect("write gitlink tree");
        let tree = repo.find_tree(tree_id).expect("find gitlink tree");
        let signature = git2::Signature::now("Macro", "macro@local").expect("signature");
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "crafted gitlink",
            &tree,
            &[],
        )
        .expect("commit crafted tree");

        let error = verify_direct_checkpoint_history(&repo)
            .expect_err("accepted gitlinks must not pass integrity validation");

        assert!(matches!(
            error,
            BackendError::DirectCheckpointCorrupt {
                operation: Some(ref operation),
                accepted_history_at_risk: true,
                ..
            } if operation == "direct_checkpoint_head_gitlink"
        ));
    }

    #[test]
    fn direct_checkpoint_missing_is_reported_without_initializing_the_project() {
        let temp = TempDir::new().expect("temp dir");
        let app_data = temp.path().join("app-data");
        let project = temp.path().join("project");
        fs::create_dir_all(&app_data).expect("app data");
        fs::create_dir_all(&project).expect("project");
        fs::write(project.join("README.md"), "unchanged\n").expect("project file");

        let error = expect_checkpoint_open_error(
            open_direct_checkpoint_at(&app_data, "task-1", &project, None, false),
            "review must not initialize an absent checkpoint",
        );
        assert!(matches!(
            error,
            BackendError::DirectCheckpointMissing { .. }
        ));
        assert!(!app_data.join(DIRECT_CHECKPOINTS_DIR).exists());
        assert!(!project.join(".git").exists());
        assert_eq!(
            fs::read(project.join("README.md")).expect("project file"),
            b"unchanged\n"
        );
    }

    #[test]
    fn direct_checkpoint_reopens_after_restart_and_reports_later_removal() {
        let temp = TempDir::new().expect("temp dir");
        let app_data = temp.path().join("app-data");
        let project = temp.path().join("project");
        fs::create_dir_all(&app_data).expect("app data");
        fs::create_dir_all(&project).expect("project");
        fs::write(project.join("README.md"), "baseline\n").expect("project file");
        let checkpoint_id = direct_checkpoint_key("task-1", &project.canonicalize().expect("path"));
        let repo =
            open_direct_checkpoint_at(&app_data, "task-1", &project, Some(&checkpoint_id), true)
                .expect("create checkpoint");
        let accepted_head = ensure_direct_checkpoint_head(&repo).expect("baseline");
        drop(repo);

        let reopened =
            open_direct_checkpoint_at(&app_data, "task-1", &project, Some(&checkpoint_id), false)
                .expect("reopen checkpoint");
        assert_eq!(
            ensure_direct_checkpoint_head(&reopened).expect("verify"),
            accepted_head
        );
        drop(reopened);
        assert!(
            remove_direct_checkpoint(&app_data, "task-1", &checkpoint_id, &project)
                .expect("remove checkpoint")
        );
        let error = expect_checkpoint_open_error(
            open_direct_checkpoint_at(&app_data, "task-1", &project, Some(&checkpoint_id), false),
            "removed checkpoint must stay absent",
        );
        assert!(matches!(
            error,
            BackendError::DirectCheckpointMissing { .. }
        ));
        assert_eq!(
            fs::read(project.join("README.md")).expect("project file"),
            b"baseline\n"
        );
        assert!(!project.join(".git").exists());
    }

    #[test]
    fn persisted_direct_checkpoint_removal_never_creates_a_new_baseline() {
        let temp = TempDir::new().expect("temp dir");
        let app_data = temp.path().join("app-data");
        let project = temp.path().join("project");
        fs::create_dir_all(&app_data).expect("app data");
        fs::create_dir_all(&project).expect("project");
        fs::write(project.join("README.md"), "accepted\n").expect("write accepted state");
        let checkpoint_id = direct_checkpoint_key("task-1", &project);
        let repo =
            open_direct_checkpoint_at(&app_data, "task-1", &project, Some(&checkpoint_id), true)
                .expect("create checkpoint");
        let accepted_head = ensure_direct_checkpoint_head(&repo).expect("accepted baseline");
        let checkpoint_path = repo.path().to_path_buf();
        drop(repo);
        fs::remove_dir_all(&checkpoint_path).expect("simulate removed internal checkpoint");
        fs::write(project.join("README.md"), "unaccepted after removal\n")
            .expect("write unaccepted state");

        let error = expect_checkpoint_open_error(
            open_direct_checkpoint_at(&app_data, "task-1", &project, Some(&checkpoint_id), true),
            "persisted checkpoint removal must not recreate current files as accepted",
        );

        assert!(matches!(
            error,
            BackendError::DirectCheckpointMissing { .. }
        ));
        assert!(!checkpoint_path.exists());
        assert_eq!(
            fs::read(project.join("README.md")).expect("read project"),
            b"unaccepted after removal\n"
        );
        assert!(!project.join(".git").exists());
        assert!(!accepted_head.is_empty());
    }

    #[test]
    fn official_direct_checkpoint_removal_blocks_a_stale_recreation() {
        let temp = TempDir::new().expect("temp dir");
        let app_data = temp.path().join("app-data");
        let project = temp.path().join("project");
        fs::create_dir_all(&app_data).expect("app data");
        fs::create_dir_all(&project).expect("project");
        fs::write(project.join("README.md"), "accepted\n").expect("write accepted state");
        let checkpoint_id = direct_checkpoint_key("task-1", &project);
        let repo =
            open_direct_checkpoint_at(&app_data, "task-1", &project, Some(&checkpoint_id), true)
                .expect("create checkpoint");
        ensure_direct_checkpoint_head(&repo).expect("accepted baseline");
        drop(repo);

        assert!(
            remove_direct_checkpoint(&app_data, "task-1", &checkpoint_id, &project)
                .expect("remove checkpoint")
        );
        fs::write(project.join("README.md"), "unaccepted after removal\n")
            .expect("write unaccepted state");
        let error = expect_checkpoint_open_error(
            open_direct_checkpoint_at(&app_data, "task-1", &project, Some(&checkpoint_id), true),
            "stale activation must not recreate an explicitly removed checkpoint",
        );

        assert!(matches!(
            error,
            BackendError::DirectCheckpointMissing { .. }
        ));
        assert_eq!(
            fs::read(project.join("README.md")).expect("read project"),
            b"unaccepted after removal\n"
        );
        assert!(!project.join(".git").exists());
    }

    #[test]
    fn direct_checkpoint_never_rebinds_to_an_existing_other_project() {
        let temp = TempDir::new().expect("temp dir");
        let app_data = temp.path().join("app-data");
        let first_project = temp.path().join("first");
        let second_project = temp.path().join("second");
        fs::create_dir_all(&app_data).expect("app data");
        fs::create_dir_all(&first_project).expect("first project");
        fs::create_dir_all(&second_project).expect("second project");
        let checkpoint_id =
            direct_checkpoint_key("task-1", &first_project.canonicalize().expect("first path"));
        let repo = open_direct_checkpoint_at(
            &app_data,
            "task-1",
            &first_project,
            Some(&checkpoint_id),
            true,
        )
        .expect("create checkpoint");
        drop(repo);

        let error = expect_checkpoint_open_error(
            open_direct_checkpoint_at(
                &app_data,
                "task-1",
                &second_project,
                Some(&checkpoint_id),
                true,
            ),
            "checkpoint must remain bound to the first existing project",
        );
        assert!(matches!(
            error,
            BackendError::DirectCheckpointProjectMismatch { .. }
        ));
        assert!(!first_project.join(".git").exists());
        assert!(!second_project.join(".git").exists());
    }

    #[test]
    fn direct_checkpoint_blocks_an_unverified_project_move_without_changing_head() {
        let temp = TempDir::new().expect("temp dir");
        let app_data = temp.path().join("app-data");
        let old_project = temp.path().join("old-project");
        let moved_project = temp.path().join("moved-project");
        fs::create_dir_all(&app_data).expect("app data");
        fs::create_dir_all(&old_project).expect("old project");
        fs::write(old_project.join("README.md"), "baseline\n").expect("project file");
        let checkpoint_id =
            direct_checkpoint_key("task-1", &old_project.canonicalize().expect("old path"));
        let repo = open_direct_checkpoint_at(
            &app_data,
            "task-1",
            &old_project,
            Some(&checkpoint_id),
            true,
        )
        .expect("create checkpoint");
        let head_before = ensure_direct_checkpoint_head(&repo).expect("baseline");
        drop(repo);
        fs::rename(&old_project, &moved_project).expect("move project");

        let error = expect_checkpoint_open_error(
            open_direct_checkpoint_at(
                &app_data,
                "task-1",
                &moved_project,
                Some(&checkpoint_id),
                true,
            ),
            "project moves require an explicit identity-preserving migration",
        );
        assert!(matches!(
            error,
            BackendError::DirectCheckpointProjectMismatch { .. }
        ));
        let bare =
            Repository::open_bare(app_data.join(DIRECT_CHECKPOINTS_DIR).join(&checkpoint_id))
                .expect("open preserved checkpoint");
        assert_eq!(
            bare.head().expect("head").target().map(|id| id.to_string()),
            Some(head_before)
        );
        assert!(!moved_project.join(".git").exists());
    }

    #[test]
    fn legacy_checkpoint_resolution_reuses_the_existing_identity() {
        let temp = TempDir::new().expect("temp dir");
        let app_data = temp.path().join("app-data");
        let project = temp.path().join("project");
        fs::create_dir_all(&app_data).expect("app data");
        fs::create_dir_all(&project).expect("project");
        fs::write(project.join("README.md"), "accepted\n").expect("project file");
        let checkpoint_id = direct_checkpoint_key("task-1", &project);
        let repo =
            open_direct_checkpoint_at(&app_data, "task-1", &project, Some(&checkpoint_id), true)
                .expect("create checkpoint");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        drop(repo);

        assert_eq!(
            resolve_direct_checkpoint_id_at(&app_data, "task-1", &project)
                .expect("resolve existing checkpoint"),
            checkpoint_id
        );
        assert!(!project.join(".git").exists());
    }

    #[test]
    fn legacy_checkpoint_resolution_blocks_a_moved_project_without_rebasing() {
        let temp = TempDir::new().expect("temp dir");
        let app_data = temp.path().join("app-data");
        let original_project = temp.path().join("project-before");
        let moved_project = temp.path().join("project-after");
        fs::create_dir_all(&app_data).expect("app data");
        fs::create_dir_all(&original_project).expect("project");
        fs::write(original_project.join("README.md"), "accepted\n").expect("project file");
        let checkpoint_id = direct_checkpoint_key("task-1", &original_project);
        let repo = open_direct_checkpoint_at(
            &app_data,
            "task-1",
            &original_project,
            Some(&checkpoint_id),
            true,
        )
        .expect("create checkpoint");
        let accepted_head = ensure_direct_checkpoint_head(&repo).expect("baseline");
        let checkpoint_path = repo.path().to_path_buf();
        drop(repo);
        fs::rename(&original_project, &moved_project).expect("move project");
        fs::write(moved_project.join("README.md"), "unaccepted after move\n")
            .expect("pending project change");

        let error = resolve_direct_checkpoint_id_at(&app_data, "task-1", &moved_project)
            .expect_err("a moved legacy checkpoint must not derive a new baseline");

        assert!(matches!(
            error,
            BackendError::DirectCheckpointProjectMismatch { .. }
        ));
        let preserved = Repository::open_bare(&checkpoint_path).expect("preserved checkpoint");
        assert_eq!(
            preserved
                .head()
                .expect("head")
                .target()
                .map(|id| id.to_string()),
            Some(accepted_head)
        );
        let derived_after_move = direct_checkpoint_key("task-1", &moved_project);
        assert!(!app_data
            .join(DIRECT_CHECKPOINTS_DIR)
            .join(derived_after_move)
            .exists());
        assert_eq!(
            fs::read_to_string(moved_project.join("README.md")).expect("project file"),
            "unaccepted after move\n"
        );
        assert!(!moved_project.join(".git").exists());
    }

    #[test]
    fn legacy_checkpoint_resolution_preserves_an_ambiguous_second_project() {
        let temp = TempDir::new().expect("temp dir");
        let app_data = temp.path().join("app-data");
        let project_a = temp.path().join("project-a");
        let project_b = temp.path().join("project-b");
        fs::create_dir_all(&app_data).expect("app data");
        fs::create_dir_all(&project_a).expect("project a");
        fs::create_dir_all(&project_b).expect("project b");
        fs::write(project_a.join("README.md"), "accepted a\n").expect("project a file");
        fs::write(project_b.join("README.md"), "unaccepted b\n").expect("project b file");
        let checkpoint_a = direct_checkpoint_key("task-1", &project_a);
        let repo_a =
            open_direct_checkpoint_at(&app_data, "task-1", &project_a, Some(&checkpoint_a), true)
                .expect("create checkpoint a");
        let accepted_a = ensure_direct_checkpoint_head(&repo_a).expect("baseline a");
        let checkpoint_a_path = repo_a.path().to_path_buf();
        drop(repo_a);

        let error = resolve_direct_checkpoint_id_at(&app_data, "task-1", &project_b)
            .expect_err("legacy identity cannot distinguish a move from a second project safely");

        assert!(matches!(
            error,
            BackendError::DirectCheckpointProjectMismatch { .. }
        ));
        assert_eq!(
            Repository::open_bare(&checkpoint_a_path)
                .expect("checkpoint a preserved")
                .head()
                .expect("head a")
                .target()
                .map(|id| id.to_string()),
            Some(accepted_a)
        );
        assert!(!app_data
            .join(DIRECT_CHECKPOINTS_DIR)
            .join(direct_checkpoint_key("task-1", &project_b))
            .exists());
        assert_eq!(
            fs::read_to_string(project_b.join("README.md")).expect("project b file"),
            "unaccepted b\n"
        );
        assert!(!project_b.join(".git").exists());
    }

    #[cfg(windows)]
    #[test]
    fn direct_checkpoint_treats_windows_path_case_as_the_same_project() {
        let temp = TempDir::new().expect("temp dir");
        let app_data = temp.path().join("app-data");
        let project = temp.path().join("mixedCaseProject");
        fs::create_dir_all(&app_data).expect("app data");
        fs::create_dir_all(&project).expect("project");
        let canonical = project.canonicalize().expect("canonical project");
        let checkpoint_id = direct_checkpoint_key("task-1", &canonical);
        let repo =
            open_direct_checkpoint_at(&app_data, "task-1", &project, Some(&checkpoint_id), true)
                .expect("create checkpoint");
        drop(repo);
        let alternate_case = PathBuf::from(project.to_string_lossy().to_uppercase());

        open_direct_checkpoint_at(
            &app_data,
            "task-1",
            &alternate_case,
            Some(&checkpoint_id),
            false,
        )
        .expect("same Windows path with different case");
    }

    #[test]
    fn direct_checkpoint_rejects_a_head_with_a_missing_commit_without_rebasing() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        fs::write(project_path.join("README.md"), "accepted\n").expect("write project file");
        let head_id = Oid::from_str(&ensure_direct_checkpoint_head(&repo).expect("baseline"))
            .expect("head oid");
        let index_before = fs::read(repo.path().join("index")).expect("read index");
        let checkpoint_path = repo.path().to_path_buf();
        let worktree_before = fs::read(project_path.join("README.md")).expect("read project file");
        remove_loose_checkpoint_object(&repo, head_id);
        drop(repo);
        let repo = Repository::open(checkpoint_path).expect("reopen checkpoint");

        let error = ensure_direct_checkpoint_head(&repo).expect_err("missing commit must block");
        assert_direct_checkpoint_corrupt(error, true);
        assert_eq!(repo.head().expect("head reference").target(), Some(head_id));
        assert_eq!(
            fs::read(repo.path().join("index")).expect("read index"),
            index_before
        );
        assert_eq!(
            fs::read(project_path.join("README.md")).expect("read project file"),
            worktree_before
        );
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_checkpoint_rejects_a_missing_head_tree_without_rebasing() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        fs::write(project_path.join("README.md"), "accepted\n").expect("write project file");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        let head = repo.head().expect("head").peel_to_commit().expect("commit");
        let tree_id = head.tree_id();
        let head_id = head.id();
        let checkpoint_path = repo.path().to_path_buf();
        drop(head);
        remove_loose_checkpoint_object(&repo, tree_id);
        drop(repo);
        let repo = Repository::open(checkpoint_path).expect("reopen checkpoint");

        let error = ensure_direct_checkpoint_head(&repo).expect_err("missing tree must block");
        assert_direct_checkpoint_corrupt(error, true);
        assert_eq!(repo.head().expect("head reference").target(), Some(head_id));
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_checkpoint_rejects_a_missing_head_blob_without_rebasing() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        fs::write(project_path.join("README.md"), "accepted\n").expect("write project file");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        let head = repo.head().expect("head").peel_to_commit().expect("commit");
        let blob_id = head
            .tree()
            .expect("tree")
            .get_path(Path::new("README.md"))
            .expect("tree entry")
            .id();
        drop(head);
        remove_loose_checkpoint_object(&repo, blob_id);

        let error = ensure_direct_checkpoint_head(&repo).expect_err("missing blob must block");
        assert_direct_checkpoint_corrupt(error, true);
        assert_eq!(
            fs::read(project_path.join("README.md")).expect("read project file"),
            b"accepted\n"
        );
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_checkpoint_rejects_a_missing_index_without_changing_accepted_history() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        fs::write(project_path.join("README.md"), "accepted\n").expect("write baseline");
        let accepted_head = ensure_direct_checkpoint_head(&repo).expect("baseline");
        let worktree_before = fs::read(project_path.join("README.md")).expect("read project file");
        fs::remove_file(repo.path().join("index")).expect("remove internal index");

        let error = ensure_direct_checkpoint_head(&repo).expect_err("missing index must block");

        assert!(matches!(
            error,
            BackendError::DirectCheckpointCorrupt {
                operation: Some(ref operation),
                accepted_history_at_risk: false,
                ..
            } if operation == "direct_checkpoint_index"
        ));
        assert_eq!(
            repo.head().expect("head").target().map(|id| id.to_string()),
            Some(accepted_head)
        );
        verify_direct_checkpoint_history(&repo).expect("accepted history remains readable");
        assert_eq!(
            fs::read(project_path.join("README.md")).expect("read project file"),
            worktree_before
        );
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_restore_rejects_an_unmerged_checkpoint_index_without_touching_the_project() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        fs::write(project_path.join("conflict.txt"), "accepted\n").expect("write accepted file");
        ensure_direct_checkpoint_head(&repo).expect("capture baseline");
        let mut index = repo.index().expect("checkpoint index");
        index.read(true).expect("refresh index");
        let mut conflict_entry = index
            .get_path(Path::new("conflict.txt"), 0)
            .expect("accepted index entry");
        index
            .remove_path(Path::new("conflict.txt"))
            .expect("remove stage zero");
        conflict_entry.flags = (conflict_entry.flags & !0x3000) | 0x2000;
        index.add(&conflict_entry).expect("add conflict stage");
        index.write().expect("persist conflict index");
        fs::write(project_path.join("conflict.txt"), "pending\n").expect("write pending file");

        let error =
            restore_direct_worktree_paths(&repo, &project_path, vec!["conflict.txt".to_string()])
                .expect_err("an unmerged checkpoint index must block restore");

        assert!(matches!(
            error,
            BackendError::DirectCheckpointCorrupt {
                operation: Some(ref operation),
                ..
            } if operation == "direct_checkpoint_index_conflict"
        ));
        assert_eq!(
            fs::read_to_string(project_path.join("conflict.txt")).expect("read pending file"),
            "pending\n"
        );
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_restore_checks_integrity_before_removing_an_untracked_file() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        fs::write(project_path.join("README.md"), "accepted\n").expect("write baseline");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        let head = repo.head().expect("head").peel_to_commit().expect("commit");
        let blob_id = head
            .tree()
            .expect("tree")
            .get_path(Path::new("README.md"))
            .expect("tree entry")
            .id();
        drop(head);
        remove_loose_checkpoint_object(&repo, blob_id);
        fs::write(project_path.join("untracked.txt"), "keep me\n").expect("write untracked");

        let error =
            restore_direct_worktree_paths(&repo, &project_path, vec!["untracked.txt".to_string()])
                .expect_err("corrupt accepted history must block restore before mutation");

        assert_direct_checkpoint_corrupt(error, true);
        assert_eq!(
            fs::read(project_path.join("untracked.txt")).expect("read preserved file"),
            b"keep me\n"
        );
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_review_reopens_once_then_reports_a_missing_index_blob() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        fs::write(project_path.join("README.md"), "accepted\n").expect("write baseline");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        fs::write(project_path.join("README.md"), "accepted change\n").expect("write accepted");
        stage_direct_paths(&repo, &["README.md".to_string()]).expect("stage accepted change");
        let accepted_head = accept_direct_changes(&repo).expect("accept change");
        fs::write(project_path.join("README.md"), "validated pending\n").expect("write change");
        stage_direct_paths(&repo, &["README.md".to_string()]).expect("stage direct change");
        let mut index = repo.index().expect("index");
        index.read(true).expect("refresh index");
        let missing_id = index
            .get_path(Path::new("README.md"), 0)
            .expect("index entry")
            .id;
        let checkpoint_path = repo.path().to_path_buf();
        let head_id = repo.head().expect("head").target();
        drop(index);
        drop(repo);
        let repo = Repository::open(&checkpoint_path).expect("reopen checkpoint");
        remove_loose_checkpoint_object(&repo, missing_id);
        drop(repo);
        let worktree_before = fs::read(project_path.join("README.md")).expect("read project file");

        let error = match run_direct_checkpoint_review(
            || Ok((Repository::open(&checkpoint_path)?, project_path.clone())),
            None,
            |repo, project| review::build_git_review_snapshot(repo, project),
        ) {
            Ok(_) => panic!("persistent missing index blob must block direct review"),
            Err(error) => error,
        };
        assert!(matches!(
            error,
            BackendError::DirectCheckpointCorrupt {
                object_id: Some(ref object_id),
                retry_attempted: true,
                accepted_history_at_risk: false,
                ..
            } if object_id == &missing_id.to_string()
        ));
        let reopened = Repository::open(&checkpoint_path).expect("reopen after failure");
        assert_eq!(reopened.head().expect("head").target(), head_id);
        let accepted = reopened
            .find_commit(Oid::from_str(&accepted_head).expect("accepted oid"))
            .expect("accepted commit remains readable");
        assert_eq!(accepted.parent_count(), 1);
        verify_direct_checkpoint_history(&reopened).expect("accepted history remains readable");
        assert_eq!(
            fs::read(project_path.join("README.md")).expect("read project file"),
            worktree_before
        );
        assert!(!project_path.join(".git").exists());
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
    fn direct_checkpoint_rejects_malformed_and_foreign_identifiers_without_creation() {
        let temp = TempDir::new().expect("temp dir");
        let app_data = temp.path().join("app-data");
        let project = temp.path().join("project");
        fs::create_dir_all(&app_data).expect("app data");
        fs::create_dir_all(&project).expect("project");
        for checkpoint_id in ["malformed", "other-task-0123456789abcdef"] {
            let error = expect_checkpoint_open_error(
                open_direct_checkpoint_at(&app_data, "task-1", &project, Some(checkpoint_id), true),
                "invalid checkpoint id must fail",
            );
            assert!(matches!(
                error,
                BackendError::DirectCheckpointMissing { .. }
            ));
        }
        assert!(!app_data.join(DIRECT_CHECKPOINTS_DIR).exists());
        assert!(!project.join(".git").exists());
    }

    #[test]
    fn direct_checkpoint_without_worktree_config_returns_a_structured_corruption() {
        let temp = TempDir::new().expect("temp dir");
        let app_data = temp.path().join("app-data");
        let project = temp.path().join("project");
        fs::create_dir_all(&app_data).expect("app data");
        fs::create_dir_all(&project).expect("project");
        let checkpoint_id = direct_checkpoint_key("task-1", &project);
        let checkpoint_path = app_data.join(DIRECT_CHECKPOINTS_DIR).join(&checkpoint_id);
        fs::create_dir_all(checkpoint_path.parent().expect("checkpoint root"))
            .expect("checkpoint root");
        let repo = Repository::init_bare(&checkpoint_path).expect("bare checkpoint");
        repo.config()
            .and_then(|mut config| config.set_bool("core.bare", false))
            .expect("simulate missing worktree config");
        drop(repo);

        let error = expect_checkpoint_open_error(
            open_direct_checkpoint_at(&app_data, "task-1", &project, Some(&checkpoint_id), false),
            "missing worktree config must be structured",
        );

        assert!(
            matches!(error, BackendError::DirectCheckpointCorrupt { .. }),
            "unexpected error: {error:?}"
        );
        assert!(!project.join(".git").exists());
    }

    #[test]
    fn direct_checkpoint_operations_are_serialized_per_project() {
        let temp = TempDir::new().expect("temporary project");
        let project_key = direct_project_operation_lock_key(temp.path());
        let first_lock = direct_checkpoint_operation_lock(&project_key).expect("first lock");
        let first_guard = first_lock.lock().expect("first guard");
        let second_lock = direct_checkpoint_operation_lock(&project_key).expect("second lock");
        assert!(Arc::ptr_eq(&first_lock, &second_lock));
        let (sender, receiver) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _guard = second_lock.lock().expect("second guard");
            sender.send(()).expect("signal acquisition");
        });

        assert!(receiver.recv_timeout(Duration::from_millis(50)).is_err());
        drop(first_guard);
        receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("second operation proceeds after release");
        worker.join().expect("worker");
    }

    #[test]
    fn two_tasks_initialize_checkpoints_for_one_project_without_overlapping() {
        let temp = TempDir::new().expect("temporary roots");
        let app_data = temp.path().join("app-data");
        let project = temp.path().join("project");
        fs::create_dir_all(&app_data).expect("create app data");
        fs::create_dir_all(&project).expect("create project");
        fs::write(project.join("user.txt"), "user content\n").expect("write user file");
        let start = Arc::new(std::sync::Barrier::new(3));
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let workers = ["task-a", "task-b"]
            .into_iter()
            .map(|task_id| {
                let app_data = app_data.clone();
                let project = project.clone();
                let start = Arc::clone(&start);
                let active = Arc::clone(&active);
                let peak = Arc::clone(&peak);
                std::thread::spawn(move || {
                    start.wait();
                    with_direct_project_operation_lock(&project, || {
                        let current = active.fetch_add(1, AtomicOrdering::SeqCst) + 1;
                        peak.fetch_max(current, AtomicOrdering::SeqCst);
                        let checkpoint_id = direct_checkpoint_key(task_id, &project);
                        let repo = open_direct_checkpoint_at(
                            &app_data,
                            task_id,
                            &project,
                            Some(&checkpoint_id),
                            true,
                        )?;
                        let head = ensure_direct_checkpoint_head(&repo)?;
                        std::thread::sleep(Duration::from_millis(25));
                        active.fetch_sub(1, AtomicOrdering::SeqCst);
                        Ok((checkpoint_id, head))
                    })
                })
            })
            .collect::<Vec<_>>();
        start.wait();

        let checkpoints = workers
            .into_iter()
            .map(|worker| {
                worker
                    .join()
                    .expect("checkpoint worker")
                    .expect("checkpoint init")
            })
            .collect::<Vec<_>>();

        assert_eq!(peak.load(AtomicOrdering::SeqCst), 1);
        assert_ne!(checkpoints[0].0, checkpoints[1].0);
        for (checkpoint_id, head) in checkpoints {
            let repo = Repository::open(app_data.join(DIRECT_CHECKPOINTS_DIR).join(checkpoint_id))
                .expect("reopen checkpoint");
            assert_eq!(
                repo.head().expect("head").target().map(|id| id.to_string()),
                Some(head)
            );
        }
        assert_eq!(
            fs::read_to_string(project.join("user.txt")).expect("read user file"),
            "user content\n"
        );
        assert!(!project.join(".git").exists());
    }

    #[test]
    fn direct_checkpoint_removal_waits_for_the_project_operation_lock() {
        let temp = TempDir::new().expect("temporary roots");
        let app_data = temp.path().join("app-data");
        let project = temp.path().join("project");
        fs::create_dir_all(&app_data).expect("create app data");
        fs::create_dir_all(&project).expect("create project");
        fs::write(project.join("user.txt"), "unchanged\n").expect("write user file");
        let checkpoint_id = direct_checkpoint_key("task-1", &project);
        let repo =
            open_direct_checkpoint_at(&app_data, "task-1", &project, Some(&checkpoint_id), true)
                .expect("create checkpoint");
        ensure_direct_checkpoint_head(&repo).expect("create baseline");
        let checkpoint_path = repo.path().to_path_buf();
        drop(repo);

        let (locked_tx, locked_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let locked_project = project.clone();
        let holder = std::thread::spawn(move || {
            with_direct_project_operation_lock(&locked_project, || {
                locked_tx.send(()).expect("signal locked project");
                release_rx.recv().expect("release project lock");
                Ok(())
            })
        });
        locked_rx.recv().expect("wait for project lock");

        let removal_app_data = app_data.clone();
        let removal_project = project.clone();
        let removal_checkpoint_id = checkpoint_id.clone();
        let (removed_tx, removed_rx) = std::sync::mpsc::channel();
        let remover = std::thread::spawn(move || {
            let removed = remove_locked_direct_checkpoint_at(
                &removal_app_data,
                "task-1",
                &removal_checkpoint_id,
                &removal_project,
            );
            removed_tx.send(()).expect("signal removal completion");
            removed
        });

        assert!(removed_rx.recv_timeout(Duration::from_millis(50)).is_err());
        assert!(checkpoint_path.exists());
        release_tx.send(()).expect("release project lock");
        holder.join().expect("lock holder").expect("held operation");
        assert!(remover
            .join()
            .expect("removal worker")
            .expect("remove checkpoint"));
        assert!(removed_rx.recv_timeout(Duration::from_secs(1)).is_ok());
        assert!(!checkpoint_path.exists());
        assert_eq!(
            fs::read_to_string(project.join("user.txt")).expect("read user file"),
            "unchanged\n"
        );
        assert!(!project.join(".git").exists());
    }

    #[test]
    fn checkpoint_id_resolution_waits_for_initialization_publication() {
        let temp = TempDir::new().expect("temporary roots");
        let app_data = temp.path().join("app-data");
        let project = temp.path().join("project");
        fs::create_dir_all(&app_data).expect("create app data");
        fs::create_dir_all(&project).expect("create project");
        fs::write(project.join("user.txt"), "unchanged\n").expect("write user file");
        let checkpoint_id = direct_checkpoint_key("task-1", &project);
        let (partial_tx, partial_rx) = std::sync::mpsc::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let initialization_app_data = app_data.clone();
        let initialization_project = project.clone();
        let initialization_checkpoint_id = checkpoint_id.clone();
        let initializer = std::thread::spawn(move || {
            with_direct_checkpoint_storage_lock(|| {
                let checkpoint_root = initialization_app_data.join(DIRECT_CHECKPOINTS_DIR);
                fs::create_dir_all(&checkpoint_root).expect("create checkpoint root");
                let checkpoint_path = checkpoint_root.join(&initialization_checkpoint_id);
                let repo = Repository::init_bare(&checkpoint_path).expect("publish partial repo");
                partial_tx.send(()).expect("signal partial publication");
                finish_rx.recv().expect("finish initialization");
                let mut config = repo.config().expect("checkpoint config");
                config
                    .set_bool("core.bare", false)
                    .expect("configure worktree mode");
                config
                    .set_str("core.worktree", &initialization_project.to_string_lossy())
                    .expect("configure project path");
                config
                    .set_str("macro.taskId", "task-1")
                    .expect("configure task owner");
                Ok(())
            })
        });
        partial_rx.recv().expect("wait for partial publication");

        let resolution_app_data = app_data.clone();
        let resolution_project = project.clone();
        let (resolved_tx, resolved_rx) = std::sync::mpsc::channel();
        let resolver = std::thread::spawn(move || {
            let result = resolve_direct_checkpoint_id_at(
                &resolution_app_data,
                "task-1",
                &resolution_project,
            );
            resolved_tx.send(()).expect("signal resolution");
            result
        });

        assert!(resolved_rx.recv_timeout(Duration::from_millis(50)).is_err());
        finish_tx
            .send(())
            .expect("finish checkpoint initialization");
        initializer
            .join()
            .expect("initializer")
            .expect("initialize checkpoint");
        assert_eq!(
            resolver.join().expect("resolver").expect("resolve id"),
            checkpoint_id
        );
        assert!(resolved_rx.recv_timeout(Duration::from_secs(1)).is_ok());
        assert_eq!(
            fs::read_to_string(project.join("user.txt")).expect("read user file"),
            "unchanged\n"
        );
        assert!(!project.join(".git").exists());
    }

    #[test]
    fn failed_new_checkpoint_configuration_is_removed_and_can_be_retried() {
        let temp = TempDir::new().expect("temporary roots");
        let app_data = temp.path().join("app-data");
        let project = temp.path().join("project");
        let checkpoint_root = app_data.join(DIRECT_CHECKPOINTS_DIR);
        fs::create_dir_all(&checkpoint_root).expect("create checkpoint root");
        fs::create_dir_all(&project).expect("create project");
        fs::write(project.join("user.txt"), "unchanged\n").expect("write user file");
        let checkpoint_id = direct_checkpoint_key("task-1", &project);
        let checkpoint_path = checkpoint_root.join(&checkpoint_id);
        fs::create_dir(&checkpoint_path).expect("create new checkpoint directory");

        let error = initialize_created_direct_checkpoint(&checkpoint_path, &checkpoint_id, || {
            fs::write(checkpoint_path.join("partial-config"), "incomplete")
                .expect("write partial checkpoint state");
            Err(BackendError::Git {
                message: "simulated transient checkpoint configuration failure".to_string(),
            })
        })
        .expect_err("partial initialization must fail");
        assert!(error.to_string().contains("simulated transient"));
        assert!(!checkpoint_path.exists());

        let repo =
            open_direct_checkpoint_at(&app_data, "task-1", &project, Some(&checkpoint_id), true)
                .expect("retry checkpoint initialization");
        ensure_direct_checkpoint_head(&repo).expect("create baseline after retry");
        assert!(checkpoint_path.exists());
        assert_eq!(
            fs::read_to_string(project.join("user.txt")).expect("read user file"),
            "unchanged\n"
        );
        assert!(!project.join(".git").exists());
    }

    #[test]
    fn different_checkpoints_can_create_the_shared_storage_root_concurrently() {
        let temp = TempDir::new().expect("temp dir");
        let app_data = temp.path().join("app-data");
        let project_a = temp.path().join("project-a");
        let project_b = temp.path().join("project-b");
        fs::create_dir_all(&app_data).expect("app data");
        fs::create_dir_all(&project_a).expect("project a");
        fs::create_dir_all(&project_b).expect("project b");
        let start = Arc::new(std::sync::Barrier::new(3));
        let workers = [("task-a", project_a), ("task-b", project_b)]
            .into_iter()
            .map(|(task_id, project)| {
                let app_data = app_data.clone();
                let start = Arc::clone(&start);
                std::thread::spawn(move || {
                    start.wait();
                    let checkpoint_id = direct_checkpoint_key(task_id, &project);
                    open_direct_checkpoint_at(
                        &app_data,
                        task_id,
                        &project,
                        Some(&checkpoint_id),
                        true,
                    )
                    .map(|repo| repo.path().to_path_buf())
                })
            })
            .collect::<Vec<_>>();
        start.wait();

        let paths = workers
            .into_iter()
            .map(|worker| {
                worker
                    .join()
                    .expect("checkpoint worker")
                    .expect("create checkpoint")
            })
            .collect::<Vec<_>>();

        assert_eq!(paths.len(), 2);
        assert!(paths.iter().all(|path| path.is_dir()));
        assert!(app_data.join(DIRECT_CHECKPOINTS_DIR).is_dir());
    }

    #[test]
    fn concurrent_direct_review_loads_share_the_checkpoint_lock() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        fs::write(project_path.join("README.md"), "accepted\n").expect("write baseline");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        let checkpoint_path = repo.path().to_path_buf();
        drop(repo);
        let checkpoint_id = "task-review-lock-0123456789abcdef";
        let start = Arc::new(std::sync::Barrier::new(3));
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut workers = Vec::new();

        for _ in 0..2 {
            let checkpoint_path = checkpoint_path.clone();
            let project_path = project_path.clone();
            let start = Arc::clone(&start);
            let active = Arc::clone(&active);
            let peak = Arc::clone(&peak);
            workers.push(std::thread::spawn(move || {
                start.wait();
                let lock = direct_checkpoint_operation_lock(checkpoint_id).expect("review lock");
                let _guard = lock.lock().expect("review guard");
                let current = active.fetch_add(1, AtomicOrdering::SeqCst) + 1;
                peak.fetch_max(current, AtomicOrdering::SeqCst);
                let opened = Repository::open(&checkpoint_path).expect("open checkpoint");
                verify_direct_checkpoint_history(&opened).expect("read accepted history");
                review::build_git_review_snapshot(&opened, &project_path)
                    .expect("load direct review");
                std::thread::sleep(Duration::from_millis(25));
                active.fetch_sub(1, AtomicOrdering::SeqCst);
            }));
        }

        start.wait();
        for worker in workers {
            worker.join().expect("review worker");
        }
        assert_eq!(peak.load(AtomicOrdering::SeqCst), 1);
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_review_detects_an_ancestor_object_removed_between_loads() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        fs::write(project_path.join("README.md"), "first accepted state\n")
            .expect("write first baseline");
        ensure_direct_checkpoint_head(&repo).expect("first baseline");
        let first_blob = repo
            .head()
            .expect("first head")
            .peel_to_commit()
            .expect("first commit")
            .tree()
            .expect("first tree")
            .get_path(Path::new("README.md"))
            .expect("first tree entry")
            .id();

        fs::write(project_path.join("README.md"), "second accepted state\n")
            .expect("write second baseline");
        stage_direct_paths(&repo, &["README.md".to_string()]).expect("stage second baseline");
        accept_direct_changes(&repo).expect("accept second baseline");
        let checkpoint_path = repo.path().to_path_buf();
        let project_before = fs::read(project_path.join("README.md")).expect("read project");
        drop(repo);

        run_direct_checkpoint_review(
            || Ok((Repository::open(&checkpoint_path)?, project_path.clone())),
            None,
            |repo, project| review::build_git_review_snapshot(repo, project),
        )
        .expect("first review");
        let repo = Repository::open(&checkpoint_path).expect("reopen checkpoint");
        remove_loose_checkpoint_object(&repo, first_blob);
        drop(repo);

        let error = match run_direct_checkpoint_review(
            || Ok((Repository::open(&checkpoint_path)?, project_path.clone())),
            None,
            |repo, project| review::build_git_review_snapshot(repo, project),
        ) {
            Ok(_) => panic!("a missing ancestor object must block the next review"),
            Err(error) => error,
        };

        assert_direct_checkpoint_corrupt(error, true);
        assert_eq!(
            fs::read(project_path.join("README.md")).expect("read preserved project"),
            project_before
        );
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn failed_direct_checkpoint_object_write_does_not_publish_a_head() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        fs::write(project_path.join("README.md"), "user content\n").expect("write project");
        let worktree_before = fs::read(project_path.join("README.md")).expect("read project");
        let objects = repo.path().join("objects");
        let saved_objects = repo.path().join("objects.saved-for-test");
        fs::rename(&objects, &saved_objects).expect("move temporary object directory");
        fs::write(&objects, "not a directory").expect("block object writes");

        let error = ensure_direct_checkpoint_head(&repo)
            .expect_err("object write failure must stop checkpoint initialization");

        assert!(matches!(
            error,
            BackendError::DirectCheckpointCorrupt {
                operation: Some(ref operation),
                accepted_history_at_risk: false,
                git_output: None,
                ..
            } if operation.starts_with("direct_checkpoint_init_")
        ));
        assert!(repo.head().is_err());
        assert_eq!(
            fs::read(project_path.join("README.md")).expect("read project after failure"),
            worktree_before
        );
        assert!(!project_path.join(".git").exists());

        fs::remove_file(&objects).expect("remove test blocker");
        fs::rename(&saved_objects, &objects).expect("restore object directory");
        fs::remove_file(project_path.join("README.md")).expect("remove file before retry");

        ensure_direct_checkpoint_head(&repo).expect("retry checkpoint initialization");
        let accepted_tree = repo
            .head()
            .expect("checkpoint head")
            .peel_to_commit()
            .expect("checkpoint commit")
            .tree()
            .expect("checkpoint tree");
        assert!(accepted_tree.get_path(Path::new("README.md")).is_err());
        assert!(!project_path.join("README.md").exists());
        assert!(!project_path.join(".git").exists());
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

        let checkpoint_id = direct_checkpoint_key("task-1", &outside_root);
        let error = expect_checkpoint_open_error(
            open_direct_checkpoint_at(
                &app_data_dir,
                "task-1",
                &outside_root,
                Some(&checkpoint_id),
                true,
            ),
            "linked checkpoint root must be rejected before creation",
        );

        assert!(matches!(
            error,
            BackendError::DirectCheckpointCorrupt {
                operation: Some(ref operation),
                ..
            } if operation == "direct_checkpoint_root"
        ));
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
        let checkpoint_id = direct_checkpoint_key("task-1", &project_path);
        let repo = open_direct_checkpoint_at(
            temp.path(),
            "task-1",
            &project_path,
            Some(&checkpoint_id),
            true,
        )
        .expect("create checkpoint");
        let checkpoint_path = repo.path().to_path_buf();
        drop(repo);
        let sibling_id = direct_checkpoint_key("task-2", &project_path);
        let sibling = open_direct_checkpoint_at(
            temp.path(),
            "task-2",
            &project_path,
            Some(&sibling_id),
            true,
        )
        .expect("create sibling checkpoint");
        let sibling_path = sibling.path().to_path_buf();
        drop(sibling);

        let other_project = temp.path().join("other-project");
        fs::create_dir_all(&other_project).expect("create other project");
        let wrong_project_error =
            remove_direct_checkpoint(temp.path(), "task-1", &checkpoint_id, &other_project)
                .expect_err("another project must not remove the checkpoint");
        assert!(wrong_project_error
            .to_string()
            .contains("does not belong to this project"));
        assert!(checkpoint_path.exists());

        assert!(
            remove_direct_checkpoint(temp.path(), "task-1", &checkpoint_id, &project_path)
                .expect("remove checkpoint")
        );
        assert!(!checkpoint_path.exists());
        assert!(sibling_path.exists());
        assert!(direct_checkpoint_known_marker(
            &temp.path().join(DIRECT_CHECKPOINTS_DIR),
            &checkpoint_id,
        )
        .exists());
        assert!(
            !remove_direct_checkpoint(temp.path(), "task-1", &checkpoint_id, &project_path)
                .expect("repeat checkpoint removal")
        );
    }

    #[test]
    fn direct_checkpoint_never_recreates_after_a_dangling_marker() {
        let temp = TempDir::new().expect("temp dir");
        let project_path = temp.path().join("project");
        fs::create_dir_all(&project_path).expect("project");
        fs::write(project_path.join("pending.txt"), "pending\n").expect("project file");
        let checkpoint_id = direct_checkpoint_key("task-1", &project_path);
        let repo = open_direct_checkpoint_at(
            temp.path(),
            "task-1",
            &project_path,
            Some(&checkpoint_id),
            true,
        )
        .expect("create checkpoint");
        drop(repo);
        assert!(
            remove_direct_checkpoint(temp.path(), "task-1", &checkpoint_id, &project_path)
                .expect("remove checkpoint")
        );
        let marker = direct_checkpoint_known_marker(
            &temp.path().join(DIRECT_CHECKPOINTS_DIR),
            &checkpoint_id,
        );
        fs::remove_file(&marker).expect("remove regular marker");
        let missing_target = temp.path().join("missing-marker-target");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&missing_target, &marker).expect("dangling marker link");
        #[cfg(windows)]
        {
            fs::create_dir_all(&missing_target).expect("temporary marker target");
            create_windows_junction(&marker, &missing_target);
            fs::remove_dir(&missing_target).expect("make marker junction dangling");
        }

        let error = expect_checkpoint_open_error(
            open_direct_checkpoint_at(
                temp.path(),
                "task-1",
                &project_path,
                Some(&checkpoint_id),
                true,
            ),
            "a dangling tombstone must block recreation",
        );

        assert!(matches!(
            error,
            BackendError::DirectCheckpointCorrupt {
                operation: Some(ref operation),
                ..
            } if operation == "direct_checkpoint_marker"
        ));
        assert!(!temp
            .path()
            .join(DIRECT_CHECKPOINTS_DIR)
            .join(&checkpoint_id)
            .exists());
        assert_eq!(
            fs::read_to_string(project_path.join("pending.txt")).expect("project preserved"),
            "pending\n"
        );
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_checkpoint_removal_rejects_another_task_owner() {
        let temp = TempDir::new().expect("temp dir");
        let project_path = temp.path().join("project");
        fs::create_dir_all(&project_path).expect("create project");
        let checkpoint_id = direct_checkpoint_key("task/2", &project_path);
        let repo = open_direct_checkpoint_at(
            temp.path(),
            "task/2",
            &project_path,
            Some(&checkpoint_id),
            true,
        )
        .expect("create checkpoint");
        let checkpoint_path = repo.path().to_path_buf();
        drop(repo);

        let error = remove_direct_checkpoint(temp.path(), "task:2", &checkpoint_id, &project_path)
            .expect_err("a colliding sanitized task id must not remove the checkpoint");

        assert!(error.to_string().contains("does not belong to this task"));
        assert!(checkpoint_path.exists());
    }

    #[test]
    fn legacy_checkpoint_without_exact_owner_is_preserved_and_blocked() {
        let temp = TempDir::new().expect("temp dir");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        let checkpoint_id = direct_checkpoint_key("task-1", &project);
        let repo =
            open_direct_checkpoint_at(temp.path(), "task-1", &project, Some(&checkpoint_id), true)
                .expect("create checkpoint");
        let checkpoint_path = repo.path().to_path_buf();
        repo.config()
            .and_then(|mut config| config.remove("macro.taskId"))
            .expect("simulate legacy checkpoint");
        drop(repo);

        let error = remove_direct_checkpoint(temp.path(), "task-1", &checkpoint_id, &project)
            .expect_err("unverified legacy checkpoint must be preserved");
        assert!(error.to_string().contains("legacy direct checkpoint"));
        assert!(checkpoint_path.exists());

        let reopen_error = expect_checkpoint_open_error(
            open_direct_checkpoint_at(temp.path(), "task-1", &project, Some(&checkpoint_id), true),
            "legacy ownership must not be guessed",
        );
        assert!(matches!(
            reopen_error,
            BackendError::DirectCheckpointCorrupt {
                operation: Some(operation),
                accepted_history_at_risk: true,
                ..
            } if operation == "direct_checkpoint_owner"
        ));
        assert!(checkpoint_path.exists());
    }

    #[test]
    fn failed_checkpoint_directory_initialization_does_not_publish_a_tombstone() {
        let temp = TempDir::new().expect("temp dir");
        let app_data = temp.path().join("app-data");
        let project = temp.path().join("project");
        fs::create_dir_all(&app_data).expect("app data");
        fs::create_dir_all(&project).expect("project");
        let checkpoint_id = direct_checkpoint_key("task-1", &project);
        let checkpoint_root = app_data.join(DIRECT_CHECKPOINTS_DIR);
        fs::create_dir_all(&checkpoint_root).expect("checkpoint root");
        let blocked_path = checkpoint_root.join(&checkpoint_id);
        fs::write(&blocked_path, "not a directory").expect("block checkpoint directory");

        let error = expect_checkpoint_open_error(
            open_direct_checkpoint_at(&app_data, "task-1", &project, Some(&checkpoint_id), true),
            "failed initialization must remain retryable",
        );
        assert!(matches!(
            error,
            BackendError::DirectCheckpointCorrupt {
                operation: Some(ref operation),
                ..
            } if operation == "direct_checkpoint_path"
        ));
        assert!(!direct_checkpoint_known_marker(&checkpoint_root, &checkpoint_id).exists());

        fs::remove_file(&blocked_path).expect("remove blocker");
        let repo =
            open_direct_checkpoint_at(&app_data, "task-1", &project, Some(&checkpoint_id), true)
                .expect("retry initialization");
        assert!(direct_checkpoint_known_marker(&checkpoint_root, &checkpoint_id).exists());
        assert!(repo.head().is_err());
        assert!(!project.join(".git").exists());
    }

    #[test]
    fn direct_checkpoint_repairs_exclusions_before_capturing_a_baseline() {
        let temp = TempDir::new().expect("temp dir");
        let app_data = temp.path().join("app-data");
        let project = temp.path().join("project");
        fs::create_dir_all(&app_data).expect("app data");
        fs::create_dir_all(&project).expect("project");
        fs::write(project.join("visible.txt"), "visible\n").expect("visible file");
        fs::write(project.join(".gitignore"), "ignored.log\n!.env\n").expect("project gitignore");
        fs::write(project.join(".env"), "SECRET=must-not-be-captured\n").expect("secret file");
        fs::write(project.join("ignored.log"), "ignored\n").expect("ignored file");
        let checkpoint_id = direct_checkpoint_key("task-1", &project);
        let repo =
            open_direct_checkpoint_at(&app_data, "task-1", &project, Some(&checkpoint_id), true)
                .expect("create checkpoint");
        let exclude_path = repo.path().join("info").join("exclude");
        drop(repo);
        fs::write(&exclude_path, "!*.env\n").expect("corrupt exclusions");

        let reopened =
            open_direct_checkpoint_at(&app_data, "task-1", &project, Some(&checkpoint_id), true)
                .expect("reopen repairs exclusions");
        ensure_direct_checkpoint_head(&reopened).expect("capture baseline");
        let mut index = reopened.index().expect("index");
        index.read(true).expect("refresh index");

        assert_eq!(
            fs::read_to_string(&exclude_path).expect("repaired exclusions"),
            DIRECT_CHECKPOINT_EXCLUDES
        );
        assert!(index.get_path(Path::new("visible.txt"), 0).is_some());
        assert!(index.get_path(Path::new(".env"), 0).is_none());
        assert!(index.get_path(Path::new("ignored.log"), 0).is_none());
        let head = reopened
            .head()
            .expect("head")
            .peel_to_commit()
            .expect("commit");
        let tree = head.tree().expect("tree");
        assert!(tree.get_path(Path::new("visible.txt")).is_ok());
        assert!(tree.get_path(Path::new(".env")).is_err());
        assert!(!project.join(".git").exists());
    }

    #[test]
    fn direct_checkpoint_exclusions_cannot_be_negated_by_project_gitignore() {
        let (_temp, project, repo) = init_direct_checkpoint();
        fs::create_dir_all(project.join(".env")).expect("secret directory");
        fs::write(
            project.join(".gitignore"),
            "!.env\n!.env/**\n!.env.*\n!*.pem\n!*.key\n",
        )
        .expect("gitignore");
        fs::write(project.join(".env").join("token.txt"), "hidden\n").expect("secret child");
        fs::write(project.join(".npmrc"), "//registry/:_authToken=hidden\n")
            .expect("credential file");
        let excluded_files = [
            (".env.production", "production secret\n"),
            ("certificate.pem", "private certificate\n"),
            ("private.key", "private key\n"),
        ];
        for (name, contents) in excluded_files {
            fs::write(project.join(name), contents).expect("excluded credential file");
        }
        fs::write(project.join("visible.txt"), "visible\n").expect("visible file");

        ensure_direct_checkpoint_head(&repo).expect("capture baseline");
        let mut index = repo.index().expect("index");
        index.read(true).expect("refresh index");
        assert!(index.get_path(Path::new("visible.txt"), 0).is_some());
        assert!(index.get_path(Path::new(".env/token.txt"), 0).is_none());
        assert!(index.get_path(Path::new(".npmrc"), 0).is_none());
        for (name, _) in excluded_files {
            assert!(index.get_path(Path::new(name), 0).is_none(), "{name}");
        }

        fs::write(project.join(".env").join("later.txt"), "later\n").expect("later secret");
        let mut snapshot = review::build_git_review_snapshot(&repo, &project).expect("snapshot");
        filter_direct_checkpoint_snapshot(&mut snapshot);
        assert!(snapshot
            .changes
            .iter()
            .all(|change| !change.path.starts_with(".env")));
        assert!(stage_direct_paths(&repo, &[".env/later.txt".to_string()]).is_err());
        assert!(stage_direct_paths(&repo, &[".npmrc".to_string()]).is_err());
        for (name, _) in excluded_files {
            assert!(stage_direct_paths(&repo, &[name.to_string()]).is_err());
            assert!(
                restore_direct_worktree_paths(&repo, &project, vec![name.to_string()]).is_err()
            );
        }
        assert!(
            restore_direct_worktree_paths(&repo, &project, vec![".env/later.txt".to_string()])
                .is_err()
        );
        assert_eq!(
            fs::read_to_string(project.join(".env").join("later.txt")).expect("secret preserved"),
            "later\n"
        );
        assert_eq!(
            fs::read_to_string(project.join(".npmrc")).expect("credential preserved"),
            "//registry/:_authToken=hidden\n"
        );
        assert!(!project.join(".git").exists());
    }

    #[test]
    fn direct_checkpoint_never_captures_files_through_a_linked_directory() {
        let temp = TempDir::new().expect("temp dir");
        let project = temp.path().join("project");
        let checkpoint = temp.path().join("checkpoint");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&project).expect("project");
        fs::create_dir_all(&outside).expect("outside");
        fs::write(project.join("visible.txt"), "visible\n").expect("visible file");
        fs::write(outside.join("token.txt"), "outside secret\n").expect("outside file");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, project.join("linked")).expect("linked directory");
        #[cfg(windows)]
        create_windows_junction(&project.join("linked"), &outside);
        let repo = Repository::init_bare(&checkpoint).expect("checkpoint");
        {
            let mut config = repo.config().expect("config");
            config.set_bool("core.bare", false).expect("non-bare");
            config
                .set_str("core.worktree", &project.to_string_lossy())
                .expect("worktree");
        }
        fs::create_dir_all(checkpoint.join("info")).expect("info");
        fs::write(checkpoint.join("info/exclude"), DIRECT_CHECKPOINT_EXCLUDES).expect("exclusions");

        ensure_direct_checkpoint_head(&repo).expect("baseline");
        let tree = repo
            .head()
            .expect("head")
            .peel_to_commit()
            .expect("commit")
            .tree()
            .expect("tree");
        assert!(tree.get_path(Path::new("visible.txt")).is_ok());
        assert!(tree.get_path(Path::new("linked/token.txt")).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            let linked = tree.get_path(Path::new("linked")).expect("linked entry");
            assert_eq!(linked.filemode(), 0o120000);
            assert_eq!(
                repo.find_blob(linked.id()).expect("linked blob").content(),
                outside.as_os_str().as_bytes()
            );
        }
        #[cfg(windows)]
        assert!(tree.get_path(Path::new("linked")).is_err());
        assert!(stage_direct_paths(&repo, &["linked/token.txt".to_string()]).is_err());
        assert_eq!(
            fs::read_to_string(outside.join("token.txt")).expect("outside preserved"),
            "outside secret\n"
        );
        assert!(!project.join(".git").exists());
    }

    #[test]
    fn direct_checkpoint_file_open_never_follows_a_linked_entry() {
        let temp = TempDir::new().expect("temp dir");
        let project = temp.path().join("project");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&project).expect("project");
        fs::create_dir_all(&outside).expect("outside");
        fs::write(outside.join("secret.txt"), "outside secret\n").expect("outside secret");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.join("secret.txt"), project.join("linked"))
            .expect("linked file");
        #[cfg(windows)]
        create_windows_junction(&project.join("linked"), &outside);
        let root =
            CapabilityDir::open_ambient_dir(&project, ambient_authority()).expect("retain project");

        open_direct_regular_file_no_follow(&root, OsStr::new("linked"))
            .expect_err("linked entries must not be opened as checkpoint files");

        assert_eq!(
            fs::read_to_string(outside.join("secret.txt")).expect("outside preserved"),
            "outside secret\n"
        );
    }

    #[test]
    fn direct_checkpoint_excludes_common_credential_files() {
        for name in [
            ".npmrc",
            ".pypirc",
            ".netrc",
            ".git-credentials",
            ".envrc",
            ".dev.vars",
            "identity.p12",
            "identity.pfx",
            "keystore.jks",
            "identity.ppk",
            "id_rsa",
            "id_ed25519",
            "id_ecdsa",
            "kubeconfig",
            "terraform.tfstate",
            "terraform.tfstate.backup",
            "build-service-account.json",
            "credentials.json",
            "client_secret_app.json",
            ".streamlit/secrets.toml",
            ".ssh/id_ed25519",
            ".aws/credentials",
            ".docker/config.json",
            ".kube/config",
        ] {
            assert!(
                is_direct_checkpoint_excluded_path(Path::new(name)),
                "{name}"
            );
            assert!(is_direct_checkpoint_excluded_path(
                Path::new("nested").join(name).join("child").as_path()
            ));
        }
    }

    #[test]
    fn direct_checkpoint_never_captures_tool_credentials() {
        let (_temp, project, repo) = init_direct_checkpoint();
        let credentials = [
            ".envrc",
            ".dev.vars",
            ".ssh/id_ed25519",
            ".aws/credentials",
            ".docker/config.json",
            ".kube/config",
            "identity.p12",
            "identity.ppk",
            "id_rsa",
            "id_ed25519",
            "id_ecdsa",
            "terraform.tfstate",
            "build-service-account.json",
            "credentials.json",
            "client_secret_app.json",
            ".streamlit/secrets.toml",
        ];
        for path in credentials {
            let path = project.join(path);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("credential parent");
            }
            fs::write(path, "secret\n").expect("credential file");
        }
        fs::write(project.join("visible.txt"), "visible\n").expect("visible file");

        ensure_direct_checkpoint_head(&repo).expect("capture baseline");
        let mut index = repo.index().expect("index");
        index.read(true).expect("refresh index");
        assert!(index.get_path(Path::new("visible.txt"), 0).is_some());
        for path in credentials {
            assert!(index.get_path(Path::new(path), 0).is_none(), "{path}");
        }
        fs::write(project.join("client_secret_late.json"), "late secret\n")
            .expect("late credential");
        assert!(stage_direct_paths(&repo, &["client_secret_late.json".to_string()]).is_err());
        assert!(!project.join(".git").exists());
    }

    #[cfg(windows)]
    #[test]
    fn windows_direct_restore_rejects_a_reparse_or_mismatched_parent() {
        let temp = TempDir::new().expect("temp dir");
        let expected = temp.path().join("expected");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&expected).expect("expected");
        fs::create_dir_all(&outside).expect("outside");
        fs::write(outside.join("temporary"), "new\n").expect("temporary");
        fs::write(outside.join("target"), "old\n").expect("target");
        let retained_outside =
            CapabilityDir::open_ambient_dir(&outside, ambient_authority()).expect("retain outside");

        let mismatch = atomic_replace_direct_restore_entry(
            &retained_outside,
            OsStr::new("temporary"),
            OsStr::new("target"),
            &expected,
        )
        .expect_err("a mismatched retained parent must fail");
        assert_eq!(mismatch.kind(), std::io::ErrorKind::PermissionDenied);
        assert_eq!(
            fs::read_to_string(outside.join("target")).expect("target"),
            "old\n"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_direct_restore_never_converts_a_link_to_a_regular_file() {
        let (_temp, project, repo) = init_direct_checkpoint();
        let path = project.join("linked.txt");
        fs::write(&path, "user file\n").expect("user file");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        let blob = repo.blob(b"target.txt").expect("link blob");
        let mut index = repo.index().expect("index");
        index
            .add(&git2::IndexEntry {
                ctime: git2::IndexTime::new(0, 0),
                mtime: git2::IndexTime::new(0, 0),
                dev: 0,
                ino: 0,
                mode: 0o120000,
                uid: 0,
                gid: 0,
                file_size: 10,
                id: blob,
                flags: 0,
                flags_extended: 0,
                path: b"linked.txt".to_vec(),
            })
            .expect("link index entry");
        index.write().expect("write link index");

        restore_direct_worktree_paths(&repo, &project, vec!["linked.txt".to_string()])
            .expect_err("Windows must reject link restore before mutation");

        assert_eq!(
            fs::read_to_string(&path).expect("user file preserved"),
            "user file\n"
        );
        assert!(!project.join(".git").exists());
        assert!(fs::read_dir(&project)
            .expect("project entries")
            .filter_map(|entry| entry.ok())
            .all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .contains("macro-restore")));
    }

    #[test]
    fn pre_cancelled_direct_review_never_runs_the_operation() {
        let (_temp, project, repo) = init_direct_checkpoint();
        fs::write(project.join("README.md"), "accepted\n").expect("project file");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        let checkpoint = repo.path().to_path_buf();
        drop(repo);
        let cancelled = Arc::new(AtomicBool::new(true));
        let operation_ran = Arc::new(AtomicBool::new(false));
        let operation_marker = operation_ran.clone();

        let error = run_direct_checkpoint_review(
            || Ok((Repository::open(&checkpoint)?, project.clone())),
            Some(cancelled),
            move |_, _| {
                operation_marker.store(true, Ordering::Release);
                Ok(())
            },
        )
        .expect_err("pre-cancelled direct review must stop");

        assert!(matches!(
            error,
            BackendError::Git { message } if message == "Git review was cancelled."
        ));
        assert!(!operation_ran.load(Ordering::Acquire));
    }

    #[cfg(unix)]
    #[test]
    fn direct_checkpoint_stages_a_dangling_symbolic_link_as_a_link() {
        use std::os::unix::fs::symlink;

        let (_temp, project, repo) = init_direct_checkpoint();
        symlink("accepted-target", project.join("linked.txt")).expect("accepted link");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        fs::remove_file(project.join("linked.txt")).expect("remove accepted link");
        symlink("missing-pending-target", project.join("linked.txt")).expect("pending link");

        stage_direct_paths(&repo, &["linked.txt".to_string()]).expect("stage pending link");
        accept_direct_changes(&repo).expect("accept pending link");

        let head = repo.head().expect("head").peel_to_commit().expect("commit");
        let tree = head.tree().expect("tree");
        let entry = tree
            .get_path(Path::new("linked.txt"))
            .expect("linked entry");
        assert_eq!(entry.filemode(), 0o120000);
        let blob = repo.find_blob(entry.id()).expect("link blob");
        assert_eq!(blob.content(), b"missing-pending-target");
        assert!(!project.join(".git").exists());
    }

    #[test]
    fn direct_checkpoint_never_writes_exclusions_through_a_link() {
        let temp = TempDir::new().expect("temp dir");
        let app_data = temp.path().join("app-data");
        let project = temp.path().join("project");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&app_data).expect("app data");
        fs::create_dir_all(&project).expect("project");
        fs::create_dir_all(&outside).expect("outside");
        fs::write(outside.join("exclude"), "keep outside\n").expect("outside file");
        let checkpoint_id = direct_checkpoint_key("task-1", &project);
        let repo =
            open_direct_checkpoint_at(&app_data, "task-1", &project, Some(&checkpoint_id), true)
                .expect("create checkpoint");
        let info = repo.path().join("info");
        drop(repo);
        fs::remove_dir_all(&info).expect("remove managed info directory");

        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &info).expect("link info directory");
        #[cfg(windows)]
        if std::os::windows::fs::symlink_dir(&outside, &info).is_err() {
            return;
        }

        let error = expect_checkpoint_open_error(
            open_direct_checkpoint_at(&app_data, "task-1", &project, Some(&checkpoint_id), true),
            "linked exclusions must be rejected",
        );

        assert!(matches!(
            error,
            BackendError::DirectCheckpointCorrupt {
                operation: Some(ref operation),
                ..
            } if operation == "direct_checkpoint_exclusions"
        ));
        assert_eq!(
            fs::read_to_string(outside.join("exclude")).expect("outside file"),
            "keep outside\n"
        );
        assert!(!project.join(".git").exists());
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

        let error = remove_direct_checkpoint(&app_data_dir, "task-1", checkpoint_id, &outside_root)
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

        let capability =
            open_direct_restore_capability(&project_path).expect("retain project root");
        assert!(capability.metadata("src").expect("inspect src").is_dir());
    }

    #[test]
    fn direct_restore_replaces_a_tracked_file_from_the_checkpoint_index() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        fs::create_dir_all(project_path.join("src")).expect("create source directory");
        fs::write(project_path.join("src/main.txt"), "accepted\n").expect("write accepted file");
        let accepted_head = ensure_direct_checkpoint_head(&repo).expect("capture baseline");
        fs::write(project_path.join("src/main.txt"), "pending\n").expect("write pending file");

        restore_direct_worktree_paths(&repo, &project_path, vec!["src/main.txt".to_string()])
            .expect("restore tracked file");

        assert_eq!(
            fs::read_to_string(project_path.join("src/main.txt")).expect("read restored file"),
            "accepted\n"
        );
        assert_eq!(
            repo.head().expect("head").target().map(|id| id.to_string()),
            Some(accepted_head)
        );
        assert!(fs::read_dir(project_path.join("src"))
            .expect("read source directory")
            .all(|entry| !entry
                .expect("source entry")
                .file_name()
                .to_string_lossy()
                .contains("macro-restore")));
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_stage_and_restore_treat_a_rename_as_one_change() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        fs::write(project_path.join("old.txt"), "accepted\n").expect("accepted file");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        fs::rename(project_path.join("old.txt"), project_path.join("new.txt"))
            .expect("rename file");

        let status = build_git_status(&repo).expect("rename status");
        let renamed = status
            .unstaged_files
            .iter()
            .find(|file| file.path == "new.txt")
            .expect("renamed file");
        assert_eq!(renamed.status, "renamed");
        assert_eq!(renamed.old_path.as_deref(), Some("old.txt"));
        stage_direct_paths(&repo, &["new.txt".to_string()]).expect("stage rename pair");
        let mut index = repo.index().expect("index");
        index.read(true).expect("refresh index");
        assert!(index.get_path(Path::new("old.txt"), 0).is_none());
        assert!(index.get_path(Path::new("new.txt"), 0).is_some());

        unstage_direct_paths(&repo, &["new.txt".to_string()]).expect("unstage rename pair");
        index.read(true).expect("refresh unstaged index");
        assert!(index.get_path(Path::new("old.txt"), 0).is_some());
        assert!(index.get_path(Path::new("new.txt"), 0).is_none());

        restore_direct_worktree_paths(&repo, &project_path, vec!["new.txt".to_string()])
            .expect("restore rename pair");
        assert_eq!(
            fs::read_to_string(project_path.join("old.txt")).expect("old path restored"),
            "accepted\n"
        );
        assert!(!project_path.join("new.txt").exists());
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_checkpoint_rejects_a_blob_with_mismatched_content_hash() {
        use flate2::write::ZlibEncoder;
        use flate2::Compression;

        let (_temp, project_path, repo) = init_direct_checkpoint();
        fs::write(project_path.join("file.txt"), "accepted\n").expect("accepted file");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        let head = repo.head().expect("head").peel_to_commit().expect("commit");
        let tree = head.tree().expect("tree");
        let blob_id = tree.get_path(Path::new("file.txt")).expect("entry").id();
        let object_path = repo
            .path()
            .join("objects")
            .join(&blob_id.to_string()[..2])
            .join(&blob_id.to_string()[2..]);
        let checkpoint_path = repo.path().to_path_buf();
        drop(tree);
        drop(head);
        drop(repo);
        let altered = b"tampered\n";
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder
            .write_all(format!("blob {}\0", altered.len()).as_bytes())
            .expect("write object header");
        encoder.write_all(altered).expect("write altered blob");
        let mut permissions = fs::metadata(&object_path)
            .expect("loose object metadata")
            .permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&object_path, permissions).expect("make loose object writable");
        fs::write(
            &object_path,
            encoder.finish().expect("compress altered blob"),
        )
        .expect("replace loose object");
        let reopened = Repository::open(&checkpoint_path).expect("reopen checkpoint");

        let error = ensure_direct_checkpoint_integrity(&reopened)
            .expect_err("an altered blob must fail integrity verification");

        assert!(matches!(
            error,
            BackendError::DirectCheckpointCorrupt {
                object_id: Some(ref object_id),
                operation: Some(ref operation),
                ..
            } if object_id == &blob_id.to_string()
                && operation == "direct_checkpoint_head_blob"
        ));
        assert_eq!(
            fs::read_to_string(project_path.join("file.txt")).expect("project preserved"),
            "accepted\n"
        );
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_restore_streams_a_large_checkpoint_blob() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        let accepted = vec![b'a'; 8 * 1024 * 1024];
        fs::write(project_path.join("asset.bin"), &accepted).expect("write accepted asset");
        ensure_direct_checkpoint_head(&repo).expect("capture baseline");
        fs::write(project_path.join("asset.bin"), b"pending").expect("write pending asset");

        restore_direct_worktree_paths(&repo, &project_path, vec!["asset.bin".to_string()])
            .expect("restore large asset by streaming");

        assert_eq!(
            fs::metadata(project_path.join("asset.bin"))
                .expect("asset metadata")
                .len(),
            accepted.len() as u64
        );
        assert_eq!(
            Sha256::digest(fs::read(project_path.join("asset.bin")).expect("restored asset")),
            Sha256::digest(&accepted)
        );
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_stage_rejects_content_changed_after_the_snapshot() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        let path = project_path.join("file.txt");
        fs::write(&path, "accepted\n").expect("accepted file");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        fs::write(&path, "reviewed\n").expect("reviewed file");
        let root = open_direct_restore_capability(&project_path).expect("retain project");
        let revision = direct_worktree_revision(&root, Path::new("file.txt"), "file.txt")
            .expect("snapshot revision");
        let before = repo
            .index()
            .expect("index")
            .get_path(Path::new("file.txt"), 0)
            .expect("baseline entry")
            .id;
        fs::write(&path, "saved after review\n").expect("concurrent save");

        let error = stage_direct_paths_with_revisions(
            &repo,
            &["file.txt".to_string()],
            &HashMap::from([("file.txt".to_string(), revision)]),
        )
        .expect_err("stale review must not validate a concurrent save");

        assert!(matches!(error, BackendError::RevisionConflict { .. }));
        assert_eq!(
            repo.index()
                .expect("index")
                .get_path(Path::new("file.txt"), 0)
                .expect("baseline entry")
                .id,
            before
        );
        assert_eq!(
            fs::read_to_string(path).expect("file"),
            "saved after review\n"
        );
    }

    #[test]
    fn direct_stage_prevalidates_every_path_before_writing_objects() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        fs::write(project_path.join("a.txt"), "accepted\n").expect("accepted file");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        fs::write(project_path.join("a.txt"), "pending\n").expect("pending file");
        let root = open_direct_restore_capability(&project_path).expect("retain project");
        let revision = direct_worktree_revision(&root, Path::new("a.txt"), "a.txt")
            .expect("snapshot revision");
        let count_objects = || {
            let mut count = 0usize;
            repo.odb()
                .expect("odb")
                .foreach(|_| {
                    count += 1;
                    true
                })
                .expect("walk odb");
            count
        };
        let before = count_objects();

        stage_direct_paths_with_revisions(
            &repo,
            &["a.txt".to_string(), "z/../../escape.txt".to_string()],
            &HashMap::from([
                ("a.txt".to_string(), revision),
                ("z/../../escape.txt".to_string(), "v1:absent".to_string()),
            ]),
        )
        .expect_err("invalid late path must reject the complete batch");

        assert_eq!(count_objects(), before);
    }

    #[test]
    fn direct_review_authorization_rejects_an_unknown_path_with_a_valid_revision() {
        let temp = TempDir::new().expect("temp dir");
        let revisions = HashMap::from([("reviewed.txt".to_string(), "v1:absent".to_string())]);
        let snapshot_id = register_direct_review_authorization(
            "task-1",
            temp.path(),
            "task-1-0000000000000001",
            "checkpoint-revision-1",
            &revisions,
        )
        .expect("register snapshot");

        let error = resolve_direct_review_authorization(
            &snapshot_id,
            "task-1",
            temp.path(),
            "task-1-0000000000000001",
            "checkpoint-revision-1",
            &["unknown.txt".to_string()],
        )
        .expect_err("a caller-provided digest cannot authorize an unknown path");

        assert!(matches!(error, BackendError::RevisionConflict { .. }));

        let other_project = TempDir::new().expect("other project");
        for (task_id, project_path, checkpoint_id) in [
            ("task-2", temp.path(), "task-1-0000000000000001"),
            ("task-1", other_project.path(), "task-1-0000000000000001"),
            ("task-1", temp.path(), "task-1-0000000000000002"),
        ] {
            let error = resolve_direct_review_authorization(
                &snapshot_id,
                task_id,
                project_path,
                checkpoint_id,
                "checkpoint-revision-1",
                &["reviewed.txt".to_string()],
            )
            .expect_err("snapshot identity must remain bound to its context");
            assert!(matches!(error, BackendError::RevisionConflict { .. }));
        }
    }

    #[test]
    fn direct_review_authorization_rejects_a_changed_checkpoint_revision() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        let path = project_path.join("file.txt");
        fs::write(&path, "accepted\n").expect("accepted file");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        fs::write(&path, "pending\n").expect("pending file");
        let root = open_direct_restore_capability(&project_path).expect("retain project");
        let worktree_revision = direct_worktree_revision(&root, Path::new("file.txt"), "file.txt")
            .expect("worktree revision");
        let checkpoint_revision = direct_checkpoint_revision(&repo).expect("checkpoint revision");
        let snapshot_id = register_direct_review_authorization(
            "task-1",
            &project_path,
            "task-1-0000000000000001",
            &checkpoint_revision,
            &HashMap::from([("file.txt".to_string(), worktree_revision)]),
        )
        .expect("register snapshot");

        let mut index = repo.index().expect("index");
        index
            .remove_path(Path::new("file.txt"))
            .expect("change index");
        index.write().expect("persist changed index");
        let changed_revision = direct_checkpoint_revision(&repo).expect("changed revision");
        assert_ne!(changed_revision, checkpoint_revision);

        let error = resolve_direct_review_authorization(
            &snapshot_id,
            "task-1",
            &project_path,
            "task-1-0000000000000001",
            &changed_revision,
            &["file.txt".to_string()],
        )
        .expect_err("an old snapshot must not authorize a changed checkpoint");

        assert!(matches!(error, BackendError::RevisionConflict { .. }));
        assert_eq!(fs::read_to_string(path).expect("file"), "pending\n");
    }

    #[test]
    fn direct_review_snapshot_registration_rejects_an_index_change_during_capture() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        let path = project_path.join("file.txt");
        fs::write(&path, "accepted\n").expect("accepted file");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        fs::write(&path, "pending\n").expect("pending file");
        let checkpoint_revision = direct_checkpoint_revision(&repo).expect("starting revision");
        review::build_git_review_snapshot(&repo, &project_path).expect("captured snapshot");

        let mut index = repo.index().expect("index");
        index
            .remove_path(Path::new("file.txt"))
            .expect("concurrent index change");
        index.write().expect("persist concurrent index change");

        let error = register_direct_review_authorization_if_checkpoint_unchanged(
            &repo,
            &checkpoint_revision,
            "task-1",
            &project_path,
            "task-1-0000000000000001",
            &HashMap::from([("file.txt".to_string(), "v1:absent".to_string())]),
        )
        .expect_err("a mixed-revision snapshot must not receive an authorization token");

        assert!(matches!(error, BackendError::RevisionConflict { .. }));
        assert_eq!(fs::read_to_string(path).expect("file"), "pending\n");
    }

    #[test]
    fn direct_checkpoint_verification_has_one_global_object_budget() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        fs::write(project_path.join("file.txt"), "accepted\n").expect("accepted file");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        let mut budget = DirectCheckpointVerificationBudget {
            remaining_bytes: MAX_DIRECT_REVIEW_REVISION_BYTES,
            remaining_objects: 0,
        };

        let error = verify_direct_checkpoint_history_with_budget(&repo, None, &mut budget)
            .expect_err("verification must stop at the shared object limit");

        assert!(matches!(error, BackendError::FilesystemFileTooLarge { .. }));
    }

    #[test]
    fn direct_checkpoint_initial_scan_stops_at_the_path_limit() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        for index in 0..=MAX_DIRECT_REVIEW_PATHS {
            fs::write(project_path.join(format!("entry-{index}.txt")), b"x")
                .expect("create bounded scan fixture");
        }
        let mut files = Vec::new();
        let mut scanned_entries = 0usize;

        let error = collect_direct_checkpoint_files(
            &repo,
            &project_path,
            &project_path,
            &mut files,
            &mut scanned_entries,
        )
        .expect_err("initial capture must stop at the path limit");

        assert!(matches!(error, BackendError::FilesystemFileTooLarge { .. }));
        assert!(repo.is_empty().expect("checkpoint state"));
    }

    #[test]
    fn direct_review_revision_hashing_is_bounded_and_cancellable_between_reads() {
        let temp = TempDir::new().expect("temp dir");
        let path = temp.path().join("macro-test-cancel-revision.bin");
        fs::write(&path, vec![b'x'; 256 * 1024]).expect("large revision file");
        let root = open_direct_restore_capability(temp.path()).expect("retain project");
        let cancellation = Arc::new(AtomicBool::new(false));
        let mut budget = MAX_DIRECT_REVIEW_REVISION_BYTES;

        let error = direct_worktree_revision_bounded(
            &root,
            Path::new("macro-test-cancel-revision.bin"),
            "macro-test-cancel-revision.bin",
            Some(&cancellation),
            &mut budget,
        )
        .expect_err("cancellation must interrupt revision hashing");

        assert!(matches!(error, BackendError::Git { .. }));
        let mut small_budget = 1usize;
        let error = direct_worktree_revision_bounded(
            &root,
            Path::new("macro-test-cancel-revision.bin"),
            "regular-file.bin",
            None,
            &mut small_budget,
        )
        .expect_err("revision hashing must enforce its byte budget");
        assert!(matches!(error, BackendError::FilesystemFileTooLarge { .. }));
    }

    #[test]
    fn direct_stage_rejects_a_path_batch_above_the_limit() {
        let (_temp, _project_path, repo) = init_direct_checkpoint();
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        let paths = (0..=MAX_DIRECT_REVIEW_PATHS)
            .map(|index| format!("file-{index}.txt"))
            .collect::<Vec<_>>();

        let error = stage_direct_paths_with_revisions(&repo, &paths, &HashMap::new())
            .expect_err("oversized path batch must fail before capture");

        assert!(matches!(error, BackendError::FilesystemFileTooLarge { .. }));
    }

    #[test]
    fn pre_cancelled_direct_restore_does_not_mutate_the_worktree() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        let path = project_path.join("file.txt");
        fs::write(&path, "accepted\n").expect("accepted file");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        fs::write(&path, "pending\n").expect("pending file");
        let root = open_direct_restore_capability(&project_path).expect("retain project");
        let revision = direct_worktree_revision(&root, Path::new("file.txt"), "file.txt")
            .expect("snapshot revision");
        let cancellation = Arc::new(AtomicBool::new(true));

        restore_direct_worktree_paths_with_revisions(
            &repo,
            &project_path,
            vec!["file.txt".to_string()],
            &HashMap::from([("file.txt".to_string(), revision)]),
            Some(&cancellation),
        )
        .expect_err("pre-cancelled restore must stop before publication");

        assert_eq!(fs::read_to_string(path).expect("file"), "pending\n");
    }

    #[test]
    fn direct_restore_never_overwrites_a_concurrent_save() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        let path = project_path.join("macro-test-concurrent-save.txt");
        fs::write(&path, "accepted\n").expect("accepted file");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        fs::write(&path, "pending\n").expect("pending file");

        restore_direct_worktree_paths(
            &repo,
            &project_path,
            vec!["macro-test-concurrent-save.txt".to_string()],
        )
        .expect_err("a concurrent save must stop publication");

        assert_eq!(
            fs::read_to_string(&path).expect("concurrent save preserved"),
            "concurrent save\n"
        );
        assert!(fs::read_dir(&project_path)
            .expect("project entries")
            .filter_map(|entry| entry.ok())
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .contains("macro-restore-backup")));
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_restore_rejects_a_file_changed_since_the_snapshot() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        let path = project_path.join("file.txt");
        fs::write(&path, "accepted\n").expect("accepted file");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        fs::write(&path, "pending at snapshot\n").expect("pending file");
        let root = open_direct_restore_capability(&project_path).expect("retain project");
        let expected = direct_worktree_revision(&root, Path::new("file.txt"), "file.txt")
            .expect("snapshot revision");
        fs::write(&path, "saved after snapshot\n").expect("late save");
        let revisions = HashMap::from([("file.txt".to_string(), expected)]);

        let error = restore_direct_worktree_paths_with_revisions(
            &repo,
            &project_path,
            vec!["file.txt".to_string()],
            &revisions,
            None,
        )
        .expect_err("a stale snapshot must not restore");

        assert!(matches!(error, BackendError::RevisionConflict { .. }));
        assert_eq!(
            fs::read_to_string(&path).expect("late save preserved"),
            "saved after snapshot\n"
        );
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_restore_rechecks_the_file_after_moving_it_to_backup() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        let name = "macro-test-save-before-backup.txt";
        let path = project_path.join(name);
        fs::write(&path, "accepted\n").expect("accepted file");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        fs::write(&path, "pending at snapshot\n").expect("pending file");
        let root = open_direct_restore_capability(&project_path).expect("retain project");
        let expected =
            direct_worktree_revision(&root, Path::new(name), name).expect("snapshot revision");
        let revisions = HashMap::from([(name.to_string(), expected)]);

        let error = restore_direct_worktree_paths_with_revisions(
            &repo,
            &project_path,
            vec![name.to_string()],
            &revisions,
            None,
        )
        .expect_err("a save between validation and backup must stop restore");

        assert!(matches!(error, BackendError::RevisionConflict { .. }));
        assert_eq!(
            fs::read_to_string(&path).expect("concurrent save restored"),
            "save during restore\n"
        );
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_restore_prevalidates_the_complete_batch() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        fs::write(project_path.join("a.txt"), "accepted a\n").expect("accepted a");
        fs::write(project_path.join("b.txt"), "accepted b\n").expect("accepted b");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        fs::write(project_path.join("a.txt"), "pending a\n").expect("pending a");
        fs::write(project_path.join("b.txt"), "pending b\n").expect("pending b");
        let root = open_direct_restore_capability(&project_path).expect("retain project");
        let revisions = HashMap::from([
            (
                "a.txt".to_string(),
                direct_worktree_revision(&root, Path::new("a.txt"), "a.txt").expect("a revision"),
            ),
            (
                "b.txt".to_string(),
                direct_worktree_revision(&root, Path::new("b.txt"), "b.txt").expect("b revision"),
            ),
        ]);
        fs::write(project_path.join("b.txt"), "late b\n").expect("late b");

        restore_direct_worktree_paths_with_revisions(
            &repo,
            &project_path,
            vec!["a.txt".to_string(), "b.txt".to_string()],
            &revisions,
            None,
        )
        .expect_err("the stale second path must block the whole batch");

        assert_eq!(
            fs::read_to_string(project_path.join("a.txt")).expect("a preserved"),
            "pending a\n"
        );
        assert_eq!(
            fs::read_to_string(project_path.join("b.txt")).expect("b preserved"),
            "late b\n"
        );
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_restore_requires_a_snapshot_revision_for_every_path() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        fs::write(project_path.join("file.txt"), "accepted\n").expect("accepted file");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        fs::write(project_path.join("file.txt"), "pending\n").expect("pending file");

        let error = restore_direct_worktree_paths_with_revisions(
            &repo,
            &project_path,
            vec!["file.txt".to_string()],
            &HashMap::new(),
            None,
        )
        .expect_err("missing revisions must fail closed");

        assert!(matches!(error, BackendError::RevisionConflict { .. }));
        assert_eq!(
            fs::read_to_string(project_path.join("file.txt")).expect("file preserved"),
            "pending\n"
        );
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_restore_does_not_expand_an_index_only_rename() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        fs::write(project_path.join("old.txt"), "accepted\n").expect("accepted file");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        fs::rename(project_path.join("old.txt"), project_path.join("new.txt"))
            .expect("rename file");
        stage_direct_paths(&repo, &["new.txt".to_string()]).expect("stage rename");
        fs::write(project_path.join("old.txt"), "independent file\n").expect("recreate old path");
        fs::write(project_path.join("new.txt"), "pending new\n").expect("modify new path");

        restore_direct_worktree_paths(&repo, &project_path, vec!["new.txt".to_string()])
            .expect("restore only the worktree-side change");

        assert_eq!(
            fs::read_to_string(project_path.join("old.txt")).expect("old path preserved"),
            "independent file\n"
        );
        assert_eq!(
            fs::read_to_string(project_path.join("new.txt")).expect("new path restored"),
            "accepted\n"
        );
        let mut index = repo.index().expect("index");
        index.read(true).expect("refresh index");
        assert!(index.get_path(Path::new("old.txt"), 0).is_none());
        assert!(index.get_path(Path::new("new.txt"), 0).is_some());
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_restore_refuses_to_remove_an_untracked_directory() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        let untracked = project_path.join("untracked");
        fs::create_dir_all(&untracked).expect("untracked directory");
        fs::write(untracked.join("keep.txt"), "keep\n").expect("untracked content");

        restore_direct_worktree_paths(&repo, &project_path, vec!["untracked".to_string()])
            .expect_err("untracked directories must not be removed implicitly");

        assert_eq!(
            fs::read_to_string(untracked.join("keep.txt")).expect("directory preserved"),
            "keep\n"
        );
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_restore_rolls_back_earlier_paths_when_a_later_path_fails() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        fs::write(project_path.join("a.txt"), "accepted a\n").expect("accepted a");
        fs::write(
            project_path.join("macro-test-fail-after-backup.txt"),
            "accepted b\n",
        )
        .expect("accepted b");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        fs::write(project_path.join("a.txt"), "pending a\n").expect("pending a");
        fs::write(
            project_path.join("macro-test-fail-after-backup.txt"),
            "pending b\n",
        )
        .expect("pending b");

        restore_direct_worktree_paths(
            &repo,
            &project_path,
            vec![
                "a.txt".to_string(),
                "macro-test-fail-after-backup.txt".to_string(),
            ],
        )
        .expect_err("the injected second restore must fail");

        assert_eq!(
            fs::read_to_string(project_path.join("a.txt")).expect("preserved a"),
            "pending a\n"
        );
        assert_eq!(
            fs::read_to_string(project_path.join("macro-test-fail-after-backup.txt"))
                .expect("preserved b"),
            "pending b\n"
        );
        let artifacts = fs::read_dir(&project_path)
            .expect("project entries")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains("macro-restore"))
            .collect::<Vec<_>>();
        assert!(artifacts.is_empty(), "restore artifacts: {artifacts:?}");
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_restore_rollback_preserves_a_concurrent_type_change() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        fs::write(
            project_path.join("macro-test-concurrent-rollback.txt"),
            "accepted a\n",
        )
        .expect("accepted a");
        fs::write(
            project_path.join("macro-test-fail-after-backup.txt"),
            "accepted b\n",
        )
        .expect("accepted b");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        fs::write(
            project_path.join("macro-test-concurrent-rollback.txt"),
            "pending a\n",
        )
        .expect("pending a");
        fs::write(
            project_path.join("macro-test-fail-after-backup.txt"),
            "pending b\n",
        )
        .expect("pending b");

        let error = restore_direct_worktree_paths(
            &repo,
            &project_path,
            vec![
                "macro-test-concurrent-rollback.txt".to_string(),
                "macro-test-fail-after-backup.txt".to_string(),
            ],
        )
        .expect_err("the concurrent type change must block rollback");

        assert_eq!(
            fs::read_to_string(
                project_path
                    .join("macro-test-concurrent-rollback.txt")
                    .join("keep.txt")
            )
            .expect("concurrent directory preserved"),
            "concurrent directory\n"
        );
        assert!(error
            .to_string()
            .contains("could not restore every preserved file"));
        assert!(fs::read_dir(&project_path)
            .expect("project entries")
            .filter_map(|entry| entry.ok())
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .contains("macro-restore-backup")));
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_restore_rollback_preserves_a_concurrent_file_save_at_its_path() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        let concurrent_path = project_path.join("macro-test-concurrent-file-rollback.txt");
        fs::write(&concurrent_path, "accepted a\n").expect("accepted a");
        fs::write(
            project_path.join("macro-test-fail-after-backup.txt"),
            "accepted b\n",
        )
        .expect("accepted b");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        fs::write(&concurrent_path, "pending a\n").expect("pending a");
        fs::write(
            project_path.join("macro-test-fail-after-backup.txt"),
            "pending b\n",
        )
        .expect("pending b");

        restore_direct_worktree_paths(
            &repo,
            &project_path,
            vec![
                "macro-test-concurrent-file-rollback.txt".to_string(),
                "macro-test-fail-after-backup.txt".to_string(),
            ],
        )
        .expect_err("the second failure must preserve the concurrent file save");

        assert_eq!(
            fs::read_to_string(&concurrent_path).expect("concurrent file"),
            "concurrent file save\n"
        );
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_restore_rollback_never_recursively_removes_a_replaced_displaced_artifact() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        let first = "macro-test-concurrent-displaced-rollback.txt";
        let second = "macro-test-fail-after-backup.txt";
        fs::write(project_path.join(first), "accepted a\n").expect("accepted a");
        fs::write(project_path.join(second), "accepted b\n").expect("accepted b");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        fs::write(project_path.join(first), "pending a\n").expect("pending a");
        fs::write(project_path.join(second), "pending b\n").expect("pending b");

        restore_direct_worktree_paths(
            &repo,
            &project_path,
            vec![first.to_string(), second.to_string()],
        )
        .expect_err("the later failure must retain the replaced displaced artifact");

        assert_eq!(
            fs::read_to_string(project_path.join(first)).expect("pending file restored"),
            "pending a\n"
        );
        assert!(fs::read_dir(&project_path)
            .expect("project entries")
            .filter_map(|entry| entry.ok())
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .contains("macro-restore-backup")
                && entry.path().join("keep.txt").is_file()));
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_restore_rollback_removes_parent_directories_created_by_the_batch() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        fs::create_dir_all(project_path.join("absent")).expect("create accepted directory");
        fs::write(project_path.join("absent/nested.txt"), "accepted nested\n")
            .expect("write accepted nested file");
        fs::write(
            project_path.join("macro-test-fail-after-backup.txt"),
            "accepted failure\n",
        )
        .expect("write accepted failure file");
        ensure_direct_checkpoint_head(&repo).expect("capture baseline");
        fs::remove_dir_all(project_path.join("absent")).expect("remove accepted directory");
        fs::write(
            project_path.join("macro-test-fail-after-backup.txt"),
            "pending failure\n",
        )
        .expect("write pending failure file");

        restore_direct_worktree_paths(
            &repo,
            &project_path,
            vec![
                "absent/nested.txt".to_string(),
                "macro-test-fail-after-backup.txt".to_string(),
            ],
        )
        .expect_err("the second restore must fail");

        assert!(!project_path.join("absent").exists());
        assert_eq!(
            fs::read_to_string(project_path.join("macro-test-fail-after-backup.txt"))
                .expect("read preserved failure file"),
            "pending failure\n"
        );
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_restore_never_overwrites_an_existing_backup_artifact() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        fs::write(project_path.join("file.txt"), "accepted\n").expect("write accepted file");
        ensure_direct_checkpoint_head(&repo).expect("capture baseline");
        fs::write(project_path.join("file.txt"), "pending\n").expect("write pending file");
        let existing_backup = project_path.join(".file.txt.macro-restore-backup-existing");
        fs::write(&existing_backup, "older preserved data\n").expect("write existing backup");

        restore_direct_worktree_paths(&repo, &project_path, vec!["file.txt".to_string()])
            .expect("restore file");

        assert_eq!(
            fs::read_to_string(existing_backup).expect("read existing backup"),
            "older preserved data\n"
        );
        assert_eq!(
            fs::read_to_string(project_path.join("file.txt")).expect("read restored file"),
            "accepted\n"
        );
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_restore_retains_pending_data_when_backup_cleanup_fails() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        let file_name = "macro-test-keep-backup-on-cleanup-failure.txt";
        fs::write(project_path.join(file_name), "accepted\n").expect("write accepted file");
        let accepted_head = ensure_direct_checkpoint_head(&repo).expect("capture baseline");
        fs::write(project_path.join(file_name), "pending\n").expect("write pending file");

        restore_direct_worktree_paths(&repo, &project_path, vec![file_name.to_string()])
            .expect("cleanup failure must not turn a completed restore into data loss");

        assert_eq!(
            fs::read_to_string(project_path.join(file_name)).expect("read restored file"),
            "accepted\n"
        );
        let retained = fs::read_dir(&project_path)
            .expect("read project")
            .filter_map(|entry| entry.ok())
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .contains("macro-restore-backup")
            })
            .expect("pending data backup must remain recoverable");
        assert_eq!(
            fs::read_to_string(retained.path()).expect("read retained backup"),
            "pending\n"
        );
        assert_eq!(
            repo.head().expect("head").target().map(|id| id.to_string()),
            Some(accepted_head)
        );
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_restore_never_recursively_removes_a_replaced_backup_artifact() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        let file_name = "macro-test-concurrent-backup-cleanup.txt";
        fs::write(project_path.join(file_name), "accepted\n").expect("accepted file");
        ensure_direct_checkpoint_head(&repo).expect("baseline");
        fs::write(project_path.join(file_name), "pending\n").expect("pending file");

        restore_direct_worktree_paths(&repo, &project_path, vec![file_name.to_string()])
            .expect("cleanup conflict must not undo the completed restore");

        assert_eq!(
            fs::read_to_string(project_path.join(file_name)).expect("restored file"),
            "accepted\n"
        );
        assert!(fs::read_dir(&project_path)
            .expect("project entries")
            .filter_map(|entry| entry.ok())
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .contains("macro-restore-backup")
                && entry.path().join("keep.txt").is_file()));
        assert!(!project_path.join(".git").exists());
    }

    #[test]
    fn direct_restore_of_an_absent_untracked_path_does_not_create_parent_directories() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        fs::write(project_path.join("kept.txt"), "unchanged\n").expect("write user file");
        ensure_direct_checkpoint_head(&repo).expect("capture baseline");

        restore_direct_worktree_paths(&repo, &project_path, vec!["absent/nested.txt".to_string()])
            .expect("an already absent path is a no-op");

        assert!(!project_path.join("absent").exists());
        assert_eq!(
            fs::read_to_string(project_path.join("kept.txt")).expect("read user file"),
            "unchanged\n"
        );
        assert!(!project_path.join(".git").exists());
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

        let capability =
            open_direct_restore_capability(&project_path).expect("retain project root");
        let error = remove_direct_untracked_path(
            &capability,
            Path::new("linked/secret.txt"),
            "linked/secret.txt",
        )
        .expect_err("outside target must be rejected");

        assert!(!error.to_string().is_empty());
        assert_eq!(
            fs::read_to_string(outside_path.join("secret.txt")).expect("read outside file"),
            "keep me"
        );
    }

    #[test]
    fn direct_restore_never_checks_out_a_tracked_file_through_a_linked_parent() {
        let (_temp, project_path, repo) = init_direct_checkpoint();
        let tracked_parent = project_path.join("tracked");
        fs::create_dir_all(&tracked_parent).expect("create tracked parent");
        fs::write(tracked_parent.join("file.txt"), "accepted\n").expect("write accepted file");
        ensure_direct_checkpoint_head(&repo).expect("capture accepted file");

        let outside_path = project_path
            .parent()
            .expect("project parent")
            .join("outside-restore");
        fs::create_dir_all(&outside_path).expect("create outside directory");
        fs::write(outside_path.join("file.txt"), "outside stays\n").expect("write outside file");
        fs::remove_dir_all(&tracked_parent).expect("remove tracked parent");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside_path, &tracked_parent)
            .expect("create tracked parent symlink");
        #[cfg(windows)]
        create_windows_junction(&tracked_parent, &outside_path);

        let error = restore_direct_worktree_paths(
            &repo,
            &project_path,
            vec!["tracked/file.txt".to_string()],
        )
        .expect_err("tracked restore must reject a linked parent");

        assert!(error.to_string().contains("linked parent"));
        assert_eq!(
            fs::read_to_string(outside_path.join("file.txt")).expect("read outside file"),
            "outside stays\n"
        );
        assert!(!project_path.join(".git").exists());
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
        let outside_hooks_path = temp
            .path()
            .parent()
            .expect("temp parent")
            .join("outside-hooks");
        for hooks_path in [
            outside_hooks_path.to_string_lossy().to_string(),
            "../outside-hooks".to_string(),
            temp.path()
                .join("hooks/../../outside-hooks")
                .to_string_lossy()
                .to_string(),
        ] {
            repo.config()
                .expect("repo config")
                .set_str("core.hooksPath", &hooks_path)
                .expect("set hooks path");

            let error = match run_git_command(temp.path(), &["status".to_string()]) {
                Ok(_) => panic!("unsafe hooks path must be rejected: {hooks_path}"),
                Err(error) => error,
            };

            assert!(error.to_string().contains("core.hooksPath"));
        }
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
    fn test_task_start_points_separate_external_worktrees_and_free_branches() {
        let (temp, repo) = init_repo();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature/external", &head, false).unwrap();
        repo.branch("feature/internal", &head, false).unwrap();
        repo.branch("feature/free", &head, false).unwrap();
        repo.branch(MACRO_BRANCH_NAME, &head, false).unwrap();

        let external_path = temp.path().join("external-worktree");
        let external_ref = repo.find_reference("refs/heads/feature/external").unwrap();
        let mut external_options = git2::WorktreeAddOptions::new();
        external_options.reference(Some(&external_ref));
        repo.worktree("external", &external_path, Some(&external_options))
            .unwrap();

        let internal_root = temp.path().join(".macro").join("worktrees");
        fs::create_dir_all(&internal_root).unwrap();
        let internal_ref = repo.find_reference("refs/heads/feature/internal").unwrap();
        let mut internal_options = git2::WorktreeAddOptions::new();
        internal_options.reference(Some(&internal_ref));
        repo.worktree(
            "internal",
            &internal_root.join("task-internal"),
            Some(&internal_options),
        )
        .unwrap();

        let metadata_ref = repo
            .find_reference(&format!("refs/heads/{MACRO_BRANCH_NAME}"))
            .unwrap();
        let mut metadata_options = git2::WorktreeAddOptions::new();
        metadata_options.reference(Some(&metadata_ref));
        repo.worktree(
            "macro-metadata",
            &repo.path().join(MACRO_WORKTREE_DIR_NAME),
            Some(&metadata_options),
        )
        .unwrap();

        let start_points = build_git_task_start_points(&repo).unwrap();
        assert_eq!(start_points.worktrees.len(), 1);
        assert_eq!(start_points.worktrees[0].branch_name, "feature/external");
        assert_eq!(
            start_points
                .branches
                .iter()
                .map(|branch| branch.name.as_str())
                .collect::<Vec<_>>(),
            vec!["feature/free"]
        );
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
