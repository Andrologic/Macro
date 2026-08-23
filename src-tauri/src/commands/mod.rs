pub mod ai;
mod ast_search;
mod external_apps;
pub mod fs;
pub mod git;
pub mod mcp;
pub mod skills;
pub mod speech;
pub mod terminal;
mod tool_output;
pub mod web_search;
pub mod workspace;
pub mod workspace_tools;

#[doc(hidden)]
pub use external_apps::{__cmd__list_external_apps, __cmd__open_external_target};
pub use external_apps::{
    list_external_apps, open_external_target, ExternalAppCatalogDto, ExternalAppOptionDto,
};
pub use workspace_tools::WorkspaceProjectMount;

use crate::config::{
    ConfigChangeSource, ConfigDocumentKind, ConfigManager, ConfigPatchRequest, ConfigScope,
    JsonPatchOperation,
};
use crate::core::tool_policy::{
    get_mode_policy, is_macro_scoped_path, validate_tool_execution, ToolModePolicyResult,
    ToolValidationResult,
};
use crate::db::{models::*, repository, DbError};
use crate::dev_overrides::DevProviderOverridesFile;
use crate::fs::{
    normalize_path, validate_path as validate_fs_path,
    validate_path_for_write as validate_fs_path_for_write,
};
use crate::git::GitState;
use crate::project_path::{join_wsl_path, parse_wsl_unc_path, WslProjectPath};
use crate::secrets;
use crate::{WorkspaceMetadataRoot, WorkspaceRoot};
use glob::Pattern;
use regex::RegexBuilder;
use serde::{ser::SerializeStruct, Deserialize, Serialize, Serializer};
use serde_json::Value;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::Instant;
use tauri::State;
use tokio::sync::{watch, Notify};
use tokio::time::{timeout, Duration};

const DB_INIT_WAIT_TIMEOUT: Duration = Duration::from_secs(15);
static PROVIDER_MUTATION_LOCKS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static CONTENT_MUTATION_LOCKS: LazyLock<Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
#[derive(Default)]
struct ToolExecutionCancellationRegistry {
    active: HashMap<String, Arc<ToolCancellation>>,
    pending: HashMap<String, Instant>,
}

static TOOL_EXECUTION_CANCELLATION_REGISTRY: LazyLock<Mutex<ToolExecutionCancellationRegistry>> =
    LazyLock::new(|| Mutex::new(ToolExecutionCancellationRegistry::default()));
const PENDING_TOOL_CANCELLATION_TTL: Duration = Duration::from_secs(60);
const PENDING_TOOL_CANCELLATION_LIMIT: usize = 1_024;

pub(super) struct ToolCancellation {
    cancelled: AtomicBool,
    notify: Notify,
}

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

