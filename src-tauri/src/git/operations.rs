use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(test)]
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cap_std::ambient_authority;
use cap_std::fs::Dir as CapabilityDir;
#[cfg(windows)]
use cap_std::fs::OpenOptions as CapabilityOpenOptions;
use chrono::{DateTime, Utc};
use git2::{
    BranchType, CheckoutNotificationType, Commit, DiffFormat, DiffStatsFormat, Oid, Repository,
    RepositoryState, ResetType, StashFlags, Status, StatusEntry, TreeWalkMode, TreeWalkResult,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::core::error::{BackendError, Result};
use crate::core::process::{
    background_command, background_contained_tokio_command, ContainedBackgroundProcess,
};
use crate::fs::{normalize_path, validate_path};
use crate::git::repo::{get_branch_name, get_head_commit, get_status, get_status_options};
use crate::project_path::{
    parse_wsl_unc_path, run_wsl_command_allow_failure, run_wsl_git_allow_failure,
    run_wsl_git_bounded_allow_failure, WslCommandOutput, WslProjectPath,
};

pub(crate) const DEFAULT_REMOTE_NAME: &str = "origin";
const GENERIC_CONVENTIONAL_COMMIT_MESSAGE: &str =
    "Commit message must follow Conventional Commits: type: subject";
pub(crate) const WSL_GIT_TIMEOUT: Duration = Duration::from_secs(8);
pub(crate) const WSL_GIT_MUTATION_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const NATIVE_GIT_NETWORK_TIMEOUT: Duration = Duration::from_secs(30);
const GIT_COMMAND_OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_GIT_COMMAND_OUTPUT_BYTES: u64 = 256 * 1024;
static HARD_RESET_CHECKOUT_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, ts_rs::TS)]
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

#[derive(Serialize, ts_rs::TS)]
pub struct GitFileStatus {
    pub path: String,
    pub status: String,
    pub old_path: Option<String>,
}

#[derive(Serialize, ts_rs::TS)]
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

#[derive(Debug, Clone)]
pub(crate) struct GitLogSnapshot {
    pub revision: String,
    pub(crate) tip: Option<String>,
    pub(crate) has_staged: bool,
    pub(crate) has_unstaged: bool,
}

#[derive(Serialize, ts_rs::TS)]
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

#[derive(Serialize, ts_rs::TS)]
pub struct PredictedGitTreeDto {
    pub branch: String,
    pub structure: Vec<GitNode>,
    pub modified_files_count: u32,
}

