use super::registry::{
    apply_modes_for_paths, classify_sensitive_paths, collect_leaf_pointers, default_document,
    effective_documents, project_overlay_is_restrictive, schema_map, sparse_document,
    strip_default_values, validate_document,
};
use super::types::*;
use chrono::Utc;
use fs2::FileExt;
use json_patch::Patch;
use serde::{Deserialize, Serialize};
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DurablePendingSensitiveChange {
    pending: PendingSensitiveConfigChange,
    approved_etag: String,
    all_changed_paths: Vec<String>,
    apply_modes: Vec<String>,
}

#[derive(Default)]
struct ConfigState {
    documents: BTreeMap<DocumentKey, StoredDocument>,
    project_roots: BTreeMap<String, PathBuf>,
    session_documents: BTreeMap<ConfigDocumentKind, Value>,
    pending_changes: BTreeMap<String, DurablePendingSensitiveChange>,
    pending_restart_paths: BTreeSet<String>,
}

#[derive(Clone)]
pub struct ConfigManager {
    root: Arc<PathBuf>,
    state: Arc<RwLock<ConfigState>>,
    document_locks: Arc<Mutex<BTreeMap<DocumentKey, Arc<Mutex<()>>>>>,
    secret_reference_lock: Arc<Mutex<()>>,
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

struct DocumentFileLock {
    file: std::fs::File,
}

impl Drop for DocumentFileLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
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
            secret_reference_lock: Arc::new(Mutex::new(())),
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

    pub async fn lock_secret_references(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.secret_reference_lock.clone().lock_owned().await
    }

    pub async fn register_project_root(
        &self,
        project_id: &str,
        macro_metadata_root: PathBuf,
    ) -> Result<PathBuf, ConfigApiError> {
        validate_project_id(project_id)?;
        let projects_root = macro_metadata_root.join("projects");
        fs::create_dir_all(&projects_root).map_err(|error| {
            ConfigApiError::new(
                "config.project.create_failed",
                format!("Impossible de créer le dossier des projets : {error}"),
            )
        })?;
        let config_root = projects_root.join(project_id).join("config");
        if !config_root.starts_with(&projects_root) {
            return Err(ConfigApiError::new(
                "config.project.path_escape",
                "Le dossier de configuration du projet sort de la racine autorisée.",
            ));
        }
        fs::create_dir_all(&config_root).map_err(|error| {
            ConfigApiError::new(
                "config.project.create_failed",
                format!("Impossible de créer le dossier de configuration du projet : {error}"),
            )
        })?;

        for kind in ConfigDocumentKind::ALL
            .into_iter()
            .filter(|kind| kind.supports_project_scope())
        {
            let scope = ConfigScope::Project {
                project_id: project_id.to_string(),
            };
            let path = config_root.join(kind.file_name());
            if path.exists() {
                if let Err(error) = self.load_document_from_path(kind, scope, path, false).await {
                    let mut state = self.state.write().await;
                    state.documents.retain(|key, _| {
                        key.scope
                            != (ConfigScope::Project {
                                project_id: project_id.to_string(),
                            })
                    });
                    state.pending_changes.retain(|_, pending| {
                        pending.pending.scope
                            != (ConfigScope::Project {
                                project_id: project_id.to_string(),
                            })
                    });
                    return Err(error);
                }
            }
        }
        self.state
            .write()
            .await
            .project_roots
            .insert(project_id.to_string(), config_root.clone());
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
        if let ConfigScope::Project { project_id } = &scope {
            validate_project_id(project_id)?;
        }
        let key = DocumentKey {
            kind,
            scope: scope.clone(),
        };
        let local_lock = self.document_lock(&key).await;
        let _local_guard = local_lock.lock().await;
        let _file_guard = lock_document_file_async(path.clone()).await?;
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
        let validation = validate_document(kind, &key.scope, &value);
        let invalid = parse_diagnostic.is_some() || !validation.valid;
        if invalid && fail_on_invalid_initial {
            tracing::warn!(
                document = ?kind,
                path = %path.display(),
                "Configuration initiale invalide, conservation des valeurs par défaut"
            );
        }

        let document_etag = if parse_diagnostic.is_some() {
            etag_bytes(&raw)
        } else {
            etag(&value)
        };
        let approved_path = approved_document_path(self.root(), &key);
        let pending_path = pending_document_path(self.root(), &key);
        let mut runtime_diagnostics = Vec::new();
        let mut approved = if approved_path.exists() {
            match read_json_value(&approved_path) {
                Ok(approved)
                    if {
                        let validation = validate_document(kind, &key.scope, &approved);
                        validation.valid && !validation.read_only
                    } =>
                {
                    approved
                }
                Ok(_) | Err(_) => {
                    backup_corrupt_runtime_file(&approved_path);
                    let baseline = sparse_document(kind);
                    atomic_write_json(&approved_path, &baseline).map_err(|error| {
                        ConfigApiError::new(
                            "config.approved.recovery_failed",
                            format!("Impossible de recréer la copie approuvée : {error}"),
                        )
                    })?;
                    runtime_diagnostics.push(ConfigDiagnostic {
                        document: kind,
                        scope: key.scope.clone(),
                        path: None,
                        code: "config.approved.recovered".to_string(),
                        message: "La copie approuvée interne était corrompue. Macro l’a remplacée par une baseline sûre et a conservé une sauvegarde de diagnostic.".to_string(),
                        severity: "warning".to_string(),
                    });
                    baseline
                }
            }
        } else {
            let baseline = sparse_document(kind);
            atomic_write_json(&approved_path, &baseline).map_err(|error| {
                ConfigApiError::new(
                    "config.approved.create_failed",
                    format!("Impossible de créer la copie approuvée : {error}"),
                )
            })?;
            baseline
        };

        let mut durable_pending = match read_durable_pending(&pending_path) {
            Ok(pending) => pending,
            Err(_) => {
                backup_corrupt_runtime_file(&pending_path);
                remove_file_if_exists(&pending_path)?;
                runtime_diagnostics.push(ConfigDiagnostic {
                    document: kind,
                    scope: key.scope.clone(),
                    path: None,
                    code: "config.pending.recovered".to_string(),
                    message: "La demande sensible interne était corrompue. Macro l’a isolée et a recalculé la proposition depuis le document JSON.".to_string(),
                    severity: "warning".to_string(),
                });
                None
            }
        };
        if validation.read_only {
            durable_pending = None;
            remove_file_if_exists(&pending_path)?;
        } else if !invalid {
            if matches!(key.scope, ConfigScope::Project { .. }) {
                let global = self.effective_user_document(kind).await;
                project_overlay_is_restrictive(kind, &global, &value).map_err(|message| {
                    ConfigApiError::new("config.project.relaxation_forbidden", message)
                })?;
            }

            let approved_etag = etag(&approved);
            if document_etag == approved_etag {
                durable_pending = None;
                remove_file_if_exists(&pending_path)?;
            } else if durable_pending.as_ref().is_some_and(|pending| {
                pending.approved_etag == approved_etag
                    && pending.pending.proposed_etag == document_etag
                    && pending.pending.document == kind
                    && pending.pending.scope == key.scope
            }) {
                // The durable proposal is still current. Keep the approved baseline effective.
            } else {
                let changed_paths = diff_leaf_paths(&approved, &value);
                let (sensitive_paths, reasons) = classify_sensitive_paths(kind, &changed_paths);
                if sensitive_paths.is_empty() {
                    atomic_write_json(&approved_path, &value).map_err(|error| {
                        ConfigApiError::new(
                            "config.approved.write_failed",
                            format!("Impossible de promouvoir la configuration : {error}"),
                        )
                    })?;
                    approved = value.clone();
                    durable_pending = None;
                    remove_file_if_exists(&pending_path)?;
                } else {
                    let pending = DurablePendingSensitiveChange {
                        pending: PendingSensitiveConfigChange {
                            id: Uuid::new_v4().to_string(),
                            document: kind,
                            scope: key.scope.clone(),
                            source: ConfigChangeSource::ExternalEditor,
                            changed_paths: sensitive_paths,
                            reasons,
                            proposed_document: value.clone(),
                            proposed_etag: document_etag.clone(),
                            created_at: Utc::now().to_rfc3339(),
                        },
                        approved_etag,
                        all_changed_paths: changed_paths.clone(),
                        apply_modes: apply_modes_for_paths(kind, &changed_paths)
                            .into_iter()
                            .collect(),
                    };
                    write_durable_pending(&pending_path, &pending)?;
                    durable_pending = Some(pending);
                }
            }
        }
        let mut diagnostics = validation.diagnostics;
        diagnostics.extend(parse_diagnostic);
        diagnostics.extend(runtime_diagnostics);
        let stored = StoredDocument {
            path,
            etag: document_etag,
            disk_value: value,
            last_valid_value: approved,
            read_only: validation.read_only,
            invalid,
            diagnostics,
            last_internal_hash: None,
        };
        let mut state = self.state.write().await;
        state.documents.insert(key, stored);
        if let Some(pending) = durable_pending {
            state
                .pending_changes
                .insert(pending.pending.id.clone(), pending);
        }
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
        validate_project_id(project_id)?;
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
        if !path.exists() {
            atomic_write_json(&path, &sparse_document(kind)).map_err(|error| {
                ConfigApiError::new(
                    "config.document.create_failed",
                    format!("Impossible de créer {} : {error}", path.display()),
                )
            })?;
        }
        self.load_document_from_path(kind, key.scope, path, true)
            .await
    }

