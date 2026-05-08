use crate::ai::chatgpt::types::{
    AiChatRequest, AiStreamChunkEvent, AiStreamDoneEvent, AiStreamErrorEvent,
    AiStreamToolTraceEvent, AiToolTrace,
};
use crate::ai::reasoning_catalog::resolve_reasoning_capability;
use crate::ai::{
    emit_timeline, AiState, AuthTask, CopilotRuntimeCache, DownloadTask, ProviderTimeline,
};
use crate::core::process::{hide_console_window, hide_tokio_console_window};
use crate::db::models::{AiModel, ProviderAuthMetadata, ProviderModelInput};
use crate::db::repository;
use crate::tool_host::ToolHostConfig;
use flate2::read::GzDecoder;
use futures::StreamExt;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Instant;
use tar::Archive;
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{watch, Mutex};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const MIN_CLI_VERSION: &str = "1.0.12";
const AI_RUNTIME_BASENAME: &str = "macro-ai-runtime";
const LEGACY_AI_RUNTIME_BASENAME: &str = "macro-copilot-bridge";
const COPILOT_AUTO_UPDATE_ENV: (&str, &str) = ("COPILOT_AUTO_UPDATE", "false");
const COPILOT_RUNTIME_METADATA_KEY: &str = "copilot.runtime.managed";
const COPILOT_RUNTIME_MANIFEST_RESOURCE: &str = "copilot-runtime-manifest.json";
const COPILOT_RUNTIME_LICENSE_RESOURCE: &str = "licenses/github-copilot-cli-LICENSE.md";
const COPILOT_RUNTIME_DIR_SEGMENT: &str = "copilot/runtimes";
const COPILOT_TEMP_DIR_SEGMENT: &str = "copilot/tmp";
const COPILOT_DEFAULT_DEVICE_URL: &str = "https://github.com/login/device";
const DEFAULT_COPILOT_SEND_TIMEOUT_MS: i64 = 30 * 60 * 1000;
const MIN_COPILOT_SEND_TIMEOUT_MS: i64 = 60 * 1000;
const DOWNLOAD_PROGRESS_GRANULARITY_BYTES: u64 = 1_048_576;

