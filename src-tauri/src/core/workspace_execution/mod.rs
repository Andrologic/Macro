pub(crate) mod ast_search;
pub(crate) mod tool_output;
pub mod workspace_tools;
pub use super::command_error::CommandError;
use super::command_error::{command_error, CommandResult};
use crate::core::error::BackendError;
use crate::core::tool_policy::{
    is_macro_scoped_path, validate_tool_execution, ToolValidationResult,
};
use crate::fs::mutation_locks::{
    content_mutation_lock, native_content_mutation_key, wsl_content_mutation_key,
};
use crate::fs::operations as fs;
use crate::fs::{
    validate_path as validate_fs_path, validate_path_for_write as validate_fs_path_for_write,
};
use crate::git::{operations as git, GitState};
use crate::project_path::{
    join_wsl_path, parse_wsl_unc_path, run_wsl_shell, run_wsl_shell_with_stdin, WslProjectPath,
};
use glob::Pattern;
use regex::RegexBuilder;
use serde_json::Value;
use std::collections::HashMap;
#[cfg(all(test, unix))]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Instant;
use tokio::sync::Notify;
use tokio::time::{timeout, Duration};
pub use workspace_tools::WorkspaceProjectMount;
#[derive(Default)]
struct ToolExecutionCancellationRegistry {
    active: HashMap<String, Arc<ToolCancellation>>,
    pending: HashMap<String, Instant>,
}

static TOOL_EXECUTION_CANCELLATION_REGISTRY: LazyLock<Mutex<ToolExecutionCancellationRegistry>> =
    LazyLock::new(|| Mutex::new(ToolExecutionCancellationRegistry::default()));
const PENDING_TOOL_CANCELLATION_TTL: Duration = Duration::from_secs(60);
const PENDING_TOOL_CANCELLATION_LIMIT: usize = 1_024;

pub(crate) struct ToolCancellation {
    cancelled: AtomicBool,
    notify: Notify,
}

struct ToolExecutionGuard {
    execution_id: String,
    cancellation: Arc<ToolCancellation>,
}

impl Drop for ToolExecutionGuard {
    fn drop(&mut self) {
        let mut registry = TOOL_EXECUTION_CANCELLATION_REGISTRY
            .lock()
            .expect("tool cancellation registry");
        if registry
            .active
            .get(&self.execution_id)
            .is_some_and(|current| Arc::ptr_eq(current, &self.cancellation))
        {
            registry.active.remove(&self.execution_id);
        }
    }
}

fn register_tool_execution(
    execution_id: Option<&str>,
) -> Option<(Arc<ToolCancellation>, ToolExecutionGuard)> {
    let execution_id = execution_id
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    let (cancellation, was_cancelled_before_registration) = {
        let mut registry = TOOL_EXECUTION_CANCELLATION_REGISTRY
            .lock()
            .expect("tool cancellation registry");
        let now = Instant::now();
        registry.pending.retain(|_, recorded_at| {
            now.duration_since(*recorded_at) < PENDING_TOOL_CANCELLATION_TTL
        });
        let was_pending = registry.pending.remove(&execution_id).is_some();
        let cancellation = registry
            .active
            .entry(execution_id.clone())
            .or_insert_with(|| Arc::new(ToolCancellation::new()))
            .clone();
        (cancellation, was_pending)
    };
    if was_cancelled_before_registration {
        cancellation.cancel();
    }
    let guard = ToolExecutionGuard {
        execution_id,
        cancellation: cancellation.clone(),
    };
    Some((cancellation, guard))
}

fn tool_execution_timeout(tool_id: &str) -> Option<Duration> {
    match tool_id {
        "list" => Some(Duration::from_millis(tool_output::LIST_TIMEOUT_MILLIS)),
        "read" => Some(Duration::from_millis(tool_output::READ_TIMEOUT_MILLIS)),
        "glob" => Some(Duration::from_millis(tool_output::GLOB_TIMEOUT_MILLIS)),
        "grep" => Some(Duration::from_millis(tool_output::GREP_TIMEOUT_MILLIS)),
        "ast_grep" => Some(Duration::from_millis(tool_output::AST_TIMEOUT_MILLIS)),
        _ => None,
    }
}
pub(crate) fn json_arg_string(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
}

pub(crate) fn json_arg_bool(args: &Value, key: &str) -> Option<bool> {
    args.get(key).and_then(|value| value.as_bool())
}

pub(crate) fn json_arg_u32(args: &Value, key: &str) -> Option<u32> {
    args.get(key)
        .and_then(|value| value.as_u64())
        .map(|value| value as u32)
}

fn json_arg_string_array(args: &Value, key: &str) -> Option<Vec<String>> {
    args.get(key)
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(|value| value.to_string()))
                .filter(|value| !value.trim().is_empty())
                .collect::<Vec<_>>()
        })
}

