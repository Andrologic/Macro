#[path = "commands/ai.rs"]
pub mod ai;
#[path = "commands/fs.rs"]
pub mod fs;
#[path = "commands/git.rs"]
pub mod git;
#[path = "commands/terminal.rs"]
pub mod terminal;
#[path = "commands/workspace.rs"]
pub mod workspace;

use crate::core::tool_policy::{
    get_mode_policy, is_macro_scoped_path, validate_tool_execution, ToolModePolicyResult,
    ToolValidationResult,
};
use crate::db::{models::*, repository, DbError};
use crate::dev_overrides::DevProviderOverridesFile;
use crate::fs::{
    validate_path as validate_fs_path, validate_path_for_write as validate_fs_path_for_write,
};
use crate::git::GitState;
use crate::secrets;
use crate::{WorkspaceMetadataRoot, WorkspaceRoot};
use glob::Pattern;
use regex::RegexBuilder;
use serde::Serialize;
use serde_json::Value;
use sqlx::SqlitePool;
use std::env;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration};

pub type DbPool = Arc<Mutex<Option<SqlitePool>>>;
const DB_INIT_WAIT_RETRIES: usize = 300;
const DB_INIT_WAIT_DELAY_MS: u64 = 50;

#[derive(Debug, Serialize)]
pub struct CommandError {
    pub message: String,
}

impl From<DbError> for CommandError {
    fn from(err: DbError) -> Self {
        CommandError {
            message: err.to_string(),
        }
    }
}

pub(crate) type CommandResult<T> = Result<T, CommandError>;

pub(crate) fn command_error(message: impl Into<String>) -> CommandError {
    CommandError {
        message: message.into(),
    }
}

pub(crate) async fn get_pool(pool: &State<'_, DbPool>) -> CommandResult<SqlitePool> {
    for attempt in 0..DB_INIT_WAIT_RETRIES {
        {
            let pool_guard = pool.lock().await;
            if let Some(pool) = pool_guard.as_ref() {
                return Ok(pool.clone());
            }
        }

        if attempt == 20 || attempt == 100 || attempt == 200 {
            tracing::warn!(
                attempt = attempt + 1,
                waited_ms = (attempt + 1) as u64 * DB_INIT_WAIT_DELAY_MS,
                "Database pool is still initializing"
            );
        }

        if attempt + 1 < DB_INIT_WAIT_RETRIES {
            sleep(Duration::from_millis(DB_INIT_WAIT_DELAY_MS)).await;
        }
    }

    Err(CommandError {
        message: "Database not initialized yet. Please retry in a moment.".to_string(),
    })
}

#[tauri::command]
pub async fn tool_get_mode_policy(mode: String) -> CommandResult<ToolModePolicyResult> {
    Ok(get_mode_policy(&mode))
}

#[tauri::command]
pub async fn tool_validate_execution(
    mode: String,
    tool_id: String,
    path: Option<String>,
) -> CommandResult<ToolValidationResult> {
    Ok(validate_tool_execution(&mode, &tool_id, path.as_deref()))
}

#[tauri::command]
pub async fn ai_get_dev_provider_overrides(
    workspace_metadata_root: State<'_, WorkspaceMetadataRoot>,
) -> CommandResult<Option<DevProviderOverridesFile>> {
    if !tauri::is_dev() {
        return Ok(None);
    }

    let workspace_root = workspace_metadata_root.0.read().await.clone();
    Ok(crate::dev_overrides::load_dev_provider_overrides_from_workspace(&workspace_root))
}

fn json_arg_string(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
}

fn json_arg_bool(args: &Value, key: &str) -> Option<bool> {
    args.get(key).and_then(|value| value.as_bool())
}

