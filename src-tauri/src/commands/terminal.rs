use crate::commands::{command_error, CommandResult, DbPool};
use crate::core::process::background_tokio_command;
use crate::db::{models::TerminalTabRecord, repository};
use crate::git::GitState;
use crate::project_path::{join_wsl_path, parse_wsl_unc_path, wsl_unc_path, WslProjectPath};
use crate::workspace;
use crate::WorkspaceMetadataRoot;
use chrono::Utc;
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
#[cfg(unix)]
use std::{fs, os::unix::fs::PermissionsExt};
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncReadExt;
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

const DEFAULT_TERMINAL_COLS: u16 = 120;
const DEFAULT_TERMINAL_ROWS: u16 = 32;
const MAX_TERMINAL_SNAPSHOT_BYTES: usize = 1_000_000;
const DEFAULT_LEGACY_COMMAND_TIMEOUT_MS: u64 = 5 * 60 * 1_000;
const MAX_LEGACY_COMMAND_TIMEOUT_MS: u64 = 30 * 60 * 1_000;
#[cfg(not(windows))]
const LEGACY_COMMAND_KILL_GRACE_MS: u64 = 2_000;
#[cfg(not(windows))]
const LEGACY_COMMAND_KILL_POLL_MS: u64 = 25;
const LEGACY_COMMAND_DRAIN_TIMEOUT_MS: u64 = 2_000;
const MAX_LEGACY_COMMAND_OUTPUT_BYTES: usize = 1024 * 1024;
const LEGACY_COMMAND_OUTPUT_HEAD_BYTES: usize = 64 * 1024;
const INCOMPLETE_DRAIN_MARKER: &str =
    "\n[terminal output drain timed out; remaining output was discarded]\n";
const OUTPUT_FLUSH_DELAY_MS: u64 = 16;
const LIVE_TERMINAL_CLOSE_GRACE_MS: u64 = 200;
const DEFAULT_TERM: &str = "xterm-256color";
const DEFAULT_COLORTERM: &str = "truecolor";
const TERM_PROGRAM_NAME: &str = "Macro";
#[cfg(not(windows))]
const DEFAULT_UNIX_SHELL_FALLBACKS: [&str; 3] = ["/bin/zsh", "/bin/bash", "/bin/sh"];

#[derive(Clone, Default)]
pub struct TerminalSessionStore {
    legacy_sessions: Arc<Mutex<HashMap<String, LegacyTerminalSessionRecord>>>,
    live_tabs: Arc<Mutex<HashMap<String, LiveTerminalSession>>>,
}

