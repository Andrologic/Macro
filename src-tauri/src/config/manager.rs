use super::registry::{
    apply_modes_for_paths, classify_sensitive_paths, collect_leaf_pointers, default_document,
    effective_documents, project_overlay_is_restrictive, schema_map, sparse_document,
    strip_default_values, validate_document,
};
use super::types::*;
use chrono::Utc;
use fs2::FileExt;
use json_patch::Patch;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
#[cfg(unix)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct DocumentKey {
    kind: ConfigDocumentKind,
    scope: ConfigScope,
}

#[derive(Clone, Debug)]
struct StoredDocument {
    path: PathBuf,
    disk_value: Value,
    last_valid_value: Value,
    etag: String,
    read_only: bool,
    invalid: bool,
    diagnostics: Vec<ConfigDiagnostic>,
    last_internal_hash: Option<String>,
}

#[derive(Default)]
struct ConfigState {
    documents: BTreeMap<DocumentKey, StoredDocument>,
    project_roots: BTreeMap<String, PathBuf>,
    session_documents: BTreeMap<ConfigDocumentKind, Value>,
    pending_changes: BTreeMap<String, PendingSensitiveConfigChange>,
    pending_restart_paths: BTreeSet<String>,
}

#[derive(Clone)]
pub struct ConfigManager {
    root: Arc<PathBuf>,
    state: Arc<RwLock<ConfigState>>,
    document_locks: Arc<Mutex<BTreeMap<DocumentKey, Arc<Mutex<()>>>>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigApiError {
    pub code: String,
    pub message: String,
    pub document: Option<ConfigDocument>,
    pub diagnostics: Vec<ConfigDiagnostic>,
}

impl ConfigApiError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            document: None,
            diagnostics: Vec::new(),
        }
    }

    fn with_document(mut self, document: ConfigDocument) -> Self {
        self.document = Some(document);
        self
    }

    fn with_diagnostics(mut self, diagnostics: Vec<ConfigDiagnostic>) -> Self {
        self.diagnostics = diagnostics;
        self
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReloadOutcome {
    pub changed: bool,
    pub invalid: bool,
    pub pending: Option<PendingSensitiveConfigChange>,
    pub restart_required: bool,
    pub document: ConfigDocument,
}

impl ConfigManager {
    pub async fn initialize(root: PathBuf) -> Result<Self, ConfigApiError> {
        if root.as_os_str().is_empty() {
            return Err(ConfigApiError::new(
                "config.root.empty",
                "Le dossier de configuration est vide.",
            ));
        }
        fs::create_dir_all(&root).map_err(|error| {
            ConfigApiError::new(
                "config.root.create_failed",
                format!(
                    "Impossible de créer le dossier de configuration {} : {error}",
                    root.display()
                ),
            )
        })?;

        let manager = Self {
            root: Arc::new(root),
            state: Arc::new(RwLock::new(ConfigState::default())),
            document_locks: Arc::new(Mutex::new(BTreeMap::new())),
        };
        manager.write_schemas()?;

        for kind in ConfigDocumentKind::ALL {
            manager.load_initial_user_document(kind).await?;
        }
        Ok(manager)
    }

    pub fn root(&self) -> &Path {
        self.root.as_path()
    }

    pub async fn register_project_root(
        &self,
        project_id: &str,
        macro_metadata_root: PathBuf,
    ) -> Result<PathBuf, ConfigApiError> {
        if project_id.trim().is_empty() || project_id.contains(['/', '\\']) {
            return Err(ConfigApiError::new(
                "config.project.invalid_id",
                "L’identifiant du projet n’est pas valide.",
            ));
        }
        let config_root = macro_metadata_root
            .join("projects")
            .join(project_id)
            .join("config");
        fs::create_dir_all(&config_root).map_err(|error| {
            ConfigApiError::new(
                "config.project.create_failed",
                format!("Impossible de créer le dossier de configuration du projet : {error}"),
            )
        })?;

        self.state
            .write()
            .await
            .project_roots
            .insert(project_id.to_string(), config_root.clone());

        for kind in ConfigDocumentKind::ALL
            .into_iter()
            .filter(|kind| kind.supports_project_scope())
        {
            let scope = ConfigScope::Project {
                project_id: project_id.to_string(),
            };
            let path = config_root.join(kind.file_name());
            if path.exists() {
                self.load_document_from_path(kind, scope, path, false)
                    .await?;
            }
        }
        Ok(config_root)
    }

    async fn load_initial_user_document(
        &self,
        kind: ConfigDocumentKind,
    ) -> Result<(), ConfigApiError> {
        let path = self.root.join(kind.file_name());
        if !path.exists() {
            atomic_write_json(&path, &sparse_document(kind)).map_err(|error| {
                ConfigApiError::new(
                    "config.document.create_failed",
                    format!("Impossible de créer {} : {error}", path.display()),
                )
            })?;
        }
        self.load_document_from_path(kind, ConfigScope::User, path, true)
            .await
    }

    async fn load_document_from_path(
        &self,
        kind: ConfigDocumentKind,
        scope: ConfigScope,
        path: PathBuf,
        fail_on_invalid_initial: bool,
    ) -> Result<(), ConfigApiError> {
        let raw = fs::read(&path).map_err(|error| {
            ConfigApiError::new(
                "config.document.read_failed",
                format!("Impossible de lire {} : {error}", path.display()),
            )
        })?;
        let (value, parse_diagnostic) = match serde_json::from_slice::<Value>(&raw) {
            Ok(value) => (value, None),
            Err(error) => (
                sparse_document(kind),
                Some(ConfigDiagnostic {
                    document: kind,
                    scope: scope.clone(),
                    path: Some(format!(
                        "ligne {}, colonne {}",
                        error.line(),
                        error.column()
                    )),
                    code: "config.json.invalid".to_string(),
                    message: error.to_string(),
                    severity: "error".to_string(),
                }),
            ),
        };
        let validation = validate_document(kind, &scope, &value);
        let invalid = parse_diagnostic.is_some() || !validation.valid;
        if invalid && fail_on_invalid_initial {
            tracing::warn!(
                document = ?kind,
                path = %path.display(),
                "Configuration initiale invalide, conservation des valeurs par défaut"
            );
        }

        let last_valid_value = if !invalid {
            value.clone()
        } else {
            sparse_document(kind)
        };
        let document_etag = if parse_diagnostic.is_some() {
            etag_bytes(&raw)
        } else {
            etag(&value)
        };
        let mut diagnostics = validation.diagnostics;
        diagnostics.extend(parse_diagnostic);
        let stored = StoredDocument {
            path,
            etag: document_etag,
            disk_value: value,
            last_valid_value,
            read_only: validation.read_only,
            invalid,
            diagnostics,
            last_internal_hash: None,
        };
        self.state
            .write()
            .await
            .documents
            .insert(DocumentKey { kind, scope }, stored);
        Ok(())
    }

    fn write_schemas(&self) -> Result<(), ConfigApiError> {
        let schema_root = self.root.join("schemas").join("v1");
        fs::create_dir_all(&schema_root).map_err(|error| {
            ConfigApiError::new(
                "config.schema.create_failed",
                format!("Impossible de créer le dossier des schémas : {error}"),
            )
        })?;
        for (kind, schema) in schema_map() {
            atomic_write_json(&schema_root.join(kind.schema_file_name()), &schema).map_err(
                |error| {
                    ConfigApiError::new(
                        "config.schema.write_failed",
                        format!("Impossible d’écrire le schéma {:?} : {error}", kind),
                    )
                },
            )?;
        }
        Ok(())
    }

    async fn document_lock(&self, key: &DocumentKey) -> Arc<Mutex<()>> {
        let mut locks = self.document_locks.lock().await;
        locks
            .entry(key.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn ensure_project_document(
        &self,
        kind: ConfigDocumentKind,
        project_id: &str,
    ) -> Result<(), ConfigApiError> {
        if !kind.supports_project_scope() {
            return Err(ConfigApiError::new(
                "config.scope.forbidden",
                "Ce document ne peut pas être surchargé au niveau projet.",
            ));
        }
        let key = DocumentKey {
            kind,
            scope: ConfigScope::Project {
                project_id: project_id.to_string(),
            },
        };
        if self.state.read().await.documents.contains_key(&key) {
            return Ok(());
        }

        let project_root = self
            .state
            .read()
            .await
            .project_roots
            .get(project_id)
            .cloned()
            .ok_or_else(|| {
                ConfigApiError::new(
                    "config.project.not_registered",
                    "La racine metadata du projet n’a pas encore été enregistrée.",
                )
            })?;
        let path = project_root.join(kind.file_name());
        atomic_write_json(&path, &sparse_document(kind)).map_err(|error| {
            ConfigApiError::new(
                "config.document.create_failed",
                format!("Impossible de créer {} : {error}", path.display()),
            )
        })?;
        self.load_document_from_path(kind, key.scope, path, true)
            .await
    }

    pub async fn get_document(
        &self,
        kind: ConfigDocumentKind,
        scope: ConfigScope,
    ) -> Result<ConfigDocument, ConfigApiError> {
        if let ConfigScope::Project { project_id } = &scope {
            self.ensure_project_document(kind, project_id).await?;
        }
        let key = DocumentKey { kind, scope };
        let state = self.state.read().await;
        let stored = state.documents.get(&key).ok_or_else(|| {
            ConfigApiError::new(
                "config.document.not_found",
                "Le document de configuration demandé est introuvable.",
            )
        })?;
        Ok(to_document(&key, stored))
    }

    pub async fn get_snapshot(
        &self,
        project_ids: &[String],
    ) -> Result<ConfigSnapshot, ConfigApiError> {
        let state = self.state.read().await;
        let user_documents = state
            .documents
            .iter()
            .filter_map(|(key, stored)| {
                matches!(key.scope, ConfigScope::User)
                    .then_some((key.kind, stored.last_valid_value.clone()))
            })
            .collect::<BTreeMap<_, _>>();

        let mut owned_project_documents =
            Vec::<(String, BTreeMap<ConfigDocumentKind, Value>)>::new();
        for project_id in project_ids {
            let documents = state
                .documents
                .iter()
                .filter_map(|(key, stored)| match &key.scope {
                    ConfigScope::Project {
                        project_id: current,
                    } if current == project_id => Some((key.kind, stored.last_valid_value.clone())),
                    _ => None,
                })
                .collect::<BTreeMap<_, _>>();
            if !documents.is_empty() {
                owned_project_documents.push((project_id.clone(), documents));
            }
        }
        let borrowed_project_documents = owned_project_documents
            .iter()
            .map(|(project_id, documents)| (project_id.as_str(), documents))
            .collect::<Vec<_>>();
        let (effective, provenance) = effective_documents(
            &user_documents,
            &borrowed_project_documents,
            &state.session_documents,
        );
        let project_effective = borrowed_project_documents
            .iter()
            .map(|(project_id, documents)| {
                let scoped = [(*project_id, *documents)];
                let (effective, _) =
                    effective_documents(&user_documents, &scoped, &state.session_documents);
                ((*project_id).to_string(), effective)
            })
            .collect::<BTreeMap<_, _>>();

        let documents = state
            .documents
            .iter()
            .filter(|(key, _)| match &key.scope {
                ConfigScope::User => true,
                ConfigScope::Project { project_id } => project_ids.contains(project_id),
            })
            .map(|(key, stored)| to_document(key, stored))
            .collect::<Vec<_>>();
        let diagnostics = documents
            .iter()
            .flat_map(|document| document.diagnostics.clone())
            .collect();

        Ok(ConfigSnapshot {
            schema_version: CURRENT_SCHEMA_VERSION,
            effective,
            project_effective,
            documents,
            provenance,
            diagnostics,
            pending_restart_paths: state.pending_restart_paths.iter().cloned().collect(),
        })
    }

    pub fn get_schema(&self, kind: ConfigDocumentKind) -> Result<Value, ConfigApiError> {
        schema_map().remove(&kind).ok_or_else(|| {
            ConfigApiError::new(
                "config.schema.not_found",
                "Le schéma demandé est introuvable.",
            )
        })
    }

    pub fn validate(
        &self,
        kind: ConfigDocumentKind,
        scope: ConfigScope,
        value: &Value,
    ) -> ConfigValidationResult {
        validate_document(kind, &scope, value)
    }

    pub async fn apply_patch(
        &self,
        request: ConfigPatchRequest,
    ) -> Result<ConfigPatchResult, ConfigApiError> {
        if let ConfigScope::Project { project_id } = &request.scope {
            self.ensure_project_document(request.kind, project_id)
                .await?;
        }
        let key = DocumentKey {
            kind: request.kind,
            scope: request.scope.clone(),
        };
        let lock = self.document_lock(&key).await;
        let _guard = lock.lock().await;

        let stored = self
            .state
            .read()
            .await
            .documents
            .get(&key)
            .cloned()
            .ok_or_else(|| {
                ConfigApiError::new(
                    "config.document.not_found",
                    "Le document de configuration demandé est introuvable.",
                )
            })?;
        let is_explicit_ui_replacement = request.source == ConfigChangeSource::UserInterface
            && request.patch.len() == 1
            && request.patch[0].op == "replace"
            && request.patch[0].path.is_empty();
        if stored.invalid && !is_explicit_ui_replacement {
            return Err(ConfigApiError::new(
                "config.document.invalid_on_disk",
                "Le document sur disque est invalide. Corrigez-le ou rechargez-le avant toute écriture.",
            )
            .with_document(to_document(&key, &stored))
            .with_diagnostics(stored.diagnostics));
        }
        if stored.read_only {
            return Err(ConfigApiError::new(
                "config.document.future_version",
                "Ce document utilise une version de schéma plus récente et reste en lecture seule.",
            )
            .with_document(to_document(&key, &stored)));
        }
        if stored.etag != request.expected_etag {
            return Err(ConfigApiError::new(
                "config.etag.conflict",
                "Le document a été modifié depuis sa lecture. Rechargez-le avant de réessayer.",
            )
            .with_document(to_document(&key, &stored)));
        }

        let patch_value = serde_json::to_value(&request.patch).map_err(|error| {
            ConfigApiError::new(
                "config.patch.serialize_failed",
                format!("Le patch JSON n’est pas sérialisable : {error}"),
            )
        })?;
        let patch: Patch = serde_json::from_value(patch_value).map_err(|error| {
            ConfigApiError::new(
                "config.patch.invalid",
                format!("Le patch JSON RFC 6902 est invalide : {error}"),
            )
        })?;
        let mut proposed = stored.disk_value.clone();
        json_patch::patch(&mut proposed, &patch).map_err(|error| {
            ConfigApiError::new(
                "config.patch.apply_failed",
                format!("Impossible d’appliquer le patch JSON : {error}"),
            )
        })?;

        let defaults = default_document(request.kind);
        strip_default_values(&mut proposed, &defaults);
        let validation = validate_document(request.kind, &request.scope, &proposed);
        if !validation.valid {
            return Err(ConfigApiError::new(
                "config.document.validation_failed",
                "Le document proposé ne respecte pas le contrat de configuration.",
            )
            .with_diagnostics(validation.diagnostics));
        }

        if matches!(request.scope, ConfigScope::Project { .. }) {
            let user_effective = self.effective_user_document(request.kind).await;
            project_overlay_is_restrictive(request.kind, &user_effective, &proposed).map_err(
                |message| ConfigApiError::new("config.project.relaxation_forbidden", message),
            )?;
        }

        // Classify the actual semantic diff, not the patch envelope. In particular,
        // a root-level replacement must not hide sensitive descendant changes.
        let changed_paths = diff_leaf_paths(&stored.last_valid_value, &proposed);
        let (sensitive_paths, reasons) = classify_sensitive_paths(request.kind, &changed_paths);
        let apply_modes = apply_modes_for_paths(request.kind, &changed_paths);
        let needs_approval =
            request.source != ConfigChangeSource::UserInterface && !sensitive_paths.is_empty();
        let new_etag = etag(&proposed);
        atomic_write_json(&stored.path, &proposed).map_err(|error| {
            ConfigApiError::new(
                "config.document.write_failed",
                format!("Impossible d’écrire {} : {error}", stored.path.display()),
            )
        })?;

        let pending = needs_approval.then(|| PendingSensitiveConfigChange {
            id: Uuid::new_v4().to_string(),
            document: request.kind,
            scope: request.scope.clone(),
            source: request.source,
            changed_paths: sensitive_paths,
            reasons,
            proposed_document: proposed.clone(),
            proposed_etag: new_etag.clone(),
            created_at: Utc::now().to_rfc3339(),
        });
        let restart_required = apply_modes.contains("restart");

        let mut state = self.state.write().await;
        let document = {
            let stored = state.documents.get_mut(&key).ok_or_else(|| {
                ConfigApiError::new(
                    "config.document.not_found",
                    "Le document de configuration a disparu pendant l’écriture.",
                )
            })?;
            stored.disk_value = proposed.clone();
            stored.etag = new_etag.clone();
            stored.last_internal_hash = Some(new_etag);
            stored.diagnostics.clear();
            stored.invalid = false;
            if !needs_approval {
                stored.last_valid_value = proposed;
            }
            to_document(&key, stored)
        };
        if let Some(pending) = pending.clone() {
            state.pending_changes.insert(pending.id.clone(), pending);
        }
        if restart_required {
            state.pending_restart_paths.extend(changed_paths.clone());
        }

        Ok(ConfigPatchResult {
            status: if needs_approval {
                "pendingApproval".to_string()
            } else {
                "applied".to_string()
            },
            document,
            pending_change: pending,
            restart_required,
        })
    }

    pub async fn reset_path(
        &self,
        kind: ConfigDocumentKind,
        scope: ConfigScope,
        path: String,
        expected_etag: String,
        source: ConfigChangeSource,
    ) -> Result<ConfigPatchResult, ConfigApiError> {
        self.apply_patch(ConfigPatchRequest {
            kind,
            scope,
            expected_etag,
            patch: vec![JsonPatchOperation {
                op: "remove".to_string(),
                path,
                from: None,
                value: None,
            }],
            source,
        })
        .await
    }

    pub async fn effective_user_document(&self, kind: ConfigDocumentKind) -> Value {
        let state = self.state.read().await;
        let mut effective = default_document(kind);
        if let Some(stored) = state.documents.get(&DocumentKey {
            kind,
            scope: ConfigScope::User,
        }) {
            super::registry::merge_values(&mut effective, &stored.last_valid_value);
        }
        effective
    }

    pub async fn reload(
        &self,
        kind: ConfigDocumentKind,
        scope: ConfigScope,
        source: ConfigChangeSource,
    ) -> Result<ReloadOutcome, ConfigApiError> {
        if let ConfigScope::Project { project_id } = &scope {
            self.ensure_project_document(kind, project_id).await?;
        }
        let key = DocumentKey { kind, scope };
        let lock = self.document_lock(&key).await;
        let _guard = lock.lock().await;
        let current = self
            .state
            .read()
            .await
            .documents
            .get(&key)
            .cloned()
            .ok_or_else(|| {
                ConfigApiError::new(
                    "config.document.not_found",
                    "Le document de configuration demandé est introuvable.",
                )
            })?;

        let raw = fs::read(&current.path).map_err(|error| {
            ConfigApiError::new(
                "config.document.read_failed",
                format!("Impossible de lire {} : {error}", current.path.display()),
            )
        })?;
        let parsed = serde_json::from_slice::<Value>(&raw);
        let proposed_etag = parsed
            .as_ref()
            .map(etag)
            .unwrap_or_else(|_| etag_bytes(&raw));
        if current.last_internal_hash.as_deref() == Some(proposed_etag.as_str()) {
            let mut state = self.state.write().await;
            if let Some(stored) = state.documents.get_mut(&key) {
                stored.last_internal_hash = None;
            }
            return Ok(ReloadOutcome {
                changed: false,
                invalid: false,
                pending: None,
                restart_required: false,
                document: to_document(&key, &current),
            });
        }
        if current.etag == proposed_etag {
            return Ok(ReloadOutcome {
                changed: false,
                invalid: current.invalid,
                pending: None,
                restart_required: false,
                document: to_document(&key, &current),
            });
        }

        let proposed = match parsed {
            Ok(value) => value,
            Err(error) => {
                let diagnostic = ConfigDiagnostic {
                    document: kind,
                    scope: key.scope.clone(),
                    path: Some(format!(
                        "ligne {}, colonne {}",
                        error.line(),
                        error.column()
                    )),
                    code: "config.json.invalid".to_string(),
                    message: error.to_string(),
                    severity: "error".to_string(),
                };
                let mut state = self.state.write().await;
                let stored = state.documents.get_mut(&key).expect("loaded document");
                stored.etag = proposed_etag;
                stored.invalid = true;
                stored.diagnostics = vec![diagnostic];
                return Ok(ReloadOutcome {
                    changed: true,
                    invalid: true,
                    pending: None,
                    restart_required: false,
                    document: to_document(&key, stored),
                });
            }
        };

        let validation = validate_document(kind, &key.scope, &proposed);
        if !validation.valid {
            let mut state = self.state.write().await;
            let stored = state.documents.get_mut(&key).expect("loaded document");
            stored.disk_value = proposed;
            stored.etag = proposed_etag;
            stored.invalid = true;
            stored.diagnostics = validation.diagnostics;
            let document = to_document(&key, stored);
            return Ok(ReloadOutcome {
                changed: true,
                invalid: true,
                pending: None,
                restart_required: false,
                document,
            });
        }

        if matches!(key.scope, ConfigScope::Project { .. }) {
            let global = self.effective_user_document(kind).await;
            if let Err(message) = project_overlay_is_restrictive(kind, &global, &proposed) {
                let diagnostic = ConfigDiagnostic {
                    document: kind,
                    scope: key.scope.clone(),
                    path: None,
                    code: "config.project.relaxation_forbidden".to_string(),
                    message,
                    severity: "error".to_string(),
                };
                let mut state = self.state.write().await;
                let stored = state.documents.get_mut(&key).expect("loaded document");
                stored.disk_value = proposed;
                stored.etag = proposed_etag;
                stored.invalid = true;
                stored.diagnostics = vec![diagnostic];
                let document = to_document(&key, stored);
                return Ok(ReloadOutcome {
                    changed: true,
                    invalid: true,
                    pending: None,
                    restart_required: false,
                    document,
                });
            }
        }

        let changed_paths = diff_leaf_paths(&current.last_valid_value, &proposed);
        let (sensitive_paths, reasons) = classify_sensitive_paths(kind, &changed_paths);
        let apply_modes = apply_modes_for_paths(kind, &changed_paths);
        let pending = (source != ConfigChangeSource::UserInterface && !sensitive_paths.is_empty())
            .then(|| PendingSensitiveConfigChange {
                id: Uuid::new_v4().to_string(),
                document: kind,
                scope: key.scope.clone(),
                source,
                changed_paths: sensitive_paths,
                reasons,
                proposed_document: proposed.clone(),
                proposed_etag: proposed_etag.clone(),
                created_at: Utc::now().to_rfc3339(),
            });
        let restart_required = apply_modes.contains("restart");

        let mut state = self.state.write().await;
        let document = {
            let stored = state.documents.get_mut(&key).expect("loaded document");
            stored.disk_value = proposed.clone();
            stored.etag = proposed_etag;
            stored.invalid = false;
            stored.read_only = validation.read_only;
            stored.diagnostics = validation.diagnostics;
            if pending.is_none() {
                stored.last_valid_value = proposed;
            }
            to_document(&key, stored)
        };
        if let Some(pending) = pending.clone() {
            state.pending_changes.insert(pending.id.clone(), pending);
        }
        if restart_required {
            state.pending_restart_paths.extend(changed_paths);
        }
        Ok(ReloadOutcome {
            changed: true,
            invalid: false,
            pending,
            restart_required,
            document,
        })
    }

    pub async fn accept_pending_change(&self, id: &str) -> Result<ConfigDocument, ConfigApiError> {
        let mut state = self.state.write().await;
        let pending = state.pending_changes.remove(id).ok_or_else(|| {
            ConfigApiError::new(
                "config.pending.not_found",
                "La modification sensible en attente est introuvable.",
            )
        })?;
        let key = DocumentKey {
            kind: pending.document,
            scope: pending.scope,
        };
        let stored = state.documents.get_mut(&key).ok_or_else(|| {
            ConfigApiError::new(
                "config.document.not_found",
                "Le document associé à la modification est introuvable.",
            )
        })?;
        if stored.etag != pending.proposed_etag {
            return Err(ConfigApiError::new(
                "config.etag.conflict",
                "Le fichier a changé depuis la demande d’approbation.",
            )
            .with_document(to_document(&key, stored)));
        }
        stored.last_valid_value = pending.proposed_document;
        Ok(to_document(&key, stored))
    }

    pub async fn reject_pending_change(
        &self,
        id: &str,
        restore_approved: bool,
    ) -> Result<ConfigDocument, ConfigApiError> {
        let pending = self
            .state
            .write()
            .await
            .pending_changes
            .remove(id)
            .ok_or_else(|| {
                ConfigApiError::new(
                    "config.pending.not_found",
                    "La modification sensible en attente est introuvable.",
                )
            })?;
        let key = DocumentKey {
            kind: pending.document,
            scope: pending.scope,
        };
        let lock = self.document_lock(&key).await;
        let _guard = lock.lock().await;
        let mut state = self.state.write().await;
        let stored = state.documents.get_mut(&key).ok_or_else(|| {
            ConfigApiError::new(
                "config.document.not_found",
                "Le document associé à la modification est introuvable.",
            )
        })?;
        if restore_approved {
            atomic_write_json(&stored.path, &stored.last_valid_value).map_err(|error| {
                ConfigApiError::new(
                    "config.document.restore_failed",
                    format!("Impossible de restaurer la version approuvée : {error}"),
                )
            })?;
            stored.disk_value = stored.last_valid_value.clone();
            stored.etag = etag(&stored.disk_value);
            stored.last_internal_hash = Some(stored.etag.clone());
        }
        Ok(to_document(&key, stored))
    }

    pub async fn list_pending_changes(&self) -> Vec<PendingSensitiveConfigChange> {
        self.state
            .read()
            .await
            .pending_changes
            .values()
            .cloned()
            .collect()
    }

    pub async fn path_for_scope(
        &self,
        kind: ConfigDocumentKind,
        scope: &ConfigScope,
    ) -> Result<PathBuf, ConfigApiError> {
        if let ConfigScope::Project { project_id } = scope {
            self.ensure_project_document(kind, project_id).await?;
        }
        self.state
            .read()
            .await
            .documents
            .get(&DocumentKey {
                kind,
                scope: scope.clone(),
            })
            .map(|stored| stored.path.clone())
            .ok_or_else(|| {
                ConfigApiError::new(
                    "config.document.not_found",
                    "Le document de configuration demandé est introuvable.",
                )
            })
    }
}

fn to_document(key: &DocumentKey, stored: &StoredDocument) -> ConfigDocument {
    ConfigDocument {
        kind: key.kind,
        scope: key.scope.clone(),
        value: stored.disk_value.clone(),
        etag: stored.etag.clone(),
        read_only: stored.read_only,
        invalid: stored.invalid,
        file_path: stored.path.to_string_lossy().to_string(),
        diagnostics: stored.diagnostics.clone(),
    }
}

fn etag(value: &Value) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    etag_bytes(&bytes)
}

fn etag_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("sha256:{digest:x}")
}

fn diff_leaf_paths(before: &Value, after: &Value) -> Vec<String> {
    let mut paths = collect_leaf_pointers(before);
    paths.extend(collect_leaf_pointers(after));
    paths.sort();
    paths.dedup();
    paths
        .into_iter()
        .filter(|path| before.pointer(path) != after.pointer(path))
        .collect()
}

pub(crate) fn atomic_write_json(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Le chemin cible n’a pas de dossier parent.".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;

    let lock_path = path.with_extension(format!(
        "{}.lock",
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("json")
    ));
    let lock_file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|error| error.to_string())?;
    lock_file
        .lock_exclusive()
        .map_err(|error| error.to_string())?;

    let temp_path = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("config.json"),
        Uuid::new_v4()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .map_err(|error| error.to_string())?;
        let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        replace_file_atomically(&temp_path, path)?;
        sync_parent_directory(parent)?;
        Ok(())
    })();
    if temp_path.exists() {
        let _ = fs::remove_file(&temp_path);
    }
    let _ = FileExt::unlock(&lock_file);
    result
}