    async fn discover_project_documents(
        &self,
        project_ids: &[String],
    ) -> Result<(), ConfigApiError> {
        let roots = {
            let state = self.state.read().await;
            let mut roots = Vec::with_capacity(project_ids.len());
            for project_id in project_ids {
                validate_project_id(project_id)?;
                let root = state.project_roots.get(project_id).cloned().ok_or_else(|| {
                    ConfigApiError::new(
                        "config.project.not_registered",
                        format!(
                            "La configuration du projet {project_id} n’a pas été enregistrée ou chargée."
                        ),
                    )
                })?;
                roots.push((project_id.clone(), root));
            }
            roots
        };
        for (project_id, root) in roots {
            for kind in ConfigDocumentKind::ALL
                .into_iter()
                .filter(|kind| kind.supports_project_scope())
            {
                let scope = ConfigScope::Project {
                    project_id: project_id.clone(),
                };
                let key = DocumentKey {
                    kind,
                    scope: scope.clone(),
                };
                if self.state.read().await.documents.contains_key(&key) {
                    continue;
                }
                let path = root.join(kind.file_name());
                if path.exists() {
                    self.load_document_from_path(kind, scope, path, false)
                        .await?;
                }
            }
        }
        Ok(())
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
        self.discover_project_documents(project_ids).await?;
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
        let _reference_guard = matches!(
            request.kind,
            ConfigDocumentKind::Providers | ConfigDocumentKind::Tools
        )
        .then(|| self.secret_reference_lock.lock());
        let _reference_guard = match _reference_guard {
            Some(guard) => Some(guard.await),
            None => None,
        };
        let key = DocumentKey {
            kind: request.kind,
            scope: request.scope.clone(),
        };
        let lock = self.document_lock(&key).await;
        let _guard = lock.lock().await;

        let stored = {
            let state = self.state.read().await;
            let stored = state.documents.get(&key).cloned().ok_or_else(|| {
                ConfigApiError::new(
                    "config.document.not_found",
                    "Le document de configuration demandé est introuvable.",
                )
            })?;
            if state.pending_changes.values().any(|pending| {
                pending.pending.document == key.kind && pending.pending.scope == key.scope
            }) {
                return Err(ConfigApiError::new(
                    "config.pending.unresolved",
                    "Une modification sensible de ce document attend une décision. Acceptez-la ou rejetez-la avant une nouvelle écriture.",
                )
                .with_document(to_document(&key, &stored)));
            }
            stored
        };
        let _file_guard = lock_document_file_async(stored.path.clone()).await?;
        let (approved, disk_pending) = read_runtime_state(self.root(), &key)?;
        if let Some(durable) = disk_pending {
            let mut state = self.state.write().await;
            if let Some(current) = state.documents.get_mut(&key) {
                current.last_valid_value = approved;
            }
            state.pending_changes.retain(|_, pending| {
                pending.pending.document != key.kind || pending.pending.scope != key.scope
            });
            state
                .pending_changes
                .insert(durable.pending.id.clone(), durable);
            let current = state.documents.get(&key).expect("loaded document");
            return Err(ConfigApiError::new(
                "config.pending.unresolved",
                "Une modification sensible de ce document attend une décision. Acceptez-la ou rejetez-la avant une nouvelle écriture.",
            )
            .with_document(to_document(&key, current)));
        }
        let current_raw = fs::read(&stored.path).map_err(|error| {
            ConfigApiError::new(
                "config.document.read_failed",
                format!("Impossible de relire {} : {error}", stored.path.display()),
            )
        })?;
        let is_explicit_ui_replacement = request.source == ConfigChangeSource::UserInterface
            && request.patch.len() == 1
            && request.patch[0].op == "replace"
            && request.patch[0].path.is_empty();
        let parsed_current = serde_json::from_slice::<Value>(&current_raw);
        let current_disk_etag = parsed_current
            .as_ref()
            .map(etag)
            .unwrap_or_else(|_| etag_bytes(&current_raw));
        let current_disk = match parsed_current {
            Ok(value) => value,
            Err(_) if is_explicit_ui_replacement => stored.disk_value.clone(),
            Err(error) => {
                return Err(ConfigApiError::new(
                    "config.document.invalid_on_disk",
                    format!("Le document sur disque est invalide : {error}"),
                ))
            }
        };
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
        if current_disk_etag != request.expected_etag {
            let mut conflict = stored.clone();
            conflict.disk_value = current_disk;
            conflict.etag = current_disk_etag;
            return Err(ConfigApiError::new(
                "config.etag.conflict",
                "Le document a été modifié depuis sa lecture. Rechargez-le avant de réessayer.",
            )
            .with_document(to_document(&key, &conflict)));
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
        let mut proposed = current_disk;
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
        let changed_paths = diff_leaf_paths(&approved, &proposed);
        let (sensitive_paths, reasons) = classify_sensitive_paths(request.kind, &changed_paths);
        let apply_modes = apply_modes_for_paths(request.kind, &changed_paths);
        let needs_approval =
            request.source != ConfigChangeSource::UserInterface && !sensitive_paths.is_empty();
        let new_etag = etag(&proposed);
        atomic_write_json_locked(&stored.path, &proposed).map_err(|error| {
            ConfigApiError::new(
                "config.document.write_failed",
                format!("Impossible d’écrire {} : {error}", stored.path.display()),
            )
        })?;

        let durable_pending = needs_approval.then(|| DurablePendingSensitiveChange {
            pending: PendingSensitiveConfigChange {
                id: Uuid::new_v4().to_string(),
                document: request.kind,
                scope: request.scope.clone(),
                source: request.source,
                changed_paths: sensitive_paths,
                reasons,
                proposed_document: proposed.clone(),
                proposed_etag: new_etag.clone(),
                created_at: Utc::now().to_rfc3339(),
            },
            approved_etag: etag(&approved),
            all_changed_paths: changed_paths.clone(),
            apply_modes: apply_modes.iter().map(|mode| (*mode).to_string()).collect(),
        });
        let pending_path = pending_document_path(self.root(), &key);
        let approved_path = approved_document_path(self.root(), &key);
        if let Some(pending) = &durable_pending {
            write_durable_pending(&pending_path, pending)?;
        } else {
            atomic_write_json(&approved_path, &proposed).map_err(|error| {
                ConfigApiError::new(
                    "config.approved.write_failed",
                    format!("Impossible de promouvoir la configuration : {error}"),
                )
            })?;
            remove_file_if_exists(&pending_path)?;
        }
        let pending = durable_pending.as_ref().map(|entry| entry.pending.clone());
        let restart_required = !needs_approval && apply_modes.contains("restart");

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
        state.pending_changes.retain(|_, existing| {
            existing.pending.document != key.kind || existing.pending.scope != key.scope
        });
        if let Some(durable) = durable_pending {
            state
                .pending_changes
                .insert(durable.pending.id.clone(), durable);
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
        let _reference_guard = matches!(
            kind,
            ConfigDocumentKind::Providers | ConfigDocumentKind::Tools
        )
        .then(|| self.secret_reference_lock.lock());
        let _reference_guard = match _reference_guard {
            Some(guard) => Some(guard.await),
            None => None,
        };
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
        let _file_guard = lock_document_file_async(current.path.clone()).await?;
        let (approved, disk_pending) = read_runtime_state(self.root(), &key)?;

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
        if let Some(durable) = disk_pending
            .as_ref()
            .filter(|pending| pending.pending.proposed_etag == proposed_etag)
        {
            let mut state = self.state.write().await;
            let document = {
                let stored = state.documents.get_mut(&key).expect("loaded document");
                stored.disk_value = durable.pending.proposed_document.clone();
                stored.etag = proposed_etag;
                stored.last_valid_value = approved;
                stored.invalid = false;
                to_document(&key, stored)
            };
            state.pending_changes.retain(|_, pending| {
                pending.pending.document != key.kind || pending.pending.scope != key.scope
            });
            state
                .pending_changes
                .insert(durable.pending.id.clone(), durable.clone());
            return Ok(ReloadOutcome {
                changed: current.etag != document.etag,
                invalid: false,
                pending: Some(durable.pending.clone()),
                restart_required: false,
                document,
            });
        }
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
        if validation.read_only {
            remove_file_if_exists(&pending_document_path(self.root(), &key))?;
            let mut state = self.state.write().await;
            let stored = state.documents.get_mut(&key).expect("loaded document");
            stored.disk_value = proposed;
            stored.etag = proposed_etag;
            stored.invalid = false;
            stored.read_only = true;
            stored.diagnostics = validation.diagnostics;
            let document = to_document(&key, stored);
            state.pending_changes.retain(|_, existing| {
                existing.pending.document != key.kind || existing.pending.scope != key.scope
            });
            return Ok(ReloadOutcome {
                changed: true,
                invalid: false,
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

        let changed_paths = diff_leaf_paths(&approved, &proposed);
        let (sensitive_paths, reasons) = classify_sensitive_paths(kind, &changed_paths);
        let apply_modes = apply_modes_for_paths(kind, &changed_paths);
        let durable_pending = (source != ConfigChangeSource::UserInterface
            && !sensitive_paths.is_empty())
        .then(|| DurablePendingSensitiveChange {
            pending: PendingSensitiveConfigChange {
                id: Uuid::new_v4().to_string(),
                document: kind,
                scope: key.scope.clone(),
                source,
                changed_paths: sensitive_paths,
                reasons,
                proposed_document: proposed.clone(),
                proposed_etag: proposed_etag.clone(),
                created_at: Utc::now().to_rfc3339(),
            },
            approved_etag: etag(&approved),
            all_changed_paths: changed_paths.clone(),
            apply_modes: apply_modes.iter().map(|mode| (*mode).to_string()).collect(),
        });
        let pending_path = pending_document_path(self.root(), &key);
        let approved_path = approved_document_path(self.root(), &key);
        if let Some(pending) = &durable_pending {
            write_durable_pending(&pending_path, pending)?;
        } else {
            atomic_write_json(&approved_path, &proposed).map_err(|error| {
                ConfigApiError::new(
                    "config.approved.write_failed",
                    format!("Impossible de promouvoir la configuration : {error}"),
                )
            })?;
            remove_file_if_exists(&pending_path)?;
        }
        let pending = durable_pending.as_ref().map(|entry| entry.pending.clone());
        let restart_required = durable_pending.is_none() && apply_modes.contains("restart");

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
        state.pending_changes.retain(|_, existing| {
            existing.pending.document != key.kind || existing.pending.scope != key.scope
        });
        if let Some(durable) = durable_pending {
            state
                .pending_changes
                .insert(durable.pending.id.clone(), durable);
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
        let _reference_guard = self.secret_reference_lock.lock().await;
        let durable = self
            .state
            .read()
            .await
            .pending_changes
            .get(id)
            .cloned()
            .ok_or_else(|| {
                ConfigApiError::new(
                    "config.pending.not_found",
                    "La modification sensible en attente est introuvable.",
                )
            })?;
        let key = DocumentKey {
            kind: durable.pending.document,
            scope: durable.pending.scope.clone(),
        };
        let local_lock = self.document_lock(&key).await;
        let _local_guard = local_lock.lock().await;
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
                    "Le document associé à la modification est introuvable.",
                )
            })?;
        let _file_guard = lock_document_file_async(stored.path.clone()).await?;
        let (approved, disk_pending) = read_runtime_state(self.root(), &key)?;
        let durable = disk_pending
            .filter(|pending| pending.pending.id == id)
            .ok_or_else(|| {
                ConfigApiError::new(
                    "config.pending.conflict",
                    "La modification sensible persistée a changé depuis sa lecture.",
                )
            })?;
        let canonical = read_json_value(&stored.path)?;
        let canonical_etag = etag(&canonical);
        if canonical_etag != durable.pending.proposed_etag
            || canonical != durable.pending.proposed_document
        {
            return Err(ConfigApiError::new(
                "config.etag.conflict",
                "Le fichier a changé depuis la demande d’approbation.",
            )
            .with_document(to_document(&key, &stored)));
        }
        if etag(&approved) != durable.approved_etag {
            return Err(ConfigApiError::new(
                "config.pending.baseline_conflict",
                "La copie approuvée a changé depuis la demande d’approbation.",
            ));
        }
        let approved_path = approved_document_path(self.root(), &key);
        atomic_write_json(&approved_path, &durable.pending.proposed_document).map_err(|error| {
            ConfigApiError::new(
                "config.approved.write_failed",
                format!("Impossible de promouvoir la configuration approuvée : {error}"),
            )
        })?;
        remove_file_if_exists(&pending_document_path(self.root(), &key))?;

        let mut state = self.state.write().await;
        let stored = state.documents.get_mut(&key).ok_or_else(|| {
            ConfigApiError::new(
                "config.document.not_found",
                "Le document associé à la modification est introuvable.",
            )
        })?;
        stored.disk_value = canonical;
        stored.etag = canonical_etag;
        stored.last_valid_value = durable.pending.proposed_document;
        stored.invalid = false;
        stored.diagnostics.clear();
        let document = to_document(&key, stored);
        state.pending_changes.remove(id);
        if durable.apply_modes.iter().any(|mode| mode == "restart") {
            state
                .pending_restart_paths
                .extend(durable.all_changed_paths);
        }
        Ok(document)
    }

    pub async fn reject_pending_change(
        &self,
        id: &str,
        restore_approved: bool,
    ) -> Result<ConfigDocument, ConfigApiError> {
        if !restore_approved {
            return Err(ConfigApiError::new(
                "config.pending.restore_required",
                "Le refus doit confirmer explicitement la restauration de la dernière version approuvée.",
            ));
        }
        let _reference_guard = self.secret_reference_lock.lock().await;
        let durable = self
            .state
            .read()
            .await
            .pending_changes
            .get(id)
            .cloned()
            .ok_or_else(|| {
                ConfigApiError::new(
                    "config.pending.not_found",
                    "La modification sensible en attente est introuvable.",
                )
            })?;
        let key = DocumentKey {
            kind: durable.pending.document,
            scope: durable.pending.scope,
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
                    "Le document associé à la modification est introuvable.",
                )
            })?;
        let _file_guard = lock_document_file_async(stored.path.clone()).await?;
        let (approved, disk_pending) = read_runtime_state(self.root(), &key)?;
        let durable = disk_pending
            .filter(|pending| pending.pending.id == id)
            .ok_or_else(|| {
                ConfigApiError::new(
                    "config.pending.conflict",
                    "La modification sensible persistée a changé depuis sa lecture.",
                )
            })?;
        if etag(&approved) != durable.approved_etag {
            return Err(ConfigApiError::new(
                "config.pending.baseline_conflict",
                "La copie approuvée a changé depuis la demande d’approbation.",
            ));
        }
        atomic_write_json_locked(&stored.path, &approved).map_err(|error| {
            ConfigApiError::new(
                "config.document.restore_failed",
                format!("Impossible de restaurer la version approuvée : {error}"),
            )
        })?;
        remove_file_if_exists(&pending_document_path(self.root(), &key))?;

        let mut state = self.state.write().await;
        let stored = state.documents.get_mut(&key).ok_or_else(|| {
            ConfigApiError::new(
                "config.document.not_found",
                "Le document associé à la modification est introuvable.",
            )
        })?;
        stored.disk_value = approved.clone();
        stored.last_valid_value = approved;
        stored.etag = etag(&stored.disk_value);
        stored.last_internal_hash = Some(stored.etag.clone());
        stored.invalid = false;
        stored.diagnostics.clear();
        let document = to_document(&key, stored);
        state.pending_changes.remove(id);
        Ok(document)
    }

    pub async fn list_pending_changes(&self) -> Vec<PendingSensitiveConfigChange> {
        self.state
            .read()
            .await
            .pending_changes
            .values()
            .map(|pending| pending.pending.clone())
            .collect()
    }

    pub async fn secret_reference_documents(&self) -> Vec<Value> {
        let state = self.state.read().await;
        let mut documents = state
            .documents
            .values()
            .map(|stored| stored.last_valid_value.clone())
            .collect::<Vec<_>>();
        documents.extend(state.session_documents.values().cloned());
        documents.extend(
            state
                .pending_changes
                .values()
                .map(|pending| pending.pending.proposed_document.clone()),
        );
        documents
    }

    pub async fn reload_all_changed(
        &self,
        source: ConfigChangeSource,
    ) -> Vec<Result<ReloadOutcome, ConfigApiError>> {
        let project_ids = self
            .state
            .read()
            .await
            .project_roots
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        if let Err(error) = self.discover_project_documents(&project_ids).await {
            return vec![Err(error)];
        }
        let keys = self
            .state
            .read()
            .await
            .documents
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let mut outcomes = Vec::with_capacity(keys.len());
        for key in keys {
            outcomes.push(self.reload(key.kind, key.scope, source).await);
        }
        outcomes
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

fn validate_project_id(project_id: &str) -> Result<(), ConfigApiError> {
    let bytes = project_id.as_bytes();
    let valid = (1..=128).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'));
    let upper = project_id.to_ascii_uppercase();
    let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || upper
            .strip_prefix("COM")
            .or_else(|| upper.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            });
    if !valid || reserved {
        return Err(ConfigApiError::new(
            "config.project.invalid_id",
            "L’identifiant du projet n’est pas valide.",
        ));
    }
    Ok(())
}

fn runtime_scope_key(scope: &ConfigScope) -> String {
    match scope {
        ConfigScope::User => "user".to_string(),
        ConfigScope::Project { project_id } => format!("project-{project_id}"),
    }
}

fn approved_document_path(root: &Path, key: &DocumentKey) -> PathBuf {
    root.join(".runtime")
        .join("approved")
        .join(runtime_scope_key(&key.scope))
        .join(key.kind.file_name())
}

fn pending_document_path(root: &Path, key: &DocumentKey) -> PathBuf {
    root.join(".runtime")
        .join("pending")
        .join(runtime_scope_key(&key.scope))
        .join(key.kind.file_name())
}

fn read_json_value(path: &Path) -> Result<Value, ConfigApiError> {
    let bytes = fs::read(path).map_err(|error| {
        ConfigApiError::new(
            "config.runtime.read_failed",
            format!("Impossible de lire {} : {error}", path.display()),
        )
    })?;
    serde_json::from_slice(&bytes).map_err(|error| {
        ConfigApiError::new(
            "config.runtime.invalid_json",
            format!("Le fichier privé {} est invalide : {error}", path.display()),
        )
    })
}

fn read_durable_pending(
    path: &Path,
) -> Result<Option<DurablePendingSensitiveChange>, ConfigApiError> {
    if !path.exists() {
        return Ok(None);
    }
    let value = read_json_value(path)?;
    serde_json::from_value(value).map(Some).map_err(|error| {
        ConfigApiError::new(
            "config.pending.invalid",
            format!("La demande sensible durable est invalide : {error}"),
        )
    })
}

fn read_runtime_state(
    root: &Path,
    key: &DocumentKey,
) -> Result<(Value, Option<DurablePendingSensitiveChange>), ConfigApiError> {
    let approved = read_json_value(&approved_document_path(root, key)).map_err(|_| {
        ConfigApiError::new(
            "config.approved.invalid",
            "La copie approuvée est absente ou invalide. L’écriture est bloquée par sécurité.",
        )
    })?;
    let validation = validate_document(key.kind, &key.scope, &approved);
    if !validation.valid || validation.read_only {
        return Err(ConfigApiError::new(
            "config.approved.invalid",
            "La copie approuvée ne respecte pas le schéma courant. L’écriture est bloquée par sécurité.",
        )
        .with_diagnostics(validation.diagnostics));
    }

    let pending = read_durable_pending(&pending_document_path(root, key))?;
    if pending.as_ref().is_some_and(|pending| {
        pending.pending.document != key.kind || pending.pending.scope != key.scope
    }) {
        return Err(ConfigApiError::new(
            "config.pending.invalid",
            "La modification sensible persistée ne correspond pas au document verrouillé.",
        ));
    }
    Ok((approved, pending))
}

fn write_durable_pending(
    path: &Path,
    pending: &DurablePendingSensitiveChange,
) -> Result<(), ConfigApiError> {
    let value = serde_json::to_value(pending).map_err(|error| {
        ConfigApiError::new(
            "config.pending.serialize_failed",
            format!("Impossible de sérialiser la demande sensible : {error}"),
        )
    })?;
    atomic_write_json(path, &value).map_err(|error| {
        ConfigApiError::new(
            "config.pending.write_failed",
            format!("Impossible de conserver la demande sensible : {error}"),
        )
    })
}

fn remove_file_if_exists(path: &Path) -> Result<(), ConfigApiError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(ConfigApiError::new(
            "config.runtime.remove_failed",
            format!("Impossible de supprimer {} : {error}", path.display()),
        )),
    }
}

