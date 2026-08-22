use super::{
    ConfigApiError, ConfigChangeSource, ConfigDocument, ConfigDocumentKind, ConfigManager,
    ConfigPatchRequest, ConfigPatchResult, ConfigScope, ConfigSnapshot, ConfigValidationResult,
    PendingSensitiveConfigChange,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeSet;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;

const EVENT_CHANGED: &str = "config://changed";
const EVENT_INVALID: &str = "config://invalid";
const EVENT_PENDING: &str = "config://pending-sensitive-change";
const EVENT_RESTART: &str = "config://restart-required";

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanSecretDto {
    pub id: String,
    pub namespace: String,
    pub secret_type: String,
    pub secret_ref: String,
}

fn collect_secret_references(value: &Value, target: &mut BTreeSet<String>) {
    match value {
        Value::String(value) if value.starts_with("macro-secret://") => {
            target.insert(value.clone());
        }
        Value::Array(values) => {
            for value in values {
                collect_secret_references(value, target);
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                collect_secret_references(value, target);
            }
        }
        _ => {}
    }
}

fn referenced_secret_ids(documents: &[Value]) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut api_keys = BTreeSet::new();
    let mut sessions = BTreeSet::new();
    let mut references = BTreeSet::new();
    for document in documents {
        collect_secret_references(document, &mut references);
    }
    for reference in references {
        if let Some(id) = reference.strip_prefix("macro-secret://web-search/") {
            api_keys.insert(format!("web-search:{id}"));
        } else if let Some(id) = reference.strip_prefix("macro-secret://mcp-env/") {
            api_keys.insert(format!("mcp-env:{}", id.replacen('/', ":", 1)));
        } else if let Some(id) = reference.strip_prefix("macro-secret://speech/") {
            api_keys.insert(format!("speech-provider:{id}"));
            api_keys.insert(format!("speech:{id}"));
        } else if let Some(id) = reference.strip_prefix("macro-secret://providers/") {
            api_keys.insert(id.to_string());
        } else if let Some(id) = reference.strip_prefix("macro-secret://chatgpt/") {
            sessions.insert(id.to_string());
        }
    }
    for document in documents {
        if let Some(providers) = document.get("providers").and_then(Value::as_object) {
            for provider_id in providers.keys() {
                api_keys.insert(provider_id.clone());
                sessions.insert(provider_id.clone());
            }
        }
        if let Some(speech_providers) = document.get("speechProviders").and_then(Value::as_object) {
            for provider_id in speech_providers.keys() {
                api_keys.insert(format!("speech-provider:{provider_id}"));
                api_keys.insert(format!("speech:{provider_id}"));
            }
        }
    }
    (api_keys, sessions)
}

pub async fn list_orphan_secrets(
    manager: &ConfigManager,
) -> Result<Vec<OrphanSecretDto>, ConfigApiError> {
    let documents = manager.secret_reference_documents().await;
    let (api_keys, sessions) = referenced_secret_ids(&documents);
    let entries = crate::secrets::list_secret_metadata().map_err(|error| ConfigApiError {
        code: "config.secrets.read_failed".to_string(),
        message: format!("Impossible de lire les métadonnées des secrets : {error}"),
        document: None,
        diagnostics: Vec::new(),
    })?;
    Ok(entries
        .into_iter()
        .filter(|entry| {
            if entry.namespace == "system" {
                return false;
            }
            match entry.secret_type.as_str() {
                "chatgptSession" => !sessions.contains(&entry.id),
                _ => !api_keys.contains(&entry.id),
            }
        })
        .map(|entry| OrphanSecretDto {
            id: entry.id,
            namespace: entry.namespace,
            secret_type: entry.secret_type,
            secret_ref: entry.secret_ref,
        })
        .collect())
}