impl TerminalSessionStore {
    pub(crate) async fn live_tab_ids(&self) -> Vec<String> {
        let live_tabs = self.live_tabs.lock().await;
        live_tabs.keys().cloned().collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalTabDto {
    pub id: String,
    pub kind: String,
    pub task_id: Option<String>,
    pub project_id: String,
    pub project_name: String,
    pub mount_name: String,
    pub workspace_path: String,
    pub cwd: String,
    pub title: String,
    pub status: String,
    pub snapshot: String,
    pub last_command: Option<String>,
    pub last_exit_code: Option<i32>,
    pub has_live_session: bool,
    pub is_restored: bool,
    pub output_sequence: u64,
    pub generation: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
struct TerminalOutputEvent {
    tab_id: String,
    data: String,
    snapshot: String,
    sequence: u64,
    generation: i64,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
struct TerminalClosedEvent {
    tab_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalSessionDto {
    pub id: String,
    pub project_id: String,
    pub project_name: String,
    pub mount_name: String,
    pub workspace_path: String,
    pub cwd: String,
    pub status: String,
    pub last_command: Option<String>,
    pub output: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub output_truncated: bool,
    pub updated_at: String,
}

struct LiveTerminalSession {
    child: Arc<StdMutex<Box<dyn portable_pty::Child + Send>>>,
    writer: Arc<StdMutex<Box<dyn Write + Send>>>,
    master: Arc<StdMutex<Box<dyn MasterPty + Send>>>,
    runtime: Arc<Mutex<LiveTerminalRuntime>>,
}

struct LiveTerminalRuntime {
    record: TerminalTabRecord,
    persistence_lock: Arc<Mutex<()>>,
    scan_buffer: String,
    pending_command: Option<PendingCommand>,
    pending_output: String,
    output_flush_scheduled: bool,
    shell_kind: ManagedShellKind,
    mode: LiveTerminalMode,
    output_sequence: u64,
}

struct PendingCommand {
    marker_prefix: String,
    echoed_command: Option<String>,
    visible_command: String,
    completion_tx: Option<oneshot::Sender<i32>>,
}

struct CommandDispatchRollback {
    record: TerminalTabRecord,
    pending_output: String,
    output_flush_scheduled: bool,
    output_sequence: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ManagedShellKind {
    Posix,
    #[cfg_attr(windows, allow(dead_code))]
    Fish,
    #[cfg_attr(not(windows), allow(dead_code))]
    PowerShell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LiveTerminalMode {
    InteractiveShell,
    CommandProcess,
}

#[cfg(not(windows))]
#[derive(Debug, Clone, PartialEq, Eq)]
enum UnixShellKind {
    Bash,
    Zsh,
    Fish,
    Posix,
    Other,
}

#[cfg(not(windows))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct UnixShellSpec {
    path: String,
    kind: UnixShellKind,
}

#[cfg(not(windows))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct UnixShellLaunchConfig {
    args: Vec<String>,
    env: Vec<(&'static str, String)>,
}

struct LegacyTerminalSessionRecord {
    id: String,
    project_id: String,
    project_name: String,
    mount_name: String,
    workspace_path: PathBuf,
    cwd: PathBuf,
    status: String,
    last_command: Option<String>,
    output: String,
    exit_code: Option<i32>,
    timed_out: bool,
    output_truncated: bool,
    updated_at: String,
    pid: Option<u32>,
    run_in_progress: bool,
    kill_requested: bool,
    active_execution_id: Option<String>,
    pending_kill_execution_id: Option<String>,
    execution_generation: u64,
    #[cfg(windows)]
    windows_job: Option<Arc<WindowsJob>>,
}

#[cfg(windows)]
struct WindowsJob {
    handle: HANDLE,
}

#[cfg(windows)]
unsafe impl Send for WindowsJob {}
#[cfg(windows)]
unsafe impl Sync for WindowsJob {}

#[cfg(windows)]
impl WindowsJob {
    fn assign(child: &tokio::process::Child) -> CommandResult<Arc<Self>> {
        let process_handle = child
            .raw_handle()
            .ok_or_else(|| command_error("Windows child process handle is unavailable"))?
            as HANDLE;
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(command_error(format!(
                "Failed to create Windows Job Object: {}",
                std::io::Error::last_os_error()
            )));
        }

        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            unsafe { CloseHandle(handle) };
            return Err(command_error(format!(
                "Failed to configure Windows Job Object: {}",
                std::io::Error::last_os_error()
            )));
        }

        if unsafe { AssignProcessToJobObject(handle, process_handle) } == 0 {
            unsafe { CloseHandle(handle) };
            return Err(command_error(format!(
                "Failed to assign the command process to its Windows Job Object: {}",
                std::io::Error::last_os_error()
            )));
        }

        Ok(Arc::new(Self { handle }))
    }

    fn terminate(&self) -> CommandResult<()> {
        if unsafe { TerminateJobObject(self.handle, 1) } == 0 {
            return Err(command_error(format!(
                "Failed to terminate Windows Job Object: {}",
                std::io::Error::last_os_error()
            )));
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

struct ProjectTerminalTarget {
    project_name: String,
    mount_name: String,
    workspace_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TerminalPromptContext {
    pub project_label: Option<String>,
    pub task_label: Option<String>,
    pub branch_label: Option<String>,
}

impl LegacyTerminalSessionRecord {
    fn to_dto(&self) -> TerminalSessionDto {
        TerminalSessionDto {
            id: self.id.clone(),
            project_id: self.project_id.clone(),
            project_name: self.project_name.clone(),
            mount_name: self.mount_name.clone(),
            workspace_path: self.workspace_path.to_string_lossy().to_string(),
            cwd: self.cwd.to_string_lossy().to_string(),
            status: self.status.clone(),
            last_command: self.last_command.clone(),
            output: self.output.clone(),
            exit_code: self.exit_code,
            timed_out: self.timed_out,
            output_truncated: self.output_truncated,
            updated_at: self.updated_at.clone(),
        }
    }
}

fn current_timestamp() -> String {
    Utc::now().to_rfc3339()
}

fn touch_terminal_tab_record(record: &mut TerminalTabRecord) {
    record.generation = record.generation.saturating_add(1);
    record.updated_at = current_timestamp();
}

fn trim_snapshot_to_limit(value: &str) -> String {
    if value.len() <= MAX_TERMINAL_SNAPSHOT_BYTES {
        return value.to_string();
    }

    let start = value.len() - MAX_TERMINAL_SNAPSHOT_BYTES;
    if value.is_char_boundary(start) {
        value[start..].to_string()
    } else {
        let adjusted = value
            .char_indices()
            .find_map(|(index, _)| (index >= start).then_some(index))
            .unwrap_or(value.len());
        value[adjusted..].to_string()
    }
}

fn append_snapshot(existing: &mut String, chunk: &str) {
    existing.push_str(chunk);
    if existing.len() > MAX_TERMINAL_SNAPSHOT_BYTES {
        *existing = trim_snapshot_to_limit(existing);
    }
}

fn terminal_tab_to_dto(
    record: &TerminalTabRecord,
    has_live_session: bool,
    output_sequence: u64,
) -> TerminalTabDto {
    TerminalTabDto {
        id: record.id.clone(),
        kind: record.kind.clone(),
        task_id: record.task_id.clone(),
        project_id: record.project_id.clone(),
        project_name: record.project_name.clone(),
        mount_name: record.mount_name.clone(),
        workspace_path: record.workspace_path.clone(),
        cwd: record.cwd.clone(),
        title: record.title.clone(),
        status: if has_live_session {
            record.status.clone()
        } else {
            "restored-disconnected".to_string()
        },
        snapshot: record.snapshot.clone(),
        last_command: record.last_command.clone(),
        last_exit_code: record.last_exit_code,
        has_live_session,
        is_restored: !has_live_session,
        output_sequence,
        generation: record.generation,
        created_at: record.created_at.clone(),
        updated_at: record.updated_at.clone(),
    }
}

fn stored_tab_to_dto(record: &TerminalTabRecord, has_live_session: bool) -> TerminalTabDto {
    terminal_tab_to_dto(record, has_live_session, 0)
}

async fn load_db_pool(pool: &State<'_, DbPool>) -> CommandResult<sqlx::SqlitePool> {
    crate::commands::get_pool(pool).await
}

async fn resolve_metadata_root(
    workspace_path: PathBuf,
    git_state: GitState,
) -> CommandResult<PathBuf> {
    if parse_wsl_unc_path(&workspace_path.to_string_lossy()).is_some() {
        return Err(command_error(
            "Macro metadata-scoped terminals are not yet available for WSL projects.",
        ));
    }

    let workspace_path_for_fallback = workspace_path.clone();
    let resolved =
        tokio::task::spawn_blocking(move || git_state.resolve_macro_metadata_root(&workspace_path))
            .await
            .map_err(|error| command_error(format!("Metadata root task failed: {}", error)))?;

    match resolved {
        Ok(metadata_root) => Ok(metadata_root),
        Err(crate::core::error::BackendError::GitRepositoryNotFound { message }) => {
            let fallback = workspace_path_for_fallback.join(".macro");
            tracing::warn!(
                action = "terminal_metadata_root_fallback",
                workspace_path = %workspace_path_for_fallback.display(),
                fallback_path = %fallback.display(),
                reason = %message
            );
            Ok(fallback)
        }
        Err(error) => Err(command_error(error.to_string())),
    }
}

fn resolve_project_path(workspace_path: &Path, project_path: &str) -> PathBuf {
    let candidate = PathBuf::from(project_path);
    if candidate.is_absolute() {
        candidate
    } else {
        workspace_path.join(candidate)
    }
}

fn canonicalize_existing_dir(path: &Path) -> CommandResult<PathBuf> {
    let canonical = path
        .canonicalize()
        .map_err(|_| command_error(format!("Path not found: {}", path.display())))?;

    if !canonical.is_dir() {
        return Err(command_error(format!(
            "Path must be a directory: {}",
            canonical.display()
        )));
    }

    Ok(canonical)
}

async fn resolve_project_target(
    workspace_path: &Path,
    metadata_root: &Path,
    project_id: &str,
) -> CommandResult<ProjectTerminalTarget> {
    let project = workspace::get_project_by_id(workspace_path, metadata_root, project_id)
        .await
        .map_err(|error| command_error(error.to_string()))?
        .ok_or_else(|| command_error(format!("Unknown project id: {}", project_id)))?;

    if project.is_read_only {
        return Err(command_error(format!(
            "Project \"{}\" is read-only. Terminal sessions are unavailable.",
            project.name
        )));
    }

    let workspace_path = if let Some(wsl_path) = parse_wsl_unc_path(&project.path) {
        PathBuf::from(wsl_path.unc_path)
    } else {
        canonicalize_existing_dir(&resolve_project_path(workspace_path, &project.path))?
    };

    Ok(ProjectTerminalTarget {
        project_name: project.name,
        mount_name: project.mount_name,
        workspace_path,
    })
}

fn is_within(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}

fn linux_path_is_same_or_child(root: &str, candidate: &str) -> bool {
    let root = root.trim_end_matches('/');
    candidate == root
        || candidate
            .strip_prefix(root)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn resolve_wsl_session_cwd(
    project_root: &WslProjectPath,
    cwd: Option<&str>,
) -> CommandResult<PathBuf> {
    let Some(raw_cwd) = cwd.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(PathBuf::from(project_root.unc_path.clone()));
    };

    if let Some(requested_wsl_path) = parse_wsl_unc_path(raw_cwd) {
        if requested_wsl_path.distro != project_root.distro {
            return Err(command_error(format!(
                "cwd WSL must remain in distribution {}: {}",
                project_root.distro, raw_cwd
            )));
        }
        return Ok(PathBuf::from(requested_wsl_path.unc_path));
    }

    if raw_cwd.replace('\\', "/").starts_with('/') {
        let unc_path = wsl_unc_path(&project_root.distro, raw_cwd);
        return Ok(PathBuf::from(unc_path));
    }

    let joined =
        join_wsl_path(project_root, raw_cwd).map_err(|error| command_error(error.to_string()))?;
    if !linux_path_is_same_or_child(&project_root.linux_path, &joined.linux_path) {
        return Err(command_error(format!(
            "cwd must remain inside the selected WSL project: {}",
            raw_cwd
        )));
    }

    Ok(PathBuf::from(joined.unc_path))
}

fn resolve_session_cwd(
    project_root: &Path,
    cwd: Option<&str>,
    git_state: &GitState,
) -> CommandResult<PathBuf> {
    let project_root_string = project_root.to_string_lossy();
    if let Some(wsl_project_root) = parse_wsl_unc_path(&project_root_string) {
        return resolve_wsl_session_cwd(&wsl_project_root, cwd);
    }

    let canonical_project_root = canonicalize_existing_dir(project_root)?;
    let Some(raw_cwd) = cwd.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(canonical_project_root);
    };

    let requested = PathBuf::from(raw_cwd);
    let is_absolute = requested.is_absolute();
    let candidate = if is_absolute {
        requested
    } else {
        canonical_project_root.join(requested)
    };
    let canonical_candidate = canonicalize_existing_dir(&candidate)?;

    if is_within(&canonical_project_root, &canonical_candidate) {
        return Ok(canonical_candidate);
    }

    if is_absolute && git_state.open_repo(&canonical_candidate).is_ok() {
        return Ok(canonical_candidate);
    }

    Err(command_error(format!(
        "cwd must remain inside the selected project or a valid worktree: {}",
        canonical_candidate.display()
    )))
}

fn build_terminal_record(
    kind: &str,
    project_id: String,
    task_id: Option<String>,
    title: String,
    prompt_context: Option<TerminalPromptContext>,
    project: ProjectTerminalTarget,
    cwd: PathBuf,
) -> TerminalTabRecord {
    let now = current_timestamp();
    TerminalTabRecord {
        id: format!("terminal-tab-{}", Uuid::new_v4()),
        kind: kind.to_string(),
        task_id,
        project_id,
        project_name: project.project_name,
        mount_name: project.mount_name,
        workspace_path: project.workspace_path.to_string_lossy().to_string(),
        cwd: cwd.to_string_lossy().to_string(),
        title,
        prompt_context_json: prompt_context.and_then(|value| serde_json::to_string(&value).ok()),
        status: "idle".to_string(),
        snapshot: String::new(),
        last_command: None,
        last_exit_code: None,
        generation: 0,
        created_at: now.clone(),
        updated_at: now,
    }
}

fn marker_in_progress_start(buffer: &str, marker_prefix: &str) -> Option<usize> {
    if let Some(start) = buffer.rfind(marker_prefix) {
        let suffix = &buffer[start + marker_prefix.len()..];
        if suffix.is_empty()
            || suffix.chars().all(|character| character.is_ascii_digit())
            || "__".starts_with(suffix)
        {
            return Some(start);
        }
    }

    let max_suffix_len = buffer.len().min(marker_prefix.len().saturating_sub(1));
    for suffix_len in (1..=max_suffix_len).rev() {
        let suffix_start = buffer.len() - suffix_len;
        if buffer.is_char_boundary(suffix_start)
            && marker_prefix.starts_with(&buffer[suffix_start..])
        {
            return Some(suffix_start);
        }
    }

    None
}

fn parse_command_marker(buffer: &str, marker_prefix: &str) -> Option<(usize, usize, i32)> {
    let mut search_start = 0;
    while let Some(relative_start) = buffer[search_start..].find(marker_prefix) {
        let start = search_start + relative_start;
        let after_start = start + marker_prefix.len();
        let suffix = &buffer[after_start..];
        let Some(end_rel) = suffix.find("__") else {
            return None;
        };

        if let Ok(exit_code) = suffix[..end_rel].parse::<i32>() {
            let end = after_start + end_rel + 2;
            return Some((start, end, exit_code));
        }

        search_start = after_start;
    }

    None
}

fn command_echo_variants(command: &str) -> Vec<String> {
    let crlf_command = command.replace('\n', "\r\n");
    if crlf_command == command {
        vec![command.to_string()]
    } else {
        vec![command.to_string(), crlf_command]
    }
}

enum PendingEchoStrip {
    Incomplete,
    Ready(String),
}

fn strip_pending_command_echo(buffer: &str, echoed_command: &str) -> PendingEchoStrip {
    let variants = command_echo_variants(echoed_command);
    for variant in &variants {
        if buffer.starts_with(variant) {
            return PendingEchoStrip::Ready(buffer[variant.len()..].to_string());
        }

        if let Some(index) = buffer.find(variant) {
            if index <= 32 {
                return PendingEchoStrip::Ready(buffer[index + variant.len()..].to_string());
            }
        }
    }

    if variants.iter().any(|variant| variant.starts_with(buffer)) {
        return PendingEchoStrip::Incomplete;
    }

    PendingEchoStrip::Ready(buffer.to_string())
}

struct PendingOutputExtraction {
    visible_output: String,
    scan_buffer: String,
    completed_exit_code: Option<i32>,
}

fn extract_pending_visible_output(
    scan_buffer: &str,
    chunk: &str,
    pending: &mut PendingCommand,
) -> PendingOutputExtraction {
    debug_assert!(!pending.visible_command.trim().is_empty());
    let mut combined = format!("{}{}", scan_buffer, chunk);

    if let Some(echoed_command) = pending.echoed_command.as_deref() {
        match strip_pending_command_echo(&combined, echoed_command) {
            PendingEchoStrip::Incomplete => {
                return PendingOutputExtraction {
                    visible_output: String::new(),
                    scan_buffer: combined,
                    completed_exit_code: None,
                };
            }
            PendingEchoStrip::Ready(stripped) => {
                pending.echoed_command = None;
                combined = stripped;
            }
        }
    }

    if let Some((start, end, exit_code)) = parse_command_marker(&combined, &pending.marker_prefix) {
        let mut visible_output = String::new();
        visible_output.push_str(&combined[..start]);
        visible_output.push_str(&combined[end..]);
        return PendingOutputExtraction {
            visible_output,
            scan_buffer: String::new(),
            completed_exit_code: Some(exit_code),
        };
    }

    let split_at =
        marker_in_progress_start(&combined, &pending.marker_prefix).unwrap_or(combined.len());
    PendingOutputExtraction {
        visible_output: combined[..split_at].to_string(),
        scan_buffer: combined[split_at..].to_string(),
        completed_exit_code: None,
    }
}

fn terminal_env_value_from<F>(name: &str, fallback: &str, read_env: &F) -> String
where
    F: Fn(&str) -> Option<String>,
{
    read_env(name)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn build_terminal_environment_from<F>(
    cwd: &str,
    shell: Option<&str>,
    read_env: F,
) -> Vec<(&'static str, String)>
where
    F: Fn(&str) -> Option<String>,
{
    let mut env = vec![
        (
            "TERM",
            terminal_env_value_from("TERM", DEFAULT_TERM, &read_env),
        ),
        (
            "COLORTERM",
            terminal_env_value_from("COLORTERM", DEFAULT_COLORTERM, &read_env),
        ),
        (
            "TERM_PROGRAM",
            terminal_env_value_from("TERM_PROGRAM", TERM_PROGRAM_NAME, &read_env),
        ),
        ("PWD", cwd.to_string()),
    ];

    if let Some(shell) = shell.filter(|value| !value.trim().is_empty()) {
        env.push(("SHELL", shell.to_string()));
    }

    env
}

fn build_terminal_environment(cwd: &str, shell: Option<&str>) -> Vec<(&'static str, String)> {
    build_terminal_environment_from(cwd, shell, |key| std::env::var(key).ok())
}

fn apply_terminal_environment(command: &mut CommandBuilder, cwd: &str, shell: Option<&str>) {
    for (name, value) in build_terminal_environment(cwd, shell) {
        command.env(name, value);
    }
}

#[cfg(not(windows))]
fn shell_basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
        .to_ascii_lowercase()
}

#[cfg(not(windows))]
fn classify_unix_shell(path: &str) -> UnixShellKind {
    match shell_basename(path).as_str() {
        "bash" => UnixShellKind::Bash,
        "zsh" => UnixShellKind::Zsh,
        "fish" => UnixShellKind::Fish,
        "sh" | "dash" | "ksh" | "mksh" => UnixShellKind::Posix,
        _ => UnixShellKind::Other,
    }
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };

    metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(windows))]
fn is_valid_shell_path_with<F>(path: &str, is_executable: &F) -> bool
where
    F: Fn(&Path) -> bool + ?Sized,
{
    let shell_path = Path::new(path.trim());
    shell_path.is_absolute() && is_executable(shell_path)
}

#[cfg(not(windows))]
fn parse_passwd_shell(passwd_contents: &str, username: &str) -> Option<String> {
    if username.trim().is_empty() {
        return None;
    }

    passwd_contents.lines().find_map(|line| {
        let mut fields = line.split(':');
        let user = fields.next()?;
        if user != username {
            return None;
        }
        fields.nth(5).map(str::trim).and_then(|shell| {
            if shell.is_empty() {
                None
            } else {
                Some(shell.to_string())
            }
        })
    })
}

#[cfg(not(windows))]
fn unix_shell_spec(path: &str) -> UnixShellSpec {
    UnixShellSpec {
        path: path.to_string(),
        kind: classify_unix_shell(path),
    }
}

#[cfg(not(windows))]
fn first_valid_shell<'a, I>(candidates: I, is_executable: &dyn Fn(&Path) -> bool) -> Option<String>
where
    I: IntoIterator<Item = &'a str>,
{
    candidates
        .into_iter()
        .find(|candidate| is_valid_shell_path_with(candidate, &is_executable))
        .map(str::to_string)
}

#[cfg(not(windows))]
fn resolve_unix_shell_from<F, P>(
    read_env: F,
    read_passwd: P,
    is_executable: &dyn Fn(&Path) -> bool,
) -> UnixShellSpec
where
    F: Fn(&str) -> Option<String>,
    P: Fn() -> Option<String>,
{
    let env_shell = read_env("SHELL").unwrap_or_default();
    if let Some(path) = first_valid_shell([env_shell.as_str()], is_executable) {
        return unix_shell_spec(&path);
    }

    let username = read_env("USER")
        .or_else(|| read_env("LOGNAME"))
        .unwrap_or_default();
    let passwd_shell = read_passwd().and_then(|contents| parse_passwd_shell(&contents, &username));
    if let Some(path) = first_valid_shell(passwd_shell.as_deref(), is_executable) {
        return unix_shell_spec(&path);
    }

    if let Some(path) = first_valid_shell(DEFAULT_UNIX_SHELL_FALLBACKS, is_executable) {
        return unix_shell_spec(&path);
    }

    unix_shell_spec("sh")
}

#[cfg(not(windows))]
fn resolve_unix_shell() -> UnixShellSpec {
    resolve_unix_shell_from(
        |key| std::env::var(key).ok(),
        || fs::read_to_string("/etc/passwd").ok(),
        &is_executable_file,
    )
}

#[cfg(not(windows))]
fn fish_double_quote_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '$' => escaped.push_str("\\$"),
            '`' => escaped.push_str("\\`"),
            _ => escaped.push(character),
        }
    }
    escaped
}

#[cfg(not(windows))]
fn shell_args(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| (*arg).to_string()).collect()
}

#[cfg(not(windows))]
fn shell_env(entries: &[(&'static str, &str)]) -> Vec<(&'static str, String)> {
    entries
        .iter()
        .map(|(name, value)| (*name, (*value).to_string()))
        .collect()
}

#[cfg(not(windows))]
fn build_unix_shell_launch_config(shell: &UnixShellSpec, prompt: &str) -> UnixShellLaunchConfig {
    match shell.kind {
        UnixShellKind::Bash => UnixShellLaunchConfig {
            args: shell_args(&["--noprofile", "--norc", "-i"]),
            env: shell_env(&[
                ("PS1", prompt),
                ("PROMPT_COMMAND", ""),
                ("BASH_SILENCE_DEPRECATION_WARNING", "1"),
            ]),
        },
        UnixShellKind::Zsh => UnixShellLaunchConfig {
            args: shell_args(&["-f", "-i"]),
            env: shell_env(&[("PS1", prompt), ("PROMPT", prompt)]),
        },
        UnixShellKind::Fish => UnixShellLaunchConfig {
            args: vec![
                "-i".to_string(),
                "-C".to_string(),
                format!(
                    "function fish_prompt; printf \"%s\" \"{}\"; end",
                    fish_double_quote_escape(prompt)
                ),
            ],
            env: Vec::new(),
        },
        UnixShellKind::Posix | UnixShellKind::Other => UnixShellLaunchConfig {
            args: shell_args(&["-i"]),
            env: shell_env(&[("PS1", prompt)]),
        },
    }
}

#[cfg(not(windows))]
fn apply_unix_shell_args_and_prompt(
    command: &mut CommandBuilder,
    shell: &UnixShellSpec,
    prompt: &str,
) {
    let launch_config = build_unix_shell_launch_config(shell, prompt);
    for arg in launch_config.args {
        command.arg(arg);
    }
    for (name, value) in launch_config.env {
        command.env(name, value);
    }
}

#[cfg(windows)]
fn build_shell_command(record: &TerminalTabRecord) -> (CommandBuilder, ManagedShellKind) {
    if let Some(wsl_path) = parse_wsl_unc_path(&record.cwd) {
        let mut command = CommandBuilder::new("wsl.exe");
        command.arg("-d");
        command.arg(wsl_path.distro);
        command.arg("--cd");
        command.arg(wsl_path.linux_path);
        command.arg("--");
        command.arg("/bin/sh");
        command.arg("-lc");
        command.arg("if [ -x /bin/bash ]; then exec /bin/bash -i; else exec /bin/sh -i; fi");
        command.env("TERM", DEFAULT_TERM);
        command.env("COLORTERM", DEFAULT_COLORTERM);
        command.env("TERM_PROGRAM", TERM_PROGRAM_NAME);
        command.env("MACRO_TERMINAL_CWD", &record.cwd);
        return (command, ManagedShellKind::Posix);
    }

    let mut command = CommandBuilder::new("powershell");
    command.arg("-NoLogo");
    command.arg("-NoProfile");
    command.arg("-NoExit");
    command.arg("-Command");
    command.arg(
        "function global:prompt { $env:MACRO_TERMINAL_PROMPT }; Set-Location -LiteralPath $env:MACRO_TERMINAL_CWD",
    );
    command.cwd(Path::new(&record.cwd));
    apply_terminal_environment(&mut command, &record.cwd, None);
    command.env("MACRO_TERMINAL_CWD", &record.cwd);
    command.env("MACRO_TERMINAL_PROMPT", render_terminal_prompt(record));
    (command, ManagedShellKind::PowerShell)
}

#[cfg(not(windows))]
fn managed_shell_kind_from_unix(shell: &UnixShellSpec) -> ManagedShellKind {
    match shell.kind {
        UnixShellKind::Fish => ManagedShellKind::Fish,
        UnixShellKind::Bash | UnixShellKind::Zsh | UnixShellKind::Posix | UnixShellKind::Other => {
            ManagedShellKind::Posix
        }
    }
}

#[cfg(not(windows))]
fn build_shell_command(record: &TerminalTabRecord) -> (CommandBuilder, ManagedShellKind) {
    let shell = resolve_unix_shell();
    let mut command = CommandBuilder::new(&shell.path);
    command.cwd(Path::new(&record.cwd));
    apply_terminal_environment(&mut command, &record.cwd, Some(&shell.path));
    apply_unix_shell_args_and_prompt(&mut command, &shell, &render_terminal_prompt(record));
    let shell_kind = managed_shell_kind_from_unix(&shell);
    (command, shell_kind)
}

#[cfg(windows)]
fn powershell_double_quote_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '`' => escaped.push_str("``"),
            '"' => escaped.push_str("`\""),
            '$' => escaped.push_str("`$"),
            '\r' => escaped.push_str("`r"),
            '\n' => escaped.push_str("`n"),
            _ => escaped.push(character),
        }
    }
    escaped
}

#[cfg(windows)]
fn build_managed_command(
    command: &str,
    marker_prefix: &str,
    shell_kind: ManagedShellKind,
) -> String {
    match shell_kind {
        ManagedShellKind::Posix => {
            let command_literal = shell_printf_b_literal(command);
            let marker_literal = shell_single_quote(marker_prefix);
            format!(
                "eval \"$(printf '%b' {})\"; __m=$?; printf '%s%s__\\n' {} \"$__m\"\n",
                command_literal, marker_literal
            )
        }
        ManagedShellKind::Fish => {
            let command_literal = shell_printf_b_literal(command);
            let marker_literal = shell_single_quote(marker_prefix);
            format!(
                "eval (printf '%b' {}); set __m $status; printf '%s%s__\\n' {} $__m\n",
                command_literal, marker_literal
            )
        }
        ManagedShellKind::PowerShell => format!(
            "Invoke-Expression \"{}\"; $__m = if ($LASTEXITCODE -ne $null) {{ [int]$LASTEXITCODE }} elseif ($?) {{ 0 }} else {{ 1 }}; Write-Output (\"{}\" + $__m + \"__\")\r\n",
            powershell_double_quote_escape(command),
            powershell_double_quote_escape(marker_prefix)
        ),
    }
}

#[cfg(windows)]
fn build_command_process(record: &TerminalTabRecord, command_text: &str) -> CommandBuilder {
    if let Some(wsl_path) = parse_wsl_unc_path(&record.cwd) {
        let mut command = CommandBuilder::new("wsl.exe");
        command.arg("-d");
        command.arg(wsl_path.distro);
        command.arg("--cd");
        command.arg(wsl_path.linux_path);
        command.arg("--");
        command.arg("/bin/sh");
        command.arg("-lc");
        command.arg(command_text);
        command.env("TERM", DEFAULT_TERM);
        command.env("COLORTERM", DEFAULT_COLORTERM);
        command.env("TERM_PROGRAM", TERM_PROGRAM_NAME);
        return command;
    }

    let mut command = CommandBuilder::new("powershell");
    command.arg("-NoLogo");
    command.arg("-NoProfile");
    command.arg("-Command");
    command.arg(command_text);
    command.cwd(Path::new(&record.cwd));
    apply_terminal_environment(&mut command, &record.cwd, None);
    command
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn shell_printf_b_literal(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => {}
            _ => escaped.push(character),
        }
    }
    shell_single_quote(&escaped)
}