#[derive(Debug, Clone, Deserialize)]
struct BridgeHealthResult {
    ok: bool,
    #[serde(rename = "cli_installed")]
    _cli_installed: bool,
    cli_version: Option<String>,
    min_cli_version: String,
    #[serde(rename = "version_ok")]
    _version_ok: bool,
    auth_status: String,
    auth_source: Option<String>,
    account_label: Option<String>,
    status_message: Option<String>,
    error_code: Option<String>,
    error_message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct BridgeModelRecord {
    model_id: String,
    name: String,
    description: Option<String>,
    owned_by: Option<String>,
    supported_reasoning_efforts: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
struct BridgeModelsResponse {
    models: Vec<BridgeModelRecord>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum BridgeSendEvent {
    Delta {
        delta: String,
    },
    ToolTrace {
        #[serde(flatten)]
        tool_trace: AiToolTrace,
    },
    ToolRequest {
        request_id: String,
        tool_call_id: String,
        tool_name: String,
        #[serde(default)]
        args: Value,
    },
    Done {
        content: String,
        reasoning_summary: Option<String>,
        hidden_context: Option<String>,
        tool_traces: Option<Vec<AiToolTrace>>,
    },
    Error {
        code: Option<String>,
        message: String,
    },
    Progress {
        #[serde(flatten)]
        _extra: HashMap<String, Value>,
    },
    LoginComplete {
        #[serde(flatten)]
        _extra: HashMap<String, Value>,
    },
}

#[derive(Debug, Clone, Deserialize)]
struct CopilotRuntimeManifest {
    #[serde(rename = "version")]
    _version: String,
    runtimes: HashMap<String, CopilotRuntimeAsset>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CopilotRuntimeAsset {
    package_name: String,
    version: String,
    platform: String,
    arch: String,
    url: String,
    archive_sha256: String,
    archive_size: u64,
    binary_name: String,
    binary_sha256: String,
    binary_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedRuntimeMetadata {
    version: String,
    platform_key: String,
    binary_path: String,
    installed_at: String,
    binary_sha256: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CopilotStatus {
    pub ok: bool,
    pub runtime_source: String,
    pub runtime_status: String,
    pub runtime_version: Option<String>,
    pub min_cli_version: String,
    pub auth_status: String,
    pub auth_source: Option<String>,
    pub account_label: Option<String>,
    pub status_message: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CopilotDownloadProgressEvent {
    pub request_id: String,
    pub provider_id: String,
    pub phase: String,
    pub message: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CopilotDownloadCompleteEvent {
    pub request_id: String,
    pub provider_id: String,
    pub runtime_version: String,
    pub runtime_source: String,
    pub status: CopilotStatus,
}

#[derive(Debug, Clone, Serialize)]
pub struct CopilotDownloadErrorEvent {
    pub request_id: String,
    pub provider_id: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CopilotAuthProgressEvent {
    pub request_id: String,
    pub provider_id: String,
    pub phase: String,
    pub message: String,
    pub verification_url: Option<String>,
    pub user_code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CopilotAuthCompleteEvent {
    pub request_id: String,
    pub provider_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CopilotAuthCancelledEvent {
    pub request_id: String,
    pub provider_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CopilotAuthErrorEvent {
    pub request_id: String,
    pub provider_id: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CopilotToolRequestEvent {
    pub request_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub args: Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CopilotToolResultRequest {
    pub request_id: String,
    pub tool_call_id: String,
    pub result: String,
    pub hidden_context: Option<String>,
    pub visible_content: Option<String>,
    pub interrupt: Option<bool>,
}

#[derive(Debug, Clone)]
struct ResolvedRuntime {
    source: RuntimeSource,
    path: PathBuf,
    version: String,
}

#[derive(Debug, Clone)]
struct ProbeIssue {
    runtime_source: RuntimeSource,
    runtime_status: String,
    runtime_version: Option<String>,
    error_code: String,
    error_message: String,
}

#[derive(Debug, Clone)]
enum RuntimeProbe {
    Ready(ResolvedRuntime),
    Absent,
    Issue(ProbeIssue),
}

#[derive(Debug, Clone)]
enum RuntimeSource {
    Managed,
    System,
    None,
}

impl RuntimeSource {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Managed => "managed",
            Self::System => "system",
            Self::None => "none",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "managed" => Some(Self::Managed),
            "system" => Some(Self::System),
            "none" => Some(Self::None),
            _ => None,
        }
    }
}

fn packaged_runtime_filename(base_name: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        format!("{}.exe", base_name)
    }

    #[cfg(not(target_os = "windows"))]
    {
        base_name.to_string()
    }
}

fn sidecar_runtime_filename(base_name: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        format!("{}-{}.exe", base_name, env!("TAURI_ENV_TARGET_TRIPLE"))
    }

    #[cfg(not(target_os = "windows"))]
    {
        format!("{}-{}", base_name, env!("TAURI_ENV_TARGET_TRIPLE"))
    }
}

fn bridge_filename() -> String {
    packaged_runtime_filename(AI_RUNTIME_BASENAME)
}

fn legacy_bridge_filename() -> String {
    packaged_runtime_filename(LEGACY_AI_RUNTIME_BASENAME)
}

fn bridge_sidecar_filename() -> String {
    sidecar_runtime_filename(AI_RUNTIME_BASENAME)
}

fn legacy_bridge_sidecar_filename() -> String {
    sidecar_runtime_filename(LEGACY_AI_RUNTIME_BASENAME)
}

fn bridge_candidates(_app_handle: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            candidates.push(parent.join(bridge_filename()));
            // Accept the old sidecar name during the rename so existing local builds still work.
            candidates.push(parent.join(legacy_bridge_filename()));
        }
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    candidates.push(
        manifest_dir
            .join("binaries")
            .join(bridge_sidecar_filename()),
    );
    candidates.push(
        manifest_dir
            .join("binaries")
            .join(legacy_bridge_sidecar_filename()),
    );
    candidates.push(manifest_dir.join("resources").join(bridge_filename()));
    candidates.push(
        manifest_dir
            .join("resources")
            .join(legacy_bridge_filename()),
    );
    candidates
}

fn resource_candidates_from_paths(
    resolved_resource_path: Option<PathBuf>,
    resource_dir: Option<PathBuf>,
    manifest_dir: &Path,
    relative_path: &str,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(resolved_resource_path) = resolved_resource_path {
        candidates.push(resolved_resource_path);
    }
    if let Some(resource_dir) = resource_dir {
        candidates.push(resource_dir.join(relative_path));
        candidates.push(resource_dir.join("resources").join(relative_path));
    }
    candidates.push(manifest_dir.join("resources").join(relative_path));
    candidates
}

fn resource_candidates(app_handle: &AppHandle, relative_path: &str) -> Vec<PathBuf> {
    let resolved_resource_path = app_handle
        .path()
        .resolve(relative_path, BaseDirectory::Resource)
        .ok();
    let resource_dir = app_handle.path().resource_dir().ok();
    resource_candidates_from_paths(
        resolved_resource_path,
        resource_dir,
        Path::new(env!("CARGO_MANIFEST_DIR")),
        relative_path,
    )
}

fn resolve_bridge_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    bridge_candidates(app_handle)
        .into_iter()
        .find(|candidate| candidate.exists())
        .ok_or_else(|| {
            format!(
                "Macro AI runtime executable was not found. Expected {} in the packaged app bundle or dev sidecar directory.",
                bridge_filename()
            )
        })
}

fn resolve_resource_path(app_handle: &AppHandle, relative_path: &str) -> Result<PathBuf, String> {
    resource_candidates(app_handle, relative_path)
        .into_iter()
        .find(|candidate| candidate.exists())
        .ok_or_else(|| format!("Required Copilot resource missing: {}", relative_path))
}

fn app_data_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {}", error))?;
    fs::create_dir_all(&app_dir).map_err(|error| error.to_string())?;
    Ok(app_dir)
}

fn copilot_runtime_root(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let root = app_data_dir(app_handle)?.join(COPILOT_RUNTIME_DIR_SEGMENT);
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn copilot_temp_root(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let root = app_data_dir(app_handle)?.join(COPILOT_TEMP_DIR_SEGMENT);
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn parse_version_parts(value: &str) -> Option<(u64, u64, u64)> {
    let mut parts = value
        .split(['.', '-', '+'])
        .take(3)
        .map(|part| part.parse::<u64>().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

fn compare_versions(left: &str, right: &str) -> i8 {
    let Some(left_parts) = parse_version_parts(left) else {
        return 0;
    };
    let Some(right_parts) = parse_version_parts(right) else {
        return 0;
    };
    if left_parts.0 != right_parts.0 {
        return if left_parts.0 > right_parts.0 { 1 } else { -1 };
    }
    if left_parts.1 != right_parts.1 {
        return if left_parts.1 > right_parts.1 { 1 } else { -1 };
    }
    if left_parts.2 != right_parts.2 {
        return if left_parts.2 > right_parts.2 { 1 } else { -1 };
    }
    0
}

fn same_major_version(left: &str, right: &str) -> bool {
    parse_version_parts(left)
        .zip(parse_version_parts(right))
        .map(|(parsed_left, parsed_right)| parsed_left.0 == parsed_right.0)
        .unwrap_or(false)
}

fn current_platform_key() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Ok("windows-x64"),
        ("windows", "aarch64") => Ok("windows-arm64"),
        ("macos", "x86_64") => Ok("macos-x64"),
        ("macos", "aarch64") => Ok("macos-arm64"),
        ("linux", "x86_64") => Ok("linux-x64"),
        ("linux", "aarch64") => Ok("linux-arm64"),
        (os, arch) => Err(format!(
            "Unsupported Copilot runtime target: {}-{}",
            os, arch
        )),
    }
}

fn load_runtime_manifest(app_handle: &AppHandle) -> Result<CopilotRuntimeManifest, String> {
    let manifest_path = resolve_resource_path(app_handle, COPILOT_RUNTIME_MANIFEST_RESOURCE)?;
    let text = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("Failed to read Copilot runtime manifest: {}", error))?;
    serde_json::from_str::<CopilotRuntimeManifest>(&text)
        .map_err(|error| format!("Failed to parse Copilot runtime manifest: {}", error))
}

fn current_runtime_asset(
    app_handle: &AppHandle,
) -> Result<(String, CopilotRuntimeManifest, CopilotRuntimeAsset), String> {
    let platform_key = current_platform_key()?.to_string();
    let manifest = load_runtime_manifest(app_handle)?;
    let asset = manifest
        .runtimes
        .get(&platform_key)
        .cloned()
        .ok_or_else(|| {
            format!(
                "Copilot runtime manifest missing entry for {}.",
                platform_key
            )
        })?;
    Ok((platform_key, manifest, asset))
}

fn managed_runtime_dir(
    app_handle: &AppHandle,
    platform_key: &str,
    asset: &CopilotRuntimeAsset,
) -> Result<PathBuf, String> {
    Ok(copilot_runtime_root(app_handle)?
        .join(platform_key)
        .join(&asset.version))
}

fn managed_runtime_path(
    app_handle: &AppHandle,
    platform_key: &str,
    asset: &CopilotRuntimeAsset,
) -> Result<PathBuf, String> {
    Ok(managed_runtime_dir(app_handle, platform_key, asset)?.join(&asset.binary_name))
}

fn bridge_envs(app_handle: &AppHandle, runtime: &ResolvedRuntime) -> Vec<(String, String)> {
    let tool_host = app_handle.state::<ToolHostConfig>().inner().clone();
    vec![
        (
            "MACRO_COPILOT_CLI_PATH".to_string(),
            runtime.path.to_string_lossy().to_string(),
        ),
        ("MACRO_TOOL_HOST_URL".to_string(), tool_host.base_url),
        (
            "MACRO_TOOL_HOST_BEARER_TOKEN".to_string(),
            tool_host.bearer_token,
        ),
        (
            COPILOT_AUTO_UPDATE_ENV.0.to_string(),
            COPILOT_AUTO_UPDATE_ENV.1.to_string(),
        ),
    ]
}

fn normalize_copilot_send_timeout_ms(value: Option<i64>) -> i64 {
    value
        .filter(|timeout| *timeout >= MIN_COPILOT_SEND_TIMEOUT_MS)
        .unwrap_or(DEFAULT_COPILOT_SEND_TIMEOUT_MS)
}

fn spawn_bridge(
    app_handle: &AppHandle,
    args: &[&str],
    envs: &[(String, String)],
) -> Result<Child, String> {
    let bridge_path = resolve_bridge_path(app_handle)?;
    let mut command = Command::new(bridge_path);
    hide_tokio_console_window(&mut command);
    tracing::debug!(
        operation = "copilot_runtime_spawn",
        args = ?args,
        hidden_console = cfg!(target_os = "windows"),
        "starting Macro AI runtime"
    );
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    for (key, value) in envs {
        command.env(key, value);
    }

    command
        .spawn()
        .map_err(|error| format!("Failed to start Macro AI runtime: {}", error))
}

fn bridge_error_message(values: &[Value], fallback: &str) -> String {
    values
        .iter()
        .rev()
        .find_map(|value| value.get("message").and_then(Value::as_str))
        .map(|message| message.to_string())
        .unwrap_or_else(|| fallback.to_string())
}

async fn run_bridge_json_command<T: for<'de> Deserialize<'de>>(
    app_handle: &AppHandle,
    args: &[&str],
    envs: &[(String, String)],
    stdin_payload: Option<String>,
) -> Result<T, String> {
    let mut child = spawn_bridge(app_handle, args, envs)?;

    if let Some(payload) = stdin_payload {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "AI runtime stdin is unavailable.".to_string())?;
        stdin
            .write_all(payload.as_bytes())
            .await
            .map_err(|error| format!("Failed to write AI runtime request: {}", error))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|error| format!("Failed to write AI runtime request newline: {}", error))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("Failed to flush AI runtime request: {}", error))?;
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "AI runtime stdout is unavailable.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "AI runtime stderr is unavailable.".to_string())?;
    let mut stdout_reader = BufReader::new(stdout).lines();
    let stderr_task = tokio::spawn(async move {
        let mut stderr_reader = BufReader::new(stderr).lines();
        let mut lines = Vec::new();
        while let Ok(Some(line)) = stderr_reader.next_line().await {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                lines.push(trimmed.to_string());
            }
        }
        lines.join("\n")
    });

    let mut parsed_values: Vec<Value> = Vec::new();
    while let Some(line) = stdout_reader
        .next_line()
        .await
        .map_err(|error| format!("Failed to read AI runtime output: {}", error))?
    {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("error") {
            let message = bridge_error_message(&[value], "Macro AI runtime command failed.");
            let _ = child.kill().await;
            let _ = child.wait().await;
            stderr_task.abort();
            return Err(message);
        }
        match serde_json::from_value::<T>(value.clone()) {
            Ok(parsed) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                stderr_task.abort();
                return Ok(parsed);
            }
            Err(_) => parsed_values.push(value),
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|error| format!("Failed to wait for AI runtime process: {}", error))?;
    let stderr_output = stderr_task.await.unwrap_or_default();

    if !status.success() {
        let message = if !parsed_values.is_empty() {
            bridge_error_message(&parsed_values, stderr_output.trim())
        } else if !stderr_output.trim().is_empty() {
            stderr_output
        } else {
            "Macro AI runtime command failed.".to_string()
        };
        return Err(message);
    }

    let value = parsed_values
        .last()
        .cloned()
        .ok_or_else(|| "Macro AI runtime returned no JSON output.".to_string())?;
    serde_json::from_value::<T>(value)
        .map_err(|error| format!("Failed to parse AI runtime response: {}", error))
}

fn build_provider_metadata(status: &CopilotStatus) -> ProviderAuthMetadata {
    ProviderAuthMetadata {
        auth_status: Some(status.auth_status.clone()),
        auth_source: status.auth_source.clone(),
        plan_type: None,
        account_label: status.account_label.clone(),
        token_expires_at: None,
    }
}

async fn persist_provider_status(
    pool: &SqlitePool,
    provider_id: &str,
    status: &CopilotStatus,
) -> Result<(), String> {
    repository::update_provider_auth_metadata(pool, provider_id, &build_provider_metadata(status))
        .await
        .map_err(|error| error.to_string())
}

fn issue_to_status(issue: ProbeIssue) -> CopilotStatus {
    CopilotStatus {
        ok: false,
        runtime_source: issue.runtime_source.as_str().to_string(),
        runtime_status: issue.runtime_status,
        runtime_version: issue.runtime_version,
        min_cli_version: MIN_CLI_VERSION.to_string(),
        auth_status: "error".to_string(),
        auth_source: None,
        account_label: None,
        status_message: Some(issue.error_message.clone()),
        error_code: Some(issue.error_code),
        error_message: Some(issue.error_message),
    }
}

fn bridge_health_to_status(runtime: &ResolvedRuntime, health: BridgeHealthResult) -> CopilotStatus {
    let auth_status = match health.auth_status.as_str() {
        "connected" => "connected",
        "login_required" => "login_required",
        "policy_blocked" => "policy_blocked",
        "quota_or_auth_error" => "quota_or_auth_error",
        _ => "error",
    }
    .to_string();

    CopilotStatus {
        ok: health.ok && auth_status == "connected",
        runtime_source: runtime.source.as_str().to_string(),
        runtime_status: "ready".to_string(),
        runtime_version: health
            .cli_version
            .clone()
            .or_else(|| Some(runtime.version.clone())),
        min_cli_version: health.min_cli_version,
        auth_status,
        auth_source: health.auth_source,
        account_label: health.account_label,
        status_message: health.status_message,
        error_code: health.error_code,
        error_message: health.error_message,
    }
}

fn bridge_send_error_to_status(
    runtime: &ResolvedRuntime,
    code: Option<&str>,
    message: &str,
) -> CopilotStatus {
    let auth_status = match code {
        Some("login_required") => "login_required",
        Some("policy_blocked") => "policy_blocked",
        Some("quota_or_auth_error") => "quota_or_auth_error",
        _ => "error",
    };

    CopilotStatus {
        ok: false,
        runtime_source: runtime.source.as_str().to_string(),
        runtime_status: "ready".to_string(),
        runtime_version: Some(runtime.version.clone()),
        min_cli_version: MIN_CLI_VERSION.to_string(),
        auth_status: auth_status.to_string(),
        auth_source: None,
        account_label: None,
        status_message: Some(message.to_string()),
        error_code: code.map(str::to_string),
        error_message: Some(message.to_string()),
    }
}

async fn run_cli_command(cli_path: &Path, args: &[&str]) -> Result<(i32, String), String> {
    let mut command = Command::new(cli_path);
    tracing::debug!(
        operation = "copilot_status_probe",
        cli_path = %cli_path.display(),
        args = ?args,
        hidden_console = cfg!(target_os = "windows"),
        "running Copilot CLI probe"
    );
    command
        .args(args)
        .env(COPILOT_AUTO_UPDATE_ENV.0, COPILOT_AUTO_UPDATE_ENV.1)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hide_tokio_console_window(&mut command);
    let output = command.output().await.map_err(|error| {
        format!(
            "Failed to run Copilot CLI at {}: {}",
            cli_path.display(),
            error
        )
    })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined = [stdout.trim(), stderr.trim()]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    Ok((output.status.code().unwrap_or(1), combined))
}

async fn detect_runtime_version(cli_path: &Path) -> Result<String, String> {
    let version_regex =
        Regex::new(r"(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)").map_err(|error| error.to_string())?;

    for args in [["version"].as_slice(), ["--version"].as_slice()] {
        let (code, output) = run_cli_command(cli_path, args).await?;
        if code != 0 {
            continue;
        }

        if let Some(version) = version_regex
            .captures(&output)
            .and_then(|captures| captures.get(1))
            .map(|capture| capture.as_str().to_string())
        {
            return Ok(version);
        }
    }

    Err(format!(
        "Unable to determine Copilot CLI version for {}.",
        cli_path.display()
    ))
}

fn validate_runtime_version(version: &str, expected_version: &str) -> Result<(), String> {
    if compare_versions(version, MIN_CLI_VERSION) < 0 {
        return Err(format!(
            "GitHub Copilot CLI {}+ is required; found {}.",
            MIN_CLI_VERSION, version
        ));
    }

    if !same_major_version(version, expected_version) {
        return Err(format!(
            "GitHub Copilot CLI {} is incompatible with pinned runtime {}.",
            version, expected_version
        ));
    }

    Ok(())
}

async fn inspect_runtime_path(
    cli_path: &Path,
    source: RuntimeSource,
    expected_version: &str,
) -> Result<ResolvedRuntime, ProbeIssue> {
    let version = detect_runtime_version(cli_path)
        .await
        .map_err(|error| ProbeIssue {
            runtime_source: source.clone(),
            runtime_status: "error".to_string(),
            runtime_version: None,
            error_code: "runtime_probe_failed".to_string(),
            error_message: error,
        })?;

    validate_runtime_version(&version, expected_version).map_err(|error| ProbeIssue {
        runtime_source: source.clone(),
        runtime_status: "update_required".to_string(),
        runtime_version: Some(version.clone()),
        error_code: "runtime_version_unsupported".to_string(),
        error_message: error,
    })?;

    Ok(ResolvedRuntime {
        source,
        path: cli_path.to_path_buf(),
        version,
    })
}

async fn probe_managed_runtime(
    app_handle: &AppHandle,
    platform_key: &str,
    asset: &CopilotRuntimeAsset,
) -> RuntimeProbe {
    let Ok(path) = managed_runtime_path(app_handle, platform_key, asset) else {
        return RuntimeProbe::Issue(ProbeIssue {
            runtime_source: RuntimeSource::Managed,
            runtime_status: "error".to_string(),
            runtime_version: None,
            error_code: "managed_runtime_path_failed".to_string(),
            error_message: "Failed to resolve managed Copilot runtime path.".to_string(),
        });
    };

    if !path.exists() {
        return RuntimeProbe::Absent;
    }

    match fs::metadata(&path) {
        Ok(metadata) if metadata.len() != asset.binary_size => RuntimeProbe::Issue(ProbeIssue {
            runtime_source: RuntimeSource::Managed,
            runtime_status: "error".to_string(),
            runtime_version: None,
            error_code: "managed_runtime_corrupt".to_string(),
            error_message: "Managed GitHub Copilot runtime is present but has an unexpected size."
                .to_string(),
        }),
        Ok(_) => match inspect_runtime_path(&path, RuntimeSource::Managed, &asset.version).await {
            Ok(runtime) => RuntimeProbe::Ready(runtime),
            Err(issue) => RuntimeProbe::Issue(issue),
        },
        Err(error) => RuntimeProbe::Issue(ProbeIssue {
            runtime_source: RuntimeSource::Managed,
            runtime_status: "error".to_string(),
            runtime_version: None,
            error_code: "managed_runtime_inaccessible".to_string(),
            error_message: format!(
                "Managed GitHub Copilot runtime is not accessible: {}",
                error
            ),
        }),
    }
}

async fn probe_candidate_paths(candidates: Vec<PathBuf>, expected_version: &str) -> RuntimeProbe {
    if candidates.is_empty() {
        return RuntimeProbe::Absent;
    }

    let mut first_issue: Option<ProbeIssue> = None;
    for candidate in candidates {
        if !candidate.exists() {
            continue;
        }
        match inspect_runtime_path(&candidate, RuntimeSource::System, expected_version).await {
            Ok(runtime) => return RuntimeProbe::Ready(runtime),
            Err(issue) if first_issue.is_none() => first_issue = Some(issue),
            Err(_) => {}
        }
    }

    first_issue
        .map(RuntimeProbe::Issue)
        .unwrap_or(RuntimeProbe::Absent)
}

fn system_cli_candidates() -> Vec<PathBuf> {
    let resolver = if cfg!(target_os = "windows") {
        "where.exe"
    } else {
        "which"
    };
    let mut command = std::process::Command::new(resolver);
    command.arg("copilot");
    hide_console_window(&mut command);
    tracing::debug!(
        operation = "copilot_status_probe",
        resolver,
        hidden_console = cfg!(target_os = "windows"),
        "resolving system Copilot CLI"
    );
    let output = command.output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }

    let text = [
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    ]
    .join("\n");

    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .collect()
}

async fn probe_system_runtime(expected_version: &str) -> RuntimeProbe {
    probe_candidate_paths(system_cli_candidates(), expected_version).await
}

#[cfg(debug_assertions)]
async fn probe_dev_runtime(asset: &CopilotRuntimeAsset) -> RuntimeProbe {
    let workspace_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    let mut package_path = workspace_root.join("node_modules");
    for segment in asset.package_name.split('/') {
        package_path = package_path.join(segment);
    }
    probe_candidate_paths(vec![package_path.join(&asset.binary_name)], &asset.version).await
}

#[cfg(not(debug_assertions))]
async fn probe_dev_runtime(_asset: &CopilotRuntimeAsset) -> RuntimeProbe {
    RuntimeProbe::Absent
}

async fn resolve_runtime(
    app_handle: &AppHandle,
) -> Result<(ResolvedRuntime, CopilotRuntimeAsset), ProbeIssue> {
    let (platform_key, _manifest, asset) =
        current_runtime_asset(app_handle).map_err(|error| ProbeIssue {
            runtime_source: RuntimeSource::None,
            runtime_status: "error".to_string(),
            runtime_version: None,
            error_code: "runtime_manifest_missing".to_string(),
            error_message: error,
        })?;

    let managed = probe_managed_runtime(app_handle, &platform_key, &asset).await;
    if let RuntimeProbe::Ready(runtime) = managed.clone() {
        return Ok((runtime, asset));
    }

    let system = probe_system_runtime(&asset.version).await;
    if let RuntimeProbe::Ready(runtime) = system.clone() {
        return Ok((runtime, asset));
    }

    let dev = probe_dev_runtime(&asset).await;
    if let RuntimeProbe::Ready(runtime) = dev.clone() {
        return Ok((runtime, asset));
    }

    for probe in [managed, system, dev] {
        if let RuntimeProbe::Issue(issue) = probe {
            return Err(issue);
        }
    }

    Err(ProbeIssue {
        runtime_source: RuntimeSource::None,
        runtime_status: "missing".to_string(),
        runtime_version: None,
        error_code: "runtime_missing".to_string(),
        error_message:
            "GitHub Copilot runtime is not installed. Download it from Macro to continue."
                .to_string(),
    })
}

fn cached_runtime_matches(
    cached: &CopilotRuntimeCache,
    manifest_version: &str,
    platform_key: &str,
    asset: &CopilotRuntimeAsset,
) -> bool {
    cached.manifest_version == manifest_version
        && cached.platform_key == platform_key
        && cached.version == asset.version
        && cached.path.exists()
        && RuntimeSource::from_str(&cached.source).is_some()
}

async fn ensure_copilot_runtime_for_send(
    app_handle: &AppHandle,
    ai_state: &AiState,
) -> Result<ResolvedRuntime, String> {
    let (platform_key, manifest, asset) = current_runtime_asset(app_handle)?;
    {
        let cache = ai_state.copilot_runtime_cache.lock().await;
        if let Some(cached) = cache.as_ref() {
            if cached_runtime_matches(cached, &manifest._version, &platform_key, &asset) {
                if let Some(source) = RuntimeSource::from_str(&cached.source) {
                    return Ok(ResolvedRuntime {
                        source,
                        path: cached.path.clone(),
                        version: cached.version.clone(),
                    });
                }
            }
        }
    }

    let (runtime, _) = resolve_runtime(app_handle)
        .await
        .map_err(|issue| issue.error_message)?;
    {
        let mut cache = ai_state.copilot_runtime_cache.lock().await;
        *cache = Some(CopilotRuntimeCache {
            manifest_version: manifest._version,
            platform_key,
            path: runtime.path.clone(),
            version: runtime.version.clone(),
            source: runtime.source.as_str().to_string(),
            validated_at: Instant::now(),
        });
    }
    Ok(runtime)
}

async fn read_bridge_health(
    app_handle: &AppHandle,
    runtime: &ResolvedRuntime,
) -> Result<BridgeHealthResult, String> {
    run_bridge_json_command(
        app_handle,
        &["health"],
        &bridge_envs(app_handle, runtime),
        None,
    )
    .await
}

async fn get_status_inner(
    app_handle: &AppHandle,
    pool: &SqlitePool,
    provider_id: &str,
    is_downloading: bool,
) -> Result<CopilotStatus, String> {
    let mut status = if is_downloading {
        CopilotStatus {
            ok: false,
            runtime_source: RuntimeSource::None.as_str().to_string(),
            runtime_status: "downloading".to_string(),
            runtime_version: None,
            min_cli_version: MIN_CLI_VERSION.to_string(),
            auth_status: "error".to_string(),
            auth_source: None,
            account_label: None,
            status_message: Some("Downloading GitHub Copilot runtime...".to_string()),
            error_code: None,
            error_message: None,
        }
    } else {
        match resolve_runtime(app_handle).await {
            Ok((runtime, _asset)) => {
                let health = read_bridge_health(app_handle, &runtime).await?;
                bridge_health_to_status(&runtime, health)
            }
            Err(issue) => issue_to_status(issue),
        }
    };

    if status.runtime_status == "ready"
        && status.auth_status == "error"
        && status.error_code.is_none()
    {
        status.error_code = Some("copilot_error".to_string());
    }

    normalize_status_auth_source(&mut status);
    persist_provider_status(pool, provider_id, &status).await?;
    Ok(status)
}

fn models_to_inputs(models: &[BridgeModelRecord]) -> Vec<ProviderModelInput> {
    models
        .iter()
        .map(|model| {
            let reasoning = resolve_reasoning_capability(
                Some("copilot"),
                Some(&model.model_id),
                None,
                model.supported_reasoning_efforts.as_deref(),
                None,
            );

            ProviderModelInput {
                model_id: model.model_id.clone(),
                name: model.name.clone(),
                description: model.description.clone(),
                owned_by: model.owned_by.clone(),
                pricing_prompt: None,
                pricing_completion: None,
                pricing_request: None,
                reasoning_efforts: if reasoning.reasoning_efforts.is_empty() {
                    None
                } else {
                    Some(reasoning.reasoning_efforts)
                },
                context_window_tokens: None,
                default_reasoning_effort: reasoning.default_reasoning_effort,
            }
        })
        .collect()
}

pub async fn get_status(
    app_handle: &AppHandle,
    pool: &SqlitePool,
    ai_state: &AiState,
    provider_id: &str,
) -> Result<CopilotStatus, String> {
    let download_in_progress = {
        let tasks = ai_state.download_tasks.lock().await;
        tasks.values().any(|task| task.provider_id == provider_id)
    };
    get_status_inner(app_handle, pool, provider_id, download_in_progress).await
}

fn emit_download_progress(
    app_handle: &AppHandle,
    request_id: &str,
    provider_id: &str,
    phase: &str,
    message: String,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
) -> Result<(), String> {
    app_handle
        .emit(
            "ai:copilot-download-progress",
            CopilotDownloadProgressEvent {
                request_id: request_id.to_string(),
                provider_id: provider_id.to_string(),
                phase: phase.to_string(),
                message,
                downloaded_bytes,
                total_bytes,
            },
        )
        .map_err(|error| error.to_string())
}

fn emit_download_complete(
    app_handle: &AppHandle,
    request_id: &str,
    provider_id: &str,
    runtime_version: &str,
    status: CopilotStatus,
) -> Result<(), String> {
    app_handle
        .emit(
            "ai:copilot-download-complete",
            CopilotDownloadCompleteEvent {
                request_id: request_id.to_string(),
                provider_id: provider_id.to_string(),
                runtime_version: runtime_version.to_string(),
                runtime_source: RuntimeSource::Managed.as_str().to_string(),
                status,
            },
        )
        .map_err(|error| error.to_string())
}

fn emit_download_error(
    app_handle: &AppHandle,
    request_id: &str,
    provider_id: &str,
    code: &str,
    message: &str,
) -> Result<(), String> {
    app_handle
        .emit(
            "ai:copilot-download-error",
            CopilotDownloadErrorEvent {
                request_id: request_id.to_string(),
                provider_id: provider_id.to_string(),
                code: code.to_string(),
                message: message.to_string(),
            },
        )
        .map_err(|error| error.to_string())
}

fn emit_auth_progress(
    app_handle: &AppHandle,
    request_id: &str,
    provider_id: &str,
    phase: &str,
    message: String,
    verification_url: Option<String>,
    user_code: Option<String>,
) -> Result<(), String> {
    app_handle
        .emit(
            "ai:copilot-auth-progress",
            CopilotAuthProgressEvent {
                request_id: request_id.to_string(),
                provider_id: provider_id.to_string(),
                phase: phase.to_string(),
                message,
                verification_url,
                user_code,
            },
        )
        .map_err(|error| error.to_string())
}

fn emit_auth_complete(
    app_handle: &AppHandle,
    request_id: &str,
    provider_id: &str,
) -> Result<(), String> {
    app_handle
        .emit(
            "ai:copilot-auth-complete",
            CopilotAuthCompleteEvent {
                request_id: request_id.to_string(),
                provider_id: provider_id.to_string(),
            },
        )
        .map_err(|error| error.to_string())
}

fn emit_auth_cancelled(
    app_handle: &AppHandle,
    request_id: &str,
    provider_id: &str,
) -> Result<(), String> {
    app_handle
        .emit(
            "ai:copilot-auth-cancelled",
            CopilotAuthCancelledEvent {
                request_id: request_id.to_string(),
                provider_id: provider_id.to_string(),
            },
        )
        .map_err(|error| error.to_string())
}

fn emit_auth_error(
    app_handle: &AppHandle,
    request_id: &str,
    provider_id: &str,
    code: &str,
    message: &str,
) -> Result<(), String> {
    app_handle
        .emit(
            "ai:copilot-auth-error",
            CopilotAuthErrorEvent {
                request_id: request_id.to_string(),
                provider_id: provider_id.to_string(),
                code: code.to_string(),
                message: message.to_string(),
            },
        )
        .map_err(|error| error.to_string())
}

fn copy_license_to_runtime(app_handle: &AppHandle, target_dir: &Path) -> Result<(), String> {
    let license_path = resolve_resource_path(app_handle, COPILOT_RUNTIME_LICENSE_RESOURCE)?;
    let license_target = target_dir.join("LICENSE.md");
    fs::copy(&license_path, &license_target)
        .map_err(|error| format!("Failed to copy Copilot license: {}", error))?;
    Ok(())
}

async fn write_managed_runtime_metadata(
    pool: &SqlitePool,
    platform_key: &str,
    binary_path: &Path,
    asset: &CopilotRuntimeAsset,
) -> Result<(), String> {
    let metadata = ManagedRuntimeMetadata {
        version: asset.version.clone(),
        platform_key: platform_key.to_string(),
        binary_path: binary_path.to_string_lossy().to_string(),
        installed_at: chrono::Utc::now().to_rfc3339(),
        binary_sha256: asset.binary_sha256.clone(),
    };
    let value_json = serde_json::to_string(&metadata)
        .map_err(|error| format!("Failed to encode metadata: {}", error))?;
    repository::set_app_setting(pool, COPILOT_RUNTIME_METADATA_KEY, &value_json)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read =
            std::io::Read::read(&mut file, &mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn extract_archive(archive_path: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        fs::remove_dir_all(destination).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(destination).map_err(|error| error.to_string())?;

    let archive_file = File::open(archive_path).map_err(|error| error.to_string())?;
    let decoder = GzDecoder::new(archive_file);
    let mut archive = Archive::new(decoder);
    archive
        .unpack(destination)
        .map_err(|error| error.to_string())
}

fn cleanup_old_managed_versions(
    app_handle: &AppHandle,
    platform_key: &str,
    keep_version: &str,
) -> Result<(), String> {
    let platform_root = copilot_runtime_root(app_handle)?.join(platform_key);
    if !platform_root.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(platform_root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path
            .file_name()
            .and_then(|value| value.to_str())
            .map(|value| value == keep_version)
            .unwrap_or(false)
        {
            continue;
        }
        if path.is_dir() {
            let _ = fs::remove_dir_all(path);
        }
    }

    Ok(())
}

async fn install_runtime_archive(
    app_handle: &AppHandle,
    pool: &SqlitePool,
    request_id: &str,
    provider_id: &str,
    platform_key: &str,
    asset: &CopilotRuntimeAsset,
    cancel_rx: &mut watch::Receiver<bool>,
) -> Result<(), String> {
    let temp_root = copilot_temp_root(app_handle)?;
    let request_root = temp_root.join(format!("download-{}", request_id));
    if request_root.exists() {
        let _ = fs::remove_dir_all(&request_root);
    }
    fs::create_dir_all(&request_root).map_err(|error| error.to_string())?;

    let archive_path = request_root.join("runtime.tgz");
    let extract_root = request_root.join("extract");

    emit_download_progress(
        app_handle,
        request_id,
        provider_id,
        "starting",
        "Preparing GitHub Copilot runtime download...".to_string(),
        0,
        Some(asset.archive_size),
    )?;

    let client = reqwest::Client::new();
    let response = client
        .get(&asset.url)
        .send()
        .await
        .map_err(|error| format!("Failed to download GitHub Copilot runtime: {}", error))?;
    if !response.status().is_success() {
        return Err(format!(
            "Failed to download GitHub Copilot runtime: HTTP {}",
            response.status()
        ));
    }

    let total_bytes = response
        .content_length()
        .or(Some(asset.archive_size))
        .filter(|value| *value > 0);
    let mut file = tokio::fs::File::create(&archive_path)
        .await
        .map_err(|error| format!("Failed to create archive file: {}", error))?;
    let mut stream = response.bytes_stream();
    let mut downloaded_bytes = 0u64;
    let mut last_reported = 0u64;
    let mut archive_hash = Sha256::new();

    while let Some(chunk_result) = stream.next().await {
        if *cancel_rx.borrow() {
            return Err("Download cancelled.".to_string());
        }

        let chunk = chunk_result.map_err(|error| {
            format!("Failed while downloading GitHub Copilot runtime: {}", error)
        })?;
        archive_hash.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("Failed to write GitHub Copilot archive: {}", error))?;
        downloaded_bytes += chunk.len() as u64;

        if downloaded_bytes.saturating_sub(last_reported) >= DOWNLOAD_PROGRESS_GRANULARITY_BYTES
            || total_bytes
                .map(|total| downloaded_bytes >= total)
                .unwrap_or(false)
        {
            last_reported = downloaded_bytes;
            emit_download_progress(
                app_handle,
                request_id,
                provider_id,
                "downloading",
                "Downloading GitHub Copilot runtime...".to_string(),
                downloaded_bytes,
                total_bytes,
            )?;
        }
    }

    file.flush()
        .await
        .map_err(|error| format!("Failed to flush GitHub Copilot archive: {}", error))?;

    let expected_size = total_bytes.unwrap_or(asset.archive_size);
    if downloaded_bytes != expected_size {
        return Err(format!(
            "Downloaded GitHub Copilot archive size mismatch (expected {}, got {}).",
            expected_size, downloaded_bytes
        ));
    }

    let archive_sha = format!("{:x}", archive_hash.finalize());
    if archive_sha != asset.archive_sha256 {
        return Err("Downloaded GitHub Copilot archive failed checksum verification.".to_string());
    }

    emit_download_progress(
        app_handle,
        request_id,
        provider_id,
        "extracting",
        "Extracting GitHub Copilot runtime...".to_string(),
        downloaded_bytes,
        total_bytes,
    )?;

    let archive_path_clone = archive_path.clone();
    let extract_root_clone = extract_root.clone();
    tokio::task::spawn_blocking(move || extract_archive(&archive_path_clone, &extract_root_clone))
        .await
        .map_err(|error| format!("Failed to extract GitHub Copilot runtime: {}", error))??;

    let extracted_binary = extract_root.join("package").join(&asset.binary_name);
    if !extracted_binary.exists() {
        return Err("Extracted GitHub Copilot runtime is missing the expected binary.".to_string());
    }

    let binary_metadata = fs::metadata(&extracted_binary).map_err(|error| error.to_string())?;
    if binary_metadata.len() != asset.binary_size {
        return Err("Extracted GitHub Copilot runtime binary has an unexpected size.".to_string());
    }

    let binary_sha = tokio::task::spawn_blocking({
        let extracted_binary = extracted_binary.clone();
        move || sha256_file(&extracted_binary)
    })
    .await
    .map_err(|error| format!("Failed to verify Copilot runtime binary: {}", error))??;
    if binary_sha != asset.binary_sha256 {
        return Err(
            "Extracted GitHub Copilot runtime binary failed checksum verification.".to_string(),
        );
    }

    emit_download_progress(
        app_handle,
        request_id,
        provider_id,
        "installing",
        "Installing GitHub Copilot runtime...".to_string(),
        downloaded_bytes,
        total_bytes,
    )?;

    let final_dir = managed_runtime_dir(app_handle, platform_key, asset)?;
    let staging_dir = final_dir.with_extension(format!("staging-{}", request_id));
    if staging_dir.exists() {
        let _ = fs::remove_dir_all(&staging_dir);
    }
    if final_dir.exists() {
        let _ = fs::remove_dir_all(&final_dir);
    }
    fs::create_dir_all(&staging_dir).map_err(|error| error.to_string())?;

    let final_binary = staging_dir.join(&asset.binary_name);
    fs::copy(&extracted_binary, &final_binary)
        .map_err(|error| format!("Failed to stage Copilot runtime binary: {}", error))?;

    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&final_binary)
            .map_err(|error| error.to_string())?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&final_binary, permissions).map_err(|error| error.to_string())?;
    }

    copy_license_to_runtime(app_handle, &staging_dir)?;
    fs::rename(&staging_dir, &final_dir)
        .map_err(|error| format!("Failed to finalize Copilot runtime install: {}", error))?;

    let final_binary_path = final_dir.join(&asset.binary_name);
    write_managed_runtime_metadata(pool, platform_key, &final_binary_path, asset).await?;
    cleanup_old_managed_versions(app_handle, platform_key, &asset.version)?;
    let _ = fs::remove_dir_all(&request_root);
    Ok(())
}

pub async fn start_runtime_download(
    app_handle: AppHandle,
    pool: SqlitePool,
    ai_state: AiState,
    request_id: String,
    provider_id: String,
) -> Result<(), String> {
    {
        let mut tasks = ai_state.download_tasks.lock().await;
        let request_ids = tasks.keys().cloned().collect::<Vec<_>>();
        for active_request_id in request_ids {
            if let Some(task) = tasks.remove(&active_request_id) {
                let _ = task.cancel_sender.send(true);
                task.handle.abort();
            }
        }
    }

    let app_for_task = app_handle.clone();
    let pool_for_task = pool.clone();
    let state_for_task = ai_state.clone();
    let provider_for_task = provider_id.clone();
    let request_for_task = request_id.clone();
    let (cancel_tx, mut cancel_rx) = watch::channel(false);

    let handle = tokio::spawn(async move {
        let result = async {
            let (platform_key, _manifest, asset) = current_runtime_asset(&app_for_task)?;
            install_runtime_archive(
                &app_for_task,
                &pool_for_task,
                &request_for_task,
                &provider_for_task,
                &platform_key,
                &asset,
                &mut cancel_rx,
            )
            .await?;
            {
                let mut tasks = state_for_task.download_tasks.lock().await;
                tasks.remove(&request_for_task);
            }
            let status =
                get_status_inner(&app_for_task, &pool_for_task, &provider_for_task, false).await?;
            emit_download_complete(
                &app_for_task,
                &request_for_task,
                &provider_for_task,
                &asset.version,
                status,
            )?;
            Ok::<(), String>(())
        }
        .await;

        if let Err(message) = result {
            let code = if message == "Download cancelled." {
                "cancelled"
            } else {
                "download_failed"
            };
            let _ = emit_download_error(
                &app_for_task,
                &request_for_task,
                &provider_for_task,
                code,
                &message,
            );
        }

        let mut tasks = state_for_task.download_tasks.lock().await;
        tasks.remove(&request_for_task);
    });

    let mut tasks = ai_state.download_tasks.lock().await;
    tasks.insert(
        request_id,
        DownloadTask {
            provider_id,
            handle,
            cancel_sender: cancel_tx,
        },
    );
    Ok(())
}

pub async fn cancel_runtime_download(
    app_handle: &AppHandle,
    ai_state: &AiState,
    request_id: &str,
) -> Result<(), String> {
    let mut tasks = ai_state.download_tasks.lock().await;
    if let Some(task) = tasks.remove(request_id) {
        let provider_id = task.provider_id.clone();
        let _ = task.cancel_sender.send(true);
        task.handle.abort();
        let _ = emit_download_error(
            app_handle,
            request_id,
            &provider_id,
            "download_cancelled",
            "GitHub Copilot runtime download was cancelled.",
        );
    }
    Ok(())
}

fn detect_auth_source(raw: Option<String>) -> Option<String> {
    let raw = raw?;
    let normalized = raw.to_lowercase();
    if normalized.contains("gh") {
        return Some("gh-cli".to_string());
    }
    if normalized.contains("env") || normalized.contains("token") {
        return Some("env".to_string());
    }
    if normalized.contains("oauth") || normalized.contains("cli") {
        return Some("oauth".to_string());
    }
    Some("unknown".to_string())
}

fn normalize_status_auth_source(status: &mut CopilotStatus) {
    status.auth_source = detect_auth_source(status.auth_source.take());
}

async fn run_login_flow(
    app_handle: AppHandle,
    pool: SqlitePool,
    provider_id: String,
    request_id: String,
    runtime: ResolvedRuntime,
) -> Result<(), String> {
    let mut command = Command::new(&runtime.path);
    tracing::debug!(
        operation = "copilot_runtime_spawn",
        flow = "login",
        runtime_path = %runtime.path.display(),
        hidden_console = cfg!(target_os = "windows"),
        "starting Copilot login runtime"
    );
    command
        .arg("login")
        .env(COPILOT_AUTO_UPDATE_ENV.0, COPILOT_AUTO_UPDATE_ENV.1)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .kill_on_drop(true);
    hide_tokio_console_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start GitHub Copilot login: {}", error))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Copilot login stdout is unavailable.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Copilot login stderr is unavailable.".to_string())?;

    let (line_tx, mut line_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let stdout_task = tokio::spawn({
        let line_tx = line_tx.clone();
        async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = line_tx.send(line);
            }
        }
    });
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = line_tx.send(line);
        }
    });

    let code_regex =
        Regex::new(r"\b([A-Z0-9]{4}(?:-[A-Z0-9]{4})+)\b").map_err(|error| error.to_string())?;
    let url_regex = Regex::new(r"https?://\S+").map_err(|error| error.to_string())?;
    let mut verification_url: Option<String> = None;
    let mut user_code: Option<String> = None;
    let mut last_message = "Waiting for GitHub Copilot login...".to_string();

    emit_auth_progress(
        &app_handle,
        &request_id,
        &provider_id,
        "starting",
        "Starting GitHub Copilot login...".to_string(),
        None,
        None,
    )?;

    while let Some(line) = line_rx.recv().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if verification_url.is_none() {
            verification_url = url_regex
                .find(trimmed)
                .map(|value| value.as_str().trim_end_matches('.').to_string());
        }
        if user_code.is_none() {
            user_code = code_regex
                .captures(trimmed)
                .and_then(|captures| captures.get(1))
                .map(|capture| capture.as_str().to_string());
        }
        if user_code.is_some() && verification_url.is_none() {
            verification_url = Some(COPILOT_DEFAULT_DEVICE_URL.to_string());
        }

        last_message = trimmed.to_string();
        emit_auth_progress(
            &app_handle,
            &request_id,
            &provider_id,
            if user_code.is_some() {
                "waiting_for_browser"
            } else {
                "waiting_for_completion"
            },
            last_message.clone(),
            verification_url.clone(),
            user_code.clone(),
        )?;
    }

    let status = child
        .wait()
        .await
        .map_err(|error| format!("Failed to wait for GitHub Copilot login: {}", error))?;
    let _ = stdout_task.await;
    let _ = stderr_task.await;

    if !status.success() {
        return Err(if last_message.trim().is_empty() {
            "GitHub Copilot login failed.".to_string()
        } else {
            last_message
        });
    }

    let mut status = get_status_inner(&app_handle, &pool, &provider_id, false).await?;
    normalize_status_auth_source(&mut status);
    persist_provider_status(&pool, &provider_id, &status).await?;
    emit_auth_complete(&app_handle, &request_id, &provider_id)?;
    Ok(())
}