#[tauri::command]
pub async fn config_list_orphan_secrets(
    manager: State<'_, ConfigManager>,
) -> Result<Vec<OrphanSecretDto>, ConfigApiError> {
    list_orphan_secrets(manager.inner()).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOrphanSecretRequest {
    id: String,
    secret_type: String,
}

pub async fn delete_orphan_secret(
    manager: &ConfigManager,
    request: DeleteOrphanSecretRequest,
) -> Result<(), ConfigApiError> {
    if !matches!(request.secret_type.as_str(), "apiKey" | "chatgptSession") {
        return Err(ConfigApiError {
            code: "config.secrets.invalid_type".to_string(),
            message: "Le type de secret à supprimer est invalide.".to_string(),
            document: None,
            diagnostics: Vec::new(),
        });
    }
    let _reference_guard = manager.lock_secret_references().await;
    let is_orphan = list_orphan_secrets(manager)
        .await?
        .into_iter()
        .any(|entry| entry.id == request.id && entry.secret_type == request.secret_type);
    if !is_orphan {
        return Err(ConfigApiError {
            code: "config.secrets.not_orphan".to_string(),
            message: "Ce secret est encore utilisé ou n’existe plus.".to_string(),
            document: None,
            diagnostics: Vec::new(),
        });
    }
    crate::secrets::delete_secret_metadata(&request.id, &request.secret_type).map_err(|error| {
        ConfigApiError {
            code: "config.secrets.delete_failed".to_string(),
            message: format!("Impossible de supprimer le secret orphelin : {error}"),
            document: None,
            diagnostics: Vec::new(),
        }
    })
}

#[tauri::command]
pub async fn config_delete_orphan_secret(
    manager: State<'_, ConfigManager>,
    request: DeleteOrphanSecretRequest,
) -> Result<(), ConfigApiError> {
    delete_orphan_secret(manager.inner(), request).await
}

#[tauri::command]
pub async fn config_get_snapshot(
    manager: State<'_, ConfigManager>,
    project_ids: Option<Vec<String>>,
) -> Result<ConfigSnapshot, ConfigApiError> {
    manager.get_snapshot(&project_ids.unwrap_or_default()).await
}

#[tauri::command]
pub async fn config_get_document(
    manager: State<'_, ConfigManager>,
    kind: ConfigDocumentKind,
    scope: Option<ConfigScope>,
) -> Result<ConfigDocument, ConfigApiError> {
    manager.get_document(kind, scope.unwrap_or_default()).await
}

#[tauri::command]
pub fn config_get_schema(
    manager: State<'_, ConfigManager>,
    kind: ConfigDocumentKind,
) -> Result<Value, ConfigApiError> {
    manager.get_schema(kind)
}

#[tauri::command]
pub fn config_validate_document(
    manager: State<'_, ConfigManager>,
    kind: ConfigDocumentKind,
    scope: Option<ConfigScope>,
    document: Value,
) -> ConfigValidationResult {
    manager.validate(kind, scope.unwrap_or_default(), &document)
}

#[tauri::command]
pub async fn config_apply_patch(
    app: AppHandle,
    manager: State<'_, ConfigManager>,
    mut request: ConfigPatchRequest,
) -> Result<ConfigPatchResult, ConfigApiError> {
    request.source = ConfigChangeSource::UserInterface;
    let result = manager.apply_patch(request).await?;
    emit_patch_events(&app, &result);
    Ok(result)
}

#[tauri::command]
pub async fn config_reset_path(
    app: AppHandle,
    manager: State<'_, ConfigManager>,
    kind: ConfigDocumentKind,
    scope: Option<ConfigScope>,
    path: String,
    expected_etag: String,
) -> Result<ConfigPatchResult, ConfigApiError> {
    let result = manager
        .reset_path(
            kind,
            scope.unwrap_or_default(),
            path,
            expected_etag,
            ConfigChangeSource::UserInterface,
        )
        .await?;
    emit_patch_events(&app, &result);
    Ok(result)
}

#[tauri::command]
pub async fn config_reload(
    app: AppHandle,
    manager: State<'_, ConfigManager>,
    kind: ConfigDocumentKind,
    scope: Option<ConfigScope>,
) -> Result<ConfigDocument, ConfigApiError> {
    let outcome = manager
        .reload(
            kind,
            scope.unwrap_or_default(),
            ConfigChangeSource::UserInterface,
        )
        .await?;
    if outcome.invalid {
        let _ = app.emit(EVENT_INVALID, &outcome.document);
    } else if outcome.changed {
        let _ = app.emit(EVENT_CHANGED, &outcome.document);
    }
    if let Some(pending) = &outcome.pending {
        let _ = app.emit(EVENT_PENDING, pending);
    }
    if outcome.restart_required {
        let _ = app.emit(EVENT_RESTART, &outcome.document);
    }
    Ok(outcome.document)
}

#[tauri::command]
pub async fn config_open_directory(
    app: AppHandle,
    manager: State<'_, ConfigManager>,
    kind: Option<ConfigDocumentKind>,
    scope: Option<ConfigScope>,
) -> Result<String, ConfigApiError> {
    let target = match kind {
        Some(kind) => manager
            .path_for_scope(kind, &scope.unwrap_or_default())
            .await?
            .parent()
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| manager.root().to_path_buf()),
        None => manager.root().to_path_buf(),
    };
    app.opener()
        .open_path(target.to_string_lossy().to_string(), None::<&str>)
        .map_err(|error| ConfigApiError {
            code: "config.directory.open_failed".to_string(),
            message: format!("Impossible d’ouvrir le dossier de configuration : {error}"),
            document: None,
            diagnostics: Vec::new(),
        })?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn config_accept_pending_change(
    app: AppHandle,
    manager: State<'_, ConfigManager>,
    id: String,
) -> Result<ConfigDocument, ConfigApiError> {
    let document = manager.accept_pending_change(&id).await?;
    let _ = app.emit(EVENT_CHANGED, &document);
    Ok(document)
}

#[tauri::command]
pub async fn config_reject_pending_change(
    app: AppHandle,
    manager: State<'_, ConfigManager>,
    id: String,
    restore_approved: bool,
) -> Result<ConfigDocument, ConfigApiError> {
    let document = manager.reject_pending_change(&id, restore_approved).await?;
    if restore_approved {
        let _ = app.emit(EVENT_CHANGED, &document);
    }
    Ok(document)
}

#[tauri::command]
pub async fn config_list_pending_changes(
    manager: State<'_, ConfigManager>,
) -> Result<Vec<PendingSensitiveConfigChange>, ConfigApiError> {
    Ok(manager.list_pending_changes().await)
}

// Agent-facing structured aliases. They intentionally use the same manager and
// therefore the same validation, ETag and approval rules as the UI.
#[tauri::command]
pub async fn config_list(
    manager: State<'_, ConfigManager>,
    project_ids: Option<Vec<String>>,
) -> Result<ConfigSnapshot, ConfigApiError> {
    manager.get_snapshot(&project_ids.unwrap_or_default()).await
}

#[tauri::command]
pub async fn config_get(
    manager: State<'_, ConfigManager>,
    kind: ConfigDocumentKind,
    scope: Option<ConfigScope>,
) -> Result<ConfigDocument, ConfigApiError> {
    manager.get_document(kind, scope.unwrap_or_default()).await
}

#[tauri::command]
pub fn config_validate(
    manager: State<'_, ConfigManager>,
    kind: ConfigDocumentKind,
    scope: Option<ConfigScope>,
    document: Value,
) -> ConfigValidationResult {
    manager.validate(kind, scope.unwrap_or_default(), &document)
}

#[tauri::command]
pub async fn config_patch(
    app: AppHandle,
    manager: State<'_, ConfigManager>,
    mut request: ConfigPatchRequest,
) -> Result<ConfigPatchResult, ConfigApiError> {
    request.source = ConfigChangeSource::Agent;
    let result = manager.apply_patch(request).await?;
    emit_patch_events(&app, &result);
    Ok(result)
}

fn emit_patch_events(app: &AppHandle, result: &ConfigPatchResult) {
    if let Some(pending) = &result.pending_change {
        let _ = app.emit(EVENT_PENDING, pending);
    } else {
        let _ = app.emit(EVENT_CHANGED, &result.document);
    }
    if result.restart_required {
        let _ = app.emit(EVENT_RESTART, &result.document);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn project_and_pending_documents_keep_referenced_secrets_alive() {
        let documents = vec![
            json!({
                "mcpServers": {
                    "project-server": {
                        "transport": {
                            "env": {
                                "TOKEN": "macro-secret://mcp-env/project-server/TOKEN"
                            }
                        }
                    }
                }
            }),
            json!({
                "providers": { "custom-provider": { "enabled": true } },
                "speechProviders": { "dictation": { "enabled": true } },
                "webSearch": { "secretRef": "macro-secret://web-search/brave" }
            }),
        ];
        let (api_keys, sessions) = referenced_secret_ids(&documents);
        assert!(api_keys.contains("mcp-env:project-server:TOKEN"));
        assert!(api_keys.contains("custom-provider"));
        assert!(sessions.contains("custom-provider"));
        assert!(api_keys.contains("speech-provider:dictation"));
        assert!(api_keys.contains("speech:dictation"));
        assert!(api_keys.contains("web-search:brave"));
    }
}