#[cfg(not(windows))]
fn build_managed_command(
    command: &str,
    marker_prefix: &str,
    shell_kind: ManagedShellKind,
) -> String {
    let command_literal = shell_printf_b_literal(command);
    let marker_literal = shell_single_quote(marker_prefix);

    match shell_kind {
        ManagedShellKind::Fish => format!(
            "eval (printf '%b' {}); set __m $status; printf '%s%s__\\n' {} $__m\n",
            command_literal, marker_literal
        ),
        ManagedShellKind::Posix | ManagedShellKind::PowerShell => format!(
            "eval \"$(printf '%b' {})\"; __m=$?; printf '%s%s__\\n' {} \"$__m\"\n",
            command_literal, marker_literal
        ),
    }
}

#[cfg(not(windows))]
fn build_command_process(record: &TerminalTabRecord, command_text: &str) -> CommandBuilder {
    let shell = resolve_unix_shell();
    let mut command = CommandBuilder::new(&shell.path);
    match shell.kind {
        UnixShellKind::Bash | UnixShellKind::Zsh => {
            command.arg("-lc");
            command.arg(command_text);
        }
        UnixShellKind::Fish | UnixShellKind::Posix | UnixShellKind::Other => {
            command.arg("-c");
            command.arg(command_text);
        }
    }
    command.cwd(Path::new(&record.cwd));
    apply_terminal_environment(&mut command, &record.cwd, Some(&shell.path));
    command
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn trim_prompt_label(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn terminal_prompt_context_from_record(
    record: &TerminalTabRecord,
) -> Option<TerminalPromptContext> {
    if let Some(serialized) = record.prompt_context_json.as_deref() {
        if let Ok(context) = serde_json::from_str::<TerminalPromptContext>(serialized) {
            return Some(context);
        }
    }

    let project_label =
        trim_prompt_label(&record.mount_name).or_else(|| trim_prompt_label(&record.project_name));
    let task_label = record.task_id.as_deref().and_then(trim_prompt_label);

    if project_label.is_none() && task_label.is_none() {
        None
    } else {
        Some(TerminalPromptContext {
            project_label,
            task_label,
            branch_label: None,
        })
    }
}

fn render_terminal_prompt(record: &TerminalTabRecord) -> String {
    let Some(context) = terminal_prompt_context_from_record(record) else {
        return "> ".to_string();
    };

    let segments = [
        context.project_label.as_deref(),
        context.task_label.as_deref(),
    ]
    .into_iter()
    .flatten()
    .filter_map(trim_prompt_label)
    .collect::<Vec<_>>();

    if segments.is_empty() {
        "> ".to_string()
    } else {
        format!("{} > ", segments.join(" | "))
    }
}

async fn apply_live_tab_metadata_update(
    app_handle: &AppHandle,
    db_pool: DbPool,
    terminal_store: &State<'_, TerminalSessionStore>,
    tab_id: &str,
    title: String,
    prompt_context: Option<TerminalPromptContext>,
) -> CommandResult<Option<TerminalTabDto>> {
    let live_runtime = {
        let live_tabs = terminal_store.live_tabs.lock().await;
        live_tabs.get(tab_id).map(|session| session.runtime.clone())
    };

    let Some(runtime) = live_runtime else {
        return Ok(None);
    };

    let (dto, record_to_persist) = {
        let mut runtime_guard = runtime.lock().await;
        runtime_guard.record.title = title;
        runtime_guard.record.prompt_context_json =
            prompt_context.and_then(|value| serde_json::to_string(&value).ok());
        touch_terminal_tab_record(&mut runtime_guard.record);
        let dto = stored_tab_to_dto(&runtime_guard.record, true);
        (dto, runtime_guard.record.clone())
    };

    persist_live_tab_record(db_pool, runtime).await?;
    emit_tab_update(app_handle, &record_to_persist, true);

    Ok(Some(dto))
}

async fn persist_terminal_tab_record(
    db_pool: DbPool,
    record: TerminalTabRecord,
) -> CommandResult<()> {
    let pool = db_pool
        .ready_pool()
        .ok_or_else(|| command_error("Terminal database is unavailable"))?;
    repository::upsert_terminal_tab(&pool, &record)
        .await
        .map_err(|error| command_error(error.to_string()))?;
    Ok(())
}

async fn persist_live_tab_record(
    db_pool: DbPool,
    runtime: Arc<Mutex<LiveTerminalRuntime>>,
) -> CommandResult<()> {
    let persistence_lock = { runtime.lock().await.persistence_lock.clone() };
    let _persistence_guard = persistence_lock.lock().await;
    let record = { runtime.lock().await.record.clone() };
    if record.status == "closed" {
        return Ok(());
    }
    persist_terminal_tab_record(db_pool, record).await
}

fn persist_live_tab_record_in_background(
    db_pool: DbPool,
    runtime: Arc<Mutex<LiveTerminalRuntime>>,
) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = persist_live_tab_record(db_pool, runtime).await {
            tracing::error!(action = "terminal_tab_persistence_failed", error = ?error);
        }
    });
}

fn emit_tab_update(app_handle: &AppHandle, record: &TerminalTabRecord, has_live_session: bool) {
    let _ = app_handle.emit("terminal:tab", stored_tab_to_dto(record, has_live_session));
}

fn emit_tab_update_with_sequence(
    app_handle: &AppHandle,
    record: &TerminalTabRecord,
    has_live_session: bool,
    output_sequence: u64,
) {
    let _ = app_handle.emit(
        "terminal:tab",
        terminal_tab_to_dto(record, has_live_session, output_sequence),
    );
}

fn emit_output(app_handle: &AppHandle, record: &TerminalTabRecord, data: String, sequence: u64) {
    if data.is_empty() {
        return;
    }

    let _ = app_handle.emit(
        "terminal:output",
        TerminalOutputEvent {
            tab_id: record.id.clone(),
            data,
            snapshot: record.snapshot.clone(),
            sequence,
            generation: record.generation,
            updated_at: record.updated_at.clone(),
        },
    );
}

fn take_pending_output_batch(
    runtime: &mut LiveTerminalRuntime,
) -> Option<(String, TerminalTabRecord, u64)> {
    runtime.output_flush_scheduled = false;
    if runtime.pending_output.is_empty() {
        return None;
    }

    Some((
        std::mem::take(&mut runtime.pending_output),
        runtime.record.clone(),
        runtime.output_sequence,
    ))
}

async fn flush_live_output(
    app_handle: AppHandle,
    db_pool: DbPool,
    runtime: Arc<Mutex<LiveTerminalRuntime>>,
) {
    let maybe_batch = {
        let mut runtime_guard = runtime.lock().await;
        take_pending_output_batch(&mut runtime_guard)
    };

    if let Some((data, record, sequence)) = maybe_batch {
        emit_output(&app_handle, &record, data, sequence);
        if let Err(error) = persist_live_tab_record(db_pool, runtime).await {
            tracing::error!(action = "terminal_output_persistence_failed", tab_id = %record.id, error = ?error);
        }
    }
}

fn schedule_live_output_flush(
    app_handle: AppHandle,
    db_pool: DbPool,
    runtime: Arc<Mutex<LiveTerminalRuntime>>,
    immediate: bool,
) {
    tauri::async_runtime::spawn(async move {
        if !immediate {
            tokio::time::sleep(Duration::from_millis(OUTPUT_FLUSH_DELAY_MS)).await;
        }
        flush_live_output(app_handle, db_pool, runtime).await;
    });
}

fn wait_for_child_exit_code(child: &Arc<StdMutex<Box<dyn portable_pty::Child + Send>>>) -> i32 {
    let Ok(mut guard) = child.lock() else {
        return 1;
    };

    match guard.try_wait() {
        Ok(Some(status)) => status.exit_code() as i32,
        Ok(None) => guard
            .wait()
            .map(|status| status.exit_code() as i32)
            .unwrap_or(1),
        Err(_) => 1,
    }
}

fn spawn_reader_task(
    app_handle: AppHandle,
    db_pool: DbPool,
    terminal_store: TerminalSessionStore,
    tab_id: String,
    runtime: Arc<Mutex<LiveTerminalRuntime>>,
    mut reader: Box<dyn Read + Send>,
) {
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    handle_live_disconnect(
                        app_handle.clone(),
                        db_pool.clone(),
                        terminal_store.clone(),
                        tab_id.clone(),
                        runtime.clone(),
                    );
                    break;
                }
                Ok(read) => {
                    let chunk = String::from_utf8_lossy(&buffer[..read]).to_string();
                    if chunk.is_empty() {
                        continue;
                    }

                    handle_live_output(app_handle.clone(), db_pool.clone(), runtime.clone(), chunk);
                }
                Err(_) => {
                    handle_live_disconnect(
                        app_handle.clone(),
                        db_pool.clone(),
                        terminal_store.clone(),
                        tab_id.clone(),
                        runtime.clone(),
                    );
                    break;
                }
            }
        }
    });
}

fn handle_live_output(
    app_handle: AppHandle,
    db_pool: DbPool,
    runtime: Arc<Mutex<LiveTerminalRuntime>>,
    chunk: String,
) {
    let mut visible_output = String::new();
    let mut completed_exit_code: Option<i32> = None;
    let mut completion_tx: Option<oneshot::Sender<i32>> = None;
    let (record, output_sequence, should_schedule_output_flush, should_force_output_flush) = {
        let mut runtime_guard = runtime.blocking_lock();
        if let Some(mut pending) = runtime_guard.pending_command.take() {
            let extraction =
                extract_pending_visible_output(&runtime_guard.scan_buffer, &chunk, &mut pending);
            visible_output.push_str(&extraction.visible_output);
            runtime_guard.scan_buffer = extraction.scan_buffer;

            if let Some(exit_code) = extraction.completed_exit_code {
                completed_exit_code = Some(exit_code);
                completion_tx = pending.completion_tx.take();
            } else {
                runtime_guard.pending_command = Some(pending);
            }
        } else {
            visible_output.push_str(&runtime_guard.scan_buffer);
            visible_output.push_str(&chunk);
            runtime_guard.scan_buffer.clear();
        }

        if !visible_output.is_empty() {
            append_snapshot(&mut runtime_guard.record.snapshot, &visible_output);
            runtime_guard.pending_output.push_str(&visible_output);
            runtime_guard.output_sequence = runtime_guard.output_sequence.saturating_add(1);
            touch_terminal_tab_record(&mut runtime_guard.record);
        }

        if let Some(exit_code) = completed_exit_code {
            runtime_guard.record.status = "idle".to_string();
            runtime_guard.record.last_exit_code = Some(exit_code);
            touch_terminal_tab_record(&mut runtime_guard.record);
        }

        let should_schedule_output_flush =
            !visible_output.is_empty() && !runtime_guard.output_flush_scheduled;
        let should_force_output_flush = !visible_output.is_empty() && completed_exit_code.is_some();
        if should_schedule_output_flush {
            runtime_guard.output_flush_scheduled = true;
        }

        (
            runtime_guard.record.clone(),
            runtime_guard.output_sequence,
            should_schedule_output_flush,
            should_force_output_flush,
        )
    };

    if should_schedule_output_flush {
        schedule_live_output_flush(
            app_handle.clone(),
            db_pool.clone(),
            runtime.clone(),
            completed_exit_code.is_some(),
        );
    } else if should_force_output_flush {
        schedule_live_output_flush(app_handle.clone(), db_pool.clone(), runtime.clone(), true);
    }

    if completed_exit_code.is_some() {
        emit_tab_update_with_sequence(&app_handle, &record, true, output_sequence);
    }

    if completed_exit_code.is_some() && visible_output.is_empty() {
        persist_live_tab_record_in_background(db_pool, runtime);
    }

    if let (Some(exit_code), Some(tx)) = (completed_exit_code, completion_tx) {
        let _ = tx.send(exit_code);
    }
}