#[cfg(windows)]
fn replace_file_atomically(temp_path: &Path, target_path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let temp = temp_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = target_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            temp.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file_atomically(temp_path: &Path, target_path: &Path) -> Result<(), String> {
    fs::rename(temp_path, target_path).map_err(|error| error.to_string())
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> Result<(), String> {
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn manager() -> (tempfile::TempDir, ConfigManager) {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = ConfigManager::initialize(temp.path().join("config"))
            .await
            .expect("manager");
        (temp, manager)
    }

    #[tokio::test]
    async fn first_launch_creates_sparse_documents_and_schemas() {
        let (_temp, manager) = manager().await;
        for kind in ConfigDocumentKind::ALL {
            let document = manager
                .get_document(kind, ConfigScope::User)
                .await
                .expect("document");
            assert_eq!(document.value.as_object().map(|map| map.len()), Some(2));
            assert!(manager
                .root()
                .join("schemas/v1")
                .join(kind.schema_file_name())
                .exists());
        }
    }

    #[tokio::test]
    async fn patch_uses_etag_and_keeps_files_sparse() {
        let (_temp, manager) = manager().await;
        let document = manager
            .get_document(ConfigDocumentKind::Settings, ConfigScope::User)
            .await
            .expect("settings");
        let result = manager
            .apply_patch(ConfigPatchRequest {
                kind: ConfigDocumentKind::Settings,
                scope: ConfigScope::User,
                expected_etag: document.etag.clone(),
                patch: vec![JsonPatchOperation {
                    op: "add".to_string(),
                    path: "/language".to_string(),
                    from: None,
                    value: Some(json!("fr")),
                }],
                source: ConfigChangeSource::UserInterface,
            })
            .await
            .expect("patch");
        assert_eq!(result.document.value.get("language"), Some(&json!("fr")));

        let conflict = manager
            .apply_patch(ConfigPatchRequest {
                kind: ConfigDocumentKind::Settings,
                scope: ConfigScope::User,
                expected_etag: document.etag,
                patch: Vec::new(),
                source: ConfigChangeSource::UserInterface,
            })
            .await
            .expect_err("etag conflict");
        assert_eq!(conflict.code, "config.etag.conflict");
    }

    #[tokio::test]
    async fn sensitive_agent_patch_waits_for_explicit_approval() {
        let (_temp, manager) = manager().await;
        let document = manager
            .get_document(ConfigDocumentKind::Tools, ConfigScope::User)
            .await
            .expect("tools");
        let result = manager
            .apply_patch(ConfigPatchRequest {
                kind: ConfigDocumentKind::Tools,
                scope: ConfigScope::User,
                expected_etag: document.etag,
                patch: vec![JsonPatchOperation {
                    op: "add".to_string(),
                    path: "/riskLevel".to_string(),
                    from: None,
                    value: Some(json!("yolo")),
                }],
                source: ConfigChangeSource::Agent,
            })
            .await
            .expect("pending patch");
        assert_eq!(result.status, "pendingApproval");

        let snapshot = manager.get_snapshot(&[]).await.expect("snapshot");
        assert_eq!(
            snapshot.effective["tools"].get("riskLevel"),
            Some(&json!("balanced"))
        );
        manager
            .accept_pending_change(&result.pending_change.expect("pending").id)
            .await
            .expect("accept");
        let snapshot = manager.get_snapshot(&[]).await.expect("snapshot");
        assert_eq!(
            snapshot.effective["tools"].get("riskLevel"),
            Some(&json!("yolo"))
        );
    }

    #[tokio::test]
    async fn root_replacement_cannot_bypass_sensitive_change_classification() {
        let (_temp, manager) = manager().await;
        let document = manager
            .get_document(ConfigDocumentKind::Tools, ConfigScope::User)
            .await
            .expect("tools");
        let result = manager
            .apply_patch(ConfigPatchRequest {
                kind: ConfigDocumentKind::Tools,
                scope: ConfigScope::User,
                expected_etag: document.etag,
                patch: vec![JsonPatchOperation {
                    op: "replace".to_string(),
                    path: String::new(),
                    from: None,
                    value: Some(json!({
                        "$schema": "./schemas/v1/tools.schema.json",
                        "schemaVersion": 1,
                        "riskLevel": "yolo"
                    })),
                }],
                source: ConfigChangeSource::Agent,
            })
            .await
            .expect("pending replacement");

        assert_eq!(result.status, "pendingApproval");
        assert!(result
            .pending_change
            .expect("pending")
            .changed_paths
            .contains(&"/riskLevel".to_string()));
    }

    #[tokio::test]
    async fn invalid_external_document_preserves_last_valid_snapshot() {
        let (_temp, manager) = manager().await;
        let document = manager
            .get_document(ConfigDocumentKind::Settings, ConfigScope::User)
            .await
            .expect("settings");
        fs::write(&document.file_path, "{ invalid").expect("write invalid json");
        let outcome = manager
            .reload(
                ConfigDocumentKind::Settings,
                ConfigScope::User,
                ConfigChangeSource::ExternalEditor,
            )
            .await
            .expect("invalid json is reported without stopping Macro");
        assert!(outcome.invalid);
        assert_eq!(outcome.document.diagnostics[0].code, "config.json.invalid");
        let snapshot = manager.get_snapshot(&[]).await.expect("snapshot");
        assert_eq!(
            snapshot.effective["settings"].pointer("/appearance/theme"),
            Some(&json!("macro-dark"))
        );

        let repaired = manager
            .apply_patch(ConfigPatchRequest {
                kind: ConfigDocumentKind::Settings,
                scope: ConfigScope::User,
                expected_etag: outcome.document.etag,
                patch: vec![JsonPatchOperation {
                    op: "replace".to_string(),
                    path: String::new(),
                    from: None,
                    value: Some(json!({
                        "$schema": "./schemas/v1/settings.schema.json",
                        "schemaVersion": 1,
                        "language": "fr"
                    })),
                }],
                source: ConfigChangeSource::UserInterface,
            })
            .await
            .expect("explicit valid replacement repairs the document");
        assert!(!repaired.document.invalid);
        assert_eq!(repaired.document.value.get("language"), Some(&json!("fr")));
    }
}
