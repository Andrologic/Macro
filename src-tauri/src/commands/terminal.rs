use crate::commands::{command_error, CommandResult, DbPool};
use crate::db::{models::TerminalTabRecord, repository};
use crate::git::GitState;
use crate::workspace;
use crate::WorkspaceMetadataRoot;
use chrono::Utc;
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

const DEFAULT_TERMINAL_COLS: u16 = 120;
const DEFAULT_TERMINAL_ROWS: u16 = 32;
const MAX_TERMINAL_SNAPSHOT_BYTES: usize = 1_000_000;
const OUTPUT_FLUSH_DELAY_MS: u64 = 16;

#[derive(Clone, Default)]
pub struct TerminalSessionStore {
    legacy_sessions: Arc<Mutex<HashMap<String, LegacyTerminalSessionRecord>>>,
    live_tabs: Arc<Mutex<HashMap<String, LiveTerminalSession>>>,
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
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
struct TerminalOutputEvent {
    tab_id: String,
    data: String,
    snapshot: String,
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
    scan_buffer: String,
    pending_command: Option<PendingCommand>,
    pending_output: String,
    output_flush_scheduled: bool,
}

struct PendingCommand {
    marker_prefix: String,
    completion_tx: Option<oneshot::Sender<i32>>,
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
    updated_at: String,
    pid: Option<u32>,
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
            updated_at: self.updated_at.clone(),
        }
    }
}

fn current_timestamp() -> String {
    Utc::now().to_rfc3339()
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

fn stored_tab_to_dto(record: &TerminalTabRecord, has_live_session: bool) -> TerminalTabDto {
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
        created_at: record.created_at.clone(),
        updated_at: record.updated_at.clone(),
    }
}

async fn load_db_pool(pool: &State<'_, DbPool>) -> CommandResult<sqlx::SqlitePool> {
    let guard = pool.lock().await;
    guard
        .as_ref()
        .cloned()
        .ok_or_else(|| command_error("Database not initialized"))
}

async fn resolve_metadata_root(
    workspace_path: PathBuf,
    git_state: GitState,
) -> CommandResult<PathBuf> {
    tokio::task::spawn_blocking(move || {
        git_state
            .resolve_macro_metadata_root(&workspace_path)
            .map_err(|error| command_error(error.to_string()))
    })
    .await
    .map_err(|error| command_error(format!("Metadata root task failed: {}", error)))?
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
    workspace_path: &PathBuf,
    metadata_root: &PathBuf,
    project_id: &str,
) -> CommandResult<ProjectTerminalTarget> {
    let groups = workspace::list_projects(workspace_path, metadata_root)
        .await
        .map_err(|error| command_error(error.to_string()))?;

    let project = groups
        .iter()
        .flat_map(|group| group.projects.iter())
        .find(|project| project.id == project_id)
        .ok_or_else(|| command_error(format!("Unknown project id: {}", project_id)))?;

    let workspace_path =
        canonicalize_existing_dir(&resolve_project_path(workspace_path, &project.path))?;

    Ok(ProjectTerminalTarget {
        project_name: project.name.clone(),
        mount_name: project.mount_name.clone(),
        workspace_path,
    })
}

fn is_within(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}

fn resolve_session_cwd(
    project_root: &Path,
    cwd: Option<&str>,
    git_state: &GitState,
) -> CommandResult<PathBuf> {
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
        "cwd must remain inside the selected subproject or a valid worktree: {}",
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
        created_at: now.clone(),
        updated_at: now,
    }
}

fn reader_holdback_len(marker_prefix: &str) -> usize {
    marker_prefix.len() + 16
}

fn parse_command_marker(buffer: &str, marker_prefix: &str) -> Option<(usize, usize, i32)> {
    let start = buffer.find(marker_prefix)?;
    let after_start = start + marker_prefix.len();
    let suffix = &buffer[after_start..];
    let end_rel = suffix.find("__")?;
    let exit_code = suffix[..end_rel].parse::<i32>().ok()?;
    let end = after_start + end_rel + 2;
    Some((start, end, exit_code))
}