fn handle_live_disconnect(
    app_handle: AppHandle,
    db_pool: DbPool,
    terminal_store: TerminalSessionStore,
    tab_id: String,
    runtime: Arc<Mutex<LiveTerminalRuntime>>,
) {
    let live_session = {
        let mut live_tabs = terminal_store.live_tabs.blocking_lock();
        let is_current_session = live_tabs
            .get(&tab_id)
            .is_some_and(|session| Arc::ptr_eq(&session.runtime, &runtime));
        if is_current_session {
            live_tabs.remove(&tab_id)
        } else {
            None
        }
    };

    if live_session.is_none() {
        return;
    }

    let is_command_process = {
        let runtime_guard = runtime.blocking_lock();
        runtime_guard.mode == LiveTerminalMode::CommandProcess
    };

    let command_exit_code = if is_command_process {
        live_session
            .as_ref()
            .map(|session| wait_for_child_exit_code(&session.child))
    } else {
        None
    };

    let mut completion_tx: Option<oneshot::Sender<i32>> = None;
    let (pending_output_batch, maybe_record, output_sequence) = {
        let mut runtime_guard = runtime.blocking_lock();
        let pending_output_batch = take_pending_output_batch(&mut runtime_guard);
        if runtime_guard.record.status == "closed" {
            (pending_output_batch, None, runtime_guard.output_sequence)
        } else if runtime_guard.mode == LiveTerminalMode::CommandProcess {
            let exit_code = command_exit_code.unwrap_or(1);
            runtime_guard.pending_command = None;
            runtime_guard.record.status = if exit_code == 0 {
                "completed".to_string()
            } else {
                "failed".to_string()
            };
            runtime_guard.record.last_exit_code = Some(exit_code);
            touch_terminal_tab_record(&mut runtime_guard.record);
            (
                pending_output_batch,
                Some(runtime_guard.record.clone()),
                runtime_guard.output_sequence,
            )
        } else {
            if let Some(pending) = runtime_guard.pending_command.as_mut() {
                completion_tx = pending.completion_tx.take();
            }
            runtime_guard.pending_command = None;
            runtime_guard.record.status = "disconnected".to_string();
            touch_terminal_tab_record(&mut runtime_guard.record);
            (
                pending_output_batch,
                Some(runtime_guard.record.clone()),
                runtime_guard.output_sequence,
            )
        }
    };

    if let Some((data, record, sequence)) = pending_output_batch {
        emit_output(&app_handle, &record, data, sequence);
    }

    if let Some(record) = maybe_record {
        emit_tab_update_with_sequence(&app_handle, &record, false, output_sequence);
        persist_live_tab_record_in_background(db_pool, runtime);
    }

    if let Some(tx) = completion_tx {
        let _ = tx.send(130);
    }
}

async fn get_live_record(
    terminal_store: &State<'_, TerminalSessionStore>,
    tab_id: &str,
) -> Option<TerminalTabRecord> {
    let runtime = {
        let live_tabs = terminal_store.live_tabs.lock().await;
        live_tabs.get(tab_id).map(|session| session.runtime.clone())
    }?;

    let runtime_guard = runtime.lock().await;
    Some(runtime_guard.record.clone())
}

async fn spawn_live_tab(
    app_handle: AppHandle,
    db_pool: DbPool,
    terminal_store: &State<'_, TerminalSessionStore>,
    mut record: TerminalTabRecord,
) -> CommandResult<TerminalTabDto> {
    let existing = {
        let live_tabs = terminal_store.live_tabs.lock().await;
        live_tabs
            .get(&record.id)
            .map(|session| session.runtime.clone())
    };
    if let Some(runtime) = existing {
        let guard = runtime.lock().await;
        return Ok(stored_tab_to_dto(&guard.record, true));
    }

    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(pty_size(DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS))
        .map_err(|error| command_error(format!("Failed to create terminal PTY: {}", error)))?;

    #[cfg(windows)]
    let (shell_command, shell_kind) = build_shell_command(&record);
    #[cfg(not(windows))]
    let (shell_command, shell_kind) = build_shell_command(&record);
    let mut child = pair
        .slave
        .spawn_command(shell_command)
        .map_err(|error| command_error(format!("Failed to launch terminal shell: {}", error)))?;
    drop(pair.slave);

    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = child.kill();
            return Err(command_error(format!(
                "Failed to open terminal writer: {}",
                error
            )));
        }
    };
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = child.kill();
            return Err(command_error(format!(
                "Failed to open terminal reader: {}",
                error
            )));
        }
    };

    record.status = "idle".to_string();
    touch_terminal_tab_record(&mut record);

    let runtime = Arc::new(Mutex::new(LiveTerminalRuntime {
        record: record.clone(),
        persistence_lock: Arc::new(Mutex::new(())),
        scan_buffer: String::new(),
        pending_command: None,
        pending_output: String::new(),
        output_flush_scheduled: false,
        shell_kind,
        mode: LiveTerminalMode::InteractiveShell,
        output_sequence: 0,
    }));

    let child: Arc<StdMutex<Box<dyn portable_pty::Child + Send>>> = Arc::new(StdMutex::new(child));
    let session = LiveTerminalSession {
        child: child.clone(),
        writer: Arc::new(StdMutex::new(writer)),
        master: Arc::new(StdMutex::new(pair.master)),
        runtime: runtime.clone(),
    };

    let replaced_by_existing = {
        let mut live_tabs = terminal_store.live_tabs.lock().await;
        if let Some(existing) = live_tabs.get(&record.id) {
            Some(existing.runtime.clone())
        } else {
            live_tabs.insert(record.id.clone(), session);
            None
        }
    };

    if let Some(existing) = replaced_by_existing {
        let _ = tokio::task::spawn_blocking(move || {
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
            }
        })
        .await;
        let guard = existing.lock().await;
        return Ok(stored_tab_to_dto(&guard.record, true));
    }

    if let Err(error) = persist_live_tab_record(db_pool.clone(), runtime.clone()).await {
        let removed = {
            let mut live_tabs = terminal_store.live_tabs.lock().await;
            live_tabs.remove(&record.id)
        };
        if let Some(session) = removed {
            let _ = tokio::task::spawn_blocking(move || {
                if let Ok(mut child) = session.child.lock() {
                    let _ = child.kill();
                }
            })
            .await;
        }
        return Err(error);
    }
    emit_tab_update(&app_handle, &record, true);
    spawn_reader_task(
        app_handle,
        db_pool,
        terminal_store.inner().clone(),
        record.id.clone(),
        runtime,
        reader,
    );

    Ok(stored_tab_to_dto(&record, true))
}

async fn spawn_command_tab(
    app_handle: AppHandle,
    db_pool: DbPool,
    terminal_store: &State<'_, TerminalSessionStore>,
    mut record: TerminalTabRecord,
    command_text: String,
) -> CommandResult<TerminalTabDto> {
    let existing = {
        let live_tabs = terminal_store.live_tabs.lock().await;
        live_tabs
            .get(&record.id)
            .map(|session| session.runtime.clone())
    };
    if let Some(runtime) = existing {
        let guard = runtime.lock().await;
        return Ok(terminal_tab_to_dto(
            &guard.record,
            true,
            guard.output_sequence,
        ));
    }

    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(pty_size(DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS))
        .map_err(|error| command_error(format!("Failed to create terminal PTY: {}", error)))?;

    let process_command = build_command_process(&record, &command_text);
    let mut child = pair
        .slave
        .spawn_command(process_command)
        .map_err(|error| command_error(format!("Failed to launch terminal command: {}", error)))?;
    drop(pair.slave);

    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = child.kill();
            return Err(command_error(format!(
                "Failed to open terminal writer: {}",
                error
            )));
        }
    };
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = child.kill();
            return Err(command_error(format!(
                "Failed to open terminal reader: {}",
                error
            )));
        }
    };

    record.status = "running".to_string();
    touch_terminal_tab_record(&mut record);
    let output_sequence = if record.snapshot.is_empty() { 0 } else { 1 };

    let runtime = Arc::new(Mutex::new(LiveTerminalRuntime {
        record: record.clone(),
        persistence_lock: Arc::new(Mutex::new(())),
        scan_buffer: String::new(),
        pending_command: None,
        pending_output: String::new(),
        output_flush_scheduled: false,
        shell_kind: ManagedShellKind::Posix,
        mode: LiveTerminalMode::CommandProcess,
        output_sequence,
    }));

    let session = LiveTerminalSession {
        child: Arc::new(StdMutex::new(child)),
        writer: Arc::new(StdMutex::new(writer)),
        master: Arc::new(StdMutex::new(pair.master)),
        runtime: runtime.clone(),
    };

    {
        let mut live_tabs = terminal_store.live_tabs.lock().await;
        live_tabs.insert(record.id.clone(), session);
    }

    if let Err(error) = persist_live_tab_record(db_pool.clone(), runtime.clone()).await {
        let removed = {
            let mut live_tabs = terminal_store.live_tabs.lock().await;
            live_tabs.remove(&record.id)
        };
        if let Some(session) = removed {
            let _ = tokio::task::spawn_blocking(move || {
                if let Ok(mut child) = session.child.lock() {
                    let _ = child.kill();
                }
            })
            .await;
        }
        return Err(error);
    }
    emit_tab_update_with_sequence(&app_handle, &record, true, output_sequence);
    spawn_reader_task(
        app_handle,
        db_pool,
        terminal_store.inner().clone(),
        record.id.clone(),
        runtime,
        reader,
    );

    Ok(terminal_tab_to_dto(&record, true, output_sequence))
}

async fn get_persisted_tab_record(
    pool: &State<'_, DbPool>,
    tab_id: &str,
) -> CommandResult<TerminalTabRecord> {
    let db_pool = load_db_pool(pool).await?;
    repository::get_terminal_tab(&db_pool, tab_id)
        .await
        .map_err(|error| command_error(error.to_string()))?
        .ok_or_else(|| command_error(format!("Unknown terminal tab id: {}", tab_id)))
}

fn build_shell_command_compat(command: &str, cwd: &Path) -> tokio::process::Command {
    #[cfg(windows)]
    let mut process = {
        let mut process = background_tokio_command("powershell");
        process.args(["-NoLogo", "-NoProfile", "-Command", command]);
        process
    };

    #[cfg(not(windows))]
    let mut process = {
        let mut process = background_tokio_command("bash");
        process.args(["-lc", command]);
        process
    };

    process
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        process.as_std_mut().process_group(0);
    }
    process
}

