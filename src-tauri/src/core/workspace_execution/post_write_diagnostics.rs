//! Bounded observations of committed local edits. Each document gets a fresh
//! connection: unversioned push diagnostics cannot belong to an older overlay.
use super::{fs, PendingFileChange, ToolCancellation};
use crate::config::{ConfigDocumentKind, LanguageServerSettings};
use crate::lsp::{ClientState, LspClient, LspEvent, LspServerConfig};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::time::{Duration, Instant};

const MAX_DOCUMENTS: usize = 4;
const MAX_DIAGNOSTICS: usize = 20;
const MAX_TEXT_BYTES: usize = 1024 * 1024;
const BATCH_WAIT: Duration = Duration::from_secs(10);

struct Context {
    settings: Option<LanguageServerSettings>,
    cancellation: Arc<ToolCancellation>,
}
tokio::task_local! { static CONTEXT: Context; }
#[cfg(test)]
tokio::task_local! { static TEST_SETTINGS: LanguageServerSettings; }

pub(super) async fn with_context<T>(
    cancellation: Arc<ToolCancellation>,
    operation: impl Future<Output = T>,
) -> T {
    let settings = match crate::config::runtime_config_manager() {
        Some(manager) => serde_json::from_value::<LanguageServerSettings>(
            manager
                .effective_user_document(ConfigDocumentKind::Tools)
                .await["languageServer"]
                .clone(),
        )
        .ok(),
        None => None,
    };
    #[cfg(test)]
    let settings = TEST_SETTINGS.try_with(Clone::clone).ok().or(settings);
    CONTEXT
        .scope(
            Context {
                settings,
                cancellation,
            },
            operation,
        )
        .await
}

type Roots = HashMap<PathBuf, fs::WorkspaceRootIdentity>;

pub(super) fn capture_roots(changes: &[PendingFileChange]) -> Roots {
    changes
        .iter()
        .filter_map(|change| {
            fs::workspace_root_identity(&change.effective_workspace)
                .ok()
                .map(|identity| (change.effective_workspace.clone(), identity))
        })
        .collect()
}

async fn is_current(change: &PendingFileChange, roots: &Roots) -> bool {
    if roots.get(&change.effective_workspace).copied()
        != fs::workspace_root_identity(&change.effective_workspace).ok()
        || !roots.contains_key(&change.effective_workspace)
    {
        return false;
    }
    let Some(content) = &change.new_content else {
        return false;
    };
    let expected = Arc::new(
        roots
            .iter()
            .map(|(root, identity)| (root.clone(), *identity))
            .collect(),
    );
    let read = fs::with_expected_workspace_roots(
        expected,
        fs::read_file_internal(
            &change.effective_workspace,
            change.effective_path.clone(),
            Some(false),
        ),
    );
    matches!(tokio::time::timeout(Duration::from_millis(250), read).await,
        Ok(Ok(current)) if current.revision == fs::content_revision(content.as_bytes()))
        && roots.get(&change.effective_workspace).copied()
            == fs::workspace_root_identity(&change.effective_workspace).ok()
}