#[cfg(windows)]
fn build_shell_command(record: &TerminalTabRecord) -> CommandBuilder {
    let mut command = CommandBuilder::new("powershell");
    command.arg("-NoLogo");
    command.arg("-NoProfile");
    command.arg("-NoExit");
    command.arg("-Command");
    command.arg(
        "function global:prompt { $env:MACRO_TERMINAL_PROMPT }; Set-Location -LiteralPath $env:MACRO_TERMINAL_CWD",
    );
    command.cwd(Path::new(&record.cwd));
    command.env("MACRO_TERMINAL_CWD", &record.cwd);
    command.env("MACRO_TERMINAL_PROMPT", render_terminal_prompt(record));
    command
}

#[cfg(not(windows))]
fn build_shell_command(record: &TerminalTabRecord) -> CommandBuilder {
    let mut command = CommandBuilder::new("bash");
    command.arg("--noprofile");
    command.arg("--norc");
    command.arg("-i");
    command.cwd(Path::new(&record.cwd));
    command.env("PS1", render_terminal_prompt(record));
    command.env("PROMPT_COMMAND", "");
    command
}

#[cfg(windows)]
fn build_managed_command(command: &str, marker_prefix: &str) -> String {
    format!(
        "& {{\r\n{}\r\n$__macroExit = if ($LASTEXITCODE -ne $null) {{ [int]$LASTEXITCODE }} elseif ($?) {{ 0 }} else {{ 1 }}\r\nWrite-Output \"{}$($__macroExit)__\"\r\n}}\r\n",
        command, marker_prefix
    )
}

#[cfg(not(windows))]
fn build_managed_command(command: &str, marker_prefix: &str) -> String {
    format!(
        "{{\n{}\n}}\n__macro_exit=$?\nprintf '{}%s__\\n' \"$__macro_exit\"\n",
        command, marker_prefix
    )
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
        runtime_guard.record.updated_at = current_timestamp();
        let dto = stored_tab_to_dto(&runtime_guard.record, true);
        (dto, runtime_guard.record.clone())
    };

    emit_tab_update(app_handle, &record_to_persist, true);
    persist_terminal_tab_record(db_pool, record_to_persist).await;

    Ok(Some(dto))
}

async fn persist_terminal_tab_record(db_pool: DbPool, record: TerminalTabRecord) {
    let pool = {
        let guard = db_pool.lock().await;
        guard.as_ref().cloned()
    };

    if let Some(pool) = pool {
        let _ = repository::upsert_terminal_tab(&pool, &record).await;
    }
}

fn emit_tab_update(app_handle: &AppHandle, record: &TerminalTabRecord, has_live_session: bool) {
    let _ = app_handle.emit("terminal:tab", stored_tab_to_dto(record, has_live_session));
}

fn emit_output(app_handle: &AppHandle, record: &TerminalTabRecord, data: String) {
    if data.is_empty() {
        return;
    }

    let _ = app_handle.emit(
        "terminal:output",
        TerminalOutputEvent {
            tab_id: record.id.clone(),
            data,
            snapshot: record.snapshot.clone(),
            updated_at: record.updated_at.clone(),
        },
    );
}