pub async fn start_auth(
    app_handle: AppHandle,
    pool: SqlitePool,
    ai_state: AiState,
    request_id: String,
    provider_id: String,
) -> Result<(), String> {
    let (runtime, _asset) = resolve_runtime(&app_handle)
        .await
        .map_err(|issue| issue.error_message)?;

    {
        let mut tasks = ai_state.auth_tasks.lock().await;
        let stale_request_ids = tasks
            .iter()
            .filter_map(|(active_request_id, task)| {
                if task.provider_id == provider_id {
                    Some(active_request_id.clone())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        for active_request_id in stale_request_ids {
            if let Some(task) = tasks.remove(&active_request_id) {
                let _ = task.cancel_sender.send(true);
                task.handle.abort();
            }
        }
    }

    let app_for_task = app_handle.clone();
    let pool_for_task = pool.clone();
    let state_for_task = ai_state.clone();
    let provider_for_task = provider_id.clone();
    let request_for_task = request_id.clone();
    let (cancel_tx, _cancel_rx) = watch::channel(false);

    let handle = tokio::spawn(async move {
        let result = run_login_flow(
            app_for_task.clone(),
            pool_for_task,
            provider_for_task.clone(),
            request_for_task.clone(),
            runtime,
        )
        .await;

        if let Err(message) = result {
            let _ = emit_auth_error(
                &app_for_task,
                &request_for_task,
                &provider_for_task,
                "login_failed",
                &message,
            );
        }

        let mut tasks = state_for_task.auth_tasks.lock().await;
        tasks.remove(&request_for_task);
    });

    let mut tasks = ai_state.auth_tasks.lock().await;
    tasks.insert(
        request_id,
        AuthTask {
            provider_id,
            handle,
            cancel_sender: cancel_tx,
        },
    );
    Ok(())
}

pub async fn cancel_auth(
    app_handle: &AppHandle,
    ai_state: &AiState,
    request_id: &str,
) -> Result<(), String> {
    let mut tasks = ai_state.auth_tasks.lock().await;
    if let Some(task) = tasks.remove(request_id) {
        let provider_id = task.provider_id.clone();
        let _ = task.cancel_sender.send(true);
        task.handle.abort();
        emit_auth_cancelled(app_handle, request_id, &provider_id)?;
    }
    Ok(())
}

pub async fn sync_models(
    app_handle: &AppHandle,
    pool: &SqlitePool,
    ai_state: &AiState,
    provider_id: &str,
) -> Result<Vec<AiModel>, String> {
    let mut status = get_status(app_handle, pool, ai_state, provider_id).await?;
    normalize_status_auth_source(&mut status);
    persist_provider_status(pool, provider_id, &status).await?;

    if status.runtime_status != "ready" || status.auth_status != "connected" {
        return Err(status
            .error_message
            .or(status.status_message)
            .unwrap_or_else(|| "GitHub Copilot is not connected.".to_string()));
    }

    let (runtime, _asset) = resolve_runtime(app_handle)
        .await
        .map_err(|issue| issue.error_message)?;
    let response: BridgeModelsResponse = run_bridge_json_command(
        app_handle,
        &["models"],
        &bridge_envs(app_handle, &runtime),
        None,
    )
    .await?;
    let models = models_to_inputs(&response.models);

    repository::upsert_provider_models(pool, provider_id, &models)
        .await
        .map_err(|error| error.to_string())?;

    let keep_model_ids = models
        .iter()
        .map(|model| model.model_id.clone())
        .collect::<Vec<_>>();
    repository::prune_provider_models(pool, provider_id, &keep_model_ids)
        .await
        .map_err(|error| error.to_string())?;

    repository::list_models_by_provider(pool, provider_id)
        .await
        .map_err(|error| error.to_string())
}

pub async fn stream_chat(
    app_handle: AppHandle,
    pool: SqlitePool,
    ai_state: AiState,
    request: AiChatRequest,
) -> Result<(), String> {
    cancel_stream(&ai_state, &request.request_id).await?;

    let request_id = request.request_id.clone();
    let task_request_id = request.request_id.clone();
    let task_provider_id = request.provider_id.clone();
    let app_for_task = app_handle.clone();
    let state_for_task = ai_state.clone();
    let task_started_at = Instant::now();

    let handle = tokio::spawn(async move {
        let result =
            stream_chat_inner(app_for_task.clone(), pool, state_for_task.clone(), request).await;
        if let Err(message) = result {
            emit_timeline(
                &app_for_task,
                &task_request_id,
                &task_provider_id,
                "copilot",
                task_started_at,
                "error",
            );
            let _ = app_for_task.emit(
                "ai:error",
                AiStreamErrorEvent {
                    request_id: task_request_id.clone(),
                    message,
                },
            );
        }

        let mut tasks = state_for_task.stream_tasks.lock().await;
        tasks.remove(&task_request_id);
        let mut tool_writers = state_for_task.copilot_tool_writers.lock().await;
        tool_writers.remove(&task_request_id);
    });

    let mut tasks = ai_state.stream_tasks.lock().await;
    tasks.insert(request_id, handle);
    Ok(())
}

pub async fn cancel_stream(ai_state: &AiState, request_id: &str) -> Result<(), String> {
    {
        let mut tool_writers = ai_state.copilot_tool_writers.lock().await;
        tool_writers.remove(request_id);
    }

    crate::ai::chatgpt::cancel_stream(ai_state, request_id).await
}

pub async fn submit_tool_result(
    ai_state: &AiState,
    request: CopilotToolResultRequest,
) -> Result<(), String> {
    let writer = {
        let tool_writers = ai_state.copilot_tool_writers.lock().await;
        tool_writers.get(&request.request_id).cloned()
    }
    .ok_or_else(|| {
        format!(
            "No active Copilot stream is waiting for tool result {}.",
            request.tool_call_id
        )
    })?;

    let payload = json!({
        "type": "tool_result",
        "request_id": request.request_id,
        "tool_call_id": request.tool_call_id,
        "result": request.result,
        "hidden_context": request.hidden_context,
        "visible_content": request.visible_content,
        "interrupt": request.interrupt.unwrap_or(false),
    });
    let line = serde_json::to_string(&payload)
        .map_err(|error| format!("Failed to serialize Copilot tool result: {}", error))?;

    let mut stdin = writer.lock().await;
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|error| format!("Failed to send Copilot tool result: {}", error))?;
    stdin
        .write_all(b"\n")
        .await
        .map_err(|error| format!("Failed to send Copilot tool result newline: {}", error))?;
    stdin
        .flush()
        .await
        .map_err(|error| format!("Failed to flush Copilot tool result: {}", error))?;
    Ok(())
}

async fn stream_chat_inner(
    app_handle: AppHandle,
    pool: SqlitePool,
    ai_state: AiState,
    request: AiChatRequest,
) -> Result<(), String> {
    let mut request = request;
    let started_at = Instant::now();
    let timeline = ProviderTimeline::new(
        &app_handle,
        &request.request_id,
        &request.provider_id,
        "copilot",
        started_at,
    );
    timeline.emit("backend_task_started");
    let provider = repository::get_provider_config(&pool, &request.provider_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Provider {} not found.", request.provider_id))?;

    let provider_settings = repository::get_provider_settings(&pool, &provider.id)
        .await
        .map_err(|error| error.to_string())?;
    request.copilot_send_timeout_ms = Some(normalize_copilot_send_timeout_ms(
        provider_settings.copilot_send_timeout_ms,
    ));

    let runtime = ensure_copilot_runtime_for_send(&app_handle, &ai_state).await?;
    let payload = serde_json::to_string(&request)
        .map_err(|error| format!("Failed to serialize Copilot request: {}", error))?;
    let mut child = spawn_bridge(&app_handle, &["send"], &bridge_envs(&app_handle, &runtime))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "AI runtime stdin is unavailable.".to_string())?;
    let stdin = Arc::new(Mutex::new(stdin));
    {
        let mut writer = stdin.lock().await;
        writer
            .write_all(payload.as_bytes())
            .await
            .map_err(|error| format!("Failed to send AI runtime request: {}", error))?;
        writer
            .write_all(b"\n")
            .await
            .map_err(|error| format!("Failed to send AI runtime request newline: {}", error))?;
        writer
            .flush()
            .await
            .map_err(|error| format!("Failed to flush AI runtime request: {}", error))?;
    }
    timeline.emit("provider_request_sent");
    {
        let mut tool_writers = ai_state.copilot_tool_writers.lock().await;
        tool_writers.insert(request.request_id.clone(), stdin);
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "AI runtime stdout is unavailable.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "AI runtime stderr is unavailable.".to_string())?;

    let mut stdout_reader = BufReader::new(stdout).lines();
    let stderr_task = tokio::spawn(async move {
        let mut stderr_reader = BufReader::new(stderr).lines();
        let mut lines = Vec::new();
        while let Ok(Some(line)) = stderr_reader.next_line().await {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                lines.push(trimmed.to_string());
            }
        }
        lines.join("\n")
    });

    let mut saw_done = false;
    let mut last_error: Option<(Option<String>, String)> = None;
    let mut emitted_first_provider_event = false;
    let mut emitted_first_token = false;

    while let Some(line) = stdout_reader
        .next_line()
        .await
        .map_err(|error| format!("Failed to read AI runtime output: {}", error))?
    {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let event = serde_json::from_str::<BridgeSendEvent>(trimmed)
            .map_err(|error| format!("Invalid AI runtime event: {}", error))?;

        match event {
            BridgeSendEvent::Delta { delta } => {
                if !emitted_first_provider_event {
                    emitted_first_provider_event = true;
                    timeline.emit("first_provider_event");
                }
                if !emitted_first_token {
                    emitted_first_token = true;
                    timeline.emit("first_token");
                }
                app_handle
                    .emit(
                        "ai:stream",
                        AiStreamChunkEvent {
                            request_id: request.request_id.clone(),
                            delta,
                        },
                    )
                    .map_err(|error| error.to_string())?;
            }
            BridgeSendEvent::Done {
                content,
                reasoning_summary,
                hidden_context,
                tool_traces,
            } => {
                saw_done = true;
                if !emitted_first_provider_event {
                    emitted_first_provider_event = true;
                    timeline.emit("first_provider_event");
                }
                timeline.emit("done");
                app_handle
                    .emit(
                        "ai:done",
                        AiStreamDoneEvent {
                            request_id: request.request_id.clone(),
                            output_text: content,
                            tool_calls: Vec::new(),
                            response_id: None,
                            output_items: None,
                            provider_input_items: None,
                            provider_turn_state: None,
                            reasoning_summary,
                            tool_traces,
                            hidden_context,
                        },
                    )
                    .map_err(|error| error.to_string())?;
            }
            BridgeSendEvent::Error { code, message } => {
                if !emitted_first_provider_event {
                    emitted_first_provider_event = true;
                    timeline.emit("first_provider_event");
                }
                let mut status =
                    bridge_send_error_to_status(&runtime, code.as_deref(), message.as_str());
                normalize_status_auth_source(&mut status);
                let _ = persist_provider_status(&pool, &provider.id, &status).await;
                last_error = Some((code, message));
            }
            BridgeSendEvent::ToolTrace { tool_trace } => {
                if !emitted_first_provider_event {
                    emitted_first_provider_event = true;
                    timeline.emit("first_provider_event");
                }
                app_handle
                    .emit(
                        "ai:tool-trace",
                        AiStreamToolTraceEvent {
                            request_id: request.request_id.clone(),
                            tool_trace,
                        },
                    )
                    .map_err(|error| error.to_string())?;
            }
            BridgeSendEvent::ToolRequest {
                request_id,
                tool_call_id,
                tool_name,
                args,
            } => {
                if !emitted_first_provider_event {
                    emitted_first_provider_event = true;
                    timeline.emit("first_provider_event");
                }
                app_handle
                    .emit(
                        "ai:tool-request",
                        CopilotToolRequestEvent {
                            request_id,
                            tool_call_id,
                            tool_name,
                            args,
                        },
                    )
                    .map_err(|error| error.to_string())?;
            }
            BridgeSendEvent::Progress { .. } | BridgeSendEvent::LoginComplete { .. } => {}
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|error| format!("Failed to wait for AI runtime process: {}", error))?;
    let stderr_output = stderr_task.await.unwrap_or_default();

    if saw_done {
        return Ok(());
    }

    if let Some((code, message)) = last_error {
        return Err(code
            .map(|code| format!("{}: {}", code, message))
            .unwrap_or(message));
    }

    if !status.success() {
        if !stderr_output.trim().is_empty() {
            return Err(stderr_output);
        }
        return Err("Macro AI runtime exited unexpectedly.".to_string());
    }

    app_handle
        .emit(
            "ai:done",
            AiStreamDoneEvent {
                request_id: request.request_id,
                output_text: String::new(),
                tool_calls: Vec::new(),
                response_id: None,
                output_items: None,
                provider_input_items: None,
                provider_turn_state: None,
                reasoning_summary: None,
                tool_traces: None,
                hidden_context: None,
            },
        )
        .map_err(|error| error.to_string())?;
    timeline.emit("done");

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_copilot_send_timeout_to_thirty_minute_default() {
        assert_eq!(normalize_copilot_send_timeout_ms(None), 1_800_000);
        assert_eq!(normalize_copilot_send_timeout_ms(Some(30_000)), 1_800_000);
        assert_eq!(normalize_copilot_send_timeout_ms(Some(60_000)), 60_000);
        assert_eq!(
            normalize_copilot_send_timeout_ms(Some(2_400_000)),
            2_400_000
        );
    }

    #[test]
    fn bridge_done_event_deserializes_reasoning_summary() {
        let event = serde_json::from_str::<BridgeSendEvent>(
            r#"{
                "type": "done",
                "content": "Final answer.",
                "reasoning_summary": "Reasoning shown to the user."
            }"#,
        )
        .expect("done event should deserialize");

        match event {
            BridgeSendEvent::Done {
                content,
                reasoning_summary,
                ..
            } => {
                assert_eq!(content, "Final answer.");
                assert_eq!(
                    reasoning_summary.as_deref(),
                    Some("Reasoning shown to the user.")
                );
            }
            _ => panic!("expected done event"),
        }
    }

    #[test]
    fn resource_candidates_include_flat_packaged_legacy_packaged_and_dev_paths() {
        let resolved =
            PathBuf::from("/App/Macro.app/Contents/Resources/copilot-runtime-manifest.json");
        let resource_dir = PathBuf::from("/App/Macro.app/Contents/Resources");
        let manifest_dir = PathBuf::from("/repo/src-tauri");

        let candidates = resource_candidates_from_paths(
            Some(resolved.clone()),
            Some(resource_dir.clone()),
            &manifest_dir,
            COPILOT_RUNTIME_MANIFEST_RESOURCE,
        );

        assert_eq!(candidates[0], resolved);
        assert!(candidates.contains(
            &resource_dir
                .join("resources")
                .join(COPILOT_RUNTIME_MANIFEST_RESOURCE)
        ));
        assert!(candidates.contains(
            &manifest_dir
                .join("resources")
                .join(COPILOT_RUNTIME_MANIFEST_RESOURCE)
        ));
    }

    #[test]
    fn resource_candidates_handle_nested_license_path() {
        let resource_dir = PathBuf::from("/App/Macro.app/Contents/Resources");
        let manifest_dir = PathBuf::from("/repo/src-tauri");

        let candidates = resource_candidates_from_paths(
            Some(resource_dir.join(COPILOT_RUNTIME_LICENSE_RESOURCE)),
            Some(resource_dir.clone()),
            &manifest_dir,
            COPILOT_RUNTIME_LICENSE_RESOURCE,
        );

        assert!(candidates.contains(&resource_dir.join(COPILOT_RUNTIME_LICENSE_RESOURCE)));
        assert!(candidates.contains(
            &resource_dir
                .join("resources")
                .join(COPILOT_RUNTIME_LICENSE_RESOURCE)
        ));
        assert!(candidates.contains(
            &manifest_dir
                .join("resources")
                .join(COPILOT_RUNTIME_LICENSE_RESOURCE)
        ));
    }

    #[test]
    fn cached_runtime_requires_matching_manifest_platform_version_and_existing_path() {
        let temp_path =
            std::env::temp_dir().join(format!("macro-copilot-cache-test-{}", std::process::id()));
        std::fs::write(&temp_path, "runtime").expect("temp runtime");
        let asset = CopilotRuntimeAsset {
            package_name: "@github/copilot-darwin-arm64".to_string(),
            version: "1.0.12".to_string(),
            platform: "darwin".to_string(),
            arch: "arm64".to_string(),
            url: "https://example.test/runtime.tgz".to_string(),
            archive_sha256: "archive".to_string(),
            archive_size: 1,
            binary_name: "copilot".to_string(),
            binary_sha256: "binary".to_string(),
            binary_size: 1,
        };
        let cache = CopilotRuntimeCache {
            manifest_version: "manifest-1".to_string(),
            platform_key: "macos-arm64".to_string(),
            path: temp_path.clone(),
            version: "1.0.12".to_string(),
            source: "managed".to_string(),
            validated_at: Instant::now(),
        };

        assert!(cached_runtime_matches(
            &cache,
            "manifest-1",
            "macos-arm64",
            &asset
        ));
        assert!(!cached_runtime_matches(
            &cache,
            "manifest-2",
            "macos-arm64",
            &asset
        ));
        assert!(!cached_runtime_matches(
            &cache,
            "manifest-1",
            "macos-x64",
            &asset
        ));

        let _ = std::fs::remove_file(temp_path);
        assert!(!cached_runtime_matches(
            &cache,
            "manifest-1",
            "macos-arm64",
            &asset
        ));
    }

    #[test]
    fn bridge_send_error_status_preserves_auth_classification() {
        let runtime = ResolvedRuntime {
            source: RuntimeSource::Managed,
            path: PathBuf::from("/tmp/copilot"),
            version: "1.0.12".to_string(),
        };

        let login_status =
            bridge_send_error_to_status(&runtime, Some("login_required"), "Please log in.");
        assert_eq!(login_status.runtime_status, "ready");
        assert_eq!(login_status.auth_status, "login_required");
        assert_eq!(login_status.error_code.as_deref(), Some("login_required"));

        let quota_status = bridge_send_error_to_status(
            &runtime,
            Some("quota_or_auth_error"),
            "Quota or auth failed.",
        );
        assert_eq!(quota_status.auth_status, "quota_or_auth_error");

        let generic_status = bridge_send_error_to_status(&runtime, None, "Unexpected failure.");
        assert_eq!(generic_status.auth_status, "error");
        assert_eq!(generic_status.runtime_version.as_deref(), Some("1.0.12"));
    }
}