pub(super) async fn collect(changes: &[PendingFileChange], roots: Roots) -> Vec<Value> {
    let context = CONTEXT
        .try_with(|context| (context.settings.clone(), context.cancellation.clone()))
        .ok();
    let deadline = Instant::now() + BATCH_WAIT;
    let mut results = Vec::with_capacity(changes.len().min(MAX_DOCUMENTS));
    for (index, change) in changes.iter().take(MAX_DOCUMENTS).enumerate() {
        let start = Instant::now();
        let canonical_root = change.effective_workspace.canonicalize().ok();
        let uri = url::Url::from_file_path(&change.absolute_path)
            .ok()
            .map(|uri| uri.to_string());
        let revision = change
            .new_content
            .as_ref()
            .map(|text| fs::content_revision(text.as_bytes()));
        let mut result = json!({
            "path": change.display_path, "root": canonical_root, "uri": uri,
            "workspace_path": change.effective_workspace, "document_path": change.effective_path,
            "root_identity": roots.get(&change.effective_workspace).and_then(|identity| identity.observation_key()),
            "revision": revision, "version": 1, "session": uuid::Uuid::new_v4().to_string(),
            "status": "disabled", "items": [], "truncated": false,
        });
        let language = match change
            .absolute_path
            .extension()
            .and_then(|value| value.to_str())
        {
            Some("ts" | "mts" | "cts") => Some("typescript"),
            Some("tsx") => Some("typescriptreact"),
            Some("js" | "mjs" | "cjs") => Some("javascript"),
            Some("jsx") => Some("javascriptreact"),
            _ => None,
        };
        if change.new_content.is_none() {
            result["status"] = json!("deleted");
        } else if language.is_none()
            || super::parse_wsl_unc_path(&change.effective_workspace.to_string_lossy()).is_some()
        {
            result["status"] = json!("unsupported");
        } else if let Some((Some(settings), cancellation)) = &context {
            if settings.enabled {
                let allowed = canonical_root.as_ref().is_some_and(|root| {
                    settings.workspace_roots.iter().any(|allowed| {
                        // A removed root or a symlink replacement must not silently expand approval.
                        std::path::Path::new(allowed) == root
                    })
                });
                if settings.validate().is_err() || !allowed {
                    result["status"] = json!("unavailable");
                    result["reason"] = json!("configuration_or_root_not_authorized");
                } else if change
                    .new_content
                    .as_ref()
                    .is_some_and(|text| text.len() > MAX_TEXT_BYTES)
                {
                    result["status"] = json!("unavailable");
                    result["reason"] = json!("document_size_limit");
                } else if !is_current(change, &roots).await {
                    result["status"] = json!("stale");
                } else if cancellation.is_cancelled() {
                    result["status"] = json!("cancelled");
                } else if Instant::now() >= deadline {
                    result["status"] = json!("pending");
                    result["reason"] = json!("batch_wait_limit");
                } else if let (Some(root), Some(uri), Some(language)) =
                    (canonical_root, uri, language)
                {
                    // Share the remaining batch budget instead of multiplying it by file count.
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    let slots = changes.len().min(MAX_DOCUMENTS) - index;
                    let wait = Duration::from_millis(settings.wait_ms as u64)
                        .min(remaining / slots as u32);
                    observe(
                        settings,
                        cancellation,
                        root,
                        &uri,
                        language,
                        change.new_content.as_deref().unwrap_or_default(),
                        wait,
                        &mut result,
                    )
                    .await;
                } else {
                    result["status"] = json!("unavailable");
                    result["reason"] = json!("invalid_local_uri");
                }
            }
        }
        result["wait_ms"] = json!(start.elapsed().as_millis() as u64);
        results.push(result);
    }
    // Recheck the entire batch after all waits, not just each result at arrival.
    for (change, result) in changes.iter().zip(&mut results) {
        if context
            .as_ref()
            .is_some_and(|(_, token)| token.is_cancelled())
            && result["status"] == "ready"
        {
            result["status"] = json!("cancelled");
            result["items"] = json!([]);
        }
        if result["status"] == "ready" && !is_current(change, &roots).await {
            result["status"] = json!("stale");
            result["items"] = json!([]);
            result["truncated"] = json!(false);
        }
    }
    if changes.len() > MAX_DOCUMENTS {
        results.push(
            json!({"status": "pending", "reason": "document_count_limit",
            "omitted_documents": changes.len() - MAX_DOCUMENTS, "items": []}),
        );
    }
    results
}

