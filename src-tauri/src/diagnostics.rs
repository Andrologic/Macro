use crate::app_updates::{diagnostic_manifest, StagedUpdatePhase};
use crate::commands::mcp::{McpRuntimeManager, McpRuntimeStatus};
use crate::commands::{DbInitializationState, DbPool};
use crate::config::ConfigManager;
use crate::core::platform_log_dir;
use chrono::Utc;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, State};
use tempfile::Builder as TempFileBuilder;

const REPORT_SCHEMA_VERSION: u32 = 1;
const MAX_LOG_READ_BYTES: u64 = 64 * 1024;
const MAX_LOG_EVENTS: usize = 50;

#[derive(Default)]
pub struct DiagnosticReportStore {
    report: Mutex<Option<StoredDiagnosticReport>>,
}

#[derive(Clone)]
struct StoredDiagnosticReport {
    id: String,
    content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticReportPreview {
    report_id: String,
    suggested_file_name: String,
    content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticReport {
    schema_version: u32,
    generated_at: String,
    application: ApplicationDiagnostic,
    configuration: ConfigurationDiagnostic,
    database: DatabaseDiagnostic,
    mcp: McpDiagnostic,
    updater: UpdaterDiagnostic,
    logs: LogDiagnostic,
    privacy: PrivacyDiagnostic,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplicationDiagnostic {
    version: String,
    operating_system: &'static str,
    architecture: &'static str,
    build_profile: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigurationDiagnostic {
    schema_version: u32,
    document_count: usize,
    invalid_document_count: usize,
    diagnostic_codes: Vec<String>,
    pending_restart_count: usize,
    effective_non_secret: BTreeMap<String, Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseDiagnostic {
    status: String,
    integrity: String,
    migration_count: Option<i64>,
    latest_migration: Option<i64>,
    recovery: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpDiagnostic {
    server_count: usize,
    status_counts: BTreeMap<String, usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdaterDiagnostic {
    status: String,
    target: Option<String>,
    activation_attempts: Option<u8>,
    has_error: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogDiagnostic {
    source_available: bool,
    read_limit_bytes: u64,
    event_limit: usize,
    omitted_line_count: usize,
    events: Vec<SafeLogEvent>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SafeLogEvent {
    timestamp: String,
    level: String,
    target: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrivacyDiagnostic {
    excluded: [&'static str; 5],
}

#[tauri::command]
pub async fn app_diagnostic_generate(
    app: AppHandle,
    pool: State<'_, DbPool>,
    config: State<'_, ConfigManager>,
    mcp: State<'_, McpRuntimeManager>,
    reports: State<'_, DiagnosticReportStore>,
) -> Result<DiagnosticReportPreview, String> {
    let configuration = configuration_diagnostic(config.inner()).await?;
    let database = database_diagnostic(pool.inner(), &app).await;
    let runtime = mcp.snapshot().await;
    let updater = updater_diagnostic(&app);
    let logs = log_diagnostic(platform_log_dir());
    let generated_at = Utc::now();
    let report = DiagnosticReport {
        schema_version: REPORT_SCHEMA_VERSION,
        generated_at: generated_at.to_rfc3339(),
        application: ApplicationDiagnostic {
            version: app.package_info().version.to_string(),
            operating_system: std::env::consts::OS,
            architecture: std::env::consts::ARCH,
            build_profile: if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            },
        },
        configuration,
        database,
        mcp: McpDiagnostic {
            server_count: runtime.servers.len(),
            status_counts: runtime
                .servers
                .iter()
                .fold(BTreeMap::new(), |mut counts, server| {
                    *counts
                        .entry(mcp_status_name(server.status).to_string())
                        .or_insert(0) += 1;
                    counts
                }),
        },
        updater,
        logs,
        privacy: PrivacyDiagnostic {
            excluded: [
                "secrets",
                "prompts",
                "sourceCode",
                "privatePaths",
                "userContent",
            ],
        },
    };
    let content = serde_json::to_string_pretty(&report)
        .map_err(|error| format!("Impossible de générer le diagnostic : {error}"))?;
    let report_id = uuid::Uuid::new_v4().to_string();
    *reports
        .report
        .lock()
        .map_err(|_| "DIAGNOSTIC_STATE_UNAVAILABLE".to_string())? = Some(StoredDiagnosticReport {
        id: report_id.clone(),
        content: content.clone(),
    });
    Ok(DiagnosticReportPreview {
        report_id,
        suggested_file_name: format!(
            "macro-diagnostic-{}.json",
            generated_at.format("%Y%m%d-%H%M%S")
        ),
        content,
    })
}

#[tauri::command]
pub fn app_diagnostic_save(
    report_id: String,
    path: String,
    reports: State<'_, DiagnosticReportStore>,
) -> Result<(), String> {
    let destination = validate_destination(&path)?;
    let content = {
        let state = reports
            .report
            .lock()
            .map_err(|_| "DIAGNOSTIC_STATE_UNAVAILABLE".to_string())?;
        let report = state
            .as_ref()
            .filter(|report| report.id == report_id)
            .ok_or_else(|| "DIAGNOSTIC_REPORT_EXPIRED".to_string())?;
        report.content.clone()
    };
    persist_report(&destination, content.as_bytes())
}

async fn configuration_diagnostic(
    manager: &ConfigManager,
) -> Result<ConfigurationDiagnostic, String> {
    let snapshot = manager
        .get_snapshot(&[])
        .await
        .map_err(|_| "DIAGNOSTIC_CONFIG_UNAVAILABLE".to_string())?;
    let mut diagnostic_codes = snapshot
        .diagnostics
        .iter()
        .filter(|item| {
            item.code.len() <= 64
                && item
                    .code
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
        })
        .map(|item| item.code.clone())
        .collect::<Vec<_>>();
    diagnostic_codes.sort();
    diagnostic_codes.dedup();
    Ok(ConfigurationDiagnostic {
        schema_version: snapshot.schema_version,
        document_count: snapshot.documents.len(),
        invalid_document_count: snapshot
            .documents
            .iter()
            .filter(|document| document.invalid)
            .count(),
        diagnostic_codes,
        pending_restart_count: snapshot.pending_restart_paths.len(),
        effective_non_secret: safe_effective_config(&snapshot.effective),
    })
}

fn safe_effective_config(effective: &BTreeMap<String, Value>) -> BTreeMap<String, Value> {
    const POINTERS: &[(&str, &str)] = &[
        ("settings", "/language"),
        ("settings", "/appearance/zoomMode"),
        ("settings", "/code/overflowMode"),
        ("settings", "/notifications/inAppEnabled"),
        ("agents", "/maxTurns"),
        ("agents", "/compaction/automatic"),
        ("agents", "/compaction/prune"),
        ("agents", "/reviewPresentation"),
        ("tools", "/riskLevel"),
        ("tools", "/webSearch/enabled"),
        ("tools", "/webSearch/fetchEnabled"),
        ("tools", "/webSearch/maxResults"),
        ("tools", "/projectSwitchPolicy"),
        ("git", "/completionMergePolicy"),
        ("git", "/syncTargetBeforeFinish"),
        ("git", "/metadataAutoPush"),
    ];
    POINTERS
        .iter()
        .filter_map(|(document, pointer)| {
            let value = effective.get(*document)?.pointer(pointer)?;
            let safe = match value {
                Value::Bool(_) | Value::Number(_) => value.clone(),
                Value::String(text)
                    if text.len() <= 64
                        && !text
                            .chars()
                            .any(|character| matches!(character, '/' | '\\' | ':')) =>
                {
                    value.clone()
                }
                _ => return None,
            };
            Some((format!("{document}{pointer}"), safe))
        })
        .collect()
}

async fn database_diagnostic(pool: &DbPool, app: &AppHandle) -> DatabaseDiagnostic {
    let recovery = crate::local_backup::local_backup_status(app.clone())
        .map(|status| recovery_status(&status.message).to_string())
        .unwrap_or_else(|_| "unavailable".to_string());
    let database = match pool.current() {
        DbInitializationState::Ready(database) => database,
        state => {
            let status = match state {
                DbInitializationState::Initializing => "initializing",
                DbInitializationState::Failed(_) => "failed",
                DbInitializationState::Ready(_) => unreachable!(),
            };
            return DatabaseDiagnostic {
                status: status.into(),
                integrity: "notChecked".into(),
                migration_count: None,
                latest_migration: None,
                recovery,
            };
        }
    };
    let integrity = sqlx::query_scalar::<_, String>("PRAGMA quick_check(1)")
        .fetch_one(&database)
        .await
        .map(|value| if value == "ok" { "ok" } else { "failed" })
        .unwrap_or("unavailable")
        .to_string();
    let migrations = sqlx::query_as::<_, (i64, i64)>(
        "SELECT COUNT(*), COALESCE(MAX(version), 0) FROM schema_migrations",
    )
    .fetch_one(&database)
    .await
    .ok();
    DatabaseDiagnostic {
        status: "ready".into(),
        integrity,
        migration_count: migrations.map(|value| value.0),
        latest_migration: migrations.map(|value| value.1),
        recovery,
    }
}

fn recovery_status(message: &str) -> &'static str {
    let normalized = message.to_ascii_lowercase();
    if normalized.is_empty() {
        "none"
    } else if normalized.contains("failed") || normalized.contains("échec") {
        "failed"
    } else if normalized.contains("recover")
        || normalized.contains("récup")
        || normalized.contains("restor")
    {
        "completed"
    } else {
        "completed"
    }
}

fn mcp_status_name(status: McpRuntimeStatus) -> &'static str {
    match status {
        McpRuntimeStatus::Disconnected => "disconnected",
        McpRuntimeStatus::Probing => "probing",
        McpRuntimeStatus::Connecting => "connecting",
        McpRuntimeStatus::Ready => "ready",
        McpRuntimeStatus::Reconnecting => "reconnecting",
        McpRuntimeStatus::Failed => "failed",
    }
}

fn updater_diagnostic(app: &AppHandle) -> UpdaterDiagnostic {
    match diagnostic_manifest(app) {
        Ok(Some(manifest)) => UpdaterDiagnostic {
            status: match manifest.phase {
                StagedUpdatePhase::Staged => "staged",
                StagedUpdatePhase::Activating => "activating",
                StagedUpdatePhase::Failed => "failed",
            }
            .into(),
            target: safe_token(&manifest.target),
            activation_attempts: Some(manifest.activation_attempts),
            has_error: manifest.error.is_some(),
        },
        Ok(None) => UpdaterDiagnostic {
            status: "none".into(),
            target: None,
            activation_attempts: None,
            has_error: false,
        },
        Err(_) => UpdaterDiagnostic {
            status: "unreadable".into(),
            target: None,
            activation_attempts: None,
            has_error: true,
        },
    }
}

fn log_diagnostic(directory: Option<PathBuf>) -> LogDiagnostic {
    let Some(directory) = directory else {
        return empty_log_diagnostic(false);
    };
    let latest = fs::read_dir(directory).ok().and_then(|entries| {
        entries
            .flatten()
            .filter_map(|entry| {
                let metadata = entry.metadata().ok()?;
                let name = entry.file_name();
                (metadata.is_file()
                    && name.to_string_lossy().starts_with("macro.")
                    && name.to_string_lossy().ends_with(".log"))
                .then_some((metadata.modified().ok()?, entry.path()))
            })
            .max_by_key(|(modified, _)| *modified)
            .map(|(_, path)| path)
    });
    let Some(path) = latest else {
        return empty_log_diagnostic(false);
    };
    let Ok((lines, truncated)) = read_bounded_log_tail(&path) else {
        return empty_log_diagnostic(true);
    };
    let parsed = lines
        .lines()
        .filter_map(parse_safe_log_event)
        .collect::<Vec<_>>();
    let omitted_line_count = lines.lines().count().saturating_sub(parsed.len())
        + parsed.len().saturating_sub(MAX_LOG_EVENTS)
        + usize::from(truncated);
    let events = parsed
        .into_iter()
        .rev()
        .take(MAX_LOG_EVENTS)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    LogDiagnostic {
        source_available: true,
        read_limit_bytes: MAX_LOG_READ_BYTES,
        event_limit: MAX_LOG_EVENTS,
        omitted_line_count,
        events,
    }
}

fn safe_token(value: &str) -> Option<String> {
    (value.len() <= 64
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character)))
    .then(|| value.to_string())
}

fn empty_log_diagnostic(source_available: bool) -> LogDiagnostic {
    LogDiagnostic {
        source_available,
        read_limit_bytes: MAX_LOG_READ_BYTES,
        event_limit: MAX_LOG_EVENTS,
        omitted_line_count: 0,
        events: Vec::new(),
    }
}

fn read_bounded_log_tail(path: &Path) -> Result<(String, bool), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("DIAGNOSTIC_LOG_INVALID".into());
    }
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let truncated = metadata.len() > MAX_LOG_READ_BYTES;
    if truncated {
        file.seek(SeekFrom::End(-(MAX_LOG_READ_BYTES as i64)))
            .map_err(|error| error.to_string())?;
    }
    let mut bytes = Vec::with_capacity(MAX_LOG_READ_BYTES as usize);
    file.take(MAX_LOG_READ_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    Ok((String::from_utf8_lossy(&bytes).into_owned(), truncated))
}

fn parse_safe_log_event(line: &str) -> Option<SafeLogEvent> {
    let mut fields = line.split_whitespace();
    let timestamp = fields.next()?;
    let level = fields.next()?;
    let raw_target = fields.next()?.trim_end_matches(':');
    if timestamp.len() > 40
        || !timestamp
            .chars()
            .all(|character| character.is_ascii_digit() || "-:.+TZ".contains(character))
    {
        return None;
    }
    if !matches!(level, "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR") {
        return None;
    }
    // Log messages may contain line breaks and imitate the text formatter's
    // prefix. Never copy an arbitrary third field: reduce known targets to a
    // fixed component label so message content cannot enter the report.
    let target = match raw_target.split("::").next()? {
        "macro" => "macro",
        "macro_lib" => "macro_lib",
        "tauri" => "tauri",
        "tauri_remote_ui" => "tauri_remote_ui",
        "sqlx" => "sqlx",
        "tracing" => "tracing",
        "wry" => "wry",
        _ => return None,
    };
    Some(SafeLogEvent {
        timestamp: timestamp.into(),
        level: level.into(),
        target: target.to_string(),
    })
}

fn validate_destination(path: &str) -> Result<PathBuf, String> {
    let destination = PathBuf::from(path);
    if !destination.is_absolute()
        || destination.extension().and_then(|value| value.to_str()) != Some("json")
    {
        return Err("DIAGNOSTIC_DESTINATION_INVALID".into());
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "DIAGNOSTIC_DESTINATION_INVALID".to_string())?;
    if !parent.is_dir() {
        return Err("DIAGNOSTIC_DESTINATION_INVALID".into());
    }
    Ok(destination)
}

fn persist_report(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "DIAGNOSTIC_DESTINATION_INVALID".to_string())?;
    let mut temporary = TempFileBuilder::new()
        .prefix(".macro-diagnostic-")
        .tempfile_in(parent)
        .map_err(|error| format!("Impossible de préparer le rapport : {error}"))?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("Impossible d’enregistrer le rapport : {error}"))?;
    temporary
        .persist(path)
        .map(|_| ())
        .map_err(|error| format!("Impossible de finaliser le rapport : {}", error.error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_configuration_uses_only_declared_scalar_fields() {
        let effective = BTreeMap::from([
            (
                "settings".into(),
                serde_json::json!({"language":"fr","defaultWorkspace":"/Users/private/project"}),
            ),
            (
                "providers".into(),
                serde_json::json!({"apiKey":"top-secret"}),
            ),
            (
                "agents".into(),
                serde_json::json!({"maxTurns":12,"prompts":{"chat":"private prompt"}}),
            ),
        ]);
        let safe = safe_effective_config(&effective);
        let serialized = serde_json::to_string(&safe).unwrap();
        assert_eq!(
            safe.get("settings/language"),
            Some(&Value::String("fr".into()))
        );
        assert_eq!(safe.get("agents/maxTurns"), Some(&Value::from(12)));
        assert!(!serialized.contains("top-secret"));
        assert!(!serialized.contains("private prompt"));
        assert!(!serialized.contains("/Users/private"));
    }

    #[test]
    fn log_parser_drops_messages_secrets_and_private_paths() {
        let line =
            "2026-09-06T10:11:12.000Z INFO macro_lib::db: token=secret /Users/private source code";
        let event = parse_safe_log_event(line).unwrap();
        let serialized = serde_json::to_string(&event).unwrap();
        assert_eq!(event.target, "macro_lib");
        assert!(!serialized.contains("secret"));
        assert!(!serialized.contains("/Users"));
        assert!(!serialized.contains("source code"));
        assert_eq!(safe_token("darwin-aarch64"), Some("darwin-aarch64".into()));
        assert_eq!(safe_token("/Users/private/token"), None);

        let spoofed_continuation =
            "2026-09-06T10:11:12.000Z INFO macro_lib::sk-proj-secret private message";
        let spoofed = parse_safe_log_event(spoofed_continuation).unwrap();
        assert_eq!(spoofed.target, "macro_lib");
        assert!(!serde_json::to_string(&spoofed)
            .unwrap()
            .contains("sk-proj-secret"));
        assert!(parse_safe_log_event(
            "2026-09-06T10:11:12.000Z INFO sk-proj-secret private message"
        )
        .is_none());
    }

    #[test]
    fn report_store_saves_only_the_generated_preview() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("diagnostic.json");
        let store = DiagnosticReportStore::default();
        *store.report.lock().unwrap() = Some(StoredDiagnosticReport {
            id: "known".into(),
            content: "{\"safe\":true}".into(),
        });
        let content = store
            .report
            .lock()
            .unwrap()
            .as_ref()
            .filter(|report| report.id == "known")
            .unwrap()
            .content
            .clone();
        persist_report(&destination, content.as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(destination).unwrap(), "{\"safe\":true}");
        assert!(validate_destination("relative.json").is_err());
    }
}