fn json_arg_u32(args: &Value, key: &str) -> Option<u32> {
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

fn format_with_line_numbers(lines: &[&str], start_line: usize) -> String {
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
        let workspace_for_task = workspace.to_path_buf();
        let workspace_for_fallback = workspace.to_path_buf();
        let git_state_for_task = git_state.clone();
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

    let requested_path = PathBuf::from(requested_workspace);
    let candidate = if requested_path.is_absolute() {
        requested_path
    } else {
        metadata_workspace.join(requested_path)
    };

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
enum ParsedPatchOperation {
    Add { path: String, lines: Vec<String> },
    Update { path: String, hunks: Vec<PatchHunk> },
    Delete { path: String },
}

#[derive(Debug, Clone)]
struct PatchHunk {
    lines: Vec<PatchHunkLine>,
}

#[derive(Debug, Clone)]
struct PatchHunkLine {
    kind: char,
    content: String,
}

#[derive(Debug, Clone)]
struct PendingFileChange {
    display_path: String,
    effective_workspace: PathBuf,
    effective_path: String,
    absolute_path: PathBuf,
    status: String,
    new_content: Option<String>,
    created: bool,
    bytes_written: u64,
    additions: usize,
    deletions: usize,
}

fn parse_apply_patch(patch_text: &str) -> CommandResult<Vec<ParsedPatchOperation>> {
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

fn join_text_lines(lines: &[String], trailing_newline: bool) -> String {
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

fn apply_patch_hunks_to_content(
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

fn compute_line_change_stats(old_content: &str, new_content: &str) -> (usize, usize) {
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

fn resolve_validated_tool_path(
    workspace: &Path,
    path: &str,
    for_write: bool,
) -> CommandResult<PathBuf> {
    let path_buf = PathBuf::from(path);
    if for_write {
        validate_fs_path_for_write(&path_buf, workspace)
            .map_err(|error| command_error(error.to_string()))
    } else {
        validate_fs_path(&path_buf, workspace).map_err(|error| command_error(error.to_string()))
    }
}

async fn build_post_write_response(
    changes: &[PendingFileChange],
    extra_fields: serde_json::Map<String, Value>,
) -> CommandResult<String> {
    let mut files = Vec::new();
    let mut validation_files = Vec::new();
    let mut errors = Vec::new();

    for change in changes {
        let validation = if change.new_content.is_some() {
            match fs::read_file_internal(
                &change.effective_workspace,
                change.effective_path.clone(),
                None,
            )
            .await
            {
                Ok(read_result) => serde_json::json!({
                    "path": change.display_path,
                    "exists": true,
                    "readable": true,
                    "is_binary": read_result.is_binary,
                    "size": read_result.size,
                    "encoding": read_result.encoding,
                    "language": read_result.language,
                }),
                Err(error) => {
                    errors.push(format!(
                        "Validation failed for {}: {}",
                        change.display_path, error
                    ));
                    serde_json::json!({
                        "path": change.display_path,
                        "exists": true,
                        "readable": false,
                        "is_binary": false,
                        "size": 0,
                        "encoding": Value::Null,
                        "language": Value::Null,
                    })
                }
            }
        } else {
            let exists = tokio::fs::try_exists(&change.absolute_path)
                .await
                .map_err(|error| {
                    command_error(format!(
                        "Failed to validate deleted file {}: {}",
                        change.display_path, error
                    ))
                })?;
            if exists {
                errors.push(format!(
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
            })
        };

        validation_files.push(validation.clone());
        files.push(serde_json::json!({
            "path": change.display_path,
            "status": change.status,
            "additions": change.additions,
            "deletions": change.deletions,
            "created": change.created,
            "bytes_written": change.bytes_written,
            "validation": validation,
        }));
    }

    let mut response = serde_json::Map::new();
    response.insert("ok".to_string(), Value::Bool(errors.is_empty()));
    response.insert("files".to_string(), Value::Array(files));
    response.insert(
        "diff".to_string(),
        Value::String(build_diff_summary(changes)),
    );
    response.insert("diagnostics".to_string(), Value::Array(Vec::new()));
    response.insert(
        "validation".to_string(),
        serde_json::json!({
            "all_files_readable": errors.is_empty(),
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

#[derive(Clone, Copy)]
enum ExternalOpenAction {
    Editor,
    Terminal,
    Files,
}

impl ExternalOpenAction {
    fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "editor" => Some(Self::Editor),
            "terminal" => Some(Self::Terminal),
            "files" => Some(Self::Files),
            _ => None,
        }
    }
}

impl ExternalOpenAction {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Editor => "editor",
            Self::Terminal => "terminal",
            Self::Files => "files",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ExternalAppOptionDto {
    pub id: String,
    pub label: String,
    pub action: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExternalAppCatalogDto {
    pub editor: Vec<ExternalAppOptionDto>,
    pub terminal: Vec<ExternalAppOptionDto>,
    pub files: Vec<ExternalAppOptionDto>,
}

struct ExternalLaunchCommand {
    program: String,
    args: Vec<String>,
    current_dir: Option<PathBuf>,
}

fn external_app_option(
    id: &str,
    label: &str,
    action: ExternalOpenAction,
    kind: &str,
) -> ExternalAppOptionDto {
    ExternalAppOptionDto {
        id: id.to_string(),
        label: label.to_string(),
        action: action.as_str().to_string(),
        kind: kind.to_string(),
    }
}

fn none_external_app(action: ExternalOpenAction) -> ExternalAppOptionDto {
    external_app_option("none", "Do nothing", action, "none")
}

fn binary_candidates(binary: &str) -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        let path = Path::new(binary);
        if path.extension().is_some() {
            return vec![binary.to_string()];
        }

        return vec![
            format!("{}.exe", binary),
            format!("{}.cmd", binary),
            format!("{}.bat", binary),
            binary.to_string(),
        ];
    }

    #[cfg(not(target_os = "windows"))]
    {
        vec![binary.to_string()]
    }
}

fn is_binary_available(binary: &str) -> bool {
    let binary_path = Path::new(binary);
    if binary_path.components().count() > 1 {
        return binary_path.exists();
    }

    let Some(path_var) = env::var_os("PATH") else {
        return false;
    };

    env::split_paths(&path_var).any(|dir| {
        binary_candidates(binary)
            .into_iter()
            .map(|candidate| dir.join(candidate))
            .any(|candidate| candidate.is_file())
    })
}

#[cfg(target_os = "macos")]
fn mac_app_bundle_path(names: &[&str]) -> Option<PathBuf> {
    let app_bundles = names
        .iter()
        .map(|name| {
            if name.ends_with(".app") {
                name.to_string()
            } else {
                format!("{}.app", name)
            }
        })
        .collect::<Vec<_>>();

    let mut candidate_roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/Applications/Utilities"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
        PathBuf::from("/System/Library/CoreServices"),
    ];

    if let Some(home_dir) = env::var_os("HOME") {
        candidate_roots.push(PathBuf::from(&home_dir).join("Applications"));
        candidate_roots.push(PathBuf::from(home_dir).join("Applications/Utilities"));
    }

    candidate_roots.into_iter().find_map(|root| {
        app_bundles
            .iter()
            .map(|bundle| root.join(bundle))
            .find(|candidate| candidate.exists())
    })
}

#[cfg(target_os = "macos")]
fn mac_app_exists(names: &[&str]) -> bool {
    mac_app_bundle_path(names).is_some()
}

#[cfg(target_os = "macos")]
fn push_mac_app(
    apps: &mut Vec<ExternalAppOptionDto>,
    id: &str,
    label: &str,
    action: ExternalOpenAction,
    bundle_names: &[&str],
    kind: &str,
) {
    if mac_app_exists(bundle_names) {
        apps.push(external_app_option(id, label, action, kind));
    }
}

#[cfg(target_os = "macos")]
fn mac_app_executable_path(bundle_names: &[&str], executable_names: &[&str]) -> Option<PathBuf> {
    let bundle_path = mac_app_bundle_path(bundle_names)?;
    let executable_dir = bundle_path.join("Contents/MacOS");

    for executable_name in executable_names {
        let candidate = executable_dir.join(executable_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    std::fs::read_dir(&executable_dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| path.is_file())
}

#[cfg(target_os = "macos")]
fn mac_binary_or_app_executable(
    binary_names: &[&str],
    bundle_names: &[&str],
    executable_names: &[&str],
) -> Option<String> {
    binary_names
        .iter()
        .find(|binary_name| is_binary_available(binary_name))
        .map(|binary_name| (*binary_name).to_string())
        .or_else(|| {
            mac_app_executable_path(bundle_names, executable_names)
                .map(|path| path.to_string_lossy().to_string())
        })
}

#[cfg(not(target_os = "macos"))]
fn push_binary_app(
    apps: &mut Vec<ExternalAppOptionDto>,
    id: &str,
    label: &str,
    action: ExternalOpenAction,
    binary_name: &str,
    kind: &str,
) {
    if is_binary_available(binary_name) {
        apps.push(external_app_option(id, label, action, kind));
    }
}

#[cfg(target_os = "macos")]
fn build_external_app_catalog() -> ExternalAppCatalogDto {
    let mut editor = vec![none_external_app(ExternalOpenAction::Editor)];
    push_mac_app(
        &mut editor,
        "vscode",
        "Visual Studio Code",
        ExternalOpenAction::Editor,
        &["Visual Studio Code"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "vscode-insiders",
        "VS Code Insiders",
        ExternalOpenAction::Editor,
        &["Visual Studio Code - Insiders", "VS Code - Insiders"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "vscodium",
        "VSCodium",
        ExternalOpenAction::Editor,
        &["VSCodium"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "cursor",
        "Cursor",
        ExternalOpenAction::Editor,
        &["Cursor"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "windsurf",
        "Windsurf",
        ExternalOpenAction::Editor,
        &["Windsurf"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "zed",
        "Zed",
        ExternalOpenAction::Editor,
        &["Zed"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "antigravity",
        "Antigravity",
        ExternalOpenAction::Editor,
        &["Antigravity"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "sublime-text",
        "Sublime Text",
        ExternalOpenAction::Editor,
        &["Sublime Text"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "bbedit",
        "BBEdit",
        ExternalOpenAction::Editor,
        &["BBEdit"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "nova",
        "Nova",
        ExternalOpenAction::Editor,
        &["Nova"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "textmate",
        "TextMate",
        ExternalOpenAction::Editor,
        &["TextMate"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "fleet",
        "JetBrains Fleet",
        ExternalOpenAction::Editor,
        &["Fleet"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "intellij-idea",
        "IntelliJ IDEA",
        ExternalOpenAction::Editor,
        &[
            "IntelliJ IDEA",
            "IntelliJ IDEA CE",
            "IntelliJ IDEA Ultimate",
        ],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "pycharm",
        "PyCharm",
        ExternalOpenAction::Editor,
        &["PyCharm", "PyCharm CE", "PyCharm Professional"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "webstorm",
        "WebStorm",
        ExternalOpenAction::Editor,
        &["WebStorm"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "phpstorm",
        "PhpStorm",
        ExternalOpenAction::Editor,
        &["PhpStorm"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "goland",
        "GoLand",
        ExternalOpenAction::Editor,
        &["GoLand"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "clion",
        "CLion",
        ExternalOpenAction::Editor,
        &["CLion"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "rider",
        "Rider",
        ExternalOpenAction::Editor,
        &["Rider"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "rubymine",
        "RubyMine",
        ExternalOpenAction::Editor,
        &["RubyMine"],
        "detected",
    );
    push_mac_app(
        &mut editor,
        "rustrover",
        "RustRover",
        ExternalOpenAction::Editor,
        &["RustRover"],
        "detected",
    );

    let mut terminal = vec![none_external_app(ExternalOpenAction::Terminal)];
    push_mac_app(
        &mut terminal,
        "terminal",
        "Terminal",
        ExternalOpenAction::Terminal,
        &["Terminal"],
        "builtin",
    );
    push_mac_app(
        &mut terminal,
        "ghostty",
        "Ghostty",
        ExternalOpenAction::Terminal,
        &["Ghostty"],
        "detected",
    );
    push_mac_app(
        &mut terminal,
        "wezterm",
        "WezTerm",
        ExternalOpenAction::Terminal,
        &["WezTerm"],
        "detected",
    );
    push_mac_app(
        &mut terminal,
        "kitty",
        "Kitty",
        ExternalOpenAction::Terminal,
        &["kitty", "Kitty"],
        "detected",
    );
    push_mac_app(
        &mut terminal,
        "alacritty",
        "Alacritty",
        ExternalOpenAction::Terminal,
        &["Alacritty"],
        "detected",
    );

    let mut files = vec![none_external_app(ExternalOpenAction::Files)];
    push_mac_app(
        &mut files,
        "finder",
        "Finder",
        ExternalOpenAction::Files,
        &["Finder"],
        "builtin",
    );
    push_mac_app(
        &mut files,
        "path-finder",
        "Path Finder",
        ExternalOpenAction::Files,
        &["Path Finder"],
        "detected",
    );
    push_mac_app(
        &mut files,
        "forklift",
        "ForkLift",
        ExternalOpenAction::Files,
        &["ForkLift"],
        "detected",
    );
    push_mac_app(
        &mut files,
        "commander-one",
        "Commander One",
        ExternalOpenAction::Files,
        &["Commander One"],
        "detected",
    );

    ExternalAppCatalogDto {
        editor,
        terminal,
        files,
    }
}

#[cfg(target_os = "windows")]
fn build_external_app_catalog() -> ExternalAppCatalogDto {
    let mut editor = vec![none_external_app(ExternalOpenAction::Editor)];
    push_binary_app(
        &mut editor,
        "vscode",
        "Visual Studio Code",
        ExternalOpenAction::Editor,
        "code",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "vscode-insiders",
        "VS Code Insiders",
        ExternalOpenAction::Editor,
        "code-insiders",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "vscodium",
        "VSCodium",
        ExternalOpenAction::Editor,
        "codium",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "cursor",
        "Cursor",
        ExternalOpenAction::Editor,
        "cursor",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "windsurf",
        "Windsurf",
        ExternalOpenAction::Editor,
        "windsurf",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "zed",
        "Zed",
        ExternalOpenAction::Editor,
        "zed",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "sublime-text",
        "Sublime Text",
        ExternalOpenAction::Editor,
        "subl",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "lapce",
        "Lapce",
        ExternalOpenAction::Editor,
        "lapce",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "fleet",
        "JetBrains Fleet",
        ExternalOpenAction::Editor,
        "fleet",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "intellij-idea",
        "IntelliJ IDEA",
        ExternalOpenAction::Editor,
        "idea64",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "pycharm",
        "PyCharm",
        ExternalOpenAction::Editor,
        "pycharm64",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "webstorm",
        "WebStorm",
        ExternalOpenAction::Editor,
        "webstorm64",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "phpstorm",
        "PhpStorm",
        ExternalOpenAction::Editor,
        "phpstorm64",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "goland",
        "GoLand",
        ExternalOpenAction::Editor,
        "goland64",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "clion",
        "CLion",
        ExternalOpenAction::Editor,
        "clion64",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "rider",
        "Rider",
        ExternalOpenAction::Editor,
        "rider64",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "rustrover",
        "RustRover",
        ExternalOpenAction::Editor,
        "rustrover64",
        "detected",
    );

    let mut terminal = vec![none_external_app(ExternalOpenAction::Terminal)];
    push_binary_app(
        &mut terminal,
        "windows-terminal",
        "Windows Terminal",
        ExternalOpenAction::Terminal,
        "wt",
        "detected",
    );
    terminal.push(external_app_option(
        "powershell",
        "PowerShell",
        ExternalOpenAction::Terminal,
        "builtin",
    ));
    push_binary_app(
        &mut terminal,
        "pwsh",
        "PowerShell 7",
        ExternalOpenAction::Terminal,
        "pwsh",
        "detected",
    );
    terminal.push(external_app_option(
        "command-prompt",
        "Command Prompt",
        ExternalOpenAction::Terminal,
        "builtin",
    ));
    push_binary_app(
        &mut terminal,
        "wezterm",
        "WezTerm",
        ExternalOpenAction::Terminal,
        "wezterm",
        "detected",
    );
    push_binary_app(
        &mut terminal,
        "ghostty",
        "Ghostty",
        ExternalOpenAction::Terminal,
        "ghostty",
        "detected",
    );
    push_binary_app(
        &mut terminal,
        "kitty",
        "Kitty",
        ExternalOpenAction::Terminal,
        "kitty",
        "detected",
    );
    let files = vec![
        none_external_app(ExternalOpenAction::Files),
        external_app_option(
            "explorer",
            "File Explorer",
            ExternalOpenAction::Files,
            "builtin",
        ),
    ];

    ExternalAppCatalogDto {
        editor,
        terminal,
        files,
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn build_external_app_catalog() -> ExternalAppCatalogDto {
    let mut editor = vec![none_external_app(ExternalOpenAction::Editor)];
    push_binary_app(
        &mut editor,
        "vscode",
        "Visual Studio Code",
        ExternalOpenAction::Editor,
        "code",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "vscode-insiders",
        "VS Code Insiders",
        ExternalOpenAction::Editor,
        "code-insiders",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "vscodium",
        "VSCodium",
        ExternalOpenAction::Editor,
        "codium",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "code-oss",
        "Code - OSS",
        ExternalOpenAction::Editor,
        "code-oss",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "cursor",
        "Cursor",
        ExternalOpenAction::Editor,
        "cursor",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "windsurf",
        "Windsurf",
        ExternalOpenAction::Editor,
        "windsurf",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "zed",
        "Zed",
        ExternalOpenAction::Editor,
        "zed",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "sublime-text",
        "Sublime Text",
        ExternalOpenAction::Editor,
        "subl",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "lapce",
        "Lapce",
        ExternalOpenAction::Editor,
        "lapce",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "fleet",
        "JetBrains Fleet",
        ExternalOpenAction::Editor,
        "fleet",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "kate",
        "Kate",
        ExternalOpenAction::Editor,
        "kate",
        "detected",
    );
    push_binary_app(
        &mut editor,
        "geany",
        "Geany",
        ExternalOpenAction::Editor,
        "geany",
        "detected",
    );

    let mut terminal = vec![none_external_app(ExternalOpenAction::Terminal)];
    push_binary_app(
        &mut terminal,
        "gnome-terminal",
        "GNOME Terminal",
        ExternalOpenAction::Terminal,
        "gnome-terminal",
        "detected",
    );
    push_binary_app(
        &mut terminal,
        "konsole",
        "Konsole",
        ExternalOpenAction::Terminal,
        "konsole",
        "detected",
    );
    push_binary_app(
        &mut terminal,
        "xfce4-terminal",
        "Xfce Terminal",
        ExternalOpenAction::Terminal,
        "xfce4-terminal",
        "detected",
    );
    push_binary_app(
        &mut terminal,
        "tilix",
        "Tilix",
        ExternalOpenAction::Terminal,
        "tilix",
        "detected",
    );
    push_binary_app(
        &mut terminal,
        "mate-terminal",
        "MATE Terminal",
        ExternalOpenAction::Terminal,
        "mate-terminal",
        "detected",
    );
    push_binary_app(
        &mut terminal,
        "kitty",
        "Kitty",
        ExternalOpenAction::Terminal,
        "kitty",
        "detected",
    );
    push_binary_app(
        &mut terminal,
        "wezterm",
        "WezTerm",
        ExternalOpenAction::Terminal,
        "wezterm",
        "detected",
    );
    push_binary_app(
        &mut terminal,
        "ghostty",
        "Ghostty",
        ExternalOpenAction::Terminal,
        "ghostty",
        "detected",
    );
    let mut files = vec![none_external_app(ExternalOpenAction::Files)];
    push_binary_app(
        &mut files,
        "xdg-open",
        "System File Browser",
        ExternalOpenAction::Files,
        "xdg-open",
        "builtin",
    );
    push_binary_app(
        &mut files,
        "nautilus",
        "Nautilus",
        ExternalOpenAction::Files,
        "nautilus",
        "detected",
    );
    push_binary_app(
        &mut files,
        "dolphin",
        "Dolphin",
        ExternalOpenAction::Files,
        "dolphin",
        "detected",
    );
    push_binary_app(
        &mut files,
        "thunar",
        "Thunar",
        ExternalOpenAction::Files,
        "thunar",
        "detected",
    );
    push_binary_app(
        &mut files,
        "nemo",
        "Nemo",
        ExternalOpenAction::Files,
        "nemo",
        "detected",
    );
    push_binary_app(
        &mut files,
        "caja",
        "Caja",
        ExternalOpenAction::Files,
        "caja",
        "detected",
    );
    push_binary_app(
        &mut files,
        "pcmanfm",
        "PCManFM",
        ExternalOpenAction::Files,
        "pcmanfm",
        "detected",
    );

    ExternalAppCatalogDto {
        editor,
        terminal,
        files,
    }
}

fn target_parent_dir(path: &Path) -> Option<PathBuf> {
    if path.is_dir() {
        Some(path.to_path_buf())
    } else {
        path.parent().map(Path::to_path_buf)
    }
}

#[cfg(target_os = "macos")]
fn mac_open_known_app_command(
    bundle_names: &[&str],
    target_path: &Path,
) -> CommandResult<ExternalLaunchCommand> {
    let bundle_path = mac_app_bundle_path(bundle_names)
        .ok_or_else(|| command_error("Configured macOS app was not found."))?;
    let app_name = bundle_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| command_error("Configured macOS app bundle is invalid."))?;

    Ok(ExternalLaunchCommand {
        program: "open".to_string(),
        args: vec![
            "-a".to_string(),
            app_name.to_string(),
            target_path.to_string_lossy().to_string(),
        ],
        current_dir: target_parent_dir(target_path),
    })
}

#[cfg(target_os = "windows")]
fn escape_powershell_literal(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(target_os = "windows")]
fn escape_cmd_literal(value: &str) -> String {
    value.replace('"', "\"\"")
}

#[cfg(target_os = "macos")]
fn mac_binary_or_app_command(
    binary_names: &[&str],
    bundle_names: &[&str],
    executable_names: &[&str],
    args: Vec<String>,
    target_path: &Path,
) -> CommandResult<ExternalLaunchCommand> {
    let program = mac_binary_or_app_executable(binary_names, bundle_names, executable_names)
        .ok_or_else(|| {
            command_error(format!("App is installed but no launch binary was found."))
        })?;

    Ok(ExternalLaunchCommand {
        program,
        args,
        current_dir: target_parent_dir(target_path),
    })
}

fn build_external_open_command(
    target_path: &Path,
    app_id: &str,
) -> CommandResult<ExternalLaunchCommand> {
    #[cfg(target_os = "macos")]
    let command = match app_id {
        "vscode" => mac_open_known_app_command(&["Visual Studio Code"], target_path)?,
        "vscode-insiders" => mac_open_known_app_command(
            &["Visual Studio Code - Insiders", "VS Code - Insiders"],
            target_path,
        )?,
        "vscodium" => mac_open_known_app_command(&["VSCodium"], target_path)?,
        "cursor" => mac_open_known_app_command(&["Cursor"], target_path)?,
        "windsurf" => mac_open_known_app_command(&["Windsurf"], target_path)?,
        "zed" => mac_open_known_app_command(&["Zed"], target_path)?,
        "antigravity" => mac_open_known_app_command(&["Antigravity"], target_path)?,
        "sublime-text" => mac_open_known_app_command(&["Sublime Text"], target_path)?,
        "bbedit" => mac_open_known_app_command(&["BBEdit"], target_path)?,
        "nova" => mac_open_known_app_command(&["Nova"], target_path)?,
        "textmate" => mac_open_known_app_command(&["TextMate"], target_path)?,
        "fleet" => mac_open_known_app_command(&["Fleet"], target_path)?,
        "intellij-idea" => mac_open_known_app_command(
            &[
                "IntelliJ IDEA",
                "IntelliJ IDEA CE",
                "IntelliJ IDEA Ultimate",
            ],
            target_path,
        )?,
        "pycharm" => mac_open_known_app_command(
            &["PyCharm", "PyCharm CE", "PyCharm Professional"],
            target_path,
        )?,
        "webstorm" => mac_open_known_app_command(&["WebStorm"], target_path)?,
        "phpstorm" => mac_open_known_app_command(&["PhpStorm"], target_path)?,
        "goland" => mac_open_known_app_command(&["GoLand"], target_path)?,
        "clion" => mac_open_known_app_command(&["CLion"], target_path)?,
        "rider" => mac_open_known_app_command(&["Rider"], target_path)?,
        "rubymine" => mac_open_known_app_command(&["RubyMine"], target_path)?,
        "rustrover" => mac_open_known_app_command(&["RustRover"], target_path)?,
        "terminal" => mac_open_known_app_command(&["Terminal"], target_path)?,
        "ghostty" => mac_binary_or_app_command(
            &["ghostty"],
            &["Ghostty"],
            &["ghostty"],
            vec![
                "--working-directory".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            target_path,
        )?,
        "wezterm" => mac_binary_or_app_command(
            &["wezterm"],
            &["WezTerm"],
            &["wezterm", "wezterm-gui"],
            vec![
                "start".to_string(),
                "--cwd".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            target_path,
        )?,
        "kitty" => mac_binary_or_app_command(
            &["kitty"],
            &["kitty", "Kitty"],
            &["kitty"],
            vec![
                "launch".to_string(),
                "--cwd".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            target_path,
        )?,
        "alacritty" => mac_binary_or_app_command(
            &["alacritty"],
            &["Alacritty"],
            &["alacritty"],
            vec![
                "--working-directory".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            target_path,
        )?,
        "finder" => mac_open_known_app_command(&["Finder"], target_path)?,
        "path-finder" => mac_open_known_app_command(&["Path Finder"], target_path)?,
        "forklift" => mac_open_known_app_command(&["ForkLift"], target_path)?,
        "commander-one" => mac_open_known_app_command(&["Commander One"], target_path)?,
        "none" => {
            return Err(command_error("This open action is disabled."));
        }
        _ => {
            return Err(command_error(format!(
                "Unsupported external app id: {}",
                app_id
            )))
        }
    };

    #[cfg(target_os = "windows")]
    let command = match app_id {
        "vscode" => ExternalLaunchCommand {
            program: "code".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "vscode-insiders" => ExternalLaunchCommand {
            program: "code-insiders".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "vscodium" => ExternalLaunchCommand {
            program: "codium".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "cursor" => ExternalLaunchCommand {
            program: "cursor".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "windsurf" => ExternalLaunchCommand {
            program: "windsurf".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "zed" => ExternalLaunchCommand {
            program: "zed".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "sublime-text" => ExternalLaunchCommand {
            program: "subl".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "lapce" => ExternalLaunchCommand {
            program: "lapce".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "fleet" => ExternalLaunchCommand {
            program: "fleet".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "intellij-idea" => ExternalLaunchCommand {
            program: "idea64".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "pycharm" => ExternalLaunchCommand {
            program: "pycharm64".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "webstorm" => ExternalLaunchCommand {
            program: "webstorm64".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "phpstorm" => ExternalLaunchCommand {
            program: "phpstorm64".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "goland" => ExternalLaunchCommand {
            program: "goland64".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "clion" => ExternalLaunchCommand {
            program: "clion64".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "rider" => ExternalLaunchCommand {
            program: "rider64".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "rustrover" => ExternalLaunchCommand {
            program: "rustrover64".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "windows-terminal" => ExternalLaunchCommand {
            program: "wt".to_string(),
            args: vec![
                "new-tab".to_string(),
                "--startingDirectory".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            current_dir: target_parent_dir(target_path),
        },
        "powershell" => ExternalLaunchCommand {
            program: "powershell".to_string(),
            args: vec![
                "-NoExit".to_string(),
                "-Command".to_string(),
                format!(
                    "Set-Location -LiteralPath '{}'",
                    escape_powershell_literal(&target_path.to_string_lossy())
                ),
            ],
            current_dir: target_parent_dir(target_path),
        },
        "command-prompt" => ExternalLaunchCommand {
            program: "cmd".to_string(),
            args: vec![
                "/K".to_string(),
                format!(
                    r#"cd /d "{}""#,
                    escape_cmd_literal(&target_path.to_string_lossy())
                ),
            ],
            current_dir: target_parent_dir(target_path),
        },
        "pwsh" => ExternalLaunchCommand {
            program: "pwsh".to_string(),
            args: vec![
                "-NoExit".to_string(),
                "-Command".to_string(),
                format!(
                    "Set-Location -LiteralPath '{}'",
                    escape_powershell_literal(&target_path.to_string_lossy())
                ),
            ],
            current_dir: target_parent_dir(target_path),
        },
        "wezterm" => ExternalLaunchCommand {
            program: "wezterm".to_string(),
            args: vec![
                "start".to_string(),
                "--cwd".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            current_dir: target_parent_dir(target_path),
        },
        "ghostty" => ExternalLaunchCommand {
            program: "ghostty".to_string(),
            args: vec![
                "--working-directory".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            current_dir: target_parent_dir(target_path),
        },
        "kitty" => ExternalLaunchCommand {
            program: "kitty".to_string(),
            args: vec![
                "launch".to_string(),
                "--cwd".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            current_dir: target_parent_dir(target_path),
        },
        "explorer" => ExternalLaunchCommand {
            program: "explorer".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "none" => {
            return Err(command_error("This open action is disabled."));
        }
        _ => {
            return Err(command_error(format!(
                "Unsupported external app id: {}",
                app_id
            )))
        }
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let command = match app_id {
        "vscode" => ExternalLaunchCommand {
            program: "code".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "vscode-insiders" => ExternalLaunchCommand {
            program: "code-insiders".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "vscodium" => ExternalLaunchCommand {
            program: "codium".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "code-oss" => ExternalLaunchCommand {
            program: "code-oss".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "cursor" => ExternalLaunchCommand {
            program: "cursor".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "windsurf" => ExternalLaunchCommand {
            program: "windsurf".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "zed" => ExternalLaunchCommand {
            program: "zed".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "sublime-text" => ExternalLaunchCommand {
            program: "subl".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "lapce" => ExternalLaunchCommand {
            program: "lapce".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "fleet" => ExternalLaunchCommand {
            program: "fleet".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "kate" => ExternalLaunchCommand {
            program: "kate".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "geany" => ExternalLaunchCommand {
            program: "geany".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "gnome-terminal" => ExternalLaunchCommand {
            program: "gnome-terminal".to_string(),
            args: vec![
                "--working-directory".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            current_dir: target_parent_dir(target_path),
        },
        "konsole" => ExternalLaunchCommand {
            program: "konsole".to_string(),
            args: vec![
                "--workdir".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            current_dir: target_parent_dir(target_path),
        },
        "xfce4-terminal" => ExternalLaunchCommand {
            program: "xfce4-terminal".to_string(),
            args: vec![
                "--working-directory".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            current_dir: target_parent_dir(target_path),
        },
        "tilix" => ExternalLaunchCommand {
            program: "tilix".to_string(),
            args: vec![
                "--working-directory".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            current_dir: target_parent_dir(target_path),
        },
        "mate-terminal" => ExternalLaunchCommand {
            program: "mate-terminal".to_string(),
            args: vec![
                "--working-directory".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            current_dir: target_parent_dir(target_path),
        },
        "kitty" => ExternalLaunchCommand {
            program: "kitty".to_string(),
            args: vec![
                "launch".to_string(),
                "--cwd".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            current_dir: target_parent_dir(target_path),
        },
        "wezterm" => ExternalLaunchCommand {
            program: "wezterm".to_string(),
            args: vec![
                "start".to_string(),
                "--cwd".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            current_dir: target_parent_dir(target_path),
        },
        "ghostty" => ExternalLaunchCommand {
            program: "ghostty".to_string(),
            args: vec![
                "--working-directory".to_string(),
                target_path.to_string_lossy().to_string(),
            ],
            current_dir: target_parent_dir(target_path),
        },
        "xdg-open" => ExternalLaunchCommand {
            program: "xdg-open".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "nautilus" => ExternalLaunchCommand {
            program: "nautilus".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "dolphin" => ExternalLaunchCommand {
            program: "dolphin".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "thunar" => ExternalLaunchCommand {
            program: "thunar".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "nemo" => ExternalLaunchCommand {
            program: "nemo".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "caja" => ExternalLaunchCommand {
            program: "caja".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "pcmanfm" => ExternalLaunchCommand {
            program: "pcmanfm".to_string(),
            args: vec![target_path.to_string_lossy().to_string()],
            current_dir: target_parent_dir(target_path),
        },
        "none" => {
            return Err(command_error("This open action is disabled."));
        }
        _ => {
            return Err(command_error(format!(
                "Unsupported external app id: {}",
                app_id
            )))
        }
    };

    Ok(command)
}

#[tauri::command]
pub async fn list_external_apps() -> CommandResult<ExternalAppCatalogDto> {
    Ok(build_external_app_catalog())
}

#[tauri::command]
pub async fn open_external_target(
    target_path: String,
    action: String,
    app_id: String,
) -> CommandResult<()> {
    let action = ExternalOpenAction::parse(&action)
        .ok_or_else(|| command_error(format!("Unsupported open action: {}", action)))?;
    let resolved_path = PathBuf::from(target_path.trim());
    let canonical_path = resolved_path
        .canonicalize()
        .map_err(|error| command_error(format!("Open target not found: {}", error)))?;
    let app_catalog = build_external_app_catalog();
    let action_apps = match action {
        ExternalOpenAction::Editor => &app_catalog.editor,
        ExternalOpenAction::Terminal => &app_catalog.terminal,
        ExternalOpenAction::Files => &app_catalog.files,
    };

    if !action_apps.iter().any(|app| app.id == app_id) {
        return Err(command_error(format!(
            "App id \"{}\" is not available for {}.",
            app_id,
            action.as_str()
        )));
    }

    let launch = build_external_open_command(&canonical_path, app_id.as_str())?;

    tokio::task::spawn_blocking(move || {
        let mut command = Command::new(&launch.program);
        command.args(&launch.args);
        command.stdin(Stdio::null());
        command.stdout(Stdio::null());
        command.stderr(Stdio::null());

        if let Some(current_dir) = launch.current_dir {
            command.current_dir(current_dir);
        }

        command
            .spawn()
            .map(|_| ())
            .map_err(|error| command_error(format!("Failed to launch external app: {}", error)))
    })
    .await
    .map_err(|error| command_error(format!("External launch task failed: {}", error)))?
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
) -> CommandResult<String> {
    let workspace = resolve_requested_workspace(
        &default_workspace,
        &metadata_workspace,
        workspace_path.as_deref(),
    )?;
    let mode_trimmed = mode.trim().to_string();
    let tool_trimmed = tool_id.trim().to_string();

    let candidate_path =
        json_arg_string(&args, "path").or_else(|| json_arg_string(&args, "repo_path"));

    let validation =
        validate_tool_execution(&mode_trimmed, &tool_trimmed, candidate_path.as_deref());

    if !validation.allowed {
        return Ok(validation
            .reason
            .unwrap_or_else(|| format!("Tool {} is not allowed", tool_trimmed)));
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
                effective_path,
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

            serde_json::to_string_pretty(&serde_json::json!({
                "path": path,
                "count": entries.len(),
                "entries": entries
            }))
            .map_err(|error| command_error(error.to_string()))
        }
        "read" => {
            let path = json_arg_string(&args, "path")
                .ok_or_else(|| command_error("Missing path argument for read tool."))?;
            let effective_path = remap_macro_tool_path(path.as_str());
            let start_line = json_arg_u32(&args, "start_line").unwrap_or(1).max(1) as usize;
            let end_line = json_arg_u32(&args, "end_line").map(|value| value as usize);
            let effective_workspace = resolve_workspace_for_tool_path(
                &workspace,
                &git_state,
                Some(path.as_str()),
                workspace_scope.as_deref(),
            )
            .await?;

            let result = fs::read_file_internal(
                &effective_workspace,
                effective_path,
                Some(false),
            )
            .await
            .map_err(|error| command_error(error.to_string()))?;

            if result.is_binary {
                return Ok(format!(
                    "File {} is binary ({} bytes, encoding={}).",
                    path, result.size, result.encoding
                ));
            }

            let lines: Vec<&str> = result.content.lines().collect();
            let effective_start = start_line.min(lines.len().max(1));
            let effective_end = end_line
                .map(|value| value.max(effective_start))
                .unwrap_or(lines.len().max(effective_start));

            let selected: Vec<&str> = if lines.is_empty() {
                vec![""]
            } else {
                lines
                    .iter()
                    .skip(effective_start.saturating_sub(1))
                    .take(effective_end.saturating_sub(effective_start) + 1)
                    .copied()
                    .collect()
            };

            let numbered = format_with_line_numbers(&selected, effective_start);
            Ok(format!(
                "FILE: {}\nSOURCE: WORKSPACE_FILE\nLANGUAGE: {}\nSIZE: {}\nLINES: {}-{}\n\n---BEGIN FILE CONTENT---\n{}\n---END FILE CONTENT---",
                path,
                result.language,
                result.size,
                effective_start,
                effective_start + selected.len().saturating_sub(1),
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
            let effective_workspace = resolve_workspace_for_tool_path(
                &workspace,
                &git_state,
                Some(path.as_str()),
                workspace_scope.as_deref(),
            )
            .await?;

            let absolute_path =
                resolve_validated_tool_path(&effective_workspace, effective_path.as_str(), true)?;

            let write_result = fs::write_file_internal(
                &effective_workspace,
                effective_path.clone(),
                content.clone(),
                create_dirs,
                Some(false),
            )
            .await
            .map_err(|error| command_error(error.to_string()))?;

            let change = PendingFileChange {
                display_path: path.clone(),
                effective_workspace,
                effective_path,
                absolute_path,
                status: if write_result.created {
                    "created".to_string()
                } else {
                    "updated".to_string()
                },
                new_content: Some(content.clone()),
                created: write_result.created,
                bytes_written: write_result.bytes_written,
                additions: content.lines().count(),
                deletions: 0,
            };

            build_post_write_response(
                &[change],
                serde_json::Map::from_iter([
                    ("path".to_string(), Value::String(write_result.path)),
                    (
                        "bytes_written".to_string(),
                        Value::Number(serde_json::Number::from(write_result.bytes_written)),
                    ),
                    ("created".to_string(), Value::Bool(write_result.created)),
                ]),
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

            if current.is_binary {
                return Ok(format!("Cannot edit binary file: {}", path));
            }

            let occurrences = current.content.matches(&old_text).count();
            if occurrences == 0 {
                return Ok(format!("No match found for old_text in {}.", path));
            }

            let updated = if replace_all {
                current.content.replace(&old_text, &new_text)
            } else {
                current.content.replacen(&old_text, &new_text, 1)
            };

            let absolute_path =
                resolve_validated_tool_path(&effective_workspace, effective_path.as_str(), true)?;

            let write_result = fs::write_file_internal(
                &effective_workspace,
                effective_path.clone(),
                updated.clone(),
                Some(true),
                Some(false),
            )
            .await
            .map_err(|error| command_error(error.to_string()))?;

            let (additions, deletions) = compute_line_change_stats(&current.content, &updated);
            let change = PendingFileChange {
                display_path: path.clone(),
                effective_workspace,
                effective_path,
                absolute_path,
                status: if write_result.created {
                    "created".to_string()
                } else {
                    "updated".to_string()
                },
                new_content: Some(updated),
                created: write_result.created,
                bytes_written: write_result.bytes_written,
                additions,
                deletions,
            };

            build_post_write_response(
                &[change],
                serde_json::Map::from_iter([
                    (
                        "replacements".to_string(),
                        Value::Number(serde_json::Number::from(if replace_all {
                            occurrences as u64
                        } else {
                            1
                        })),
                    ),
                    ("path".to_string(), Value::String(write_result.path)),
                    (
                        "bytes_written".to_string(),
                        Value::Number(serde_json::Number::from(write_result.bytes_written)),
                    ),
                    ("created".to_string(), Value::Bool(write_result.created)),
                ]),
            )
            .await
        }
        "apply_patch" => {
            let patch_text = json_arg_string(&args, "patch_text").ok_or_else(|| {
                command_error("Missing patch_text argument for apply_patch tool.")
            })?;
            let operations = parse_apply_patch(&patch_text)?;

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
                        if tokio::fs::try_exists(&absolute_path)
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
                        });
                    }
                    ParsedPatchOperation::Update { path, hunks } => {
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
                        });
                    }
                    ParsedPatchOperation::Delete { path } => {
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
                        });
                    }
                }
            }

            for change in pending_changes.iter() {
                if let Some(new_content) = change.new_content.as_ref() {
                    fs::write_file_internal(
                        &change.effective_workspace,
                        change.effective_path.clone(),
                        new_content.clone(),
                        Some(true),
                        Some(false),
                    )
                    .await
                    .map_err(|error| command_error(error.to_string()))?;
                } else {
                    tokio::fs::remove_file(&change.absolute_path)
                        .await
                        .map_err(|error| {
                            command_error(format!(
                                "Failed to delete {}: {}",
                                change.display_path, error
                            ))
                        })?;
                }
            }

            build_post_write_response(
                &pending_changes,
                serde_json::Map::from_iter([(
                    "applied_operations".to_string(),
                    Value::Number(serde_json::Number::from(pending_changes.len() as u64)),
                )]),
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

            let paths: Vec<String> = entries
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

            serde_json::to_string_pretty(&serde_json::json!({
                "pattern": pattern,
                "count": paths.len(),
                "paths": paths
            }))
            .map_err(|error| command_error(error.to_string()))
        }
        "grep" => {
            let query = json_arg_string(&args, "query")
                .ok_or_else(|| command_error("Missing query argument for grep tool."))?;
            let include_hidden = json_arg_bool(&args, "include_hidden").unwrap_or(false);
            let is_regexp = json_arg_bool(&args, "is_regexp").unwrap_or(false);
            let include_pattern = json_arg_string(&args, "include_pattern");
            let max_results = json_arg_u32(&args, "max_results").unwrap_or(50).max(1) as usize;
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
            let mut results = Vec::new();

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

                let read_path = relative_path.clone();

                let content =
                    fs::read_file_internal(&effective_workspace, read_path, Some(false))
                        .await
                        .map_err(|error| command_error(error.to_string()))?;

                if content.is_binary {
                    continue;
                }

                for (index, line) in content.content.lines().enumerate() {
                    let is_match = if let Some(compiled) = regex.as_ref() {
                        compiled.is_match(line)
                    } else {
                        line.to_lowercase().contains(&query_lower)
                    };

                    if is_match {
                        results.push(serde_json::json!({
                            "path": virtual_path,
                            "line": index + 1,
                            "text": line.trim()
                        }));

                        if results.len() >= max_results {
                            break;
                        }
                    }
                }

                if results.len() >= max_results {
                    break;
                }
            }

            serde_json::to_string_pretty(&serde_json::json!({
                "query": query,
                "total": results.len(),
                "results": results
            }))
            .map_err(|error| command_error(error.to_string()))
        }
        "git_status" => {
            let repo_path = json_arg_string(&args, "repo_path").unwrap_or_else(|| ".".to_string());
            let repo_path_for_task = repo_path.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();

            let status = tokio::task::spawn_blocking(move || {
                let validated = git::validate_repo_path(&repo_path_for_task, &workspace_for_task)
                    .map_err(|error| command_error(error.to_string()))?;
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

            serde_json::to_string_pretty(&serde_json::json!({
                "repo_path": repo_path,
                "branch": status.branch,
                "head_commit": status.head_commit,
                "staged_files": status.staged_files,
                "unstaged_files": status.unstaged_files,
                "untracked_files": status.untracked_files,
                "is_clean": status.is_clean
            }))
            .map_err(|error| command_error(error.to_string()))
        }
        "git_log" => {
            let repo_path = json_arg_string(&args, "repo_path").unwrap_or_else(|| ".".to_string());
            let limit = json_arg_u32(&args, "limit").unwrap_or(50).max(1) as usize;
            let branch = json_arg_string(&args, "branch");
            let repo_path_for_task = repo_path.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();

            let commits = tokio::task::spawn_blocking(move || {
                let validated = git::validate_repo_path(&repo_path_for_task, &workspace_for_task)
                    .map_err(|error| command_error(error.to_string()))?;
                let repo = git_state_for_task
                    .open_repo(&validated)
                    .map_err(|error| command_error(error.to_string()))?;
                let repo = repo
                    .lock()
                    .map_err(|_| command_error("Failed to lock repository"))?;

                git::build_git_log(&repo, limit, branch.as_deref())
                    .map_err(|error| command_error(error.to_string()))
            })
            .await
            .map_err(|error| command_error(git::to_join_error(error).to_string()))??;

            serde_json::to_string_pretty(&serde_json::json!({
                "repo_path": repo_path,
                "count": commits.len(),
                "commits": commits
            }))
            .map_err(|error| command_error(error.to_string()))
        }
        "git_branch_list" => {
            let repo_path = json_arg_string(&args, "repo_path").unwrap_or_else(|| ".".to_string());
            let repo_path_for_task = repo_path.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();

            let branches = tokio::task::spawn_blocking(move || {
                let validated = git::validate_repo_path(&repo_path_for_task, &workspace_for_task)
                    .map_err(|error| command_error(error.to_string()))?;
                let repo = git_state_for_task
                    .open_repo(&validated)
                    .map_err(|error| command_error(error.to_string()))?;
                let repo = repo
                    .lock()
                    .map_err(|_| command_error("Failed to lock repository"))?;

                git::build_git_branches(&repo).map_err(|error| command_error(error.to_string()))
            })
            .await
            .map_err(|error| command_error(git::to_join_error(error).to_string()))??;

            serde_json::to_string_pretty(&serde_json::json!({
                "repo_path": repo_path,
                "local": branches.local,
                "remote": branches.remote,
                "current": branches.current
            }))
            .map_err(|error| command_error(error.to_string()))
        }
        "git_diff" => {
            let repo_path = json_arg_string(&args, "repo_path").unwrap_or_else(|| ".".to_string());
            let base = json_arg_string(&args, "base");
            let head = json_arg_string(&args, "head");
            let context_lines = json_arg_u32(&args, "context_lines");
            let ignore_whitespace = json_arg_bool(&args, "ignore_whitespace").unwrap_or(false);
            let paths = json_arg_string_array(&args, "paths");
            let repo_path_for_task = repo_path.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();

            let patch = tokio::task::spawn_blocking(move || {
                let validated = git::validate_repo_path(&repo_path_for_task, &workspace_for_task)
                    .map_err(|error| command_error(error.to_string()))?;
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
                    },
                )
                .map_err(|error| command_error(error.to_string()))
            })
            .await
            .map_err(|error| command_error(git::to_join_error(error).to_string()))??;

            Ok(patch)
        }
        "git_read_file_pair" => {
            let repo_path = json_arg_string(&args, "repo_path").unwrap_or_else(|| ".".to_string());
            let path = json_arg_string(&args, "path").unwrap_or_default();
            let repo_path_for_task = repo_path.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();

            let pair = tokio::task::spawn_blocking(move || {
                let validated = git::validate_repo_path(&repo_path_for_task, &workspace_for_task)
                    .map_err(|error| command_error(error.to_string()))?;
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
            let repo_path_for_task = repo_path.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();

            let tree = tokio::task::spawn_blocking(move || {
                let validated = git::validate_repo_path(&repo_path_for_task, &workspace_for_task)
                    .map_err(|error| command_error(error.to_string()))?;
                let repo = git_state_for_task
                    .open_repo(&validated)
                    .map_err(|error| command_error(error.to_string()))?;
                let repo = repo
                    .lock()
                    .map_err(|_| command_error("Failed to lock repository"))?;

                git::build_git_tree(&repo, branch.as_deref())
                    .map_err(|error| command_error(error.to_string()))
            })
            .await
            .map_err(|error| command_error(git::to_join_error(error).to_string()))??;

            serde_json::to_string_pretty(&serde_json::json!({
                "repo_path": repo_path,
                "branch": tree.branch,
                "structure": tree.structure,
                "modified_files_count": tree.modified_files_count
            }))
            .map_err(|error| command_error(error.to_string()))
        }
        "git_add" => {
            let repo_path = json_arg_string(&args, "repo_path").unwrap_or_else(|| ".".to_string());
            let paths = json_arg_string_array(&args, "paths")
                .filter(|items| !items.is_empty())
                .unwrap_or_else(|| vec![".".to_string()]);
            let paths_for_task = paths.clone();
            let repo_path_for_task = repo_path.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();

            let status = tokio::task::spawn_blocking(move || {
                let validated = git::validate_repo_path(&repo_path_for_task, &workspace_for_task)
                    .map_err(|error| command_error(error.to_string()))?;
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
            let repo_path_for_task = repo_path.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();

            let result = tokio::task::spawn_blocking(move || {
                let validated = git::validate_repo_path(&repo_path_for_task, &workspace_for_task)
                    .map_err(|error| command_error(error.to_string()))?;
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
            let repo_path_for_task = repo_path.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();

            let status = tokio::task::spawn_blocking(move || {
                let validated = git::validate_repo_path(&repo_path_for_task, &workspace_for_task)
                    .map_err(|error| command_error(error.to_string()))?;
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
            let repo_path_for_task = repo_path.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();

            let status = tokio::task::spawn_blocking(move || {
                let validated = git::validate_repo_path(&repo_path_for_task, &workspace_for_task)
                    .map_err(|error| command_error(error.to_string()))?;
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
        "git_stash" => {
            let repo_path = json_arg_string(&args, "repo_path").unwrap_or_else(|| ".".to_string());
            let message = json_arg_string(&args, "message");
            let repo_path_for_task = repo_path.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();

            let result = tokio::task::spawn_blocking(move || {
                let validated = git::validate_repo_path(&repo_path_for_task, &workspace_for_task)
                    .map_err(|error| command_error(error.to_string()))?;
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

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn tool_execute_workspace(
    workspace_root: State<'_, WorkspaceRoot>,
    workspace_metadata_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    mode: String,
    tool_id: String,
    args: Value,
    workspace_path: Option<String>,
    workspace_scope: Option<String>,
) -> CommandResult<String> {
    let workspace = workspace_root.inner().read().await.clone();
    let metadata_workspace = workspace_metadata_root.inner().0.read().await.clone();
    let git_state = git_state.inner().clone();
    execute_workspace_tool(
        workspace,
        metadata_workspace,
        git_state,
        mode,
        tool_id,
        args,
        workspace_path,
        workspace_scope,
    )
    .await
}

// ============ CONVERSATIONS ============

#[tauri::command]
pub async fn db_list_conversations(pool: State<'_, DbPool>) -> CommandResult<Vec<Conversation>> {
    let pool = get_pool(&pool).await?;

    repository::list_conversations(&pool)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_get_chat_snapshot(pool: State<'_, DbPool>) -> CommandResult<ChatSnapshot> {
    let pool = get_pool(&pool).await?;

    repository::get_chat_snapshot(&pool)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_get_conversation(
    pool: State<'_, DbPool>,
    id: String,
) -> CommandResult<Option<Conversation>> {
    let pool = get_pool(&pool).await?;

    repository::get_conversation(&pool, &id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_create_conversation(
    pool: State<'_, DbPool>,
    title: Option<String>,
    scope_mode: String,
    task_id: Option<String>,
    group_id: Option<String>,
    project_id: Option<String>,
) -> CommandResult<Conversation> {
    let pool = get_pool(&pool).await?;

    repository::create_conversation(
        &pool,
        CreateConversationInput {
            title,
            scope_mode,
            task_id,
            group_id,
            project_id,
        },
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn db_rename_conversation(
    pool: State<'_, DbPool>,
    id: String,
    title: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::rename_conversation(&pool, &id, &title)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_update_conversation_details(
    pool: State<'_, DbPool>,
    id: String,
    title: Option<String>,
    description: Option<String>,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::update_conversation_details(&pool, &id, title.as_deref(), description.as_deref())
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_delete_conversation_by_id(
    pool: State<'_, DbPool>,
    id: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::delete_conversation(&pool, &id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_delete_conversations_by_ids(
    pool: State<'_, DbPool>,
    ids: Vec<String>,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::delete_conversations(&pool, &ids)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_toggle_pin_conversation(
    pool: State<'_, DbPool>,
    id: String,
) -> CommandResult<bool> {
    let pool = get_pool(&pool).await?;

    repository::toggle_pin_conversation(&pool, &id)
        .await
        .map_err(Into::into)
}

// ============ MESSAGES ============

#[tauri::command]
pub async fn db_list_messages(
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> CommandResult<Vec<Message>> {
    let pool = get_pool(&pool).await?;

    repository::list_messages(&pool, &conversation_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_create_message(
    pool: State<'_, DbPool>,
    conversation_id: String,
    role: String,
    content: String,
    token_count: Option<i32>,
    tool_traces_json: Option<String>,
    hidden_context: Option<String>,
    provider_input_items_json: Option<String>,
    provider_turn_state_json: Option<String>,
) -> CommandResult<Message> {
    let pool = get_pool(&pool).await?;

    repository::create_message(
        &pool,
        CreateMessageInput {
            conversation_id,
            role,
            content,
            token_count,
            tool_traces_json,
            hidden_context,
            provider_input_items_json,
            provider_turn_state_json,
        },
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn db_import_messages(
    pool: State<'_, DbPool>,
    conversation_id: String,
    messages: Vec<ImportMessageInput>,
) -> CommandResult<Vec<Message>> {
    let pool = get_pool(&pool).await?;

    repository::import_messages(&pool, &conversation_id, messages)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_update_message(
    pool: State<'_, DbPool>,
    id: String,
    content: String,
    token_count: Option<i32>,
    tool_traces_json: Option<String>,
    hidden_context: Option<String>,
    provider_input_items_json: Option<String>,
    provider_turn_state_json: Option<String>,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::update_message_content(
        &pool,
        &id,
        &content,
        token_count,
        tool_traces_json,
        hidden_context,
        provider_input_items_json,
        provider_turn_state_json,
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn db_delete_messages_after(
    pool: State<'_, DbPool>,
    conversation_id: String,
    after_message_id: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::delete_messages_after(&pool, &conversation_id, &after_message_id)
        .await
        .map_err(CommandError::from)
}

// ============ PROVIDER CONFIGS ============

#[tauri::command]
pub async fn db_list_provider_configs(
    pool: State<'_, DbPool>,
    workspace_metadata_root: State<'_, WorkspaceMetadataRoot>,
) -> CommandResult<Vec<ProviderConfig>> {
    let pool = get_pool(&pool).await?;
    if tauri::is_dev() {
        let workspace_root = workspace_metadata_root.0.read().await.clone();
        crate::dev_overrides::sync_declared_dev_providers_from_workspace(&pool, &workspace_root)
            .await
            .map_err(CommandError::from)?;
    }

    repository::list_provider_configs(&pool)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_get_provider_config(
    pool: State<'_, DbPool>,
    id: String,
) -> CommandResult<Option<ProviderConfig>> {
    let pool = get_pool(&pool).await?;

    repository::get_provider_config(&pool, &id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_reveal_provider_api_key(
    pool: State<'_, DbPool>,
    id: String,
) -> CommandResult<Option<String>> {
    let pool = get_pool(&pool).await?;
    let config = repository::get_provider_config(&pool, &id)
        .await
        .map_err(CommandError::from)?;

    if config.is_none() {
        return Err(CommandError {
            message: format!("Provider {} not found", id),
        });
    }

    let api_key = secrets::get_api_key(&id).map_err(|error| CommandError {
        message: format!("Failed to access the keychain for {}: {}", id, error),
    })?;

    repository::set_provider_has_stored_api_key(&pool, &id, api_key.is_some())
        .await
        .map_err(CommandError::from)?;

    Ok(api_key)
}

#[tauri::command]
pub async fn db_update_provider_config(
    pool: State<'_, DbPool>,
    id: String,
    name: Option<String>,
    provider_type: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    is_local: Option<bool>,
    is_enabled: Option<bool>,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    let provider_id = id.clone();
    let api_key_for_store = api_key.clone();

    repository::update_provider_config(
        &pool,
        UpdateProviderConfigInput {
            id,
            name,
            provider_type,
            base_url,
            api_key,
            is_local,
            is_enabled,
        },
    )
    .await
    .map_err(CommandError::from)?;

    if let Some(key) = api_key_for_store {
        if key.trim().is_empty() {
            secrets::delete_api_key(&provider_id).ok();
            repository::set_provider_has_stored_api_key(&pool, &provider_id, false)
                .await
                .map_err(CommandError::from)?;
        } else {
            secrets::set_api_key(&provider_id, &key).map_err(|e| CommandError {
                message: e.to_string(),
            })?;
            repository::set_provider_has_stored_api_key(&pool, &provider_id, true)
                .await
                .map_err(CommandError::from)?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn db_create_provider_config(
    pool: State<'_, DbPool>,
    name: String,
    provider_type: String,
    base_url: String,
    api_key: Option<String>,
    is_local: bool,
) -> CommandResult<ProviderConfig> {
    let pool = get_pool(&pool).await?;

    let created = repository::create_provider_config(
        &pool,
        &name,
        &provider_type,
        &base_url,
        api_key.as_deref(),
        is_local,
    )
    .await
    .map_err(CommandError::from)?;

    if let Some(key) = api_key {
        if !key.trim().is_empty() {
            secrets::set_api_key(&created.id, &key).map_err(|e| CommandError {
                message: e.to_string(),
            })?;
        }
    }

    Ok(created)
}

#[tauri::command]
pub async fn db_delete_provider_config(pool: State<'_, DbPool>, id: String) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    secrets::delete_api_key(&id).ok();
    repository::delete_provider_config(&pool, &id)
        .await
        .map_err(Into::into)
}

// ============ AI MODELS ============

#[tauri::command]
pub async fn db_list_provider_models(
    pool: State<'_, DbPool>,
    provider_id: String,
) -> CommandResult<Vec<AiModel>> {
    let pool = get_pool(&pool).await?;

    repository::list_models_by_provider(&pool, &provider_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_upsert_provider_models(
    pool: State<'_, DbPool>,
    provider_id: String,
    models: Vec<ProviderModelInput>,
) -> CommandResult<Vec<AiModel>> {
    let pool = get_pool(&pool).await?;

    repository::upsert_provider_models(&pool, &provider_id, &models)
        .await
        .map_err(CommandError::from)?;

    repository::list_models_by_provider(&pool, &provider_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_get_conversation_compaction_state(
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> CommandResult<Option<ConversationCompactionStateRecord>> {
    let pool = get_pool(&pool).await?;

    repository::get_conversation_compaction_state(&pool, &conversation_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_upsert_conversation_compaction_state(
    pool: State<'_, DbPool>,
    input: UpsertConversationCompactionStateInput,
) -> CommandResult<ConversationCompactionStateRecord> {
    let pool = get_pool(&pool).await?;

    repository::upsert_conversation_compaction_state(&pool, input)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_delete_conversation_compaction_state(
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::delete_conversation_compaction_state(&pool, &conversation_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_register_manual_model(
    pool: State<'_, DbPool>,
    provider_id: String,
    model_id: String,
    name: String,
) -> CommandResult<Vec<AiModel>> {
    let pool = get_pool(&pool).await?;

    repository::register_manual_model(&pool, &provider_id, &model_id, &name)
        .await
        .map_err(CommandError::from)?;

    repository::list_models_by_provider(&pool, &provider_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_update_manual_model(
    pool: State<'_, DbPool>,
    provider_id: String,
    current_model_id: String,
    next_model_id: String,
    name: String,
) -> CommandResult<Vec<AiModel>> {
    let pool = get_pool(&pool).await?;

    repository::update_manual_model(
        &pool,
        &provider_id,
        &current_model_id,
        &next_model_id,
        &name,
    )
    .await
    .map_err(CommandError::from)?;

    repository::list_models_by_provider(&pool, &provider_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_delete_manual_model(
    pool: State<'_, DbPool>,
    provider_id: String,
    model_id: String,
) -> CommandResult<Vec<AiModel>> {
    let pool = get_pool(&pool).await?;

    repository::delete_manual_model(&pool, &provider_id, &model_id)
        .await
        .map_err(CommandError::from)?;

    repository::list_models_by_provider(&pool, &provider_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_set_provider_model_enabled(
    pool: State<'_, DbPool>,
    provider_id: String,
    model_id: String,
    enabled: bool,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::set_model_enabled(&pool, &provider_id, &model_id, enabled)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_set_all_provider_models_enabled(
    pool: State<'_, DbPool>,
    provider_id: String,
    enabled: bool,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::set_all_models_enabled(&pool, &provider_id, enabled)
        .await
        .map_err(Into::into)
}

// ============ PROVIDER SETTINGS ============

#[tauri::command]
pub async fn db_get_provider_settings(
    pool: State<'_, DbPool>,
    provider_id: String,
) -> CommandResult<ProviderSettings> {
    let pool = get_pool(&pool).await?;

    repository::get_provider_settings(&pool, &provider_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_update_provider_settings(
    pool: State<'_, DbPool>,
    provider_id: String,
    filter_free_models: bool,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::update_provider_settings(&pool, &provider_id, filter_free_models)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_get_setting(pool: State<'_, DbPool>, key: String) -> CommandResult<Option<String>> {
    let pool = get_pool(&pool).await?;

    let result = sqlx::query_scalar::<_, String>(
        r#"
        SELECT value
        FROM settings
        WHERE key = ?
        "#,
    )
    .bind(&key)
    .fetch_optional(&pool)
    .await
    .map_err(|error| command_error(error.to_string()))?;

    Ok(result)
}

#[tauri::command]
pub async fn db_set_setting(
    pool: State<'_, DbPool>,
    key: String,
    value: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    sqlx::query(
        r#"
        INSERT INTO settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        "#,
    )
    .bind(&key)
    .bind(&value)
    .execute(&pool)
    .await
    .map_err(|error| command_error(error.to_string()))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        apply_patch_hunks_to_content, parse_apply_patch, resolve_requested_workspace,
        resolve_workspace_for_tool_path, ParsedPatchOperation,
    };
    use crate::git::GitState;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn resolve_requested_workspace_uses_metadata_root_for_relative_paths() {
        let default_workspace = TempDir::new().expect("default workspace");
        let metadata_workspace = TempDir::new().expect("metadata workspace");
        let project_dir = metadata_workspace
            .path()
            .join("projects")
            .join("smartcards");
        fs::create_dir_all(&project_dir).expect("create project dir");

        let resolved = resolve_requested_workspace(
            default_workspace.path(),
            metadata_workspace.path(),
            Some("projects/smartcards"),
        )
        .expect("resolve requested workspace");

        assert_eq!(
            resolved,
            project_dir.canonicalize().expect("canonical project dir")
        );
    }

    #[tokio::test]
    async fn resolve_workspace_for_tool_path_falls_back_to_dot_macro_when_workspace_is_not_git() {
        let workspace = TempDir::new().expect("workspace");

        let resolved = resolve_workspace_for_tool_path(
            workspace.path(),
            &GitState::new(),
            None,
            Some("metadata"),
        )
        .await
        .expect("resolve metadata workspace");

        assert_eq!(resolved, workspace.path().join(".macro"));
    }

    #[test]
    fn parse_apply_patch_supports_add_update_delete_sections() {
        let parsed = parse_apply_patch(
            [
                "*** Begin Patch",
                "*** Update File: src/app.ts",
                "@@",
                "-before",
                "+after",
                "*** Add File: notes.md",
                "+hello",
                "*** Delete File: old.md",
                "*** End Patch",
            ]
            .join("\n")
            .as_str(),
        )
        .expect("parse apply_patch");

        assert_eq!(parsed.len(), 3);
        match &parsed[0] {
            ParsedPatchOperation::Update { path, hunks } => {
                assert_eq!(path, "src/app.ts");
                assert_eq!(hunks.len(), 1);
            }
            _ => panic!("expected update operation"),
        }
        match &parsed[1] {
            ParsedPatchOperation::Add { path, lines } => {
                assert_eq!(path, "notes.md");
                assert_eq!(lines, &vec!["hello".to_string()]);
            }
            _ => panic!("expected add operation"),
        }
        match &parsed[2] {
            ParsedPatchOperation::Delete { path } => {
                assert_eq!(path, "old.md");
            }
            _ => panic!("expected delete operation"),
        }
    }

    #[test]
    fn apply_patch_hunks_to_content_updates_expected_lines() {
        let parsed = parse_apply_patch(
            [
                "*** Begin Patch",
                "*** Update File: src/app.ts",
                "@@",
                " export const value = 1;",
                "-console.log(value);",
                "+console.info(value);",
                "*** End Patch",
            ]
            .join("\n")
            .as_str(),
        )
        .expect("parse apply_patch");

        let ParsedPatchOperation::Update { path, hunks } = &parsed[0] else {
            panic!("expected update operation");
        };

        let updated = apply_patch_hunks_to_content(
            path,
            "export const value = 1;\nconsole.log(value);\n",
            hunks,
        )
        .expect("apply patch");

        assert_eq!(updated, "export const value = 1;\nconsole.info(value);\n");
    }
}

// ============ APP STATE SETTINGS ============

#[tauri::command]
pub async fn db_get_app_setting(
    pool: State<'_, DbPool>,
    key: String,
) -> CommandResult<Option<AppSettingRecord>> {
    let pool = get_pool(&pool).await?;

    repository::get_app_setting(&pool, &key)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_set_app_setting(
    pool: State<'_, DbPool>,
    key: String,
    value_json: String,
) -> CommandResult<AppSettingRecord> {
    let pool = get_pool(&pool).await?;

    repository::set_app_setting(&pool, &key, &value_json)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_get_project_context_state(
    pool: State<'_, DbPool>,
    project_id: String,
) -> CommandResult<Option<ProjectContextStateRecord>> {
    let pool = get_pool(&pool).await?;

    repository::get_project_context_state(&pool, &project_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_upsert_project_context_state(
    pool: State<'_, DbPool>,
    input: UpsertProjectContextStateInput,
) -> CommandResult<ProjectContextStateRecord> {
    let pool = get_pool(&pool).await?;

    repository::upsert_project_context_state(&pool, input)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_delete_project_context_state(
    pool: State<'_, DbPool>,
    project_id: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::delete_project_context_state(&pool, &project_id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_get_session_context_state(
    pool: State<'_, DbPool>,
) -> CommandResult<Option<SessionContextStateRecord>> {
    let pool = get_pool(&pool).await?;

    repository::get_session_context_state(&pool)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_upsert_session_context_state(
    pool: State<'_, DbPool>,
    input: UpsertSessionContextStateInput,
) -> CommandResult<SessionContextStateRecord> {
    let pool = get_pool(&pool).await?;

    repository::upsert_session_context_state(&pool, input)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_reconcile_project_registry(
    pool: State<'_, DbPool>,
    input: ReconcileProjectRegistryInput,
) -> CommandResult<ProjectRegistryDbRepairReport> {
    let pool = get_pool(&pool).await?;

    repository::reconcile_project_registry(&pool, input)
        .await
        .map_err(Into::into)
}

// ============ GIT METADATA ============

#[tauri::command]
pub async fn db_upsert_git_repository(
    pool: State<'_, DbPool>,
    input: CreateGitRepositoryInput,
) -> CommandResult<GitRepositoryRecord> {
    let pool = get_pool(&pool).await?;

    repository::upsert_git_repository(&pool, input)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_upsert_git_worktree(
    pool: State<'_, DbPool>,
    input: CreateGitWorktreeInput,
) -> CommandResult<GitWorktreeRecord> {
    let pool = get_pool(&pool).await?;

    repository::upsert_git_worktree(&pool, input)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn db_list_git_worktrees(
    pool: State<'_, DbPool>,
    project_id: String,
) -> CommandResult<Vec<GitWorktreeRecord>> {
    let pool = get_pool(&pool).await?;

    repository::list_git_worktrees_by_project(&pool, &project_id)
        .await
        .map_err(Into::into)
}