#[allow(clippy::too_many_arguments)]
async fn observe(
    settings: &LanguageServerSettings,
    cancellation: &ToolCancellation,
    root: PathBuf,
    uri: &str,
    language: &str,
    text: &str,
    wait: Duration,
    result: &mut Value,
) {
    if !std::path::Path::new(&settings.executable).is_file() {
        result["status"] = json!("unavailable");
        result["reason"] = json!("executable_missing");
        return;
    }
    let root_uri = url::Url::from_directory_path(&root).ok();
    let mut config = LspServerConfig::new(
        &settings.executable,
        root,
        json!({
            "processId": std::process::id(), "rootUri": root_uri,
            "initializationOptions": {"disableAutomaticTypingAcquisition": true},
            "capabilities": {"textDocument": {"publishDiagnostics": {"versionSupport": true}}},
            "workspaceFolders": [{"uri": root_uri, "name": "workspace"}],
        }),
    );
    config.arguments = settings.arguments.iter().map(Into::into).collect();
    config.startup_timeout = wait.max(Duration::from_millis(1));
    config.shutdown_timeout = Duration::from_millis(100);
    config.max_message_bytes = 2 * 1024 * 1024;
    let Ok(client) = LspClient::new(config, None) else {
        result["status"] = json!("unavailable");
        return;
    };
    let mut events = client.subscribe();
    let mut state = client.subscribe_state();
    let deadline = Instant::now() + wait;
    let startup = tokio::select! {
        biased;
        _ = cancellation.cancelled() => "cancelled",
        _ = tokio::time::sleep_until(deadline) => "timeout",
        started = client.start() => if started.is_ok() { "started" } else { "failed" },
    };
    result["status"] = json!(startup);
    if startup == "started" {
        result["status"] = json!("pending");
        let observation = async {
            if client.open_document(uri, language, 1, text).await.is_err() {
                result["status"] = json!("failed");
                return;
            }
            result["status"] = json!("pending");
            loop {
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => {
                        result["status"] = json!("cancelled");
                        break;
                    },
                    _ = tokio::time::sleep_until(deadline) => break,
                    changed = state.changed() => {
                        if changed.is_err() || matches!(*state.borrow(), ClientState::Failed | ClientState::Stopped) {
                            result["status"] = json!("failed");
                            break;
                        }
                    },
                    event = events.recv() => match event {
                        Ok(LspEvent::Diagnostics { params }) if params["uri"] == uri => {
                            if params.get("version").is_some_and(|version| !version.is_null() && version.as_i64() != Some(1)) {
                                result["status"] = json!("stale");
                                result["items"] = json!([]);
                                continue;
                            }
                            if let Some(items) = params["diagnostics"].as_array() {
                                result["status"] = json!("ready");
                                result["items"] = Value::Array(items.iter().take(MAX_DIAGNOSTICS).map(bounded_diagnostic).collect());
                                result["truncated"] = json!(items.len() > MAX_DIAGNOSTICS);
                                result["server_version"] = params.get("version").cloned().unwrap_or(Value::Null);
                            }
                        },
                        Err(_) => { result["status"] = json!("failed"); break; },
                        _ => {},
                    }
                }
            }
        };
        // didOpen itself also belongs to the deadline and cancellation budget.
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => result["status"] = json!("cancelled"),
            _ = tokio::time::sleep_until(deadline) => {},
            _ = observation => {},
        }
    }
    if result["status"] != "ready" {
        result["items"] = json!([]);
    }
    // Cleanup is bounded independently; Drop forces termination if graceful shutdown stalls.
    let _ = tokio::time::timeout(Duration::from_millis(500), client.shutdown()).await;
}

fn bounded_diagnostic(diagnostic: &Value) -> Value {
    fn short(value: &Value) -> Value {
        value
            .as_str()
            .map(|value| Value::String(value.chars().take(2048).collect()))
            .unwrap_or(Value::Null)
    }
    // Whitelist scalar fields; server-specific data and related documents are excluded.
    let position = |name: &str| {
        json!({
            "line": diagnostic["range"][name]["line"].as_u64(),
            "character": diagnostic["range"][name]["character"].as_u64(),
        })
    };
    json!({
        "range": {"start": position("start"), "end": position("end")},
        "severity": diagnostic["severity"].as_u64(),
        "code": diagnostic["code"].as_i64().map(Value::from).unwrap_or_else(|| short(&diagnostic["code"])),
        "source": short(&diagnostic["source"]), "message": short(&diagnostic["message"]),
    })
}

#[cfg(test)]
mod tests;