#[tauri::command]
pub async fn terminal_list_tabs(
    pool: State<'_, DbPool>,
    terminal_store: State<'_, TerminalSessionStore>,
) -> CommandResult<Vec<TerminalTabDto>> {
    let db_pool = load_db_pool(&pool).await?;
    let stored_tabs = repository::list_terminal_tabs(&db_pool)
        .await
        .map_err(|error| command_error(error.to_string()))?;

    let live_runtimes = {
        let live_tabs = terminal_store.live_tabs.lock().await;
        live_tabs
            .iter()
            .map(|(tab_id, session)| (tab_id.clone(), session.runtime.clone()))
            .collect::<Vec<_>>()
    };

    let mut live_records = HashMap::new();
    for (tab_id, runtime) in live_runtimes {
        let guard = runtime.lock().await;
        live_records.insert(tab_id, guard.record.clone());
    }

    Ok(stored_tabs
        .into_iter()
        .map(|record| {
            if let Some(live_record) = live_records.get(&record.id) {
                stored_tab_to_dto(live_record, true)
            } else {
                stored_tab_to_dto(&record, false)
            }
        })
        .collect())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn terminal_create_tab(
    app_handle: AppHandle,
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    pool: State<'_, DbPool>,
    terminal_store: State<'_, TerminalSessionStore>,
    kind: String,
    project_id: String,
    cwd: Option<String>,
    title: String,
    task_id: Option<String>,
    prompt_context: Option<TerminalPromptContext>,
) -> CommandResult<TerminalTabDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    let project = resolve_project_target(&workspace_path, &metadata_root, &project_id).await?;
    let session_cwd =
        resolve_session_cwd(&project.workspace_path, cwd.as_deref(), git_state.inner())?;
    let record = build_terminal_record(
        kind.trim(),
        project_id,
        task_id,
        title.trim().to_string(),
        prompt_context,
        project,
        session_cwd,
    );

    spawn_live_tab(app_handle, pool.inner().clone(), &terminal_store, record).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn terminal_start_command_tab(
    app_handle: AppHandle,
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    pool: State<'_, DbPool>,
    terminal_store: State<'_, TerminalSessionStore>,
    kind: String,
    project_id: String,
    cwd: Option<String>,
    title: String,
    task_id: Option<String>,
    prompt_context: Option<TerminalPromptContext>,
    command: String,
) -> CommandResult<TerminalTabDto> {
    let trimmed_command = command.trim();
    if trimmed_command.is_empty() {
        return Err(command_error("Command cannot be empty"));
    }

    let workspace_path = workspace_root.inner().0.read().await.clone();
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    let project = resolve_project_target(&workspace_path, &metadata_root, &project_id).await?;
    let session_cwd =
        resolve_session_cwd(&project.workspace_path, cwd.as_deref(), git_state.inner())?;
    let mut record = build_terminal_record(
        kind.trim(),
        project_id,
        task_id,
        title.trim().to_string(),
        prompt_context,
        project,
        session_cwd,
    );
    record.status = "running".to_string();
    record.last_command = Some(trimmed_command.to_string());
    record.snapshot = format!("{}\r\n", trimmed_command);
    touch_terminal_tab_record(&mut record);

    spawn_command_tab(
        app_handle,
        pool.inner().clone(),
        &terminal_store,
        record,
        trimmed_command.to_string(),
    )
    .await
}

#[tauri::command]
pub async fn terminal_reconnect_tab(
    app_handle: AppHandle,
    pool: State<'_, DbPool>,
    terminal_store: State<'_, TerminalSessionStore>,
    tab_id: String,
) -> CommandResult<TerminalTabDto> {
    if let Some(record) = get_live_record(&terminal_store, &tab_id).await {
        return Ok(stored_tab_to_dto(&record, true));
    }

    let mut record = get_persisted_tab_record(&pool, &tab_id).await?;
    record.status = "idle".to_string();
    touch_terminal_tab_record(&mut record);
    spawn_live_tab(app_handle, pool.inner().clone(), &terminal_store, record).await
}

#[tauri::command]
pub async fn terminal_read_tab(
    pool: State<'_, DbPool>,
    terminal_store: State<'_, TerminalSessionStore>,
    tab_id: String,
) -> CommandResult<TerminalTabDto> {
    if let Some(record) = get_live_record(&terminal_store, &tab_id).await {
        return Ok(stored_tab_to_dto(&record, true));
    }

    let record = get_persisted_tab_record(&pool, &tab_id).await?;
    Ok(stored_tab_to_dto(&record, false))
}

#[tauri::command]
pub async fn terminal_update_tab_metadata(
    app_handle: AppHandle,
    pool: State<'_, DbPool>,
    terminal_store: State<'_, TerminalSessionStore>,
    tab_id: String,
    title: String,
    prompt_context: Option<TerminalPromptContext>,
) -> CommandResult<TerminalTabDto> {
    let normalized_title = title.trim().to_string();
    if normalized_title.is_empty() {
        return Err(command_error("Terminal title cannot be empty"));
    }

    if let Some(dto) = apply_live_tab_metadata_update(
        &app_handle,
        pool.inner().clone(),
        &terminal_store,
        &tab_id,
        normalized_title.clone(),
        prompt_context.clone(),
    )
    .await?
    {
        return Ok(dto);
    }

    let db_pool = load_db_pool(&pool).await?;
    let mut record = repository::get_terminal_tab(&db_pool, &tab_id)
        .await
        .map_err(|error| command_error(error.to_string()))?
        .ok_or_else(|| command_error(format!("Unknown terminal tab id: {}", tab_id)))?;
    record.title = normalized_title;
    record.prompt_context_json =
        prompt_context.and_then(|value| serde_json::to_string(&value).ok());
    touch_terminal_tab_record(&mut record);
    repository::upsert_terminal_tab(&db_pool, &record)
        .await
        .map_err(|error| command_error(error.to_string()))?;
    emit_tab_update(&app_handle, &record, false);
    Ok(stored_tab_to_dto(&record, false))
}

#[tauri::command]
pub async fn terminal_write_input(
    terminal_store: State<'_, TerminalSessionStore>,
    tab_id: String,
    input: String,
) -> CommandResult<()> {
    let writer = {
        let live_tabs = terminal_store.live_tabs.lock().await;
        let session = live_tabs
            .get(&tab_id)
            .ok_or_else(|| command_error(format!("Terminal tab is not connected: {}", tab_id)))?;
        session.writer.clone()
    };

    tokio::task::spawn_blocking(move || {
        let mut guard = writer
            .lock()
            .map_err(|_| command_error("Failed to lock terminal writer"))?;
        guard
            .write_all(input.as_bytes())
            .map_err(|error| command_error(format!("Failed to write terminal input: {}", error)))?;
        guard
            .flush()
            .map_err(|error| command_error(format!("Failed to flush terminal input: {}", error)))
    })
    .await
    .map_err(|error| command_error(format!("Terminal input task failed: {}", error)))??;

    Ok(())
}

#[tauri::command]
pub async fn terminal_resize(
    terminal_store: State<'_, TerminalSessionStore>,
    tab_id: String,
    cols: u16,
    rows: u16,
) -> CommandResult<()> {
    let master = {
        let live_tabs = terminal_store.live_tabs.lock().await;
        let session = live_tabs
            .get(&tab_id)
            .ok_or_else(|| command_error(format!("Terminal tab is not connected: {}", tab_id)))?;
        session.master.clone()
    };

    let target_cols = cols.max(20);
    let target_rows = rows.max(4);
    tokio::task::spawn_blocking(move || {
        let guard = master
            .lock()
            .map_err(|_| command_error("Failed to lock terminal master"))?;
        guard
            .resize(pty_size(target_cols, target_rows))
            .map_err(|error| command_error(format!("Failed to resize terminal: {}", error)))
    })
    .await
    .map_err(|error| command_error(format!("Terminal resize task failed: {}", error)))??;

    Ok(())
}

#[tauri::command]
pub async fn terminal_execute_command(
    app_handle: AppHandle,
    pool: State<'_, DbPool>,
    terminal_store: State<'_, TerminalSessionStore>,
    tab_id: String,
    command: String,
) -> CommandResult<TerminalTabDto> {
    let trimmed_command = command.trim();
    if trimmed_command.is_empty() {
        return Err(command_error("Command cannot be empty"));
    }

    let (writer, runtime) = {
        let live_tabs = terminal_store.live_tabs.lock().await;
        let session = live_tabs
            .get(&tab_id)
            .ok_or_else(|| command_error(format!("Terminal tab is not connected: {}", tab_id)))?;
        (session.writer.clone(), session.runtime.clone())
    };

    let command_id = Uuid::new_v4().to_string();
    let marker_prefix = format!("__MACRO_CMD_DONE__{}__", command_id);
    let shell_kind = {
        let runtime_guard = runtime.lock().await;
        runtime_guard.shell_kind
    };
    let wrapped_command = build_managed_command(trimmed_command, &marker_prefix, shell_kind);
    let db_pool_state = pool.inner().clone();
    let (completion_rx, should_flush_visible_command, rollback) = {
        let mut runtime_guard = runtime.lock().await;
        if runtime_guard.pending_command.is_some() {
            return Err(command_error(
                "A managed command is already running in this terminal tab",
            ));
        }

        let rollback = CommandDispatchRollback {
            record: runtime_guard.record.clone(),
            pending_output: runtime_guard.pending_output.clone(),
            output_flush_scheduled: runtime_guard.output_flush_scheduled,
            output_sequence: runtime_guard.output_sequence,
        };
        let (completion_tx, completion_rx) = oneshot::channel();
        let visible_command_output = format!("{}\r\n", trimmed_command);
        runtime_guard.record.status = "running".to_string();
        runtime_guard.record.last_command = Some(trimmed_command.to_string());
        touch_terminal_tab_record(&mut runtime_guard.record);
        append_snapshot(&mut runtime_guard.record.snapshot, &visible_command_output);
        runtime_guard
            .pending_output
            .push_str(&visible_command_output);
        runtime_guard.output_sequence = runtime_guard.output_sequence.saturating_add(1);
        let should_flush_visible_command = !runtime_guard.output_flush_scheduled;
        if should_flush_visible_command {
            runtime_guard.output_flush_scheduled = true;
        }
        runtime_guard.pending_command = Some(PendingCommand {
            marker_prefix: marker_prefix.clone(),
            echoed_command: Some(wrapped_command.clone()),
            visible_command: trimmed_command.to_string(),
            completion_tx: Some(completion_tx),
        });
        (completion_rx, should_flush_visible_command, rollback)
    };

    if let Err(error) = persist_live_tab_record(db_pool_state.clone(), runtime.clone()).await {
        let mut runtime_guard = runtime.lock().await;
        runtime_guard.record = rollback.record;
        runtime_guard.pending_output = rollback.pending_output;
        runtime_guard.output_flush_scheduled = rollback.output_flush_scheduled;
        runtime_guard.output_sequence = rollback.output_sequence;
        runtime_guard.pending_command = None;
        return Err(error);
    }
    {
        let runtime_guard = runtime.lock().await;
        emit_tab_update(&app_handle, &runtime_guard.record, true);
    }

    if should_flush_visible_command {
        schedule_live_output_flush(
            app_handle.clone(),
            db_pool_state.clone(),
            runtime.clone(),
            true,
        );
    }

    let write_result = {
        let wrapped_command = wrapped_command.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = writer
                .lock()
                .map_err(|_| command_error("Failed to lock terminal writer"))?;
            guard
                .write_all(wrapped_command.as_bytes())
                .map_err(|error| {
                    command_error(format!("Failed to dispatch terminal command: {}", error))
                })?;
            guard.flush().map_err(|error| {
                command_error(format!("Failed to flush terminal command: {}", error))
            })
        })
        .await
        .map_err(|error| command_error(format!("Terminal command task failed: {}", error)))?
    };

    if let Err(error) = write_result {
        let mut runtime_guard = runtime.lock().await;
        runtime_guard.pending_command = None;
        runtime_guard.record.status = "idle".to_string();
        touch_terminal_tab_record(&mut runtime_guard.record);
        drop(runtime_guard);
        persist_live_tab_record(db_pool_state.clone(), runtime.clone()).await?;
        let runtime_guard = runtime.lock().await;
        emit_tab_update(&app_handle, &runtime_guard.record, true);
        return Err(error);
    }

    let _ = completion_rx
        .await
        .map_err(|_| command_error("Terminal command did not complete"))?;

    let runtime_guard = runtime.lock().await;
    Ok(stored_tab_to_dto(&runtime_guard.record, true))
}

#[tauri::command]
pub async fn terminal_interrupt(
    app_handle: AppHandle,
    pool: State<'_, DbPool>,
    terminal_store: State<'_, TerminalSessionStore>,
    tab_id: String,
) -> CommandResult<TerminalTabDto> {
    let (writer, runtime) = {
        let live_tabs = terminal_store.live_tabs.lock().await;
        let session = live_tabs
            .get(&tab_id)
            .ok_or_else(|| command_error(format!("Terminal tab is not connected: {}", tab_id)))?;
        (session.writer.clone(), session.runtime.clone())
    };

    tokio::task::spawn_blocking(move || {
        let mut guard = writer
            .lock()
            .map_err(|_| command_error("Failed to lock terminal writer"))?;
        guard
            .write_all(&[3])
            .map_err(|error| command_error(format!("Failed to interrupt terminal: {}", error)))?;
        guard.flush().map_err(|error| {
            command_error(format!("Failed to flush terminal interrupt: {}", error))
        })
    })
    .await
    .map_err(|error| command_error(format!("Terminal interrupt task failed: {}", error)))??;

    let db_pool_state = pool.inner().clone();
    let maybe_completion = {
        let mut runtime_guard = runtime.lock().await;
        if runtime_guard.mode == LiveTerminalMode::CommandProcess {
            runtime_guard.record.status = "interrupting".to_string();
            touch_terminal_tab_record(&mut runtime_guard.record);
            let dto =
                terminal_tab_to_dto(&runtime_guard.record, true, runtime_guard.output_sequence);
            drop(runtime_guard);
            persist_live_tab_record(db_pool_state.clone(), runtime.clone()).await?;
            let runtime_guard = runtime.lock().await;
            emit_tab_update_with_sequence(
                &app_handle,
                &runtime_guard.record,
                true,
                runtime_guard.output_sequence,
            );
            return Ok(dto);
        }

        let completion = runtime_guard
            .pending_command
            .as_mut()
            .and_then(|pending| pending.completion_tx.take());
        runtime_guard.pending_command = None;
        runtime_guard.record.status = "idle".to_string();
        runtime_guard.record.last_exit_code = Some(130);
        touch_terminal_tab_record(&mut runtime_guard.record);
        let dto = stored_tab_to_dto(&runtime_guard.record, true);
        (completion, dto)
    };

    persist_live_tab_record(db_pool_state, runtime.clone()).await?;
    {
        let runtime_guard = runtime.lock().await;
        emit_tab_update(&app_handle, &runtime_guard.record, true);
    }

    if let Some(completion) = maybe_completion.0 {
        let _ = completion.send(130);
    }

    Ok(maybe_completion.1)
}

#[tauri::command]
pub async fn terminal_clear_tab(
    app_handle: AppHandle,
    pool: State<'_, DbPool>,
    terminal_store: State<'_, TerminalSessionStore>,
    tab_id: String,
) -> CommandResult<TerminalTabDto> {
    if let Some(runtime) = {
        let live_tabs = terminal_store.live_tabs.lock().await;
        live_tabs
            .get(&tab_id)
            .map(|session| session.runtime.clone())
    } {
        let mut runtime_guard = runtime.lock().await;
        runtime_guard.record.snapshot.clear();
        runtime_guard.output_sequence = runtime_guard.output_sequence.saturating_add(1);
        touch_terminal_tab_record(&mut runtime_guard.record);
        let dto = stored_tab_to_dto(&runtime_guard.record, true);
        drop(runtime_guard);
        persist_live_tab_record(pool.inner().clone(), runtime.clone()).await?;
        let runtime_guard = runtime.lock().await;
        emit_tab_update_with_sequence(
            &app_handle,
            &runtime_guard.record,
            true,
            runtime_guard.output_sequence,
        );
        return Ok(dto);
    }

    let db_pool = load_db_pool(&pool).await?;
    let mut record = repository::get_terminal_tab(&db_pool, &tab_id)
        .await
        .map_err(|error| command_error(error.to_string()))?
        .ok_or_else(|| command_error(format!("Unknown terminal tab id: {}", tab_id)))?;
    record.snapshot.clear();
    touch_terminal_tab_record(&mut record);
    repository::upsert_terminal_tab(&db_pool, &record)
        .await
        .map_err(|error| command_error(error.to_string()))?;
    emit_tab_update(&app_handle, &record, false);
    Ok(stored_tab_to_dto(&record, false))
}

#[tauri::command]
pub async fn terminal_close_tab(
    app_handle: AppHandle,
    pool: State<'_, DbPool>,
    terminal_store: State<'_, TerminalSessionStore>,
    tab_id: String,
) -> CommandResult<()> {
    let live_session = {
        let mut live_tabs = terminal_store.live_tabs.lock().await;
        live_tabs.remove(&tab_id)
    };

    if let Some(session) = live_session {
        let (is_command_process, task_id, project_id) = {
            let runtime_guard = session.runtime.lock().await;
            (
                runtime_guard.mode == LiveTerminalMode::CommandProcess,
                runtime_guard.record.task_id.clone(),
                runtime_guard.record.project_id.clone(),
            )
        };

        let (closed_record, persistence_lock) = {
            let mut runtime_guard = session.runtime.lock().await;
            runtime_guard.record.status = "closed".to_string();
            touch_terminal_tab_record(&mut runtime_guard.record);
            if let Some(pending) = runtime_guard.pending_command.as_mut() {
                if let Some(completion) = pending.completion_tx.take() {
                    let _ = completion.send(130);
                }
            }
            runtime_guard.pending_command = None;
            (
                runtime_guard.record.clone(),
                runtime_guard.persistence_lock.clone(),
            )
        };

        if is_command_process {
            tracing::debug!(
                action = "terminal_command_process_closed_by_user",
                tab_id = %tab_id,
                task_id = task_id.as_deref().unwrap_or(""),
                project_id = %project_id,
                status = "closed_by_user"
            );
        }

        let writer = session.writer.clone();
        let interrupt_result = tokio::task::spawn_blocking(move || {
            if let Ok(mut guard) = writer.lock() {
                guard
                    .write_all(&[3])
                    .and_then(|_| guard.flush())
                    .map_err(|error| {
                        command_error(format!(
                            "Failed to interrupt terminal during close: {error}"
                        ))
                    })
            } else {
                Err(command_error("Failed to lock terminal writer during close"))
            }
        })
        .await
        .map_err(|error| command_error(format!("Terminal close interrupt task failed: {error}")))?;
        if let Err(error) = interrupt_result {
            tracing::warn!(action = "terminal_close_interrupt_failed", tab_id = %tab_id, error = ?error);
        }

        tokio::time::sleep(Duration::from_millis(LIVE_TERMINAL_CLOSE_GRACE_MS)).await;
        let child = session.child.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = child
                .lock()
                .map_err(|_| command_error("Failed to lock terminal child during close"))?;
            match guard.try_wait() {
                Ok(Some(_)) => Ok(()),
                Ok(None) => guard.kill().map_err(|error| {
                    command_error(format!("Failed to terminate terminal process: {error}"))
                }),
                Err(error) => Err(command_error(format!(
                    "Failed to inspect terminal process: {error}"
                ))),
            }
        })
        .await
        .map_err(|error| {
            command_error(format!("Terminal close termination task failed: {error}"))
        })??;

        let db_pool = load_db_pool(&pool).await?;
        let _persistence_guard = persistence_lock.lock().await;
        persist_terminal_tab_record(pool.inner().clone(), closed_record).await?;
        repository::delete_terminal_tab(&db_pool, &tab_id)
            .await
            .map_err(|error| command_error(error.to_string()))?;
    } else {
        let db_pool = load_db_pool(&pool).await?;
        repository::delete_terminal_tab(&db_pool, &tab_id)
            .await
            .map_err(|error| command_error(error.to_string()))?;
    }

    let _ = app_handle.emit("terminal:closed", TerminalClosedEvent { tab_id });
    Ok(())
}