pub(crate) fn json_arg_string_map(args: &Value, key: &str) -> HashMap<String, String> {
    args.get(key)
        .and_then(Value::as_object)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|(path, revision)| {
                    revision
                        .as_str()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(|value| (normalize_tool_map_path(path), value.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn normalize_tool_map_path(path: &str) -> String {
    let mut normalized = path.trim().replace('\\', "/");
    while normalized.starts_with("./") {
        normalized = normalized[2..].to_string();
    }
    normalized.trim_matches('/').to_string()
}

pub(crate) fn format_with_line_numbers(lines: &[&str], start_line: usize) -> String {
    lines
        .iter()
        .enumerate()
        .map(|(index, line)| format!("{:>4} | {}", start_line + index, line))
        .collect::<Vec<_>>()
        .join("\n")
}

async fn resolve_workspace_for_tool_path(
    workspace: &Path,
    git_state: &GitState,
    path: Option<&str>,
    workspace_scope: Option<&str>,
) -> CommandResult<PathBuf> {
    async fn resolve_metadata_workspace(
        workspace: &Path,
        git_state: &GitState,
    ) -> CommandResult<PathBuf> {
        if parse_wsl_unc_path(&workspace.to_string_lossy()).is_some() {
            return Err(command_error(
                "Macro metadata is not yet available through agent tools for WSL projects.",
            ));
        }
        let workspace_for_task = workspace.to_path_buf();
        let workspace_for_fallback = workspace.to_path_buf();
        let git_state_for_task = git_state.clone();
        let _repo_guard = crate::workspace::lock_git_repository(workspace)
            .await
            .map_err(|error| command_error(error.to_string()))?;
        let resolved = tokio::task::spawn_blocking(move || {
            git_state_for_task.resolve_macro_metadata_root(&workspace_for_task)
        })
        .await
        .map_err(|error| command_error(format!("Metadata root task failed: {}", error)))?;

        match resolved {
            Ok(metadata_root) => Ok(metadata_root),
            Err(crate::core::error::BackendError::GitRepositoryNotFound { message }) => {
                let fallback = workspace_for_fallback.join(".macro");
                tracing::warn!(
                    action = "workspace_tool_metadata_root_fallback",
                    workspace_path = %workspace_for_fallback.display(),
                    fallback_path = %fallback.display(),
                    reason = %message
                );
                Ok(fallback)
            }
            Err(error) => Err(command_error(error.to_string())),
        }
    }

    let metadata_scope = matches!(workspace_scope.map(str::trim), Some("metadata"));
    let Some(path) = path else {
        if metadata_scope {
            return resolve_metadata_workspace(workspace, git_state).await;
        }
        return Ok(workspace.to_path_buf());
    };

    if !metadata_scope && !is_macro_scoped_path(path) {
        return Ok(workspace.to_path_buf());
    }

    resolve_metadata_workspace(workspace, git_state).await
}

fn resolve_requested_workspace(
    default_workspace: &Path,
    metadata_workspace: &Path,
    requested_workspace: Option<&str>,
) -> CommandResult<PathBuf> {
    let Some(requested_workspace) = requested_workspace
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(default_workspace.to_path_buf());
    };

    if parse_wsl_unc_path(requested_workspace).is_some() {
        return Ok(PathBuf::from(requested_workspace));
    }

    let requested_path = PathBuf::from(requested_workspace);
    let candidate = if requested_path.is_absolute() {
        requested_path
    } else {
        metadata_workspace.join(requested_path)
    };

    if fs::has_expected_workspace_root(&candidate) {
        return Ok(crate::fs::normalize_path(&candidate));
    }

    let resolved = candidate
        .canonicalize()
        .map_err(|_| command_error(format!("Workspace path not found: {}", requested_workspace)))?;

    if !resolved.is_dir() {
        return Err(command_error(format!(
            "Workspace path must be a directory: {}",
            requested_workspace
        )));
    }

    Ok(resolved)
}

fn linux_path_is_same_or_child(root: &str, candidate: &str) -> bool {
    let root = root.trim_end_matches('/');
    candidate == root
        || candidate
            .strip_prefix(root)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn resolve_wsl_path_for_workspace(
    workspace: &Path,
    path: &str,
) -> CommandResult<Option<WslProjectPath>> {
    if let Some(wsl_path) = parse_wsl_unc_path(path) {
        return Ok(Some(wsl_path));
    }

    let workspace_string = workspace.to_string_lossy();
    let Some(wsl_workspace) = parse_wsl_unc_path(&workspace_string) else {
        return Ok(None);
    };

    let resolved =
        join_wsl_path(&wsl_workspace, path).map_err(|error| command_error(error.to_string()))?;
    if resolved.distro != wsl_workspace.distro
        || !linux_path_is_same_or_child(&wsl_workspace.linux_path, &resolved.linux_path)
    {
        return Err(command_error(format!(
            "Path escapes WSL workspace: {}",
            path
        )));
    }

    Ok(Some(resolved))
}

async fn resolve_confined_wsl_repo_path_for_workspace(
    workspace: &Path,
    path: &str,
) -> CommandResult<Option<WslProjectPath>> {
    let workspace_string = workspace.to_string_lossy();
    let Some(wsl_workspace) = parse_wsl_unc_path(&workspace_string) else {
        if parse_wsl_unc_path(path).is_some() {
            return Err(command_error(format!(
                "Repository path is outside the selected workspace: {}",
                path
            )));
        }
        return Ok(None);
    };

    let resolved = resolve_wsl_path_for_workspace(workspace, path)?
        .ok_or_else(|| command_error(format!("Invalid WSL repository path: {}", path)))?;
    if resolved.distro != wsl_workspace.distro {
        return Err(command_error(format!(
            "Repository path escapes WSL workspace: {}",
            path
        )));
    }
    let canonical = fs::canonical_wsl_path_within_workspace(&wsl_workspace, &resolved, Some(false))
        .await
        .map_err(|error| command_error(error.to_string()))?;
    Ok(Some(canonical))
}

fn validate_agent_git_repo_path(repo_path: &str, workspace: &Path) -> CommandResult<PathBuf> {
    let confined = crate::fs::validate_path(Path::new(repo_path), workspace)
        .map_err(|error| command_error(error.to_string()))?;
    git::validate_repo_path(confined.to_string_lossy().as_ref(), workspace)
        .map_err(|error| command_error(error.to_string()))
}

fn unsupported_wsl_workspace_tool(tool_id: &str) -> CommandError {
    command_error(format!(
        "Tool {} is not yet supported for WSL projects.",
        tool_id
    ))
}

fn remap_macro_tool_path(path: &str) -> String {
    if is_macro_scoped_path(path) {
        fs::map_macro_virtual_path(path)
    } else {
        path.to_string()
    }
}

fn to_macro_virtual_relative(path: &str) -> String {
    let normalized = path.trim().replace('\\', "/");
    if normalized.is_empty() || normalized == "." {
        ".macro".to_string()
    } else {
        format!(".macro/{}", normalized.trim_start_matches("./"))
    }
}

#[derive(Debug, Clone)]
pub(crate) enum ParsedPatchOperation {
    Add { path: String, lines: Vec<String> },
    Update { path: String, hunks: Vec<PatchHunk> },
    Delete { path: String },
}

impl ParsedPatchOperation {
    pub(crate) fn path(&self) -> &str {
        match self {
            Self::Add { path, .. } | Self::Update { path, .. } | Self::Delete { path } => path,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct PatchHunk {
    pub(crate) lines: Vec<PatchHunkLine>,
}

#[derive(Debug, Clone)]
pub(crate) struct PatchHunkLine {
    pub(crate) kind: char,
    pub(crate) content: String,
}

#[derive(Debug, Clone)]
pub(crate) struct PendingFileChange {
    pub(crate) display_path: String,
    pub(crate) effective_workspace: PathBuf,
    pub(crate) effective_path: String,
    pub(crate) absolute_path: PathBuf,
    pub(crate) status: String,
    pub(crate) new_content: Option<String>,
    pub(crate) created: bool,
    pub(crate) bytes_written: u64,
    pub(crate) additions: usize,
    pub(crate) deletions: usize,
    pub(crate) expected_revision: Option<String>,
    pub(crate) requested_unix_mode: Option<u32>,
}

pub(crate) fn parse_apply_patch(patch_text: &str) -> CommandResult<Vec<ParsedPatchOperation>> {
    let lines: Vec<&str> = patch_text.lines().collect();
    if lines.first().copied() != Some("*** Begin Patch") {
        return Err(command_error(
            "Invalid apply_patch payload: missing '*** Begin Patch' header.",
        ));
    }
    if lines.last().copied() != Some("*** End Patch") {
        return Err(command_error(
            "Invalid apply_patch payload: missing '*** End Patch' footer.",
        ));
    }

    let mut operations = Vec::new();
    let mut index = 1usize;
    while index + 1 < lines.len() {
        let line = lines[index];
        if line.trim().is_empty() {
            index += 1;
            continue;
        }

        if let Some(path) = line.strip_prefix("*** Add File: ") {
            let mut added_lines = Vec::new();
            index += 1;
            while index + 1 < lines.len() && !lines[index].starts_with("*** ") {
                let current = lines[index];
                let Some(content) = current.strip_prefix('+') else {
                    return Err(command_error(format!(
                        "Invalid add-file line for {}: expected '+' prefix.",
                        path
                    )));
                };
                added_lines.push(content.to_string());
                index += 1;
            }
            operations.push(ParsedPatchOperation::Add {
                path: path.trim().to_string(),
                lines: added_lines,
            });
            continue;
        }

        if let Some(path) = line.strip_prefix("*** Update File: ") {
            let mut hunks = Vec::new();
            let mut hunk_lines = Vec::new();
            index += 1;
            while index + 1 < lines.len() && !lines[index].starts_with("*** ") {
                let current = lines[index];
                if current == "@@" || current.starts_with("@@ ") {
                    if !hunk_lines.is_empty() {
                        hunks.push(PatchHunk { lines: hunk_lines });
                        hunk_lines = Vec::new();
                    }
                    index += 1;
                    continue;
                }

                let Some(kind) = current.chars().next() else {
                    return Err(command_error(format!(
                        "Invalid update hunk line for {}.",
                        path
                    )));
                };
                if !matches!(kind, ' ' | '+' | '-') {
                    return Err(command_error(format!(
                        "Invalid update hunk line for {}: expected ' ', '+', or '-'.",
                        path
                    )));
                }
                hunk_lines.push(PatchHunkLine {
                    kind,
                    content: current[1..].to_string(),
                });
                index += 1;
            }
            if !hunk_lines.is_empty() {
                hunks.push(PatchHunk { lines: hunk_lines });
            }
            if hunks.is_empty() {
                return Err(command_error(format!(
                    "Update patch for {} must contain at least one hunk.",
                    path
                )));
            }
            operations.push(ParsedPatchOperation::Update {
                path: path.trim().to_string(),
                hunks,
            });
            continue;
        }

        if let Some(path) = line.strip_prefix("*** Delete File: ") {
            operations.push(ParsedPatchOperation::Delete {
                path: path.trim().to_string(),
            });
            index += 1;
            continue;
        }

        return Err(command_error(format!(
            "Invalid apply_patch section header: {}",
            line
        )));
    }

    if operations.is_empty() {
        return Err(command_error(
            "Invalid apply_patch payload: no file operations were provided.",
        ));
    }

    Ok(operations)
}

pub fn validate_workspace_tool_execution(
    mode: &str,
    tool_id: &str,
    args: &Value,
) -> CommandResult<ToolValidationResult> {
    let candidate_path =
        json_arg_string(args, "path").or_else(|| json_arg_string(args, "repo_path"));
    let validation = validate_tool_execution(mode, tool_id, candidate_path.as_deref());
    if !validation.allowed || tool_id.trim() != "apply_patch" {
        return Ok(validation);
    }

    let patch_text = json_arg_string(args, "patch_text")
        .ok_or_else(|| command_error("Missing patch_text argument for apply_patch tool."))?;
    for operation in parse_apply_patch(&patch_text)? {
        let target_validation = validate_tool_execution(mode, tool_id, Some(operation.path()));
        if !target_validation.allowed {
            return Ok(target_validation);
        }
    }
    Ok(validation)
}

fn split_text_lines(content: &str) -> (Vec<String>, bool) {
    let trailing_newline = content.ends_with('\n');
    let mut lines = content
        .split('\n')
        .map(|line| line.to_string())
        .collect::<Vec<_>>();
    if trailing_newline {
        let _ = lines.pop();
    }
    (lines, trailing_newline)
}

pub(crate) fn join_text_lines(lines: &[String], trailing_newline: bool) -> String {
    let mut joined = lines.join("\n");
    if trailing_newline {
        joined.push('\n');
    }
    joined
}

fn find_line_sequence(lines: &[String], needle: &[String], start_index: usize) -> Option<usize> {
    if needle.is_empty() {
        return Some(start_index.min(lines.len()));
    }
    if needle.len() > lines.len() {
        return None;
    }

    for candidate_start in start_index..=lines.len().saturating_sub(needle.len()) {
        if lines[candidate_start..candidate_start + needle.len()] == *needle {
            return Some(candidate_start);
        }
    }
    None
}

pub(crate) fn apply_patch_hunks_to_content(
    path: &str,
    current_content: &str,
    hunks: &[PatchHunk],
) -> CommandResult<String> {
    let (mut lines, trailing_newline) = split_text_lines(current_content);
    let mut search_start = 0usize;

    for hunk in hunks {
        let old_lines = hunk
            .lines
            .iter()
            .filter(|line| line.kind != '+')
            .map(|line| line.content.clone())
            .collect::<Vec<_>>();
        let replacement_lines = hunk
            .lines
            .iter()
            .filter(|line| line.kind != '-')
            .map(|line| line.content.clone())
            .collect::<Vec<_>>();

        let replace_at = find_line_sequence(&lines, &old_lines, search_start).ok_or_else(|| {
            command_error(format!(
                "Patch hunk could not be applied cleanly to {}.",
                path
            ))
        })?;
        let replace_end = replace_at + old_lines.len();
        lines.splice(replace_at..replace_end, replacement_lines.iter().cloned());
        search_start = replace_at + replacement_lines.len();
    }

    Ok(join_text_lines(&lines, trailing_newline))
}

pub(crate) fn compute_line_change_stats(old_content: &str, new_content: &str) -> (usize, usize) {
    let old_lines = old_content.lines().collect::<Vec<_>>();
    let new_lines = new_content.lines().collect::<Vec<_>>();

    let mut prefix = 0usize;
    while prefix < old_lines.len()
        && prefix < new_lines.len()
        && old_lines[prefix] == new_lines[prefix]
    {
        prefix += 1;
    }

    let mut suffix = 0usize;
    while suffix < old_lines.len().saturating_sub(prefix)
        && suffix < new_lines.len().saturating_sub(prefix)
        && old_lines[old_lines.len() - 1 - suffix] == new_lines[new_lines.len() - 1 - suffix]
    {
        suffix += 1;
    }

    (
        new_lines.len().saturating_sub(prefix + suffix),
        old_lines.len().saturating_sub(prefix + suffix),
    )
}

pub(crate) fn exact_edit_match_error(
    path: &str,
    occurrences: usize,
    replace_all: bool,
) -> Option<String> {
    if occurrences == 0 {
        return Some(format!("No match found for old_text in {}.", path));
    }
    if !replace_all && occurrences > 1 {
        return Some(format!(
            "Cannot edit {}: old_text matched {} locations. Provide more context so it matches exactly once, or set replace_all to true.",
            path, occurrences
        ));
    }
    None
}

fn build_diff_summary(changes: &[PendingFileChange]) -> String {
    changes
        .iter()
        .map(|change| {
            format!(
                "{} {} (+{} -{})",
                change.status.to_uppercase(),
                change.display_path,
                change.additions,
                change.deletions
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn resolve_validated_tool_path(
    workspace: &Path,
    path: &str,
    for_write: bool,
) -> CommandResult<PathBuf> {
    if parse_wsl_unc_path(&workspace.to_string_lossy()).is_some() {
        if let Some(resolved) = resolve_wsl_path_for_workspace(workspace, path)? {
            return Ok(PathBuf::from(resolved.unc_path));
        }
    }

    let path_buf = PathBuf::from(path);
    if for_write {
        validate_fs_path_for_write(&path_buf, workspace)
            .map_err(|error| command_error(error.to_string()))
    } else {
        validate_fs_path(&path_buf, workspace).map_err(|error| command_error(error.to_string()))
    }
}

#[cfg(test)]
async fn write_bytes_atomically_with_parent_creation(
    path: &Path,
    bytes: &[u8],
    create_dirs: bool,
    expected_revision: Option<&str>,
    unix_mode: Option<u32>,
) -> CommandResult<()> {
    #[cfg(not(unix))]
    let _ = unix_mode;

    let parent = path
        .parent()
        .ok_or_else(|| command_error(format!("Invalid file path: {}", path.display())))?;
    if create_dirs {
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            command_error(format!(
                "Failed to create parent directory for {}: {}",
                path.display(),
                error
            ))
        })?;
    } else if !parent.exists() {
        return Err(command_error(format!(
            "Parent directory does not exist for {}: {}",
            path.display(),
            parent.display()
        )));
    }

    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    let temp_path = parent.join(format!(
        ".{}.macro-tmp-{}",
        file_name,
        uuid::Uuid::new_v4().simple()
    ));

    if let Err(error) = tokio::fs::write(&temp_path, bytes).await {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(command_error(format!(
            "Failed to write temporary file for {}: {}",
            path.display(),
            error
        )));
    }
    #[cfg(unix)]
    if let Some(mode) = unix_mode {
        if let Err(error) =
            tokio::fs::set_permissions(&temp_path, std::fs::Permissions::from_mode(mode & 0o7777))
                .await
        {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(command_error(format!(
                "Failed to restore permissions for {}: {}",
                path.display(),
                error
            )));
        }
    }
    if expected_revision.is_some() {
        let latest_revision = match tokio::fs::read(path).await {
            Ok(current) => Some(fs::content_revision(&current)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                let _ = tokio::fs::remove_file(&temp_path).await;
                return Err(command_error(format!(
                    "Failed to revalidate {} before rollback: {}",
                    path.display(),
                    error
                )));
            }
        };
        if let Err(error) = fs::validate_expected_revision(
            &path.to_string_lossy(),
            expected_revision,
            latest_revision.as_deref(),
        ) {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(command_error(error.to_string()));
        }
    }
    if let Err(error) = tokio::fs::rename(&temp_path, path).await {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(command_error(format!(
            "Failed to replace {} atomically: {}",
            path.display(),
            error
        )));
    }

    Ok(())
}

#[cfg(test)]
async fn rollback_pending_file_changes(
    backups: &[(PathBuf, Option<Vec<u8>>, Option<u32>)],
    applied_changes: &[PendingFileChange],
) -> Vec<String> {
    debug_assert_eq!(backups.len(), applied_changes.len());
    let mut errors = Vec::new();
    for ((path, backup, unix_mode), change) in backups.iter().zip(applied_changes).rev() {
        let state_matches_applied_mutation = match change.new_content.as_ref() {
            Some(content) => match tokio::fs::read(path).await {
                Ok(current) => {
                    fs::content_revision(&current) == fs::content_revision(content.as_bytes())
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                Err(error) => {
                    errors.push(format!(
                        "Failed to inspect {} before rollback: {}",
                        change.display_path, error
                    ));
                    false
                }
            },
            None => match tokio::fs::try_exists(path).await {
                Ok(exists) => !exists,
                Err(error) => {
                    errors.push(format!(
                        "Failed to inspect {} before rollback: {}",
                        change.display_path, error
                    ));
                    false
                }
            },
        };
        if !state_matches_applied_mutation {
            errors.push(format!(
                "Rollback conflict for {}: the current file no longer matches Macro's applied mutation; preserving the current filesystem state",
                change.display_path
            ));
            continue;
        }

        match backup {
            Some(bytes) => {
                let expected_revision = change
                    .new_content
                    .as_ref()
                    .map(|content| fs::content_revision(content.as_bytes()));
                if let Err(error) = write_bytes_atomically_with_parent_creation(
                    path,
                    bytes,
                    true,
                    expected_revision.as_deref(),
                    *unix_mode,
                )
                .await
                {
                    errors.push(format!(
                        "Failed to restore {} during rollback: {}",
                        path.display(),
                        error.message
                    ));
                }
            }
            None => match tokio::fs::try_exists(path).await {
                Ok(true) => {
                    if let Err(error) = tokio::fs::remove_file(path).await {
                        errors.push(format!(
                            "Failed to remove created file {} during rollback: {}",
                            path.display(),
                            error
                        ));
                    }
                }
                Ok(false) => {}
                Err(error) => errors.push(format!(
                    "Failed to inspect {} during rollback: {}",
                    path.display(),
                    error
                )),
            },
        }
    }
    errors
}

fn change_targets_wsl(change: &PendingFileChange) -> bool {
    parse_wsl_unc_path(&change.effective_workspace.to_string_lossy()).is_some()
}

async fn content_mutation_key(change: &PendingFileChange) -> CommandResult<String> {
    if let Some(target) =
        resolve_wsl_path_for_workspace(&change.effective_workspace, &change.effective_path)?
    {
        let workspace = parse_wsl_unc_path(&change.effective_workspace.to_string_lossy())
            .ok_or_else(|| command_error("Invalid WSL workspace path"))?;
        let canonical = fs::canonical_wsl_path_within_workspace(&workspace, &target, Some(false))
            .await
            .map_err(|error| command_error(error.to_string()))?;
        return Ok(wsl_content_mutation_key(&canonical));
    }
    Ok(native_content_mutation_key(&change.absolute_path).await)
}

async fn acquire_content_mutation_locks(
    changes: &[PendingFileChange],
) -> CommandResult<Vec<tokio::sync::OwnedMutexGuard<()>>> {
    let mut keys = Vec::with_capacity(changes.len());
    for change in changes {
        keys.push(content_mutation_key(change).await?);
    }
    keys.sort();
    keys.dedup();

    let locks = keys
        .iter()
        .map(|key| content_mutation_lock(key))
        .collect::<Vec<_>>();
    let mut guards = Vec::with_capacity(locks.len());
    for lock in locks {
        guards.push(lock.lock_owned().await);
    }
    Ok(guards)
}

async fn read_wsl_mutation_backup(
    workspace: &Path,
    path: &str,
) -> CommandResult<(Vec<u8>, Option<u32>)> {
    let target = resolve_wsl_path_for_workspace(workspace, path)?
        .ok_or_else(|| command_error(format!("Invalid WSL path: {}", path)))?;
    let wsl_workspace = parse_wsl_unc_path(&workspace.to_string_lossy())
        .ok_or_else(|| command_error("Invalid WSL workspace path"))?;
    let target = fs::canonical_wsl_path_within_workspace(&wsl_workspace, &target, Some(false))
        .await
        .map_err(|error| command_error(error.to_string()))?;
    let output = run_wsl_shell(
        &target,
        wsl_mutation_backup_read_script(),
        &[
            target.linux_path.clone(),
            fs::MAX_WRITE_SIZE_BYTES.saturating_add(1).to_string(),
        ],
        Duration::from_secs(10),
    )
    .await
    .map_err(|error| command_error(error.to_string()))?;
    let Some(separator) = output.stdout.iter().position(|byte| *byte == 0) else {
        return Err(command_error(format!(
            "Failed to read WSL backup metadata for {}",
            path
        )));
    };
    let mode = std::str::from_utf8(&output.stdout[..separator])
        .ok()
        .and_then(|value| u32::from_str_radix(value.trim(), 8).ok());
    let bytes = output.stdout[separator.saturating_add(1)..].to_vec();
    if bytes.len() as u64 > fs::MAX_WRITE_SIZE_BYTES {
        return Err(command_error(format!(
            "Backup for {} exceeds maximum write size of {} bytes",
            path,
            fs::MAX_WRITE_SIZE_BYTES
        )));
    }
    Ok((bytes, mode))
}

fn wsl_mutation_backup_read_script() -> &'static str {
    r#"
mode=$(stat -c '%a' -- "$1") || exit 4
printf '%s\0' "$mode"
head -c "$2" -- "$1"
"#
}

async fn write_wsl_backup_bytes(
    workspace: &Path,
    path: &str,
    bytes: &[u8],
    expected_revision: Option<&str>,
    unix_mode: Option<u32>,
) -> CommandResult<()> {
    let target = resolve_wsl_path_for_workspace(workspace, path)?
        .ok_or_else(|| command_error(format!("Invalid WSL path: {}", path)))?;
    let wsl_workspace = parse_wsl_unc_path(&workspace.to_string_lossy())
        .ok_or_else(|| command_error("Invalid WSL workspace path"))?;
    let target = fs::canonical_wsl_path_within_workspace(&wsl_workspace, &target, Some(false))
        .await
        .map_err(|error| command_error(error.to_string()))?;
    let output = run_wsl_shell_with_stdin(
        &target,
        wsl_mutation_backup_write_script(),
        &[
            target.linux_path.clone(),
            expected_revision.unwrap_or_default().to_string(),
            unix_mode
                .map(|mode| format!("{:o}", mode))
                .unwrap_or_default(),
        ],
        bytes.to_vec(),
        Duration::from_secs(15),
    )
    .await
    .map_err(|error| command_error(error.to_string()))?;
    if let Some(actual) = output
        .stdout_text()
        .lines()
        .find_map(|line| line.strip_prefix("revision_conflict actual="))
    {
        let actual_revision = if actual == fs::EXPECTED_REVISION_ABSENT || actual == "unavailable" {
            None
        } else {
            Some(actual)
        };
        fs::validate_expected_revision(path, expected_revision, actual_revision)
            .map_err(|error| command_error(error.to_string()))?;
        return Err(command_error(format!(
            "Revision conflict while restoring {}",
            path
        )));
    }
    Ok(())
}

fn wsl_mutation_backup_write_script() -> &'static str {
    r#"
p=$1
expected=$2
mode=$3
dir=$(dirname -- "$p") || exit 4
mkdir -p -- "$dir" || exit 4
actual=absent
if [ -f "$p" ]; then
  line=$(sha256sum -- "$p") || exit 5
  actual=${line%% *}
elif [ -e "$p" ] || [ -L "$p" ]; then
  actual=unavailable
fi
if [ -n "$expected" ] && [ "$actual" != "$expected" ]; then
  printf 'revision_conflict actual=%s\n' "$actual"
  exit 0
fi
tmp=$(mktemp "$dir/.macro-rollback.XXXXXX") || exit 6
cat >"$tmp" || { rm -f -- "$tmp"; exit 7; }
if [ -n "$mode" ]; then chmod "$mode" -- "$tmp" || { rm -f -- "$tmp"; exit 8; }; fi
mv -f -- "$tmp" "$p" || { rm -f -- "$tmp"; exit 9; }
"#
}

type MutationBackupEntry = (
    PathBuf,
    String,
    String,
    Option<Vec<u8>>,
    Option<u32>,
    Option<fs::WorkspaceCapabilityTarget>,
);

async fn rollback_pending_file_changes_via_fs(
    backups: &[MutationBackupEntry],
    applied_changes: &[PendingFileChange],
) -> Vec<String> {
    debug_assert_eq!(backups.len(), applied_changes.len());
    let mut errors = Vec::new();
    for ((workspace, path, display_path, backup, unix_mode, native_target), change) in
        backups.iter().zip(applied_changes).rev()
    {
        let expected_applied_revision = change
            .new_content
            .as_ref()
            .map(|content| fs::content_revision(content.as_bytes()));
        match backup {
            Some(content) => {
                let expected = Some(
                    expected_applied_revision
                        .as_deref()
                        .unwrap_or(fs::EXPECTED_REVISION_ABSENT),
                );
                let result = if let Some(target) = native_target {
                    fs::write_file_bytes_with_capability_target_unlocked(
                        target,
                        display_path,
                        content.clone(),
                        true,
                        expected,
                        *unix_mode,
                    )
                    .await
                    .map(|_| ())
                    .map_err(|error| command_error(error.to_string()))
                } else {
                    write_wsl_backup_bytes(workspace, path, content, expected, *unix_mode).await
                };
                if let Err(error) = result {
                    if error.message.contains("Revision conflict") {
                        errors.push(format!(
                            "Rollback conflict for {}: the current file no longer matches Macro's applied mutation; preserving the current filesystem state",
                            display_path
                        ));
                    } else {
                        errors.push(format!(
                            "Failed to restore {} during rollback: {}",
                            display_path, error.message
                        ));
                    }
                }
            }
            None => {
                if let Some(expected_revision) = expected_applied_revision.as_deref() {
                    let deletion = if let Some(target) = native_target {
                        fs::delete_file_with_capability_target_unlocked(
                            target,
                            display_path,
                            Some(expected_revision),
                        )
                        .await
                    } else {
                        fs::delete_path_internal_with_revision_unlocked(
                            workspace,
                            path.to_string(),
                            Some(false),
                            Some(expected_revision),
                        )
                        .await
                    };
                    if let Err(error) = deletion {
                        if error.to_string().contains("Revision conflict") {
                            errors.push(format!(
                                "Rollback conflict for {}: the current file no longer matches Macro's applied mutation; preserving the current filesystem state",
                                display_path
                            ));
                        } else {
                            errors.push(format!(
                                "Failed to remove created file {} during rollback: {}",
                                display_path, error
                            ));
                        }
                    }
                }
            }
        }
    }
    errors
}

/// Snapshots retained until post-mutation validation has finished so any
/// later failure can still be compensated.
///
/// Native and WSL targets retain raw bytes so rollback also works for binary
/// files. Non-WSL virtual-fs targets still route UTF-8 content through the
/// workspace fs primitives.
struct MutationBackups(Vec<MutationBackupEntry>);

const INTERNAL_CHECKPOINT_SNAPSHOTS_FIELD: &str = "__macro_checkpoint_snapshots";
const MAX_CHECKPOINT_FILES_PER_MUTATION: usize = 64;
const MAX_CHECKPOINT_TOTAL_BYTES: usize = 64 * 1024 * 1024;
const MAX_DURABLE_CHECKPOINT_JSON_BYTES: usize = 64 * 1024 * 1024;

pub(crate) fn mutation_response_fields(
    include_checkpoint_snapshots: bool,
    mut fields: serde_json::Map<String, Value>,
) -> serde_json::Map<String, Value> {
    if include_checkpoint_snapshots {
        fields.insert(
            INTERNAL_CHECKPOINT_SNAPSHOTS_FIELD.to_string(),
            Value::Bool(true),
        );
    }
    fields
}

fn missing_checkpoint_snapshot_json() -> Value {
    serde_json::json!({
        "exists": false,
        "content": Value::Null,
        "revision": Value::Null,
        "isBinary": false,
        "size": 0,
        "encoding": Value::Null,
        "language": Value::Null,
        "unixMode": Value::Null,
    })
}

fn checkpoint_before_snapshots(
    backups: &MutationBackups,
    changes: &[PendingFileChange],
) -> CommandResult<Vec<Value>> {
    let mut snapshots = Vec::with_capacity(changes.len());
    for (index, change) in changes.iter().enumerate() {
        let (backup, unix_mode) = backups
            .0
            .get(index)
            .map(|(_, _, _, backup, unix_mode, _)| (backup.as_deref(), *unix_mode))
            .ok_or_else(|| command_error("Checkpoint snapshot alignment failed"))?;
        let Some(bytes) = backup else {
            snapshots.push(missing_checkpoint_snapshot_json());
            continue;
        };
        let content = std::str::from_utf8(bytes).map_err(|_| {
            command_error(format!(
                "Cannot checkpoint binary file {}; refusing to make an unrewindable remote edit.",
                change.display_path
            ))
        })?;
        snapshots.push(serde_json::json!({
            "exists": true,
            "content": content,
            "revision": fs::content_revision(bytes),
            "isBinary": false,
            "size": bytes.len(),
            "encoding": "utf-8",
            "language": Value::Null,
            "unixMode": unix_mode,
        }));
    }
    Ok(snapshots)
}

fn validate_projected_durable_checkpoint_size(
    changes: &[PendingFileChange],
    backups: &MutationBackups,
    before: &[Value],
) -> CommandResult<()> {
    let files = changes
        .iter()
        .enumerate()
        .map(|(index, change)| {
            let after = match change.new_content.as_ref() {
                Some(content) => serde_json::json!({
                    "exists": true,
                    "content": content,
                    "revision": fs::content_revision(content.as_bytes()),
                    "isBinary": false,
                    "size": content.len(),
                    "encoding": "utf-8",
                    "language": Value::Null,
                    "unixMode": change.requested_unix_mode.or_else(|| {
                        backups.0.get(index).and_then(|entry| entry.4)
                    }),
                }),
                None => missing_checkpoint_snapshot_json(),
            };
            serde_json::json!({
                "path": change.display_path,
                "before": before.get(index).cloned().unwrap_or_else(missing_checkpoint_snapshot_json),
                "after": after,
            })
        })
        .collect::<Vec<_>>();
    let encoded = serde_json::to_vec(&serde_json::json!({ "files": files }))
        .map_err(|error| command_error(error.to_string()))?;
    if encoded.len() > MAX_DURABLE_CHECKPOINT_JSON_BYTES {
        return Err(command_error(format!(
            "The serialized checkpoint requires {} bytes, exceeding the {}-byte durable-result budget",
            encoded.len(),
            MAX_DURABLE_CHECKPOINT_JSON_BYTES
        )));
    }
    Ok(())
}

async fn build_checkpoint_snapshot_payload(
    changes: &[PendingFileChange],
    backups: &MutationBackups,
    before: Vec<Value>,
) -> CommandResult<Value> {
    let mut files = Vec::with_capacity(changes.len());
    for (index, change) in changes.iter().enumerate() {
        let native_target = backups.0.get(index).and_then(|entry| entry.5.as_ref());
        let after = if change.new_content.is_none() {
            missing_checkpoint_snapshot_json()
        } else if let Some(target) = native_target {
            let Some((bytes, unix_mode)) =
                fs::read_file_bytes_with_mode_from_capability_target(target)
                    .await
                    .map_err(|error| command_error(error.to_string()))?
            else {
                return Err(command_error(format!(
                    "Cannot checkpoint missing file {} after mutation.",
                    change.display_path
                )));
            };
            let content = String::from_utf8(bytes).map_err(|_| {
                command_error(format!(
                    "Cannot checkpoint binary file {}; refusing to publish an unrewindable remote edit.",
                    change.display_path
                ))
            })?;
            serde_json::json!({
                "exists": true,
                "content": content,
                "revision": fs::content_revision(content.as_bytes()),
                "isBinary": false,
                "size": content.len(),
                "encoding": "utf-8",
                "language": fs::capability_target_language(target),
                "unixMode": unix_mode,
            })
        } else {
            let readback = fs::read_file_internal(
                &change.effective_workspace,
                change.effective_path.clone(),
                Some(false),
            )
            .await
            .map_err(|error| command_error(error.to_string()))?;
            if readback.is_binary {
                return Err(command_error(format!(
                    "Cannot checkpoint binary file {}; refusing to publish an unrewindable remote edit.",
                    change.display_path
                )));
            }
            serde_json::json!({
                "exists": true,
                "content": readback.content,
                "revision": readback.revision,
                "isBinary": false,
                "size": readback.size,
                "encoding": readback.encoding,
                "language": readback.language,
                "unixMode": readback.unix_mode,
            })
        };
        files.push(serde_json::json!({
            "path": change.display_path,
            "before": before.get(index).cloned().unwrap_or_else(missing_checkpoint_snapshot_json),
            "after": after,
        }));
    }
    Ok(serde_json::json!({ "files": files }))
}

fn normalize_pending_change_metadata(
    changes: &mut [PendingFileChange],
    backups: &MutationBackups,
    extra_fields: &mut serde_json::Map<String, Value>,
) {
    for (index, change) in changes.iter_mut().enumerate() {
        let Some(new_content) = change.new_content.as_ref() else {
            continue;
        };
        let (existed, unchanged) = backups
            .0
            .get(index)
            .map(|(_, _, _, backup, _, _)| {
                (
                    backup.is_some(),
                    backup.as_deref() == Some(new_content.as_bytes()),
                )
            })
            .unwrap_or((false, false));
        change.created = !existed;
        change.status = if existed { "updated" } else { "created" }.to_string();
        change.bytes_written = if unchanged {
            0
        } else {
            new_content.len() as u64
        };
    }

    if let [change] = changes {
        if change.new_content.is_some() {
            extra_fields.insert("created".to_string(), Value::Bool(change.created));
            extra_fields.insert(
                "bytes_written".to_string(),
                Value::Number(serde_json::Number::from(change.bytes_written)),
            );
        }
    }
}

async fn rollback_mutation_backups(
    backups: &MutationBackups,
    changes: &[PendingFileChange],
) -> Vec<String> {
    rollback_pending_file_changes_via_fs(&backups.0, changes).await
}

fn validate_checkpoint_size_values(
    file_count: usize,
    backup_bytes: usize,
    next_bytes: usize,
) -> CommandResult<()> {
    if file_count > MAX_CHECKPOINT_FILES_PER_MUTATION {
        return Err(command_error(format!(
            "A recoverable mutation may affect at most {MAX_CHECKPOINT_FILES_PER_MUTATION} files"
        )));
    }
    let total_bytes = backup_bytes.checked_add(next_bytes).ok_or_else(|| {
        command_error("Recoverable mutation checkpoint size overflowed its safety limit")
    })?;
    if total_bytes > MAX_CHECKPOINT_TOTAL_BYTES {
        return Err(command_error(format!(
            "Recoverable mutation snapshots total {total_bytes} bytes, exceeding the {MAX_CHECKPOINT_TOTAL_BYTES}-byte limit"
        )));
    }
    Ok(())
}

fn validate_checkpoint_batch_size(
    changes: &[PendingFileChange],
    backups: &MutationBackups,
) -> CommandResult<()> {
    let backup_bytes = backups
        .0
        .iter()
        .try_fold(0usize, |total, (_, _, _, backup, _, _)| {
            total.checked_add(backup.as_ref().map_or(0, Vec::len))
        })
        .ok_or_else(|| {
            command_error("Recoverable mutation checkpoint size overflowed its safety limit")
        })?;
    let next_bytes = changes
        .iter()
        .try_fold(0usize, |total, change| {
            total.checked_add(change.new_content.as_ref().map_or(0, String::len))
        })
        .ok_or_else(|| {
            command_error("Recoverable mutation checkpoint size overflowed its safety limit")
        })?;
    validate_checkpoint_size_values(changes.len(), backup_bytes, next_bytes)
}

async fn prepare_mutation_backups(changes: &[PendingFileChange]) -> CommandResult<MutationBackups> {
    if changes.len() > MAX_CHECKPOINT_FILES_PER_MUTATION {
        return Err(command_error(format!(
            "A recoverable mutation may affect at most {MAX_CHECKPOINT_FILES_PER_MUTATION} files"
        )));
    }
    for change in changes {
        if change
            .new_content
            .as_ref()
            .is_some_and(|content| content.len() as u64 > fs::MAX_WRITE_SIZE_BYTES)
        {
            return Err(command_error(format!(
                "Content for {} exceeds maximum write size of {} bytes",
                change.display_path,
                fs::MAX_WRITE_SIZE_BYTES
            )));
        }
    }
    let mut backups = Vec::with_capacity(changes.len());
    for change in changes {
        let (backup, native_target) = if change_targets_wsl(change) {
            if fs::exists_internal(&change.effective_workspace, change.effective_path.clone())
                .await
                .map_err(|error| {
                    command_error(format!(
                        "Failed to inspect {} before write: {}",
                        change.display_path, error
                    ))
                })?
            {
                (
                    Some(
                        read_wsl_mutation_backup(
                            &change.effective_workspace,
                            &change.effective_path,
                        )
                        .await
                        .map_err(|error| {
                            command_error(format!(
                                "Failed to prepare backup for {}: {}",
                                change.display_path, error.message
                            ))
                        })?,
                    ),
                    None,
                )
            } else {
                (None, None)
            }
        } else {
            let target = fs::open_workspace_capability_target_internal(
                &change.effective_workspace,
                change.effective_path.clone(),
            )
            .await
            .map_err(|error| command_error(error.to_string()))?;
            let backup = fs::read_file_bytes_with_mode_from_capability_target(&target)
                .await
                .map_err(|error| command_error(error.to_string()))?;
            (backup, Some(target))
        };
        if let Some((bytes, _)) = backup.as_ref() {
            if bytes.len() as u64 > fs::MAX_WRITE_SIZE_BYTES {
                return Err(command_error(format!(
                    "Backup for {} exceeds maximum write size of {} bytes",
                    change.display_path,
                    fs::MAX_WRITE_SIZE_BYTES
                )));
            }
        }
        fs::validate_expected_revision(
            &change.display_path,
            change.expected_revision.as_deref(),
            backup
                .as_ref()
                .map(|(bytes, _)| fs::content_revision(bytes))
                .as_deref(),
        )
        .map_err(|error| command_error(error.to_string()))?;
        let (backup, unix_mode) = backup
            .map(|(content, unix_mode)| (Some(content), unix_mode))
            .unwrap_or((None, None));
        backups.push((
            change.effective_workspace.clone(),
            change.effective_path.clone(),
            change.display_path.clone(),
            backup,
            unix_mode,
            native_target,
        ));
    }
    let backups = MutationBackups(backups);
    validate_checkpoint_batch_size(changes, &backups)?;
    Ok(backups)
}

async fn apply_mutation_backups(
    changes: &[PendingFileChange],
    backups: &MutationBackups,
    create_dirs: bool,
) -> CommandResult<()> {
    for (applied_count, change) in changes.iter().enumerate() {
        let native_target = backups.0[applied_count].5.as_ref();
        let result = if let Some(new_content) = change.new_content.as_ref() {
            if let Some(target) = native_target {
                fs::write_file_bytes_with_capability_target_unlocked(
                    target,
                    &change.display_path,
                    new_content.as_bytes().to_vec(),
                    create_dirs,
                    change.expected_revision.as_deref(),
                    change.requested_unix_mode,
                )
                .await
                .map(|_| ())
            } else {
                fs::write_file_internal_with_revision_and_mode_unlocked(
                    &change.effective_workspace,
                    change.effective_path.clone(),
                    new_content.clone(),
                    Some(create_dirs),
                    Some(false),
                    change.expected_revision.as_deref(),
                    change.requested_unix_mode,
                )
                .await
                .map(|_| ())
            }
        } else {
            let deletion = if let Some(target) = native_target {
                fs::delete_file_with_capability_target_unlocked(
                    target,
                    &change.display_path,
                    change.expected_revision.as_deref(),
                )
                .await
            } else {
                fs::delete_path_internal_with_revision_unlocked(
                    &change.effective_workspace,
                    change.effective_path.clone(),
                    Some(false),
                    change.expected_revision.as_deref(),
                )
                .await
            };
            deletion.map_err(|error| BackendError::Filesystem {
                message: format!("Failed to delete {}: {}", change.display_path, error),
            })
        };

        if let Err(error) = result {
            let rollback_errors = rollback_pending_file_changes_via_fs(
                &backups.0[..applied_count],
                &changes[..applied_count],
            )
            .await;
            return Err(command_error(format!(
                "{}{}",
                error,
                rollback_error_suffix(rollback_errors)
            )));
        }
    }

    Ok(())
}

/// Applies pending changes and validates them before reporting success.
///
/// Mutations are only considered committed once every target re-reads with the
/// produced revisions. Until then the snapshots and per-path mutation locks
/// are held: on any post-mutation validation failure all still-restorable
/// targets are restored (CAS-guarded, never overwriting an external edit),
/// rollback continues past conflicts, and every error is aggregated into the
/// returned failure. A failed call therefore never leaves a Macro mutation
/// silently applied.
pub(crate) async fn commit_and_validate_pending_file_changes(
    changes: Vec<PendingFileChange>,
    extra_fields: serde_json::Map<String, Value>,
) -> CommandResult<String> {
    commit_with_post_mutation_gate(changes, extra_fields, true, |_| true).await
}

pub(crate) async fn commit_and_validate_pending_file_changes_with_create_dirs(
    changes: Vec<PendingFileChange>,
    extra_fields: serde_json::Map<String, Value>,
    create_dirs: bool,
) -> CommandResult<String> {
    commit_with_post_mutation_gate(changes, extra_fields, create_dirs, |_| true).await
}

/// Testable variant of [`commit_and_validate_pending_file_changes`].
///
/// `post_mutation_gate` runs after the mutations were applied but before the
/// filesystem readback. Returning `false` simulates a failed post-mutation
/// validation; the closure may also mutate the filesystem to simulate an
/// external writer racing with Macro between the mutations and their
/// compensation.
async fn commit_with_post_mutation_gate<G>(
    mut changes: Vec<PendingFileChange>,
    mut extra_fields: serde_json::Map<String, Value>,
    create_dirs: bool,
    post_mutation_gate: G,
) -> CommandResult<String>
where
    G: FnOnce(&[PendingFileChange]) -> bool,
{
    let include_checkpoint_snapshots = extra_fields
        .remove(INTERNAL_CHECKPOINT_SNAPSHOTS_FIELD)
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let _mutation_guards = acquire_content_mutation_locks(&changes).await?;
    let backups = prepare_mutation_backups(&changes).await?;
    let checkpoint_before = include_checkpoint_snapshots
        .then(|| checkpoint_before_snapshots(&backups, &changes))
        .transpose()?;
    if let Some(before) = checkpoint_before.as_deref() {
        validate_projected_durable_checkpoint_size(&changes, &backups, before)?;
    }
    normalize_pending_change_metadata(&mut changes, &backups, &mut extra_fields);
    apply_mutation_backups(&changes, &backups, create_dirs).await?;

    let mut report = if post_mutation_gate(&changes) {
        validate_post_write_changes(&changes, &backups).await
    } else {
        PostWriteValidationReport {
            files: Vec::new(),
            validation_files: Vec::new(),
            errors: changes
                .iter()
                .map(|change| {
                    format!(
                        "Injected post-mutation validation failure for {}.",
                        change.display_path
                    )
                })
                .collect::<Vec<_>>(),
        }
    };

    let checkpoint_payload = if report.errors.is_empty() {
        if let Some(before) = checkpoint_before {
            match build_checkpoint_snapshot_payload(&changes, &backups, before).await {
                Ok(payload) => Some(payload),
                Err(error) => {
                    report.errors.push(error.message);
                    None
                }
            }
        } else {
            None
        }
    } else {
        None
    };

    if report.errors.is_empty() {
        if let Some(payload) = checkpoint_payload {
            extra_fields.insert(INTERNAL_CHECKPOINT_SNAPSHOTS_FIELD.to_string(), payload);
        }
        return assemble_post_write_response(&changes, report, extra_fields);
    }

    let rollback_errors = rollback_mutation_backups(&backups, &changes).await;
    Err(command_error(format!(
        "Post-mutation validation failed; Macro's mutations were rolled back where still possible. Validation errors: {}{}",
        report.errors.join("; "),
        rollback_error_suffix(rollback_errors)
    )))
}

struct PostWriteValidationReport {
    files: Vec<Value>,
    validation_files: Vec<Value>,
    errors: Vec<String>,
}

/// Re-reads every mutated target after the mutations were applied.
///
/// Readback or existence problems are collected as errors instead of being
/// returned immediately so the caller can compensate the whole batch before
/// reporting a failure.
async fn validate_post_write_changes(
    changes: &[PendingFileChange],
    backups: &MutationBackups,
) -> PostWriteValidationReport {
    let mut report = PostWriteValidationReport {
        files: Vec::with_capacity(changes.len()),
        validation_files: Vec::with_capacity(changes.len()),
        errors: Vec::new(),
    };

    for (index, change) in changes.iter().enumerate() {
        let native_target = backups.0.get(index).and_then(|entry| entry.5.as_ref());
        let validation = if let Some(new_content) = change.new_content.as_ref() {
            let readback = if let Some(target) = native_target {
                match fs::read_file_bytes_with_mode_from_capability_target(target).await {
                    Ok(Some((bytes, _))) => Ok((
                        bytes.len() as u64,
                        fs::capability_target_language(target),
                        fs::content_revision(&bytes),
                    )),
                    Ok(None) => Err("file is missing".to_string()),
                    Err(error) => Err(error.to_string()),
                }
            } else {
                let metadata =
                    fs::stat_internal(&change.effective_workspace, change.effective_path.clone())
                        .await;
                let revision = fs::file_content_revision_internal(
                    &change.effective_workspace,
                    change.effective_path.clone(),
                )
                .await;
                match (metadata, revision) {
                    (Ok(metadata), Ok(revision)) => Ok((
                        metadata.size,
                        metadata.language.unwrap_or_else(|| "Unknown".to_string()),
                        revision,
                    )),
                    (metadata, revision) => Err([
                        metadata.err().map(|error| error.to_string()),
                        revision.err().map(|error| error.to_string()),
                    ]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join("; ")),
                }
            };
            match readback {
                Ok((size, language, readback_revision)) => {
                    let expected_revision = fs::content_revision(new_content.as_bytes());
                    if expected_revision != readback_revision {
                        report.errors.push(format!(
                            "External modification detected for {} after mutation: expected revision {} but guarded readback found {}. Preserving the external state.",
                            change.display_path, expected_revision, readback_revision
                        ));
                    }
                    serde_json::json!({
                        "path": change.display_path,
                        "exists": true,
                        "readable": true,
                        "is_binary": false,
                        "size": size,
                        "encoding": "utf-8",
                        "language": language,
                        "revision": readback_revision,
                    })
                }
                Err(details) => {
                    report.errors.push(format!(
                        "Validation failed for {}: {}",
                        change.display_path, details
                    ));
                    serde_json::json!({
                        "path": change.display_path,
                        "exists": true,
                        "readable": false,
                        "is_binary": false,
                        "size": 0,
                        "encoding": Value::Null,
                        "language": Value::Null,
                        "revision": Value::Null,
                    })
                }
            }
        } else {
            let existence = if let Some(target) = native_target {
                fs::read_file_bytes_with_mode_from_capability_target(target)
                    .await
                    .map(|current| current.is_some())
            } else {
                fs::exists_internal(&change.effective_workspace, change.effective_path.clone())
                    .await
            };
            match existence {
                Ok(exists) => {
                    if exists {
                        report.errors.push(format!(
                            "Deletion validation failed for {}: file still exists.",
                            change.display_path
                        ));
                    }
                    serde_json::json!({
                        "path": change.display_path,
                        "exists": exists,
                        "readable": false,
                        "is_binary": false,
                        "size": 0,
                        "encoding": Value::Null,
                        "language": Value::Null,
                        "revision": Value::Null,
                    })
                }
                Err(error) => {
                    report.errors.push(format!(
                        "Failed to validate deleted file {}: {}",
                        change.display_path, error
                    ));
                    serde_json::json!({
                        "path": change.display_path,
                        "exists": false,
                        "readable": false,
                        "is_binary": false,
                        "size": 0,
                        "encoding": Value::Null,
                        "language": Value::Null,
                        "revision": Value::Null,
                    })
                }
            }
        };

        report.validation_files.push(validation.clone());
        report.files.push(serde_json::json!({
            "path": change.display_path,
            "status": change.status,
            "additions": change.additions,
            "deletions": change.deletions,
            "created": change.created,
            "bytes_written": change.bytes_written,
            "validation": validation,
        }));
    }

    report
}

fn assemble_post_write_response(
    changes: &[PendingFileChange],
    report: PostWriteValidationReport,
    extra_fields: serde_json::Map<String, Value>,
) -> CommandResult<String> {
    let succeeded = report.errors.is_empty();
    let PostWriteValidationReport {
        files,
        validation_files,
        errors,
    } = report;

    let mut response = serde_json::Map::new();
    response.insert("ok".to_string(), Value::Bool(succeeded));
    response.insert("files".to_string(), Value::Array(files));
    response.insert(
        "diff".to_string(),
        Value::String(build_diff_summary(changes)),
    );
    response.insert("diagnostics".to_string(), Value::Array(Vec::new()));
    response.insert(
        "validation".to_string(),
        serde_json::json!({
            "all_files_readable": succeeded,
            "files": validation_files,
        }),
    );
    response.insert(
        "errors".to_string(),
        Value::Array(errors.into_iter().map(Value::String).collect()),
    );
    response.extend(extra_fields);

    serde_json::to_string_pretty(&Value::Object(response))
        .map_err(|error| command_error(error.to_string()))
}

fn rollback_error_suffix(rollback_errors: Vec<String>) -> String {
    if rollback_errors.is_empty() {
        String::new()
    } else {
        format!(" Rollback errors: {}", rollback_errors.join("; "))
    }
}

fn format_bounded_git_status(
    repo_path: &str,
    status: git::GitStatusDto,
    args: &Value,
) -> CommandResult<String> {
    let staged_count = status.staged_files.len();
    let unstaged_count = status.unstaged_files.len();
    let untracked_count = status.untracked_files.len();
    let conflicted_count = status.conflicted_files.len();
    let mut entries =
        Vec::with_capacity(staged_count + unstaged_count + untracked_count + conflicted_count);
    for file in status.staged_files {
        entries.push(serde_json::json!({ "category": "staged", "file": file }));
    }
    for file in status.unstaged_files {
        entries.push(serde_json::json!({ "category": "unstaged", "file": file }));
    }
    for file in status.untracked_files {
        entries.push(serde_json::json!({ "category": "untracked", "file": file }));
    }
    for path in status.conflicted_files {
        entries.push(serde_json::json!({ "category": "conflicted", "path": path }));
    }
    let snapshot =
        serde_json::to_vec(&entries).map_err(|error| command_error(error.to_string()))?;
    let revision = fs::content_revision(&snapshot);
    let cursor_scope = format!("git_status\0{repo_path}\0{revision}");
    let total_count = entries.len();
    let page = tool_output::paginate_items(
        &entries,
        args,
        &cursor_scope,
        tool_output::GIT_STATUS_DEFAULT_LIMIT,
        tool_output::GIT_STATUS_MAX_LIMIT,
    )?;
    let mut staged_files = Vec::new();
    let mut unstaged_files = Vec::new();
    let mut untracked_files = Vec::new();
    let mut conflicted_files = Vec::new();
    for entry in page.items {
        match entry.get("category").and_then(Value::as_str) {
            Some("staged") => staged_files.push(entry["file"].clone()),
            Some("unstaged") => unstaged_files.push(entry["file"].clone()),
            Some("untracked") => untracked_files.push(entry["file"].clone()),
            Some("conflicted") => conflicted_files.push(entry["path"].clone()),
            _ => {}
        }
    }

    serde_json::to_string_pretty(&serde_json::json!({
        "repo_path": repo_path,
        "branch": status.branch,
        "head_commit": status.head_commit,
        "staged_files": staged_files,
        "unstaged_files": unstaged_files,
        "untracked_files": untracked_files,
        "conflicted_files": conflicted_files,
        "merge_in_progress": status.merge_in_progress,
        "is_clean": status.is_clean,
        "has_origin": status.has_origin,
        "has_upstream": status.has_upstream,
        "ahead": status.ahead,
        "behind": status.behind,
        "counts": {
            "staged": staged_count,
            "unstaged": unstaged_count,
            "untracked": untracked_count,
            "conflicted": conflicted_count
        },
        "total_count": total_count,
        "limit": page.limit,
        "offset": page.offset,
        "truncated": page.truncated,
        "next_cursor": page.next_cursor,
        "revision": revision
    }))
    .map_err(|error| command_error(error.to_string()))
}

fn format_bounded_git_log(
    repo_path: &str,
    mut commits: Vec<git::GitCommitDto>,
    page: tool_output::ToolPage,
    cursor_scope: &str,
) -> CommandResult<String> {
    let truncated = commits.len() > page.limit;
    if truncated {
        commits.truncate(page.limit);
    }
    let next_cursor = truncated
        .then(|| tool_output::create_tool_cursor(cursor_scope, page.offset + commits.len()));
    serde_json::to_string_pretty(&serde_json::json!({
        "repo_path": repo_path,
        "count": commits.len(),
        "commits": commits,
        "limit": page.limit,
        "offset": page.offset,
        "truncated": truncated,
        "next_cursor": next_cursor,
        "total_count": (!truncated).then_some(page.offset + commits.len()),
        "total_is_exact": !truncated
    }))
    .map_err(|error| command_error(error.to_string()))
}

#[allow(clippy::too_many_arguments)]
pub async fn execute_workspace_tool(
    default_workspace: PathBuf,
    metadata_workspace: PathBuf,
    git_state: GitState,
    mode: String,
    tool_id: String,
    args: Value,
    workspace_path: Option<String>,
    workspace_scope: Option<String>,
    project_mounts: Option<Vec<WorkspaceProjectMount>>,
    virtual_root_enabled: Option<bool>,
    focused_project_id: Option<String>,
) -> CommandResult<String> {
    execute_workspace_tool_controlled(
        default_workspace,
        metadata_workspace,
        git_state,
        mode,
        tool_id,
        args,
        workspace_path,
        workspace_scope,
        project_mounts,
        virtual_root_enabled,
        focused_project_id,
        None,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn execute_workspace_tool_controlled(
    default_workspace: PathBuf,
    metadata_workspace: PathBuf,
    git_state: GitState,
    mode: String,
    tool_id: String,
    args: Value,
    workspace_path: Option<String>,
    workspace_scope: Option<String>,
    project_mounts: Option<Vec<WorkspaceProjectMount>>,
    virtual_root_enabled: Option<bool>,
    focused_project_id: Option<String>,
    execution_id: Option<String>,
) -> CommandResult<String> {
    execute_workspace_tool_controlled_with_options(
        default_workspace,
        metadata_workspace,
        git_state,
        mode,
        tool_id,
        args,
        workspace_path,
        workspace_scope,
        project_mounts,
        virtual_root_enabled,
        focused_project_id,
        execution_id,
        WorkspaceToolExecutionOptions::default(),
    )
    .await
}

#[derive(Clone, Debug, Default)]
pub struct WorkspaceToolExecutionOptions {
    pub capture_checkpoint_snapshots: bool,
    pub raw_checkpoint_snapshot: bool,
    pub expected_workspace_roots:
        Option<Arc<std::collections::BTreeMap<PathBuf, fs::WorkspaceRootIdentity>>>,
}

#[allow(clippy::too_many_arguments)]
pub async fn execute_workspace_tool_controlled_with_options(
    default_workspace: PathBuf,
    metadata_workspace: PathBuf,
    git_state: GitState,
    mode: String,
    tool_id: String,
    args: Value,
    workspace_path: Option<String>,
    workspace_scope: Option<String>,
    project_mounts: Option<Vec<WorkspaceProjectMount>>,
    virtual_root_enabled: Option<bool>,
    focused_project_id: Option<String>,
    execution_id: Option<String>,
    internal_options: WorkspaceToolExecutionOptions,
) -> CommandResult<String> {
    let Some(timeout_duration) = tool_execution_timeout(tool_id.trim()) else {
        let expected_workspace_roots = internal_options.expected_workspace_roots.clone();
        let execution = execute_workspace_tool_inner(
            default_workspace,
            metadata_workspace,
            git_state,
            mode,
            tool_id,
            args,
            workspace_path,
            workspace_scope,
            project_mounts,
            virtual_root_enabled,
            focused_project_id,
            None,
            internal_options,
        );
        return match expected_workspace_roots {
            Some(roots) => fs::with_expected_workspace_roots(roots, execution).await,
            None => execution.await,
        };
    };
    let registration = register_tool_execution(execution_id.as_deref());
    let cancellation = registration
        .as_ref()
        .map(|(cancellation, _)| cancellation.clone());
    let _guard = registration.map(|(_, guard)| guard);
    let cancellation = cancellation.unwrap_or_else(|| Arc::new(ToolCancellation::new()));
    let tool_label = tool_id.trim().to_string();
    let expected_workspace_roots = internal_options.expected_workspace_roots.clone();
    let inner_execution = execute_workspace_tool_inner(
        default_workspace,
        metadata_workspace,
        git_state,
        mode,
        tool_id,
        args,
        workspace_path,
        workspace_scope,
        project_mounts,
        virtual_root_enabled,
        focused_project_id,
        Some(cancellation.clone()),
        internal_options,
    );
    let execution = async move {
        match expected_workspace_roots {
            Some(roots) => fs::with_expected_workspace_roots(roots, inner_execution).await,
            None => inner_execution.await,
        }
    };
    tokio::pin!(execution);

    if execution_id.is_some() {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(command_error(format!(
                "Tool execution cancelled: {tool_label}."
            ))),
            _ = tokio::time::sleep(timeout_duration) => {
                cancellation.cancel();
                Err(command_error(format!(
                    "Tool execution timed out after {} seconds: {tool_label}. Narrow the path, pattern, or query before retrying.",
                    timeout_duration.as_secs()
                )))
            },
            result = &mut execution => result,
        }
    } else {
        match timeout(timeout_duration, &mut execution).await {
            Ok(result) => result,
            Err(_) => {
                cancellation.cancel();
                Err(command_error(format!(
                    "Tool execution timed out after {} seconds: {tool_label}. Narrow the path, pattern, or query before retrying.",
                    timeout_duration.as_secs()
                )))
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_workspace_tool_inner(
    default_workspace: PathBuf,
    metadata_workspace: PathBuf,
    git_state: GitState,
    mode: String,
    tool_id: String,
    args: Value,
    workspace_path: Option<String>,
    workspace_scope: Option<String>,
    project_mounts: Option<Vec<WorkspaceProjectMount>>,
    virtual_root_enabled: Option<bool>,
    focused_project_id: Option<String>,
    cancellation: Option<Arc<ToolCancellation>>,
    internal_options: WorkspaceToolExecutionOptions,
) -> CommandResult<String> {
    let workspace = resolve_requested_workspace(
        &default_workspace,
        &metadata_workspace,
        workspace_path.as_deref(),
    )?;
    let mode_trimmed = mode.trim().to_string();
    let tool_trimmed = tool_id.trim().to_string();

    let validation = validate_workspace_tool_execution(&mode_trimmed, &tool_trimmed, &args)?;

    if !validation.allowed {
        return Ok(validation
            .reason
            .unwrap_or_else(|| format!("Tool {} is not allowed", tool_trimmed)));
    }

    if virtual_root_enabled.unwrap_or(false) {
        if let Some(result) = workspace_tools::execute_virtual_workspace_tool(
            &mode_trimmed,
            &tool_trimmed,
            &args,
            project_mounts.as_deref().unwrap_or(&[]),
            focused_project_id.as_deref(),
            cancellation.clone(),
            internal_options.capture_checkpoint_snapshots,
        )
        .await?
        {
            return Ok(result);
        }
    }

    match tool_trimmed.as_str() {
        "list" => {
            let path = json_arg_string(&args, "path").unwrap_or_else(|| ".".to_string());
            let effective_path = remap_macro_tool_path(path.as_str());
            let list_is_macro_scope = is_macro_scoped_path(path.as_str());
            let recursive = json_arg_bool(&args, "recursive");
            let include_hidden = json_arg_bool(&args, "include_hidden");
            let max_depth = json_arg_u32(&args, "max_depth");
            let effective_workspace = resolve_workspace_for_tool_path(
                &workspace,
                &git_state,
                Some(path.as_str()),
                workspace_scope.as_deref(),
            )
            .await?;
            let mut entries = fs::list_dir_internal(
                &effective_workspace,
                effective_path.clone(),
                recursive,
                include_hidden,
                max_depth,
                Some(false),
            )
            .await
            .map_err(|error| command_error(error.to_string()))?;

            if list_is_macro_scope {
                for entry in entries.iter_mut() {
                    entry.relative_path = to_macro_virtual_relative(&entry.relative_path);
                }
            }

            entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
            let cursor_scope = format!(
                "list\0{}\0{}\0{}\0{}\0{}",
                effective_workspace.to_string_lossy(),
                effective_path,
                recursive.unwrap_or(false),
                include_hidden.unwrap_or(false),
                max_depth.map_or_else(String::new, |value| value.to_string())
            );
            let total_count = entries.len();
            let page = tool_output::paginate_items(
                &entries,
                &args,
                &cursor_scope,
                tool_output::LIST_DEFAULT_LIMIT,
                tool_output::LIST_MAX_LIMIT,
            )?;

            serde_json::to_string_pretty(&serde_json::json!({
                "path": path,
                "count": page.items.len(),
                "total_count": total_count,
                "entries": page.items,
                "limit": page.limit,
                "offset": page.offset,
                "truncated": page.truncated,
                "next_cursor": page.next_cursor
            }))
            .map_err(|error| command_error(error.to_string()))
        }
        "read" => {
            let path = json_arg_string(&args, "path")
                .ok_or_else(|| command_error("Missing path argument for read tool."))?;
            let effective_path = remap_macro_tool_path(path.as_str());
            let effective_workspace = resolve_workspace_for_tool_path(
                &workspace,
                &git_state,
                Some(path.as_str()),
                workspace_scope.as_deref(),
            )
            .await?;

            let raw_checkpoint_snapshot = internal_options.raw_checkpoint_snapshot;
            if raw_checkpoint_snapshot
                && !fs::exists_internal(&effective_workspace, effective_path.clone())
                    .await
                    .map_err(|error| command_error(error.to_string()))?
            {
                return serde_json::to_string(&missing_checkpoint_snapshot_json())
                    .map_err(|error| command_error(error.to_string()));
            }

            let result =
                fs::read_file_internal(&effective_workspace, effective_path.clone(), Some(false))
                    .await
                    .map_err(|error| command_error(error.to_string()))?;

            if raw_checkpoint_snapshot {
                if result.is_binary {
                    return Err(command_error(format!(
                        "Cannot checkpoint binary file {}; refusing an unrewindable remote replay.",
                        path
                    )));
                }
                return serde_json::to_string(&serde_json::json!({
                    "exists": true,
                    "content": result.content,
                    "revision": result.revision,
                    "isBinary": false,
                    "size": result.size,
                    "encoding": result.encoding,
                    "language": result.language,
                    "unixMode": result.unix_mode,
                }))
                .map_err(|error| command_error(error.to_string()));
            }

            if result.is_binary {
                return Ok(format!(
                    "FILE: {}\nSOURCE: WORKSPACE_FILE\nBINARY: true\nSIZE: {}\nENCODING: {}\nREVISION: {}\nCONTENT_OMITTED: binary",
                    path, result.size, result.encoding, result.revision
                ));
            }

            let end_line_scope =
                json_arg_u32(&args, "end_line").map_or_else(String::new, |value| value.to_string());
            let cursor_scope = format!(
                "read\0{}\0{}\0{}\0{}",
                effective_workspace.to_string_lossy(),
                effective_path,
                result.revision,
                end_line_scope
            );
            let page = tool_output::paginate_read_content(&result.content, &args, &cursor_scope)?;
            let selected = page.lines.iter().map(String::as_str).collect::<Vec<_>>();
            let numbered = format_with_line_numbers(&selected, page.start_line);
            Ok(format!(
                "FILE: {}\nSOURCE: WORKSPACE_FILE\nLANGUAGE: {}\nSIZE: {}\nREVISION: {}\nLINES: {}-{}\nTOTAL_LINES: {}\nRETURNED_LINES: {}\nTRUNCATED: {}\nNEXT_CURSOR: {}\nLIMITS: max_lines={}, max_bytes={}, max_columns={}\nCOLUMN_TRUNCATED_LINES: {}\n\n---BEGIN FILE CONTENT---\n{}\n---END FILE CONTENT---",
                path,
                result.language,
                result.size,
                result.revision,
                page.start_line,
                page.end_line,
                page.total_lines,
                page.returned_lines,
                page.truncated,
                page.next_cursor.as_deref().unwrap_or("none"),
                page.max_lines,
                page.max_bytes,
                tool_output::READ_MAX_COLUMNS,
                page.column_truncated_lines,
                numbered
            ))
        }
        "write" => {
            let path = json_arg_string(&args, "path")
                .ok_or_else(|| command_error("Missing path argument for write tool."))?;
            let effective_path = remap_macro_tool_path(path.as_str());
            let content = json_arg_string(&args, "content")
                .ok_or_else(|| command_error("Missing content argument for write tool."))?;
            let create_dirs = json_arg_bool(&args, "create_dirs");
            let expected_revision = json_arg_string(&args, "expected_revision");
            let requested_unix_mode = json_arg_u32(&args, "unix_mode");
            let effective_workspace = resolve_workspace_for_tool_path(
                &workspace,
                &git_state,
                Some(path.as_str()),
                workspace_scope.as_deref(),
            )
            .await?;

            let absolute_path =
                resolve_validated_tool_path(&effective_workspace, effective_path.as_str(), true)?;

            if !create_dirs.unwrap_or(true) {
                let parent = absolute_path.parent();
                if !parent.is_some_and(Path::exists) {
                    return Err(command_error(format!(
                        "Parent directory does not exist for {}: {}",
                        path,
                        parent
                            .map(|value| value.display().to_string())
                            .unwrap_or_default()
                    )));
                }
            }

            let existed = fs::exists_internal(&effective_workspace, effective_path.clone())
                .await
                .map_err(|error| {
                    command_error(format!(
                        "Failed to inspect {} before write: {}",
                        path, error
                    ))
                })?;
            let created = !existed;
            let bytes_written = content.len() as u64;

            let change = PendingFileChange {
                display_path: path.clone(),
                effective_workspace,
                effective_path,
                absolute_path: absolute_path.clone(),
                status: if created {
                    "created".to_string()
                } else {
                    "updated".to_string()
                },
                new_content: Some(content.clone()),
                created,
                bytes_written,
                additions: content.lines().count(),
                deletions: 0,
                expected_revision,
                requested_unix_mode,
            };

            commit_and_validate_pending_file_changes_with_create_dirs(
                vec![change],
                mutation_response_fields(
                    internal_options.capture_checkpoint_snapshots,
                    serde_json::Map::from_iter([
                        (
                            "path".to_string(),
                            Value::String(absolute_path.to_string_lossy().to_string()),
                        ),
                        (
                            "bytes_written".to_string(),
                            Value::Number(serde_json::Number::from(bytes_written)),
                        ),
                        ("created".to_string(), Value::Bool(created)),
                    ]),
                ),
                create_dirs.unwrap_or(true),
            )
            .await
        }
        "edit" => {
            let path = json_arg_string(&args, "path")
                .ok_or_else(|| command_error("Missing path argument for edit tool."))?;
            let effective_path = remap_macro_tool_path(path.as_str());
            let old_text = json_arg_string(&args, "old_text")
                .ok_or_else(|| command_error("Missing old_text argument for edit tool."))?;
            let new_text = json_arg_string(&args, "new_text")
                .ok_or_else(|| command_error("Missing new_text argument for edit tool."))?;
            let replace_all = json_arg_bool(&args, "replace_all").unwrap_or(false);
            let expected_revision = json_arg_string(&args, "expected_revision");
            let effective_workspace = resolve_workspace_for_tool_path(
                &workspace,
                &git_state,
                Some(path.as_str()),
                workspace_scope.as_deref(),
            )
            .await?;

            let current =
                fs::read_file_internal(&effective_workspace, effective_path.clone(), Some(false))
                    .await
                    .map_err(|error| command_error(error.to_string()))?;

            if current.is_binary {
                return Ok(format!("Cannot edit binary file: {}", path));
            }
            fs::validate_expected_revision(
                &path,
                expected_revision.as_deref(),
                Some(&current.revision),
            )
            .map_err(|error| command_error(error.to_string()))?;
            let mutation_revision = expected_revision
                .clone()
                .unwrap_or_else(|| current.revision.clone());

            let occurrences = current.content.matches(&old_text).count();
            if let Some(error) = exact_edit_match_error(&path, occurrences, replace_all) {
                return Ok(error);
            }

            let updated = if replace_all {
                current.content.replace(&old_text, &new_text)
            } else {
                current.content.replacen(&old_text, &new_text, 1)
            };

            let absolute_path =
                resolve_validated_tool_path(&effective_workspace, effective_path.as_str(), true)?;

            let (additions, deletions) = compute_line_change_stats(&current.content, &updated);
            let write_result_bytes = updated.len() as u64;
            let change = PendingFileChange {
                display_path: path.clone(),
                effective_workspace,
                effective_path,
                absolute_path,
                status: "updated".to_string(),
                new_content: Some(updated.clone()),
                created: false,
                bytes_written: write_result_bytes,
                additions,
                deletions,
                expected_revision: Some(mutation_revision),
                requested_unix_mode: None,
            };

            commit_and_validate_pending_file_changes(
                vec![change],
                mutation_response_fields(
                    internal_options.capture_checkpoint_snapshots,
                    serde_json::Map::from_iter([
                        (
                            "replacements".to_string(),
                            Value::Number(serde_json::Number::from(if replace_all {
                                occurrences as u64
                            } else {
                                1
                            })),
                        ),
                        ("path".to_string(), Value::String(path)),
                        (
                            "bytes_written".to_string(),
                            Value::Number(serde_json::Number::from(write_result_bytes)),
                        ),
                        ("created".to_string(), Value::Bool(false)),
                    ]),
                ),
            )
            .await
        }
        "delete" => {
            let path = json_arg_string(&args, "path")
                .ok_or_else(|| command_error("Missing path argument for delete tool."))?;
            let effective_path = remap_macro_tool_path(path.as_str());
            let expected_revision = json_arg_string(&args, "expected_revision");
            let effective_workspace = resolve_workspace_for_tool_path(
                &workspace,
                &git_state,
                Some(path.as_str()),
                workspace_scope.as_deref(),
            )
            .await?;

            let absolute_path =
                resolve_validated_tool_path(&effective_workspace, effective_path.as_str(), false)?;
            let metadata = fs::stat_internal(&effective_workspace, effective_path.clone())
                .await
                .map_err(|error| {
                    command_error(format!(
                        "Failed to inspect {} before delete: {}",
                        path, error
                    ))
                })?;
            if metadata.kind == "directory" {
                return Ok(format!(
                    "Cannot delete directory with delete tool: {}. Only files are supported.",
                    path
                ));
            }

            let current =
                fs::read_file_internal(&effective_workspace, effective_path.clone(), Some(false))
                    .await
                    .map_err(|error| command_error(error.to_string()))?;
            let deletions = if current.is_binary {
                0
            } else {
                current.content.lines().count()
            };
            fs::validate_expected_revision(
                &path,
                expected_revision.as_deref(),
                Some(&current.revision),
            )
            .map_err(|error| command_error(error.to_string()))?;
            let mutation_revision = expected_revision
                .clone()
                .unwrap_or_else(|| current.revision.clone());

            let change = PendingFileChange {
                display_path: path.clone(),
                effective_workspace,
                effective_path,
                absolute_path,
                status: "deleted".to_string(),
                new_content: None,
                created: false,
                bytes_written: 0,
                additions: 0,
                deletions,
                expected_revision: Some(mutation_revision),
                requested_unix_mode: None,
            };

            commit_and_validate_pending_file_changes(
                vec![change],
                mutation_response_fields(
                    internal_options.capture_checkpoint_snapshots,
                    serde_json::Map::from_iter([("path".to_string(), Value::String(path))]),
                ),
            )
            .await
        }
        "apply_patch" => {
            let patch_text = json_arg_string(&args, "patch_text").ok_or_else(|| {
                command_error("Missing patch_text argument for apply_patch tool.")
            })?;
            let operations = parse_apply_patch(&patch_text)?;
            let expected_revisions = json_arg_string_map(&args, "expected_revisions");

            for operation in operations.iter() {
                let operation_path = match operation {
                    ParsedPatchOperation::Add { path, .. }
                    | ParsedPatchOperation::Update { path, .. }
                    | ParsedPatchOperation::Delete { path } => path,
                };

                let validation = validate_tool_execution(
                    &mode_trimmed,
                    &tool_trimmed,
                    Some(operation_path.as_str()),
                );
                if !validation.allowed {
                    return Ok(validation.reason.unwrap_or_else(|| {
                        format!(
                            "Tool {} is not allowed for path {}",
                            tool_trimmed, operation_path
                        )
                    }));
                }
            }

            let mut pending_changes = Vec::new();

            for operation in operations {
                match operation {
                    ParsedPatchOperation::Add { path, lines } => {
                        let expected_revision = expected_revisions
                            .get(&normalize_tool_map_path(&path))
                            .cloned()
                            .or_else(|| Some(fs::EXPECTED_REVISION_ABSENT.to_string()));
                        let effective_path = remap_macro_tool_path(path.as_str());
                        let effective_workspace = resolve_workspace_for_tool_path(
                            &workspace,
                            &git_state,
                            Some(path.as_str()),
                            workspace_scope.as_deref(),
                        )
                        .await?;
                        let absolute_path = resolve_validated_tool_path(
                            &effective_workspace,
                            effective_path.as_str(),
                            true,
                        )?;
                        if fs::exists_internal(&effective_workspace, effective_path.clone())
                            .await
                            .map_err(|error| {
                                command_error(format!(
                                    "Failed to inspect {} before apply_patch: {}",
                                    path, error
                                ))
                            })?
                        {
                            return Ok(format!(
                                "Cannot add file {} because it already exists.",
                                path
                            ));
                        }

                        let new_content = join_text_lines(&lines, true);
                        pending_changes.push(PendingFileChange {
                            display_path: path,
                            effective_workspace,
                            effective_path,
                            absolute_path,
                            status: "created".to_string(),
                            new_content: Some(new_content.clone()),
                            created: true,
                            bytes_written: new_content.len() as u64,
                            additions: new_content.lines().count(),
                            deletions: 0,
                            expected_revision,
                            requested_unix_mode: None,
                        });
                    }
                    ParsedPatchOperation::Update { path, hunks } => {
                        let requested_revision = expected_revisions
                            .get(&normalize_tool_map_path(&path))
                            .cloned();
                        let effective_path = remap_macro_tool_path(path.as_str());
                        let effective_workspace = resolve_workspace_for_tool_path(
                            &workspace,
                            &git_state,
                            Some(path.as_str()),
                            workspace_scope.as_deref(),
                        )
                        .await?;
                        let current = fs::read_file_internal(
                            &effective_workspace,
                            effective_path.clone(),
                            Some(false),
                        )
                        .await
                        .map_err(|error| command_error(error.to_string()))?;
                        let expected_revision =
                            requested_revision.unwrap_or_else(|| current.revision.clone());

                        if current.is_binary {
                            return Ok(format!("Cannot apply patch to binary file: {}", path));
                        }

                        let absolute_path = resolve_validated_tool_path(
                            &effective_workspace,
                            effective_path.as_str(),
                            true,
                        )?;
                        let new_content =
                            apply_patch_hunks_to_content(path.as_str(), &current.content, &hunks)?;
                        let (additions, deletions) =
                            compute_line_change_stats(&current.content, &new_content);

                        pending_changes.push(PendingFileChange {
                            display_path: path,
                            effective_workspace,
                            effective_path,
                            absolute_path,
                            status: "updated".to_string(),
                            new_content: Some(new_content.clone()),
                            created: false,
                            bytes_written: new_content.len() as u64,
                            additions,
                            deletions,
                            expected_revision: Some(expected_revision),
                            requested_unix_mode: None,
                        });
                    }
                    ParsedPatchOperation::Delete { path } => {
                        let requested_revision = expected_revisions
                            .get(&normalize_tool_map_path(&path))
                            .cloned();
                        let effective_path = remap_macro_tool_path(path.as_str());
                        let effective_workspace = resolve_workspace_for_tool_path(
                            &workspace,
                            &git_state,
                            Some(path.as_str()),
                            workspace_scope.as_deref(),
                        )
                        .await?;
                        let absolute_path = resolve_validated_tool_path(
                            &effective_workspace,
                            effective_path.as_str(),
                            false,
                        )?;
                        let current = fs::read_file_internal(
                            &effective_workspace,
                            effective_path.clone(),
                            Some(false),
                        )
                        .await
                        .map_err(|error| command_error(error.to_string()))?;
                        let expected_revision =
                            requested_revision.unwrap_or_else(|| current.revision.clone());
                        let deletion_count = current.content.lines().count();
                        pending_changes.push(PendingFileChange {
                            display_path: path,
                            effective_workspace,
                            effective_path,
                            absolute_path,
                            status: "deleted".to_string(),
                            new_content: None,
                            created: false,
                            bytes_written: 0,
                            additions: 0,
                            deletions: deletion_count,
                            expected_revision: Some(expected_revision),
                            requested_unix_mode: None,
                        });
                    }
                }
            }

            let applied_operations = pending_changes.len() as u64;
            commit_and_validate_pending_file_changes(
                pending_changes,
                mutation_response_fields(
                    internal_options.capture_checkpoint_snapshots,
                    serde_json::Map::from_iter([(
                        "applied_operations".to_string(),
                        Value::Number(serde_json::Number::from(applied_operations)),
                    )]),
                ),
            )
            .await
        }
        "glob" => {
            let pattern = json_arg_string(&args, "pattern").unwrap_or_else(|| "**/*".to_string());
            let include_hidden = json_arg_bool(&args, "include_hidden").unwrap_or(false);
            let list_path = ".".to_string();
            let list_is_macro_scope = is_macro_scoped_path(list_path.as_str());
            let effective_list_path = remap_macro_tool_path(list_path.as_str());
            let effective_workspace = resolve_workspace_for_tool_path(
                &workspace,
                &git_state,
                Some(list_path.as_str()),
                workspace_scope.as_deref(),
            )
            .await?;

            let entries = fs::list_dir_internal(
                &effective_workspace,
                effective_list_path,
                Some(true),
                Some(include_hidden),
                None,
                Some(false),
            )
            .await
            .map_err(|error| command_error(error.to_string()))?;

            let compiled = Pattern::new(&pattern)
                .map_err(|error| command_error(format!("Invalid glob pattern: {}", error)))?;

            let mut paths: Vec<String> = entries
                .into_iter()
                .filter(|entry| entry.kind == "file")
                .filter_map(|entry| {
                    let relative_path = entry.relative_path.replace('\\', "/");
                    let virtual_path = if list_is_macro_scope {
                        to_macro_virtual_relative(&relative_path)
                    } else {
                        relative_path.clone()
                    };

                    if compiled.matches(&relative_path) || compiled.matches(&virtual_path) {
                        Some(virtual_path)
                    } else {
                        None
                    }
                })
                .collect();
            paths.sort();
            paths.dedup();
            let cursor_scope = format!(
                "glob\0{}\0{}\0{}",
                effective_workspace.to_string_lossy(),
                pattern,
                include_hidden
            );
            let total_count = paths.len();
            let page = tool_output::paginate_items(
                &paths,
                &args,
                &cursor_scope,
                tool_output::GLOB_DEFAULT_LIMIT,
                tool_output::GLOB_MAX_LIMIT,
            )?;

            serde_json::to_string_pretty(&serde_json::json!({
                "pattern": pattern,
                "count": page.items.len(),
                "total_count": total_count,
                "paths": page.items,
                "limit": page.limit,
                "offset": page.offset,
                "truncated": page.truncated,
                "next_cursor": page.next_cursor
            }))
            .map_err(|error| command_error(error.to_string()))
        }
        "grep" => {
            let query = json_arg_string(&args, "query")
                .filter(|query| !query.is_empty())
                .ok_or_else(|| command_error("Missing query argument for grep tool."))?;
            let include_hidden = json_arg_bool(&args, "include_hidden").unwrap_or(false);
            let is_regexp = json_arg_bool(&args, "is_regexp").unwrap_or(false);
            let include_pattern = json_arg_string(&args, "include_pattern");
            let list_path = ".".to_string();
            let list_is_macro_scope = is_macro_scoped_path(list_path.as_str());
            let effective_list_path = remap_macro_tool_path(list_path.as_str());
            let effective_workspace = resolve_workspace_for_tool_path(
                &workspace,
                &git_state,
                Some(list_path.as_str()),
                workspace_scope.as_deref(),
            )
            .await?;

            let mut entries = fs::list_dir_internal(
                &effective_workspace,
                effective_list_path,
                Some(true),
                Some(include_hidden),
                None,
                Some(false),
            )
            .await
            .map_err(|error| command_error(error.to_string()))?;
            entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));

            let include_glob = if let Some(glob) = include_pattern.as_ref() {
                Some(Pattern::new(glob).map_err(|error| {
                    command_error(format!("Invalid include_pattern glob: {}", error))
                })?)
            } else {
                None
            };

            let regex = if is_regexp {
                Some(
                    RegexBuilder::new(&query)
                        .case_insensitive(true)
                        .build()
                        .map_err(|error| {
                            command_error(format!("Invalid regex pattern for grep: {}", error))
                        })?,
                )
            } else {
                None
            };
            let query_lower = query.to_lowercase();
            let cursor_scope = format!(
                "grep\0{}\0{}\0{}\0{}\0{}",
                effective_workspace.to_string_lossy(),
                query,
                is_regexp,
                include_pattern.as_deref().unwrap_or(""),
                include_hidden
            );
            let page = tool_output::resolve_tool_page(
                &args,
                &cursor_scope,
                tool_output::GREP_DEFAULT_LIMIT,
                tool_output::GREP_MAX_LIMIT,
            )?;
            let mut results = Vec::new();
            let mut seen_matches = 0usize;
            let mut files_scanned = 0usize;
            let mut skipped_binary = 0usize;
            let mut skipped_too_large = 0usize;
            let mut column_truncated_matches = 0usize;

            for entry in entries.into_iter().filter(|entry| entry.kind == "file") {
                let relative_path = entry.relative_path.replace('\\', "/");
                let virtual_path = if list_is_macro_scope {
                    to_macro_virtual_relative(&relative_path)
                } else {
                    relative_path.clone()
                };

                if let Some(pattern) = include_glob.as_ref() {
                    if !pattern.matches(&relative_path) && !pattern.matches(&virtual_path) {
                        continue;
                    }
                }

                if entry.size.unwrap_or(0) > tool_output::GREP_MAX_FILE_BYTES {
                    skipped_too_large += 1;
                    continue;
                }

                let read_path = relative_path.clone();

                let content = fs::read_file_internal(&effective_workspace, read_path, Some(false))
                    .await
                    .map_err(|error| command_error(error.to_string()))?;

                if content.size > tool_output::GREP_MAX_FILE_BYTES {
                    skipped_too_large += 1;
                    continue;
                }
                if content.is_binary {
                    skipped_binary += 1;
                    continue;
                }
                files_scanned += 1;

                for (index, line) in content.content.lines().enumerate() {
                    let is_match = if let Some(compiled) = regex.as_ref() {
                        compiled.is_match(line)
                    } else {
                        line.to_lowercase().contains(&query_lower)
                    };

                    if is_match {
                        if seen_matches < page.offset {
                            seen_matches += 1;
                            continue;
                        }
                        seen_matches += 1;
                        let (text, was_truncated) = tool_output::truncate_grep_line(line.trim());
                        results.push(serde_json::json!({
                            "path": virtual_path,
                            "line": index + 1,
                            "text": text,
                            "text_truncated": was_truncated
                        }));
                        if was_truncated && results.len() <= page.limit {
                            column_truncated_matches += 1;
                        }

                        if results.len() > page.limit {
                            break;
                        }
                    }
                }

                if results.len() > page.limit {
                    break;
                }
            }

            let truncated = results.len() > page.limit;
            if truncated {
                results.truncate(page.limit);
            }
            let next_cursor = truncated.then(|| {
                tool_output::create_tool_cursor(&cursor_scope, page.offset + results.len())
            });

            serde_json::to_string_pretty(&serde_json::json!({
                "query": query,
                "total": results.len(),
                "count": results.len(),
                "total_count": (!truncated).then_some(seen_matches),
                "total_is_exact": !truncated,
                "results": results,
                "limit": page.limit,
                "offset": page.offset,
                "truncated": truncated,
                "next_cursor": next_cursor,
                "files_scanned": files_scanned,
                "scan_complete": !truncated,
                "skipped_files": {
                    "binary": skipped_binary,
                    "too_large": skipped_too_large,
                    "max_file_bytes": tool_output::GREP_MAX_FILE_BYTES,
                    "is_exact": !truncated
                },
                "column_truncated_matches": column_truncated_matches,
                "max_columns": tool_output::GREP_MAX_COLUMNS
            }))
            .map_err(|error| command_error(error.to_string()))
        }
        "ast_grep" => {
            let path = json_arg_string(&args, "path").unwrap_or_else(|| ".".to_string());
            let effective_path = remap_macro_tool_path(path.as_str());
            let path_is_macro_scope = is_macro_scoped_path(path.as_str());
            let include_hidden = json_arg_bool(&args, "include_hidden").unwrap_or(false);
            let effective_workspace = resolve_workspace_for_tool_path(
                &workspace,
                &git_state,
                Some(path.as_str()),
                workspace_scope.as_deref(),
            )
            .await?;
            let stats = fs::stat_internal(&effective_workspace, effective_path.clone())
                .await
                .map_err(|error| command_error(error.to_string()))?;
            let mut candidates = Vec::new();

            if stats.kind == "directory" {
                let entries = fs::list_dir_internal(
                    &effective_workspace,
                    effective_path.clone(),
                    Some(true),
                    Some(include_hidden),
                    None,
                    Some(false),
                )
                .await
                .map_err(|error| command_error(error.to_string()))?;
                for entry in entries.into_iter().filter(|entry| entry.kind == "file") {
                    let relative = entry.relative_path.replace('\\', "/");
                    let read_path = if effective_path.is_empty() || effective_path == "." {
                        relative
                    } else {
                        format!(
                            "{}/{}",
                            effective_path.trim_end_matches(['/', '\\']),
                            relative.trim_start_matches(['/', '\\'])
                        )
                    };
                    let display_path = if path_is_macro_scope {
                        to_macro_virtual_relative(&read_path)
                    } else {
                        read_path.clone()
                    };
                    candidates.push(ast_search::AstSearchCandidate {
                        workspace: effective_workspace.clone(),
                        read_path,
                        display_path,
                        size: entry.size,
                        project_id: None,
                        mount_name: None,
                    });
                }
            } else if stats.kind == "file" {
                candidates.push(ast_search::AstSearchCandidate {
                    workspace: effective_workspace.clone(),
                    read_path: effective_path.clone(),
                    display_path: path.clone(),
                    size: Some(stats.size),
                    project_id: None,
                    mount_name: None,
                });
            } else {
                return Err(command_error(format!(
                    "ast_grep path must be a file or directory: {}",
                    path
                )));
            }

            let cursor_scope = format!(
                "ast_grep\0{}\0{}\0{}\0{}\0{}\0{}\0{}",
                effective_workspace.to_string_lossy(),
                effective_path,
                json_arg_string(&args, "pattern").unwrap_or_default(),
                json_arg_string(&args, "language").unwrap_or_default(),
                json_arg_string(&args, "strictness").unwrap_or_else(|| "smart".to_string()),
                json_arg_string(&args, "include_pattern").unwrap_or_default(),
                include_hidden
            );
            ast_search::execute_ast_search(&args, candidates, &cursor_scope, false, cancellation)
                .await
        }
        "git_status" => {
            let repo_path = json_arg_string(&args, "repo_path").unwrap_or_else(|| ".".to_string());
            if let Some(wsl_repo_path) =
                resolve_confined_wsl_repo_path_for_workspace(&workspace, &repo_path).await?
            {
                let status = git::build_wsl_git_status(&wsl_repo_path)
                    .await
                    .map_err(|error| command_error(error.to_string()))?;
                return format_bounded_git_status(&repo_path, status, &args);
            }
            let repo_path_for_task = repo_path.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();

            let status = tokio::task::spawn_blocking(move || {
                let validated =
                    validate_agent_git_repo_path(&repo_path_for_task, &workspace_for_task)?;
                let repo = git_state_for_task
                    .open_repo(&validated)
                    .map_err(|error| command_error(error.to_string()))?;
                let repo = repo
                    .lock()
                    .map_err(|_| command_error("Failed to lock repository"))?;

                git::build_git_status(&repo).map_err(|error| command_error(error.to_string()))
            })
            .await
            .map_err(|error| command_error(git::to_join_error(error).to_string()))??;

            format_bounded_git_status(&repo_path, status, &args)
        }
        "git_log" => {
            let repo_path = json_arg_string(&args, "repo_path").unwrap_or_else(|| ".".to_string());
            let branch = json_arg_string(&args, "branch");
            if let Some(wsl_repo_path) =
                resolve_confined_wsl_repo_path_for_workspace(&workspace, &repo_path).await?
            {
                let snapshot = git::build_wsl_git_log_snapshot(&wsl_repo_path, branch.as_deref())
                    .await
                    .map_err(|error| command_error(error.to_string()))?;
                let cursor_scope = format!(
                    "git_log\0{}\0{}\0{}",
                    repo_path,
                    branch.as_deref().unwrap_or(""),
                    snapshot.revision
                );
                let page = tool_output::resolve_tool_page(
                    &args,
                    &cursor_scope,
                    tool_output::GIT_LOG_DEFAULT_LIMIT,
                    tool_output::GIT_LOG_MAX_LIMIT,
                )?;
                let commits = git::build_wsl_git_log_page(
                    &wsl_repo_path,
                    page.offset,
                    page.limit.saturating_add(1),
                    &snapshot,
                )
                .await
                .map_err(|error| command_error(error.to_string()))?;
                return format_bounded_git_log(&repo_path, commits, page, &cursor_scope);
            }
            let repo_path_for_task = repo_path.clone();
            let response_repo_path = repo_path.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();
            let args_for_task = args.clone();

            tokio::task::spawn_blocking(move || {
                let validated =
                    validate_agent_git_repo_path(&repo_path_for_task, &workspace_for_task)?;
                let repo = git_state_for_task
                    .open_repo(&validated)
                    .map_err(|error| command_error(error.to_string()))?;
                let repo = repo
                    .lock()
                    .map_err(|_| command_error("Failed to lock repository"))?;
                let snapshot = git::build_git_log_snapshot(&repo, branch.as_deref())
                    .map_err(|error| command_error(error.to_string()))?;
                let cursor_scope = format!(
                    "git_log\0{}\0{}\0{}",
                    response_repo_path,
                    branch.as_deref().unwrap_or(""),
                    snapshot.revision
                );
                let page = tool_output::resolve_tool_page(
                    &args_for_task,
                    &cursor_scope,
                    tool_output::GIT_LOG_DEFAULT_LIMIT,
                    tool_output::GIT_LOG_MAX_LIMIT,
                )?;
                let commits = git::build_git_log_page(
                    &repo,
                    page.offset,
                    page.limit.saturating_add(1),
                    &snapshot,
                )
                .map_err(|error| command_error(error.to_string()))?;
                format_bounded_git_log(&response_repo_path, commits, page, &cursor_scope)
            })
            .await
            .map_err(|error| command_error(git::to_join_error(error).to_string()))?
        }
        "git_branch_list" => {
            let repo_path = json_arg_string(&args, "repo_path").unwrap_or_else(|| ".".to_string());
            if let Some(wsl_repo_path) =
                resolve_confined_wsl_repo_path_for_workspace(&workspace, &repo_path).await?
            {
                let revision = git::wsl_git_branch_snapshot_revision(&wsl_repo_path)
                    .await
                    .map_err(|error| command_error(error.to_string()))?;
                let cursor_scope = format!("git_branch_list\0{}\0{}", repo_path, revision);
                let page = tool_output::resolve_tool_page(
                    &args,
                    &cursor_scope,
                    tool_output::GIT_BRANCH_DEFAULT_LIMIT,
                    tool_output::GIT_BRANCH_MAX_LIMIT,
                )?;
                let branches =
                    git::build_wsl_git_branches_tool_page(&wsl_repo_path, page.offset, page.limit)
                        .await
                        .map_err(|error| command_error(error.to_string()))?;
                let revision_after = git::wsl_git_branch_snapshot_revision(&wsl_repo_path)
                    .await
                    .map_err(|error| command_error(error.to_string()))?;
                if revision_after != revision {
                    return Err(command_error(
                        "Repository branches changed while the page was being produced. Retry without a cursor.",
                    ));
                }
                let returned = branches.local.len().saturating_add(branches.remote.len());
                return serde_json::to_string_pretty(&serde_json::json!({
                    "repo_path": repo_path,
                    "revision": revision,
                    "local": branches.local,
                    "remote": branches.remote,
                    "current": branches.current,
                    "limit": page.limit,
                    "offset": page.offset,
                    "truncated": branches.has_more,
                    "next_cursor": branches.has_more.then(|| tool_output::create_tool_cursor(&cursor_scope, page.offset.saturating_add(returned)))
                }))
                .map_err(|error| command_error(error.to_string()));
            }
            let repo_path_for_task = repo_path.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();
            let args_for_task = args.clone();
            let response_repo_path = repo_path.clone();

            let (branches, page, cursor_scope, revision) = tokio::task::spawn_blocking(move || {
                let validated =
                    validate_agent_git_repo_path(&repo_path_for_task, &workspace_for_task)?;
                let repo = git_state_for_task
                    .open_repo(&validated)
                    .map_err(|error| command_error(error.to_string()))?;
                let repo = repo
                    .lock()
                    .map_err(|_| command_error("Failed to lock repository"))?;
                let revision = git::git_branch_snapshot_revision(&repo)
                    .map_err(|error| command_error(error.to_string()))?;
                let cursor_scope =
                    format!("git_branch_list\0{}\0{}", response_repo_path, revision);
                let page = tool_output::resolve_tool_page(
                    &args_for_task,
                    &cursor_scope,
                    tool_output::GIT_BRANCH_DEFAULT_LIMIT,
                    tool_output::GIT_BRANCH_MAX_LIMIT,
                )?;
                let branches = git::build_git_branches_tool_page(&repo, page.offset, page.limit)
                    .map_err(|error| command_error(error.to_string()))?;
                let revision_after = git::git_branch_snapshot_revision(&repo)
                    .map_err(|error| command_error(error.to_string()))?;
                if revision_after != revision {
                    return Err(command_error(
                        "Repository branches changed while the page was being produced. Retry without a cursor.",
                    ));
                }
                Ok((branches, page, cursor_scope, revision))
            })
            .await
            .map_err(|error| command_error(git::to_join_error(error).to_string()))??;

            let returned = branches.local.len().saturating_add(branches.remote.len());
            serde_json::to_string_pretty(&serde_json::json!({
                "repo_path": repo_path,
                "revision": revision,
                "local": branches.local,
                "remote": branches.remote,
                "current": branches.current,
                "limit": page.limit,
                "offset": page.offset,
                "truncated": branches.has_more,
                "next_cursor": branches.has_more.then(|| tool_output::create_tool_cursor(&cursor_scope, page.offset.saturating_add(returned)))
            }))
            .map_err(|error| command_error(error.to_string()))
        }
        "git_diff" => {
            let repo_path = json_arg_string(&args, "repo_path").unwrap_or_else(|| ".".to_string());
            let base = json_arg_string(&args, "base");
            let head = json_arg_string(&args, "head");
            let context_lines = json_arg_u32(&args, "context_lines")
                .map(|value| value.min(tool_output::GIT_DIFF_MAX_CONTEXT_LINES));
            let ignore_whitespace = json_arg_bool(&args, "ignore_whitespace").unwrap_or(false);
            let paths = json_arg_string_array(&args, "paths");
            let mode = git::GitDiffMode::parse(json_arg_string(&args, "mode").as_deref())
                .map_err(|error| command_error(error.to_string()))?;
            let require_complete = json_arg_bool(&args, "require_complete").unwrap_or(false);
            if let Some(wsl_repo_path) =
                resolve_confined_wsl_repo_path_for_workspace(&workspace, &repo_path).await?
            {
                let diff = git::wsl_git_diff(
                    &wsl_repo_path,
                    base.as_deref(),
                    head.as_deref(),
                    git::DiffRequestOptions {
                        context_lines,
                        ignore_whitespace,
                        paths,
                        mode,
                        max_bytes: Some(tool_output::GIT_DIFF_MAX_BYTES),
                        require_complete,
                    },
                )
                .await
                .map_err(|error| command_error(error.to_string()))?;
                return Ok(format!(
                    "DIFF_MODE: {}\nMAX_OUTPUT_BYTES: {}\nREQUIRE_COMPLETE: {}\n\n{}",
                    mode.as_str(),
                    tool_output::GIT_DIFF_MAX_BYTES,
                    require_complete,
                    diff
                ));
            }
            let repo_path_for_task = repo_path.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();

            let patch = tokio::task::spawn_blocking(move || {
                let validated =
                    validate_agent_git_repo_path(&repo_path_for_task, &workspace_for_task)?;
                let repo = git_state_for_task
                    .open_repo(&validated)
                    .map_err(|error| command_error(error.to_string()))?;
                let repo = repo
                    .lock()
                    .map_err(|_| command_error("Failed to lock repository"))?;

                git::diff_repo(
                    &repo,
                    base.as_deref(),
                    head.as_deref(),
                    git::DiffRequestOptions {
                        context_lines,
                        ignore_whitespace,
                        paths,
                        mode,
                        max_bytes: Some(tool_output::GIT_DIFF_MAX_BYTES),
                        require_complete,
                    },
                )
                .map_err(|error| command_error(error.to_string()))
            })
            .await
            .map_err(|error| command_error(git::to_join_error(error).to_string()))??;

            Ok(format!(
                "DIFF_MODE: {}\nMAX_OUTPUT_BYTES: {}\nREQUIRE_COMPLETE: {}\n\n{}",
                mode.as_str(),
                tool_output::GIT_DIFF_MAX_BYTES,
                require_complete,
                patch
            ))
        }
        "git_read_file_pair" => {
            let repo_path = json_arg_string(&args, "repo_path").unwrap_or_else(|| ".".to_string());
            let path = json_arg_string(&args, "path").unwrap_or_default();
            if resolve_confined_wsl_repo_path_for_workspace(&workspace, &repo_path)
                .await?
                .is_some()
            {
                return Err(unsupported_wsl_workspace_tool("git_read_file_pair"));
            }
            let repo_path_for_task = repo_path.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();

            let pair = tokio::task::spawn_blocking(move || {
                let validated =
                    validate_agent_git_repo_path(&repo_path_for_task, &workspace_for_task)?;
                let relative_path = git::validate_repo_relative_file_path(&path)
                    .map_err(|error| command_error(error.to_string()))?;
                let repo = git_state_for_task
                    .open_repo(&validated)
                    .map_err(|error| command_error(error.to_string()))?;
                let repo = repo
                    .lock()
                    .map_err(|_| command_error("Failed to lock repository"))?;

                git::read_git_file_pair(&repo, &validated, &relative_path)
                    .map_err(|error| command_error(error.to_string()))
            })
            .await
            .map_err(|error| command_error(git::to_join_error(error).to_string()))??;

            serde_json::to_string_pretty(&pair).map_err(|error| command_error(error.to_string()))
        }
        "git_get_tree" => {
            let repo_path = json_arg_string(&args, "repo_path").unwrap_or_else(|| ".".to_string());
            let branch = json_arg_string(&args, "branch");
            let cursor_scope_base = format!(
                "git_get_tree\0{}\0{}",
                repo_path,
                branch.as_deref().unwrap_or("HEAD")
            );
            if let Some(wsl_repo_path) =
                resolve_confined_wsl_repo_path_for_workspace(&workspace, &repo_path).await?
            {
                let expected_revision =
                    git::wsl_git_tree_revision(&wsl_repo_path, branch.as_deref())
                        .await
                        .map_err(|error| command_error(error.to_string()))?;
                let cursor_scope = format!("{}\0{}", cursor_scope_base, expected_revision);
                let page = tool_output::resolve_tool_page(
                    &args,
                    &cursor_scope,
                    tool_output::GIT_TREE_DEFAULT_LIMIT,
                    tool_output::GIT_TREE_MAX_LIMIT,
                )?;
                let tree = git::build_wsl_git_tree_tool_page(
                    &wsl_repo_path,
                    branch.as_deref(),
                    page.offset,
                    page.limit,
                )
                .await
                .map_err(|error| command_error(error.to_string()))?;
                if tree.revision != expected_revision {
                    return Err(command_error(
                        "Git tree changed while the page was being read. Retry from the first page.",
                    ));
                }
                let returned = tree.structure.len();
                return serde_json::to_string_pretty(&serde_json::json!({
                    "repo_path": repo_path,
                    "branch": tree.branch,
                    "structure": tree.structure,
                    "modified_files_count": tree.modified_files_count,
                    "limit": page.limit,
                    "offset": page.offset,
                    "truncated": tree.has_more,
                    "next_cursor": tree.has_more.then(|| tool_output::create_tool_cursor(&cursor_scope, page.offset.saturating_add(returned)))
                }))
                .map_err(|error| command_error(error.to_string()));
            }
            let repo_path_for_task = repo_path.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();
            let args_for_task = args.clone();
            let cursor_scope_base_for_task = cursor_scope_base.clone();

            let (tree, page, cursor_scope) = tokio::task::spawn_blocking(move || {
                let validated =
                    validate_agent_git_repo_path(&repo_path_for_task, &workspace_for_task)?;
                let repo = git_state_for_task
                    .open_repo(&validated)
                    .map_err(|error| command_error(error.to_string()))?;
                let repo = repo
                    .lock()
                    .map_err(|_| command_error("Failed to lock repository"))?;
                let expected_revision = git::git_tree_revision(&repo, branch.as_deref())
                    .map_err(|error| command_error(error.to_string()))?;
                let cursor_scope =
                    format!("{}\0{}", cursor_scope_base_for_task, expected_revision);
                let page = tool_output::resolve_tool_page(
                    &args_for_task,
                    &cursor_scope,
                    tool_output::GIT_TREE_DEFAULT_LIMIT,
                    tool_output::GIT_TREE_MAX_LIMIT,
                )?;
                let tree = git::build_git_tree_tool_page(
                    &repo,
                    branch.as_deref(),
                    page.offset,
                    page.limit,
                )
                .map_err(|error| command_error(error.to_string()))?;
                if tree.revision != expected_revision {
                    return Err(command_error(
                        "Git tree changed while the page was being read. Retry from the first page.",
                    ));
                }
                Ok::<_, CommandError>((tree, page, cursor_scope))
            })
            .await
            .map_err(|error| command_error(git::to_join_error(error).to_string()))??;

            let returned = tree.structure.len();
            serde_json::to_string_pretty(&serde_json::json!({
                "repo_path": repo_path,
                "branch": tree.branch,
                "structure": tree.structure,
                "modified_files_count": tree.modified_files_count,
                "limit": page.limit,
                "offset": page.offset,
                "truncated": tree.has_more,
                "next_cursor": tree.has_more.then(|| tool_output::create_tool_cursor(&cursor_scope, page.offset.saturating_add(returned)))
            }))
            .map_err(|error| command_error(error.to_string()))
        }
        "git_add" => {
            let repo_path = json_arg_string(&args, "repo_path").unwrap_or_else(|| ".".to_string());
            let paths = json_arg_string_array(&args, "paths")
                .filter(|items| !items.is_empty())
                .unwrap_or_else(|| vec![".".to_string()]);
            if let Some(wsl_repo_path) =
                resolve_confined_wsl_repo_path_for_workspace(&workspace, &repo_path).await?
            {
                let _repo_guard =
                    crate::workspace::lock_git_repository(Path::new(&wsl_repo_path.unc_path))
                        .await
                        .map_err(|error| command_error(error.to_string()))?;
                git::wsl_git_add(&wsl_repo_path, &paths)
                    .await
                    .map_err(|error| command_error(error.to_string()))?;
                let status = git::build_wsl_git_status(&wsl_repo_path)
                    .await
                    .map_err(|error| command_error(error.to_string()))?;
                return serde_json::to_string_pretty(&serde_json::json!({
                    "ok": true,
                    "repo_path": repo_path,
                    "staged_paths": paths,
                    "staged_count": status.staged_files.len(),
                    "branch": status.branch
                }))
                .map_err(|error| command_error(error.to_string()));
            }
            let paths_for_task = paths.clone();
            let repo_path_for_task = repo_path.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();
            let validated = validate_agent_git_repo_path(&repo_path, &workspace)?;
            let _repo_guard = crate::workspace::lock_git_repository(&validated)
                .await
                .map_err(|error| command_error(error.to_string()))?;

            let status = tokio::task::spawn_blocking(move || {
                let validated =
                    validate_agent_git_repo_path(&repo_path_for_task, &workspace_for_task)?;
                let repo = git_state_for_task
                    .open_repo(&validated)
                    .map_err(|error| command_error(error.to_string()))?;
                let repo = repo
                    .lock()
                    .map_err(|_| command_error("Failed to lock repository"))?;

                git::add_paths(&repo, &paths_for_task)
                    .map_err(|error| command_error(error.to_string()))?;
                git::build_git_status(&repo).map_err(|error| command_error(error.to_string()))
            })
            .await
            .map_err(|error| command_error(git::to_join_error(error).to_string()))??;

            serde_json::to_string_pretty(&serde_json::json!({
                "ok": true,
                "repo_path": repo_path,
                "staged_paths": paths,
                "staged_count": status.staged_files.len(),
                "branch": status.branch
            }))
            .map_err(|error| command_error(error.to_string()))
        }
        "git_commit" => {
            let repo_path = json_arg_string(&args, "repo_path").unwrap_or_else(|| ".".to_string());
            let message = json_arg_string(&args, "message")
                .ok_or_else(|| command_error("Missing message argument for git_commit tool."))?;
            let stage_all = json_arg_bool(&args, "stage_all").unwrap_or(true);
            if let Some(wsl_repo_path) =
                resolve_confined_wsl_repo_path_for_workspace(&workspace, &repo_path).await?
            {
                let _repo_guard =
                    crate::workspace::lock_git_repository(Path::new(&wsl_repo_path.unc_path))
                        .await
                        .map_err(|error| command_error(error.to_string()))?;
                let before = git::build_wsl_git_log(&wsl_repo_path, 1, None)
                    .await
                    .map_err(|error| command_error(error.to_string()))?;
                let head_before = before.first().map(|entry| entry.id.clone());
                let hash = git::wsl_git_commit(&wsl_repo_path, &message, stage_all)
                    .await
                    .map_err(|error| command_error(error.to_string()))?;
                let after = git::build_wsl_git_log(&wsl_repo_path, 1, None)
                    .await
                    .map_err(|error| command_error(error.to_string()))?;
                let head_after = after.first().map(|entry| entry.id.clone());
                let status = git::build_wsl_git_status(&wsl_repo_path)
                    .await
                    .map_err(|error| command_error(error.to_string()))?;
                return serde_json::to_string_pretty(&serde_json::json!({
                    "ok": true,
                    "repo_path": repo_path,
                    "branch": status.branch,
                    "hash": hash,
                    "head_before": head_before,
                    "head_after": head_after,
                    "head_changed": head_before != head_after
                }))
                .map_err(|error| command_error(error.to_string()));
            }
            let repo_path_for_task = repo_path.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();
            let validated = validate_agent_git_repo_path(&repo_path, &workspace)?;
            let _repo_guard = crate::workspace::lock_git_repository(&validated)
                .await
                .map_err(|error| command_error(error.to_string()))?;

            let result = tokio::task::spawn_blocking(move || {
                let validated =
                    validate_agent_git_repo_path(&repo_path_for_task, &workspace_for_task)?;
                let repo = git_state_for_task
                    .open_repo(&validated)
                    .map_err(|error| command_error(error.to_string()))?;
                let repo = repo
                    .lock()
                    .map_err(|_| command_error("Failed to lock repository"))?;

                let before = git::build_git_log(&repo, 1, None)
                    .map_err(|error| command_error(error.to_string()))?;
                let head_before = before.first().map(|entry| entry.id.clone());

                let hash = git::commit_repo(&repo, &message, stage_all)
                    .map_err(|error| command_error(error.to_string()))?;

                let after = git::build_git_log(&repo, 1, None)
                    .map_err(|error| command_error(error.to_string()))?;
                let head_after = after.first().map(|entry| entry.id.clone());

                let status = git::build_git_status(&repo)
                    .map_err(|error| command_error(error.to_string()))?;

                Ok::<_, CommandError>((hash, head_before, head_after, status))
            })
            .await
            .map_err(|error| command_error(git::to_join_error(error).to_string()))??;

            let (hash, head_before, head_after, status) = result;

            serde_json::to_string_pretty(&serde_json::json!({
                "ok": true,
                "repo_path": repo_path,
                "branch": status.branch,
                "hash": hash,
                "head_before": head_before,
                "head_after": head_after,
                "head_changed": head_before != head_after
            }))
            .map_err(|error| command_error(error.to_string()))
        }
        "git_checkout" => {
            let repo_path = json_arg_string(&args, "repo_path").unwrap_or_else(|| ".".to_string());
            let branch_or_commit = json_arg_string(&args, "branch_or_commit")
                .or_else(|| json_arg_string(&args, "branch"))
                .ok_or_else(|| {
                    command_error("Missing branch_or_commit argument for git_checkout tool.")
                })?;
            let branch_or_commit_for_task = branch_or_commit.clone();
            let create = json_arg_bool(&args, "create").unwrap_or(false);
            if let Some(wsl_repo_path) =
                resolve_confined_wsl_repo_path_for_workspace(&workspace, &repo_path).await?
            {
                let _repo_guard =
                    crate::workspace::lock_git_repository(Path::new(&wsl_repo_path.unc_path))
                        .await
                        .map_err(|error| command_error(error.to_string()))?;
                git::wsl_git_checkout(&wsl_repo_path, &branch_or_commit, create)
                    .await
                    .map_err(|error| command_error(error.to_string()))?;
                let status = git::build_wsl_git_status(&wsl_repo_path)
                    .await
                    .map_err(|error| command_error(error.to_string()))?;
                return serde_json::to_string_pretty(&serde_json::json!({
                    "ok": true,
                    "repo_path": repo_path,
                    "branch": status.branch,
                    "target": branch_or_commit
                }))
                .map_err(|error| command_error(error.to_string()));
            }
            let repo_path_for_task = repo_path.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();
            let validated = validate_agent_git_repo_path(&repo_path, &workspace)?;
            let _repo_guard = crate::workspace::lock_git_repository(&validated)
                .await
                .map_err(|error| command_error(error.to_string()))?;

            let status = tokio::task::spawn_blocking(move || {
                let validated =
                    validate_agent_git_repo_path(&repo_path_for_task, &workspace_for_task)?;
                let repo = git_state_for_task
                    .open_repo(&validated)
                    .map_err(|error| command_error(error.to_string()))?;
                let repo = repo
                    .lock()
                    .map_err(|_| command_error("Failed to lock repository"))?;

                git::checkout_repo(&repo, &branch_or_commit_for_task, create)
                    .map_err(|error| command_error(error.to_string()))?;
                git::build_git_status(&repo).map_err(|error| command_error(error.to_string()))
            })
            .await
            .map_err(|error| command_error(git::to_join_error(error).to_string()))??;

            serde_json::to_string_pretty(&serde_json::json!({
                "ok": true,
                "repo_path": repo_path,
                "branch": status.branch,
                "target": branch_or_commit
            }))
            .map_err(|error| command_error(error.to_string()))
        }
        "git_merge" => {
            let repo_path = json_arg_string(&args, "repo_path").unwrap_or_else(|| ".".to_string());
            let branch_name = json_arg_string(&args, "branch_name")
                .or_else(|| json_arg_string(&args, "branch"))
                .ok_or_else(|| command_error("Missing branch_name argument for git_merge tool."))?;
            let into_branch = json_arg_string(&args, "into_branch")
                .ok_or_else(|| command_error("Missing into_branch argument for git_merge tool."))?;
            if let Some(wsl_repo_path) =
                resolve_confined_wsl_repo_path_for_workspace(&workspace, &repo_path).await?
            {
                let _repo_guard =
                    crate::workspace::lock_git_repository(Path::new(&wsl_repo_path.unc_path))
                        .await
                        .map_err(|error| command_error(error.to_string()))?;
                let output = git::wsl_git_merge(&wsl_repo_path, &branch_name, &into_branch)
                    .await
                    .map_err(|error| command_error(error.to_string()))?;
                let status = git::build_wsl_git_status(&wsl_repo_path)
                    .await
                    .map_err(|error| command_error(error.to_string()))?;
                return serde_json::to_string_pretty(&serde_json::json!({
                    "ok": true,
                    "repo_path": repo_path,
                    "branch": status.branch,
                    "merged_branch": branch_name,
                    "into_branch": into_branch,
                    "output": output
                }))
                .map_err(|error| command_error(error.to_string()));
            }

            let repo_path_for_task = repo_path.clone();
            let branch_name_for_task = branch_name.clone();
            let into_branch_for_task = into_branch.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();
            let validated = validate_agent_git_repo_path(&repo_path, &workspace)?;
            let _repo_guard = crate::workspace::lock_git_repository(&validated)
                .await
                .map_err(|error| command_error(error.to_string()))?;
            let (output, status) = tokio::task::spawn_blocking(move || {
                let validated =
                    validate_agent_git_repo_path(&repo_path_for_task, &workspace_for_task)?;
                let repo = git_state_for_task
                    .open_repo(&validated)
                    .map_err(|error| command_error(error.to_string()))?;
                let repo = repo
                    .lock()
                    .map_err(|_| command_error("Failed to lock repository"))?;
                let output = git::merge_repo(&repo, &branch_name_for_task, &into_branch_for_task)
                    .map_err(|error| command_error(error.to_string()))?;
                let status = git::build_git_status(&repo)
                    .map_err(|error| command_error(error.to_string()))?;
                Ok::<_, CommandError>((output, status))
            })
            .await
            .map_err(|error| command_error(git::to_join_error(error).to_string()))??;

            serde_json::to_string_pretty(&serde_json::json!({
                "ok": true,
                "repo_path": repo_path,
                "branch": status.branch,
                "merged_branch": branch_name,
                "into_branch": into_branch,
                "output": output
            }))
            .map_err(|error| command_error(error.to_string()))
        }
        "git_reset" => {
            let repo_path = json_arg_string(&args, "repo_path").unwrap_or_else(|| ".".to_string());
            let mode = json_arg_string(&args, "mode").unwrap_or_default();
            if !matches!(mode.as_str(), "soft" | "mixed" | "hard") {
                return Ok(
                    "Missing or invalid mode for git_reset. Use one of: soft, mixed, hard."
                        .to_string(),
                );
            }
            let commit = json_arg_string(&args, "commit");
            let confirm = json_arg_bool(&args, "confirm");
            if let Some(wsl_repo_path) =
                resolve_confined_wsl_repo_path_for_workspace(&workspace, &repo_path).await?
            {
                let _repo_guard =
                    crate::workspace::lock_git_repository(Path::new(&wsl_repo_path.unc_path))
                        .await
                        .map_err(|error| command_error(error.to_string()))?;
                git::wsl_git_reset(&wsl_repo_path, &mode, commit, confirm)
                    .await
                    .map_err(|error| command_error(error.to_string()))?;
                let status = git::build_wsl_git_status(&wsl_repo_path)
                    .await
                    .map_err(|error| command_error(error.to_string()))?;
                return serde_json::to_string_pretty(&serde_json::json!({
                    "ok": true,
                    "repo_path": repo_path,
                    "branch": status.branch
                }))
                .map_err(|error| command_error(error.to_string()));
            }
            let repo_path_for_task = repo_path.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();
            let validated = validate_agent_git_repo_path(&repo_path, &workspace)?;
            let _repo_guard = crate::workspace::lock_git_repository(&validated)
                .await
                .map_err(|error| command_error(error.to_string()))?;

            let status = tokio::task::spawn_blocking(move || {
                let validated =
                    validate_agent_git_repo_path(&repo_path_for_task, &workspace_for_task)?;
                let repo = git_state_for_task
                    .open_repo(&validated)
                    .map_err(|error| command_error(error.to_string()))?;
                let repo = repo
                    .lock()
                    .map_err(|_| command_error("Failed to lock repository"))?;

                if mode == "hard" && !confirm.unwrap_or(false) {
                    return Err(command_error("Hard reset is destructive; set confirm=true"));
                }

                git::reset_repo(&repo, &mode, commit)
                    .map_err(|error| command_error(error.to_string()))?;
                git::build_git_status(&repo).map_err(|error| command_error(error.to_string()))
            })
            .await
            .map_err(|error| command_error(git::to_join_error(error).to_string()))??;

            serde_json::to_string_pretty(&serde_json::json!({
                "ok": true,
                "repo_path": repo_path,
                "branch": status.branch
            }))
            .map_err(|error| command_error(error.to_string()))
        }
        "git_abort_merge" => {
            let repo_path = json_arg_string(&args, "repo_path").unwrap_or_else(|| ".".to_string());
            let confirm = json_arg_bool(&args, "confirm");
            if resolve_confined_wsl_repo_path_for_workspace(&workspace, &repo_path)
                .await?
                .is_some()
            {
                return Err(unsupported_wsl_workspace_tool("git_abort_merge"));
            }
            let repo_path_for_task = repo_path.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();
            let validated = validate_agent_git_repo_path(&repo_path, &workspace)?;
            let _repo_guard = crate::workspace::lock_git_repository(&validated)
                .await
                .map_err(|error| command_error(error.to_string()))?;

            let status = tokio::task::spawn_blocking(move || {
                let validated =
                    validate_agent_git_repo_path(&repo_path_for_task, &workspace_for_task)?;
                let repo = git_state_for_task
                    .open_repo(&validated)
                    .map_err(|error| command_error(error.to_string()))?;
                let repo = repo
                    .lock()
                    .map_err(|_| command_error("Failed to lock repository"))?;

                git::abort_merge_with_confirmation(&repo, confirm)
                    .map_err(|error| command_error(error.to_string()))?;
                git::build_git_status(&repo).map_err(|error| command_error(error.to_string()))
            })
            .await
            .map_err(|error| command_error(git::to_join_error(error).to_string()))??;

            serde_json::to_string_pretty(&serde_json::json!({
                "ok": true,
                "repo_path": repo_path,
                "branch": status.branch
            }))
            .map_err(|error| command_error(error.to_string()))
        }
        "git_stash" => {
            let repo_path = json_arg_string(&args, "repo_path").unwrap_or_else(|| ".".to_string());
            let message = json_arg_string(&args, "message");
            if let Some(wsl_repo_path) =
                resolve_confined_wsl_repo_path_for_workspace(&workspace, &repo_path).await?
            {
                let _repo_guard =
                    crate::workspace::lock_git_repository(Path::new(&wsl_repo_path.unc_path))
                        .await
                        .map_err(|error| command_error(error.to_string()))?;
                let stash = git::wsl_git_stash(&wsl_repo_path, message)
                    .await
                    .map_err(|error| command_error(error.to_string()))?;
                let status = git::build_wsl_git_status(&wsl_repo_path)
                    .await
                    .map_err(|error| command_error(error.to_string()))?;
                return serde_json::to_string_pretty(&serde_json::json!({
                    "ok": true,
                    "repo_path": repo_path,
                    "branch": status.branch,
                    "stash": stash
                }))
                .map_err(|error| command_error(error.to_string()));
            }
            let repo_path_for_task = repo_path.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();
            let validated = validate_agent_git_repo_path(&repo_path, &workspace)?;
            let _repo_guard = crate::workspace::lock_git_repository(&validated)
                .await
                .map_err(|error| command_error(error.to_string()))?;

            let result = tokio::task::spawn_blocking(move || {
                let validated =
                    validate_agent_git_repo_path(&repo_path_for_task, &workspace_for_task)?;
                let repo = git_state_for_task
                    .open_repo(&validated)
                    .map_err(|error| command_error(error.to_string()))?;
                let mut repo = repo
                    .lock()
                    .map_err(|_| command_error("Failed to lock repository"))?;

                let stash = git::stash_repo(&mut repo, message)
                    .map_err(|error| command_error(error.to_string()))?;
                let status = git::build_git_status(&repo)
                    .map_err(|error| command_error(error.to_string()))?;

                Ok::<_, CommandError>((stash, status))
            })
            .await
            .map_err(|error| command_error(git::to_join_error(error).to_string()))??;

            let (stash, status) = result;

            serde_json::to_string_pretty(&serde_json::json!({
                "ok": true,
                "repo_path": repo_path,
                "branch": status.branch,
                "stash": stash
            }))
            .map_err(|error| command_error(error.to_string()))
        }
        _ => Ok("UNSUPPORTED_WORKSPACE_TOOL".to_string()),
    }
}

pub fn tool_cancel_workspace(execution_id: String) -> bool {
    let execution_id = execution_id.trim();
    if execution_id.is_empty() {
        return false;
    }
    let cancellation = {
        let mut registry = TOOL_EXECUTION_CANCELLATION_REGISTRY
            .lock()
            .expect("tool cancellation registry");
        let now = Instant::now();
        registry.pending.retain(|_, recorded_at| {
            now.duration_since(*recorded_at) < PENDING_TOOL_CANCELLATION_TTL
        });
        if let Some(cancellation) = registry.active.get(execution_id).cloned() {
            Some(cancellation)
        } else {
            if registry.pending.len() >= PENDING_TOOL_CANCELLATION_LIMIT {
                if let Some(oldest_id) = registry
                    .pending
                    .iter()
                    .min_by_key(|(_, recorded_at)| **recorded_at)
                    .map(|(id, _)| id.clone())
                {
                    registry.pending.remove(&oldest_id);
                }
            }
            registry.pending.insert(execution_id.to_string(), now);
            None
        }
    };
    if let Some(cancellation) = cancellation {
        cancellation.cancel();
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests;

impl ToolCancellation {
    fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.notify.notify_one();
    }

    pub(super) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    async fn cancelled(&self) {
        if self.cancelled.load(Ordering::Acquire) {
            return;
        }
        loop {
            self.notify.notified().await;
            if self.cancelled.load(Ordering::Acquire) {
                return;
            }
        }
    }
}