fn provider_mutation_lock(provider_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    PROVIDER_MUTATION_LOCKS
        .lock()
        .expect("provider mutation lock registry")
        .entry(provider_id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

fn content_mutation_lock(key: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = CONTENT_MUTATION_LOCKS
        .lock()
        .expect("content mutation lock registry");
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(key).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(key.to_string(), Arc::downgrade(&lock));
    lock
}

#[derive(Clone, Debug)]
pub enum DbInitializationState {
    Initializing,
    Ready(SqlitePool),
    Failed(String),
}

#[derive(Clone, Debug)]
pub struct DbPool {
    state: watch::Sender<DbInitializationState>,
}

impl Default for DbPool {
    fn default() -> Self {
        let (state, _) = watch::channel(DbInitializationState::Initializing);
        Self { state }
    }
}

impl DbPool {
    pub fn set_initializing(&self) {
        self.state.send_replace(DbInitializationState::Initializing);
    }

    pub fn set_ready(&self, pool: SqlitePool) {
        self.state.send_replace(DbInitializationState::Ready(pool));
    }

    pub fn set_failed(&self, message: impl Into<String>) {
        self.state
            .send_replace(DbInitializationState::Failed(message.into()));
    }

    pub fn current(&self) -> DbInitializationState {
        self.state.borrow().clone()
    }

    pub fn ready_pool(&self) -> Option<SqlitePool> {
        match self.current() {
            DbInitializationState::Ready(pool) => Some(pool),
            DbInitializationState::Initializing | DbInitializationState::Failed(_) => None,
        }
    }

    async fn wait_until_ready(&self) -> CommandResult<SqlitePool> {
        let mut receiver = self.state.subscribe();
        let wait = async {
            loop {
                match receiver.borrow().clone() {
                    DbInitializationState::Ready(pool) => return Ok(pool),
                    DbInitializationState::Failed(message) => {
                        return Err(command_error(format!(
                            "Database initialization failed: {message}"
                        )))
                    }
                    DbInitializationState::Initializing => {}
                }

                receiver.changed().await.map_err(|_| {
                    command_error("Database initialization state channel closed unexpectedly.")
                })?;
            }
        };

        timeout(DB_INIT_WAIT_TIMEOUT, wait).await.map_err(|_| {
            command_error("Database is still initializing. Please retry in a moment.")
        })?
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbInitializationStatusDto {
    pub status: String,
    pub message: Option<String>,
}

#[derive(Debug)]
pub struct CommandError {
    pub message: String,
}

impl CommandError {
    pub fn code(&self) -> Option<&'static str> {
        if self.message.contains("Revision conflict:") {
            return Some("REVISION_CONFLICT");
        }
        if self.message.starts_with("Tool execution cancelled:") {
            return Some("TOOL_EXECUTION_CANCELLED");
        }
        if self.message.starts_with("Tool execution timed out") {
            return Some("TOOL_EXECUTION_TIMEOUT");
        }
        None
    }
}

impl Serialize for CommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let code = self.code();
        let mut state =
            serializer.serialize_struct("CommandError", 1 + usize::from(code.is_some()))?;
        if let Some(code) = code {
            state.serialize_field("code", code)?;
        }
        state.serialize_field("message", &self.message)?;
        state.end()
    }
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
    pool.wait_until_ready().await
}

#[tauri::command]
pub async fn db_get_initialization_status(
    pool: State<'_, DbPool>,
) -> CommandResult<DbInitializationStatusDto> {
    let (status, message) = match pool.current() {
        DbInitializationState::Initializing => ("initializing", None),
        DbInitializationState::Ready(_) => ("ready", None),
        DbInitializationState::Failed(message) => ("failed", Some(message)),
    };
    Ok(DbInitializationStatusDto {
        status: status.to_string(),
        message,
    })
}

#[tauri::command]
pub async fn db_retry_initialize(
    app: tauri::AppHandle,
    pool: State<'_, DbPool>,
) -> CommandResult<DbInitializationStatusDto> {
    if matches!(pool.current(), DbInitializationState::Ready(_)) {
        return db_get_initialization_status(pool).await;
    }

    pool.set_initializing();
    match crate::db::init_db(&app).await {
        Ok(sqlite_pool) => pool.set_ready(sqlite_pool),
        Err(error) => {
            let message = error.to_string();
            pool.set_failed(message.clone());
            return Err(command_error(format!(
                "Database initialization failed: {message}"
            )));
        }
    }

    Ok(DbInitializationStatusDto {
        status: "ready".to_string(),
        message: None,
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
    fs::ensure_wsl_path_within_workspace(&wsl_workspace, &resolved, Some(false))
        .await
        .map_err(|error| command_error(error.to_string()))?;
    Ok(Some(resolved))
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

async fn write_bytes_atomically(path: &Path, bytes: &[u8]) -> CommandResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| command_error(format!("Invalid file path: {}", path.display())))?;
    tokio::fs::create_dir_all(parent).await.map_err(|error| {
        command_error(format!(
            "Failed to create parent directory for {}: {}",
            path.display(),
            error
        ))
    })?;

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

async fn write_file_atomically(path: &Path, content: &str) -> CommandResult<()> {
    write_bytes_atomically(path, content.as_bytes()).await
}

async fn rollback_pending_file_changes(
    backups: &[(PathBuf, Option<Vec<u8>>)],
    applied_changes: &[PendingFileChange],
) -> Vec<String> {
    debug_assert_eq!(backups.len(), applied_changes.len());
    let mut errors = Vec::new();
    for ((path, backup), change) in backups.iter().zip(applied_changes).rev() {
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
                if let Err(error) = write_bytes_atomically(path, bytes).await {
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

fn wsl_content_mutation_key(target: &WslProjectPath) -> String {
    format!(
        "wsl:{}:{}",
        target.distro.to_ascii_lowercase(),
        target.linux_path
    )
}

async fn native_content_mutation_key(path: &Path) -> String {
    let resolved_path = match tokio::fs::canonicalize(path).await {
        Ok(path) => path,
        Err(_) => {
            let parent = path.parent();
            match parent {
                Some(parent) => match tokio::fs::canonicalize(parent).await {
                    Ok(canonical_parent) => path
                        .file_name()
                        .map(|name| canonical_parent.join(name))
                        .unwrap_or_else(|| normalize_path(path)),
                    Err(_) => normalize_path(path),
                },
                None => normalize_path(path),
            }
        }
    };
    let key = resolved_path.to_string_lossy().replace('\\', "/");
    #[cfg(any(windows, target_os = "macos"))]
    let key = key.to_ascii_lowercase();
    format!("native:{key}")
}

async fn content_mutation_key(change: &PendingFileChange) -> CommandResult<String> {
    if let Some(target) =
        resolve_wsl_path_for_workspace(&change.effective_workspace, &change.effective_path)?
    {
        return Ok(wsl_content_mutation_key(&target));
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

async fn rollback_pending_file_changes_via_fs(
    backups: &[(PathBuf, String, String, Option<String>)],
    applied_changes: &[PendingFileChange],
) -> Vec<String> {
    debug_assert_eq!(backups.len(), applied_changes.len());
    let mut errors = Vec::new();
    for ((workspace, path, display_path, backup), change) in
        backups.iter().zip(applied_changes).rev()
    {
        let expected_applied_revision = change
            .new_content
            .as_ref()
            .map(|content| fs::content_revision(content.as_bytes()));
        match backup {
            Some(content) => {
                if let Err(error) = fs::write_file_internal_with_revision_unlocked(
                    workspace,
                    path.clone(),
                    content.clone(),
                    Some(true),
                    Some(false),
                    Some(
                        expected_applied_revision
                            .as_deref()
                            .unwrap_or(fs::EXPECTED_REVISION_ABSENT),
                    ),
                )
                .await
                {
                    errors.push(format!(
                        "Failed to restore {} during rollback: {}",
                        display_path, error
                    ));
                }
            }
            None => {
                if let Some(expected_revision) = expected_applied_revision.as_deref() {
                    if let Err(error) = fs::delete_path_internal_with_revision_unlocked(
                        workspace,
                        path.clone(),
                        Some(false),
                        Some(expected_revision),
                    )
                    .await
                    {
                        errors.push(format!(
                            "Failed to remove created file {} during rollback: {}",
                            display_path, error
                        ));
                    }
                }
            }
        }
    }
    errors
}

async fn commit_pending_file_changes_via_fs(changes: &[PendingFileChange]) -> CommandResult<()> {
    let mut backups = Vec::with_capacity(changes.len());
    for change in changes {
        let backup =
            if fs::exists_internal(&change.effective_workspace, change.effective_path.clone())
                .await
                .map_err(|error| {
                    command_error(format!(
                        "Failed to inspect {} before write: {}",
                        change.display_path, error
                    ))
                })?
            {
                let current = fs::read_file_internal(
                    &change.effective_workspace,
                    change.effective_path.clone(),
                    Some(false),
                )
                .await
                .map_err(|error| {
                    command_error(format!(
                        "Failed to prepare backup for {}: {}",
                        change.display_path, error
                    ))
                })?;
                if current.is_binary {
                    return Err(command_error(format!(
                        "Cannot apply a batched patch to binary file {} in WSL.",
                        change.display_path
                    )));
                }
                fs::validate_expected_revision(
                    &change.display_path,
                    change.expected_revision.as_deref(),
                    Some(&current.revision),
                )
                .map_err(|error| command_error(error.to_string()))?;
                Some(current.content)
            } else {
                fs::validate_expected_revision(
                    &change.display_path,
                    change.expected_revision.as_deref(),
                    None,
                )
                .map_err(|error| command_error(error.to_string()))?;
                None
            };
        backups.push((
            change.effective_workspace.clone(),
            change.effective_path.clone(),
            change.display_path.clone(),
            backup,
        ));
    }

    for (applied_count, change) in changes.iter().enumerate() {
        let result = if let Some(new_content) = change.new_content.as_ref() {
            fs::write_file_internal_with_revision_unlocked(
                &change.effective_workspace,
                change.effective_path.clone(),
                new_content.clone(),
                Some(true),
                Some(false),
                change.expected_revision.as_deref(),
            )
            .await
            .map(|_| ())
        } else {
            fs::delete_path_internal_with_revision_unlocked(
                &change.effective_workspace,
                change.effective_path.clone(),
                Some(false),
                change.expected_revision.as_deref(),
            )
            .await
        };

        if let Err(error) = result {
            let rollback_errors = rollback_pending_file_changes_via_fs(
                &backups[..applied_count],
                &changes[..applied_count],
            )
            .await;
            let rollback_suffix = if rollback_errors.is_empty() {
                String::new()
            } else {
                format!(" Rollback errors: {}", rollback_errors.join("; "))
            };
            return Err(command_error(format!("{}{}", error, rollback_suffix)));
        }
    }

    Ok(())
}

/// Applies a validated batch with best-effort filesystem atomicity.
///
/// Each write uses a temporary file in the destination directory followed by a
/// rename. If an operation fails after earlier files were mutated, the earlier
/// files are rolled back in reverse order. Disk or permission errors during
/// rollback are surfaced to the caller.
pub(crate) async fn commit_pending_file_changes_atomically(
    changes: &[PendingFileChange],
) -> CommandResult<()> {
    let _mutation_guards = acquire_content_mutation_locks(changes).await?;
    if changes.iter().any(change_targets_wsl) {
        return commit_pending_file_changes_via_fs(changes).await;
    }

    let mut backups = Vec::with_capacity(changes.len());
    for change in changes {
        let backup = match tokio::fs::read(&change.absolute_path).await {
            Ok(bytes) => {
                fs::validate_expected_revision(
                    &change.display_path,
                    change.expected_revision.as_deref(),
                    Some(&fs::content_revision(&bytes)),
                )
                .map_err(|error| command_error(error.to_string()))?;
                Some(bytes)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::validate_expected_revision(
                    &change.display_path,
                    change.expected_revision.as_deref(),
                    None,
                )
                .map_err(|error| command_error(error.to_string()))?;
                None
            }
            Err(error) => {
                return Err(command_error(format!(
                    "Failed to prepare backup for {}: {}",
                    change.display_path, error
                )))
            }
        };
        backups.push((change.absolute_path.clone(), backup));
    }

    for (applied_count, change) in changes.iter().enumerate() {
        let revision_result = if change.expected_revision.is_some() {
            let actual_revision = match tokio::fs::read(&change.absolute_path).await {
                Ok(bytes) => Some(fs::content_revision(&bytes)),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => {
                    return rollback_after_batch_failure(
                        &backups,
                        changes,
                        applied_count,
                        command_error(format!(
                            "Failed to revalidate {} before mutation: {}",
                            change.display_path, error
                        )),
                    )
                    .await;
                }
            };
            fs::validate_expected_revision(
                &change.display_path,
                change.expected_revision.as_deref(),
                actual_revision.as_deref(),
            )
            .map_err(|error| command_error(error.to_string()))
        } else {
            Ok(())
        };
        let result = match revision_result {
            Err(error) => Err(error),
            Ok(()) => {
                if let Some(new_content) = change.new_content.as_ref() {
                    write_file_atomically(&change.absolute_path, new_content).await
                } else {
                    tokio::fs::remove_file(&change.absolute_path)
                        .await
                        .map_err(|error| {
                            command_error(format!(
                                "Failed to delete {}: {}",
                                change.display_path, error
                            ))
                        })
                }
            }
        };

        if let Err(error) = result {
            return rollback_after_batch_failure(&backups, changes, applied_count, error).await;
        }
    }

    Ok(())
}

async fn rollback_after_batch_failure(
    backups: &[(PathBuf, Option<Vec<u8>>)],
    changes: &[PendingFileChange],
    applied_count: usize,
    error: CommandError,
) -> CommandResult<()> {
    let rollback_errors =
        rollback_pending_file_changes(&backups[..applied_count], &changes[..applied_count]).await;
    let rollback_suffix = if rollback_errors.is_empty() {
        String::new()
    } else {
        format!(" Rollback errors: {}", rollback_errors.join("; "))
    };
    Err(command_error(format!(
        "{}{}",
        error.message, rollback_suffix
    )))
}

pub(crate) async fn build_post_write_response(
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
                    "revision": read_result.revision,
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
                        "revision": Value::Null,
                    })
                }
            }
        } else {
            let exists =
                fs::exists_internal(&change.effective_workspace, change.effective_path.clone())
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
                "revision": Value::Null,
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
async fn execute_workspace_tool_controlled(
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
    let Some(timeout_duration) = tool_execution_timeout(tool_id.trim()) else {
        return execute_workspace_tool_inner(
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
        .await;
    };
    let registration = register_tool_execution(execution_id.as_deref());
    let cancellation = registration
        .as_ref()
        .map(|(cancellation, _)| cancellation.clone());
    let _guard = registration.map(|(_, guard)| guard);
    let cancellation = cancellation.unwrap_or_else(|| Arc::new(ToolCancellation::new()));
    let tool_label = tool_id.trim().to_string();
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
        Some(cancellation.clone()),
    );
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

    if virtual_root_enabled.unwrap_or(false) {
        if let Some(result) = workspace_tools::execute_virtual_workspace_tool(
            &mode_trimmed,
            &tool_trimmed,
            &args,
            project_mounts.as_deref().unwrap_or(&[]),
            focused_project_id.as_deref(),
            cancellation.clone(),
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

            let result =
                fs::read_file_internal(&effective_workspace, effective_path.clone(), Some(false))
                    .await
                    .map_err(|error| command_error(error.to_string()))?;

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
            let effective_workspace = resolve_workspace_for_tool_path(
                &workspace,
                &git_state,
                Some(path.as_str()),
                workspace_scope.as_deref(),
            )
            .await?;

            let absolute_path =
                resolve_validated_tool_path(&effective_workspace, effective_path.as_str(), true)?;

            let write_result = fs::write_file_internal_with_revision(
                &effective_workspace,
                effective_path.clone(),
                content.clone(),
                create_dirs,
                Some(false),
                expected_revision.as_deref(),
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
                expected_revision,
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

            let write_result = fs::write_file_internal_with_revision(
                &effective_workspace,
                effective_path.clone(),
                updated.clone(),
                Some(true),
                Some(false),
                Some(&mutation_revision),
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
                expected_revision: Some(mutation_revision),
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

            fs::delete_path_internal_with_revision(
                &effective_workspace,
                effective_path.clone(),
                Some(false),
                Some(&mutation_revision),
            )
            .await
            .map_err(|error| command_error(format!("Failed to delete {}: {}", path, error)))?;

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
            };

            build_post_write_response(
                &[change],
                serde_json::Map::from_iter([("path".to_string(), Value::String(path))]),
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
                        });
                    }
                }
            }

            commit_pending_file_changes_atomically(&pending_changes).await?;

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
                "total_count": (!truncated).then_some(page.offset + results.len()),
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
                let branches = git::build_wsl_git_branches(&wsl_repo_path)
                    .await
                    .map_err(|error| command_error(error.to_string()))?;
                return serde_json::to_string_pretty(&serde_json::json!({
                    "repo_path": repo_path,
                    "local": branches.local,
                    "remote": branches.remote,
                    "current": branches.current
                }))
                .map_err(|error| command_error(error.to_string()));
            }
            let repo_path_for_task = repo_path.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();

            let branches = tokio::task::spawn_blocking(move || {
                let validated =
                    validate_agent_git_repo_path(&repo_path_for_task, &workspace_for_task)?;
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
            if let Some(wsl_repo_path) =
                resolve_confined_wsl_repo_path_for_workspace(&workspace, &repo_path).await?
            {
                let tree = git::build_wsl_git_tree(&wsl_repo_path, branch.as_deref())
                    .await
                    .map_err(|error| command_error(error.to_string()))?;
                return serde_json::to_string_pretty(&serde_json::json!({
                    "repo_path": repo_path,
                    "branch": tree.branch,
                    "structure": tree.structure,
                    "modified_files_count": tree.modified_files_count
                }))
                .map_err(|error| command_error(error.to_string()));
            }
            let repo_path_for_task = repo_path.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();

            let tree = tokio::task::spawn_blocking(move || {
                let validated =
                    validate_agent_git_repo_path(&repo_path_for_task, &workspace_for_task)?;
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
            if let Some(wsl_repo_path) =
                resolve_confined_wsl_repo_path_for_workspace(&workspace, &repo_path).await?
            {
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
            if resolve_confined_wsl_repo_path_for_workspace(&workspace, &repo_path)
                .await?
                .is_some()
            {
                return Err(unsupported_wsl_workspace_tool("git_merge"));
            }

            let repo_path_for_task = repo_path.clone();
            let branch_name_for_task = branch_name.clone();
            let into_branch_for_task = into_branch.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();
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
            if resolve_confined_wsl_repo_path_for_workspace(&workspace, &repo_path)
                .await?
                .is_some()
            {
                return Err(unsupported_wsl_workspace_tool("git_stash"));
            }
            let repo_path_for_task = repo_path.clone();
            let workspace_for_task = workspace.clone();
            let git_state_for_task = git_state.clone();

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
    project_mounts: Option<Vec<WorkspaceProjectMount>>,
    virtual_root_enabled: Option<bool>,
    focused_project_id: Option<String>,
    execution_id: Option<String>,
) -> CommandResult<String> {
    let workspace = workspace_root.inner().read().await.clone();
    let metadata_workspace = workspace_metadata_root.inner().0.read().await.clone();
    let git_state = git_state.inner().clone();
    execute_workspace_tool_controlled(
        workspace,
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
    )
    .await
}

#[tauri::command]
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
pub async fn db_get_chat_bootstrap_snapshot(
    pool: State<'_, DbPool>,
    preload_conversation_ids: Option<Vec<String>>,
) -> CommandResult<ChatBootstrapSnapshot> {
    let pool = get_pool(&pool).await?;

    repository::get_chat_bootstrap_snapshot(
        &pool,
        preload_conversation_ids.as_deref().unwrap_or(&[]),
    )
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
    provider_id: Option<String>,
    model_id: Option<String>,
    reasoning_effort: Option<String>,
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
            provider_id,
            model_id,
            reasoning_effort,
        },
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn db_update_conversation_ai_selection(
    pool: State<'_, DbPool>,
    id: String,
    provider_id: Option<String>,
    model_id: Option<String>,
    reasoning_effort: Option<String>,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::update_conversation_ai_selection(
        &pool,
        &id,
        provider_id.as_deref(),
        model_id.as_deref(),
        reasoning_effort.as_deref(),
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
pub async fn db_update_conversation_scope(
    pool: State<'_, DbPool>,
    id: String,
    scope_mode: String,
    task_id: Option<String>,
    group_id: Option<String>,
    project_id: Option<String>,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::update_conversation_scope(
        &pool,
        &id,
        &scope_mode,
        task_id.as_deref(),
        group_id.as_deref(),
        project_id.as_deref(),
    )
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbCreateMessageParams {
    id: Option<String>,
    conversation_id: String,
    turn_id: Option<String>,
    role: String,
    content: String,
    token_count: Option<i32>,
    tool_traces_json: Option<String>,
    hidden_context: Option<String>,
    provider_input_items_json: Option<String>,
    provider_turn_state_json: Option<String>,
    context_refs_json: Option<String>,
    completion_reason: Option<String>,
}

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
    params: DbCreateMessageParams,
) -> CommandResult<Message> {
    let pool = get_pool(&pool).await?;

    repository::create_message(
        &pool,
        CreateMessageInput {
            id: params.id,
            conversation_id: params.conversation_id,
            turn_id: params.turn_id,
            role: params.role,
            content: params.content,
            token_count: params.token_count,
            tool_traces_json: params.tool_traces_json,
            hidden_context: params.hidden_context,
            provider_input_items_json: params.provider_input_items_json,
            provider_turn_state_json: params.provider_turn_state_json,
            context_refs_json: params.context_refs_json,
            completion_reason: params.completion_reason,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbUpdateMessageParams {
    id: String,
    turn_id: Option<String>,
    content: String,
    token_count: Option<i32>,
    tool_traces_json: Option<String>,
    hidden_context: Option<String>,
    provider_input_items_json: Option<String>,
    provider_turn_state_json: Option<String>,
    context_refs_json: Option<String>,
    completion_reason: Option<String>,
}

#[tauri::command]
pub async fn db_update_message(
    pool: State<'_, DbPool>,
    params: DbUpdateMessageParams,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::update_message_content(
        &pool,
        repository::UpdateMessageContentInput {
            id: &params.id,
            turn_id: params.turn_id,
            content: &params.content,
            token_count: params.token_count,
            tool_traces_json: params.tool_traces_json,
            hidden_context: params.hidden_context,
            provider_input_items_json: params.provider_input_items_json,
            provider_turn_state_json: params.provider_turn_state_json,
            context_refs_json: params.context_refs_json,
            completion_reason: params.completion_reason,
        },
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

#[tauri::command]
pub async fn db_trim_conversation_replay(
    pool: State<'_, DbPool>,
    conversation_id: String,
    after_message_id: String,
    code_checkpoints_json: Option<String>,
    delete_context_compaction_state: bool,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;
    repository::trim_conversation_replay(
        &pool,
        &conversation_id,
        &after_message_id,
        code_checkpoints_json.as_deref(),
        delete_context_compaction_state,
    )
    .await
    .map_err(CommandError::from)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbPrepareConversationReplayParams {
    conversation_id: String,
    message_id: String,
    session_id: String,
    turn_id: String,
    replay_id: String,
    content: String,
    hidden_context: Option<String>,
    provider_input_items_json: Option<String>,
    code_checkpoints_json: Option<String>,
    delete_context_compaction_state: bool,
}

#[tauri::command]
pub async fn db_prepare_conversation_replay(
    pool: State<'_, DbPool>,
    params: DbPrepareConversationReplayParams,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;
    repository::prepare_conversation_replay(
        &pool,
        repository::PrepareConversationReplayInput {
            conversation_id: &params.conversation_id,
            message_id: &params.message_id,
            session_id: &params.session_id,
            turn_id: &params.turn_id,
            replay_id: &params.replay_id,
            content: &params.content,
            hidden_context: params.hidden_context,
            provider_input_items_json: params.provider_input_items_json,
            code_checkpoints_json: params.code_checkpoints_json,
            delete_context_compaction_state: params.delete_context_compaction_state,
        },
    )
    .await
    .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_restore_conversation_replay(
    pool: State<'_, DbPool>,
    conversation_id: String,
    replay_id: String,
    session_id: String,
    turn_id: String,
) -> CommandResult<bool> {
    let pool = get_pool(&pool).await?;
    repository::restore_conversation_replay(
        &pool,
        &conversation_id,
        &replay_id,
        Some(&session_id),
        Some(&turn_id),
    )
    .await
    .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_complete_conversation_replay(
    pool: State<'_, DbPool>,
    conversation_id: String,
    replay_id: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;
    repository::complete_conversation_replay(&pool, &conversation_id, &replay_id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_mark_conversation_replay_launched(
    pool: State<'_, DbPool>,
    conversation_id: String,
    replay_id: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;
    repository::mark_conversation_replay_launched(&pool, &conversation_id, &replay_id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_finalize_conversation_replay(
    pool: State<'_, DbPool>,
    conversation_id: String,
    replay_id: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;
    repository::finalize_conversation_replay(&pool, &conversation_id, &replay_id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_list_conversation_citations(
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> CommandResult<Vec<ConversationCitation>> {
    let pool = get_pool(&pool).await?;

    repository::list_conversation_citations(&pool, &conversation_id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_get_conversation_citation_content(
    pool: State<'_, DbPool>,
    id: String,
) -> CommandResult<Option<String>> {
    let pool = get_pool(&pool).await?;

    repository::get_conversation_citation_content(&pool, &id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_upsert_conversation_citation(
    pool: State<'_, DbPool>,
    input: UpsertConversationCitationInput,
) -> CommandResult<ConversationCitation> {
    let pool = get_pool(&pool).await?;

    repository::upsert_conversation_citation(&pool, input)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_delete_conversation_citation(
    pool: State<'_, DbPool>,
    id: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::delete_conversation_citation(&pool, &id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_delete_conversation_citations(
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::delete_conversation_citations(&pool, &conversation_id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_get_conversation_toolbox_state(
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> CommandResult<Option<ConversationToolboxStateRecord>> {
    let pool = get_pool(&pool).await?;

    repository::get_conversation_toolbox_state(&pool, &conversation_id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_upsert_conversation_toolbox_state(
    pool: State<'_, DbPool>,
    input: UpsertConversationToolboxStateInput,
) -> CommandResult<ConversationToolboxStateRecord> {
    let pool = get_pool(&pool).await?;

    repository::upsert_conversation_toolbox_state(&pool, input)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_delete_conversation_toolbox_state(
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::delete_conversation_toolbox_state(&pool, &conversation_id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_get_architect_plan_conversation_sync(
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> CommandResult<Option<ArchitectPlanConversationSyncRecord>> {
    let pool = get_pool(&pool).await?;

    repository::get_architect_plan_conversation_sync(&pool, &conversation_id)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_get_architect_plan_conversation_sync_for_plan(
    pool: State<'_, DbPool>,
    plan_id: String,
    target_branch: String,
) -> CommandResult<Option<ArchitectPlanConversationSyncRecord>> {
    let pool = get_pool(&pool).await?;

    repository::get_architect_plan_conversation_sync_for_plan(&pool, &plan_id, &target_branch)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_upsert_architect_plan_conversation_sync(
    pool: State<'_, DbPool>,
    input: UpsertArchitectPlanConversationSyncInput,
) -> CommandResult<ArchitectPlanConversationSyncRecord> {
    let pool = get_pool(&pool).await?;

    repository::upsert_architect_plan_conversation_sync(&pool, input)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn db_delete_architect_plan_conversation_sync(
    pool: State<'_, DbPool>,
    conversation_id: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::delete_architect_plan_conversation_sync(&pool, &conversation_id)
        .await
        .map_err(CommandError::from)
}

// ============ PROVIDER CONFIGS ============

async fn configured_provider_configs(
    manager: &ConfigManager,
    pool: &SqlitePool,
) -> CommandResult<Vec<ProviderConfig>> {
    let document = manager
        .effective_user_document(ConfigDocumentKind::Providers)
        .await;
    let definitions = document
        .get("providers")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            command_error("providers.json ne contient pas de registre providers valide.")
        })?;
    let legacy_status = repository::list_provider_configs(pool)
        .await
        .map_err(CommandError::from)?
        .into_iter()
        .map(|provider| (provider.id.clone(), provider))
        .collect::<HashMap<_, _>>();
    let now = chrono::Utc::now().to_rfc3339();
    let mut providers = Vec::with_capacity(definitions.len());
    for (id, definition) in definitions {
        let status = legacy_status.get(id);
        let provider_type = definition
            .get("providerType")
            .and_then(Value::as_str)
            .unwrap_or("openai")
            .to_string();
        let has_stored_api_key = secrets::get_api_key(id)
            .map_err(|error| command_error(format!("Failed to inspect provider secret: {error}")))?
            .is_some();
        providers.push(ProviderConfig {
            id: id.clone(),
            name: definition
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(id)
                .to_string(),
            provider_type,
            base_url: definition
                .get("baseUrl")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            api_key: None,
            has_stored_api_key,
            is_enabled: definition
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            is_local: definition
                .get("isLocal")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            auth_status: status.and_then(|value| value.auth_status.clone()),
            auth_source: status.and_then(|value| value.auth_source.clone()),
            plan_type: status.and_then(|value| value.plan_type.clone()),
            account_label: status.and_then(|value| value.account_label.clone()),
            token_expires_at: status.and_then(|value| value.token_expires_at.clone()),
            created_at: status
                .map(|value| value.created_at.clone())
                .unwrap_or_else(|| now.clone()),
            updated_at: status
                .map(|value| value.updated_at.clone())
                .unwrap_or_else(|| now.clone()),
        });
    }
    Ok(providers)
}

fn provider_definition_patch_operations(
    document: &Value,
    provider_id: &str,
    definition: Option<Value>,
) -> Option<Vec<JsonPatchOperation>> {
    let escaped = provider_id.replace('~', "~0").replace('/', "~1");
    let provider_path = format!("/providers/{escaped}");
    let current_exists = document.pointer(&provider_path).is_some();
    let Some(value) = definition else {
        return current_exists.then(|| {
            vec![JsonPatchOperation {
                op: "remove".to_string(),
                path: provider_path,
                from: None,
                value: None,
            }]
        });
    };

    let mut operations = Vec::with_capacity(2);
    if document
        .get("providers")
        .and_then(Value::as_object)
        .is_none()
    {
        operations.push(JsonPatchOperation {
            op: "add".to_string(),
            path: "/providers".to_string(),
            from: None,
            value: Some(serde_json::json!({})),
        });
    }
    operations.push(JsonPatchOperation {
        op: "add".to_string(),
        path: provider_path,
        from: None,
        value: Some(value),
    });
    Some(operations)
}

async fn patch_provider_definition(
    manager: &ConfigManager,
    provider_id: &str,
    definition: Option<Value>,
) -> CommandResult<()> {
    let document = manager
        .get_document(ConfigDocumentKind::Providers, ConfigScope::User)
        .await
        .map_err(|error| command_error(error.message))?;
    let Some(patch) =
        provider_definition_patch_operations(&document.value, provider_id, definition)
    else {
        return Ok(());
    };
    manager
        .apply_patch(ConfigPatchRequest {
            kind: ConfigDocumentKind::Providers,
            scope: ConfigScope::User,
            expected_etag: document.etag,
            patch,
            source: ConfigChangeSource::UserInterface,
        })
        .await
        .map_err(|error| command_error(error.message))?;
    Ok(())
}

fn restore_deleted_provider_secrets(
    provider_id: &str,
    api_key: Option<&str>,
    chatgpt_secret: Option<&secrets::ChatGptSecret>,
) {
    if let Some(api_key) = api_key {
        if let Err(error) = secrets::set_api_key(provider_id, api_key) {
            tracing::error!(
                "Failed to restore API key for provider {provider_id} after failed deletion: {error}"
            );
        }
    }
    if let Some(chatgpt_secret) = chatgpt_secret {
        if let Err(error) = secrets::set_chatgpt_secret(provider_id, chatgpt_secret) {
            tracing::error!(
                "Failed to restore ChatGPT session for provider {provider_id} after failed deletion: {error}"
            );
        }
    }
}

async fn patch_provider_document_top_level(
    manager: &ConfigManager,
    key: &str,
    value: Value,
) -> CommandResult<()> {
    let document = manager
        .get_document(ConfigDocumentKind::Providers, ConfigScope::User)
        .await
        .map_err(|error| command_error(error.message))?;
    manager
        .apply_patch(ConfigPatchRequest {
            kind: ConfigDocumentKind::Providers,
            scope: ConfigScope::User,
            expected_etag: document.etag,
            patch: vec![JsonPatchOperation {
                op: "add".to_string(),
                path: format!("/{}", key.replace('~', "~0").replace('/', "~1")),
                from: None,
                value: Some(value),
            }],
            source: ConfigChangeSource::UserInterface,
        })
        .await
        .map_err(|error| command_error(error.message))?;
    Ok(())
}

async fn configured_provider_models(
    manager: &ConfigManager,
    pool: &SqlitePool,
    provider_id: &str,
) -> CommandResult<Vec<AiModel>> {
    let mut models = repository::list_models_by_provider(pool, provider_id)
        .await
        .map_err(CommandError::from)?
        .into_iter()
        .filter(|model| !model.is_manual)
        .collect::<Vec<_>>();
    let document = manager
        .effective_user_document(ConfigDocumentKind::Providers)
        .await;
    let now = chrono::Utc::now().to_rfc3339();
    if let Some(manual_models) = document.get("manualModels").and_then(Value::as_object) {
        for (stable_id, definition) in manual_models {
            if definition.get("providerId").and_then(Value::as_str) != Some(provider_id) {
                continue;
            }
            let Some(model_id) = definition.get("modelId").and_then(Value::as_str) else {
                continue;
            };
            models.push(AiModel {
                id: format!("config:{stable_id}"),
                provider_id: provider_id.to_string(),
                model_id: model_id.to_string(),
                name: definition
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or(model_id)
                    .to_string(),
                description: None,
                owned_by: None,
                pricing_prompt: None,
                pricing_completion: None,
                pricing_request: None,
                reasoning_efforts: None,
                default_reasoning_effort: None,
                context_window_tokens: definition
                    .get("contextWindow")
                    .and_then(Value::as_i64)
                    .and_then(|value| i32::try_from(value).ok()),
                input_limit_tokens: None,
                output_limit_tokens: None,
                context_window_source: definition
                    .get("contextWindow")
                    .is_some()
                    .then(|| "user_override".to_string()),
                context_limits_updated_at: None,
                is_enabled: definition
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                is_manual: true,
                first_seen_at: now.clone(),
                last_seen_at: now.clone(),
            });
        }
    }
    if let Some(overrides) = document.get("modelOverrides").and_then(Value::as_object) {
        for model in &mut models {
            let composite = format!("{provider_id}/{}", model.model_id);
            let Some(overlay) = overrides
                .get(&composite)
                .or_else(|| overrides.get(&model.model_id))
            else {
                continue;
            };
            if let Some(name) = overlay.get("displayName").and_then(Value::as_str) {
                model.name = name.to_string();
            }
            if let Some(enabled) = overlay.get("enabled").and_then(Value::as_bool) {
                model.is_enabled = enabled;
            }
            if let Some(tokens) = overlay
                .get("contextWindow")
                .and_then(Value::as_i64)
                .and_then(|value| i32::try_from(value).ok())
            {
                model.context_window_tokens = Some(tokens);
                model.context_window_source = Some("user_override".to_string());
            }
        }
    }
    models.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(models)
}

#[tauri::command]
pub async fn db_list_provider_configs(
    pool: State<'_, DbPool>,
    workspace_metadata_root: State<'_, WorkspaceMetadataRoot>,
    config_manager: State<'_, ConfigManager>,
) -> CommandResult<Vec<ProviderConfig>> {
    let pool = get_pool(&pool).await?;
    if tauri::is_dev() {
        let workspace_root = workspace_metadata_root.0.read().await.clone();
        crate::dev_overrides::sync_declared_dev_providers_from_workspace(&pool, &workspace_root)
            .await
            .map_err(CommandError::from)?;
    }

    let mut configs = configured_provider_configs(config_manager.inner(), &pool).await?;

    for config in configs.iter_mut() {
        reconcile_provider_secret_metadata(&pool, config).await?;
    }

    Ok(configs)
}

async fn reconcile_provider_secret_metadata(
    pool: &SqlitePool,
    config: &mut ProviderConfig,
) -> CommandResult<()> {
    if config.provider_type == "chatgpt" {
        let has_secret = secrets::get_chatgpt_secret(&config.id)
            .map_err(|error| CommandError {
                message: format!(
                    "Failed to access local ChatGPT session for {}: {}",
                    config.id, error
                ),
            })?
            .is_some();
        let linked = matches!(
            config.auth_status.as_deref(),
            Some("authenticated" | "refreshing" | "expired")
        );

        if linked && !has_secret {
            repository::update_provider_auth_metadata(
                pool,
                &config.id,
                &ProviderAuthMetadata {
                    auth_status: Some("unauthenticated".to_string()),
                    auth_source: None,
                    plan_type: None,
                    account_label: None,
                    token_expires_at: None,
                },
            )
            .await
            .map_err(CommandError::from)?;
            config.auth_status = Some("unauthenticated".to_string());
            config.auth_source = None;
            config.plan_type = None;
            config.account_label = None;
            config.token_expires_at = None;
        }
        return Ok(());
    }

    if config.provider_type != "copilot" && !config.is_local && config.has_stored_api_key {
        let has_key = secrets::get_api_key(&config.id)
            .map_err(|error| CommandError {
                message: format!(
                    "Failed to access local provider API key for {}: {}",
                    config.id, error
                ),
            })?
            .is_some();
        if !has_key {
            repository::set_provider_has_stored_api_key(pool, &config.id, false)
                .await
                .map_err(CommandError::from)?;
            config.has_stored_api_key = false;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn db_get_provider_config(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    id: String,
) -> CommandResult<Option<ProviderConfig>> {
    let pool = get_pool(&pool).await?;
    Ok(configured_provider_configs(config_manager.inner(), &pool)
        .await?
        .into_iter()
        .find(|provider| provider.id == id))
}

#[tauri::command]
pub async fn db_reveal_provider_api_key(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    id: String,
) -> CommandResult<Option<String>> {
    let pool = get_pool(&pool).await?;
    let config = configured_provider_configs(config_manager.inner(), &pool)
        .await?
        .into_iter()
        .find(|provider| provider.id == id);

    if config.is_none() {
        return Err(CommandError {
            message: format!("Provider {} not found", id),
        });
    }

    let api_key = secrets::get_api_key(&id).map_err(|error| CommandError {
        message: format!(
            "Failed to access the local provider secret for {}: {}",
            id, error
        ),
    })?;

    Ok(api_key)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbUpdateProviderConfigParams {
    id: String,
    name: Option<String>,
    provider_type: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    is_local: Option<bool>,
    is_enabled: Option<bool>,
}

#[tauri::command]
pub async fn db_update_provider_config(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    params: DbUpdateProviderConfigParams,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;
    if params.id == crate::ai::macro_ai::PROVIDER_ID {
        return Err(CommandError {
            message: "Macro AI is managed automatically and cannot be edited.".to_string(),
        });
    }

    let provider_id = params.id.clone();
    let lock = provider_mutation_lock(&provider_id);
    let _guard = lock.lock().await;
    let previous_config = configured_provider_configs(config_manager.inner(), &pool)
        .await?
        .into_iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| command_error(format!("Provider {} not found", provider_id)))?;
    let previous_api_key = if params.api_key.is_some() {
        secrets::get_api_key(&provider_id).map_err(|error| {
            command_error(format!(
                "Failed to read the local provider secret for {}: {}",
                provider_id, error
            ))
        })?
    } else {
        None
    };
    if let Some(api_key) = params.api_key.as_deref() {
        if api_key.trim().is_empty() {
            secrets::delete_api_key(&provider_id)
        } else {
            secrets::set_api_key(&provider_id, api_key.trim())
        }
        .map_err(|error| command_error(format!("Failed to update provider secret: {error}")))?;
    }

    let definition = serde_json::json!({
        "providerType": params.provider_type.unwrap_or(previous_config.provider_type),
        "name": params.name.unwrap_or(previous_config.name),
        "enabled": params.is_enabled.unwrap_or(previous_config.is_enabled),
        "baseUrl": params.base_url.unwrap_or(previous_config.base_url),
        "isLocal": params.is_local.unwrap_or(previous_config.is_local),
    });
    if let Err(error) =
        patch_provider_definition(config_manager.inner(), &provider_id, Some(definition)).await
    {
        if params.api_key.is_some() {
            let _ = match previous_api_key {
                Some(previous) => secrets::set_api_key(&provider_id, &previous),
                None => secrets::delete_api_key(&provider_id),
            };
        }
        return Err(error);
    }

    Ok(())
}

#[tauri::command]
pub async fn db_create_provider_config(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    name: String,
    provider_type: String,
    base_url: String,
    api_key: Option<String>,
    is_local: bool,
    is_enabled: bool,
) -> CommandResult<ProviderConfig> {
    let pool = get_pool(&pool).await?;
    let id = format!("provider-{}", uuid::Uuid::new_v4().simple());
    let definition = serde_json::json!({
        "providerType": provider_type,
        "name": name,
        "enabled": is_enabled,
        "baseUrl": base_url,
        "isLocal": is_local,
    });
    patch_provider_definition(config_manager.inner(), &id, Some(definition)).await?;
    if let Some(key) = api_key.as_deref().filter(|key| !key.trim().is_empty()) {
        if let Err(error) = secrets::set_api_key(&id, key.trim()) {
            let _ = patch_provider_definition(config_manager.inner(), &id, None).await;
            return Err(command_error(format!(
                "Failed to persist provider secret: {error}"
            )));
        }
    }
    configured_provider_configs(config_manager.inner(), &pool)
        .await?
        .into_iter()
        .find(|provider| provider.id == id)
        .ok_or_else(|| command_error("Le fournisseur créé est introuvable dans providers.json."))
}

#[tauri::command]
pub async fn db_delete_provider_config(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    id: String,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;
    if id == crate::ai::macro_ai::PROVIDER_ID {
        return Err(CommandError {
            message: "Macro AI is managed automatically and cannot be deleted.".to_string(),
        });
    }

    let lock = provider_mutation_lock(&id);
    let _guard = lock.lock().await;
    let previous_config = configured_provider_configs(config_manager.inner(), &pool)
        .await?
        .into_iter()
        .find(|provider| provider.id == id)
        .ok_or_else(|| command_error(format!("Provider {} not found", id)))?;
    let document = config_manager
        .get_document(ConfigDocumentKind::Providers, ConfigScope::User)
        .await
        .map_err(|error| command_error(error.message))?;
    let escaped = id.replace('~', "~0").replace('/', "~1");
    let previous_api_key = secrets::get_api_key(&id)
        .map_err(|error| command_error(format!("Failed to read provider secret: {error}")))?;
    let previous_chatgpt_secret = secrets::get_chatgpt_secret(&id).map_err(|error| {
        command_error(format!("Failed to read provider ChatGPT session: {error}"))
    })?;
    if let Err(error) = secrets::delete_api_key(&id) {
        return Err(command_error(format!(
            "Failed to delete provider secret: {error}"
        )));
    }
    if let Err(error) = secrets::delete_provider_secret(&id) {
        restore_deleted_provider_secrets(
            &id,
            previous_api_key.as_deref(),
            previous_chatgpt_secret.as_ref(),
        );
        return Err(command_error(format!(
            "Failed to delete provider ChatGPT session: {error}"
        )));
    }
    let definition = if document
        .value
        .pointer(&format!("/providers/{escaped}"))
        .is_some()
    {
        None
    } else {
        Some(serde_json::json!({
            "providerType": previous_config.provider_type,
            "name": previous_config.name,
            "enabled": false,
            "baseUrl": previous_config.base_url,
            "isLocal": previous_config.is_local,
        }))
    };
    if let Err(error) = patch_provider_definition(config_manager.inner(), &id, definition).await {
        restore_deleted_provider_secrets(
            &id,
            previous_api_key.as_deref(),
            previous_chatgpt_secret.as_ref(),
        );
        return Err(error);
    }
    Ok(())
}

// ============ AI MODELS ============

#[tauri::command]
pub async fn db_list_provider_models(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    provider_id: String,
) -> CommandResult<Vec<AiModel>> {
    let pool = get_pool(&pool).await?;
    configured_provider_models(config_manager.inner(), &pool, &provider_id).await
}

#[tauri::command]
pub async fn db_upsert_provider_models(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    provider_id: String,
    models: Vec<ProviderModelInput>,
) -> CommandResult<Vec<AiModel>> {
    let pool = get_pool(&pool).await?;

    let document = config_manager
        .effective_user_document(ConfigDocumentKind::Providers)
        .await;
    let mut overrides = document
        .get("modelOverrides")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut overrides_changed = false;
    for model in &models {
        let key = format!("{provider_id}/{}", model.model_id);
        let mut overlay = overrides
            .remove(&key)
            .unwrap_or_else(|| serde_json::json!({}));
        if model.context_window_source.as_deref() == Some("user_override") {
            if let Some(tokens) = model.context_window_tokens {
                overlay["contextWindow"] = Value::from(tokens);
                overrides_changed = true;
            }
        } else if overlay.get("contextWindow").is_some() {
            overlay
                .as_object_mut()
                .map(|object| object.remove("contextWindow"));
            overrides_changed = true;
        }
        if overlay.as_object().is_some_and(|object| !object.is_empty()) {
            overrides.insert(key, overlay);
        }
    }
    if overrides_changed {
        patch_provider_document_top_level(
            config_manager.inner(),
            "modelOverrides",
            Value::Object(overrides),
        )
        .await?;
    }

    repository::upsert_provider_models(&pool, &provider_id, &models)
        .await
        .map_err(CommandError::from)?;

    configured_provider_models(config_manager.inner(), &pool, &provider_id).await
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
pub async fn db_insert_conversation_compaction_event(
    pool: State<'_, DbPool>,
    input: InsertConversationCompactionEventInput,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;

    repository::insert_conversation_compaction_event(&pool, input)
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
    config_manager: State<'_, ConfigManager>,
    provider_id: String,
    model_id: String,
    name: String,
) -> CommandResult<Vec<AiModel>> {
    let pool = get_pool(&pool).await?;

    let document = config_manager
        .effective_user_document(ConfigDocumentKind::Providers)
        .await;
    let mut manual_models = document
        .get("manualModels")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if manual_models.values().any(|definition| {
        definition.get("providerId").and_then(Value::as_str) == Some(provider_id.as_str())
            && definition.get("modelId").and_then(Value::as_str) == Some(model_id.as_str())
    }) {
        return Err(command_error(format!(
            "Model {model_id} already exists for provider {provider_id}."
        )));
    }
    let stable_id = format!("{}:{}", provider_id, uuid::Uuid::new_v4().simple());
    manual_models.insert(
        stable_id,
        serde_json::json!({
            "providerId": provider_id,
            "modelId": model_id,
            "displayName": name,
            "enabled": true
        }),
    );
    patch_provider_document_top_level(
        config_manager.inner(),
        "manualModels",
        Value::Object(manual_models),
    )
    .await?;
    configured_provider_models(config_manager.inner(), &pool, &provider_id).await
}

#[tauri::command]
pub async fn db_update_manual_model(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    provider_id: String,
    current_model_id: String,
    next_model_id: String,
    name: String,
) -> CommandResult<Vec<AiModel>> {
    let pool = get_pool(&pool).await?;

    let document = config_manager
        .effective_user_document(ConfigDocumentKind::Providers)
        .await;
    let mut manual_models = document
        .get("manualModels")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let target = manual_models.iter().find_map(|(id, definition)| {
        (definition.get("providerId").and_then(Value::as_str) == Some(provider_id.as_str())
            && definition.get("modelId").and_then(Value::as_str) == Some(current_model_id.as_str()))
        .then(|| id.clone())
    });
    let target = target.ok_or_else(|| command_error("Manual model not found"))?;
    if manual_models.iter().any(|(id, definition)| {
        id != &target
            && definition.get("providerId").and_then(Value::as_str) == Some(provider_id.as_str())
            && definition.get("modelId").and_then(Value::as_str) == Some(next_model_id.as_str())
    }) {
        return Err(command_error(format!(
            "Model {next_model_id} already exists for provider {provider_id}."
        )));
    }
    let enabled = manual_models[&target]
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    manual_models.insert(
        target,
        serde_json::json!({
            "providerId": provider_id,
            "modelId": next_model_id,
            "displayName": name,
            "enabled": enabled
        }),
    );
    patch_provider_document_top_level(
        config_manager.inner(),
        "manualModels",
        Value::Object(manual_models),
    )
    .await?;
    configured_provider_models(config_manager.inner(), &pool, &provider_id).await
}

#[tauri::command]
pub async fn db_delete_manual_model(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    provider_id: String,
    model_id: String,
) -> CommandResult<Vec<AiModel>> {
    let pool = get_pool(&pool).await?;

    let document = config_manager
        .effective_user_document(ConfigDocumentKind::Providers)
        .await;
    let mut manual_models = document
        .get("manualModels")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    manual_models.retain(|_, definition| {
        definition.get("providerId").and_then(Value::as_str) != Some(provider_id.as_str())
            || definition.get("modelId").and_then(Value::as_str) != Some(model_id.as_str())
    });
    patch_provider_document_top_level(
        config_manager.inner(),
        "manualModels",
        Value::Object(manual_models),
    )
    .await?;
    configured_provider_models(config_manager.inner(), &pool, &provider_id).await
}

#[tauri::command]
pub async fn db_set_provider_model_enabled(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    provider_id: String,
    model_id: String,
    enabled: bool,
) -> CommandResult<()> {
    let _pool = get_pool(&pool).await?;
    let document = config_manager
        .effective_user_document(ConfigDocumentKind::Providers)
        .await;
    let mut manual_models = document
        .get("manualModels")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some((stable_id, mut definition)) = manual_models.iter().find_map(|(id, definition)| {
        (definition.get("providerId").and_then(Value::as_str) == Some(provider_id.as_str())
            && definition.get("modelId").and_then(Value::as_str) == Some(model_id.as_str()))
        .then(|| (id.clone(), definition.clone()))
    }) {
        definition["enabled"] = Value::Bool(enabled);
        manual_models.insert(stable_id, definition);
        return patch_provider_document_top_level(
            config_manager.inner(),
            "manualModels",
            Value::Object(manual_models),
        )
        .await;
    }

    let mut overrides = document
        .get("modelOverrides")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let key = format!("{provider_id}/{model_id}");
    let mut overlay = overrides
        .remove(&key)
        .unwrap_or_else(|| serde_json::json!({}));
    overlay["enabled"] = Value::Bool(enabled);
    overrides.insert(key, overlay);
    patch_provider_document_top_level(
        config_manager.inner(),
        "modelOverrides",
        Value::Object(overrides),
    )
    .await
}

#[tauri::command]
pub async fn db_set_all_provider_models_enabled(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    provider_id: String,
    enabled: bool,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;
    let models = configured_provider_models(config_manager.inner(), &pool, &provider_id).await?;
    let document = config_manager
        .effective_user_document(ConfigDocumentKind::Providers)
        .await;
    let mut manual_models = document
        .get("manualModels")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for definition in manual_models.values_mut() {
        if definition.get("providerId").and_then(Value::as_str) == Some(provider_id.as_str()) {
            definition["enabled"] = Value::Bool(enabled);
        }
    }
    let mut overrides = document
        .get("modelOverrides")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for model in models.into_iter().filter(|model| !model.is_manual) {
        let key = format!("{provider_id}/{}", model.model_id);
        let mut overlay = overrides
            .remove(&key)
            .unwrap_or_else(|| serde_json::json!({}));
        overlay["enabled"] = Value::Bool(enabled);
        overrides.insert(key, overlay);
    }
    patch_provider_document_top_level(
        config_manager.inner(),
        "manualModels",
        Value::Object(manual_models),
    )
    .await?;
    patch_provider_document_top_level(
        config_manager.inner(),
        "modelOverrides",
        Value::Object(overrides),
    )
    .await
}

// ============ PROVIDER SETTINGS ============

#[tauri::command]
pub async fn db_get_provider_settings(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    provider_id: String,
) -> CommandResult<ProviderSettings> {
    let _pool = get_pool(&pool).await?;
    let document = config_manager
        .effective_user_document(ConfigDocumentKind::Providers)
        .await;
    let definition = document
        .pointer(&format!(
            "/providers/{}",
            provider_id.replace('~', "~0").replace('/', "~1")
        ))
        .ok_or_else(|| command_error(format!("Provider {provider_id} not found")))?;
    Ok(ProviderSettings {
        provider_id,
        filter_free_models: definition
            .pointer("/options/filterFreeModels")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        copilot_send_timeout_ms: definition
            .pointer("/options/copilotSendTimeoutMs")
            .and_then(Value::as_i64),
    })
}

#[tauri::command]
pub async fn db_update_provider_settings(
    pool: State<'_, DbPool>,
    config_manager: State<'_, ConfigManager>,
    provider_id: String,
    filter_free_models: Option<bool>,
    copilot_send_timeout_ms: Option<Option<i64>>,
) -> CommandResult<()> {
    let pool = get_pool(&pool).await?;
    let current = configured_provider_configs(config_manager.inner(), &pool)
        .await?
        .into_iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| command_error(format!("Provider {provider_id} not found")))?;
    let document = config_manager
        .effective_user_document(ConfigDocumentKind::Providers)
        .await;
    let escaped = provider_id.replace('~', "~0").replace('/', "~1");
    let mut options = document
        .pointer(&format!("/providers/{escaped}/options"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(value) = filter_free_models {
        options.insert("filterFreeModels".to_string(), Value::Bool(value));
    }
    if let Some(value) = copilot_send_timeout_ms {
        match value {
            Some(timeout) => {
                options.insert("copilotSendTimeoutMs".to_string(), Value::from(timeout));
            }
            None => {
                options.remove("copilotSendTimeoutMs");
            }
        }
    }
    patch_provider_definition(
        config_manager.inner(),
        &provider_id,
        Some(serde_json::json!({
            "providerType": current.provider_type,
            "name": current.name,
            "enabled": current.is_enabled,
            "baseUrl": current.base_url,
            "isLocal": current.is_local,
            "options": options
        })),
    )
    .await
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
        apply_patch_hunks_to_content, command_error, commit_pending_file_changes_atomically,
        exact_edit_match_error, execute_workspace_tool, format_bounded_git_status,
        parse_apply_patch, provider_definition_patch_operations, register_tool_execution,
        resolve_confined_wsl_repo_path_for_workspace, resolve_requested_workspace,
        resolve_workspace_for_tool_path, restore_deleted_provider_secrets,
        rollback_pending_file_changes, tool_cancel_workspace, tool_execution_timeout,
        validate_agent_git_repo_path, DbPool, ParsedPatchOperation, PendingFileChange,
    };
    use crate::commands::fs::content_revision;
    use crate::commands::git::{GitFileStatus, GitStatusDto};
    use crate::git::GitState;
    use serde_json::{json, Value};
    use std::fs;
    use std::path::Path;
    use std::time::Duration;
    use tempfile::TempDir;

    async fn execute_readonly_workspace_tool(
        workspace: &Path,
        tool_id: &str,
        args: serde_json::Value,
    ) -> String {
        execute_workspace_tool(
            workspace.to_path_buf(),
            workspace.to_path_buf(),
            GitState::new(),
            "Implement".to_string(),
            tool_id.to_string(),
            args,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect("execute read-only workspace tool")
    }

    #[test]
    fn command_error_serializes_revision_conflicts_with_a_stable_code() {
        let error = command_error(
            "Failed to edit guarded.txt: Revision conflict: stale content".to_string(),
        );
        assert_eq!(
            serde_json::to_value(error).expect("serialize command error"),
            json!({
                "code": "REVISION_CONFLICT",
                "message": "Failed to edit guarded.txt: Revision conflict: stale content"
            })
        );
    }

    #[test]
    fn command_error_serializes_tool_interruptions_with_stable_codes() {
        let cancelled = command_error("Tool execution cancelled: grep.");
        assert_eq!(cancelled.code(), Some("TOOL_EXECUTION_CANCELLED"));
        let timed_out =
            command_error("Tool execution timed out after 30 seconds: grep. Narrow the query.");
        assert_eq!(timed_out.code(), Some("TOOL_EXECUTION_TIMEOUT"));
    }

    #[tokio::test]
    async fn confined_git_repo_rejects_a_wsl_path_from_a_native_workspace() {
        let workspace = TempDir::new().expect("workspace");
        let error = resolve_confined_wsl_repo_path_for_workspace(
            workspace.path(),
            r"\\wsl$\Ubuntu\home\user\repo",
        )
        .await
        .expect_err("native workspace must not route agent Git into WSL");

        assert!(error.message.contains("outside the selected workspace"));
    }

    #[tokio::test]
    async fn confined_git_repo_rejects_a_different_wsl_distribution_before_io() {
        let workspace = Path::new(r"\\wsl$\Ubuntu\home\user\workspace");
        let error = resolve_confined_wsl_repo_path_for_workspace(
            workspace,
            r"\\wsl$\Debian\home\user\repo",
        )
        .await
        .expect_err("agent Git must stay in the selected WSL distribution");

        assert!(error.message.contains("escapes WSL workspace"));
    }

    #[test]
    fn agent_git_repo_validation_rejects_absolute_and_linked_external_directories() {
        let temp = TempDir::new().expect("temp dir");
        let workspace = temp.path().join("workspace");
        let inside = workspace.join("inside");
        let outside = temp.path().join("workspace-sibling");
        fs::create_dir_all(&inside).expect("create inside repo directory");
        fs::create_dir_all(&outside).expect("create outside repo directory");

        let validated = validate_agent_git_repo_path("inside", &workspace)
            .expect("relative repo inside selected workspace");
        assert_eq!(validated, inside.canonicalize().expect("canonical inside"));

        let absolute_error =
            validate_agent_git_repo_path(outside.to_string_lossy().as_ref(), &workspace)
                .expect_err("absolute sibling must be rejected for agent Git");
        assert!(absolute_error.message.contains("outside workspace"));

        let linked = workspace.join("linked");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &linked).expect("create directory symlink");
        #[cfg(windows)]
        if std::os::windows::fs::symlink_dir(&outside, &linked).is_err() {
            return;
        }
        let linked_error = validate_agent_git_repo_path("linked", &workspace)
            .expect_err("linked external repo must be rejected for agent Git");
        assert!(linked_error.message.contains("outside workspace"));
    }

    #[tokio::test]
    async fn tool_execution_cancellation_reaches_the_registered_backend_work() {
        let execution_id = "workspace-tool-cancellation-test";
        let (cancellation, guard) =
            register_tool_execution(Some(execution_id)).expect("register cancellation");
        assert!(tool_cancel_workspace(execution_id.to_string()));
        tokio::time::timeout(Duration::from_millis(100), cancellation.cancelled())
            .await
            .expect("cancellation notification");
        drop(guard);
        assert!(!super::TOOL_EXECUTION_CANCELLATION_REGISTRY
            .lock()
            .expect("tool cancellation registry")
            .active
            .contains_key(execution_id));
    }

    #[tokio::test]
    async fn tool_execution_cancellation_before_registration_is_not_lost() {
        let execution_id = "workspace-tool-pre-registration-cancellation-test";
        assert!(!tool_cancel_workspace(execution_id.to_string()));

        let (cancellation, guard) =
            register_tool_execution(Some(execution_id)).expect("register cancelled execution");
        tokio::time::timeout(Duration::from_millis(100), cancellation.cancelled())
            .await
            .expect("pre-registration cancellation notification");
        assert!(cancellation.is_cancelled());
        drop(guard);
    }

    #[test]
    fn search_tools_have_hard_backend_deadlines() {
        assert_eq!(tool_execution_timeout("glob"), Some(Duration::from_secs(5)));
        assert_eq!(
            tool_execution_timeout("grep"),
            Some(Duration::from_secs(30))
        );
        assert_eq!(
            tool_execution_timeout("ast_grep"),
            Some(Duration::from_secs(30))
        );
        assert_eq!(tool_execution_timeout("git_diff"), None);
    }

    #[test]
    fn git_status_pages_are_bounded_and_bound_to_the_status_revision() {
        let build_status = || GitStatusDto {
            branch: "develop".to_string(),
            head_commit: None,
            staged_files: vec![GitFileStatus {
                path: "a.rs".to_string(),
                status: "modified".to_string(),
                old_path: None,
            }],
            unstaged_files: vec![GitFileStatus {
                path: "b.rs".to_string(),
                status: "modified".to_string(),
                old_path: None,
            }],
            untracked_files: vec![GitFileStatus {
                path: "c.rs".to_string(),
                status: "untracked".to_string(),
                old_path: None,
            }],
            conflicted_files: Vec::new(),
            merge_in_progress: false,
            is_clean: false,
            has_origin: true,
            has_upstream: true,
            ahead: 1,
            behind: 0,
        };

        let first: serde_json::Value = serde_json::from_str(
            &format_bounded_git_status(".", build_status(), &json!({ "limit": 2 }))
                .expect("first status page"),
        )
        .expect("first status JSON");
        assert_eq!(first["total_count"], 3);
        assert_eq!(first["truncated"], true);
        assert_eq!(first["staged_files"].as_array().unwrap().len(), 1);
        assert_eq!(first["unstaged_files"].as_array().unwrap().len(), 1);

        let second: serde_json::Value = serde_json::from_str(
            &format_bounded_git_status(
                ".",
                build_status(),
                &json!({ "limit": 2, "cursor": first["next_cursor"] }),
            )
            .expect("second status page"),
        )
        .expect("second status JSON");
        assert_eq!(second["offset"], 2);
        assert_eq!(second["untracked_files"].as_array().unwrap().len(), 1);
        assert_eq!(second["truncated"], false);

        let mut changed = build_status();
        changed.untracked_files.push(GitFileStatus {
            path: "d.rs".to_string(),
            status: "untracked".to_string(),
            old_path: None,
        });
        let stale = format_bounded_git_status(
            ".",
            changed,
            &json!({ "limit": 2, "cursor": first["next_cursor"] }),
        )
        .expect_err("changed status must invalidate the cursor");
        assert!(stale.message.contains("does not belong"));
    }

    #[test]
    fn exact_edit_requires_one_match_unless_replace_all_is_enabled() {
        assert_eq!(exact_edit_match_error("src/app.ts", 1, false), None);
        assert_eq!(exact_edit_match_error("src/app.ts", 2, true), None);
        assert_eq!(
            exact_edit_match_error("src/app.ts", 0, false),
            Some("No match found for old_text in src/app.ts.".to_string())
        );
        assert!(exact_edit_match_error("src/app.ts", 2, false)
            .expect("ambiguous match")
            .contains("old_text matched 2 locations"));
    }

    #[tokio::test]
    async fn db_pool_propagates_failure_without_polling() {
        let pool = DbPool::default();
        pool.set_failed("migration failed");

        let error = pool.wait_until_ready().await.expect_err("failed state");
        assert!(error.message.contains("migration failed"));
    }

    #[tokio::test]
    async fn db_pool_wakes_waiters_when_initialization_becomes_ready() {
        let pool = DbPool::default();
        let ready_pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("db pool");
        let state = pool.clone();
        let expected_pool = ready_pool.clone();
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            state.set_ready(ready_pool);
        });

        let resolved = pool.wait_until_ready().await.expect("ready state");
        assert_eq!(resolved.size(), expected_pool.size());
    }

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
    fn provider_definition_patch_initializes_a_sparse_provider_registry() {
        let document = json!({
            "$schema": "./schemas/v1/providers.schema.json",
            "schemaVersion": 1
        });
        let operations = provider_definition_patch_operations(
            &document,
            "opencode-go",
            Some(json!({
                "providerType": "openai",
                "name": "OpenCode Go",
                "enabled": true
            })),
        )
        .expect("provider definition patch");
        assert_eq!(operations.len(), 2);
        assert_eq!(operations[0].path, "/providers");
        assert_eq!(operations[1].path, "/providers/opencode-go");

        let patch: json_patch::Patch = serde_json::from_value(
            serde_json::to_value(&operations).expect("serialize provider patch"),
        )
        .expect("parse provider patch");
        let mut proposed = document;
        json_patch::patch(&mut proposed, &patch).expect("apply provider patch");
        assert_eq!(
            proposed
                .pointer("/providers/opencode-go/providerType")
                .and_then(Value::as_str),
            Some("openai")
        );
    }

    #[test]
    fn provider_definition_patch_removes_only_an_existing_definition() {
        let document = json!({
            "schemaVersion": 1,
            "providers": {
                "opencode-go": { "providerType": "openai" },
                "openai": { "providerType": "openai" }
            }
        });
        let operations = provider_definition_patch_operations(&document, "opencode-go", None)
            .expect("provider removal patch");
        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0].op, "remove");
        assert_eq!(operations[0].path, "/providers/opencode-go");

        let sparse = json!({ "schemaVersion": 1 });
        assert!(provider_definition_patch_operations(&sparse, "opencode-go", None).is_none());
    }

    #[test]
    fn provider_secret_compensation_restores_api_key_and_chatgpt_session() {
        let _guard = crate::secrets::lock_test_store();
        let temp = tempfile::tempdir().expect("tempdir");
        crate::secrets::init(temp.path()).expect("initialize secret store");
        let provider_id = format!("provider-{}", uuid::Uuid::new_v4());
        let chatgpt_secret = crate::secrets::ChatGptSecret {
            access_token: "access-token".to_string(),
            refresh_token: "refresh-token".to_string(),
            access_token_expires_at: Some("2026-08-22T12:00:00Z".to_string()),
            account_id: Some("account".to_string()),
            auth_source: "oauth".to_string(),
        };

        crate::secrets::set_api_key(&provider_id, "api-key").expect("set API key");
        crate::secrets::set_chatgpt_secret(&provider_id, &chatgpt_secret)
            .expect("set ChatGPT session");
        crate::secrets::delete_api_key(&provider_id).expect("delete API key");
        crate::secrets::delete_provider_secret(&provider_id).expect("delete ChatGPT session");

        restore_deleted_provider_secrets(&provider_id, Some("api-key"), Some(&chatgpt_secret));

        assert_eq!(
            crate::secrets::get_api_key(&provider_id)
                .expect("get restored API key")
                .as_deref(),
            Some("api-key")
        );
        assert_eq!(
            crate::secrets::get_chatgpt_secret(&provider_id).expect("get restored ChatGPT session"),
            Some(chatgpt_secret)
        );
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

    #[tokio::test]
    async fn execute_workspace_read_returns_a_resumable_bounded_page() {
        let workspace = TempDir::new().expect("workspace");
        fs::write(workspace.path().join("notes.txt"), "one\ntwo\nthree\nfour").expect("write file");

        let first = execute_readonly_workspace_tool(
            workspace.path(),
            "read",
            json!({ "path": "notes.txt", "max_lines": 2 }),
        )
        .await;
        assert!(first.contains("LINES: 1-2"));
        assert!(first.contains("TOTAL_LINES: 4"));
        assert!(first.contains("TRUNCATED: true"));
        let cursor = first
            .lines()
            .find_map(|line| line.strip_prefix("NEXT_CURSOR: "))
            .expect("next cursor");

        let second = execute_readonly_workspace_tool(
            workspace.path(),
            "read",
            json!({ "path": "notes.txt", "max_lines": 2, "cursor": cursor }),
        )
        .await;
        assert!(second.contains("LINES: 3-4"));
        assert!(second.contains("TRUNCATED: false"));
        assert!(second.contains("   3 | three"));

        fs::write(
            workspace.path().join("notes.txt"),
            "changed\ntwo\nthree\nfour",
        )
        .expect("change file after first page");
        let stale_cursor = execute_workspace_tool(
            workspace.path().to_path_buf(),
            workspace.path().to_path_buf(),
            GitState::new(),
            "Implement".to_string(),
            "read".to_string(),
            json!({ "path": "notes.txt", "max_lines": 2, "cursor": cursor }),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect_err("read cursor must be bound to the file revision");
        assert!(stale_cursor
            .message
            .contains("does not belong to this tool request"));
    }

    #[tokio::test]
    async fn execute_workspace_list_and_glob_return_sorted_pages() {
        let workspace = TempDir::new().expect("workspace");
        fs::write(workspace.path().join("b.ts"), "b").expect("write b");
        fs::write(workspace.path().join("a.ts"), "a").expect("write a");
        fs::write(workspace.path().join("c.txt"), "c").expect("write c");

        let list = execute_readonly_workspace_tool(
            workspace.path(),
            "list",
            json!({ "path": ".", "limit": 2 }),
        )
        .await;
        let list: serde_json::Value = serde_json::from_str(&list).expect("list json");
        assert_eq!(list["count"], 2);
        assert_eq!(list["total_count"], 3);
        assert_eq!(list["truncated"], true);
        assert_eq!(list["entries"][0]["relative_path"], "a.ts");
        assert!(list["next_cursor"].as_str().is_some());

        let glob = execute_readonly_workspace_tool(
            workspace.path(),
            "glob",
            json!({ "pattern": "*.ts", "limit": 1 }),
        )
        .await;
        let glob: serde_json::Value = serde_json::from_str(&glob).expect("glob json");
        assert_eq!(glob["paths"][0], "a.ts");
        assert_eq!(glob["total_count"], 2);
        assert_eq!(glob["truncated"], true);
    }

    #[tokio::test]
    async fn execute_workspace_grep_bounds_matches_and_reports_skipped_files() {
        let workspace = TempDir::new().expect("workspace");
        fs::write(
            workspace.path().join("a.txt"),
            format!("needle {}\n", "x".repeat(1_000)),
        )
        .expect("write match");
        fs::write(workspace.path().join("b.txt"), "needle second\n").expect("write match");
        fs::write(workspace.path().join("0-binary.bin"), b"needle\0binary").expect("write binary");
        fs::write(
            workspace.path().join("1-large.txt"),
            vec![b'x'; 4 * 1024 * 1024 + 1],
        )
        .expect("write oversized file");

        let grep = execute_readonly_workspace_tool(
            workspace.path(),
            "grep",
            json!({ "query": "needle", "limit": 1 }),
        )
        .await;
        let grep: serde_json::Value = serde_json::from_str(&grep).expect("grep json");
        assert_eq!(grep["count"], 1);
        assert_eq!(grep["truncated"], true);
        assert_eq!(grep["results"][0]["path"], "a.txt");
        assert_eq!(grep["results"][0]["text_truncated"], true);
        assert_eq!(grep["skipped_files"]["binary"], 1);
        assert_eq!(grep["skipped_files"]["too_large"], 1);
        assert!(grep["next_cursor"].as_str().is_some());
    }

    #[tokio::test]
    async fn execute_workspace_ast_grep_returns_structural_resumable_matches() {
        let workspace = TempDir::new().expect("workspace");
        fs::write(
            workspace.path().join("a.ts"),
            "console.log(first);\nconsole.log(second);\n",
        )
        .expect("write first source");
        fs::write(
            workspace.path().join("b.ts"),
            "const untouched = true;\nconsole.log(last);\n",
        )
        .expect("write second source");
        fs::write(workspace.path().join("notes.txt"), "console.log(notCode)")
            .expect("write unsupported source");

        let first = execute_readonly_workspace_tool(
            workspace.path(),
            "ast_grep",
            json!({
                "pattern": "console.log($ARG)",
                "include_meta": true,
                "limit": 2
            }),
        )
        .await;
        let first: serde_json::Value = serde_json::from_str(&first).expect("ast grep json");
        assert_eq!(first["count"], 2);
        assert_eq!(first["truncated"], true);
        assert_eq!(first["matches"][0]["path"], "a.ts");
        assert_eq!(first["matches"][0]["start_line"], 1);
        assert_eq!(first["matches"][1]["meta_variables"]["ARG"], "second");
        assert_eq!(first["skipped_files"]["unsupported_language"], 0);
        let cursor = first["next_cursor"].as_str().expect("ast next cursor");

        let mismatched_cursor = execute_workspace_tool(
            workspace.path().to_path_buf(),
            workspace.path().to_path_buf(),
            GitState::new(),
            "Implement".to_string(),
            "ast_grep".to_string(),
            json!({
                "pattern": "console.error($ARG)",
                "limit": 2,
                "cursor": cursor
            }),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect_err("ast cursor must be bound to the structural query");
        assert!(mismatched_cursor
            .message
            .contains("does not belong to this tool request"));

        let second = execute_readonly_workspace_tool(
            workspace.path(),
            "ast_grep",
            json!({
                "pattern": "console.log($ARG)",
                "include_meta": true,
                "limit": 2,
                "cursor": cursor
            }),
        )
        .await;
        let second: serde_json::Value = serde_json::from_str(&second).expect("ast page json");
        assert_eq!(second["count"], 1);
        assert_eq!(second["matches"][0]["path"], "b.ts");
        assert_eq!(second["matches"][0]["meta_variables"]["ARG"], "last");
        assert_eq!(second["truncated"], false);
        assert_eq!(second["total_count"], 3);
        assert_eq!(second["total_is_exact"], true);
        assert_eq!(second["skipped_files"]["unsupported_language"], 1);
    }

    #[tokio::test]
    async fn execute_workspace_tool_delete_returns_structured_deleted_file_response() {
        let workspace = TempDir::new().expect("workspace");
        fs::write(workspace.path().join("delete-me.txt"), "line 1\nline 2\n").expect("write file");

        let result = execute_workspace_tool(
            workspace.path().to_path_buf(),
            workspace.path().to_path_buf(),
            GitState::new(),
            "Implement".to_string(),
            "delete".to_string(),
            json!({ "path": "delete-me.txt" }),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect("execute delete");

        let parsed: serde_json::Value =
            serde_json::from_str(&result).expect("parse delete response");
        assert_eq!(
            parsed.get("ok").and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert_eq!(
            parsed
                .get("files")
                .and_then(serde_json::Value::as_array)
                .and_then(|files| files.first())
                .and_then(|file| file.get("status"))
                .and_then(serde_json::Value::as_str),
            Some("deleted")
        );
        assert_eq!(
            parsed
                .get("files")
                .and_then(serde_json::Value::as_array)
                .and_then(|files| files.first())
                .and_then(|file| file.get("validation"))
                .and_then(|validation| validation.get("exists"))
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
        assert!(!workspace.path().join("delete-me.txt").exists());
    }

    #[tokio::test]
    async fn execute_workspace_tool_edit_rejects_a_stale_revision() {
        let workspace = TempDir::new().expect("workspace");
        let path = workspace.path().join("guarded.txt");
        fs::write(&path, "value = 1\n").expect("seed guarded file");

        let error = execute_workspace_tool(
            workspace.path().to_path_buf(),
            workspace.path().to_path_buf(),
            GitState::new(),
            "Implement".to_string(),
            "edit".to_string(),
            json!({
                "path": "guarded.txt",
                "old_text": "value = 1",
                "new_text": "value = 2",
                "expected_revision": "stale-revision"
            }),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect_err("stale edit must fail");

        assert!(error.message.contains("Stale content"));
        assert_eq!(
            fs::read_to_string(path).expect("read guarded file"),
            "value = 1\n"
        );
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[tokio::test]
    async fn content_mutation_keys_fold_case_on_case_insensitive_desktop_platforms() {
        let workspace = TempDir::new().expect("workspace");
        let upper = super::native_content_mutation_key(&workspace.path().join("Guarded.txt")).await;
        let lower = super::native_content_mutation_key(&workspace.path().join("guarded.txt")).await;

        assert_eq!(upper, lower);
    }

    #[tokio::test]
    async fn concurrent_absent_revision_writes_allow_exactly_one_winner() {
        let workspace = TempDir::new().expect("workspace");
        let path = workspace.path().join("new.txt");
        let change = |content: &str| PendingFileChange {
            display_path: "new.txt".to_string(),
            effective_workspace: workspace.path().to_path_buf(),
            effective_path: "new.txt".to_string(),
            absolute_path: path.clone(),
            status: "created".to_string(),
            new_content: Some(content.to_string()),
            created: true,
            bytes_written: content.len() as u64,
            additions: 1,
            deletions: 0,
            expected_revision: Some("absent".to_string()),
        };
        let first = vec![change("first\n")];
        let second = vec![change("second\n")];

        let (first_result, second_result) = tokio::join!(
            commit_pending_file_changes_atomically(&first),
            commit_pending_file_changes_atomically(&second),
        );

        assert_eq!(
            usize::from(first_result.is_ok()) + usize::from(second_result.is_ok()),
            1
        );
        let failure = first_result.err().or_else(|| second_result.err()).unwrap();
        assert_eq!(failure.code(), Some("REVISION_CONFLICT"));
        let content = fs::read_to_string(path).expect("read winning content");
        assert!(content == "first\n" || content == "second\n");
    }

    #[tokio::test]
    async fn concurrent_matching_revision_writes_allow_exactly_one_winner() {
        let workspace = TempDir::new().expect("workspace");
        let path = workspace.path().join("shared.txt");
        fs::write(&path, "original\n").expect("seed shared file");
        let revision = content_revision(b"original\n");
        let change = |content: &str| PendingFileChange {
            display_path: "shared.txt".to_string(),
            effective_workspace: workspace.path().to_path_buf(),
            effective_path: "shared.txt".to_string(),
            absolute_path: path.clone(),
            status: "updated".to_string(),
            new_content: Some(content.to_string()),
            created: false,
            bytes_written: content.len() as u64,
            additions: 1,
            deletions: 1,
            expected_revision: Some(revision.clone()),
        };
        let first = vec![change("first\n")];
        let second = vec![change("second\n")];

        let (first_result, second_result) = tokio::join!(
            commit_pending_file_changes_atomically(&first),
            commit_pending_file_changes_atomically(&second),
        );

        assert_eq!(
            usize::from(first_result.is_ok()) + usize::from(second_result.is_ok()),
            1
        );
        let failure = first_result.err().or_else(|| second_result.err()).unwrap();
        assert_eq!(failure.code(), Some("REVISION_CONFLICT"));
        let content = fs::read_to_string(path).expect("read winning content");
        assert!(content == "first\n" || content == "second\n");
    }

    #[tokio::test]
    async fn commit_pending_file_changes_checks_all_revisions_before_writing() {
        let workspace = TempDir::new().expect("workspace");
        let first_path = workspace.path().join("first.txt");
        let second_path = workspace.path().join("second.txt");
        fs::write(&first_path, "first-original\n").expect("write first");
        fs::write(&second_path, "second-original\n").expect("write second");

        let changes = vec![
            PendingFileChange {
                display_path: "first.txt".to_string(),
                effective_workspace: workspace.path().to_path_buf(),
                effective_path: "first.txt".to_string(),
                absolute_path: first_path.clone(),
                status: "updated".to_string(),
                new_content: Some("first-updated\n".to_string()),
                created: false,
                bytes_written: 14,
                additions: 1,
                deletions: 1,
                expected_revision: Some(content_revision(b"first-original\n")),
            },
            PendingFileChange {
                display_path: "second.txt".to_string(),
                effective_workspace: workspace.path().to_path_buf(),
                effective_path: "second.txt".to_string(),
                absolute_path: second_path.clone(),
                status: "updated".to_string(),
                new_content: Some("second-updated\n".to_string()),
                created: false,
                bytes_written: 15,
                additions: 1,
                deletions: 1,
                expected_revision: Some("stale-revision".to_string()),
            },
        ];

        let error = commit_pending_file_changes_atomically(&changes)
            .await
            .expect_err("stale batch must fail before writing");

        assert!(error.message.contains("Stale content for 'second.txt'"));
        assert_eq!(
            fs::read_to_string(first_path).expect("read first"),
            "first-original\n"
        );
        assert_eq!(
            fs::read_to_string(second_path).expect("read second"),
            "second-original\n"
        );
    }

    #[tokio::test]
    async fn commit_pending_file_changes_rolls_back_a_late_revision_conflict() {
        let workspace = TempDir::new().expect("workspace");
        let path = workspace.path().join("shared.txt");
        fs::write(&path, "original\n").expect("write original");
        let original_revision = content_revision(b"original\n");
        let change = |content: &str| PendingFileChange {
            display_path: "shared.txt".to_string(),
            effective_workspace: workspace.path().to_path_buf(),
            effective_path: "shared.txt".to_string(),
            absolute_path: path.clone(),
            status: "updated".to_string(),
            new_content: Some(content.to_string()),
            created: false,
            bytes_written: content.len() as u64,
            additions: 1,
            deletions: 1,
            expected_revision: Some(original_revision.clone()),
        };

        let error = commit_pending_file_changes_atomically(&[
            change("first mutation\n"),
            change("second mutation\n"),
        ])
        .await
        .expect_err("the second mutation must observe the first revision change");

        assert!(error.message.contains("Stale content for 'shared.txt'"));
        assert_eq!(
            fs::read_to_string(path).expect("read rolled back file"),
            "original\n"
        );
    }

    #[tokio::test]
    async fn commit_pending_file_changes_rolls_back_first_write_when_later_operation_fails() {
        let workspace = TempDir::new().expect("workspace");
        let first_path = workspace.path().join("first.txt");
        let missing_delete_path = workspace.path().join("missing.txt");
        fs::write(&first_path, "original\n").expect("write original");

        let changes = vec![
            PendingFileChange {
                display_path: "first.txt".to_string(),
                effective_workspace: workspace.path().to_path_buf(),
                effective_path: "first.txt".to_string(),
                absolute_path: first_path.clone(),
                status: "updated".to_string(),
                new_content: Some("updated\n".to_string()),
                created: false,
                bytes_written: 8,
                additions: 1,
                deletions: 1,
                expected_revision: None,
            },
            PendingFileChange {
                display_path: "missing.txt".to_string(),
                effective_workspace: workspace.path().to_path_buf(),
                effective_path: "missing.txt".to_string(),
                absolute_path: missing_delete_path,
                status: "deleted".to_string(),
                new_content: None,
                created: false,
                bytes_written: 0,
                additions: 0,
                deletions: 0,
                expected_revision: None,
            },
        ];

        let error = commit_pending_file_changes_atomically(&changes)
            .await
            .expect_err("second operation should fail");

        assert!(error.message.contains("Failed to delete missing.txt"));
        assert_eq!(
            fs::read_to_string(first_path).expect("read restored file"),
            "original\n"
        );
    }

    #[tokio::test]
    async fn rollback_preserves_an_external_edit_after_macro_applied_its_write() {
        let workspace = TempDir::new().expect("workspace");
        let path = workspace.path().join("shared.txt");
        fs::write(&path, "macro mutation\n").expect("write Macro mutation");
        let change = PendingFileChange {
            display_path: "shared.txt".to_string(),
            effective_workspace: workspace.path().to_path_buf(),
            effective_path: "shared.txt".to_string(),
            absolute_path: path.clone(),
            status: "updated".to_string(),
            new_content: Some("macro mutation\n".to_string()),
            created: false,
            bytes_written: 15,
            additions: 1,
            deletions: 1,
            expected_revision: None,
        };
        let backups = vec![(path.clone(), Some(b"original\n".to_vec()))];

        fs::write(&path, "external edit\n").expect("simulate external edit");
        let errors = rollback_pending_file_changes(&backups, &[change]).await;

        assert!(errors
            .iter()
            .any(|error| error.contains("Rollback conflict for shared.txt")));
        assert_eq!(
            fs::read_to_string(path).expect("read preserved external edit"),
            "external edit\n"
        );
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
pub async fn db_compare_and_swap_app_setting(
    pool: State<'_, DbPool>,
    key: String,
    expected_value_json: Option<String>,
    value_json: String,
) -> CommandResult<CompareAndSwapAppSettingResult> {
    let pool = get_pool(&pool).await?;

    repository::compare_and_swap_app_setting(
        &pool,
        &key,
        expected_value_json.as_deref(),
        &value_json,
    )
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