async fn kill_process(pid: u32) -> CommandResult<()> {
    #[cfg(windows)]
    let status = {
        let mut command = background_tokio_command("taskkill");
        command.args(["/PID", &pid.to_string(), "/T", "/F"]);
        command.status()
    }
    .await
    .map_err(|error| command_error(format!("Failed to kill process {}: {}", pid, error)))?;

    #[cfg(not(windows))]
    let status = {
        let mut command = background_tokio_command("kill");
        command
            .args(["-TERM", "--", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command.status()
    }
    .await
    .map_err(|error| command_error(format!("Failed to kill process group {}: {}", pid, error)))?;

    if !status.success() {
        return Err(command_error(format!(
            "Failed to kill process {} (status: {})",
            pid, status
        )));
    }

    #[cfg(not(windows))]
    {
        let deadline =
            tokio::time::Instant::now() + Duration::from_millis(LEGACY_COMMAND_KILL_GRACE_MS);
        loop {
            let mut probe = background_tokio_command("kill");
            probe
                .args(["-0", "--", &format!("-{pid}")])
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let still_running = probe
                .status()
                .await
                .map(|status| status.success())
                .unwrap_or(false);
            if !still_running {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(LEGACY_COMMAND_KILL_POLL_MS)).await;
        }
        let mut command = background_tokio_command("kill");
        command
            .args(["-KILL", "--", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let _ = command.status().await;
    }

    Ok(())
}

#[derive(Default)]
struct BoundedChildOutput {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    total_bytes: usize,
}

impl BoundedChildOutput {
    fn push(&mut self, chunk: &[u8]) {
        self.total_bytes = self.total_bytes.saturating_add(chunk.len());
        let mut remainder = chunk;
        if self.head.len() < LEGACY_COMMAND_OUTPUT_HEAD_BYTES {
            let head_remaining = LEGACY_COMMAND_OUTPUT_HEAD_BYTES - self.head.len();
            let take = head_remaining.min(remainder.len());
            self.head.extend_from_slice(&remainder[..take]);
            remainder = &remainder[take..];
        }

        let tail_capacity =
            MAX_LEGACY_COMMAND_OUTPUT_BYTES.saturating_sub(LEGACY_COMMAND_OUTPUT_HEAD_BYTES);
        for byte in remainder {
            self.tail.push_back(*byte);
            if self.tail.len() > tail_capacity {
                self.tail.pop_front();
            }
        }
    }

    fn render(&self, drain_incomplete: bool) -> (String, bool) {
        let retained_bytes = self.head.len().saturating_add(self.tail.len());
        let omitted_bytes = self.total_bytes.saturating_sub(retained_bytes);
        let mut output = Vec::with_capacity(
            retained_bytes
                .saturating_add(128)
                .saturating_add(INCOMPLETE_DRAIN_MARKER.len()),
        );
        output.extend_from_slice(&self.head);
        if omitted_bytes > 0 {
            output.extend_from_slice(
                format!(
                    "\n[terminal output truncated: {omitted_bytes} bytes omitted; beginning and latest output retained]\n"
                )
                .as_bytes(),
            );
        }
        output.extend(self.tail.iter().copied());
        if drain_incomplete {
            output.extend_from_slice(INCOMPLETE_DRAIN_MARKER.as_bytes());
        }
        (
            String::from_utf8_lossy(&output).to_string(),
            omitted_bytes > 0 || drain_incomplete,
        )
    }
}

async fn read_child_stream<T>(
    stream: Option<T>,
    output: Arc<StdMutex<BoundedChildOutput>>,
) -> CommandResult<()>
where
    T: tokio::io::AsyncRead + Unpin,
{
    let Some(mut stream) = stream else {
        return Ok(());
    };

    let mut buffer = [0u8; 16 * 1024];
    loop {
        let count = stream
            .read(&mut buffer)
            .await
            .map_err(|error| command_error(format!("Failed to read terminal output: {}", error)))?;
        if count == 0 {
            break;
        }
        output
            .lock()
            .map_err(|_| command_error("Failed to lock terminal output collector"))?
            .push(&buffer[..count]);
    }

    Ok(())
}

async fn finish_child_output(
    mut stdout_task: tokio::task::JoinHandle<CommandResult<()>>,
    mut stderr_task: tokio::task::JoinHandle<CommandResult<()>>,
    output: Arc<StdMutex<BoundedChildOutput>>,
) -> CommandResult<(String, bool, bool)> {
    let drain_result = tokio::time::timeout(
        Duration::from_millis(LEGACY_COMMAND_DRAIN_TIMEOUT_MS),
        async {
            (&mut stdout_task).await.map_err(|error| {
                command_error(format!("Terminal stdout task failed: {}", error))
            })??;
            (&mut stderr_task).await.map_err(|error| {
                command_error(format!("Terminal stderr task failed: {}", error))
            })??;
            Ok::<(), crate::commands::CommandError>(())
        },
    )
    .await;

    let drain_incomplete = match drain_result {
        Ok(result) => {
            result?;
            false
        }
        Err(_) => {
            stdout_task.abort();
            stderr_task.abort();
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            true
        }
    };

    let (rendered, truncated) = output
        .lock()
        .map_err(|_| command_error("Failed to lock terminal output collector"))
        .map(|output| output.render(drain_incomplete))?;
    Ok((rendered, truncated, drain_incomplete))
}

#[cfg(not(windows))]
struct LegacyProcessGroupGuard {
    pid: Option<u32>,
}

#[cfg(not(windows))]
impl LegacyProcessGroupGuard {
    fn new(pid: Option<u32>) -> Self {
        Self { pid }
    }

    fn disarm(&mut self) {
        self.pid = None;
    }
}

#[cfg(not(windows))]
impl Drop for LegacyProcessGroupGuard {
    fn drop(&mut self) {
        let Some(pid) = self.pid else {
            return;
        };
        let _ = std::process::Command::new("kill")
            .args(["-KILL", "--", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

struct LegacySessionRunGuard {
    terminal_store: TerminalSessionStore,
    session_id: String,
    armed: bool,
}

impl LegacySessionRunGuard {
    fn new(terminal_store: TerminalSessionStore, session_id: String) -> Self {
        Self {
            terminal_store,
            session_id,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for LegacySessionRunGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let terminal_store = self.terminal_store.clone();
        let session_id = self.session_id.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let mut sessions = terminal_store.legacy_sessions.lock().await;
                if let Some(session) = sessions.get_mut(&session_id) {
                    session.status = "killed".to_string();
                    session.pid = None;
                    session.run_in_progress = false;
                    session.kill_requested = false;
                    session.active_execution_id = None;
                    #[cfg(windows)]
                    {
                        session.windows_job = None;
                    }
                    session.updated_at = current_timestamp();
                }
            });
        }
    }
}

#[cfg(windows)]
struct LegacyProcessGroupGuard {
    job: Option<Arc<WindowsJob>>,
}

#[cfg(windows)]
impl LegacyProcessGroupGuard {
    fn new(job: Option<Arc<WindowsJob>>) -> Self {
        Self { job }
    }

    fn disarm(&mut self) {
        self.job = None;
    }
}

#[cfg(windows)]
impl Drop for LegacyProcessGroupGuard {
    fn drop(&mut self) {
        if let Some(job) = self.job.take() {
            let _ = job.terminate();
        }
    }
}

fn normalize_legacy_timeout_ms(timeout_ms: Option<u64>) -> u64 {
    timeout_ms
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_LEGACY_COMMAND_TIMEOUT_MS)
        .min(MAX_LEGACY_COMMAND_TIMEOUT_MS)
}

#[cfg(not(windows))]
async fn stop_legacy_child_tree(
    child: &mut tokio::process::Child,
    pid: Option<u32>,
) -> CommandResult<std::process::ExitStatus> {
    if let Some(pid) = pid {
        let _ = kill_process(pid).await;
    } else {
        let _ = child.kill().await;
    }
    match tokio::time::timeout(
        Duration::from_millis(LEGACY_COMMAND_KILL_GRACE_MS),
        child.wait(),
    )
    .await
    {
        Ok(result) => result
            .map_err(|error| command_error(format!("Failed to stop terminal command: {error}"))),
        Err(_) => {
            let _ = child.kill().await;
            child.wait().await.map_err(|error| {
                command_error(format!("Failed to force-stop terminal command: {error}"))
            })
        }
    }
}

#[cfg(windows)]
async fn stop_legacy_child_tree(
    child: &mut tokio::process::Child,
    job: Option<Arc<WindowsJob>>,
) -> CommandResult<std::process::ExitStatus> {
    if let Some(job) = job {
        job.terminate()?;
    } else {
        child
            .kill()
            .await
            .map_err(|error| command_error(format!("Failed to stop terminal command: {error}")))?;
    }
    child.wait().await.map_err(|error| {
        command_error(format!(
            "Failed to wait for the stopped terminal command: {error}"
        ))
    })
}

pub async fn create_legacy_session_internal(
    workspace_path: PathBuf,
    git_state: GitState,
    terminal_store: TerminalSessionStore,
    project_id: String,
    cwd: Option<String>,
) -> CommandResult<TerminalSessionDto> {
    let metadata_root = resolve_metadata_root(workspace_path.clone(), git_state.clone()).await?;
    let project = resolve_project_target(&workspace_path, &metadata_root, &project_id).await?;
    let session_cwd = resolve_session_cwd(&project.workspace_path, cwd.as_deref(), &git_state)?;

    let session = LegacyTerminalSessionRecord {
        id: format!("terminal-{}", Uuid::new_v4()),
        project_id,
        project_name: project.project_name,
        mount_name: project.mount_name,
        workspace_path: project.workspace_path,
        cwd: session_cwd,
        status: "idle".to_string(),
        last_command: None,
        output: String::new(),
        exit_code: None,
        timed_out: false,
        output_truncated: false,
        updated_at: current_timestamp(),
        pid: None,
        run_in_progress: false,
        kill_requested: false,
        active_execution_id: None,
        pending_kill_execution_id: None,
        execution_generation: 0,
        #[cfg(windows)]
        windows_job: None,
    };

    let dto = session.to_dto();
    terminal_store
        .legacy_sessions
        .lock()
        .await
        .insert(session.id.clone(), session);
    Ok(dto)
}

pub async fn run_legacy_session_internal(
    terminal_store: TerminalSessionStore,
    session_id: String,
    command: String,
    timeout_ms: Option<u64>,
    execution_id: Option<String>,
) -> CommandResult<TerminalSessionDto> {
    let trimmed_command = command.trim();
    if trimmed_command.is_empty() {
        return Err(command_error("Command cannot be empty"));
    }

    let cwd = {
        let mut sessions = terminal_store.legacy_sessions.lock().await;
        let session = sessions
            .get_mut(&session_id)
            .ok_or_else(|| command_error(format!("Unknown terminal session id: {}", session_id)))?;

        if execution_id.is_some()
            && session.pending_kill_execution_id.as_ref() == execution_id.as_ref()
        {
            session.pending_kill_execution_id = None;
            session.status = "killed".to_string();
            session.last_command = Some(trimmed_command.to_string());
            session.output = "[terminal command cancelled before start]\n".to_string();
            session.exit_code = None;
            session.timed_out = false;
            session.output_truncated = false;
            session.updated_at = current_timestamp();
            return Ok(session.to_dto());
        }
        session.pending_kill_execution_id = None;

        if session.run_in_progress || session.kill_requested {
            return Err(command_error(
                "A command is already running in this session",
            ));
        }

        session.status = "running".to_string();
        session.last_command = Some(trimmed_command.to_string());
        session.output.clear();
        session.exit_code = None;
        session.timed_out = false;
        session.output_truncated = false;
        session.run_in_progress = true;
        session.kill_requested = false;
        session.active_execution_id = execution_id.clone();
        session.execution_generation = session.execution_generation.saturating_add(1);
        session.updated_at = current_timestamp();
        session.cwd.clone()
    };
    let mut session_run_guard =
        LegacySessionRunGuard::new(terminal_store.clone(), session_id.clone());

    let mut child = match build_shell_command_compat(trimmed_command, &cwd).spawn() {
        Ok(child) => child,
        Err(error) => {
            let mut sessions = terminal_store.legacy_sessions.lock().await;
            if let Some(session) = sessions.get_mut(&session_id) {
                session.status = "failed".to_string();
                session.run_in_progress = false;
                session.active_execution_id = None;
                session.updated_at = current_timestamp();
            }
            session_run_guard.disarm();
            return Err(command_error(format!(
                "Failed to start terminal command: {}",
                error
            )));
        }
    };
    let pid = child.id();
    #[cfg(windows)]
    let windows_job = match WindowsJob::assign(&child) {
        Ok(job) => Some(job),
        Err(error) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let mut sessions = terminal_store.legacy_sessions.lock().await;
            if let Some(session) = sessions.get_mut(&session_id) {
                session.status = "failed".to_string();
                session.run_in_progress = false;
                session.active_execution_id = None;
                session.updated_at = current_timestamp();
            }
            session_run_guard.disarm();
            return Err(error);
        }
    };
    #[cfg(not(windows))]
    let mut process_guard = LegacyProcessGroupGuard::new(pid);
    #[cfg(windows)]
    let mut process_guard = LegacyProcessGroupGuard::new(windows_job.clone());

    let output = Arc::new(StdMutex::new(BoundedChildOutput::default()));
    let stdout_task = tokio::spawn(read_child_stream(child.stdout.take(), output.clone()));
    let stderr_task = tokio::spawn(read_child_stream(child.stderr.take(), output.clone()));

    let kill_requested_before_registration = {
        let mut sessions = terminal_store.legacy_sessions.lock().await;
        let session = sessions
            .get_mut(&session_id)
            .ok_or_else(|| command_error(format!("Unknown terminal session id: {}", session_id)))?;
        if session.kill_requested {
            true
        } else {
            session.pid = pid;
            #[cfg(windows)]
            {
                session.windows_job = windows_job.clone();
            }
            session.updated_at = current_timestamp();
            false
        }
    };

    let normalized_timeout_ms = normalize_legacy_timeout_ms(timeout_ms);
    let mut timed_out = false;
    let exit_status = if kill_requested_before_registration {
        #[cfg(not(windows))]
        let stopped = stop_legacy_child_tree(&mut child, pid).await?;
        #[cfg(windows)]
        let stopped = stop_legacy_child_tree(&mut child, windows_job.clone()).await?;
        stopped
    } else {
        match tokio::time::timeout(Duration::from_millis(normalized_timeout_ms), child.wait()).await
        {
            Ok(result) => result.map_err(|error| {
                command_error(format!("Failed to wait for terminal command: {}", error))
            })?,
            Err(_) => {
                timed_out = true;
                #[cfg(not(windows))]
                let stopped = stop_legacy_child_tree(&mut child, pid).await?;
                #[cfg(windows)]
                let stopped = stop_legacy_child_tree(&mut child, windows_job.clone()).await?;
                stopped
            }
        }
    };

    let (combined_output, output_truncated, drain_incomplete) =
        finish_child_output(stdout_task, stderr_task, output).await?;
    if drain_incomplete {
        drop(process_guard);
    } else {
        process_guard.disarm();
    }

    let mut sessions = terminal_store.legacy_sessions.lock().await;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| command_error(format!("Unknown terminal session id: {}", session_id)))?;

    let was_killed = session.kill_requested || session.status == "killed";
    session.output = combined_output;
    session.exit_code = exit_status.code();
    session.timed_out = timed_out;
    session.output_truncated = output_truncated;
    session.pid = None;
    session.run_in_progress = false;
    session.kill_requested = false;
    session.active_execution_id = None;
    #[cfg(windows)]
    {
        session.windows_job = None;
    }
    session.updated_at = current_timestamp();
    session.status = if timed_out {
        "timed_out".to_string()
    } else if was_killed {
        "killed".to_string()
    } else if exit_status.success() {
        "completed".to_string()
    } else {
        "failed".to_string()
    };

    let dto = session.to_dto();
    session_run_guard.disarm();
    Ok(dto)
}

pub async fn read_legacy_session_internal(
    terminal_store: TerminalSessionStore,
    session_id: String,
) -> CommandResult<TerminalSessionDto> {
    let sessions = terminal_store.legacy_sessions.lock().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| command_error(format!("Unknown terminal session id: {}", session_id)))?;
    Ok(session.to_dto())
}

pub async fn kill_legacy_session_internal(
    terminal_store: TerminalSessionStore,
    session_id: String,
    execution_id: Option<String>,
) -> CommandResult<TerminalSessionDto> {
    let pid;
    let run_in_progress;
    let execution_generation;
    #[cfg(windows)]
    let windows_job;
    {
        let mut sessions = terminal_store.legacy_sessions.lock().await;
        let session = sessions
            .get_mut(&session_id)
            .ok_or_else(|| command_error(format!("Unknown terminal session id: {}", session_id)))?;

        if let Some(execution_id) = execution_id.as_ref() {
            if !session.run_in_progress {
                session.pending_kill_execution_id = Some(execution_id.clone());
                session.status = "killed".to_string();
                session.updated_at = current_timestamp();
                return Ok(session.to_dto());
            }
            if session.active_execution_id.as_ref() != Some(execution_id) {
                return Ok(session.to_dto());
            }
        }
        session.kill_requested = true;
        session.status = "killed".to_string();
        session.updated_at = current_timestamp();
        pid = session.pid;
        run_in_progress = session.run_in_progress;
        execution_generation = session.execution_generation;
        #[cfg(windows)]
        {
            windows_job = session.windows_job.clone();
        }
    }

    #[cfg(not(windows))]
    if let Some(pid) = pid {
        let _ = kill_process(pid).await;
    }
    #[cfg(windows)]
    if let Some(job) = windows_job {
        let _ = job.terminate();
    } else if let Some(pid) = pid {
        let _ = kill_process(pid).await;
    }

    let mut sessions = terminal_store.legacy_sessions.lock().await;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| command_error(format!("Unknown terminal session id: {}", session_id)))?;
    if session.execution_generation != execution_generation {
        return Ok(session.to_dto());
    }
    session.status = "killed".to_string();
    session.pid = None;
    if pid.is_some() || !run_in_progress {
        session.kill_requested = false;
    }
    #[cfg(windows)]
    {
        session.windows_job = None;
    }
    session.updated_at = current_timestamp();

    Ok(session.to_dto())
}

#[tauri::command]
pub async fn terminal_create_session(
    workspace_root: State<'_, WorkspaceMetadataRoot>,
    git_state: State<'_, GitState>,
    terminal_store: State<'_, TerminalSessionStore>,
    project_id: String,
    cwd: Option<String>,
) -> CommandResult<TerminalSessionDto> {
    let workspace_path = workspace_root.inner().0.read().await.clone();
    create_legacy_session_internal(
        workspace_path,
        git_state.inner().clone(),
        terminal_store.inner().clone(),
        project_id,
        cwd,
    )
    .await
}

#[tauri::command]
pub async fn terminal_run(
    terminal_store: State<'_, TerminalSessionStore>,
    session_id: String,
    command: String,
    timeout_ms: Option<u64>,
    execution_id: Option<String>,
) -> CommandResult<TerminalSessionDto> {
    run_legacy_session_internal(
        terminal_store.inner().clone(),
        session_id,
        command,
        timeout_ms,
        execution_id,
    )
    .await
}

#[tauri::command]
pub async fn terminal_read(
    terminal_store: State<'_, TerminalSessionStore>,
    session_id: String,
) -> CommandResult<TerminalSessionDto> {
    read_legacy_session_internal(terminal_store.inner().clone(), session_id).await
}

#[tauri::command]
pub async fn terminal_kill(
    terminal_store: State<'_, TerminalSessionStore>,
    session_id: String,
    execution_id: Option<String>,
) -> CommandResult<TerminalSessionDto> {
    kill_legacy_session_internal(terminal_store.inner().clone(), session_id, execution_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::metadata::{
        ProjectDto, ProjectGitFlowSettingsDto, ProjectMetadataDto, WorkspaceState,
    };
    use git2::{Repository, Signature};
    use std::collections::HashMap;
    use std::fs;
    use tempfile::TempDir;

    fn env_map(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn legacy_timeout_uses_default_and_caps_explicit_values() {
        assert_eq!(
            normalize_legacy_timeout_ms(None),
            DEFAULT_LEGACY_COMMAND_TIMEOUT_MS
        );
        assert_eq!(
            normalize_legacy_timeout_ms(Some(0)),
            DEFAULT_LEGACY_COMMAND_TIMEOUT_MS
        );
        assert_eq!(normalize_legacy_timeout_ms(Some(42)), 42);
        assert_eq!(
            normalize_legacy_timeout_ms(Some(MAX_LEGACY_COMMAND_TIMEOUT_MS + 1)),
            MAX_LEGACY_COMMAND_TIMEOUT_MS
        );
    }

    #[test]
    fn bounded_legacy_output_retains_head_tail_and_exact_omission() {
        let mut collected = BoundedChildOutput::default();
        collected.push(&vec![b'a'; MAX_LEGACY_COMMAND_OUTPUT_BYTES]);
        collected.push(&vec![b'z'; 128]);

        let (output, truncated) = collected.render(false);
        assert!(truncated);
        assert!(output.starts_with(&"a".repeat(LEGACY_COMMAND_OUTPUT_HEAD_BYTES)));
        assert!(output.contains("terminal output truncated: 128 bytes omitted"));
        assert!(output.contains(&"a".repeat(LEGACY_COMMAND_OUTPUT_HEAD_BYTES)));
        assert!(output.ends_with(&"z".repeat(128)));
        assert!(output.len() <= MAX_LEGACY_COMMAND_OUTPUT_BYTES + 128);
    }

    #[test]
    fn incomplete_legacy_output_drain_is_visible() {
        let mut collected = BoundedChildOutput::default();
        collected.push(b"partial output");

        let (output, truncated) = collected.render(true);
        assert!(truncated);
        assert!(output.starts_with("partial output"));
        assert!(output.ends_with(INCOMPLETE_DRAIN_MARKER));
    }

    fn legacy_test_session(cwd: &Path) -> LegacyTerminalSessionRecord {
        LegacyTerminalSessionRecord {
            id: "terminal-test".to_string(),
            project_id: "project-test".to_string(),
            project_name: "Project Test".to_string(),
            mount_name: "project-test".to_string(),
            workspace_path: cwd.to_path_buf(),
            cwd: cwd.to_path_buf(),
            status: "idle".to_string(),
            last_command: None,
            output: String::new(),
            exit_code: None,
            timed_out: false,
            output_truncated: false,
            updated_at: current_timestamp(),
            pid: None,
            run_in_progress: false,
            kill_requested: false,
            active_execution_id: None,
            pending_kill_execution_id: None,
            execution_generation: 0,
            #[cfg(windows)]
            windows_job: None,
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn killing_an_active_legacy_session_completes_the_pending_run() {
        let temp = TempDir::new().expect("temp dir");
        let terminal_store = TerminalSessionStore::default();
        terminal_store.legacy_sessions.lock().await.insert(
            "terminal-test".to_string(),
            legacy_test_session(temp.path()),
        );

        let run_store = terminal_store.clone();
        let run = tokio::spawn(async move {
            run_legacy_session_internal(
                run_store,
                "terminal-test".to_string(),
                "sleep 30".to_string(),
                Some(60_000),
                Some("execution-test".to_string()),
            )
            .await
        });

        for _ in 0..100 {
            let has_pid = terminal_store
                .legacy_sessions
                .lock()
                .await
                .get("terminal-test")
                .and_then(|session| session.pid)
                .is_some();
            if has_pid {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let killed = kill_legacy_session_internal(
            terminal_store.clone(),
            "terminal-test".to_string(),
            Some("execution-test".to_string()),
        )
        .await
        .expect("kill active session");
        assert_eq!(killed.status, "killed");

        let completed = tokio::time::timeout(Duration::from_secs(10), run)
            .await
            .expect("run should stop after cancellation")
            .expect("run task")
            .expect("run result");
        assert_eq!(completed.status, "killed");
        let session = terminal_store
            .legacy_sessions
            .lock()
            .await
            .get("terminal-test")
            .expect("session")
            .to_dto();
        assert_eq!(session.status, "killed");
    }

    #[tokio::test]
    async fn execution_scoped_kill_before_registration_cancels_only_its_run() {
        let temp = TempDir::new().expect("temp dir");
        let terminal_store = TerminalSessionStore::default();
        terminal_store.legacy_sessions.lock().await.insert(
            "terminal-test".to_string(),
            legacy_test_session(temp.path()),
        );

        let killed = kill_legacy_session_internal(
            terminal_store.clone(),
            "terminal-test".to_string(),
            Some("cancelled-execution".to_string()),
        )
        .await
        .expect("record pending cancellation");
        assert_eq!(killed.status, "killed");

        let cancelled = run_legacy_session_internal(
            terminal_store.clone(),
            "terminal-test".to_string(),
            "printf should-not-run".to_string(),
            Some(5_000),
            Some("cancelled-execution".to_string()),
        )
        .await
        .expect("cancel matching execution");
        assert_eq!(cancelled.status, "killed");
        assert!(cancelled.output.contains("cancelled before start"));

        let completed = run_legacy_session_internal(
            terminal_store,
            "terminal-test".to_string(),
            "printf next-run".to_string(),
            Some(5_000),
            Some("next-execution".to_string()),
        )
        .await
        .expect("run after scoped cancellation");
        assert_eq!(completed.status, "completed");
        assert_eq!(completed.output, "next-run");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn inherited_output_pipes_are_bounded_and_the_process_group_is_reaped() {
        let temp = TempDir::new().expect("temp dir");
        let child_pid_path = temp.path().join("background-child.pid");
        let terminal_store = TerminalSessionStore::default();
        terminal_store.legacy_sessions.lock().await.insert(
            "terminal-test".to_string(),
            legacy_test_session(temp.path()),
        );
        let command = format!(
            "sleep 30 & child=$!; printf '%s' \"$child\" > '{}'",
            child_pid_path.display()
        );

        let completed = tokio::time::timeout(
            Duration::from_secs(10),
            run_legacy_session_internal(
                terminal_store,
                "terminal-test".to_string(),
                command,
                Some(60_000),
                None,
            ),
        )
        .await
        .expect("inherited pipes must not block the session")
        .expect("run result");
        assert!(completed.output_truncated);
        assert!(completed.output.contains("output drain timed out"));

        let child_pid = fs::read_to_string(&child_pid_path)
            .expect("child pid file")
            .parse::<u32>()
            .expect("child pid");
        let child_probe = background_tokio_command("kill")
            .args(["-0", &child_pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .expect("probe child process");
        assert!(!child_probe.success(), "child process {child_pid} survived");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn killing_a_legacy_process_group_removes_its_child() {
        let temp = TempDir::new().expect("temp dir");
        let child_pid_path = temp.path().join("child.pid");
        let command = format!(
            "sleep 30 & child=$!; printf '%s' \"$child\" > '{}'; wait",
            child_pid_path.display()
        );
        let mut process = build_shell_command_compat(&command, temp.path());
        let mut child = process.spawn().expect("spawn process group");
        let parent_pid = child.id().expect("parent pid");

        for _ in 0..100 {
            if fs::read_to_string(&child_pid_path)
                .ok()
                .is_some_and(|value| !value.trim().is_empty())
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let child_pid = fs::read_to_string(&child_pid_path)
            .expect("child pid file")
            .parse::<u32>()
            .expect("child pid");

        kill_process(parent_pid).await.expect("kill process group");
        let _ = child.wait().await;
        let child_probe = background_tokio_command("kill")
            .args(["-0", &child_pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .expect("probe child process");
        assert!(!child_probe.success(), "child process {child_pid} survived");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn terminating_a_windows_job_removes_descendants() {
        let temp = TempDir::new().expect("temp dir");
        let child_pid_path = temp.path().join("child.pid");
        let script = format!(
            "$child = Start-Process powershell -PassThru -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 30'; Set-Content -NoNewline -Path '{}' -Value $child.Id; Wait-Process -Id $child.Id",
            child_pid_path.display()
        );
        let mut command = background_tokio_command("powershell");
        command.args(["-NoProfile", "-Command", &script]);
        let mut child = command.spawn().expect("spawn job root");
        let job = WindowsJob::assign(&child).expect("assign Windows Job Object");

        for _ in 0..100 {
            if child_pid_path.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let descendant_pid = fs::read_to_string(&child_pid_path)
            .expect("descendant pid file")
            .parse::<u32>()
            .expect("descendant pid");

        job.terminate().expect("terminate Windows Job Object");
        tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .expect("job root should exit")
            .expect("wait for job root");
        let output = background_tokio_command("tasklist")
            .args(["/FI", &format!("PID eq {descendant_pid}"), "/NH"])
            .output()
            .await
            .expect("query descendant process");
        let listing = String::from_utf8_lossy(&output.stdout);
        assert!(
            !listing.contains(&descendant_pid.to_string()),
            "descendant process {descendant_pid} survived: {listing}"
        );
    }

    fn terminal_test_project(id: &str, path: &str) -> ProjectDto {
        ProjectDto {
            id: id.to_string(),
            name: id.to_string(),
            mount_name: id.to_string(),
            path: path.to_string(),
            git_flow_settings: ProjectGitFlowSettingsDto {
                base_branch: "main".to_string(),
                main_branch: "main".to_string(),
                completion_merge_policy: "merge_commit".to_string(),
                plan_branch_template: "plan/{planSlug}".to_string(),
                feature_branch_template: "feature/{planSlug}/{featureSlug}".to_string(),
                standalone_feature_branch_template: "feature/{featureSlug}".to_string(),
                release_branch_template: "release/{releaseSlug}".to_string(),
                hotfix_branch_template: "hotfix/{hotfixSlug}".to_string(),
                bugfix_branch_template: "bugfix/{bugfixSlug}".to_string(),
            },
            created_at: "2026-06-05T00:00:00.000Z".to_string(),
            status: "active".to_string(),
            user_read_only: false,
            git_setup_state: "ready".to_string(),
            is_read_only: false,
            read_only_reason: None,
            path_kind: "windows".to_string(),
            wsl_distro: None,
            wsl_linux_path: None,
            metadata: ProjectMetadataDto {
                description: String::new(),
                tags: Vec::new(),
                team_members: Vec::new(),
                api_contracts: Vec::new(),
                dependencies: Vec::new(),
            },
        }
    }

    #[tokio::test]
    async fn resolve_project_target_accepts_standalone_project() {
        let temp = TempDir::new().expect("temp dir");
        let project_dir = temp.path().join("octan_sales");
        fs::create_dir_all(&project_dir).expect("project dir");
        let repo = Repository::init(&project_dir).expect("git repo");
        fs::write(project_dir.join("README.md"), "ready\n").expect("readme");
        let mut index = repo.index().expect("index");
        index.add_path(Path::new("README.md")).expect("add readme");
        let tree_id = index.write_tree().expect("write tree");
        let tree = repo.find_tree(tree_id).expect("tree");
        let signature = Signature::now("Macro Test", "macro@example.test").expect("signature");
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "Initial commit",
            &tree,
            &[],
        )
        .expect("initial commit");
        let state = WorkspaceState {
            standalone_projects: vec![terminal_test_project("project-octan-sales", "octan_sales")],
            ..WorkspaceState::default()
        };
        fs::write(
            temp.path().join("workspace.json"),
            serde_json::to_vec_pretty(&state).expect("serialize state"),
        )
        .expect("write workspace state");

        let target = resolve_project_target(temp.path(), temp.path(), "project-octan-sales")
            .await
            .expect("standalone project target");

        assert_eq!(target.project_name, "project-octan-sales");
        assert_eq!(target.workspace_path, project_dir.canonicalize().unwrap());
    }

    #[test]
    fn terminal_environment_supplies_pty_defaults() {
        let env = build_terminal_environment_from("/repo/app", Some("/bin/zsh"), |_| None)
            .into_iter()
            .collect::<HashMap<_, _>>();

        assert_eq!(env.get("TERM").map(String::as_str), Some(DEFAULT_TERM));
        assert_eq!(
            env.get("COLORTERM").map(String::as_str),
            Some(DEFAULT_COLORTERM)
        );
        assert_eq!(
            env.get("TERM_PROGRAM").map(String::as_str),
            Some(TERM_PROGRAM_NAME)
        );
        assert_eq!(env.get("PWD").map(String::as_str), Some("/repo/app"));
        assert_eq!(env.get("SHELL").map(String::as_str), Some("/bin/zsh"));
    }

    #[test]
    fn terminal_environment_preserves_existing_terminal_values() {
        let source = env_map(&[
            ("TERM", "screen-256color"),
            ("COLORTERM", "24bit"),
            ("TERM_PROGRAM", "UserTerminal"),
        ]);
        let env = build_terminal_environment_from("/repo/app", Some("/bin/bash"), |key| {
            source.get(key).cloned()
        })
        .into_iter()
        .collect::<HashMap<_, _>>();

        assert_eq!(env.get("TERM").map(String::as_str), Some("screen-256color"));
        assert_eq!(env.get("COLORTERM").map(String::as_str), Some("24bit"));
        assert_eq!(
            env.get("TERM_PROGRAM").map(String::as_str),
            Some("UserTerminal")
        );
        assert_eq!(env.get("PWD").map(String::as_str), Some("/repo/app"));
        assert_eq!(env.get("SHELL").map(String::as_str), Some("/bin/bash"));
    }

    #[test]
    fn terminal_environment_ignores_blank_terminal_values() {
        let source = env_map(&[("TERM", "   "), ("COLORTERM", ""), ("TERM_PROGRAM", "\t")]);
        let env =
            build_terminal_environment_from("/repo/app", None, |key| source.get(key).cloned())
                .into_iter()
                .collect::<HashMap<_, _>>();

        assert_eq!(env.get("TERM").map(String::as_str), Some(DEFAULT_TERM));
        assert_eq!(
            env.get("COLORTERM").map(String::as_str),
            Some(DEFAULT_COLORTERM)
        );
        assert_eq!(
            env.get("TERM_PROGRAM").map(String::as_str),
            Some(TERM_PROGRAM_NAME)
        );
        assert_eq!(env.get("SHELL"), None);
    }

    #[test]
    #[cfg(not(windows))]
    fn resolves_shell_from_absolute_executable_shell_env() {
        let source = env_map(&[("SHELL", "/bin/zsh")]);
        let shell = resolve_unix_shell_from(|key| source.get(key).cloned(), || None, &|path| {
            path == Path::new("/bin/zsh")
        });

        assert_eq!(
            shell,
            UnixShellSpec {
                path: "/bin/zsh".to_string(),
                kind: UnixShellKind::Zsh,
            }
        );
    }

    #[test]
    #[cfg(not(windows))]
    fn resolves_fish_shell_from_shell_env() {
        let source = env_map(&[("SHELL", "/opt/homebrew/bin/fish")]);
        let shell = resolve_unix_shell_from(|key| source.get(key).cloned(), || None, &|path| {
            path == Path::new("/opt/homebrew/bin/fish")
        });

        assert_eq!(
            shell,
            UnixShellSpec {
                path: "/opt/homebrew/bin/fish".to_string(),
                kind: UnixShellKind::Fish,
            }
        );
    }

    #[test]
    #[cfg(not(windows))]
    fn resolves_shell_from_passwd_when_shell_env_is_invalid() {
        let source = env_map(&[("SHELL", "zsh"), ("USER", "oscar")]);
        let shell = resolve_unix_shell_from(
            |key| source.get(key).cloned(),
            || {
                Some("root:x:0:0:root:/root:/bin/bash\noscar:x:501:20:Oscar:/Users/oscar:/bin/bash\n".to_string())
            },
            &|path| path == Path::new("/bin/bash"),
        );

        assert_eq!(
            shell,
            UnixShellSpec {
                path: "/bin/bash".to_string(),
                kind: UnixShellKind::Bash,
            }
        );
    }

    #[test]
    #[cfg(not(windows))]
    fn resolves_shell_from_fallbacks_when_user_shell_is_unavailable() {
        let source = env_map(&[("SHELL", "/missing/zsh"), ("USER", "oscar")]);
        let shell = resolve_unix_shell_from(
            |key| source.get(key).cloned(),
            || Some("oscar:x:501:20:Oscar:/Users/oscar:/missing/bash\n".to_string()),
            &|path| path == Path::new("/bin/sh"),
        );

        assert_eq!(
            shell,
            UnixShellSpec {
                path: "/bin/sh".to_string(),
                kind: UnixShellKind::Posix,
            }
        );
    }

    #[test]
    #[cfg(not(windows))]
    fn fish_prompt_command_escapes_prompt_for_double_quotes() {
        assert_eq!(
            fish_double_quote_escape(r#"api "$HOME" \ ` > "#),
            r#"api \"\$HOME\" \\ \` > "#
        );
    }

    #[test]
    #[cfg(not(windows))]
    fn bash_launch_config_keeps_isolated_interactive_args_and_silences_macos_warning() {
        let config = build_unix_shell_launch_config(
            &UnixShellSpec {
                path: "/bin/bash".to_string(),
                kind: UnixShellKind::Bash,
            },
            "api > ",
        );

        assert_eq!(config.args, ["--noprofile", "--norc", "-i"]);
        let env = config.env.into_iter().collect::<HashMap<_, _>>();
        assert_eq!(env.get("PS1").map(String::as_str), Some("api > "));
        assert_eq!(env.get("PROMPT_COMMAND").map(String::as_str), Some(""));
        assert_eq!(
            env.get("BASH_SILENCE_DEPRECATION_WARNING")
                .map(String::as_str),
            Some("1")
        );
    }

    #[test]
    #[cfg(not(windows))]
    fn zsh_launch_config_uses_fast_interactive_mode_with_macro_prompt() {
        let config = build_unix_shell_launch_config(
            &UnixShellSpec {
                path: "/bin/zsh".to_string(),
                kind: UnixShellKind::Zsh,
            },
            "api > ",
        );

        assert_eq!(config.args, ["-f", "-i"]);
        let env = config.env.into_iter().collect::<HashMap<_, _>>();
        assert_eq!(env.get("PS1").map(String::as_str), Some("api > "));
        assert_eq!(env.get("PROMPT").map(String::as_str), Some("api > "));
    }

    #[test]
    #[cfg(not(windows))]
    fn fish_launch_config_sets_prompt_with_init_command() {
        let config = build_unix_shell_launch_config(
            &UnixShellSpec {
                path: "/opt/homebrew/bin/fish".to_string(),
                kind: UnixShellKind::Fish,
            },
            r#"api "$HOME" > "#,
        );

        assert_eq!(config.args[0], "-i");
        assert_eq!(config.args[1], "-C");
        assert_eq!(
            config.args[2],
            r#"function fish_prompt; printf "%s" "api \"\$HOME\" > "; end"#
        );
        assert!(config.env.is_empty());
    }

    #[test]
    #[cfg(not(windows))]
    fn managed_unix_command_is_single_line() {
        let marker = "__MACRO_CMD_DONE__test__";
        let wrapper = build_managed_command(
            "flutter install; flutter run -d macos",
            marker,
            ManagedShellKind::Posix,
        );

        assert_eq!(wrapper.matches('\n').count(), 1);
        assert!(wrapper.ends_with('\n'));
        assert!(!wrapper.contains("{\n"));
        assert!(!wrapper.contains("}\n"));
        assert!(!wrapper.contains("__macro_exit"));
        assert!(wrapper.contains("eval"));
        assert!(wrapper.contains(marker));
    }

    #[test]
    #[cfg(not(windows))]
    fn managed_unix_command_escapes_quotes_and_newlines() {
        let marker = "__MACRO_CMD_DONE__test__";
        let command = "printf 'a b'; echo \"x\"\necho second";
        let wrapper = build_managed_command(command, marker, ManagedShellKind::Posix);

        assert_eq!(wrapper.matches('\n').count(), 1);
        assert!(wrapper.contains("\\n"));
        assert!(!wrapper.contains("echo \"x\"\necho second"));
        assert!(wrapper.contains("'\\''a b'\\''"));
    }

    #[test]
    #[cfg(not(windows))]
    fn pending_output_strips_echoed_wrapper_before_marker_parsing() {
        let marker = "__MACRO_CMD_DONE__test__";
        let wrapper = build_managed_command("echo ok", marker, ManagedShellKind::Posix);
        let echoed_wrapper = wrapper.replace('\n', "\r\n");
        let mut pending = PendingCommand {
            marker_prefix: marker.to_string(),
            echoed_command: Some(wrapper),
            visible_command: "echo ok".to_string(),
            completion_tx: None,
        };
        let chunk = format!("{echoed_wrapper}real output\r\n{marker}0__\r\n> ");

        let extraction = extract_pending_visible_output("", &chunk, &mut pending);

        assert_eq!(extraction.completed_exit_code, Some(0));
        assert!(extraction.visible_output.contains("real output"));
        assert!(!extraction.visible_output.contains(marker));
        assert!(!extraction.visible_output.contains("printf"));
        assert!(pending.echoed_command.is_none());
    }

    #[test]
    fn pending_output_holds_split_marker_without_leaking_it() {
        let marker = "__MACRO_CMD_DONE__test__";
        let mut pending = PendingCommand {
            marker_prefix: marker.to_string(),
            echoed_command: None,
            visible_command: "echo ok".to_string(),
            completion_tx: None,
        };

        let first =
            extract_pending_visible_output("", &format!("real output\n{marker}"), &mut pending);
        assert_eq!(first.completed_exit_code, None);
        assert!(!first.visible_output.contains(marker));
        assert!(!first.scan_buffer.is_empty());

        let second = extract_pending_visible_output(&first.scan_buffer, "0__\n> ", &mut pending);
        assert_eq!(second.completed_exit_code, Some(0));
        assert!(!second.visible_output.contains(marker));
        assert!(
            format!("{}{}", first.visible_output, second.visible_output).contains("real output")
        );
    }

    #[test]
    fn pending_output_does_not_hold_interactive_prompts() {
        let marker = "__MACRO_CMD_DONE__test__";
        let mut pending = PendingCommand {
            marker_prefix: marker.to_string(),
            echoed_command: None,
            visible_command: "flutter install; flutter run -d macos".to_string(),
            completion_tx: None,
        };
        let prompt = "Please choose one (or \"q\" to quit): ";

        let extraction = extract_pending_visible_output("", prompt, &mut pending);

        assert_eq!(extraction.visible_output, prompt);
        assert!(extraction.scan_buffer.is_empty());
        assert_eq!(extraction.completed_exit_code, None);
    }

    #[test]
    fn command_marker_parser_skips_non_exit_marker_echoes() {
        let marker = "__MACRO_CMD_DONE__test__";
        let buffer = format!("printf '{}%s__\\n'\nreal\n{}7__", marker, marker);

        let parsed = parse_command_marker(&buffer, marker);

        assert_eq!(parsed.map(|(_, _, exit_code)| exit_code), Some(7));
    }
}