fn backup_corrupt_runtime_file(path: &Path) {
    if !path.exists() {
        return;
    }
    let backup_path = path.with_extension(format!(
        "{}.corrupt-{}.bak",
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("json"),
        Uuid::new_v4()
    ));
    if let Err(error) = fs::copy(path, &backup_path) {
        tracing::warn!(
            path = %path.display(),
            backup = %backup_path.display(),
            %error,
            "Impossible de sauvegarder le fichier runtime corrompu"
        );
    }
}

fn lock_document_file(path: &Path) -> Result<DocumentFileLock, ConfigApiError> {
    let parent = path.parent().ok_or_else(|| {
        ConfigApiError::new(
            "config.document.invalid_path",
            "Le document n’a pas de dossier parent.",
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        ConfigApiError::new(
            "config.document.lock_failed",
            format!("Impossible de préparer le verrou : {error}"),
        )
    })?;
    let lock_path = path.with_extension(format!(
        "{}.lock",
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("json")
    ));
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|error| {
            ConfigApiError::new(
                "config.document.lock_failed",
                format!(
                    "Impossible d’ouvrir le verrou {} : {error}",
                    lock_path.display()
                ),
            )
        })?;
    file.lock_exclusive().map_err(|error| {
        ConfigApiError::new(
            "config.document.lock_failed",
            format!("Impossible de verrouiller {} : {error}", path.display()),
        )
    })?;
    Ok(DocumentFileLock { file })
}