#[derive(Serialize, Clone, ts_rs::TS)]
pub struct GitNode {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub status: Option<String>,
    pub children: Option<Vec<GitNode>>,
    pub hash: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
#[derive(ts_rs::TS)]
pub struct GitMergeCheckDto {
    pub mergeable: bool,
    pub conflict_files: Vec<String>,
    pub has_changes: bool,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[derive(ts_rs::TS)]
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
#[derive(ts_rs::TS)]
pub struct GitStartMergeResolutionDto {
    pub status: String,
    pub conflict_files: Vec<String>,
    pub output: String,
}

pub(crate) fn to_join_error(err: tokio::task::JoinError) -> BackendError {
    BackendError::Internal {
        message: format!("Git task join error: {}", err),
    }
}

pub(crate) struct GitCommandOutput {
    pub(crate) success: bool,
    pub(crate) code: Option<i32>,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

pub(crate) fn run_git_command(cwd: &Path, args: &[String]) -> Result<GitCommandOutput> {
    run_git_command_with_reflog_action(cwd, args, None)
}

fn run_git_command_with_reflog_action(
    cwd: &Path,
    args: &[String],
    reflog_action: Option<&str>,
) -> Result<GitCommandOutput> {
    let repo = Repository::discover(cwd)?;
    ensure_safe_config(&repo)?;

    let mut command = background_command("git");
    command
        .env_clear()
        .envs(std::env::vars_os().filter(|(key, _)| !is_git_environment_variable(key.as_os_str())));
    if let Some(action) = reflog_action {
        command.env("GIT_REFLOG_ACTION", action);
    }
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

pub(crate) fn run_git_command_with_timeout(
    cwd: &Path,
    args: &[String],
    timeout_duration: Duration,
) -> Result<GitCommandOutput> {
    run_contained_git_command_with_timeout(cwd, args, timeout_duration, false)
}

pub(crate) fn is_git_environment_variable(key: &OsStr) -> bool {
    key.to_string_lossy()
        .to_ascii_uppercase()
        .starts_with("GIT_")
}

pub(crate) fn command_output_text(output: &GitCommandOutput) -> String {
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

pub(crate) fn run_contained_git_command_with_timeout(
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

pub(crate) fn run_contained_git_command_with_timeout_and_cancellation(
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

pub(crate) fn configure_noninteractive_git_command(command: &mut tokio::process::Command) {
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

pub(crate) fn wsl_output_text(output: &WslCommandOutput) -> String {
    let stdout = output.stdout_text();
    let stderr = output.stderr_text();
    match (stdout.is_empty(), stderr.is_empty()) {
        (true, true) => String::new(),
        (false, true) => stdout,
        (true, false) => stderr,
        (false, false) => format!("{}\n{}", stdout, stderr),
    }
}

pub(crate) fn wsl_git_failure(output: &WslCommandOutput, fallback: &str) -> BackendError {
    let details = wsl_output_text(output);
    BackendError::Git {
        message: if details.is_empty() {
            fallback.to_string()
        } else {
            details
        },
    }
}

pub(crate) async fn run_wsl_git_checked(
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

pub(crate) fn validate_git_cli_operand(value: &str, label: &str) -> Result<()> {
    if value.is_empty() || value.starts_with('-') || value.chars().any(char::is_control) {
        return Err(BackendError::Validation(format!(
            "Invalid {label}: Git option-like and control-character values are not allowed"
        )));
    }
    Ok(())
}

pub(crate) async fn wsl_resolve_commit_oid(
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

pub(crate) struct ParsedWslPorcelainStatus {
    pub(crate) branch: String,
    pub(crate) staged_files: Vec<GitFileStatus>,
    pub(crate) unstaged_files: Vec<GitFileStatus>,
    pub(crate) untracked_files: Vec<GitFileStatus>,
    pub(crate) conflicted_files: Vec<String>,
}

pub(crate) fn parse_wsl_porcelain_v1_z(stdout: &[u8]) -> ParsedWslPorcelainStatus {
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

/// Paginate the concatenated local-then-remote branch listing without masking
/// failures: each source list was produced by its own checked command and is
/// already clamped to `offset + limit + 1` entries, so a full clamped list
/// proves at least one entry remains beyond the requested window.
pub(crate) fn paginate_wsl_branch_refs(
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

pub(crate) fn parse_wsl_branch_ref_lines(stdout: String) -> Vec<(String, String)> {
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
    } else {
        let staged = run_wsl_git_allow_failure(
            repo_path,
            &[
                "diff".to_string(),
                "--cached".to_string(),
                "--quiet".to_string(),
            ],
            WSL_GIT_TIMEOUT,
        )
        .await?;
        match staged.status.code() {
            Some(0) => {
                return Err(BackendError::Git {
                    message: "No staged changes to commit".to_string(),
                })
            }
            Some(1) => {}
            _ => return Err(wsl_git_failure(&staged, "git staged diff WSL failed")),
        }
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
        Some(commit) => wsl_resolve_commit_oid(repo_path, &commit, "reset commit").await?,
        None => wsl_resolve_commit_oid(repo_path, "HEAD", "reset commit").await?,
    };
    if reset_mode == "hard" {
        return wsl_hard_reset_preserving_untracked(repo_path, &resolved_commit).await;
    }
    let mut args = vec!["reset".to_string(), format!("--{}", reset_mode)];
    args.push(resolved_commit);
    run_wsl_git_checked(
        repo_path,
        &args,
        WSL_GIT_MUTATION_TIMEOUT,
        "git reset WSL failed",
    )
    .await?;
    Ok(())
}

fn normalize_git_path(path: &[u8]) -> Vec<u8> {
    let end = path
        .iter()
        .rposition(|byte| *byte != b'/')
        .map_or(0, |index| index + 1);
    path[..end].to_vec()
}

fn git_path_prefixes(path: &[u8]) -> Vec<&[u8]> {
    let mut prefixes = Vec::new();
    let mut end = path.len();
    loop {
        prefixes.push(&path[..end]);
        let Some(separator) = path[..end].iter().rposition(|byte| *byte == b'/') else {
            break;
        };
        end = separator;
    }
    prefixes
}

fn untracked_reset_collision_error(path: &[u8]) -> BackendError {
    BackendError::Git {
        message: format!(
            "Hard reset would overwrite untracked path '{}'; move or remove it before retrying",
            String::from_utf8_lossy(path)
        ),
    }
}

async fn wsl_hard_reset_preserving_untracked(
    repo_path: &WslProjectPath,
    target_commit: &str,
) -> Result<()> {
    const COLLISION_EXIT_CODE: i32 = 42;
    let hard_reset = run_wsl_command_allow_failure(
        repo_path,
        "bash",
        &[
            "-c".to_string(),
            r#"
set -u
repo=$1
target_commit=$2
git_common_dir=$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir) || exit $?
recovery_root=$git_common_dir/macro-hard-reset-recovery
if [[ -L $recovery_root ]]; then
  printf 'Hard reset recovery root must not be a symbolic link: %s\n' "$recovery_root" >&2
  exit 43
fi
mkdir -p -- "$recovery_root" || exit $?
scratch=$(mktemp -d "$recovery_root/transaction.XXXXXXXX") || exit $?
mkdir -- "$scratch/original" "$scratch/rollback-target" || exit $?
scratch_dev=$(stat -c '%d' -- "$scratch") || exit $?
repo_dev=$(stat -c '%d' -- "$repo") || exit $?
if [[ $scratch_dev != "$repo_dev" ]]; then
  printf 'Hard reset recovery storage must be on the worktree filesystem.\n' >&2
  rm -rf -- "$scratch"
  exit 43
fi
if mv --help 2>/dev/null | grep -q -- '--no-copy'; then
  safe_mv() { mv --no-copy -T -n -- "$1" "$2"; }
else
  safe_mv() {
    source_dev=$(stat -c '%d' -- "$1") || return 1
    destination_dev=$(stat -c '%d' -- "${2%/*}") || return 1
    [[ $source_dev == "$destination_dev" ]] || return 1
    mv -T -n -- "$1" "$2"
  }
fi
mutation_started=0
transaction_complete=0
keep_scratch=0
declare -a isolated_paths=()
declare -a isolated_names=()
declare -a isolated_ids=()
declare -a materialized_paths=()
declare -a materialized_ids=()

rollback_reset() {
  rollback_failed=0
  for (( rollback_index=${#materialized_paths[@]} - 1; rollback_index >= 0; rollback_index-- )); do
    materialized=${materialized_paths[$rollback_index]}
    expected_id=${materialized_ids[$rollback_index]}
    current_id=$(stat -c '%d:%i' -- "$repo/$materialized" 2>/dev/null) || current_id=
    if [[ -n $expected_id && $current_id == "$expected_id" ]]; then
      # Keep the inode linked. A process may still hold a writable descriptor.
      rollback_path=$scratch/rollback-target/$materialized
      mkdir -p -- "${rollback_path%/*}" || rollback_failed=1
      safe_mv "$repo/$materialized" "$rollback_path" || rollback_failed=1
      if [[ -e $repo/$materialized || -L $repo/$materialized ]]; then
        rollback_failed=1
        continue
      fi
      keep_scratch=1
      isolated_id=$(stat -c '%d:%i' -- "$rollback_path" 2>/dev/null) || isolated_id=
      if [[ $isolated_id != "$expected_id" ]]; then
        safe_mv "$rollback_path" "$repo/$materialized" || rollback_failed=1
        rollback_failed=1
      fi
    elif [[ -n $current_id ]]; then
      rollback_failed=1
    fi
  done

  for (( rollback_index=${#isolated_paths[@]} - 1; rollback_index >= 0; rollback_index-- )); do
    indexed=${isolated_paths[$rollback_index]}
    quarantine=${isolated_names[$rollback_index]}
    expected_id=${isolated_ids[$rollback_index]}
    quarantine_id=$(stat -c '%d:%i' -- "$quarantine" 2>/dev/null) || quarantine_id=
    original_id=$(stat -c '%d:%i' -- "$repo/$indexed" 2>/dev/null) || original_id=
    if [[ -n $quarantine_id ]]; then
      if [[ $quarantine_id != "$expected_id" || -n $original_id ]]; then
        rollback_failed=1
        continue
      fi
      safe_mv "$quarantine" "$repo/$indexed" || rollback_failed=1
      restored_id=$(stat -c '%d:%i' -- "$repo/$indexed" 2>/dev/null) || restored_id=
      if [[ -e $quarantine || -L $quarantine || $restored_id != "$expected_id" ]]; then
        rollback_failed=1
      fi
    elif [[ -z $original_id ]]; then
      rollback_failed=1
    fi
  done

  if [[ -n ${original_head-} ]]; then
    if [[ -n ${original_head_ref-} ]]; then
      current_head_ref=$(git -C "$repo" symbolic-ref -q HEAD 2>/dev/null) || current_head_ref=
      if [[ $current_head_ref != "$original_head_ref" ]]; then
        rollback_failed=1
      fi
      current_ref=$(git -C "$repo" rev-parse "$original_head_ref" 2>/dev/null) || current_ref=
      if [[ $current_ref == "$target_commit" ]]; then
        git -C "$repo" update-ref "$original_head_ref" "$original_head" "$target_commit" >/dev/null 2>&1 || rollback_failed=1
      elif [[ $current_ref != "$original_head" ]]; then
        rollback_failed=1
      fi
    else
      current_head_ref=$(git -C "$repo" symbolic-ref -q HEAD 2>/dev/null) || current_head_ref=
      current_ref=$(git -C "$repo" rev-parse HEAD 2>/dev/null) || current_ref=
      if [[ -n $current_head_ref ]]; then
        rollback_failed=1
      elif [[ $current_ref == "$target_commit" ]]; then
        git -C "$repo" update-ref --no-deref HEAD "$original_head" "$target_commit" >/dev/null 2>&1 || rollback_failed=1
      elif [[ $current_ref != "$original_head" ]]; then
        rollback_failed=1
      fi
    fi
  fi

  if [[ -n ${index_path-} && -f $scratch/index.backup ]]; then
    index_lock=$index_path.lock
    if ( set -C; : > "$index_lock" ) 2>/dev/null; then
      if cmp -s -- "$index_path" "$scratch/index.backup"; then
        rm -f -- "$index_lock" || rollback_failed=1
      elif [[ -f $scratch/index.expected ]] && cmp -s -- "$index_path" "$scratch/index.expected"; then
        if cat -- "$scratch/index.backup" > "$index_lock" && chmod --reference="$scratch/index.backup" "$index_lock"; then
          mv -f -- "$index_lock" "$index_path" || rollback_failed=1
        else
          rm -f -- "$index_lock"
          rollback_failed=1
        fi
      else
        cp -- "$index_path" "$scratch/index.concurrent" 2>/dev/null || true
        rm -f -- "$index_lock"
        rollback_failed=1
      fi
    else
      rollback_failed=1
    fi
  fi
  if (( rollback_failed != 0 )); then
    keep_scratch=1
    printf 'Hard reset rollback data retained at %s\n' "$scratch" >&2
    return 1
  fi
}

cleanup_reset() {
  original_status=$?
  trap - EXIT
  if (( mutation_started != 0 && transaction_complete == 0 )); then
    rollback_reset || original_status=1
  fi
  if (( keep_scratch == 0 )); then
    rm -rf -- "$scratch"
  fi
  exit "$original_status"
}
trap cleanup_reset EXIT

git -C "$repo" ls-files --others --exclude-standard -z > "$scratch/untracked" || exit $?
git -C "$repo" ls-files --others --ignored --exclude-standard -z >> "$scratch/untracked" || exit $?
git -C "$repo" ls-files -z > "$scratch/indexed" || exit $?
git -C "$repo" ls-tree -r -z "$target_commit" > "$scratch/target-records" || exit $?
: > "$scratch/target"
while IFS= read -r -d '' target_record; do
  target=${target_record#*$'\t'}
  printf '%s\0' "$target" >> "$scratch/target"
done < "$scratch/target-records"
mapfile -d '' -t untracked_paths < "$scratch/untracked"
mapfile -d '' -t target_paths < "$scratch/target"

declare -A target_full_paths=()
declare -A target_prefix_paths=()
declare -A target_full_inodes=()
declare -A target_prefix_inodes=()

for target in "${target_paths[@]}"; do
  target_full_paths["$target"]=1
  target_prefix=$target
  first_prefix=1
  while true; do
    if [[ -z ${target_prefix_paths["$target_prefix"]+present} ]]; then
      target_prefix_paths["$target_prefix"]=1
      prefix_id=$(stat -c '%d:%i' -- "$repo/$target_prefix" 2>/dev/null) || prefix_id=
      if [[ -n $prefix_id ]]; then
        target_prefix_inodes["$prefix_id"]=1
      fi
    elif (( first_prefix == 0 )); then
      break
    fi
    if (( first_prefix == 1 )); then
      first_prefix=0
      target_id=$(stat -c '%d:%i' -- "$repo/$target" 2>/dev/null) || target_id=
      if [[ -n $target_id ]]; then
        target_full_inodes["$target_id"]=1
      fi
    fi
    if [[ $target_prefix != */* ]]; then
      break
    fi
    target_prefix=${target_prefix%/*}
  done
done

for untracked in "${untracked_paths[@]}"; do
  untracked_id=$(stat -c '%d:%i' -- "$repo/$untracked" 2>/dev/null) || untracked_id=
  if [[ -n ${target_prefix_paths["$untracked"]+present}
        || ( -n $untracked_id && -n ${target_prefix_inodes["$untracked_id"]+present} ) ]]; then
    printf '%s\0' "$untracked"
    exit 42
  fi

  untracked_prefix=$untracked
  while true; do
    prefix_id=$(stat -c '%d:%i' -- "$repo/$untracked_prefix" 2>/dev/null) || prefix_id=
    if [[ -n ${target_full_paths["$untracked_prefix"]+present}
          || ( -n $prefix_id && -n ${target_full_inodes["$prefix_id"]+present} ) ]]; then
      printf '%s\0' "$untracked"
      exit 42
    fi
    if [[ $untracked_prefix != */* ]]; then
      break
    fi
    untracked_prefix=${untracked_prefix%/*}
  done
done

original_head=$(git -C "$repo" rev-parse HEAD) || exit $?
original_head_ref=$(git -C "$repo" symbolic-ref -q HEAD 2>/dev/null) || original_head_ref=
index_path=$(git -C "$repo" rev-parse --path-format=absolute --git-path index) || exit $?
cp -- "$index_path" "$scratch/index.backup" || exit $?

mutation_started=1
while IFS= read -r -d '' indexed; do
  indexed_path=$repo/$indexed
  if [[ -L $indexed_path || -f $indexed_path ]]; then
    expected_id=$(stat -c '%d:%i' -- "$indexed_path") || exit $?
    expected_oid=$(git -C "$repo" hash-object --no-filters -- "$indexed_path") || exit $?
    # A copy is insufficient because an already-open descriptor can write later.
    quarantine=$scratch/original/$indexed
    mkdir -p -- "${quarantine%/*}" || exit $?
    safe_mv "$indexed_path" "$quarantine" || exit $?
    if [[ -e $indexed_path || -L $indexed_path ]]; then
      printf 'Hard reset could not reserve an isolated backup path for: %s\n' "$indexed" >&2
      exit 43
    fi
    keep_scratch=1
    isolated_id=$(stat -c '%d:%i' -- "$quarantine" 2>/dev/null) || isolated_id=
    isolated_oid=$(git -C "$repo" hash-object --no-filters -- "$quarantine" 2>/dev/null) || isolated_oid=
    isolated_paths+=("$indexed")
    isolated_names+=("$quarantine")
    isolated_ids+=("$isolated_id")
    if [[ -z $isolated_id || $isolated_id != "$expected_id" || $isolated_oid != "$expected_oid" ]]; then
      printf 'Hard reset refused a concurrently replaced tracked path: %s\n' "$indexed" >&2
      exit 43
    fi
  fi
done < "$scratch/indexed"

rm -f -- "$scratch/index.expected"
GIT_INDEX_FILE="$scratch/index.expected" git -C "$repo" read-tree --reset "$target_commit" || exit $?
for target in "${target_paths[@]}"; do
  if ! GIT_INDEX_FILE="$scratch/index.expected" git -C "$repo" checkout-index -- "$target"; then
    materialized_id=$(stat -c '%d:%i' -- "$repo/$target" 2>/dev/null) || materialized_id=
    if [[ -n $materialized_id ]]; then
      materialized_paths+=("$target")
      materialized_ids+=("$materialized_id")
    fi
    exit 1
  fi
  materialized_paths+=("$target")
  materialized_id=$(stat -c '%d:%i' -- "$repo/$target" 2>/dev/null) || materialized_id=
  materialized_ids+=("$materialized_id")
done

index_lock=$index_path.lock
if ! ( set -C; : > "$index_lock" ) 2>/dev/null; then
  printf 'Hard reset could not reserve the Git index lock: %s\n' "$index_lock" >&2
  exit 43
fi
if ! cmp -s -- "$index_path" "$scratch/index.backup"; then
  cp -- "$index_path" "$scratch/index.concurrent" 2>/dev/null || true
  rm -f -- "$index_lock"
  printf 'Hard reset refused to overwrite a concurrently modified Git index.\n' >&2
  exit 43
fi
if ! cat -- "$scratch/index.expected" > "$index_lock" || ! chmod --reference="$scratch/index.backup" "$index_lock"; then
  rm -f -- "$index_lock"
  exit 1
fi

current_head_ref=$(git -C "$repo" symbolic-ref -q HEAD 2>/dev/null) || current_head_ref=
if [[ -n $original_head_ref ]]; then
  if [[ $current_head_ref != "$original_head_ref" ]] \
      || ! git -C "$repo" update-ref "$original_head_ref" "$target_commit" "$original_head"; then
    rm -f -- "$index_lock"
    printf 'Hard reset refused a concurrent HEAD update.\n' >&2
    exit 43
  fi
else
  current_ref=$(git -C "$repo" rev-parse HEAD 2>/dev/null) || current_ref=
  if [[ -n $current_head_ref || $current_ref != "$original_head" ]] \
      || ! git -C "$repo" update-ref --no-deref HEAD "$target_commit" "$original_head"; then
    rm -f -- "$index_lock"
    printf 'Hard reset refused a concurrent detached HEAD update.\n' >&2
    exit 43
  fi
fi
if ! mv -f -- "$index_lock" "$index_path"; then
  rm -f -- "$index_lock"
  exit 1
fi

printf 'state=complete\ntarget=%s\n' "$target_commit" > "$scratch/recovery-state.txt" || exit $?
transaction_complete=1
"#
            .to_string(),
            "macro-git-hard-reset".to_string(),
            repo_path.linux_path.clone(),
            target_commit.to_string(),
        ],
        WSL_GIT_MUTATION_TIMEOUT,
    )
    .await?;

    match hard_reset.status.code() {
        Some(0) => Ok(()),
        Some(COLLISION_EXIT_CODE) => {
            let path = hard_reset
                .stdout
                .split(|byte| *byte == 0)
                .next()
                .unwrap_or_default();
            Err(untracked_reset_collision_error(path))
        }
        _ => Err(wsl_git_failure(&hard_reset, "git hard reset WSL failed")),
    }
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

pub(crate) async fn wsl_current_branch(repo_path: &WslProjectPath) -> Result<Option<String>> {
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

pub(crate) fn wsl_git_diff_with_untracked_script() -> &'static str {
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

pub(crate) fn wsl_diff_range(base: Option<&str>, head: Option<&str>) -> Option<String> {
    match (base, head) {
        (Some(base), Some(head)) => Some(format!("{}..{}", base, head)),
        (Some(base), None) => Some(base.to_string()),
        (None, Some(head)) => Some(format!("HEAD..{}", head)),
        (None, None) => None,
    }
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

pub(crate) fn wsl_git_tree_page_script() -> &'static str {
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

pub(crate) fn unsupported_wsl_git_operation(name: &str) -> BackendError {
    BackendError::Git {
        message: format!(
            "L'opération Git WSL '{}' n'est pas encore prise en charge sans fallback Windows.",
            name
        ),
    }
}

pub(crate) fn is_merge_in_progress(repo: &Repository) -> bool {
    repo.path().join("MERGE_HEAD").exists()
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

pub(crate) fn validate_branch_name(branch: &str) -> Result<()> {
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

pub(crate) fn short_hash(oid: Oid) -> String {
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

pub(crate) fn validate_refspec(spec: &str) -> Result<()> {
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

pub(crate) fn validate_commit_message(message: &str) -> Result<()> {
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

pub(crate) fn ensure_safe_config(repo: &Repository) -> Result<()> {
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

pub(crate) fn repo_root(repo: &Repository) -> Result<PathBuf> {
    repo.workdir()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| BackendError::Git {
            message: "Bare repositories are not supported".to_string(),
        })
}

pub(crate) fn to_repo_relative(repo_root: &Path, path: &Path) -> Result<PathBuf> {
    path.strip_prefix(repo_root)
        .map(|p| p.to_path_buf())
        .map_err(|_| BackendError::FilesystemPathOutsideWorkspace {
            message: format!("Path is outside repository: {}", path.display()),
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

// Expand only renames from the layer being changed. An index rename must not
// cause staging an unrelated pending edit at its old path (and vice versa).
pub(crate) fn mutation_paths(
    repo: &Repository,
    paths: &[String],
    staged: bool,
) -> Result<Vec<String>> {
    let root = repo_root(repo)?;
    let mut index = repo.index()?;
    index.read(true)?;
    let mut selected = Vec::new();
    for input in paths {
        let absolute = if Path::new(input).is_absolute() {
            PathBuf::from(input)
        } else {
            root.join(input)
        };
        let relative = to_repo_relative(&root, &absolute)?;
        let relative: PathBuf = relative
            .components()
            .filter(|component| !matches!(component, std::path::Component::CurDir))
            .collect();
        let relative = if relative.as_os_str().is_empty() {
            PathBuf::from(".")
        } else {
            relative
        };
        // Review paths are literal, including deleted names containing glob
        // characters. Retain wildcard expansion only for unmatched stage inputs.
        if staged
            || absolute.symlink_metadata().is_ok()
            || index.get_path(&relative, 0).is_some()
            || head_contains_path(repo, &relative)?
        {
            selected.push(relative);
        } else {
            for candidate in expand_paths(&root, input)? {
                selected.push(to_repo_relative(&root, &candidate)?);
            }
        }
    }
    let statuses = repo.statuses(Some(&mut get_status_options()))?;
    let mut expanded = selected.clone();
    for entry in statuses.iter() {
        let delta = if staged {
            entry.head_to_index()
        } else {
            entry.index_to_workdir()
        };
        if let Some(delta) = delta.filter(|delta| delta.status() == git2::Delta::Renamed) {
            if let (Some(old), Some(new)) = (delta.old_file().path(), delta.new_file().path()) {
                if selected
                    .iter()
                    .any(|path| old.starts_with(path) || new.starts_with(path))
                {
                    expanded.push(old.to_path_buf());
                    expanded.push(new.to_path_buf());
                }
            }
        }
    }
    expanded.sort();
    expanded.dedup();
    Ok(expanded
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}

pub(crate) fn run_index_mutation(repo: &Repository, args: &[String]) -> Result<()> {
    // Git acquires index.lock before reading the index and holds it through
    // publication. Never write a cached libgit2 index over another tool's stage.
    let output = run_git_command(&repo_root(repo)?, args)?;
    if !output.success {
        return Err(BackendError::Git {
            message: command_output_text(&output),
        });
    }
    repo.index()?.read(true)?;
    Ok(())
}

pub(crate) fn add_paths(repo: &Repository, paths: &[String]) -> Result<()> {
    if paths.is_empty() {
        return Err(BackendError::Git {
            message: "No paths were provided to stage".to_string(),
        });
    }
    let paths = mutation_paths(repo, paths, false)?;
    let mut args = vec![
        "--literal-pathspecs".into(),
        "add".into(),
        "-A".into(),
        "--".into(),
    ];
    args.extend(paths);
    run_index_mutation(repo, &args)
}

pub(crate) fn head_contains_path(repo: &Repository, path: &Path) -> Result<bool> {
    let Some(head_commit) = get_head_commit(repo)? else {
        return Ok(false);
    };
    let tree = head_commit.tree()?;
    match tree.get_path(path) {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

fn native_target_tree_paths(target: &Commit<'_>) -> Result<Vec<Vec<u8>>> {
    let tree = target.tree()?;
    let mut paths = Vec::new();
    tree.walk(TreeWalkMode::PreOrder, |root, entry| {
        if entry.kind() == Some(git2::ObjectType::Tree) {
            return TreeWalkResult::Ok;
        }
        let mut path = root.as_bytes().to_vec();
        path.extend_from_slice(entry.name_bytes());
        paths.push(path);
        TreeWalkResult::Ok
    })?;
    Ok(paths)
}

fn native_untracked_paths(repo: &Repository) -> Result<Vec<Vec<u8>>> {
    let mut options = get_status_options();
    options.include_ignored(true).recurse_ignored_dirs(true);
    let statuses = repo.statuses(Some(&mut options))?;
    Ok(statuses
        .iter()
        .filter(|entry| entry.status().is_wt_new() || entry.status().is_ignored())
        .map(|entry| normalize_git_path(entry.path_bytes()))
        .collect())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct NativeFileIdentity {
    pub(crate) volume: u64,
    pub(crate) file: u64,
}

#[cfg(unix)]
fn native_path_identity(path: &Path) -> Option<NativeFileIdentity> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::symlink_metadata(path).ok()?;
    Some(NativeFileIdentity {
        volume: metadata.dev(),
        file: metadata.ino(),
    })
}

#[cfg(windows)]
fn native_path_identity(path: &Path) -> Option<NativeFileIdentity> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    let mut wide_path = path.as_os_str().encode_wide().collect::<Vec<_>>();
    wide_path.push(0);
    let handle = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return None;
    }
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    let succeeded = unsafe { GetFileInformationByHandle(handle, &mut information) } != 0;
    unsafe {
        CloseHandle(handle);
    }
    if !succeeded {
        return None;
    }

    Some(NativeFileIdentity {
        volume: u64::from(information.dwVolumeSerialNumber),
        file: (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
    })
}

#[cfg(not(any(unix, windows)))]
fn native_path_identity(_path: &Path) -> Option<NativeFileIdentity> {
    None
}

#[cfg(unix)]
fn native_git_path(path: &[u8]) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    Some(PathBuf::from(OsStr::from_bytes(path)))
}

#[cfg(windows)]
fn native_git_path(path: &[u8]) -> Option<PathBuf> {
    std::str::from_utf8(path).ok().map(PathBuf::from)
}

#[cfg(not(any(unix, windows)))]
fn native_git_path(path: &[u8]) -> Option<PathBuf> {
    std::str::from_utf8(path).ok().map(PathBuf::from)
}

fn native_git_path_identity(repo_root: &Path, path: &[u8]) -> Option<NativeFileIdentity> {
    let relative = native_git_path(path)?;
    native_path_identity(&repo_root.join(relative))
}

fn find_native_untracked_reset_collision(
    repo_root: &Path,
    untracked_paths: &[Vec<u8>],
    target_paths: &[Vec<u8>],
) -> Option<Vec<u8>> {
    let mut target_full_paths = HashSet::new();
    let mut target_prefix_paths = HashSet::new();
    let mut target_full_identities = HashSet::new();
    let mut target_prefix_identities = HashSet::new();

    for target in target_paths {
        target_full_paths.insert(target.clone());
        if let Some(identity) = native_git_path_identity(repo_root, target) {
            target_full_identities.insert(identity);
        }
        for prefix in git_path_prefixes(target) {
            if target_prefix_paths.insert(prefix.to_vec()) {
                if let Some(identity) = native_git_path_identity(repo_root, prefix) {
                    target_prefix_identities.insert(identity);
                }
            }
        }
    }

    untracked_paths.iter().find_map(|untracked| {
        let untracked_identity = native_git_path_identity(repo_root, untracked);
        if target_prefix_paths.contains(untracked)
            || untracked_identity
                .is_some_and(|identity| target_prefix_identities.contains(&identity))
        {
            return Some(untracked.clone());
        }

        git_path_prefixes(untracked)
            .into_iter()
            .any(|prefix| {
                target_full_paths.contains(prefix)
                    || native_git_path_identity(repo_root, prefix)
                        .is_some_and(|identity| target_full_identities.contains(&identity))
            })
            .then(|| untracked.clone())
    })
}

fn ensure_native_hard_reset_preserves_untracked(
    repo: &Repository,
    target: &Commit<'_>,
) -> Result<()> {
    let Some(repo_root) = repo.workdir() else {
        return Ok(());
    };
    let untracked_paths = native_untracked_paths(repo)?;
    let target_paths = native_target_tree_paths(target)?;
    if let Some(path) =
        find_native_untracked_reset_collision(repo_root, &untracked_paths, &target_paths)
    {
        return Err(untracked_reset_collision_error(&path));
    }
    Ok(())
}

#[cfg(test)]
type NativeHardResetTestHook = Box<dyn FnOnce() + Send>;

#[cfg(test)]
pub(crate) static NATIVE_HARD_RESET_AFTER_PREFLIGHT_HOOKS: OnceLock<
    Mutex<HashMap<PathBuf, NativeHardResetTestHook>>,
> = OnceLock::new();
#[cfg(test)]
pub(crate) static NATIVE_HARD_RESET_BEFORE_FINAL_RESET_HOOKS: OnceLock<
    Mutex<HashMap<PathBuf, NativeHardResetTestHook>>,
> = OnceLock::new();
#[cfg(test)]
pub(crate) static NATIVE_HARD_RESET_BEFORE_TRACKED_ISOLATION_HOOKS: OnceLock<
    Mutex<HashMap<PathBuf, NativeHardResetTestHook>>,
> = OnceLock::new();
#[cfg(test)]
pub(crate) static NATIVE_HARD_RESET_AFTER_TRACKED_ISOLATION_HOOKS: OnceLock<
    Mutex<HashMap<PathBuf, NativeHardResetTestHook>>,
> = OnceLock::new();

#[cfg(test)]
fn run_native_hard_reset_after_preflight_hook(repo_root: &Path) {
    let hook = NATIVE_HARD_RESET_AFTER_PREFLIGHT_HOOKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("lock hard reset test hooks")
        .remove(repo_root);
    if let Some(hook) = hook {
        hook();
    }
}

#[cfg(test)]
fn run_native_hard_reset_before_final_reset_hook(repo_root: &Path) -> bool {
    let hook = NATIVE_HARD_RESET_BEFORE_FINAL_RESET_HOOKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("lock hard reset final test hooks")
        .remove(repo_root);
    if let Some(hook) = hook {
        hook();
        true
    } else {
        false
    }
}

#[cfg(test)]
fn run_native_hard_reset_before_tracked_isolation_hook(repo_root: &Path) {
    let hook = NATIVE_HARD_RESET_BEFORE_TRACKED_ISOLATION_HOOKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("lock hard reset isolation test hooks")
        .remove(repo_root);
    if let Some(hook) = hook {
        hook();
    }
}

#[cfg(test)]
fn run_native_hard_reset_after_tracked_isolation_hook(repo_root: &Path) {
    let hook = NATIVE_HARD_RESET_AFTER_TRACKED_ISOLATION_HOOKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("lock hard reset post-isolation test hooks")
        .remove(repo_root);
    if let Some(hook) = hook {
        hook();
    }
}

#[cfg(not(test))]
fn run_native_hard_reset_after_preflight_hook(_repo_root: &Path) {}

#[cfg(not(test))]
fn run_native_hard_reset_before_final_reset_hook(_repo_root: &Path) -> bool {
    false
}

#[cfg(not(test))]
fn run_native_hard_reset_before_tracked_isolation_hook(_repo_root: &Path) {}

#[cfg(not(test))]
fn run_native_hard_reset_after_tracked_isolation_hook(_repo_root: &Path) {}

fn remove_native_indexed_worktree_entries(
    repo: &Repository,
    repo_root: &Path,
    target: &Commit<'_>,
    scratch: &NativeHardResetCheckoutScratch,
) -> Result<Vec<NativeHardResetBackup>> {
    let worktree =
        CapabilityDir::open_ambient_dir(repo_root, ambient_authority()).map_err(|error| {
            BackendError::Io {
                message: format!("Failed to open the hard reset worktree: {error}"),
                source: error,
            }
        })?;
    let target_tree = target.tree()?;
    let mut processed = HashSet::new();
    let mut backups = Vec::new();
    for entry in repo.index()?.iter() {
        let path = entry.path;
        if !processed.insert(path.clone()) {
            continue;
        }
        let relative = native_git_path(&path).ok_or_else(|| BackendError::Git {
            message: format!(
                "Hard reset cannot represent tracked path '{}'.",
                String::from_utf8_lossy(&path)
            ),
        })?;
        let target_matches_index = target_tree.get_path(&relative).is_ok_and(|target_entry| {
            target_entry.id() == entry.id && target_entry.filemode() as u32 == entry.mode
        });
        let worktree_is_clean = repo.status_file(&relative).is_ok_and(|status| {
            !status.intersects(
                Status::WT_NEW
                    | Status::WT_MODIFIED
                    | Status::WT_DELETED
                    | Status::WT_RENAMED
                    | Status::WT_TYPECHANGE
                    | Status::CONFLICTED,
            )
        });
        if target_matches_index && worktree_is_clean {
            continue;
        }
        let removal = remove_native_indexed_worktree_entry(
            &worktree,
            repo_root,
            &relative,
            &String::from_utf8_lossy(&path),
            scratch,
        );
        match removal {
            Ok(Some(backup)) => backups.push(backup),
            Ok(None) => {}
            Err(error) => {
                restore_native_hard_reset_backups(repo_root, scratch, &backups)?;
                return Err(error);
            }
        }
    }
    for path in native_target_tree_paths(target)? {
        if !processed.insert(path.clone()) {
            continue;
        }
        let relative = native_git_path(&path).ok_or_else(|| BackendError::Git {
            message: format!(
                "Hard reset cannot represent tracked path '{}'.",
                String::from_utf8_lossy(&path)
            ),
        })?;
        if fs::symlink_metadata(repo_root.join(&relative)).is_ok() {
            restore_native_hard_reset_backups(repo_root, scratch, &backups)?;
            return Err(untracked_reset_collision_error(&path));
        }
        backups.push(NativeHardResetBackup {
            relative,
            data: NativeHardResetBackupData::Absent,
        });
    }
    Ok(backups)
}

pub(crate) enum NativeHardResetBackupData {
    Absent,
    Preserved { identity: NativeFileIdentity },
}

pub(crate) struct NativeHardResetBackup {
    pub(crate) relative: PathBuf,
    pub(crate) data: NativeHardResetBackupData,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeEntryKind {
    File,
    Symlink,
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct NativeEntryFingerprint {
    pub(crate) kind: NativeEntryKind,
    pub(crate) digest: [u8; 32],
}

fn native_capability_entry_fingerprint(
    parent: &CapabilityDir,
    name: &OsStr,
    metadata: &cap_std::fs::Metadata,
    display_path: &str,
) -> Result<Option<NativeEntryFingerprint>> {
    if metadata.file_type().is_symlink() {
        let target = parent
            .read_link_contents(name)
            .map_err(|error| BackendError::Io {
                message: format!("Failed to inspect tracked link '{display_path}': {error}"),
                source: error,
            })?;
        return Ok(Some(NativeEntryFingerprint {
            kind: NativeEntryKind::Symlink,
            digest: Sha256::digest(native_symlink_target_bytes(&target)).into(),
        }));
    }
    if !metadata.is_file() {
        return Ok(None);
    }
    let mut file = parent.open(name).map_err(|error| BackendError::Io {
        message: format!("Failed to inspect tracked path '{display_path}': {error}"),
        source: error,
    })?;
    let opened_metadata = file.metadata().map_err(|error| BackendError::Io {
        message: format!("Failed to verify tracked path '{display_path}': {error}"),
        source: error,
    })?;
    if native_capability_identity(&opened_metadata) != native_capability_identity(metadata) {
        return Err(BackendError::Git {
            message: format!("Tracked path '{display_path}' changed while it was inspected"),
        });
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| BackendError::Io {
            message: format!("Failed to hash tracked path '{display_path}': {error}"),
            source: error,
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(Some(NativeEntryFingerprint {
        kind: NativeEntryKind::File,
        digest: hasher.finalize().into(),
    }))
}

fn remove_native_indexed_worktree_entry(
    worktree: &CapabilityDir,
    repo_root: &Path,
    relative: &Path,
    display_path: &str,
    scratch: &NativeHardResetCheckoutScratch,
) -> Result<Option<NativeHardResetBackup>> {
    let file_name = relative.file_name().ok_or_else(|| BackendError::Git {
        message: format!("Invalid tracked path during hard reset: {display_path}"),
    })?;
    let mut parent = worktree.try_clone().map_err(|error| BackendError::Io {
        message: format!("Failed to retain the hard reset worktree: {error}"),
        source: error,
    })?;
    if let Some(parent_path) = relative.parent() {
        for component in parent_path.components() {
            let std::path::Component::Normal(segment) = component else {
                return Err(BackendError::Git {
                    message: format!("Invalid tracked path during hard reset: {display_path}"),
                });
            };
            match parent.symlink_metadata(segment) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                    parent = parent.open_dir(segment).map_err(|error| BackendError::Io {
                        message: format!(
                            "Failed to open a tracked hard reset directory '{display_path}': {error}"
                        ),
                        source: error,
                    })?;
                }
                Ok(_) => {
                    return Err(BackendError::Git {
                        message: format!(
                            "Hard reset refused tracked path '{display_path}' through a linked or non-directory parent."
                        ),
                    })
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(Some(NativeHardResetBackup {
                        relative: relative.to_path_buf(),
                        data: NativeHardResetBackupData::Absent,
                    }))
                }
                Err(error) => {
                    return Err(BackendError::Io {
                        message: format!(
                            "Failed to inspect tracked hard reset path '{display_path}': {error}"
                        ),
                        source: error,
                    })
                }
            }
        }
    }

    let metadata = match parent.symlink_metadata(file_name) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Some(NativeHardResetBackup {
                relative: relative.to_path_buf(),
                data: NativeHardResetBackupData::Absent,
            }))
        }
        Err(error) => {
            return Err(BackendError::Io {
                message: format!(
                    "Failed to inspect tracked hard reset path '{display_path}': {error}"
                ),
                source: error,
            })
        }
    };
    let expected_identity =
        native_capability_identity(&metadata).ok_or_else(|| BackendError::Git {
            message: format!("Cannot identify tracked hard reset path '{display_path}'"),
        })?;
    let expected_fingerprint =
        native_capability_entry_fingerprint(&parent, file_name, &metadata, display_path)?;
    if expected_fingerprint.is_none() {
        return Ok(None);
    }
    run_native_hard_reset_before_tracked_isolation_hook(repo_root);

    let recovery_root = scratch.original_dir()?;
    let recovery_parent = open_or_create_native_worktree_parent(&recovery_root, relative)?;
    // Preserve the inode itself. A copied snapshot can become stale when an editor
    // keeps a writable handle open across the rename.
    parent
        .rename(file_name, &recovery_parent, file_name)
        .map_err(|error| BackendError::Io {
            message: format!("Failed to isolate tracked hard reset path '{display_path}': {error}"),
            source: error,
        })?;
    scratch.retain();
    let isolated_path = scratch.original_path().join(relative);
    let restore_isolated = || recovery_parent.rename(file_name, &parent, file_name);
    let isolated_metadata = match recovery_parent.symlink_metadata(file_name) {
        Ok(metadata) => metadata,
        Err(error) => {
            scratch.retain();
            return Err(BackendError::Io {
                message: format!(
                    "Failed to inspect isolated hard reset path '{}'; recovery data was retained at {}: {error}",
                    isolated_path.display(),
                    scratch.path().display()
                ),
                source: error,
            });
        }
    };
    if native_capability_identity(&isolated_metadata) != Some(expected_identity) {
        let restore_result = restore_isolated();
        if let Err(restore_error) = restore_result {
            scratch.retain();
            return Err(BackendError::Git {
                message: format!(
                    "Hard reset refused to remove concurrently replaced path '{display_path}'; the replacement was retained at {} because restoring its name failed: {restore_error}",
                    isolated_path.display()
                ),
            });
        }
        return Err(BackendError::Git {
            message: format!(
                "Hard reset refused to remove concurrently replaced path '{display_path}'"
            ),
        });
    }
    let isolated_fingerprint = match native_capability_entry_fingerprint(
        &recovery_parent,
        file_name,
        &isolated_metadata,
        display_path,
    ) {
        Ok(fingerprint) => fingerprint,
        Err(error) => {
            let restore_result = restore_isolated();
            if restore_result.is_err() {
                scratch.retain();
            }
            return Err(BackendError::Git {
                message: format!(
                    "{error}; hard reset could not verify isolated path '{display_path}'{}",
                    restore_result
                        .err()
                        .map(|restore_error| format!(
                            "; it remains at {}: {restore_error}",
                            isolated_path.display()
                        ))
                        .unwrap_or_default()
                ),
            });
        }
    };
    if isolated_fingerprint != expected_fingerprint {
        let restore_result = restore_isolated();
        if restore_result.is_err() {
            scratch.retain();
        }
        return Err(BackendError::Git {
            message: format!(
                "Hard reset refused concurrently modified tracked path '{display_path}'{}",
                restore_result
                    .err()
                    .map(|error| format!("; it remains at {}: {error}", isolated_path.display()))
                    .unwrap_or_default()
            ),
        });
    }
    run_native_hard_reset_after_tracked_isolation_hook(repo_root);
    Ok(Some(NativeHardResetBackup {
        relative: relative.to_path_buf(),
        data: NativeHardResetBackupData::Preserved {
            identity: expected_identity,
        },
    }))
}

fn open_or_create_native_worktree_parent(
    worktree: &CapabilityDir,
    relative: &Path,
) -> Result<CapabilityDir> {
    let mut parent = worktree.try_clone().map_err(|error| BackendError::Io {
        message: format!("Failed to retain the hard reset worktree: {error}"),
        source: error,
    })?;
    if let Some(parent_path) = relative.parent() {
        for component in parent_path.components() {
            let std::path::Component::Normal(segment) = component else {
                return Err(BackendError::Git {
                    message: format!(
                        "Invalid tracked path during hard reset: {}",
                        relative.display()
                    ),
                });
            };
            match parent.symlink_metadata(segment) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                Ok(_) => {
                    return Err(BackendError::Git {
                        message: format!(
                        "Hard reset rollback refused '{}' through a linked or non-directory parent",
                        relative.display()
                    ),
                    })
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    match parent.create_dir(segment) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                        Err(error) => {
                            return Err(BackendError::Io {
                                message: format!(
                                    "Failed to recreate hard reset parent for '{}': {error}",
                                    relative.display()
                                ),
                                source: error,
                            })
                        }
                    }
                }
                Err(error) => {
                    return Err(BackendError::Io {
                        message: format!(
                            "Failed to inspect hard reset rollback path '{}': {error}",
                            relative.display()
                        ),
                        source: error,
                    })
                }
            }
            parent = parent.open_dir(segment).map_err(|error| BackendError::Io {
                message: format!(
                    "Failed to open hard reset rollback parent for '{}': {error}",
                    relative.display()
                ),
                source: error,
            })?;
        }
    }
    Ok(parent)
}

fn restore_native_hard_reset_backups(
    repo_root: &Path,
    scratch: &NativeHardResetCheckoutScratch,
    backups: &[NativeHardResetBackup],
) -> Result<()> {
    let result = restore_native_hard_reset_backups_impl(repo_root, scratch, backups);
    if let Err(error) = result {
        scratch.retain();
        return Err(BackendError::Git {
            message: format!(
                "Hard reset rollback failed; recovery data was retained at {}: {error}",
                scratch.path().display()
            ),
        });
    }
    Ok(())
}

fn restore_native_hard_reset_backups_impl(
    repo_root: &Path,
    scratch: &NativeHardResetCheckoutScratch,
    backups: &[NativeHardResetBackup],
) -> Result<()> {
    let worktree =
        CapabilityDir::open_ambient_dir(repo_root, ambient_authority()).map_err(|error| {
            BackendError::Io {
                message: format!("Failed to reopen the hard reset worktree: {error}"),
                source: error,
            }
        })?;
    let recovery = scratch.original_dir()?;
    for backup in backups.iter().rev() {
        if matches!(&backup.data, NativeHardResetBackupData::Absent) {
            continue;
        }
        let file_name = backup
            .relative
            .file_name()
            .ok_or_else(|| BackendError::Git {
                message: format!(
                    "Invalid tracked rollback path: {}",
                    backup.relative.display()
                ),
            })?;
        let parent = open_or_create_native_worktree_parent(&worktree, &backup.relative)?;
        match parent.symlink_metadata(file_name) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => {
                return Err(BackendError::Git {
                    message: format!(
                        "Hard reset rollback refused to overwrite path '{}' created concurrently",
                        backup.relative.display()
                    ),
                })
            }
            Err(error) => {
                return Err(BackendError::Io {
                    message: format!(
                        "Failed to inspect hard reset rollback path '{}': {error}",
                        backup.relative.display()
                    ),
                    source: error,
                })
            }
        }
        let NativeHardResetBackupData::Preserved { identity } = &backup.data else {
            unreachable!("absent backups were handled before path restoration")
        };
        let recovery_parent = open_native_worktree_parent(&recovery, &backup.relative)?
            .ok_or_else(|| BackendError::Git {
                message: format!(
                    "Hard reset recovery data is missing for '{}'",
                    backup.relative.display()
                ),
            })?;
        let recovery_metadata = recovery_parent
            .symlink_metadata(file_name)
            .map_err(|error| BackendError::Io {
                message: format!(
                    "Failed to inspect hard reset recovery data for '{}': {error}",
                    backup.relative.display()
                ),
                source: error,
            })?;
        if native_capability_identity(&recovery_metadata) != Some(*identity) {
            return Err(BackendError::Git {
                message: format!(
                    "Hard reset refused changed recovery data for '{}'",
                    backup.relative.display()
                ),
            });
        }
        recovery_parent
            .rename(file_name, &parent, file_name)
            .map_err(|error| BackendError::Io {
                message: format!(
                    "Failed to restore hard reset path '{}': {error}",
                    backup.relative.display()
                ),
                source: error,
            })?;
    }
    Ok(())
}

pub(crate) struct NativeHardResetCheckoutScratch {
    pub(crate) path: PathBuf,
    pub(crate) directory: CapabilityDir,
    pub(crate) retain: AtomicBool,
}

impl NativeHardResetCheckoutScratch {
    pub(crate) fn create(repo: &Repository) -> Result<Self> {
        let root = repo.commondir().join("macro-hard-reset-recovery");
        fs::create_dir_all(&root).map_err(|error| BackendError::Io {
            message: format!(
                "Failed to create the hard reset recovery root {}: {error}",
                root.display()
            ),
            source: error,
        })?;
        let root_metadata = fs::symlink_metadata(&root).map_err(|error| BackendError::Io {
            message: format!(
                "Failed to inspect the hard reset recovery root {}: {error}",
                root.display()
            ),
            source: error,
        })?;
        if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
            return Err(BackendError::Git {
                message: format!(
                    "Hard reset recovery root is linked or is not a directory: {}",
                    root.display()
                ),
            });
        }
        for _ in 0..32 {
            let sequence = HARD_RESET_CHECKOUT_COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = root.join(format!(
                "transaction-{}-{sequence}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            match fs::create_dir(&path) {
                Ok(()) => {
                    let directory = CapabilityDir::open_ambient_dir(&path, ambient_authority())
                        .map_err(|error| BackendError::Io {
                            message: format!(
                                "Failed to open hard reset recovery directory {}: {error}",
                                path.display()
                            ),
                            source: error,
                        })?;
                    for child in ["original", "rollback-target", "checkout"] {
                        directory
                            .create_dir(child)
                            .map_err(|error| BackendError::Io {
                                message: format!(
                                    "Failed to create hard reset recovery directory '{}': {error}",
                                    path.join(child).display()
                                ),
                                source: error,
                            })?;
                    }
                    return Ok(Self {
                        path,
                        directory,
                        retain: AtomicBool::new(false),
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(BackendError::Io {
                        message: format!(
                            "Failed to create a temporary hard reset directory: {error}"
                        ),
                        source: error,
                    })
                }
            }
        }
        Err(BackendError::Io {
            message: "Failed to reserve a temporary hard reset directory".to_string(),
            source: std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "temporary hard reset directory names are exhausted",
            ),
        })
    }

    pub(crate) fn retain(&self) {
        self.retain.store(true, Ordering::Relaxed);
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn original_path(&self) -> PathBuf {
        self.path.join("original")
    }

    #[cfg(windows)]
    pub(crate) fn checkout_path(&self) -> PathBuf {
        self.path.join("checkout")
    }

    pub(crate) fn original_dir(&self) -> Result<CapabilityDir> {
        self.directory
            .open_dir("original")
            .map_err(|error| BackendError::Io {
                message: format!("Failed to open hard reset original recovery data: {error}"),
                source: error,
            })
    }

    pub(crate) fn rollback_target_dir(&self) -> Result<CapabilityDir> {
        self.directory
            .open_dir("rollback-target")
            .map_err(|error| BackendError::Io {
                message: format!("Failed to open hard reset rollback recovery data: {error}"),
                source: error,
            })
    }
}

impl Drop for NativeHardResetCheckoutScratch {
    fn drop(&mut self) {
        if !self.retain.load(Ordering::Relaxed) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

pub(crate) struct NativeHardResetRepositorySnapshot {
    pub(crate) head_name: Option<String>,
    pub(crate) head_oid: Oid,
    pub(crate) index_backup: PathBuf,
    pub(crate) expected_index: PathBuf,
}

fn capture_native_hard_reset_repository_snapshot(
    repo: &Repository,
    target: &Commit<'_>,
    scratch: &NativeHardResetCheckoutScratch,
) -> Result<NativeHardResetRepositorySnapshot> {
    let head = repo.head().map_err(|error| BackendError::Git {
        message: format!("Failed to capture HEAD before hard reset: {error}"),
    })?;
    let head_oid = head.target().ok_or_else(|| BackendError::Git {
        message: "Cannot hard reset an unborn HEAD".to_string(),
    })?;
    let head_name = if repo.head_detached().unwrap_or(false) {
        None
    } else {
        head.name().ok().map(str::to_string)
    };
    let index_path = repo.path().join("index");
    let index_backup = scratch.path().join("index.backup");
    fs::copy(&index_path, &index_backup).map_err(|error| BackendError::Io {
        message: format!(
            "Failed to back up the Git index {} before hard reset: {error}",
            index_path.display()
        ),
        source: error,
    })?;
    let expected_index = scratch.path().join("index.expected");
    fs::copy(&index_path, &expected_index).map_err(|error| BackendError::Io {
        message: format!("Failed to prepare the expected hard reset index: {error}"),
        source: error,
    })?;
    let mut expected = git2::Index::open(&expected_index)?;
    expected.read_tree(&target.tree()?)?;
    expected.write()?;
    fs::write(
        scratch.path().join("repository-state.txt"),
        format!(
            "head={head_oid}\nhead_name={}\nindex={}\n",
            head_name.as_deref().unwrap_or("DETACHED"),
            index_path.display()
        ),
    )
    .map_err(|error| BackendError::Io {
        message: format!("Failed to record hard reset recovery metadata: {error}"),
        source: error,
    })?;
    Ok(NativeHardResetRepositorySnapshot {
        head_name,
        head_oid,
        index_backup,
        expected_index,
    })
}

fn restore_native_hard_reset_head(
    repo: &Repository,
    snapshot: &NativeHardResetRepositorySnapshot,
    reset_target: Oid,
) -> Result<()> {
    if let Some(head_name) = snapshot.head_name.as_deref() {
        let current = repo
            .refname_to_id(head_name)
            .map_err(|error| BackendError::Git {
                message: format!("Failed to inspect HEAD during hard reset rollback: {error}"),
            })?;
        if current == snapshot.head_oid {
            return Ok(());
        }
        if current != reset_target {
            return Err(BackendError::Git {
                message: format!(
                    "Hard reset rollback refused to overwrite concurrent update of {head_name}"
                ),
            });
        }
        repo.reference_matching(
            head_name,
            snapshot.head_oid,
            true,
            reset_target,
            "Macro hard reset rollback",
        )?;
    } else {
        let head = repo.find_reference("HEAD")?;
        if head.symbolic_target()?.is_some() {
            return Err(BackendError::Git {
                message: "Hard reset rollback refused to overwrite a concurrently attached HEAD"
                    .to_string(),
            });
        }
        let current = head.target().ok_or_else(|| BackendError::Git {
            message: "Failed to inspect detached HEAD during hard reset rollback".to_string(),
        })?;
        if current == snapshot.head_oid {
            return Ok(());
        }
        if current != reset_target {
            return Err(BackendError::Git {
                message: "Hard reset rollback refused to overwrite concurrent detached HEAD update"
                    .to_string(),
            });
        }
        repo.reference_matching(
            "HEAD",
            snapshot.head_oid,
            true,
            reset_target,
            "Macro hard reset rollback",
        )?;
    }
    Ok(())
}

#[cfg(windows)]
fn replace_native_index_file(replacement: &Path, index_path: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    let mut replaced = index_path.as_os_str().encode_wide().collect::<Vec<_>>();
    replaced.push(0);
    let mut replacement_wide = replacement.as_os_str().encode_wide().collect::<Vec<_>>();
    replacement_wide.push(0);
    if unsafe {
        ReplaceFileW(
            replaced.as_ptr(),
            replacement_wide.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_native_index_file(replacement: &Path, index_path: &Path) -> std::io::Result<()> {
    fs::rename(replacement, index_path)
}

fn advance_native_hard_reset_head(
    repo: &Repository,
    snapshot: &NativeHardResetRepositorySnapshot,
    target: Oid,
) -> Result<()> {
    if let Some(head_name) = snapshot.head_name.as_deref() {
        let head = repo.find_reference("HEAD")?;
        if head.symbolic_target()? != Some(head_name) {
            return Err(BackendError::Git {
                message: "Hard reset refused a concurrent HEAD attachment change".to_string(),
            });
        }
        let current = repo.refname_to_id(head_name)?;
        if current != snapshot.head_oid {
            return Err(BackendError::Git {
                message: format!(
                    "Hard reset refused a concurrent update of {head_name} before finalization"
                ),
            });
        }
        if target != snapshot.head_oid {
            repo.reference_matching(
                head_name,
                target,
                true,
                snapshot.head_oid,
                "Macro hard reset",
            )?;
        }
    } else {
        let head = repo.find_reference("HEAD")?;
        if head.symbolic_target()?.is_some() || head.target() != Some(snapshot.head_oid) {
            return Err(BackendError::Git {
                message: "Hard reset refused a concurrent detached HEAD update".to_string(),
            });
        }
        if target != snapshot.head_oid {
            repo.reference_matching("HEAD", target, true, snapshot.head_oid, "Macro hard reset")?;
        }
    }
    Ok(())
}

fn finalize_native_hard_reset(
    repo: &Repository,
    snapshot: &NativeHardResetRepositorySnapshot,
    target: Oid,
) -> Result<()> {
    let index_path = repo.path().join("index");
    let index_lock = repo.path().join("index.lock");
    let mut lock = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&index_lock)
        .map_err(|error| BackendError::Io {
            message: format!(
                "Hard reset could not reserve Git index lock {}: {error}",
                index_lock.display()
            ),
            source: error,
        })?;
    let finalize_result = (|| -> Result<()> {
        let current = fs::read(&index_path).map_err(|error| BackendError::Io {
            message: format!("Failed to inspect the Git index before finalization: {error}"),
            source: error,
        })?;
        let original = fs::read(&snapshot.index_backup).map_err(|error| BackendError::Io {
            message: format!("Failed to read the original Git index before finalization: {error}"),
            source: error,
        })?;
        if current != original {
            let _ = fs::copy(
                &index_path,
                snapshot.index_backup.with_file_name("index.concurrent"),
            );
            return Err(BackendError::Git {
                message: "Hard reset refused to overwrite a concurrently modified Git index"
                    .to_string(),
            });
        }
        let expected = fs::read(&snapshot.expected_index).map_err(|error| BackendError::Io {
            message: format!("Failed to read the target Git index: {error}"),
            source: error,
        })?;
        lock.write_all(&expected)
            .map_err(|error| BackendError::Io {
                message: format!("Failed to stage the target Git index: {error}"),
                source: error,
            })?;
        lock.sync_all().map_err(|error| BackendError::Io {
            message: format!("Failed to flush the target Git index: {error}"),
            source: error,
        })?;
        advance_native_hard_reset_head(repo, snapshot, target)?;
        drop(lock);
        replace_native_index_file(&index_lock, &index_path).map_err(|error| BackendError::Io {
            message: format!("Failed to publish the target Git index: {error}"),
            source: error,
        })?;
        Ok(())
    })();
    if finalize_result.is_err() {
        let _ = fs::remove_file(&index_lock);
    }
    finalize_result
}

fn restore_native_hard_reset_index(
    repo: &Repository,
    snapshot: &NativeHardResetRepositorySnapshot,
) -> Result<()> {
    let index_path = repo.path().join("index");
    let index_lock = repo.path().join("index.lock");
    let mut lock = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&index_lock)
        .map_err(|error| BackendError::Io {
            message: format!(
                "Hard reset rollback could not reserve Git index lock {}: {error}",
                index_lock.display()
            ),
            source: error,
        })?;
    let restore_result = (|| -> Result<()> {
        let current = fs::read(&index_path).map_err(|error| BackendError::Io {
            message: format!("Failed to inspect the current Git index during rollback: {error}"),
            source: error,
        })?;
        let original = fs::read(&snapshot.index_backup).map_err(|error| BackendError::Io {
            message: format!("Failed to read the original Git index during rollback: {error}"),
            source: error,
        })?;
        if current == original {
            drop(lock);
            fs::remove_file(&index_lock).map_err(|error| BackendError::Io {
                message: format!("Failed to release the unused Git index lock: {error}"),
                source: error,
            })?;
            return Ok(());
        }
        let expected = fs::read(&snapshot.expected_index).map_err(|error| BackendError::Io {
            message: format!("Failed to read the target Git index during rollback: {error}"),
            source: error,
        })?;
        if current != expected {
            let _ = fs::copy(
                &index_path,
                snapshot.index_backup.with_file_name("index.current"),
            );
            return Err(BackendError::Git {
                message:
                    "Hard reset rollback refused to overwrite a concurrently modified Git index"
                        .to_string(),
            });
        }
        lock.write_all(&original)
            .map_err(|error| BackendError::Io {
                message: format!("Failed to stage the original Git index for rollback: {error}"),
                source: error,
            })?;
        lock.sync_all().map_err(|error| BackendError::Io {
            message: format!("Failed to flush the original Git index for rollback: {error}"),
            source: error,
        })?;
        drop(lock);
        replace_native_index_file(&index_lock, &index_path).map_err(|error| BackendError::Io {
            message: format!("Failed to publish the original Git index: {error}"),
            source: error,
        })?;
        Ok(())
    })();
    if restore_result.is_err() {
        let _ = fs::remove_file(&index_lock);
    }
    restore_result
}

#[cfg(unix)]
fn native_capability_identity(metadata: &cap_std::fs::Metadata) -> Option<NativeFileIdentity> {
    use cap_fs_ext::MetadataExt;
    Some(NativeFileIdentity {
        volume: metadata.dev(),
        file: metadata.ino(),
    })
}

#[cfg(windows)]
fn native_capability_identity(metadata: &cap_std::fs::Metadata) -> Option<NativeFileIdentity> {
    use cap_fs_ext::MetadataExt;
    Some(NativeFileIdentity {
        volume: metadata.dev(),
        file: metadata.ino(),
    })
}

#[cfg(not(any(unix, windows)))]
fn native_capability_identity(_metadata: &cap_std::fs::Metadata) -> Option<NativeFileIdentity> {
    None
}

fn open_native_worktree_parent(
    worktree: &CapabilityDir,
    relative: &Path,
) -> Result<Option<CapabilityDir>> {
    let mut parent = worktree.try_clone().map_err(|error| BackendError::Io {
        message: format!("Failed to retain the hard reset worktree: {error}"),
        source: error,
    })?;
    if let Some(parent_path) = relative.parent() {
        for component in parent_path.components() {
            let std::path::Component::Normal(segment) = component else {
                return Err(BackendError::Git {
                    message: format!("Invalid hard reset rollback path: {}", relative.display()),
                });
            };
            match parent.symlink_metadata(segment) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                    parent = parent.open_dir(segment).map_err(|error| BackendError::Io {
                        message: format!(
                            "Failed to open hard reset rollback path '{}': {error}",
                            relative.display()
                        ),
                        source: error,
                    })?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Ok(_) => {
                    return Err(BackendError::Git {
                        message: format!(
                        "Hard reset rollback refused '{}' through a linked or non-directory parent",
                        relative.display()
                    ),
                    })
                }
                Err(error) => {
                    return Err(BackendError::Io {
                        message: format!(
                            "Failed to inspect hard reset rollback path '{}': {error}",
                            relative.display()
                        ),
                        source: error,
                    })
                }
            }
        }
    }
    Ok(Some(parent))
}

fn remove_native_materialized_file(
    worktree: &CapabilityDir,
    scratch: &NativeHardResetCheckoutScratch,
    relative: &Path,
    expected: &NativeMaterializedState,
) -> Result<()> {
    let Some(parent) = open_native_worktree_parent(worktree, relative)? else {
        return Err(BackendError::Git {
            message: format!(
                "Hard reset rollback could not find materialized path '{}'",
                relative.display()
            ),
        });
    };
    let file_name = relative.file_name().ok_or_else(|| BackendError::Git {
        message: format!("Invalid hard reset rollback path: {}", relative.display()),
    })?;
    let recovery_root = scratch.rollback_target_dir()?;
    let recovery_parent = open_or_create_native_worktree_parent(&recovery_root, relative)?;
    // Rollback must retain this inode for the same open-handle reason as the
    // original worktree entry.
    parent
        .rename(file_name, &recovery_parent, file_name)
        .map_err(|error| BackendError::Io {
            message: format!(
                "Failed to preserve hard reset rollback path '{}': {error}",
                relative.display()
            ),
            source: error,
        })?;
    scratch.retain();
    let metadata = recovery_parent
        .symlink_metadata(file_name)
        .map_err(|error| BackendError::Io {
            message: format!(
                "Failed to verify preserved hard reset rollback path '{}': {error}",
                relative.display()
            ),
            source: error,
        })?;
    let restore_isolated = || recovery_parent.rename(file_name, &parent, file_name);
    if native_capability_identity(&metadata) != Some(expected.identity) {
        let _ = restore_isolated();
        return Err(BackendError::Git {
            message: format!(
                "Hard reset rollback refused concurrently replaced path '{}'",
                relative.display()
            ),
        });
    }
    Ok(())
}

#[derive(Clone)]
pub(crate) struct NativeMaterializedState {
    pub(crate) identity: NativeFileIdentity,
}

#[cfg(unix)]
fn native_symlink_target_bytes(target: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    target.as_os_str().as_bytes().to_vec()
}

#[cfg(not(unix))]
fn native_symlink_target_bytes(target: &Path) -> Vec<u8> {
    target.to_string_lossy().as_bytes().to_vec()
}

fn capture_native_materialized_entries(
    repo_root: &Path,
    target: &Commit<'_>,
    backups: &[NativeHardResetBackup],
) -> Result<HashMap<PathBuf, NativeMaterializedState>> {
    let tree = target.tree()?;
    let mut materialized = HashMap::new();
    for backup in backups {
        let Ok(entry) = tree.get_path(&backup.relative) else {
            continue;
        };
        if entry.kind() != Some(git2::ObjectType::Blob) {
            continue;
        }
        let identity =
            native_path_identity(&repo_root.join(&backup.relative)).ok_or_else(|| {
                BackendError::Git {
                    message: format!(
                        "Hard reset did not materialize expected target path '{}'",
                        backup.relative.display()
                    ),
                }
            })?;
        materialized.insert(
            backup.relative.clone(),
            NativeMaterializedState { identity },
        );
    }
    Ok(materialized)
}

fn remove_native_materialized_entries(
    repo_root: &Path,
    scratch: &NativeHardResetCheckoutScratch,
    backups: &[NativeHardResetBackup],
    materialized: &HashMap<PathBuf, NativeMaterializedState>,
) -> Result<()> {
    let worktree =
        CapabilityDir::open_ambient_dir(repo_root, ambient_authority()).map_err(|error| {
            BackendError::Io {
                message: format!("Failed to open the hard reset worktree: {error}"),
                source: error,
            }
        })?;
    for backup in backups.iter().rev() {
        let current_identity = native_path_identity(&repo_root.join(&backup.relative));
        match (materialized.get(&backup.relative), current_identity) {
            (Some(expected), Some(current)) if expected.identity == current => {
                remove_native_materialized_file(&worktree, scratch, &backup.relative, expected)?;
            }
            (None, _) if matches!(&backup.data, NativeHardResetBackupData::Absent) => {}
            (None, None) => {}
            _ => {
                return Err(BackendError::Git {
                    message: format!(
                        "Hard reset rollback refused concurrently changed path '{}'",
                        backup.relative.display()
                    ),
                })
            }
        }
    }
    Ok(())
}

fn rollback_native_hard_reset(
    repo: &Repository,
    repo_root: &Path,
    reset_target: Oid,
    scratch: &NativeHardResetCheckoutScratch,
    snapshot: &NativeHardResetRepositorySnapshot,
    backups: &[NativeHardResetBackup],
    materialized: &HashMap<PathBuf, NativeMaterializedState>,
    original_error: BackendError,
) -> BackendError {
    let mut rollback_errors = Vec::new();
    if let Err(error) =
        remove_native_materialized_entries(repo_root, scratch, backups, materialized)
    {
        rollback_errors.push(error.to_string());
    }
    if let Err(error) = restore_native_hard_reset_backups(repo_root, scratch, backups) {
        rollback_errors.push(error.to_string());
    }
    if let Err(error) = restore_native_hard_reset_head(repo, snapshot, reset_target) {
        rollback_errors.push(error.to_string());
    }
    if let Err(error) = restore_native_hard_reset_index(repo, snapshot) {
        rollback_errors.push(error.to_string());
    }
    if rollback_errors.is_empty() {
        original_error
    } else {
        scratch.retain();
        BackendError::Git {
            message: format!(
                "{original_error}; hard reset rollback was incomplete and recovery data was retained at {}: {}",
                scratch.path().display(),
                rollback_errors.join("; ")
            ),
        }
    }
}

#[cfg(windows)]
fn create_native_hard_reset_file_without_overwrite(
    worktree: &CapabilityDir,
    relative: &Path,
    source: &Path,
) -> Result<()> {
    let display_path = relative.to_string_lossy().replace('\\', "/");
    let file_name = relative.file_name().ok_or_else(|| BackendError::Git {
        message: format!("Invalid tracked path during hard reset: {display_path}"),
    })?;
    let mut parent = worktree.try_clone().map_err(|error| BackendError::Io {
        message: format!("Failed to retain the hard reset worktree: {error}"),
        source: error,
    })?;
    if let Some(parent_path) = relative.parent() {
        for component in parent_path.components() {
            let std::path::Component::Normal(segment) = component else {
                return Err(BackendError::Git {
                    message: format!("Invalid tracked path during hard reset: {display_path}"),
                });
            };
            match parent.symlink_metadata(segment) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                Ok(_) => return Err(untracked_reset_collision_error(display_path.as_bytes())),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    match parent.create_dir(segment) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                        Err(error) => {
                            return Err(BackendError::Io {
                                message: format!(
                                    "Failed to create a tracked hard reset directory '{display_path}': {error}"
                                ),
                                source: error,
                            })
                        }
                    }
                }
                Err(error) => {
                    return Err(BackendError::Io {
                        message: format!(
                            "Failed to inspect a tracked hard reset directory '{display_path}': {error}"
                        ),
                        source: error,
                    })
                }
            }
            parent = parent.open_dir(segment).map_err(|error| BackendError::Git {
                message: format!(
                    "Hard reset refused tracked path '{display_path}' through a linked or replaced directory: {error}"
                ),
            })?;
        }
    }

    let source_metadata = fs::symlink_metadata(source).map_err(|error| BackendError::Io {
        message: format!(
            "Failed to inspect temporary hard reset file '{}': {error}",
            source.display()
        ),
        source: error,
    })?;
    if source_metadata.file_type().is_symlink() {
        let link_target = fs::read_link(source).map_err(|error| BackendError::Io {
            message: format!(
                "Failed to read temporary hard reset link '{}': {error}",
                source.display()
            ),
            source: error,
        })?;
        return parent
            .symlink_file(link_target, file_name)
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::AlreadyExists => {
                    untracked_reset_collision_error(display_path.as_bytes())
                }
                _ => BackendError::Io {
                    message: format!(
                        "Failed to create tracked hard reset link '{display_path}': {error}"
                    ),
                    source: error,
                },
            });
    }
    if !source_metadata.is_file() {
        return Err(BackendError::Git {
            message: format!(
                "Hard reset produced an unsupported temporary entry for '{display_path}'"
            ),
        });
    }

    let mut source_file = fs::File::open(source).map_err(|error| BackendError::Io {
        message: format!(
            "Failed to open temporary hard reset file '{}': {error}",
            source.display()
        ),
        source: error,
    })?;
    let mut options = CapabilityOpenOptions::new();
    options.write(true).create_new(true);
    let mut destination =
        parent
            .open_with(file_name, &options)
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::AlreadyExists => {
                    untracked_reset_collision_error(display_path.as_bytes())
                }
                _ => BackendError::Io {
                    message: format!(
                        "Failed to create tracked hard reset file '{display_path}': {error}"
                    ),
                    source: error,
                },
            })?;
    std::io::copy(&mut source_file, &mut destination).map_err(|error| BackendError::Io {
        message: format!("Failed to write tracked hard reset file '{display_path}': {error}"),
        source: error,
    })?;
    Ok(())
}

#[cfg(windows)]
fn recover_native_case_sensitive_checkout_conflicts(
    repo: &Repository,
    repo_root: &Path,
    target: &Commit<'_>,
    conflicts: &[PathBuf],
) -> Result<bool> {
    if conflicts.is_empty() {
        return Ok(false);
    }

    let target_paths = native_target_tree_paths(target)?;
    let untracked_paths = native_untracked_paths(repo)?;
    if find_native_untracked_reset_collision(repo_root, &untracked_paths, &target_paths).is_some() {
        return Ok(false);
    }

    let mut conflict_paths = Vec::new();
    let mut seen = HashSet::new();
    for conflict in conflicts {
        let Some(display_path) = conflict.to_str().map(|path| path.replace('\\', "/")) else {
            return Ok(false);
        };
        let path_bytes = display_path.as_bytes();
        if !target_paths
            .iter()
            .any(|target_path| target_path == path_bytes)
            || fs::symlink_metadata(repo_root.join(conflict)).is_ok()
            || !untracked_paths.iter().any(|untracked| {
                untracked != path_bytes && untracked.eq_ignore_ascii_case(path_bytes)
            })
        {
            return Ok(false);
        }
        if seen.insert(conflict.clone()) {
            conflict_paths.push(conflict.clone());
        }
    }

    let scratch = NativeHardResetCheckoutScratch::create(repo)?;
    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout
        .force()
        .target_dir(&scratch.checkout_path())
        .update_index(false);
    for conflict in &conflict_paths {
        checkout.path(conflict);
    }
    repo.checkout_tree(target.as_object(), Some(&mut checkout))?;

    let worktree =
        CapabilityDir::open_ambient_dir(repo_root, ambient_authority()).map_err(|error| {
            BackendError::Io {
                message: format!("Failed to open the hard reset worktree: {error}"),
                source: error,
            }
        })?;
    for conflict in &conflict_paths {
        create_native_hard_reset_file_without_overwrite(
            &worktree,
            conflict,
            &scratch.checkout_path().join(conflict),
        )?;
    }
    Ok(true)
}

fn hard_reset_repo_preserving_untracked(repo: &Repository, target: &Commit<'_>) -> Result<()> {
    let repo_root = repo_root(repo)?;
    ensure_native_hard_reset_preserves_untracked(repo, target)?;
    run_native_hard_reset_after_preflight_hook(&repo_root);

    let scratch = NativeHardResetCheckoutScratch::create(repo)?;
    let repository_snapshot =
        capture_native_hard_reset_repository_snapshot(repo, target, &scratch)?;
    let backups = remove_native_indexed_worktree_entries(repo, &repo_root, target, &scratch)?;
    let checkout_conflicts = Arc::new(Mutex::new(Vec::<PathBuf>::new()));
    let notified_conflicts = Arc::clone(&checkout_conflicts);
    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout
        .safe()
        .recreate_missing(true)
        .overwrite_ignored(false)
        .update_index(false)
        .notify_on(CheckoutNotificationType::CONFLICT)
        .notify(move |why, path, _, _, _| {
            if why.is_conflict() {
                if let Some(path) = path {
                    notified_conflicts
                        .lock()
                        .expect("lock hard reset checkout conflicts")
                        .push(path.to_path_buf());
                }
            }
            true
        });
    let checkout_result = repo.checkout_tree(target.as_object(), Some(&mut checkout));
    drop(checkout);
    if let Err(error) = checkout_result {
        #[cfg(windows)]
        let conflicts = checkout_conflicts
            .lock()
            .expect("lock hard reset checkout conflicts")
            .clone();
        #[cfg(windows)]
        match recover_native_case_sensitive_checkout_conflicts(repo, &repo_root, target, &conflicts)
        {
            Ok(true) => {
                let materialized =
                    match capture_native_materialized_entries(&repo_root, target, &backups) {
                        Ok(materialized) => materialized,
                        Err(error) => {
                            return Err(rollback_native_hard_reset(
                                repo,
                                &repo_root,
                                target.id(),
                                &scratch,
                                &repository_snapshot,
                                &backups,
                                &HashMap::new(),
                                error,
                            ));
                        }
                    };
                let reset_result = if run_native_hard_reset_before_final_reset_hook(&repo_root) {
                    Err(BackendError::Git {
                        message: "Injected hard reset finalization failure".to_string(),
                    })
                } else {
                    finalize_native_hard_reset(repo, &repository_snapshot, target.id())
                };
                if let Err(error) = reset_result {
                    return Err(rollback_native_hard_reset(
                        repo,
                        &repo_root,
                        target.id(),
                        &scratch,
                        &repository_snapshot,
                        &backups,
                        &materialized,
                        BackendError::Git {
                            message: format!(
                                "Hard reset could not finalize repository state: {error}"
                            ),
                        },
                    ));
                }
                return Ok(());
            }
            Ok(false) => {}
            Err(recovery_error) => {
                return Err(rollback_native_hard_reset(
                    repo,
                    &repo_root,
                    target.id(),
                    &scratch,
                    &repository_snapshot,
                    &backups,
                    &HashMap::new(),
                    recovery_error,
                ));
            }
        }
        return Err(rollback_native_hard_reset(
            repo,
            &repo_root,
            target.id(),
            &scratch,
            &repository_snapshot,
            &backups,
            &HashMap::new(),
            BackendError::Git {
                message: format!(
                    "Hard reset could not update tracked files without overwriting untracked data: {error}"
                ),
            },
        ));
    }
    let materialized = match capture_native_materialized_entries(&repo_root, target, &backups) {
        Ok(materialized) => materialized,
        Err(error) => {
            return Err(rollback_native_hard_reset(
                repo,
                &repo_root,
                target.id(),
                &scratch,
                &repository_snapshot,
                &backups,
                &HashMap::new(),
                error,
            ));
        }
    };
    let reset_result = if run_native_hard_reset_before_final_reset_hook(&repo_root) {
        Err(BackendError::Git {
            message: "Injected hard reset finalization failure".to_string(),
        })
    } else {
        finalize_native_hard_reset(repo, &repository_snapshot, target.id())
    };
    if let Err(error) = reset_result {
        return Err(rollback_native_hard_reset(
            repo,
            &repo_root,
            target.id(),
            &scratch,
            &repository_snapshot,
            &backups,
            &materialized,
            BackendError::Git {
                message: format!("Hard reset could not finalize repository state: {error}"),
            },
        ));
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
        "hard" => ResetType::Hard,
        other => {
            return Err(BackendError::Validation(format!(
                "Invalid reset mode: {}",
                other
            )))
        }
    };

    if reset_type == ResetType::Hard {
        return hard_reset_repo_preserving_untracked(repo, &target);
    }

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

pub(crate) fn parse_task_id(message: &str) -> Option<String> {
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

pub(crate) fn status_entry_paths(entry: &StatusEntry<'_>) -> (Option<String>, Option<String>) {
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

pub(crate) fn build_status_map(repo: &Repository) -> Result<HashMap<String, String>> {
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

pub(crate) fn insert_node(nodes: &mut Vec<GitNode>, parts: &[&str], prefix: &str, status: &str) {
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

pub(crate) fn build_tree_nodes(
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

pub(crate) fn resolve_commit<'repo>(repo: &'repo Repository, spec: &str) -> Result<Commit<'repo>> {
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

pub(crate) fn ensure_clean(repo: &Repository) -> Result<()> {
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
    validate_refspec(branch_or_commit)?;
    let mut args = vec!["switch".to_string()];
    if create {
        validate_branch_name(branch_or_commit)?;
        if get_head_commit(repo)?.is_none() {
            return Err(BackendError::Git {
                message: "Cannot create branch without an initial commit".to_string(),
            });
        }
        args.extend(["-c".into(), branch_or_commit.into()]);
    } else if repo
        .find_branch(branch_or_commit, BranchType::Local)
        .is_ok()
    {
        args.extend(["--no-guess".into(), branch_or_commit.into()]);
    } else {
        let commit =
            resolve_commit(repo, branch_or_commit).map_err(|_| BackendError::GitInvalidCommit {
                message: format!("Commit not found: {}", branch_or_commit),
            })?;
        args.extend(["--detach".into(), commit.id().to_string()]);
    }
    // switch validates branch occupancy before changing HEAD, index or files.
    run_index_mutation(repo, &args)
}

pub(crate) fn verify_expected_worktree_identity(
    repo: &Repository,
    expected_branch_name: &str,
    actual_worktree_path: &Path,
    actual_branch_name: Option<&str>,
    expected_commit: Option<&str>,
    expected_worktree_path: Option<&str>,
) -> Result<()> {
    if let Some(expected_worktree_path) = expected_worktree_path {
        let expected_path = normalize_path(Path::new(expected_worktree_path));
        let actual_path = normalize_path(actual_worktree_path);
        if expected_path != actual_path {
            return Err(BackendError::Git {
                message: "Refusing to remove a worktree because its durable path identity changed"
                    .to_string(),
            });
        }
    }

    if let Some(expected_commit) = expected_commit {
        if expected_branch_name.is_empty() || actual_branch_name != Some(expected_branch_name) {
            return Err(BackendError::Git {
                message:
                    "Refusing to remove a worktree because its durable branch identity changed"
                        .to_string(),
            });
        }
        let expected_oid = Oid::from_str(expected_commit).map_err(|_| BackendError::Git {
            message: format!(
                "Invalid expected commit for worktree branch {}",
                expected_branch_name
            ),
        })?;
        let actual_oid = repo
            .find_branch(expected_branch_name, BranchType::Local)
            .and_then(|branch| branch.get().peel_to_commit())
            .map_err(|error| BackendError::Git {
                message: format!(
                    "Failed to resolve worktree branch {}: {}",
                    expected_branch_name, error
                ),
            })?
            .id();
        if expected_oid != actual_oid {
            return Err(BackendError::Git {
                message: format!(
                    "Refusing to remove worktree for branch {} because its durable commit identity changed",
                    expected_branch_name
                ),
            });
        }
    }

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

pub(crate) fn collect_command_conflict_files(cwd: &Path) -> Vec<String> {
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

pub(crate) fn find_worktree_path_for_branch(
    root: &Path,
    branch_name: &str,
) -> Result<Option<PathBuf>> {
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

pub(crate) fn rebase_branch_repo_with_reflog_action(
    repo: &Repository,
    branch_name: &str,
    onto_branch: &str,
    confirm: Option<bool>,
    reflog_action: Option<&str>,
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

    let rebase_args = if reflog_action.is_some() {
        vec![
            "-c".into(),
            "core.logAllRefUpdates=true".into(),
            "rebase".into(),
            "--merge".into(),
            onto_branch.to_string(),
        ]
    } else {
        vec!["rebase".into(), onto_branch.to_string()]
    };
    let output = run_git_command_with_reflog_action(&command_root, &rebase_args, reflog_action)?;

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

pub(crate) fn verify_exact_incomplete_merge(
    repo: &Repository,
    into_branch: &str,
    expected_into_commit: &str,
    expected_merge_head: &str,
) -> Result<bool> {
    if repo.state() == RepositoryState::Clean {
        return Ok(false);
    }
    if repo.state() != RepositoryState::Merge {
        return Err(BackendError::Git {
            message: format!(
                "Refusing durable merge recovery because repository state is {:?}",
                repo.state()
            ),
        });
    }
    if get_branch_name(repo)?.as_deref() != Some(into_branch) {
        return Err(BackendError::Git {
            message: format!(
                "Refusing durable merge recovery because HEAD is not on target branch {}",
                into_branch
            ),
        });
    }
    let expected_into_oid = Oid::from_str(expected_into_commit).map_err(|_| BackendError::Git {
        message: format!("Invalid expected target commit for branch {}", into_branch),
    })?;
    let actual_into_oid = repo
        .find_branch(into_branch, BranchType::Local)
        .and_then(|branch| branch.get().peel_to_commit())
        .map_err(|error| BackendError::Git {
            message: format!(
                "Failed to resolve merge target branch {}: {}",
                into_branch, error
            ),
        })?
        .id();
    if actual_into_oid != expected_into_oid {
        return Err(BackendError::Git {
            message: format!(
                "Refusing durable merge recovery because target branch {} changed from {} to {}",
                into_branch, expected_into_oid, actual_into_oid
            ),
        });
    }
    let merge_head_contents =
        fs::read_to_string(repo.path().join("MERGE_HEAD")).map_err(|error| BackendError::Git {
            message: format!(
                "Failed to inspect MERGE_HEAD during durable recovery: {}",
                error
            ),
        })?;
    let merge_heads = merge_head_contents
        .lines()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if merge_heads.as_slice() != [expected_merge_head] {
        return Err(BackendError::Git {
            message: "Refusing durable merge recovery because MERGE_HEAD does not match the journaled source commit".to_string(),
        });
    }

    Ok(true)
}

pub(crate) fn abort_exact_incomplete_merge(
    repo: &Repository,
    into_branch: &str,
    expected_into_commit: &str,
    expected_merge_head: &str,
) -> Result<bool> {
    if !verify_exact_incomplete_merge(repo, into_branch, expected_into_commit, expected_merge_head)?
    {
        return Ok(false);
    }
    let root = repo_root(repo)?;
    let output = run_git_command(&root, &["merge".to_string(), "--abort".to_string()])?;
    if !output.success {
        let details = command_output_text(&output);
        return Err(BackendError::Git {
            message: if details.is_empty() {
                format!("git merge --abort failed (exit code: {:?})", output.code)
            } else {
                details
            },
        });
    }
    Ok(true)
}

pub(crate) fn commit_repo(repo: &Repository, message: &str, stage_all: bool) -> Result<String> {
    validate_commit_message(message)?;
    ensure_safe_config(repo)?;

    // Specialized operations own their parent lists and cleanup. A general
    // commit must never turn a merge resolution into a single-parent commit.
    if repo.state() != git2::RepositoryState::Clean {
        return Err(BackendError::Git {
            message:
                "Complete or abort the active Git operation before using the general commit command"
                    .to_string(),
        });
    }
    if stage_all {
        run_index_mutation(repo, &["add".into(), "-A".into()])?;
    }

    repo.index()?.read(true)?;
    let statuses = repo.statuses(Some(&mut get_status_options()))?;
    if statuses.is_empty() {
        return Err(BackendError::Git {
            message: "No changes to commit".to_string(),
        });
    }

    let mut index = repo.index()?;
    index.read(true)?;
    let tree_id = index.write_tree()?;
    let tree = repo.find_tree(tree_id)?;

    let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
    let index_matches_parent = parent
        .as_ref()
        .map_or_else(|| tree.len() == 0, |parent| parent.tree_id() == tree_id);
    if index_matches_parent {
        return Err(BackendError::Git {
            message: "No staged changes to commit".to_string(),
        });
    }

    let signature = repo
        .signature()
        .unwrap_or_else(|_| git2::Signature::now("Macro", "macro@local").unwrap());

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

pub(crate) enum DiffTextSink {
    Full(String),
    Bounded(crate::core::workspace_execution::tool_output::BoundedTextCollector),
}

impl DiffTextSink {
    pub(crate) fn new(max_bytes: Option<usize>) -> Self {
        match max_bytes {
            Some(max_bytes) => Self::Bounded(
                crate::core::workspace_execution::tool_output::BoundedTextCollector::new(max_bytes),
            ),
            None => Self::Full(String::new()),
        }
    }

    pub(crate) fn push_str(&mut self, value: &str) {
        match self {
            Self::Full(output) => output.push_str(value),
            Self::Bounded(output) => output.push_str(value),
        }
    }

    pub(crate) fn finish(self, require_complete: bool) -> Result<String> {
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

#[path = "operations/workflow.rs"]
pub mod workflow;