fn take_pending_output_batch(
    runtime: &mut LiveTerminalRuntime,
) -> Option<(String, TerminalTabRecord)> {
    runtime.output_flush_scheduled = false;
    if runtime.pending_output.is_empty() {
        return None;
    }

    Some((
        std::mem::take(&mut runtime.pending_output),
        runtime.record.clone(),
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

    if let Some((data, record)) = maybe_batch {
        emit_output(&app_handle, &record, data);
        persist_terminal_tab_record(db_pool, record).await;
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
    let (record, should_schedule_output_flush, should_force_output_flush) = {
        let mut runtime_guard = runtime.blocking_lock();
        if let Some(mut pending) = runtime_guard.pending_command.take() {
            let combined = format!("{}{}", runtime_guard.scan_buffer, chunk);
            if let Some((start, end, exit_code)) =
                parse_command_marker(&combined, &pending.marker_prefix)
            {
                visible_output.push_str(&combined[..start]);
                visible_output.push_str(&combined[end..]);
                runtime_guard.scan_buffer.clear();
                completed_exit_code = Some(exit_code);
                completion_tx = pending.completion_tx.take();
            } else {
                let holdback = reader_holdback_len(&pending.marker_prefix);
                let split_at = combined.len().saturating_sub(holdback);
                visible_output.push_str(&combined[..split_at]);
                runtime_guard.scan_buffer = combined[split_at..].to_string();
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
            runtime_guard.record.updated_at = current_timestamp();
        }

        if let Some(exit_code) = completed_exit_code {
            runtime_guard.record.status = "idle".to_string();
            runtime_guard.record.last_exit_code = Some(exit_code);
            runtime_guard.record.updated_at = current_timestamp();
        }

        let should_schedule_output_flush =
            !visible_output.is_empty() && !runtime_guard.output_flush_scheduled;
        let should_force_output_flush = !visible_output.is_empty() && completed_exit_code.is_some();
        if should_schedule_output_flush {
            runtime_guard.output_flush_scheduled = true;
        }

        (
            runtime_guard.record.clone(),
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
        emit_tab_update(&app_handle, &record, true);
    }

    if completed_exit_code.is_some() && visible_output.is_empty() {
        let record_for_persist = record.clone();
        tauri::async_runtime::spawn(async move {
            persist_terminal_tab_record(db_pool, record_for_persist).await;
        });
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
    {
        let mut live_tabs = terminal_store.live_tabs.blocking_lock();
        live_tabs.remove(&tab_id);
    }

    let mut completion_tx: Option<oneshot::Sender<i32>> = None;
    let (pending_output_batch, maybe_record) = {
        let mut runtime_guard = runtime.blocking_lock();
        let pending_output_batch = take_pending_output_batch(&mut runtime_guard);
        if runtime_guard.record.status == "closed" {
            (pending_output_batch, None)
        } else {
            if let Some(pending) = runtime_guard.pending_command.as_mut() {
                completion_tx = pending.completion_tx.take();
            }
            runtime_guard.pending_command = None;
            runtime_guard.record.status = "disconnected".to_string();
            runtime_guard.record.updated_at = current_timestamp();
            (pending_output_batch, Some(runtime_guard.record.clone()))
        }
    };

    if let Some((data, record)) = pending_output_batch {
        emit_output(&app_handle, &record, data);
    }

    if let Some(record) = maybe_record {
        emit_tab_update(&app_handle, &record, false);
        let record_for_persist = record.clone();
        tauri::async_runtime::spawn(async move {
            persist_terminal_tab_record(db_pool, record_for_persist).await;
        });
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

    let shell_command = build_shell_command(&record);
    let child = pair
        .slave
        .spawn_command(shell_command)
        .map_err(|error| command_error(format!("Failed to launch terminal shell: {}", error)))?;
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|error| command_error(format!("Failed to open terminal writer: {}", error)))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| command_error(format!("Failed to open terminal reader: {}", error)))?;

    record.status = "idle".to_string();
    record.updated_at = current_timestamp();

    let runtime = Arc::new(Mutex::new(LiveTerminalRuntime {
        record: record.clone(),
        scan_buffer: String::new(),
        pending_command: None,
        pending_output: String::new(),
        output_flush_scheduled: false,
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

    emit_tab_update(&app_handle, &record, true);
    persist_terminal_tab_record(db_pool.clone(), record.clone()).await;
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

fn build_shell_command_compat(command: &str, cwd: &Path) -> Command {
    #[cfg(windows)]
    let mut process = {
        let mut process = Command::new("powershell");
        process.args(["-NoLogo", "-NoProfile", "-Command", command]);
        process
    };

    #[cfg(not(windows))]
    let mut process = {
        let mut process = Command::new("bash");
        process.args(["-lc", command]);
        process
    };

    process
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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

    let db_pool = load_db_pool(&pool).await?;
    repository::upsert_terminal_tab(&db_pool, &record)
        .await
        .map_err(|error| command_error(error.to_string()))?;

    spawn_live_tab(app_handle, pool.inner().clone(), &terminal_store, record).await
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
    record.updated_at = current_timestamp();
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
    record.updated_at = current_timestamp();
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
    let wrapped_command = build_managed_command(trimmed_command, &marker_prefix);
    let db_pool_state = pool.inner().clone();
    let completion_rx = {
        let mut runtime_guard = runtime.lock().await;
        if runtime_guard.pending_command.is_some() {
            return Err(command_error(
                "A managed command is already running in this terminal tab",
            ));
        }

        let (completion_tx, completion_rx) = oneshot::channel();
        runtime_guard.record.status = "running".to_string();
        runtime_guard.record.last_command = Some(trimmed_command.to_string());
        runtime_guard.record.updated_at = current_timestamp();
        runtime_guard.pending_command = Some(PendingCommand {
            marker_prefix: marker_prefix.clone(),
            completion_tx: Some(completion_tx),
        });
        emit_tab_update(&app_handle, &runtime_guard.record, true);
        let record_for_persist = runtime_guard.record.clone();
        let db_pool = db_pool_state.clone();
        tauri::async_runtime::spawn(async move {
            persist_terminal_tab_record(db_pool, record_for_persist).await;
        });
        completion_rx
    };

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
        runtime_guard.record.updated_at = current_timestamp();
        emit_tab_update(&app_handle, &runtime_guard.record, true);
        let record_for_persist = runtime_guard.record.clone();
        let db_pool = db_pool_state.clone();
        tauri::async_runtime::spawn(async move {
            persist_terminal_tab_record(db_pool, record_for_persist).await;
        });
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
        let completion = runtime_guard
            .pending_command
            .as_mut()
            .and_then(|pending| pending.completion_tx.take());
        runtime_guard.pending_command = None;
        runtime_guard.record.status = "idle".to_string();
        runtime_guard.record.last_exit_code = Some(130);
        runtime_guard.record.updated_at = current_timestamp();
        let dto = stored_tab_to_dto(&runtime_guard.record, true);
        emit_tab_update(&app_handle, &runtime_guard.record, true);
        let record_for_persist = runtime_guard.record.clone();
        let db_pool = db_pool_state.clone();
        tauri::async_runtime::spawn(async move {
            persist_terminal_tab_record(db_pool, record_for_persist).await;
        });
        (completion, dto)
    };

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
        runtime_guard.record.updated_at = current_timestamp();
        emit_tab_update(&app_handle, &runtime_guard.record, true);
        let record_for_persist = runtime_guard.record.clone();
        let db_pool = pool.inner().clone();
        tauri::async_runtime::spawn(async move {
            persist_terminal_tab_record(db_pool, record_for_persist).await;
        });
        return Ok(stored_tab_to_dto(&runtime_guard.record, true));
    }

    let db_pool = load_db_pool(&pool).await?;
    let mut record = repository::get_terminal_tab(&db_pool, &tab_id)
        .await
        .map_err(|error| command_error(error.to_string()))?
        .ok_or_else(|| command_error(format!("Unknown terminal tab id: {}", tab_id)))?;
    record.snapshot.clear();
    record.updated_at = current_timestamp();
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
        {
            let mut runtime_guard = session.runtime.lock().await;
            runtime_guard.record.status = "closed".to_string();
            runtime_guard.record.updated_at = current_timestamp();
            if let Some(pending) = runtime_guard.pending_command.as_mut() {
                if let Some(completion) = pending.completion_tx.take() {
                    let _ = completion.send(130);
                }
            }
            runtime_guard.pending_command = None;
        }

        let child = session.child.clone();
        let _ = tokio::task::spawn_blocking(move || {
            if let Ok(mut guard) = child.lock() {
                let _ = guard.kill();
            }
        })
        .await;
    }

    let db_pool = load_db_pool(&pool).await?;
    repository::delete_terminal_tab(&db_pool, &tab_id)
        .await
        .map_err(|error| command_error(error.to_string()))?;
    let _ = app_handle.emit("terminal:closed", TerminalClosedEvent { tab_id });
    Ok(())
}

async fn kill_process(pid: u32) -> CommandResult<()> {
    #[cfg(windows)]
    let status = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status()
        .await
        .map_err(|error| command_error(format!("Failed to kill process {}: {}", pid, error)))?;

    #[cfg(not(windows))]
    let status = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .await
        .map_err(|error| command_error(format!("Failed to kill process {}: {}", pid, error)))?;

    if !status.success() {
        return Err(command_error(format!(
            "Failed to kill process {} (status: {})",
            pid, status
        )));
    }

    Ok(())
}

async fn read_child_stream<T>(stream: Option<T>) -> CommandResult<String>
where
    T: tokio::io::AsyncRead + Unpin,
{
    let Some(mut stream) = stream else {
        return Ok(String::new());
    };

    let mut bytes = Vec::new();
    stream
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| command_error(format!("Failed to read terminal output: {}", error)))?;

    Ok(String::from_utf8_lossy(&bytes).to_string())
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
    let metadata_root =
        resolve_metadata_root(workspace_path.clone(), git_state.inner().clone()).await?;
    let project = resolve_project_target(&workspace_path, &metadata_root, &project_id).await?;
    let session_cwd =
        resolve_session_cwd(&project.workspace_path, cwd.as_deref(), git_state.inner())?;

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
        updated_at: current_timestamp(),
        pid: None,
    };

    let dto = session.to_dto();
    terminal_store
        .legacy_sessions
        .lock()
        .await
        .insert(session.id.clone(), session);
    Ok(dto)
}

#[tauri::command]
pub async fn terminal_run(
    terminal_store: State<'_, TerminalSessionStore>,
    session_id: String,
    command: String,
    timeout_ms: Option<u64>,
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

        if session.pid.is_some() {
            return Err(command_error(
                "A command is already running in this session",
            ));
        }

        session.status = "running".to_string();
        session.last_command = Some(trimmed_command.to_string());
        session.output.clear();
        session.exit_code = None;
        session.timed_out = false;
        session.updated_at = current_timestamp();
        session.cwd.clone()
    };

    let mut child = build_shell_command_compat(trimmed_command, &cwd)
        .spawn()
        .map_err(|error| command_error(format!("Failed to start terminal command: {}", error)))?;
    let pid = child.id();

    {
        let mut sessions = terminal_store.legacy_sessions.lock().await;
        let session = sessions
            .get_mut(&session_id)
            .ok_or_else(|| command_error(format!("Unknown terminal session id: {}", session_id)))?;
        session.pid = pid;
        session.updated_at = current_timestamp();
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_task = tokio::spawn(read_child_stream(stdout));
    let stderr_task = tokio::spawn(read_child_stream(stderr));

    let mut timed_out = false;
    let exit_status = if let Some(timeout_ms) = timeout_ms.filter(|value| *value > 0) {
        match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), child.wait()).await
        {
            Ok(result) => result.map_err(|error| {
                command_error(format!("Failed to wait for terminal command: {}", error))
            })?,
            Err(_) => {
                timed_out = true;
                let _ = child.kill().await;
                child.wait().await.map_err(|error| {
                    command_error(format!("Failed to stop terminal command: {}", error))
                })?
            }
        }
    } else {
        child.wait().await.map_err(|error| {
            command_error(format!("Failed to wait for terminal command: {}", error))
        })?
    };

    let stdout_output = stdout_task
        .await
        .map_err(|error| command_error(format!("Terminal stdout task failed: {}", error)))??;
    let stderr_output = stderr_task
        .await
        .map_err(|error| command_error(format!("Terminal stderr task failed: {}", error)))??;
    let combined_output = format!("{}{}", stdout_output, stderr_output);

    let mut sessions = terminal_store.legacy_sessions.lock().await;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| command_error(format!("Unknown terminal session id: {}", session_id)))?;

    let was_killed = session.status == "killed";
    session.output = combined_output;
    session.exit_code = exit_status.code();
    session.timed_out = timed_out;
    session.pid = None;
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

    Ok(session.to_dto())
}

#[tauri::command]
pub async fn terminal_read(
    terminal_store: State<'_, TerminalSessionStore>,
    session_id: String,
) -> CommandResult<TerminalSessionDto> {
    let sessions = terminal_store.legacy_sessions.lock().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| command_error(format!("Unknown terminal session id: {}", session_id)))?;
    Ok(session.to_dto())
}

#[tauri::command]
pub async fn terminal_kill(
    terminal_store: State<'_, TerminalSessionStore>,
    session_id: String,
) -> CommandResult<TerminalSessionDto> {
    let pid = {
        let sessions = terminal_store.legacy_sessions.lock().await;
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| command_error(format!("Unknown terminal session id: {}", session_id)))?;
        session.pid
    };

    if let Some(pid) = pid {
        let _ = kill_process(pid).await;
    }

    let mut sessions = terminal_store.legacy_sessions.lock().await;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| command_error(format!("Unknown terminal session id: {}", session_id)))?;
    session.status = "killed".to_string();
    session.pid = None;
    session.updated_at = current_timestamp();

    Ok(session.to_dto())
}
