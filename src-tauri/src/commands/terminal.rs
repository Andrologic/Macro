use crate::commands::{command_error, CommandResult};
use crate::git::GitState;
use crate::workspace;
use crate::WorkspaceMetadataRoot;
use chrono::Utc;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tauri::State;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Clone, Default)]
pub struct TerminalSessionStore {
    sessions: Arc<Mutex<HashMap<String, TerminalSessionRecord>>>,
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

struct TerminalSessionRecord {
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

impl TerminalSessionRecord {
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

fn build_shell_command(command: &str, cwd: &Path) -> Command {
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

    let session = TerminalSessionRecord {
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
        updated_at: Utc::now().to_rfc3339(),
        pid: None,
    };

    let dto = session.to_dto();
    terminal_store
        .sessions
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
        let mut sessions = terminal_store.sessions.lock().await;
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
        session.updated_at = Utc::now().to_rfc3339();
        session.cwd.clone()
    };

    let mut child = build_shell_command(trimmed_command, &cwd)
        .spawn()
        .map_err(|error| command_error(format!("Failed to start terminal command: {}", error)))?;
    let pid = child.id();

    {
        let mut sessions = terminal_store.sessions.lock().await;
        let session = sessions
            .get_mut(&session_id)
            .ok_or_else(|| command_error(format!("Unknown terminal session id: {}", session_id)))?;
        session.pid = pid;
        session.updated_at = Utc::now().to_rfc3339();
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

    let mut sessions = terminal_store.sessions.lock().await;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| command_error(format!("Unknown terminal session id: {}", session_id)))?;

    let was_killed = session.status == "killed";
    session.output = combined_output;
    session.exit_code = exit_status.code();
    session.timed_out = timed_out;
    session.pid = None;
    session.updated_at = Utc::now().to_rfc3339();
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
    let sessions = terminal_store.sessions.lock().await;
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
        let sessions = terminal_store.sessions.lock().await;
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| command_error(format!("Unknown terminal session id: {}", session_id)))?;
        session.pid
    };

    if let Some(pid) = pid {
        let _ = kill_process(pid).await;
    }

    let mut sessions = terminal_store.sessions.lock().await;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| command_error(format!("Unknown terminal session id: {}", session_id)))?;
    session.status = "killed".to_string();
    session.pid = None;
    session.updated_at = Utc::now().to_rfc3339();

    Ok(session.to_dto())
}