async fn lock_document_file_async(path: PathBuf) -> Result<DocumentFileLock, ConfigApiError> {
    tokio::task::spawn_blocking(move || lock_document_file(&path))
        .await
        .map_err(|error| {
            ConfigApiError::new(
                "config.document.lock_failed",
                format!("La tâche de verrouillage a échoué : {error}"),
            )
        })?
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
    let _guard = lock_document_file(path).map_err(|error| error.message)?;
    atomic_write_json_locked(path, value)
}

fn atomic_write_json_locked(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Le chemin cible n’a pas de dossier parent.".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;

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
    async fn sensitive_pending_survives_restart_without_becoming_effective() {
        let (_temp, manager) = manager().await;
        let root = manager.root().to_path_buf();
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
        let pending_id = result.pending_change.expect("pending").id;
        drop(manager);

        let restarted = ConfigManager::initialize(root).await.expect("restart");
        let snapshot = restarted.get_snapshot(&[]).await.expect("snapshot");
        assert_eq!(
            snapshot.effective["tools"].get("riskLevel"),
            Some(&json!("balanced"))
        );
        assert_eq!(restarted.list_pending_changes().await[0].id, pending_id);
    }

    #[tokio::test]
    async fn unresolved_sensitive_change_blocks_incidental_document_writes() {
        let (_temp, manager) = manager().await;
        let document = manager
            .get_document(ConfigDocumentKind::Tools, ConfigScope::User)
            .await
            .expect("tools");
        let pending = manager
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
            .expect("pending");
        let error = manager
            .apply_patch(ConfigPatchRequest {
                kind: ConfigDocumentKind::Tools,
                scope: ConfigScope::User,
                expected_etag: pending.document.etag,
                patch: vec![JsonPatchOperation {
                    op: "add".to_string(),
                    path: "/builtIn/test_tool".to_string(),
                    from: None,
                    value: Some(json!(false)),
                }],
                source: ConfigChangeSource::UserInterface,
            })
            .await
            .expect_err("unresolved proposal must be decided explicitly");
        assert_eq!(error.code, "config.pending.unresolved");
    }

    #[tokio::test]
    async fn accepted_sensitive_change_remains_effective_after_restart() {
        let (_temp, manager) = manager().await;
        let root = manager.root().to_path_buf();
        let document = manager
            .get_document(ConfigDocumentKind::Tools, ConfigScope::User)
            .await
            .expect("tools");
        let pending = manager
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
            .expect("pending")
            .pending_change
            .expect("pending change");
        manager
            .accept_pending_change(&pending.id)
            .await
            .expect("accept");
        drop(manager);

        let restarted = ConfigManager::initialize(root).await.expect("restart");
        assert!(restarted.list_pending_changes().await.is_empty());
        let snapshot = restarted.get_snapshot(&[]).await.expect("snapshot");
        assert_eq!(
            snapshot.effective["tools"].get("riskLevel"),
            Some(&json!("yolo"))
        );
    }

    #[tokio::test]
    async fn corrupt_approved_baseline_recovers_fail_closed() {
        let (_temp, manager) = manager().await;
        let root = manager.root().to_path_buf();
        let document = manager
            .get_document(ConfigDocumentKind::Tools, ConfigScope::User)
            .await
            .expect("tools");
        manager
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
                source: ConfigChangeSource::UserInterface,
            })
            .await
            .expect("approved UI change");
        drop(manager);

        let key = DocumentKey {
            kind: ConfigDocumentKind::Tools,
            scope: ConfigScope::User,
        };
        fs::write(approved_document_path(&root, &key), b"not-json")
            .expect("corrupt approved baseline");
        let restarted = ConfigManager::initialize(root).await.expect("safe restart");
        let snapshot = restarted.get_snapshot(&[]).await.expect("snapshot");
        assert_eq!(snapshot.effective["tools"]["riskLevel"], json!("balanced"));
        assert_eq!(restarted.list_pending_changes().await.len(), 1);
        assert!(snapshot
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code == "config.approved.recovered" }));
    }

    #[tokio::test]
    async fn rejected_sensitive_change_restores_the_approved_file() {
        let (_temp, manager) = manager().await;
        let root = manager.root().to_path_buf();
        let document = manager
            .get_document(ConfigDocumentKind::Tools, ConfigScope::User)
            .await
            .expect("tools");
        let pending = manager
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
            .expect("pending")
            .pending_change
            .expect("pending change");
        let missing_confirmation = manager
            .reject_pending_change(&pending.id, false)
            .await
            .expect_err("restoration must be explicit");
        assert_eq!(missing_confirmation.code, "config.pending.restore_required");
        let rejected = manager
            .reject_pending_change(&pending.id, true)
            .await
            .expect("reject");
        assert!(rejected.value.get("riskLevel").is_none());
        drop(manager);

        let restarted = ConfigManager::initialize(root).await.expect("restart");
        assert!(restarted.list_pending_changes().await.is_empty());
        let snapshot = restarted.get_snapshot(&[]).await.expect("snapshot");
        assert_eq!(
            snapshot.effective["tools"].get("riskLevel"),
            Some(&json!("balanced"))
        );
    }

    #[tokio::test]
    async fn two_managers_cannot_overwrite_the_same_etag() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("config");
        let first = ConfigManager::initialize(root.clone())
            .await
            .expect("first");
        let second = ConfigManager::initialize(root).await.expect("second");
        let first_document = first
            .get_document(ConfigDocumentKind::Settings, ConfigScope::User)
            .await
            .expect("first settings");
        let second_document = second
            .get_document(ConfigDocumentKind::Settings, ConfigScope::User)
            .await
            .expect("second settings");
        assert_eq!(first_document.etag, second_document.etag);

        first
            .apply_patch(ConfigPatchRequest {
                kind: ConfigDocumentKind::Settings,
                scope: ConfigScope::User,
                expected_etag: first_document.etag,
                patch: vec![JsonPatchOperation {
                    op: "add".to_string(),
                    path: "/language".to_string(),
                    from: None,
                    value: Some(json!("fr")),
                }],
                source: ConfigChangeSource::UserInterface,
            })
            .await
            .expect("first write");
        let conflict = second
            .apply_patch(ConfigPatchRequest {
                kind: ConfigDocumentKind::Settings,
                scope: ConfigScope::User,
                expected_etag: second_document.etag,
                patch: vec![JsonPatchOperation {
                    op: "add".to_string(),
                    path: "/language".to_string(),
                    from: None,
                    value: Some(json!("de")),
                }],
                source: ConfigChangeSource::UserInterface,
            })
            .await
            .expect_err("stale writer");
        assert_eq!(conflict.code, "config.etag.conflict");
        assert_eq!(
            conflict.document.expect("current document").value["language"],
            json!("fr")
        );
    }

    #[tokio::test]
    async fn second_manager_cannot_promote_an_existing_sensitive_proposal() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("config");
        let first = ConfigManager::initialize(root.clone())
            .await
            .expect("first");
        let second = ConfigManager::initialize(root).await.expect("second");
        let document = first
            .get_document(ConfigDocumentKind::Tools, ConfigScope::User)
            .await
            .expect("tools");
        let proposal = first
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
            .expect("pending proposal");

        let error = second
            .apply_patch(ConfigPatchRequest {
                kind: ConfigDocumentKind::Tools,
                scope: ConfigScope::User,
                expected_etag: proposal.document.etag,
                patch: vec![JsonPatchOperation {
                    op: "add".to_string(),
                    path: "/builtIn/write_file".to_string(),
                    from: None,
                    value: Some(json!(false)),
                }],
                source: ConfigChangeSource::UserInterface,
            })
            .await
            .expect_err("durable pending proposal must block the second writer");

        assert_eq!(error.code, "config.pending.unresolved");
        assert_eq!(
            second.get_snapshot(&[]).await.expect("snapshot").effective["tools"]["riskLevel"],
            json!("balanced")
        );
        assert_eq!(second.list_pending_changes().await.len(), 1);
    }

    #[tokio::test]
    async fn project_ids_cannot_escape_the_metadata_root() {
        let (_temp, manager) = manager().await;
        let metadata = tempfile::tempdir().expect("metadata");
        for invalid in ["", ".", "..", "../escape", "project/name", "CON"] {
            let error = manager
                .register_project_root(invalid, metadata.path().to_path_buf())
                .await
                .expect_err("invalid project id");
            assert_eq!(error.code, "config.project.invalid_id");
        }
        let root = manager
            .register_project_root("project-123", metadata.path().to_path_buf())
            .await
            .expect("valid project id");
        assert!(root.starts_with(metadata.path().join("projects")));
    }

    #[tokio::test]
    async fn snapshot_discovers_project_documents_created_after_registration() {
        let (_temp, manager) = manager().await;
        let metadata = tempfile::tempdir().expect("metadata");
        let config_root = manager
            .register_project_root("project-123", metadata.path().to_path_buf())
            .await
            .expect("register project");
        let mut tools = sparse_document(ConfigDocumentKind::Tools);
        tools["builtIn"] = json!({ "terminal_execute": false });
        atomic_write_json(&config_root.join("tools.json"), &tools).expect("external tools file");

        let snapshot = manager
            .get_snapshot(&["project-123".to_string()])
            .await
            .expect("project snapshot");
        assert_eq!(
            snapshot.effective["tools"]["builtIn"]["terminal_execute"],
            json!(false)
        );
        assert!(snapshot.documents.iter().any(|document| {
            document.kind == ConfigDocumentKind::Tools
                && document.scope
                    == ConfigScope::Project {
                        project_id: "project-123".to_string(),
                    }
        }));
    }

    #[tokio::test]
    async fn snapshot_preserves_focused_project_models_and_uses_global_models_when_ambiguous() {
        let (_temp, manager) = manager().await;
        let user_agents = manager
            .get_document(ConfigDocumentKind::Agents, ConfigScope::User)
            .await
            .expect("user agents");
        manager
            .apply_patch(ConfigPatchRequest {
                kind: ConfigDocumentKind::Agents,
                scope: ConfigScope::User,
                expected_etag: user_agents.etag,
                patch: vec![JsonPatchOperation {
                    op: "add".to_string(),
                    path: "/models".to_string(),
                    from: None,
                    value: Some(json!({"chat": {
                        "providerId": "provider",
                        "modelId": "global-model"
                    }})),
                }],
                source: ConfigChangeSource::UserInterface,
            })
            .await
            .expect("set global model");

        for (project_id, model_id) in [
            ("project-a", "project-a-model"),
            ("project-b", "project-b-model"),
        ] {
            let metadata = tempfile::tempdir().expect("metadata");
            // Keep each metadata directory alive for the duration of registration and patching.
            let metadata_path = metadata.keep();
            manager
                .register_project_root(project_id, metadata_path)
                .await
                .expect("register project");
            let scope = ConfigScope::Project {
                project_id: project_id.to_string(),
            };
            let project_agents = manager
                .get_document(ConfigDocumentKind::Agents, scope.clone())
                .await
                .expect("project agents");
            manager
                .apply_patch(ConfigPatchRequest {
                    kind: ConfigDocumentKind::Agents,
                    scope,
                    expected_etag: project_agents.etag,
                    patch: vec![JsonPatchOperation {
                        op: "add".to_string(),
                        path: "/models".to_string(),
                        from: None,
                        value: Some(json!({"chat": {
                            "providerId": "provider",
                            "modelId": model_id
                        }})),
                    }],
                    source: ConfigChangeSource::UserInterface,
                })
                .await
                .expect("set project model");
        }

        let focused = manager
            .get_snapshot(&["project-a".to_string()])
            .await
            .expect("focused project snapshot");
        assert_eq!(
            focused.effective["agents"].pointer("/models/chat/modelId"),
            Some(&json!("project-a-model"))
        );
        assert_eq!(
            focused.project_effective["project-a"]["agents"].pointer("/models/chat/modelId"),
            Some(&json!("project-a-model"))
        );
        assert!(focused.provenance.iter().any(|entry| {
            entry.json_pointer == "/agents/models/chat/modelId"
                && entry.origin == ConfigOrigin::Project
                && entry.project_id.as_deref() == Some("project-a")
        }));

        let ambiguous = manager
            .get_snapshot(&["project-a".to_string(), "project-b".to_string()])
            .await
            .expect("ambiguous multi-project snapshot");
        assert_eq!(
            ambiguous.effective["agents"].pointer("/models/chat/modelId"),
            Some(&json!("global-model"))
        );
        assert_eq!(
            ambiguous.project_effective["project-a"]["agents"].pointer("/models/chat/modelId"),
            Some(&json!("project-a-model"))
        );
        assert_eq!(
            ambiguous.project_effective["project-b"]["agents"].pointer("/models/chat/modelId"),
            Some(&json!("project-b-model"))
        );
    }

    #[tokio::test]
    async fn project_registration_keeps_an_mcp_id_collision_inactive() {
        let (_temp, manager) = manager().await;
        let user_tools = manager
            .get_document(ConfigDocumentKind::Tools, ConfigScope::User)
            .await
            .expect("user tools");
        manager
            .apply_patch(ConfigPatchRequest {
                kind: ConfigDocumentKind::Tools,
                scope: ConfigScope::User,
                expected_etag: user_tools.etag,
                patch: vec![JsonPatchOperation {
                    op: "add".to_string(),
                    path: "/mcpServers".to_string(),
                    from: None,
                    value: Some(json!({
                        "github_server": {
                            "enabled": true,
                            "transport": {"type": "stdio", "command": "global-mcp"}
                        }
                    })),
                }],
                source: ConfigChangeSource::UserInterface,
            })
            .await
            .expect("set global MCP server");

        let metadata = _temp.path().join("collision-metadata");
        let config_root = metadata.join("projects/collision-project/config");
        fs::create_dir_all(&config_root).expect("project config root");
        let mut project_tools = sparse_document(ConfigDocumentKind::Tools);
        project_tools["mcpServers"] = json!({
            "GitHub Server": {
                "enabled": true,
                "transport": {
                    "type": "stdio",
                    "command": "project-mcp",
                    "env": {
                        "API_TOKEN": "macro-secret://mcp-env/github_server/API_TOKEN"
                    }
                }
            }
        });
        atomic_write_json(&config_root.join("tools.json"), &project_tools).expect("project tools");

        manager
            .register_project_root("collision-project", metadata)
            .await
            .expect("invalid project document remains registered with a safe baseline");
        let document = manager
            .get_document(
                ConfigDocumentKind::Tools,
                ConfigScope::Project {
                    project_id: "collision-project".to_string(),
                },
            )
            .await
            .expect("invalid project document");
        assert!(
            document
                .diagnostics
                .iter()
                .any(|diagnostic| { diagnostic.code == "config.tools.mcp_server_id_noncanonical" }),
            "{:?}",
            document.diagnostics
        );
        let snapshot = manager
            .get_snapshot(&["collision-project".to_string()])
            .await
            .expect("safe project snapshot");
        assert!(
            snapshot.project_effective["collision-project"]["tools"]["mcpServers"]
                .get("GitHub Server")
                .is_none()
        );
    }

    #[tokio::test]
    async fn snapshot_rejects_an_explicit_unregistered_project() {
        let (_temp, manager) = manager().await;
        let error = manager
            .get_snapshot(&["missing-project".to_string()])
            .await
            .expect_err("unknown project must fail closed");
        assert_eq!(error.code, "config.project.not_registered");
    }

    #[tokio::test]
    async fn failed_project_registration_does_not_leave_an_executable_project() {
        let (_temp, manager) = manager().await;
        let metadata = tempfile::tempdir().expect("metadata");
        let config_root = metadata
            .path()
            .join("projects")
            .join("unsafe-project")
            .join("config");
        fs::create_dir_all(&config_root).expect("config root");
        let mut tools = sparse_document(ConfigDocumentKind::Tools);
        tools["riskLevel"] = json!("yolo");
        atomic_write_json(&config_root.join("tools.json"), &tools).expect("unsafe tools");

        let registration = manager
            .register_project_root("unsafe-project", metadata.path().to_path_buf())
            .await
            .expect_err("relaxing project configuration must fail registration");
        assert_eq!(registration.code, "config.project.relaxation_forbidden");

        let snapshot = manager
            .get_snapshot(&["unsafe-project".to_string()])
            .await
            .expect_err("failed registration must stay unavailable");
        assert_eq!(snapshot.code, "config.project.not_registered");
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

    #[tokio::test]
    async fn future_schema_document_stays_read_only_and_never_becomes_effective() {
        let (_temp, manager) = manager().await;
        let root = manager.root().to_path_buf();
        let path = root.join(ConfigDocumentKind::Settings.file_name());
        atomic_write_json(
            &path,
            &json!({
                "$schema": "./schemas/v999/settings.schema.json",
                "schemaVersion": 999,
                "language": "fr",
                "futureProperty": true
            }),
        )
        .expect("future document");

        let outcome = manager
            .reload(
                ConfigDocumentKind::Settings,
                ConfigScope::User,
                ConfigChangeSource::ExternalEditor,
            )
            .await
            .expect("reload future document");
        assert!(outcome.document.read_only);
        assert_eq!(
            manager.get_snapshot(&[]).await.expect("snapshot").effective["settings"]["language"],
            json!("en")
        );
        drop(manager);

        let restarted = ConfigManager::initialize(root).await.expect("restart");
        let document = restarted
            .get_document(ConfigDocumentKind::Settings, ConfigScope::User)
            .await
            .expect("future settings");
        assert!(document.read_only);
        assert_eq!(document.value["futureProperty"], json!(true));
        assert_eq!(
            restarted
                .get_snapshot(&[])
                .await
                .expect("snapshot")
                .effective["settings"]["language"],
            json!("en")
        );
    }
}
