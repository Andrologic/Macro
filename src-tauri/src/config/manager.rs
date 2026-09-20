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
use std::time::SystemTime;
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(super) struct DirectoryIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    created: Option<SystemTime>,
}

impl DirectoryIdentity {
    pub(super) fn read(root: &Path) -> Result<Self, String> {
        let metadata = root.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_dir() {
            return Err("Configuration root is not a directory".into());
        }
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
            created: metadata.created().ok(),
        })
    }
}

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

// Approval belongs to this canonical directory, even when another root contains
// identical JSON. Persist the binding so process restarts cannot revive an old ID.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct PendingRootBinding {
    path: PathBuf,
    identity: DirectoryIdentity,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DurablePendingSensitiveChange {
    pending: PendingSensitiveConfigChange,
    // Legacy project proposals have no binding and require a fresh approval ID.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project_root: Option<PendingRootBinding>,
    // Ack and new consent ID are published in the same atomic pending write.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_root_transition: Option<String>,
    approved_etag: String,
    all_changed_paths: Vec<String>,
    apply_modes: Vec<String>,
}

// The only transition authority: one current intent in private runtime storage.
// Per-proposal acknowledgements make replay idempotent without a second journal.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DurableProjectRootTransition {
    id: String,
    project_id: String,
    target: Option<PendingRootBinding>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DurableConfigPublication {
    document: ConfigDocumentKind,
    scope: ConfigScope,
    previous_document: Value,
    previous_etag: String,
    proposed_etag: String,
}

#[derive(Default)]
struct ConfigState {
    documents: BTreeMap<DocumentKey, StoredDocument>,
    project_roots: BTreeMap<String, PathBuf>,
    // Resolved destinations requested by the registry, including roots not yet
    // usable. Withdrawal removes this entry but keeps any consent transition.
    desired_project_roots: BTreeMap<String, PathBuf>,
    project_identities: BTreeMap<String, Option<DirectoryIdentity>>,
    project_load_errors: BTreeMap<String, ConfigApiError>,
    // Cache the current intent, including an initial write that failed. The disk
    // intent wins on recovery; this cache is never an alternative commit point.
    project_transitions: BTreeMap<String, DurableProjectRootTransition>,
    reconciliation_diagnostic: Option<ConfigDiagnostic>,
    maintenance_diagnostic: Option<ConfigDiagnostic>,
    session_documents: BTreeMap<ConfigDocumentKind, Value>,
    pending_changes: BTreeMap<String, DurablePendingSensitiveChange>,
    pending_restart_paths: BTreeSet<String>,
}

#[derive(Clone)]
pub struct ConfigManager {
    root: Arc<PathBuf>,
    state: Arc<RwLock<ConfigState>>,
    document_locks: Arc<Mutex<BTreeMap<DocumentKey, Arc<Mutex<()>>>>>,
    project_registration: Arc<Mutex<()>>,
    mcp_runtime_authority: Arc<RwLock<()>>,
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
            project_registration: Arc::new(Mutex::new(())),
            mcp_runtime_authority: Arc::new(RwLock::new(())),
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

    pub async fn lock_secret_references(&self) -> tokio::sync::OwnedRwLockWriteGuard<()> {
        self.mcp_runtime_authority.clone().write_owned().await
    }

    pub(crate) async fn lock_mcp_runtime_configuration(
        &self,
    ) -> tokio::sync::OwnedRwLockReadGuard<()> {
        self.mcp_runtime_authority.clone().read_owned().await
    }

    pub async fn register_project_root(
        &self,
        project_id: &str,
        macro_metadata_root: PathBuf,
    ) -> Result<PathBuf, ConfigApiError> {
        let _references = self.mcp_runtime_authority.write().await;
        let _registration = self.project_registration.lock().await;
        validate_project_id(project_id)?;
        let projects_root = macro_metadata_root.join("projects");
        let config_root = projects_root.join(project_id).join("config");
        if !config_root.try_exists().map_err(|error| {
            ConfigApiError::new("config.project.resolve_failed", error.to_string())
        })? {
            // Resolve the directory identity before requesting its binding. The
            // registered root and every proposal remain unchanged until the intent
            // is durable. No project document is loaded or locked here.
            fs::create_dir_all(&config_root).map_err(|error| {
                ConfigApiError::new(
                    "config.project.create_failed",
                    format!("Impossible de créer le dossier de configuration du projet : {error}"),
                )
            })?;
        }
        let config_root = config_root.canonicalize().map_err(|error| {
            ConfigApiError::new("config.project.resolve_failed", error.to_string())
        })?;
        let identity = DirectoryIdentity::read(&config_root)
            .map_err(|message| ConfigApiError::new("config.project.resolve_failed", message))?;
        let binding = PendingRootBinding {
            path: config_root.clone(),
            identity,
        };
        // Subscription intent is separate from activating configuration. Retain
        // this resolved path even if the runtime gate or initial intent write fails.
        self.state
            .write()
            .await
            .desired_project_roots
            .insert(project_id.to_string(), config_root.clone());
        // The requested subscription can be A while the pending consent intent
        // still targets B. Finish B before installing or loading A, including on
        // startup; automatic refresh retains this latest requested destination.
        self.resume_project_transition(project_id).await?;
        let _transition = self
            .prepare_project_root(project_id, Some(binding.clone()))
            .await?;
        self.install_project_root(project_id, &binding).await;
        // Loading is idempotent, including same-root retries after partial loads.
        self.load_registered_project_documents(project_id, &config_root)
            .await?;
        Ok(config_root)
    }

    /// Return the latest resolved subscription requested by the registry, even
    /// while an older consent transition blocks activation. Withdrawal hides the
    /// request without erasing its unfinished transition or reopening the project.
    pub(crate) async fn desired_project_root(&self, project_id: &str) -> Option<PathBuf> {
        self.state
            .read()
            .await
            .desired_project_roots
            .get(project_id)
            .cloned()
    }

    // Caller has completed any necessary transition and holds registration and
    // the project gate. This helper never changes the desired subscription.
    async fn install_project_root(&self, project_id: &str, binding: &PendingRootBinding) {
        let same_root = {
            let state = self.state.read().await;
            state.project_roots.get(project_id) == Some(&binding.path)
                && state
                    .project_identities
                    .get(project_id)
                    .and_then(Option::as_ref)
                    == Some(&binding.identity)
        };
        if !same_root {
            self.unregister_project_root_inner(project_id).await;
            let mut state = self.state.write().await;
            state
                .project_roots
                .insert(project_id.to_string(), binding.path.clone());
            state
                .project_identities
                .insert(project_id.to_string(), Some(binding.identity.clone()));
        }
    }

    // Caller holds project_registration. Keep successful loads across retries so an
    // unchanged failure neither purges runtime state nor recreates pending proposals.
    async fn load_registered_project_documents(
        &self,
        project_id: &str,
        root: &Path,
    ) -> Result<(), ConfigApiError> {
        let result = async {
            self.require_project_root_identity(project_id).await?;
            for kind in ConfigDocumentKind::ALL
                .into_iter()
                .filter(|kind| kind.supports_project_scope())
            {
                let scope = ConfigScope::Project {
                    project_id: project_id.to_string(),
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
                    self.load_document_from_path_locked(kind, scope, path, false)
                        .await?;
                }
            }
            self.require_project_root_identity(project_id).await
        }
        .await;
        let mut state = self.state.write().await;
        match &result {
            Ok(()) => {
                state.project_load_errors.remove(project_id);
            }
            Err(error) => {
                state
                    .project_load_errors
                    .insert(project_id.to_string(), error.clone());
            }
        }
        result
    }

    // Lock order: MCP authority, registration, project intent file, local document,
    // canonical document, runtime transaction, runtime publication files. Ordinary
    // readers never resume an intent: they may already hold an MCP read guard.
    async fn lock_project_access(
        &self,
        scope: &ConfigScope,
    ) -> Result<Option<DocumentFileLock>, ConfigApiError> {
        let ConfigScope::Project { project_id } = scope else {
            return Ok(None);
        };
        validate_project_id(project_id)?;
        self.require_no_project_transition(project_id).await?;
        let guard =
            lock_document_file_async(project_transition_path(self.root(), project_id)).await?;
        self.require_no_project_transition(project_id).await?;
        Ok(Some(guard))
    }

    async fn require_no_project_transition(&self, project_id: &str) -> Result<(), ConfigApiError> {
        if self
            .state
            .read()
            .await
            .project_transitions
            .contains_key(project_id)
            || read_project_transition(self.root(), project_id)?.is_some()
        {
            return Err(ConfigApiError::new(
                "config.project.transition_incomplete",
                format!("La transition de configuration du projet {project_id} doit être terminée avant utilisation."),
            ));
        }
        Ok(())
    }

    // Called only with registration held. Returning the gate lets the caller keep
    // the root installation and document loads serialized with other processes.
    async fn prepare_project_root(
        &self,
        project_id: &str,
        target: Option<PendingRootBinding>,
    ) -> Result<DocumentFileLock, ConfigApiError> {
        let result: Result<DocumentFileLock, ConfigApiError> = async {
            self.resume_project_transition(project_id).await?;
            let state = self.state.read().await;
            let changed = state.project_roots.get(project_id).is_some_and(|path| {
                target
                    .as_ref()
                    .map(|binding| (&binding.path, Some(&binding.identity)))
                    != Some((
                        path,
                        state
                            .project_identities
                            .get(project_id)
                            .and_then(Option::as_ref),
                    ))
                    && !(target.is_none()
                        && state.project_identities.get(project_id) == Some(&None))
            });
            drop(state);
            if changed || project_pending_needs_transition(self.root(), project_id, target.as_ref())
            {
                // Also capture startup rebinding before the gate: withdrawing the
                // desired subscription must not erase this failed transition.
                // Keep the requested target even if acquiring its runtime gate fails.
                self.cache_project_transition(project_id, target.clone())
                    .await;
            }
            let guard =
                lock_document_file_async(project_transition_path(self.root(), project_id)).await?;
            self.resume_project_transition_locked(project_id).await?;
            // On startup there is no in-memory root. Compare all durable bindings,
            // including proposals without a corresponding JSON in the target.
            if project_pending_needs_transition(self.root(), project_id, target.as_ref()) {
                self.cache_project_transition(project_id, target).await;
                self.resume_project_transition_locked(project_id).await?;
            }
            Ok(guard)
        }
        .await;
        if let Err(error) = &result {
            self.state
                .write()
                .await
                .project_load_errors
                .insert(project_id.to_string(), error.clone());
        }
        result
    }

    async fn cache_project_transition(&self, project_id: &str, target: Option<PendingRootBinding>) {
        self.state
            .write()
            .await
            .project_transitions
            .entry(project_id.to_string())
            .or_insert_with(|| DurableProjectRootTransition {
                id: Uuid::new_v4().to_string(),
                project_id: project_id.to_string(),
                target,
            });
    }

    async fn resume_project_transition(&self, project_id: &str) -> Result<bool, ConfigApiError> {
        let result = async {
            if let Some(intent) = read_project_transition(self.root(), project_id)? {
                self.state
                    .write()
                    .await
                    .project_transitions
                    .insert(project_id.to_string(), intent);
            }
            if !self
                .state
                .read()
                .await
                .project_transitions
                .contains_key(project_id)
            {
                return Ok(false);
            }
            let _gate =
                lock_document_file_async(project_transition_path(self.root(), project_id)).await?;
            self.resume_project_transition_locked(project_id).await
        }
        .await;
        if let Err(error) = &result {
            self.state
                .write()
                .await
                .project_load_errors
                .insert(project_id.to_string(), error.clone());
        }
        result
    }

    // Caller holds registration and the project file gate. The persisted intent
    // wins over both the requested root and cached observations until every ack is
    // durable. Replaying it does not require the target directory to still exist.
    async fn resume_project_transition_locked(
        &self,
        project_id: &str,
    ) -> Result<bool, ConfigApiError> {
        let intent = read_project_transition(self.root(), project_id)?.or(self
            .state
            .read()
            .await
            .project_transitions
            .get(project_id)
            .cloned());
        let Some(intent) = intent else {
            return Ok(false);
        };
        self.state
            .write()
            .await
            .project_transitions
            .insert(project_id.to_string(), intent.clone());
        let intent_path = project_transition_path(self.root(), project_id);
        // Rewrite on replay to retry a failed fsync as well as a failed initial write.
        write_project_transition(&intent_path, &intent)?;
        let previous_root = self
            .state
            .read()
            .await
            .project_roots
            .get(project_id)
            .cloned();
        self.unregister_project_root_inner(project_id).await;
        {
            let mut state = self.state.write().await;
            if let Some(binding) = &intent.target {
                state
                    .project_roots
                    .insert(project_id.to_string(), binding.path.clone());
                state
                    .project_identities
                    .insert(project_id.to_string(), Some(binding.identity.clone()));
            } else if let Some(root) = previous_root {
                state.project_roots.insert(project_id.to_string(), root);
                state
                    .project_identities
                    .insert(project_id.to_string(), None);
            }
        }
        let scope = ConfigScope::Project {
            project_id: project_id.to_string(),
        };
        let mut errors = Vec::new();
        for kind in ConfigDocumentKind::ALL
            .into_iter()
            .filter(|kind| kind.supports_project_scope())
        {
            let key = DocumentKey {
                kind,
                scope: scope.clone(),
            };
            let result = async {
                let path = pending_document_path(self.root(), &key);
                if !runtime_file_exists(&path)? {
                    return Ok(());
                }
                let local = self.document_lock(&key).await;
                let _local = local.lock().await;
                let _transaction = lock_project_pending_file(self.root(), &key).await?;
                let _pending = lock_document_file_async(path.clone()).await?;
                // Only private pending data is changed. In particular, no lock or
                // directory creation in B, and no baseline/publication mutation.
                acknowledge_project_transition(&path, &key, &intent)
            }
            .await;
            if let Err(error) = result {
                errors.push((kind, error));
            }
        }
        if !errors.is_empty() {
            return Err(project_transition_errors(&scope, errors));
        }
        remove_file_if_exists(&intent_path)?;
        sync_parent_directory(intent_path.parent().expect("runtime transition directory"))
            .map_err(|message| {
                ConfigApiError::new("config.project.transition.remove_failed", message)
            })?;
        let mut state = self.state.write().await;
        state.project_transitions.remove(project_id);
        state.project_load_errors.remove(project_id);
        Ok(true)
    }

    /// Persist an observed absence even if the directory has already returned.
    /// An unknown project is a no-op. A failed intent or ack remains retryable.
    pub(crate) async fn observe_project_root_unavailable(
        &self,
        project_id: &str,
    ) -> Result<(), ConfigApiError> {
        let _references = self.mcp_runtime_authority.write().await;
        let _registration = self.project_registration.lock().await;
        validate_project_id(project_id)?;
        // Observations cannot reopen an explicitly removed project. Only register
        // may resume a retained intent after unregister.
        if !self
            .state
            .read()
            .await
            .desired_project_roots
            .contains_key(project_id)
        {
            return Ok(());
        }
        // Finish the older intent first; an error leaves this observation for the
        // caller to retry, rather than acknowledging an unrecorded absence.
        self.resume_project_transition(project_id).await?;
        self.prepare_project_root(project_id, None).await?;
        Ok(())
    }

    /// Forget runtime state only. Approved baselines, proposals and project files stay on disk.
    pub async fn unregister_project_root(&self, project_id: &str) {
        let _references = self.mcp_runtime_authority.write().await;
        let _registration = self.project_registration.lock().await;
        self.state
            .write()
            .await
            .desired_project_roots
            .remove(project_id);
        self.unregister_project_root_inner(project_id).await;
    }

    async fn unregister_project_root_inner(&self, project_id: &str) {
        let scope = ConfigScope::Project {
            project_id: project_id.to_string(),
        };
        // Keep mutex identities alive: callers may already be waiting on these locks.
        let mut guards = Vec::new();
        for kind in ConfigDocumentKind::ALL
            .into_iter()
            .filter(|kind| kind.supports_project_scope())
        {
            guards.push(
                self.document_lock(&DocumentKey {
                    kind,
                    scope: scope.clone(),
                })
                .await
                .lock_owned()
                .await,
            );
        }
        let mut state = self.state.write().await;
        state.project_roots.remove(project_id);
        state.project_identities.remove(project_id);
        state.project_load_errors.remove(project_id);
        state.documents.retain(|key, _| key.scope != scope);
        state
            .pending_changes
            .retain(|_, pending| pending.pending.scope != scope);
    }

    pub async fn retain_project_roots(&self, project_ids: &BTreeSet<String>) {
        let _references = self.mcp_runtime_authority.write().await;
        let _registration = self.project_registration.lock().await;
        let removed = self
            .state
            .read()
            .await
            .desired_project_roots
            .keys()
            .filter(|id| !project_ids.contains(*id))
            .cloned()
            .collect::<Vec<_>>();
        for id in removed {
            self.state.write().await.desired_project_roots.remove(&id);
            self.unregister_project_root_inner(&id).await;
        }
    }

    /// Refresh directory replacements and retry incomplete loads. `changed` reports
    /// a cache mutation or recovery. Each failed retry returns its error for watcher
    /// backoff; the caller deduplicates notifications. Recovery reports a change
    /// even with the same directory identity.
    pub(crate) async fn refresh_project_roots(&self) -> (bool, Vec<ConfigApiError>) {
        let _references = self.mcp_runtime_authority.write().await;
        let _registration = self.project_registration.lock().await;
        let project_ids = {
            let state = self.state.read().await;
            state
                .desired_project_roots
                .keys()
                .cloned()
                .collect::<BTreeSet<_>>()
        };
        let mut changed = false;
        let mut errors = Vec::new();
        for project_id in project_ids {
            let before = {
                let state = self.state.read().await;
                (
                    state.project_roots.get(&project_id).cloned(),
                    state.project_identities.get(&project_id).cloned(),
                    state
                        .documents
                        .keys()
                        .filter(|key| {
                            key.scope
                                == (ConfigScope::Project {
                                    project_id: project_id.clone(),
                                })
                        })
                        .count(),
                )
            };
            let result = async {
                let resumed = self.resume_project_transition(&project_id).await?;
                let (root, previous_identity, needs_retry) = {
                    let state = self.state.read().await;
                    (
                        state.desired_project_roots.get(&project_id).cloned(),
                        state.project_identities.get(&project_id).cloned(),
                        state.project_load_errors.contains_key(&project_id),
                    )
                };
                let Some(root) = root else {
                    return Ok(resumed);
                };
                let identity = DirectoryIdentity::read(&root).ok();
                let same_root =
                    self.state.read().await.project_roots.get(&project_id) == Some(&root);
                if same_root
                    && previous_identity == Some(identity.clone())
                    && !needs_retry
                    && !resumed
                {
                    return Ok(false);
                }
                let target = identity.clone().map(|identity| PendingRootBinding {
                    path: root.clone(),
                    identity,
                });
                let _gate = self
                    .prepare_project_root(&project_id, target.clone())
                    .await?;
                if identity.is_none() {
                    if previous_identity != Some(None) {
                        return Err(ConfigApiError::new(
                            "config.project.root_missing",
                            format!(
                                "La racine de configuration du projet {project_id} est absente."
                            ),
                        ));
                    }
                    return Ok(resumed);
                }
                self.install_project_root(&project_id, target.as_ref().expect("available root"))
                    .await;
                self.load_registered_project_documents(&project_id, &root)
                    .await?;
                Ok(true)
            }
            .await;
            let after = {
                let state = self.state.read().await;
                (
                    state.project_roots.get(&project_id).cloned(),
                    state.project_identities.get(&project_id).cloned(),
                    state
                        .documents
                        .keys()
                        .filter(|key| {
                            key.scope
                                == (ConfigScope::Project {
                                    project_id: project_id.clone(),
                                })
                        })
                        .count(),
                )
            };
            changed |= before != after;
            match result {
                Ok(recovered) => changed |= recovered,
                Err(error) => errors.push(error),
            }
        }
        (changed, errors)
    }

    async fn require_current_project_root(&self, project_id: &str) -> Result<(), ConfigApiError> {
        self.require_project_root_identity(project_id).await?;
        if let Some(error) = self.state.read().await.project_load_errors.get(project_id) {
            return Err(error.clone());
        }
        Ok(())
    }

    async fn require_project_root_identity(&self, project_id: &str) -> Result<(), ConfigApiError> {
        self.pending_root_binding(&ConfigScope::Project {
            project_id: project_id.to_string(),
        })
        .await
        .map(|_| ())
    }

    async fn pending_root_binding(
        &self,
        scope: &ConfigScope,
    ) -> Result<Option<PendingRootBinding>, ConfigApiError> {
        let ConfigScope::Project { project_id } = scope else {
            return Ok(None);
        };
        self.require_no_project_transition(project_id).await?;
        let state = self.state.read().await;
        let root = state.project_roots.get(project_id).ok_or_else(|| {
            ConfigApiError::new(
                "config.project.not_registered",
                "La racine metadata du projet n’a pas encore été enregistrée.",
            )
        })?;
        let identity = DirectoryIdentity::read(root)
            .map_err(|message| ConfigApiError::new("config.project.root_missing", message))?;
        if state
            .project_identities
            .get(project_id)
            .and_then(Option::as_ref)
            != Some(&identity)
        {
            return Err(ConfigApiError::new("config.project.root_changed", "La racine de configuration a changé. Son rechargement est nécessaire avant utilisation."));
        }
        Ok(Some(PendingRootBinding {
            path: root.clone(),
            identity,
        }))
    }

    /// A committed workspace mutation remains successful; configuration degradation
    /// is carried by the existing diagnostic/event contract, not by a mutation error.
    pub(crate) async fn record_reconciliation_diagnostic(
        &self,
        message: Option<String>,
    ) -> ConfigDocument {
        let mut state = self.state.write().await;
        state.reconciliation_diagnostic = message.map(|message| ConfigDiagnostic {
            document: ConfigDocumentKind::Runtime,
            scope: ConfigScope::User,
            path: None,
            code: "config.project.reconciliation_incomplete".into(),
            message,
            severity: "warning".into(),
        });
        runtime_document_with_diagnostics(&state)
    }

    /// Maintenance owns only this diagnostic. Clearing it preserves any workspace
    /// reconciliation warning. The returned Runtime/User document contains both.
    pub(crate) async fn record_maintenance_diagnostic(
        &self,
        message: Option<String>,
    ) -> ConfigDocument {
        let mut state = self.state.write().await;
        state.maintenance_diagnostic = message.map(|message| ConfigDiagnostic {
            document: ConfigDocumentKind::Runtime,
            scope: ConfigScope::User,
            path: None,
            code: "config.project.maintenance_incomplete".into(),
            message,
            severity: "warning".into(),
        });
        runtime_document_with_diagnostics(&state)
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
        let _project = self.lock_project_access(&scope).await?;
        self.load_document_from_path_locked(kind, scope, path, fail_on_invalid_initial)
            .await
    }

    // Caller owns the project gate, if applicable.
    async fn load_document_from_path_locked(
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
        let _runtime_guards = lock_project_runtime_files(self.root(), &key).await?;
        let project_root = self.pending_root_binding(&key.scope).await?;
        recover_config_publication(self.root(), &key, &path)?;
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
                    write_runtime_json(&approved_path, &baseline, &key.scope).map_err(|error| {
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
            write_runtime_json(&approved_path, &baseline, &key.scope).map_err(|error| {
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
        require_pending_document(&key, durable_pending.as_ref())?;
        require_pending_root_binding(durable_pending.as_ref(), project_root.as_ref())?;
        if validation.read_only {
            durable_pending = None;
            remove_file_if_exists(&pending_path)?;
        } else if !invalid {
            if matches!(key.scope, ConfigScope::Project { .. }) {
                let global = self.effective_user_document(kind).await;
                self.pending_root_binding(&key.scope).await?;
                project_overlay_is_restrictive(kind, &global, &value).map_err(|message| {
                    ConfigApiError::new("config.project.relaxation_forbidden", message)
                })?;
            }

            let approved_etag = etag(&approved);
            if document_etag == approved_etag {
                durable_pending = None;
                if let Some(diagnostic) = cleanup_committed_pending(&pending_path, &key) {
                    runtime_diagnostics.push(diagnostic);
                }
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
                    write_runtime_json(&approved_path, &value, &key.scope).map_err(|error| {
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
                        project_root,
                        last_root_transition: None,
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
        state.pending_changes.retain(|_, pending| {
            pending.pending.document != key.kind || pending.pending.scope != key.scope
        });
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
        let _registration = self.project_registration.lock().await;
        validate_project_id(project_id)?;
        let _project = self
            .lock_project_access(&ConfigScope::Project {
                project_id: project_id.to_string(),
            })
            .await?;
        self.require_current_project_root(project_id).await?;
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
            let _creation_guard = lock_document_file_async(path.clone()).await?;
            self.require_current_project_root(project_id).await?;
            if !path.exists() {
                atomic_write_json_locked(&path, &sparse_document(kind)).map_err(|error| {
                    ConfigApiError::new(
                        "config.document.create_failed",
                        format!("Impossible de créer {} : {error}", path.display()),
                    )
                })?;
            }
        }
        self.load_document_from_path_locked(kind, key.scope, path, true)
            .await
    }

    async fn lock_and_discover_project_documents(
        &self,
        project_ids: &[String],
    ) -> Result<(tokio::sync::MutexGuard<'_, ()>, Vec<DocumentFileLock>), ConfigApiError> {
        let registration = self.project_registration.lock().await;
        let mut gates = Vec::new();
        for project_id in project_ids.iter().collect::<BTreeSet<_>>() {
            if let Some(gate) = self
                .lock_project_access(&ConfigScope::Project {
                    project_id: project_id.clone(),
                })
                .await?
            {
                gates.push(gate);
            }
        }
        for project_id in project_ids {
            validate_project_id(project_id)?;
            self.require_current_project_root(project_id).await?;
        }
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
                    self.load_document_from_path_locked(kind, scope, path, false)
                        .await?;
                }
            }
        }
        for project_id in project_ids {
            self.require_current_project_root(project_id).await?;
        }
        Ok((registration, gates))
    }

    pub async fn get_document(
        &self,
        kind: ConfigDocumentKind,
        scope: ConfigScope,
    ) -> Result<ConfigDocument, ConfigApiError> {
        if let ConfigScope::Project { project_id } = &scope {
            self.ensure_project_document(kind, project_id).await?;
        }
        let _project = self.lock_project_access(&scope).await?;
        if let ConfigScope::Project { project_id } = &scope {
            self.require_current_project_root(project_id).await?;
        }
        let key = DocumentKey { kind, scope };
        let state = self.state.read().await;
        let stored = state.documents.get(&key).ok_or_else(|| {
            ConfigApiError::new(
                "config.document.not_found",
                "Le document de configuration demandé est introuvable.",
            )
        })?;
        Ok(document_with_diagnostics(&state, &key, stored))
    }

    pub async fn get_snapshot(
        &self,
        project_ids: &[String],
    ) -> Result<ConfigSnapshot, ConfigApiError> {
        // A snapshot must not observe a registration with only some documents loaded.
        let _registration = self
            .lock_and_discover_project_documents(project_ids)
            .await?;
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
            .map(|(key, stored)| document_with_diagnostics(&state, key, stored))
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
        .then(|| self.mcp_runtime_authority.write());
        let _reference_guard = match _reference_guard {
            Some(guard) => Some(guard.await),
            None => None,
        };
        let key = DocumentKey {
            kind: request.kind,
            scope: request.scope.clone(),
        };
        let _project = self.lock_project_access(&key.scope).await?;
        let lock = self.document_lock(&key).await;
        let _guard = lock.lock().await;
        if let ConfigScope::Project { project_id } = &key.scope {
            self.require_current_project_root(project_id).await?;
        }

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
        let _runtime_guards = lock_project_runtime_files(self.root(), &key).await?;
        if let ConfigScope::Project { project_id } = &key.scope {
            self.require_current_project_root(project_id).await?;
        }
        let project_root = self.pending_root_binding(&key.scope).await?;
        let (approved, disk_pending) = self.read_runtime_state(&key, project_root.as_ref()).await?;
        if let ConfigScope::Project { project_id } = &key.scope {
            self.require_current_project_root(project_id).await?;
        }
        // A retained cleanup file is not a new request for consent.
        let disk_pending =
            disk_pending.filter(|pending| pending.pending.proposed_document != approved);
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
            self.pending_root_binding(&key.scope).await?;
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
            project_root,
            last_root_transition: None,
            approved_etag: etag(&approved),
            all_changed_paths: changed_paths.clone(),
            apply_modes: apply_modes.iter().map(|mode| (*mode).to_string()).collect(),
        });
        let durable_publication = (!needs_approval).then(|| DurableConfigPublication {
            document: request.kind,
            scope: request.scope.clone(),
            previous_document: approved.clone(),
            previous_etag: etag(&approved),
            proposed_etag: new_etag.clone(),
        });
        let pending_path = pending_document_path(self.root(), &key);
        let approved_path = approved_document_path(self.root(), &key);
        let publication_path = publication_document_path(self.root(), &key);
        if let Some(pending) = &durable_pending {
            write_durable_pending(&pending_path, pending)?;
        }
        if let Some(publication) = &durable_publication {
            write_durable_config_publication(&publication_path, publication)?;
        }
        if let Err(error) = atomic_write_json_locked(&stored.path, &proposed) {
            if let Some(publication) = &durable_publication {
                rollback_config_publication(self.root(), &key, &stored.path, publication).map_err(
                    |cleanup_error| {
                        ConfigApiError::new(
                            "config.document.write_failed_with_publication_rollback_failed",
                            format!(
                                "Impossible d’écrire {} : {error}. La publication préparée n’a pas pu être compensée : {}",
                                stored.path.display(), cleanup_error.message
                            ),
                        )
                    },
                )?;
            } else if durable_pending.is_some() {
                remove_file_if_exists(&pending_path).map_err(|cleanup_error| {
                    ConfigApiError::new(
                        "config.document.write_failed_with_pending_cleanup_failed",
                        format!(
                            "Impossible d’écrire {} : {error}. La demande sensible préparée n’a pas pu être retirée : {}",
                            stored.path.display(), cleanup_error.message
                        ),
                    )
                })?;
            }
            return Err(ConfigApiError::new(
                "config.document.write_failed",
                format!("Impossible d’écrire {} : {error}", stored.path.display()),
            ));
        }
        if let Some(publication) = &durable_publication {
            let publication_result = write_approved_document(&approved_path, &proposed, &key.scope)
                .map_err(|error| {
                    ConfigApiError::new(
                        "config.approved.write_failed",
                        format!("Impossible de promouvoir la configuration : {error}"),
                    )
                })
                .and_then(|()| remove_file_if_exists(&pending_path))
                .and_then(|()| remove_file_if_exists(&publication_path));
            if let Err(error) = publication_result {
                rollback_config_publication(self.root(), &key, &stored.path, publication).map_err(
                    |rollback_error| {
                        ConfigApiError::new(
                            "config.publication.failed_with_rollback_failed",
                            format!(
                                "{} La compensation durable a aussi échoué : {}",
                                error.message, rollback_error.message
                            ),
                        )
                    },
                )?;
                return Err(error);
            }
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
        .then(|| self.mcp_runtime_authority.write());
        let _reference_guard = match _reference_guard {
            Some(guard) => Some(guard.await),
            None => None,
        };
        let key = DocumentKey { kind, scope };
        let _project = self.lock_project_access(&key.scope).await?;
        let lock = self.document_lock(&key).await;
        let _guard = lock.lock().await;
        if let ConfigScope::Project { project_id } = &key.scope {
            self.require_current_project_root(project_id).await?;
        }

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
        let _runtime_guards = lock_project_runtime_files(self.root(), &key).await?;
        if let ConfigScope::Project { project_id } = &key.scope {
            self.require_current_project_root(project_id).await?;
        }
        let project_root = self.pending_root_binding(&key.scope).await?;
        let (approved, disk_pending) = self.read_runtime_state(&key, project_root.as_ref()).await?;
        if let ConfigScope::Project { project_id } = &key.scope {
            self.require_current_project_root(project_id).await?;
        }
        // A retained cleanup file is not a new request for consent.
        let disk_pending =
            disk_pending.filter(|pending| pending.pending.proposed_document != approved);

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
            self.pending_root_binding(&key.scope).await?;
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
            project_root,
            last_root_transition: None,
            approved_etag: etag(&approved),
            all_changed_paths: changed_paths.clone(),
            apply_modes: apply_modes.iter().map(|mode| (*mode).to_string()).collect(),
        });
        let pending_path = pending_document_path(self.root(), &key);
        let approved_path = approved_document_path(self.root(), &key);
        if let Some(pending) = &durable_pending {
            write_durable_pending(&pending_path, pending)?;
        } else {
            write_runtime_json(&approved_path, &proposed, &key.scope).map_err(|error| {
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

    // Disk may have been rewritten by another process or an older application.
    // Synchronize consent IDs before returning a conflict to the caller, so the
    // replacement proposal is available without another registration or reload.
    async fn read_runtime_state(
        &self,
        key: &DocumentKey,
        project_root: Option<&PendingRootBinding>,
    ) -> Result<(Value, Option<DurablePendingSensitiveChange>), ConfigApiError> {
        let (approved, pending) = read_runtime_state(self.root(), key, project_root)?;
        let active_pending = pending
            .as_ref()
            .filter(|pending| pending.pending.proposed_document != approved);
        if active_pending.is_some() {
            let mut state = self.state.write().await;
            state.pending_changes.retain(|_, pending| {
                pending.pending.document != key.kind || pending.pending.scope != key.scope
            });
            if let Some(pending) = active_pending {
                state
                    .pending_changes
                    .insert(pending.pending.id.clone(), pending.clone());
            }
        }
        Ok((approved, pending))
    }

    pub async fn accept_pending_change(&self, id: &str) -> Result<ConfigDocument, ConfigApiError> {
        let _reference_guard = self.mcp_runtime_authority.write().await;
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
        let _project = self.lock_project_access(&key.scope).await?;
        let local_lock = self.document_lock(&key).await;
        let _local_guard = local_lock.lock().await;
        if let ConfigScope::Project { project_id } = &key.scope {
            self.require_current_project_root(project_id).await?;
        }

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
        let _runtime_guards = lock_project_runtime_files(self.root(), &key).await?;
        if let ConfigScope::Project { project_id } = &key.scope {
            self.require_current_project_root(project_id).await?;
        }
        let project_root = self.pending_root_binding(&key.scope).await?;
        let (approved, disk_pending) = self.read_runtime_state(&key, project_root.as_ref()).await?;
        if let ConfigScope::Project { project_id } = &key.scope {
            self.require_current_project_root(project_id).await?;
        }
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
        let approved_matches_proposal = approved == durable.pending.proposed_document
            && etag(&approved) == durable.pending.proposed_etag;
        if !approved_matches_proposal && etag(&approved) != durable.approved_etag {
            return Err(ConfigApiError::new(
                "config.pending.baseline_conflict",
                "La copie approuvée a changé depuis la demande d’approbation.",
            ));
        }
        if !approved_matches_proposal {
            let approved_path = approved_document_path(self.root(), &key);
            write_runtime_json(
                &approved_path,
                &durable.pending.proposed_document,
                &key.scope,
            )
            .map_err(|error| {
                ConfigApiError::new(
                    "config.approved.write_failed",
                    format!("Impossible de promouvoir la configuration approuvée : {error}"),
                )
            })?;
        }
        let cleanup_diagnostic =
            cleanup_committed_pending(&pending_document_path(self.root(), &key), &key);

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
        stored.diagnostics.extend(cleanup_diagnostic);
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
        let _reference_guard = self.mcp_runtime_authority.write().await;
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
        let _project = self.lock_project_access(&key.scope).await?;
        let lock = self.document_lock(&key).await;
        let _guard = lock.lock().await;
        if let ConfigScope::Project { project_id } = &key.scope {
            self.require_current_project_root(project_id).await?;
        }

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
        let _runtime_guards = lock_project_runtime_files(self.root(), &key).await?;
        if let ConfigScope::Project { project_id } = &key.scope {
            self.require_current_project_root(project_id).await?;
        }
        let project_root = self.pending_root_binding(&key.scope).await?;
        let (approved, disk_pending) = self.read_runtime_state(&key, project_root.as_ref()).await?;
        if let ConfigScope::Project { project_id } = &key.scope {
            self.require_current_project_root(project_id).await?;
        }
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
        let state = self.state.read().await;
        state
            .pending_changes
            .values()
            .filter(|pending| match &pending.pending.scope {
                ConfigScope::User => true,
                ConfigScope::Project { project_id } => {
                    !state.project_transitions.contains_key(project_id)
                        && matches!(read_project_transition(self.root(), project_id), Ok(None))
                }
            })
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
        let mut outcomes = Vec::new();
        for project_id in &project_ids {
            if let Err(error) = self
                .lock_and_discover_project_documents(std::slice::from_ref(project_id))
                .await
            {
                outcomes.push(Err(error));
            }
        }
        let keys = self
            .state
            .read()
            .await
            .documents
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        outcomes.reserve(keys.len());
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
        let _project = self.lock_project_access(scope).await?;
        if let ConfigScope::Project { project_id } = scope {
            self.require_current_project_root(project_id).await?;
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

fn publication_document_path(root: &Path, key: &DocumentKey) -> PathBuf {
    root.join(".runtime")
        .join("publications")
        .join(runtime_scope_key(&key.scope))
        .join(key.kind.file_name())
}

// These replace the unreleased per-document root-renewal journals. Publication
// journals still recover document writes. No shipped root-renewal format needs a
// migration; development fixtures must be recreated when changing this protocol.
fn project_transition_path(root: &Path, project_id: &str) -> PathBuf {
    root.join(".runtime")
        .join("project-transitions")
        .join(format!("{project_id}.json"))
}

// A preliminary read records a known rebind even if the project gate is blocked.
// The same check is repeated under that gate; errors are diagnosed for every
// proposal only after a durable intent exists.
fn project_pending_needs_transition(
    root: &Path,
    project_id: &str,
    target: Option<&PendingRootBinding>,
) -> bool {
    let scope = ConfigScope::Project {
        project_id: project_id.to_string(),
    };
    ConfigDocumentKind::ALL
        .into_iter()
        .filter(|kind| kind.supports_project_scope())
        .any(|kind| {
            let key = DocumentKey {
                kind,
                scope: scope.clone(),
            };
            match read_durable_pending(&pending_document_path(root, &key)) {
                Ok(pending) => {
                    pending.is_some_and(|pending| pending.project_root.as_ref() != target)
                }
                Err(_) => true,
            }
        })
}

fn runtime_file_exists(path: &Path) -> Result<bool, ConfigApiError> {
    path.try_exists().map_err(|error| {
        ConfigApiError::new(
            "config.runtime.read_failed",
            format!("Impossible de vérifier {} : {error}", path.display()),
        )
    })
}

fn read_project_transition(
    root: &Path,
    project_id: &str,
) -> Result<Option<DurableProjectRootTransition>, ConfigApiError> {
    let path = project_transition_path(root, project_id);
    if !runtime_file_exists(&path)? {
        return Ok(None);
    }
    let value = read_json_value(&path)?;
    // Missing `target` is corruption, not an observed absence.
    if value.get("target").is_none() {
        return Err(ConfigApiError::new(
            "config.project.transition.invalid",
            "La cible de transition est absente.",
        ));
    }
    let intent: DurableProjectRootTransition = serde_json::from_value(value).map_err(|error| {
        ConfigApiError::new(
            "config.project.transition.invalid",
            format!("L’intention de transition est invalide : {error}"),
        )
    })?;
    if intent.project_id != project_id
        || Uuid::parse_str(&intent.id).is_err()
        || intent
            .target
            .as_ref()
            .is_some_and(|target| !target.path.is_absolute())
    {
        return Err(ConfigApiError::new(
            "config.project.transition.invalid",
            "L’intention ne correspond pas au projet ou à une racine absolue.",
        ));
    }
    Ok(Some(intent))
}

// Caller owns the project gate. A failed write is never a successful transition,
// including a failure before any proposal has been visited.
fn write_project_transition(
    path: &Path,
    intent: &DurableProjectRootTransition,
) -> Result<(), ConfigApiError> {
    #[cfg(test)]
    if path.with_extension("fail-write").exists() {
        return Err(ConfigApiError::new(
            "config.project.transition.write_failed",
            "Échec injecté pendant l’écriture de l’intention projet.",
        ));
    }
    let value = serde_json::to_value(intent).map_err(|error| {
        ConfigApiError::new("config.project.transition.invalid", error.to_string())
    })?;
    let persist = || -> Result<(), String> {
        atomic_write_json_locked(path, &value)?;
        // The intent directory can be new. Persist its entry in .runtime and
        // .runtime's entry in the existing config root before acknowledging it.
        let runtime = path
            .parent()
            .and_then(Path::parent)
            .expect("private runtime directory");
        sync_parent_directory(runtime)?;
        sync_parent_directory(runtime.parent().expect("configuration root"))
    };
    persist()
        .map_err(|message| ConfigApiError::new("config.project.transition.write_failed", message))
}

fn acknowledge_project_transition(
    path: &Path,
    key: &DocumentKey,
    intent: &DurableProjectRootTransition,
) -> Result<(), ConfigApiError> {
    let Some(mut pending) = read_durable_pending(path)? else {
        return Ok(());
    };
    require_pending_document(key, Some(&pending))?;
    let validation = validate_document(key.kind, &key.scope, &pending.pending.proposed_document);
    if !validation.valid
        || validation.read_only
        || etag(&pending.pending.proposed_document) != pending.pending.proposed_etag
    {
        return Err(ConfigApiError::new(
            "config.pending.invalid",
            "La proposition à renouveler est invalide. Elle est conservée pour diagnostic.",
        )
        .with_diagnostics(validation.diagnostics));
    }
    if pending.last_root_transition.as_deref() == Some(intent.id.as_str()) {
        if pending.project_root != intent.target {
            return Err(ConfigApiError::new(
                "config.project.transition.ack_conflict",
                "L’acquittement ne correspond pas à la cible de transition.",
            ));
        }
        // A previous rename may have succeeded before its directory fsync failed.
        return sync_parent_directory(path.parent().expect("pending directory"))
            .map_err(|message| ConfigApiError::new("config.pending.write_failed", message));
    }
    pending.pending.id = Uuid::new_v4().to_string();
    pending.pending.created_at = Utc::now().to_rfc3339();
    pending.project_root = intent.target.clone();
    pending.last_root_transition = Some(intent.id.clone());
    write_durable_pending(path, &pending)
}

fn project_transition_errors(
    scope: &ConfigScope,
    errors: Vec<(ConfigDocumentKind, ConfigApiError)>,
) -> ConfigApiError {
    let code = if errors.len() == 1 {
        errors[0].1.code.as_str()
    } else {
        "config.project.transition_incomplete"
    };
    let message = errors
        .iter()
        .map(|(kind, error)| format!("{} : {}", kind.file_name(), error.message))
        .collect::<Vec<_>>()
        .join(" ");
    let diagnostics = errors
        .iter()
        .flat_map(|(kind, error)| {
            std::iter::once(ConfigDiagnostic {
                document: *kind,
                scope: scope.clone(),
                path: None,
                code: error.code.clone(),
                message: error.message.clone(),
                severity: "error".into(),
            })
            .chain(error.diagnostics.clone())
        })
        .collect();
    ConfigApiError::new(code, message).with_diagnostics(diagnostics)
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
    if !runtime_file_exists(path)? {
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
    project_root: Option<&PendingRootBinding>,
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

    let pending_path = pending_document_path(root, key);
    let pending = read_durable_pending(&pending_path)?;
    require_pending_document(key, pending.as_ref())?;
    require_pending_root_binding(pending.as_ref(), project_root)?;
    Ok((approved, pending))
}

fn require_pending_document(
    key: &DocumentKey,
    pending: Option<&DurablePendingSensitiveChange>,
) -> Result<(), ConfigApiError> {
    if pending.is_some_and(|pending| {
        pending.pending.document != key.kind || pending.pending.scope != key.scope
    }) {
        return Err(ConfigApiError::new(
            "config.pending.invalid",
            "La modification sensible persistée ne correspond pas au document verrouillé.",
        ));
    }
    Ok(())
}

fn pending_value(pending: &DurablePendingSensitiveChange) -> Result<Value, ConfigApiError> {
    serde_json::to_value(pending).map_err(|error| {
        ConfigApiError::new(
            "config.pending.serialize_failed",
            format!("Impossible de sérialiser la demande sensible : {error}"),
        )
    })
}

fn require_pending_root_binding(
    pending: Option<&DurablePendingSensitiveChange>,
    project_root: Option<&PendingRootBinding>,
) -> Result<(), ConfigApiError> {
    if pending.is_some_and(|pending| pending.project_root.as_ref() != project_root) {
        return Err(ConfigApiError::new(
            "config.project.transition_required",
            "La liaison de la proposition nécessite une transition du projet avant utilisation.",
        ));
    }
    Ok(())
}

fn write_durable_pending(
    path: &Path,
    pending: &DurablePendingSensitiveChange,
) -> Result<(), ConfigApiError> {
    #[cfg(test)]
    if path.with_extension("fail-write").exists() {
        return Err(ConfigApiError::new(
            "config.pending.write_failed",
            "Échec injecté pendant l’écriture de la demande sensible.",
        ));
    }
    let value = pending_value(pending)?;
    write_runtime_json(path, &value, &pending.pending.scope).map_err(|error| {
        ConfigApiError::new(
            "config.pending.write_failed",
            format!("Impossible de conserver la demande sensible : {error}"),
        )
    })
}

fn read_durable_config_publication(
    path: &Path,
) -> Result<Option<DurableConfigPublication>, ConfigApiError> {
    if !path.exists() {
        return Ok(None);
    }
    let value = read_json_value(path)?;
    serde_json::from_value(value).map(Some).map_err(|error| {
        ConfigApiError::new(
            "config.publication.invalid",
            format!("Le journal de publication est invalide : {error}"),
        )
    })
}

fn write_durable_config_publication(
    path: &Path,
    publication: &DurableConfigPublication,
) -> Result<(), ConfigApiError> {
    let value = serde_json::to_value(publication).map_err(|error| {
        ConfigApiError::new(
            "config.publication.serialize_failed",
            format!("Impossible de sérialiser le journal de publication : {error}"),
        )
    })?;
    write_runtime_json(path, &value, &publication.scope).map_err(|error| {
        ConfigApiError::new(
            "config.publication.write_failed",
            format!("Impossible de préparer la publication de configuration : {error}"),
        )
    })
}

fn rollback_config_publication(
    root: &Path,
    key: &DocumentKey,
    canonical_path: &Path,
    publication: &DurableConfigPublication,
) -> Result<(), ConfigApiError> {
    if publication.document != key.kind
        || publication.scope != key.scope
        || etag(&publication.previous_document) != publication.previous_etag
    {
        return Err(ConfigApiError::new(
            "config.publication.invalid",
            "Le journal de publication ne correspond pas au document verrouillé.",
        ));
    }
    let validation = validate_document(key.kind, &key.scope, &publication.previous_document);
    if !validation.valid || validation.read_only {
        return Err(ConfigApiError::new(
            "config.publication.invalid",
            "La version de restauration du journal n’est pas valide.",
        )
        .with_diagnostics(validation.diagnostics));
    }

    let current_document = read_json_value(canonical_path)?;
    let current_etag = etag(&current_document);
    if current_etag != publication.previous_etag && current_etag != publication.proposed_etag {
        return Err(ConfigApiError::new(
            "config.publication.conflict",
            "Le document canonique a changé depuis la publication interrompue. Macro conserve cette version et le journal pour une récupération explicite.",
        ));
    }

    let approved_path = approved_document_path(root, key);
    let approved_etag = etag(&read_json_value(&approved_path)?);
    if approved_etag != publication.previous_etag && approved_etag != publication.proposed_etag {
        return Err(ConfigApiError::new(
            "config.publication.conflict",
            "La copie approuvée a changé depuis la publication interrompue. Macro conserve cette version et le journal pour une récupération explicite.",
        ));
    }

    #[cfg(test)]
    if canonical_path.with_extension("fail-rollback").exists() {
        return Err(ConfigApiError::new(
            "config.publication.rollback_failed",
            "Échec injecté pendant la compensation de publication.",
        ));
    }
    if current_etag != publication.previous_etag {
        atomic_write_json_locked(canonical_path, &publication.previous_document).map_err(
            |error| {
                ConfigApiError::new(
                    "config.publication.rollback_failed",
                    format!("Impossible de restaurer le document canonique : {error}"),
                )
            },
        )?;
    }
    #[cfg(test)]
    if canonical_path
        .with_extension("fail-rollback-after-canonical")
        .exists()
    {
        return Err(ConfigApiError::new(
            "config.publication.rollback_failed",
            "Interruption injectée après la restauration du document canonique.",
        ));
    }
    // Both files must be restored before deleting the recovery journal, even
    // when an earlier attempt already restored the canonical document.
    if approved_etag != publication.previous_etag {
        write_runtime_json(&approved_path, &publication.previous_document, &key.scope).map_err(
            |error| {
                ConfigApiError::new(
                    "config.publication.rollback_failed",
                    format!("Impossible de restaurer la copie approuvée : {error}"),
                )
            },
        )?;
    }
    remove_file_if_exists(&publication_document_path(root, key))
}

fn recover_config_publication(
    root: &Path,
    key: &DocumentKey,
    canonical_path: &Path,
) -> Result<(), ConfigApiError> {
    let publication_path = publication_document_path(root, key);
    let Some(publication) = read_durable_config_publication(&publication_path)? else {
        return Ok(());
    };
    rollback_config_publication(root, key, canonical_path, &publication)
}

fn write_approved_document(path: &Path, value: &Value, scope: &ConfigScope) -> Result<(), String> {
    #[cfg(test)]
    if path.with_extension("fail-write-once").exists() {
        let _ = fs::remove_file(path.with_extension("fail-write-once"));
        return Err("Échec injecté pendant l’écriture de la copie approuvée.".to_string());
    }
    write_runtime_json(path, value, scope)
}

fn remove_file_if_exists(path: &Path) -> Result<(), ConfigApiError> {
    #[cfg(test)]
    if path.with_extension("fail-remove").exists() {
        return Err(ConfigApiError::new(
            "config.runtime.remove_failed",
            "Échec injecté pendant la suppression du journal runtime.",
        ));
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(ConfigApiError::new(
            "config.runtime.remove_failed",
            format!("Impossible de supprimer {} : {error}", path.display()),
        )),
    }
}

// The approved file is the commit point. Cleanup failure cannot undo consent
// already persisted; retain the pending file for cleanup during the next load.
fn cleanup_committed_pending(path: &Path, key: &DocumentKey) -> Option<ConfigDiagnostic> {
    remove_file_if_exists(path).err().map(|error| ConfigDiagnostic {
        document: key.kind,
        scope: key.scope.clone(),
        path: None,
        code: "config.pending.cleanup_deferred".to_string(),
        message: format!("La configuration est enregistrée. Le nettoyage sera repris au prochain chargement : {}", error.message),
        severity: "warning".to_string(),
    })
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

// Shared across canonical root paths for the same project/document. All project
// proposal readers and writers hold this after the optional root-document lock.
async fn lock_project_pending_file(
    root: &Path,
    key: &DocumentKey,
) -> Result<Option<DocumentFileLock>, ConfigApiError> {
    if matches!(key.scope, ConfigScope::Project { .. }) {
        // The transaction serializes consent journals across canonical roots.
        // Its distinct path also allows pre-acquiring the publication file locks.
        lock_document_file_async(pending_document_path(root, key).with_extension("transaction"))
            .await
            .map(Some)
    } else {
        Ok(None)
    }
}

// Acquire every project publication lock asynchronously before the caller's final
// identity check. Runtime writers then publish without acquiring another lock.
async fn lock_project_runtime_files(
    root: &Path,
    key: &DocumentKey,
) -> Result<Vec<DocumentFileLock>, ConfigApiError> {
    let mut guards = Vec::new();
    if let Some(transaction) = lock_project_pending_file(root, key).await? {
        guards.push(transaction);
        for path in [
            approved_document_path(root, key),
            pending_document_path(root, key),
            publication_document_path(root, key),
        ] {
            guards.push(lock_document_file_async(path).await?);
        }
    }
    Ok(guards)
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

fn runtime_document_with_diagnostics(state: &ConfigState) -> ConfigDocument {
    let key = DocumentKey {
        kind: ConfigDocumentKind::Runtime,
        scope: ConfigScope::User,
    };
    document_with_diagnostics(
        state,
        &key,
        state
            .documents
            .get(&key)
            .expect("initialized runtime document"),
    )
}

fn document_with_diagnostics(
    state: &ConfigState,
    key: &DocumentKey,
    stored: &StoredDocument,
) -> ConfigDocument {
    let mut document = to_document(key, stored);
    if key.kind == ConfigDocumentKind::Runtime && key.scope == ConfigScope::User {
        document
            .diagnostics
            .extend(state.reconciliation_diagnostic.clone());
        document
            .diagnostics
            .extend(state.maintenance_diagnostic.clone());
    }
    document
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

// Project callers hold lock_project_runtime_files; user callers retain the
// original independent per-file publication lock.
fn write_runtime_json(path: &Path, value: &Value, scope: &ConfigScope) -> Result<(), String> {
    if matches!(scope, ConfigScope::Project { .. }) {
        atomic_write_json_locked(path, value)
    } else {
        atomic_write_json(path, value)
    }
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
    async fn non_sensitive_patch_rolls_back_when_approved_publication_fails() {
        let (_temp, manager) = manager().await;
        let document = manager
            .get_document(ConfigDocumentKind::Settings, ConfigScope::User)
            .await
            .expect("settings");
        let canonical_path = PathBuf::from(&document.file_path);
        let key = DocumentKey {
            kind: ConfigDocumentKind::Settings,
            scope: ConfigScope::User,
        };
        let approved_path = approved_document_path(manager.root(), &key);
        let previous = read_json_value(&canonical_path).expect("previous canonical document");
        fs::write(approved_path.with_extension("fail-write-once"), b"fail")
            .expect("inject approved publication failure");

        let error = manager
            .apply_patch(ConfigPatchRequest {
                kind: ConfigDocumentKind::Settings,
                scope: ConfigScope::User,
                expected_etag: document.etag,
                patch: vec![JsonPatchOperation {
                    op: "add".to_string(),
                    path: "/language".to_string(),
                    from: None,
                    value: Some(json!("fr")),
                }],
                source: ConfigChangeSource::UserInterface,
            })
            .await
            .expect_err("approved publication must fail");

        assert_eq!(error.code, "config.approved.write_failed");
        assert_eq!(
            read_json_value(&canonical_path).expect("rolled back canonical"),
            previous
        );
        assert_eq!(
            read_json_value(&approved_path).expect("rolled back approved"),
            previous
        );
        assert!(!publication_document_path(manager.root(), &key).exists());
    }

    #[tokio::test]
    async fn failed_non_sensitive_compensation_recovers_from_its_durable_journal() {
        let (_temp, manager) = manager().await;
        let root = manager.root().to_path_buf();
        let document = manager
            .get_document(ConfigDocumentKind::Settings, ConfigScope::User)
            .await
            .expect("settings");
        let canonical_path = PathBuf::from(&document.file_path);
        let key = DocumentKey {
            kind: ConfigDocumentKind::Settings,
            scope: ConfigScope::User,
        };
        let approved_path = approved_document_path(manager.root(), &key);
        let publication_path = publication_document_path(manager.root(), &key);
        let previous = read_json_value(&canonical_path).expect("previous canonical document");
        fs::write(approved_path.with_extension("fail-write-once"), b"fail")
            .expect("inject approved publication failure");
        let rollback_failure = canonical_path.with_extension("fail-rollback");
        fs::write(&rollback_failure, b"fail").expect("inject rollback failure");

        let error = manager
            .apply_patch(ConfigPatchRequest {
                kind: ConfigDocumentKind::Settings,
                scope: ConfigScope::User,
                expected_etag: document.etag,
                patch: vec![JsonPatchOperation {
                    op: "add".to_string(),
                    path: "/language".to_string(),
                    from: None,
                    value: Some(json!("fr")),
                }],
                source: ConfigChangeSource::UserInterface,
            })
            .await
            .expect_err("publication and compensation must fail");

        assert_eq!(error.code, "config.publication.failed_with_rollback_failed");
        assert!(publication_path.exists());
        assert_eq!(
            read_json_value(&canonical_path).expect("uncompensated canonical")["language"],
            json!("fr")
        );

        fs::remove_file(rollback_failure).expect("release rollback");
        drop(manager);
        let restarted = ConfigManager::initialize(root)
            .await
            .expect("recover publication");

        assert_eq!(
            read_json_value(&canonical_path).expect("recovered canonical"),
            previous
        );
        assert_eq!(
            read_json_value(&approved_path).expect("recovered approved"),
            previous
        );
        assert!(!publication_path.exists());
        let recovered = restarted
            .get_document(ConfigDocumentKind::Settings, ConfigScope::User)
            .await
            .expect("recovered settings");
        assert_eq!(recovered.value, previous);
    }

    #[tokio::test]
    async fn interrupted_compensation_restores_approved_before_removing_journal() {
        let (_temp, manager) = manager().await;
        let root = manager.root().to_path_buf();
        let document = manager
            .get_document(ConfigDocumentKind::Tools, ConfigScope::User)
            .await
            .expect("tools");
        let canonical_path = PathBuf::from(&document.file_path);
        let key = DocumentKey {
            kind: ConfigDocumentKind::Tools,
            scope: ConfigScope::User,
        };
        let approved_path = approved_document_path(&root, &key);
        let publication_path = publication_document_path(&root, &key);
        let previous = read_json_value(&approved_path).expect("previous approved");
        let cleanup_failure = pending_document_path(&root, &key).with_extension("fail-remove");
        let interruption = canonical_path.with_extension("fail-rollback-after-canonical");
        fs::create_dir_all(cleanup_failure.parent().expect("pending directory"))
            .expect("create pending directory");
        fs::write(&cleanup_failure, b"fail").expect("inject cleanup failure");
        fs::write(&interruption, b"fail").expect("interrupt compensation");
        let error = manager
            .apply_patch(ConfigPatchRequest {
                kind: ConfigDocumentKind::Tools,
                scope: ConfigScope::User,
                expected_etag: document.etag,
                patch: vec![JsonPatchOperation {
                    op: "add".into(),
                    path: "/riskLevel".into(),
                    from: None,
                    value: Some(json!("strict")),
                }],
                source: ConfigChangeSource::UserInterface,
            })
            .await
            .expect_err("interrupted compensation");
        assert_eq!(error.code, "config.publication.failed_with_rollback_failed");
        assert_eq!(
            read_json_value(&canonical_path).expect("canonical restored"),
            previous
        );
        assert_eq!(
            read_json_value(&approved_path).expect("approved not yet restored")["riskLevel"],
            json!("strict")
        );
        assert!(publication_path.exists());
        fs::remove_file(cleanup_failure).expect("release cleanup failure");
        fs::remove_file(interruption).expect("release interruption");
        drop(manager);
        let restarted = ConfigManager::initialize(root)
            .await
            .expect("resume compensation");
        assert_eq!(
            read_json_value(&canonical_path).expect("canonical"),
            previous
        );
        assert_eq!(read_json_value(&approved_path).expect("approved"), previous);
        assert!(!publication_path.exists());
        assert!(restarted.list_pending_changes().await.is_empty());
        assert_eq!(
            restarted
                .get_snapshot(&[])
                .await
                .expect("snapshot")
                .effective["tools"]["riskLevel"],
            json!("balanced")
        );
    }

    #[tokio::test]
    async fn interrupted_publication_never_overwrites_a_divergent_document_on_restart() {
        let (_temp, manager) = manager().await;
        let root = manager.root().to_path_buf();
        let document = manager
            .get_document(ConfigDocumentKind::Settings, ConfigScope::User)
            .await
            .expect("settings");
        let canonical_path = PathBuf::from(&document.file_path);
        let key = DocumentKey {
            kind: ConfigDocumentKind::Settings,
            scope: ConfigScope::User,
        };
        let approved_path = approved_document_path(manager.root(), &key);
        let publication_path = publication_document_path(manager.root(), &key);
        fs::write(approved_path.with_extension("fail-write-once"), b"fail")
            .expect("inject approved publication failure");
        let rollback_failure = canonical_path.with_extension("fail-rollback");
        fs::write(&rollback_failure, b"fail").expect("inject rollback failure");

        manager
            .apply_patch(ConfigPatchRequest {
                kind: ConfigDocumentKind::Settings,
                scope: ConfigScope::User,
                expected_etag: document.etag,
                patch: vec![JsonPatchOperation {
                    op: "add".to_string(),
                    path: "/language".to_string(),
                    from: None,
                    value: Some(json!("fr")),
                }],
                source: ConfigChangeSource::UserInterface,
            })
            .await
            .expect_err("publication and compensation must fail");
        fs::remove_file(rollback_failure).expect("release rollback");

        let divergent = json!({ "language": "de" });
        atomic_write_json_locked(&canonical_path, &divergent).expect("write divergent document");
        drop(manager);

        let error = match ConfigManager::initialize(root).await {
            Ok(_) => panic!("divergent recovery must stop"),
            Err(error) => error,
        };
        assert_eq!(error.code, "config.publication.conflict");
        assert_eq!(
            read_json_value(&canonical_path).expect("preserved divergent document"),
            divergent
        );
        assert!(publication_path.exists());
    }

    #[tokio::test]
    async fn builtin_provider_overrides_remain_valid_after_default_values_are_stripped() {
        let (_temp, manager) = manager().await;
        let document = manager
            .get_document(ConfigDocumentKind::Providers, ConfigScope::User)
            .await
            .expect("providers");

        let result = manager
            .apply_patch(ConfigPatchRequest {
                kind: ConfigDocumentKind::Providers,
                scope: ConfigScope::User,
                expected_etag: document.etag,
                patch: vec![
                    JsonPatchOperation {
                        op: "add".to_string(),
                        path: "/providers".to_string(),
                        from: None,
                        value: Some(json!({})),
                    },
                    JsonPatchOperation {
                        op: "add".to_string(),
                        path: "/providers/openai".to_string(),
                        from: None,
                        value: Some(json!({
                            "providerType": "openai",
                            "name": "OpenAI",
                            "enabled": true,
                            "baseUrl": "https://api.openai.com/v1",
                            "isLocal": false
                        })),
                    },
                ],
                source: ConfigChangeSource::UserInterface,
            })
            .await
            .expect("activate built-in provider");

        assert_eq!(
            result.document.value.pointer("/providers/openai"),
            Some(&json!({ "enabled": true }))
        );
        assert_eq!(
            manager
                .effective_user_document(ConfigDocumentKind::Providers)
                .await
                .pointer("/providers/openai/providerType"),
            Some(&json!("openai"))
        );
    }

    #[tokio::test]
    async fn builtin_provider_deletion_tombstones_remain_valid_sparse_overrides() {
        let (_temp, manager) = manager().await;
        let document = manager
            .get_document(ConfigDocumentKind::Providers, ConfigScope::User)
            .await
            .expect("providers");

        let result = manager
            .apply_patch(ConfigPatchRequest {
                kind: ConfigDocumentKind::Providers,
                scope: ConfigScope::User,
                expected_etag: document.etag,
                patch: vec![
                    JsonPatchOperation {
                        op: "add".to_string(),
                        path: "/providers".to_string(),
                        from: None,
                        value: Some(json!({})),
                    },
                    JsonPatchOperation {
                        op: "add".to_string(),
                        path: "/providers/openai".to_string(),
                        from: None,
                        value: Some(json!({ "deleted": true })),
                    },
                ],
                source: ConfigChangeSource::UserInterface,
            })
            .await
            .expect("delete built-in provider");

        assert_eq!(
            result.document.value.pointer("/providers/openai"),
            Some(&json!({ "deleted": true }))
        );
        let effective = manager
            .effective_user_document(ConfigDocumentKind::Providers)
            .await;
        assert_eq!(
            effective.pointer("/providers/openai/providerType"),
            Some(&json!("openai"))
        );
        assert_eq!(
            effective.pointer("/providers/openai/deleted"),
            Some(&json!(true))
        );
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
    async fn sensitive_patch_keeps_the_document_unchanged_when_pending_write_fails() {
        let (_temp, manager) = manager().await;
        let document = manager
            .get_document(ConfigDocumentKind::Tools, ConfigScope::User)
            .await
            .expect("tools");
        let document_path = PathBuf::from(&document.file_path);
        let original = fs::read(&document_path).expect("original tools document");
        let key = DocumentKey {
            kind: ConfigDocumentKind::Tools,
            scope: ConfigScope::User,
        };
        let pending_path = pending_document_path(manager.root(), &key);
        fs::create_dir_all(pending_path.parent().expect("pending parent"))
            .expect("create pending parent");
        fs::write(pending_path.with_extension("fail-write"), b"fail")
            .expect("inject pending write failure");

        let error = manager
            .apply_patch(ConfigPatchRequest {
                kind: ConfigDocumentKind::Tools,
                scope: ConfigScope::User,
                expected_etag: document.etag.clone(),
                patch: vec![JsonPatchOperation {
                    op: "add".to_string(),
                    path: "/riskLevel".to_string(),
                    from: None,
                    value: Some(json!("yolo")),
                }],
                source: ConfigChangeSource::Agent,
            })
            .await
            .expect_err("pending write must fail");

        assert_eq!(error.code, "config.pending.write_failed");
        assert_eq!(
            fs::read(&document_path).expect("unchanged document"),
            original
        );
        let current = manager
            .get_document(ConfigDocumentKind::Tools, ConfigScope::User)
            .await
            .expect("current tools document");
        assert_eq!(current.etag, document.etag);
        assert!(manager.list_pending_changes().await.is_empty());
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
    async fn accepted_sensitive_change_retries_pending_cleanup_after_promotion() {
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
            .expect("pending")
            .pending_change
            .expect("pending change");
        let key = DocumentKey {
            kind: ConfigDocumentKind::Tools,
            scope: ConfigScope::User,
        };
        let pending_path = pending_document_path(manager.root(), &key);
        let failure_marker = pending_path.with_extension("fail-remove");
        fs::write(&failure_marker, b"fail").expect("inject pending cleanup failure");

        let document = manager
            .accept_pending_change(&pending.id)
            .await
            .expect("promotion is committed despite deferred cleanup");
        assert!(document
            .diagnostics
            .iter()
            .any(|item| item.code == "config.pending.cleanup_deferred"));
        assert_eq!(
            manager.get_snapshot(&[]).await.expect("snapshot").effective["tools"]["riskLevel"],
            json!("yolo")
        );
        assert_eq!(
            read_json_value(&approved_document_path(manager.root(), &key))
                .expect("promoted baseline")["riskLevel"],
            json!("yolo")
        );
        assert!(pending_path.exists());
        assert!(manager.list_pending_changes().await.is_empty());
        let reloaded = manager
            .reload(
                ConfigDocumentKind::Tools,
                ConfigScope::User,
                ConfigChangeSource::ExternalEditor,
            )
            .await
            .expect("reload accepted document");
        assert!(reloaded.pending.is_none());
        assert!(manager.list_pending_changes().await.is_empty());

        let restarted = ConfigManager::initialize(manager.root().to_path_buf())
            .await
            .expect("restart with deferred cleanup");
        assert_eq!(
            restarted
                .get_snapshot(&[])
                .await
                .expect("restarted snapshot")
                .effective["tools"]["riskLevel"],
            json!("yolo")
        );
        assert!(restarted.list_pending_changes().await.is_empty());
        fs::remove_file(failure_marker).expect("release pending cleanup");
        let manager = ConfigManager::initialize(manager.root().to_path_buf())
            .await
            .expect("restart cleans pending file");

        assert!(!pending_path.exists());
        assert!(manager.list_pending_changes().await.is_empty());
        let snapshot = manager.get_snapshot(&[]).await.expect("snapshot");
        assert_eq!(snapshot.effective["tools"]["riskLevel"], json!("yolo"));
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
        assert!(root.starts_with(metadata.path().join("projects").canonicalize().unwrap()));
    }

    #[tokio::test]
    async fn unregister_clears_runtime_documents_and_preserves_durable_proposals() {
        let (_temp, manager) = manager().await;
        let metadata = tempfile::tempdir().unwrap();
        let root = manager
            .register_project_root("project", metadata.path().into())
            .await
            .unwrap();
        let scope = ConfigScope::Project {
            project_id: "project".into(),
        };
        let document = manager
            .get_document(ConfigDocumentKind::Tools, scope.clone())
            .await
            .unwrap();
        let result = manager
            .apply_patch(ConfigPatchRequest {
                kind: ConfigDocumentKind::Tools,
                scope: scope.clone(),
                expected_etag: document.etag,
                patch: vec![JsonPatchOperation {
                    op: "add".into(),
                    path: "/riskLevel".into(),
                    from: None,
                    value: Some(json!("strict")),
                }],
                source: ConfigChangeSource::Agent,
            })
            .await
            .unwrap();
        let pending = result.pending_change.expect("sensitive tools proposal");
        let key = DocumentKey {
            kind: ConfigDocumentKind::Tools,
            scope: scope.clone(),
        };
        let durable = pending_document_path(manager.root(), &key);
        let bytes = fs::read(&durable).unwrap();
        let document_bytes = fs::read(root.join("tools.json")).unwrap();

        manager.unregister_project_root("project").await;
        manager.unregister_project_root("project").await;
        assert!(manager.list_pending_changes().await.is_empty());
        assert_eq!(
            manager
                .get_document(ConfigDocumentKind::Tools, scope)
                .await
                .unwrap_err()
                .code,
            "config.project.not_registered"
        );
        assert_eq!(fs::read(&durable).unwrap(), bytes);
        assert_eq!(fs::read(root.join("tools.json")).unwrap(), document_bytes);
        assert!(manager
            .reload_all_changed(ConfigChangeSource::ExternalEditor)
            .await
            .iter()
            .all(Result::is_ok));
        assert!(manager
            .get_snapshot(&[])
            .await
            .unwrap()
            .documents
            .iter()
            .all(|doc| doc.scope == ConfigScope::User));

        manager
            .register_project_root("project", metadata.path().into())
            .await
            .unwrap();
        assert_eq!(manager.list_pending_changes().await[0].id, pending.id);
    }

    #[tokio::test]
    async fn moving_project_forgets_absent_documents_and_retains_other_projects() {
        let (_temp, manager) = manager().await;
        let old = tempfile::tempdir().unwrap();
        let new = tempfile::tempdir().unwrap();
        let old_root = manager
            .register_project_root("moving", old.path().into())
            .await
            .unwrap();
        manager
            .register_project_root("retained", old.path().into())
            .await
            .unwrap();
        let scope = ConfigScope::Project {
            project_id: "moving".into(),
        };
        manager
            .get_document(ConfigDocumentKind::Git, scope.clone())
            .await
            .unwrap();
        let root = manager
            .register_project_root("moving", new.path().into())
            .await
            .unwrap();
        let snapshot = manager.get_snapshot(&["moving".into()]).await.unwrap();
        assert!(snapshot.documents.iter().all(|doc| doc.scope != scope));
        assert!(old_root.join("git.json").is_file());
        assert_eq!(
            manager
                .path_for_scope(ConfigDocumentKind::Git, &scope)
                .await
                .unwrap(),
            root.join("git.json")
        );
        manager
            .retain_project_roots(&BTreeSet::from(["retained".into()]))
            .await;
        assert!(manager.get_snapshot(&["retained".into()]).await.is_ok());
        assert!(manager.get_snapshot(&["moving".into()]).await.is_err());
    }

    #[tokio::test]
    async fn unavailable_project_does_not_block_global_reload() {
        let (_temp, manager) = manager().await;
        let metadata = tempfile::tempdir().unwrap();
        let root = manager
            .register_project_root("project", metadata.path().into())
            .await
            .unwrap();
        // A directory in place of a JSON file makes discovery fail.
        fs::create_dir(root.join("git.json")).unwrap();
        let mut general = sparse_document(ConfigDocumentKind::Settings);
        general["language"] = json!("fr");
        atomic_write_json(&manager.root().join("settings.json"), &general).unwrap();
        let outcomes = manager
            .reload_all_changed(ConfigChangeSource::ExternalEditor)
            .await;
        assert!(outcomes.iter().any(Result::is_err));
        assert!(outcomes
            .iter()
            .any(
                |outcome| outcome.as_ref().is_ok_and(|outcome| outcome.document.kind
                    == ConfigDocumentKind::Settings
                    && outcome.document.scope == ConfigScope::User
                    && outcome.changed
                    && !outcome.invalid)
            ));
    }

    #[tokio::test]
    async fn replaced_directory_never_serves_cached_documents_or_accepts_old_proposals() {
        let (_temp, manager) = manager().await;
        let metadata = tempfile::tempdir().unwrap();
        let root = manager
            .register_project_root("project", metadata.path().into())
            .await
            .unwrap();
        let scope = ConfigScope::Project {
            project_id: "project".into(),
        };
        let document = manager
            .get_document(ConfigDocumentKind::Tools, scope.clone())
            .await
            .unwrap();
        let pending = manager
            .apply_patch(ConfigPatchRequest {
                kind: ConfigDocumentKind::Tools,
                scope: scope.clone(),
                expected_etag: document.etag,
                patch: vec![JsonPatchOperation {
                    op: "add".into(),
                    path: "/riskLevel".into(),
                    from: None,
                    value: Some(json!("strict")),
                }],
                source: ConfigChangeSource::Agent,
            })
            .await
            .unwrap()
            .pending_change
            .unwrap();
        let pending_path = pending_document_path(
            manager.root(),
            &DocumentKey {
                kind: ConfigDocumentKind::Tools,
                scope: scope.clone(),
            },
        );
        let durable = read_durable_pending(&pending_path).unwrap().unwrap();
        fs::rename(&root, root.with_file_name("previous-config")).unwrap();
        fs::create_dir(&root).unwrap();
        assert_eq!(
            manager
                .get_document(ConfigDocumentKind::Tools, scope)
                .await
                .unwrap_err()
                .code,
            "config.project.root_changed"
        );
        assert_eq!(
            manager
                .get_snapshot(&["project".into()])
                .await
                .unwrap_err()
                .code,
            "config.project.root_changed"
        );
        assert_eq!(
            manager
                .accept_pending_change(&pending.id)
                .await
                .unwrap_err()
                .code,
            "config.project.root_changed"
        );
        let (changed, errors) = manager.refresh_project_roots().await;
        assert!(changed);
        assert!(errors.is_empty());
        assert!(manager
            .get_snapshot(&["project".into()])
            .await
            .unwrap()
            .documents
            .iter()
            .all(|doc| doc.scope == ConfigScope::User));
        assert!(manager.list_pending_changes().await.is_empty());
        let renewed = read_durable_pending(&pending_path).unwrap().unwrap();
        assert_ne!(renewed.pending.id, durable.pending.id);
        assert_eq!(
            renewed.pending.proposed_document,
            durable.pending.proposed_document
        );
        assert_eq!(renewed.approved_etag, durable.approved_etag);
        assert!(!manager.refresh_project_roots().await.0);
    }

    #[tokio::test]
    async fn project_transaction_lock_allows_atomic_pending_publication() {
        let (_temp, manager) = manager().await;
        let key = DocumentKey {
            kind: ConfigDocumentKind::Tools,
            scope: ConfigScope::Project {
                project_id: "project".into(),
            },
        };
        let _transaction = lock_project_pending_file(manager.root(), &key)
            .await
            .unwrap();
        let path = pending_document_path(manager.root(), &key);
        // Probe non-blockingly first: a regression must fail, not hang the test runner.
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(path.with_extension("json.lock"))
            .unwrap();
        file.try_lock_exclusive()
            .expect("atomic publication lock must remain available inside the transaction");
        FileExt::unlock(&file).unwrap();
        atomic_write_json(&path, &json!({"probe": true})).unwrap();
        assert_eq!(read_json_value(&path).unwrap(), json!({"probe": true}));
    }

    async fn project_pending_pair(
        manager: &ConfigManager,
        metadata: &Path,
    ) -> (PathBuf, Vec<(DocumentKey, DurablePendingSensitiveChange)>) {
        let root = manager
            .register_project_root("project", metadata.into())
            .await
            .unwrap();
        let mut tools = sparse_document(ConfigDocumentKind::Tools);
        tools["riskLevel"] = json!("strict");
        let mut skills = sparse_document(ConfigDocumentKind::Skills);
        skills["roots"] = json!({"project-skills": {"path": ".agents/skills"}});
        atomic_write_json(&root.join("tools.json"), &tools).unwrap();
        atomic_write_json(&root.join("skills.json"), &skills).unwrap();
        manager.get_snapshot(&["project".into()]).await.unwrap();
        let pending = [ConfigDocumentKind::Tools, ConfigDocumentKind::Skills]
            .into_iter()
            .map(|kind| {
                let key = DocumentKey {
                    kind,
                    scope: ConfigScope::Project {
                        project_id: "project".into(),
                    },
                };
                let pending = read_durable_pending(&pending_document_path(manager.root(), &key))
                    .unwrap()
                    .unwrap();
                (key, pending)
            })
            .collect::<Vec<_>>();
        assert_eq!(manager.list_pending_changes().await.len(), 2);
        (root, pending)
    }

    fn assert_proposal_content_preserved(
        before: &DurablePendingSensitiveChange,
        after: &DurablePendingSensitiveChange,
    ) {
        let mut expected = before.clone();
        expected.pending.id = after.pending.id.clone();
        expected.pending.created_at = after.pending.created_at.clone();
        expected.project_root = after.project_root.clone();
        expected.last_root_transition = after.last_root_transition.clone();
        assert_eq!(
            pending_value(&expected).unwrap(),
            pending_value(after).unwrap(),
            "only binding, consent ID, timestamp and current ack may change"
        );
    }

    #[tokio::test]
    async fn empty_destination_locks_and_obsolete_renewal_journals_do_not_block_revocation() {
        for restart in [false, true] {
            let (_temp, mut manager) = manager().await;
            let metadata = tempfile::tempdir().unwrap();
            let destination = tempfile::tempdir().unwrap();
            let (root, originals) = project_pending_pair(&manager, metadata.path()).await;
            let destination_root = destination.path().join("projects/project/config");
            fs::create_dir_all(destination_root.join("tools.json.lock")).unwrap();
            // Exact obstruction from the old fallback reproduction. The unreleased
            // per-proposal journal has no role in the project transition protocol.
            fs::create_dir(
                pending_document_path(manager.root(), &originals[0].0)
                    .with_extension("root-renewal.json"),
            )
            .unwrap();
            let baselines = originals
                .iter()
                .map(|(key, _)| fs::read(approved_document_path(manager.root(), key)).unwrap())
                .collect::<Vec<_>>();
            manager
                .register_project_root("project", destination.path().into())
                .await
                .unwrap();
            assert!(!project_transition_path(manager.root(), "project").exists());
            assert!(manager.list_pending_changes().await.is_empty());
            for ((key, original), baseline) in originals.iter().zip(&baselines) {
                let renewed = read_durable_pending(&pending_document_path(manager.root(), key))
                    .unwrap()
                    .unwrap();
                assert_ne!(renewed.pending.id, original.pending.id);
                assert_proposal_content_preserved(original, &renewed);
                assert_eq!(
                    fs::read(approved_document_path(manager.root(), key)).unwrap(),
                    *baseline
                );
                assert_eq!(
                    read_json_value(&root.join(key.kind.file_name())).unwrap(),
                    original.pending.proposed_document
                );
            }
            if restart {
                manager = ConfigManager::initialize(manager.root().to_path_buf())
                    .await
                    .unwrap();
            }
            manager
                .register_project_root("project", metadata.path().into())
                .await
                .unwrap();
            for (_, original) in &originals {
                assert!(manager
                    .accept_pending_change(&original.pending.id)
                    .await
                    .is_err());
                assert!(manager
                    .reject_pending_change(&original.pending.id, true)
                    .await
                    .is_err());
            }
            for renewed in manager.list_pending_changes().await {
                manager.accept_pending_change(&renewed.id).await.unwrap();
            }
        }
    }

    #[tokio::test]
    async fn project_intent_survives_all_pending_lock_failures_and_direct_or_restart_return() {
        for restart in [false, true] {
            for first_lock in ["transaction.lock", "json.lock"] {
                for block_second in [false, true] {
                    let (_temp, mut manager) = manager().await;
                    let metadata = tempfile::tempdir().unwrap();
                    let destination = tempfile::tempdir().unwrap();
                    let (_, originals) = project_pending_pair(&manager, metadata.path()).await;
                    let paths = originals
                        .iter()
                        .map(|(key, _)| pending_document_path(manager.root(), key))
                        .collect::<Vec<_>>();
                    let baselines = originals
                        .iter()
                        .map(|(key, _)| {
                            fs::read(approved_document_path(manager.root(), key)).unwrap()
                        })
                        .collect::<Vec<_>>();
                    let first_obstruction = paths[0].with_extension(first_lock);
                    if first_obstruction.exists() {
                        fs::remove_file(&first_obstruction).unwrap();
                    }
                    fs::create_dir(&first_obstruction).unwrap();
                    let second_obstruction = paths[1].with_extension("json.lock");
                    if block_second {
                        fs::remove_file(&second_obstruction).unwrap();
                        fs::create_dir(&second_obstruction).unwrap();
                    }
                    let error = manager
                        .register_project_root("project", destination.path().into())
                        .await
                        .unwrap_err();
                    assert_eq!(error.diagnostics.len(), if block_second { 2 } else { 1 });
                    assert_eq!(error.diagnostics[0].document, ConfigDocumentKind::Tools);
                    if block_second {
                        assert_eq!(error.diagnostics[1].document, ConfigDocumentKind::Skills);
                    }
                    let intent = read_project_transition(manager.root(), "project")
                        .unwrap()
                        .unwrap();
                    assert_eq!(
                        intent.target.as_ref().unwrap().path,
                        destination
                            .path()
                            .join("projects/project/config")
                            .canonicalize()
                            .unwrap()
                    );
                    assert_eq!(
                        manager.desired_project_root("project").await,
                        intent.target.as_ref().map(|target| target.path.clone())
                    );
                    for (index, ((key, original), baseline)) in
                        originals.iter().zip(&baselines).enumerate()
                    {
                        let after = read_durable_pending(&paths[index]).unwrap().unwrap();
                        if index == 0 || block_second {
                            assert_eq!(
                                pending_value(&after).unwrap(),
                                pending_value(original).unwrap()
                            );
                        } else {
                            assert_ne!(after.pending.id, original.pending.id);
                            assert_eq!(
                                after.last_root_transition.as_deref(),
                                Some(intent.id.as_str())
                            );
                        }
                        assert_proposal_content_preserved(original, &after);
                        assert_eq!(
                            fs::read(approved_document_path(manager.root(), key)).unwrap(),
                            *baseline
                        );
                    }
                    if restart {
                        manager = ConfigManager::initialize(manager.root().to_path_buf())
                            .await
                            .unwrap();
                    }
                    assert!(manager
                        .register_project_root("project", metadata.path().into())
                        .await
                        .is_err());
                    assert_eq!(
                        read_project_transition(manager.root(), "project")
                            .unwrap()
                            .unwrap()
                            .id,
                        intent.id
                    );
                    assert!(manager.get_snapshot(&["project".into()]).await.is_err());
                    assert!(manager.get_snapshot(&[]).await.is_ok());
                    for (_, original) in &originals {
                        assert!(manager
                            .accept_pending_change(&original.pending.id)
                            .await
                            .is_err());
                    }
                    fs::remove_dir(first_obstruction).unwrap();
                    if block_second {
                        fs::remove_dir(second_obstruction).unwrap();
                    }
                    manager
                        .register_project_root("project", metadata.path().into())
                        .await
                        .unwrap();
                    assert!(!project_transition_path(manager.root(), "project").exists());
                    for (_, original) in &originals {
                        assert!(manager
                            .accept_pending_change(&original.pending.id)
                            .await
                            .is_err());
                    }
                    for pending in manager.list_pending_changes().await {
                        manager.accept_pending_change(&pending.id).await.unwrap();
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn failed_initial_intent_blocks_reads_under_mcp_guard_and_retries_before_return() {
        for fresh in [false, true] {
            for (obstruction, refresh_first) in [
                ("write", false),
                ("write", true),
                ("gate", false),
                ("gate", true),
            ] {
                let (_temp, mut manager) = manager().await;
                let metadata = tempfile::tempdir().unwrap();
                let destination = tempfile::tempdir().unwrap();
                let (root, originals) = project_pending_pair(&manager, metadata.path()).await;
                if fresh {
                    manager = ConfigManager::initialize(manager.root().to_path_buf())
                        .await
                        .unwrap();
                }
                manager
                    .register_project_root("healthy", metadata.path().into())
                    .await
                    .unwrap();
                let intent_path = project_transition_path(manager.root(), "project");
                let failure = intent_path.with_extension(if obstruction == "write" {
                    "fail-write"
                } else {
                    "json.lock"
                });
                if obstruction == "write" {
                    fs::write(&failure, b"fail").unwrap();
                } else {
                    fs::remove_file(&failure).unwrap();
                    fs::create_dir(&failure).unwrap();
                }
                assert!(manager
                    .register_project_root("project", destination.path().into())
                    .await
                    .is_err());
                assert!(
                    !intent_path.exists(),
                    "initial failure cannot claim durable success"
                );
                let destination_root = destination
                    .path()
                    .join("projects/project/config")
                    .canonicalize()
                    .unwrap();
                assert_eq!(
                    manager.desired_project_root("project").await,
                    Some(destination_root.clone())
                );
                assert_eq!(
                    manager
                        .state
                        .read()
                        .await
                        .project_roots
                        .get("project")
                        .cloned(),
                    if fresh { None } else { Some(root) }
                );
                let authority = manager.lock_mcp_runtime_configuration().await;
                let blocked = tokio::time::timeout(std::time::Duration::from_secs(1), async {
                    assert!(manager.get_snapshot(&["project".into()]).await.is_err());
                    assert!(manager
                        .get_document(ConfigDocumentKind::Tools, originals[0].0.scope.clone())
                        .await
                        .is_err());
                    assert!(manager
                        .path_for_scope(ConfigDocumentKind::Tools, &originals[0].0.scope)
                        .await
                        .is_err());
                    assert!(manager.list_pending_changes().await.is_empty());
                    assert!(manager.get_snapshot(&["healthy".into()]).await.is_ok());
                    assert!(manager.get_snapshot(&[]).await.is_ok());
                })
                .await;
                drop(authority);
                blocked.expect("reads reject the intent without recursively taking MCP authority");
                if !refresh_first {
                    assert!(manager
                        .register_project_root("project", metadata.path().into())
                        .await
                        .is_err());
                }
                for (key, original) in &originals {
                    assert_eq!(
                        pending_value(
                            &read_durable_pending(&pending_document_path(manager.root(), key))
                                .unwrap()
                                .unwrap()
                        )
                        .unwrap(),
                        pending_value(original).unwrap()
                    );
                    assert!(manager
                        .accept_pending_change(&original.pending.id)
                        .await
                        .is_err());
                }
                if obstruction == "write" {
                    fs::remove_file(failure).unwrap();
                } else {
                    fs::remove_dir(failure).unwrap();
                }
                if refresh_first {
                    let (changed, errors) = manager.refresh_project_roots().await;
                    assert!(changed);
                    assert!(errors.is_empty());
                    assert_eq!(
                        manager.desired_project_root("project").await,
                        Some(destination_root.clone())
                    );
                    assert_eq!(
                        manager.state.read().await.project_roots.get("project"),
                        Some(&destination_root)
                    );
                    assert!(!intent_path.exists());
                    assert!(manager
                        .get_snapshot(&["project".into()])
                        .await
                        .unwrap()
                        .documents
                        .iter()
                        .all(|document| document.scope == ConfigScope::User));
                    let (changed, errors) = manager.refresh_project_roots().await;
                    assert!(!changed);
                    assert!(errors.is_empty());
                }
                manager
                    .register_project_root("project", metadata.path().into())
                    .await
                    .unwrap();
                for (_, original) in &originals {
                    assert!(manager
                        .accept_pending_change(&original.pending.id)
                        .await
                        .is_err());
                }
            }
        }
    }

    #[tokio::test]
    async fn project_transition_ack_and_cleanup_replay_keep_ids_stable() {
        for restart in [false, true] {
            let (_temp, mut manager) = manager().await;
            let metadata = tempfile::tempdir().unwrap();
            let destination = tempfile::tempdir().unwrap();
            let (_, originals) = project_pending_pair(&manager, metadata.path()).await;
            let paths = originals
                .iter()
                .map(|(key, _)| pending_document_path(manager.root(), key))
                .collect::<Vec<_>>();
            let failure = paths[0].with_extension("fail-write");
            fs::write(&failure, b"fail").unwrap();
            assert!(manager
                .register_project_root("project", destination.path().into())
                .await
                .is_err());
            let intent = read_project_transition(manager.root(), "project")
                .unwrap()
                .unwrap();
            let skills_ack = fs::read(&paths[1]).unwrap();
            let intent_path = project_transition_path(manager.root(), "project");
            let retry_failure = intent_path.with_extension("fail-write");
            fs::write(&retry_failure, b"fail").unwrap();
            fs::remove_file(failure).unwrap();
            if restart {
                manager = ConfigManager::initialize(manager.root().to_path_buf())
                    .await
                    .unwrap();
            }
            assert_eq!(
                manager
                    .register_project_root("project", metadata.path().into())
                    .await
                    .unwrap_err()
                    .code,
                "config.project.transition.write_failed"
            );
            assert_eq!(
                read_durable_pending(&paths[0]).unwrap().unwrap().pending.id,
                originals[0].1.pending.id
            );
            assert_eq!(fs::read(&paths[1]).unwrap(), skills_ack);
            fs::remove_file(retry_failure).unwrap();
            let cleanup_failure = intent_path.with_extension("fail-remove");
            fs::write(&cleanup_failure, b"fail").unwrap();
            assert!(manager
                .register_project_root("project", metadata.path().into())
                .await
                .is_err());
            let tools_ack = fs::read(&paths[0]).unwrap();
            for _ in 0..2 {
                assert!(manager
                    .register_project_root("project", metadata.path().into())
                    .await
                    .is_err());
                assert_eq!(
                    read_project_transition(manager.root(), "project")
                        .unwrap()
                        .unwrap()
                        .id,
                    intent.id
                );
                assert_eq!(fs::read(&paths[0]).unwrap(), tools_ack);
                assert_eq!(fs::read(&paths[1]).unwrap(), skills_ack);
                for (_, original) in &originals {
                    assert!(manager
                        .accept_pending_change(&original.pending.id)
                        .await
                        .is_err());
                }
            }
            fs::remove_file(cleanup_failure).unwrap();
            manager
                .register_project_root("project", metadata.path().into())
                .await
                .unwrap();
            for (key, original) in &originals {
                assert_proposal_content_preserved(
                    original,
                    &read_durable_pending(&pending_document_path(manager.root(), key))
                        .unwrap()
                        .unwrap(),
                );
                assert!(manager
                    .accept_pending_change(&original.pending.id)
                    .await
                    .is_err());
            }
        }
    }

    #[tokio::test]
    async fn removing_project_with_blocked_intent_does_not_resurrect_it_on_refresh() {
        let (_temp, manager) = manager().await;
        let metadata = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let (_, originals) = project_pending_pair(&manager, metadata.path()).await;
        let failure =
            pending_document_path(manager.root(), &originals[0].0).with_extension("fail-write");
        fs::write(&failure, b"fail").unwrap();
        assert!(manager
            .register_project_root("project", destination.path().into())
            .await
            .is_err());
        let intent_path = project_transition_path(manager.root(), "project");
        let intent_bytes = fs::read(&intent_path).unwrap();
        manager.unregister_project_root("project").await;
        manager
            .observe_project_root_unavailable("project")
            .await
            .unwrap();
        assert!(manager.desired_project_root("project").await.is_none());
        fs::remove_file(failure).unwrap();
        manager
            .observe_project_root_unavailable("project")
            .await
            .unwrap();
        let (changed, errors) = manager.refresh_project_roots().await;
        assert!(!changed);
        assert!(errors.is_empty());
        assert!(manager.desired_project_root("project").await.is_none());
        assert!(manager.get_snapshot(&["project".into()]).await.is_err());
        assert_eq!(fs::read(&intent_path).unwrap(), intent_bytes);
        manager
            .register_project_root("project", metadata.path().into())
            .await
            .unwrap();
        for (_, original) in &originals {
            assert!(manager
                .accept_pending_change(&original.pending.id)
                .await
                .is_err());
        }
    }

    #[tokio::test]
    async fn startup_recovery_finishes_old_intent_then_loads_latest_requested_root() {
        let (_temp, mut manager) = manager().await;
        let metadata = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let (root_a, originals) = project_pending_pair(&manager, metadata.path()).await;
        let failure =
            pending_document_path(manager.root(), &originals[0].0).with_extension("fail-write");
        fs::write(&failure, b"fail").unwrap();
        assert!(manager
            .register_project_root("project", destination.path().into())
            .await
            .is_err());
        let intent_b = read_project_transition(manager.root(), "project")
            .unwrap()
            .unwrap();
        let root_b = destination
            .path()
            .join("projects/project/config")
            .canonicalize()
            .unwrap();
        assert_eq!(intent_b.target.as_ref().unwrap().path, root_b);
        manager = ConfigManager::initialize(manager.root().to_path_buf())
            .await
            .unwrap();
        assert!(manager
            .register_project_root("project", metadata.path().into())
            .await
            .is_err());
        assert_eq!(
            manager.desired_project_root("project").await,
            Some(root_a.clone())
        );
        assert_eq!(
            read_project_transition(manager.root(), "project")
                .unwrap()
                .unwrap()
                .id,
            intent_b.id
        );
        assert!(manager.get_snapshot(&["project".into()]).await.is_err());
        fs::remove_file(failure).unwrap();
        // No further bootstrap/register: maintenance must honor the requested A.
        let (changed, errors) = manager.refresh_project_roots().await;
        assert!(changed);
        assert!(errors.is_empty());
        assert_eq!(
            manager.desired_project_root("project").await,
            Some(root_a.clone())
        );
        assert_eq!(
            manager.state.read().await.project_roots.get("project"),
            Some(&root_a)
        );
        assert!(!project_transition_path(manager.root(), "project").exists());
        assert_eq!(manager.list_pending_changes().await.len(), 2);
        assert!(manager.get_snapshot(&["project".into()]).await.is_ok());
        for (key, original) in &originals {
            let renewed = read_durable_pending(&pending_document_path(manager.root(), key))
                .unwrap()
                .unwrap();
            assert_eq!(renewed.project_root.as_ref().unwrap().path, root_a);
            assert_proposal_content_preserved(original, &renewed);
            assert!(manager
                .accept_pending_change(&original.pending.id)
                .await
                .is_err());
        }
    }

    #[tokio::test]
    async fn withdrawn_startup_request_is_not_retried_until_explicit_registration() {
        for retain in [false, true] {
            for obstruction in ["write", "gate"] {
                let (_temp, mut manager) = manager().await;
                let metadata = tempfile::tempdir().unwrap();
                let destination = tempfile::tempdir().unwrap();
                let (_, originals) = project_pending_pair(&manager, metadata.path()).await;
                manager = ConfigManager::initialize(manager.root().to_path_buf())
                    .await
                    .unwrap();
                let intent_path = project_transition_path(manager.root(), "project");
                let failure = intent_path.with_extension(if obstruction == "write" {
                    "fail-write"
                } else {
                    "json.lock"
                });
                if obstruction == "write" {
                    fs::write(&failure, b"fail").unwrap();
                } else {
                    fs::remove_file(&failure).unwrap();
                    fs::create_dir(&failure).unwrap();
                }
                assert!(manager
                    .register_project_root("project", destination.path().into())
                    .await
                    .is_err());
                let target = destination
                    .path()
                    .join("projects/project/config")
                    .canonicalize()
                    .unwrap();
                assert_eq!(manager.desired_project_root("project").await, Some(target));
                assert!(manager.state.read().await.project_roots.is_empty());
                let intent_id = manager.state.read().await.project_transitions["project"]
                    .id
                    .clone();
                if retain {
                    manager.retain_project_roots(&BTreeSet::new()).await;
                } else {
                    manager.unregister_project_root("project").await;
                }
                if obstruction == "write" {
                    fs::remove_file(failure).unwrap();
                } else {
                    fs::remove_dir(failure).unwrap();
                }
                manager
                    .observe_project_root_unavailable("project")
                    .await
                    .unwrap();
                let (changed, errors) = manager.refresh_project_roots().await;
                assert!(!changed);
                assert!(errors.is_empty());
                assert!(manager.desired_project_root("project").await.is_none());
                assert!(manager.state.read().await.project_roots.is_empty());
                assert_eq!(
                    manager.state.read().await.project_transitions["project"].id,
                    intent_id
                );
                assert!(
                    !intent_path.exists(),
                    "withdrawal must not publish the failed intent in the background"
                );
                manager
                    .register_project_root("project", metadata.path().into())
                    .await
                    .unwrap();
                for (_, original) in &originals {
                    assert!(manager
                        .accept_pending_change(&original.pending.id)
                        .await
                        .is_err());
                }
            }
        }
    }

    #[tokio::test]
    async fn observed_absence_keeps_project_intent_until_every_proposal_is_revoked() {
        for restart in [false, true] {
            let (_temp, mut manager) = manager().await;
            let metadata = tempfile::tempdir().unwrap();
            let (root, originals) = project_pending_pair(&manager, metadata.path()).await;
            let hidden = root.with_file_name("hidden-config");
            fs::rename(&root, &hidden).unwrap();
            // The watcher has already observed the removal; the directory returns
            // before its callback is consumed by the manager.
            fs::rename(&hidden, &root).unwrap();
            let pending_path = pending_document_path(manager.root(), &originals[0].0);
            let failure = pending_path.with_extension("fail-write");
            fs::write(&failure, b"fail").unwrap();
            assert!(manager
                .observe_project_root_unavailable("project")
                .await
                .is_err());
            let intent = read_project_transition(manager.root(), "project")
                .unwrap()
                .unwrap();
            assert!(intent.target.is_none());
            let skills =
                read_durable_pending(&pending_document_path(manager.root(), &originals[1].0))
                    .unwrap()
                    .unwrap();
            assert_eq!(
                skills.last_root_transition.as_deref(),
                Some(intent.id.as_str())
            );
            assert!(skills.project_root.is_none());
            if restart {
                manager = ConfigManager::initialize(manager.root().to_path_buf())
                    .await
                    .unwrap();
            }
            assert!(manager
                .register_project_root("project", metadata.path().into())
                .await
                .is_err());
            assert_eq!(
                read_project_transition(manager.root(), "project")
                    .unwrap()
                    .unwrap()
                    .id,
                intent.id
            );
            fs::remove_file(failure).unwrap();
            manager
                .register_project_root("project", metadata.path().into())
                .await
                .unwrap();
            for (key, original) in &originals {
                let renewed = read_durable_pending(&pending_document_path(manager.root(), key))
                    .unwrap()
                    .unwrap();
                assert_proposal_content_preserved(original, &renewed);
                assert!(manager
                    .accept_pending_change(&original.pending.id)
                    .await
                    .is_err());
                assert!(manager
                    .reject_pending_change(&original.pending.id, true)
                    .await
                    .is_err());
                manager
                    .accept_pending_change(&renewed.pending.id)
                    .await
                    .unwrap();
            }
        }
    }

    #[tokio::test]
    async fn same_root_restart_keeps_all_proposal_ids_and_bytes() {
        let (_temp, mut manager) = manager().await;
        let metadata = tempfile::tempdir().unwrap();
        let (_, originals) = project_pending_pair(&manager, metadata.path()).await;
        let before = originals
            .iter()
            .map(|(key, _)| fs::read(pending_document_path(manager.root(), key)).unwrap())
            .collect::<Vec<_>>();
        for restart in [false, true] {
            if restart {
                manager = ConfigManager::initialize(manager.root().to_path_buf())
                    .await
                    .unwrap();
            }
            manager
                .register_project_root("project", metadata.path().join("."))
                .await
                .unwrap();
            let (changed, errors) = manager.refresh_project_roots().await;
            assert!(!changed);
            assert!(errors.is_empty());
            for ((key, _), bytes) in originals.iter().zip(&before) {
                assert_eq!(
                    fs::read(pending_document_path(manager.root(), key)).unwrap(),
                    *bytes
                );
            }
            assert!(!project_transition_path(manager.root(), "project").exists());
        }
    }

    #[tokio::test]
    async fn corrupt_project_intent_or_ack_preserves_all_data_and_blocks_reuse() {
        let (_temp, manager) = manager().await;
        let metadata = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let (_, originals) = project_pending_pair(&manager, metadata.path()).await;
        let failure =
            pending_document_path(manager.root(), &originals[0].0).with_extension("fail-write");
        fs::write(&failure, b"fail").unwrap();
        assert!(manager
            .register_project_root("project", destination.path().into())
            .await
            .is_err());
        fs::remove_file(failure).unwrap();
        let intent_path = project_transition_path(manager.root(), "project");
        let valid = fs::read(&intent_path).unwrap();
        let pending_paths = originals
            .iter()
            .map(|(key, _)| pending_document_path(manager.root(), key))
            .collect::<Vec<_>>();
        let pending_bytes = pending_paths
            .iter()
            .map(|path| fs::read(path).unwrap())
            .collect::<Vec<_>>();
        for corruption in ["json", "project", "target", "id", "ack"] {
            fs::write(&intent_path, &valid).unwrap();
            for (path, bytes) in pending_paths.iter().zip(&pending_bytes) {
                fs::write(path, bytes).unwrap();
            }
            let mut value: Value = serde_json::from_slice(&valid).unwrap();
            match corruption {
                "json" => fs::write(&intent_path, b"{").unwrap(),
                "project" => {
                    value["projectId"] = json!("other");
                    atomic_write_json(&intent_path, &value).unwrap();
                }
                "target" => {
                    value.as_object_mut().unwrap().remove("target");
                    atomic_write_json(&intent_path, &value).unwrap();
                }
                "id" => {
                    value["id"] = json!("invalid");
                    atomic_write_json(&intent_path, &value).unwrap();
                }
                "ack" => {
                    let mut ack = read_json_value(&pending_paths[1]).unwrap();
                    ack["projectRoot"] =
                        serde_json::to_value(&originals[1].1.project_root).unwrap();
                    atomic_write_json(&pending_paths[1], &ack).unwrap();
                }
                _ => unreachable!(),
            }
            let before_intent = fs::read(&intent_path).unwrap();
            let before_pending = pending_paths
                .iter()
                .map(|path| fs::read(path).unwrap())
                .collect::<Vec<_>>();
            assert!(manager
                .register_project_root("project", metadata.path().into())
                .await
                .is_err());
            assert_eq!(fs::read(&intent_path).unwrap(), before_intent);
            // An invalid intent prevents all proposal processing; a conflicting ack
            // leaves its own bytes untouched while other proposals are still visited.
            for index in if corruption == "ack" { 1..2 } else { 0..2 } {
                assert_eq!(
                    fs::read(&pending_paths[index]).unwrap(),
                    before_pending[index]
                );
            }
            assert!(manager.get_snapshot(&["project".into()]).await.is_err());
            for (_, original) in &originals {
                assert!(manager
                    .accept_pending_change(&original.pending.id)
                    .await
                    .is_err());
            }
        }
        fs::write(intent_path, valid).unwrap();
        for (path, bytes) in pending_paths.iter().zip(&pending_bytes) {
            fs::write(path, bytes).unwrap();
        }
        manager
            .register_project_root("project", metadata.path().into())
            .await
            .unwrap();
        for (_, original) in &originals {
            assert!(manager
                .accept_pending_change(&original.pending.id)
                .await
                .is_err());
        }
    }

    #[tokio::test]
    async fn empty_or_missing_root_round_trip_never_revives_an_old_approval() {
        for transition in ["register", "refresh", "missing"] {
            for restart in [false, true] {
                let (_temp, mut manager) = manager().await;
                let metadata = tempfile::tempdir().unwrap();
                let other_metadata = tempfile::tempdir().unwrap();
                let root = manager
                    .register_project_root("project", metadata.path().into())
                    .await
                    .unwrap();
                let mut tools = sparse_document(ConfigDocumentKind::Tools);
                tools["riskLevel"] = json!("strict");
                atomic_write_json(&root.join("tools.json"), &tools).unwrap();
                manager.get_snapshot(&["project".into()]).await.unwrap();
                let original = manager.list_pending_changes().await.pop().unwrap();
                let key = DocumentKey {
                    kind: ConfigDocumentKind::Tools,
                    scope: original.scope.clone(),
                };
                let pending_path = pending_document_path(manager.root(), &key);
                let approved_path = approved_document_path(manager.root(), &key);
                let baseline = fs::read(&approved_path).unwrap();
                let user_root = manager.root().to_path_buf();
                let preserved_root = root.with_file_name("original-config");
                if transition == "register" {
                    manager
                        .register_project_root("project", other_metadata.path().into())
                        .await
                        .unwrap();
                } else {
                    fs::rename(&root, &preserved_root).unwrap();
                    if transition == "refresh" {
                        fs::create_dir(&root).unwrap();
                    }
                    let (changed, errors) = manager.refresh_project_roots().await;
                    assert!(changed);
                    if transition == "missing" {
                        assert_eq!(errors[0].code, "config.project.root_missing");
                        assert!(
                            !root.exists(),
                            "invalidation must not recreate a missing root"
                        );
                    } else {
                        assert!(errors.is_empty());
                    }
                }
                let at_empty_root = read_durable_pending(&pending_path).unwrap().unwrap();
                assert_ne!(
                    at_empty_root.pending.id, original.id,
                    "{transition}, restart={restart}"
                );
                assert_eq!(at_empty_root.pending.proposed_document, tools);
                assert_eq!(fs::read(&approved_path).unwrap(), baseline);
                assert!(manager.list_pending_changes().await.is_empty());
                if restart {
                    drop(manager);
                    manager = ConfigManager::initialize(user_root).await.unwrap();
                    if transition != "missing" {
                        let active_metadata = if transition == "register" {
                            other_metadata.path()
                        } else {
                            metadata.path()
                        };
                        manager
                            .register_project_root("project", active_metadata.into())
                            .await
                            .unwrap();
                        assert!(manager.list_pending_changes().await.is_empty());
                        assert_eq!(
                            read_durable_pending(&pending_path)
                                .unwrap()
                                .unwrap()
                                .pending
                                .id,
                            at_empty_root.pending.id
                        );
                    }
                }
                // Unregister alone preserves the durable transition to B.
                manager.unregister_project_root("project").await;
                if transition != "register" {
                    if root.exists() {
                        fs::remove_dir_all(&root).unwrap();
                    }
                    fs::rename(&preserved_root, &root).unwrap();
                }
                manager
                    .register_project_root("project", metadata.path().into())
                    .await
                    .unwrap();
                let renewed = manager.list_pending_changes().await.pop().unwrap();
                assert_ne!(renewed.id, original.id);
                assert_ne!(renewed.id, at_empty_root.pending.id);
                assert_eq!(renewed.proposed_document, tools);
                assert_eq!(fs::read(&approved_path).unwrap(), baseline);
                assert!(manager.accept_pending_change(&original.id).await.is_err());
                assert!(manager
                    .reject_pending_change(&original.id, true)
                    .await
                    .is_err());
                manager.accept_pending_change(&renewed.id).await.unwrap();
            }
        }
    }

    #[tokio::test]
    async fn empty_root_approval_invalidation_failure_blocks_until_persisted() {
        let (_temp, manager) = manager().await;
        let metadata = tempfile::tempdir().unwrap();
        let other_metadata = tempfile::tempdir().unwrap();
        let root = manager
            .register_project_root("project", metadata.path().into())
            .await
            .unwrap();
        let mut tools = sparse_document(ConfigDocumentKind::Tools);
        tools["riskLevel"] = json!("strict");
        atomic_write_json(&root.join("tools.json"), &tools).unwrap();
        manager.get_snapshot(&["project".into()]).await.unwrap();
        let original = manager.list_pending_changes().await.pop().unwrap();
        let key = DocumentKey {
            kind: ConfigDocumentKind::Tools,
            scope: original.scope.clone(),
        };
        let pending_path = pending_document_path(manager.root(), &key);
        let before = fs::read(&pending_path).unwrap();
        let failure = pending_path.with_extension("fail-write");
        fs::write(&failure, b"fail").unwrap();
        assert_eq!(
            manager
                .register_project_root("project", other_metadata.path().into())
                .await
                .unwrap_err()
                .code,
            "config.pending.write_failed"
        );
        assert!(manager.desired_project_root("project").await.is_some());
        for _ in 0..2 {
            let (changed, errors) = manager.refresh_project_roots().await;
            assert!(!changed);
            assert_eq!(errors[0].code, "config.pending.write_failed");
            assert!(manager.get_snapshot(&["project".into()]).await.is_err());
            assert!(manager.accept_pending_change(&original.id).await.is_err());
            assert_eq!(fs::read(&pending_path).unwrap(), before);
        }
        fs::remove_file(failure).unwrap();
        let (changed, errors) = manager.refresh_project_roots().await;
        assert!(changed);
        assert!(errors.is_empty());
        assert!(manager
            .get_snapshot(&["project".into()])
            .await
            .unwrap()
            .documents
            .iter()
            .all(|document| document.scope == ConfigScope::User));
        assert_ne!(
            read_durable_pending(&pending_path)
                .unwrap()
                .unwrap()
                .pending
                .id,
            original.id
        );
        let (changed, errors) = manager.refresh_project_roots().await;
        assert!(!changed);
        assert!(errors.is_empty());
        manager
            .register_project_root("project", metadata.path().into())
            .await
            .unwrap();
        assert!(manager.accept_pending_change(&original.id).await.is_err());
    }

    #[tokio::test]
    async fn maintenance_and_reconciliation_diagnostics_clear_independently() {
        let (_temp, manager) = manager().await;
        let reconciliation = "config.project.reconciliation_incomplete";
        let maintenance = "config.project.maintenance_incomplete";
        manager
            .record_reconciliation_diagnostic(Some("Workspace indisponible".into()))
            .await;
        let event = manager
            .record_maintenance_diagnostic(Some("Surveillance indisponible".into()))
            .await;
        let codes = |document: &ConfigDocument| {
            document
                .diagnostics
                .iter()
                .map(|diagnostic| diagnostic.code.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(codes(&event), vec![reconciliation, maintenance]);
        let runtime = manager
            .get_document(ConfigDocumentKind::Runtime, ConfigScope::User)
            .await
            .unwrap();
        assert_eq!(codes(&runtime), codes(&event));
        let snapshot = manager.get_snapshot(&[]).await.unwrap();
        let runtime = snapshot
            .documents
            .iter()
            .find(|document| document.kind == ConfigDocumentKind::Runtime)
            .unwrap();
        assert_eq!(codes(runtime), codes(&event));
        assert_eq!(
            snapshot
                .diagnostics
                .iter()
                .map(|diagnostic| diagnostic.code.as_str())
                .collect::<Vec<_>>(),
            vec![reconciliation, maintenance]
        );
        let recovered = manager.record_maintenance_diagnostic(None).await;
        assert_eq!(codes(&recovered), vec![reconciliation]);
        assert_eq!(
            manager.get_snapshot(&[]).await.unwrap().diagnostics.len(),
            1
        );
        manager
            .record_maintenance_diagnostic(Some("Nouvelle panne".into()))
            .await;
        assert_eq!(
            codes(&manager.record_reconciliation_diagnostic(None).await),
            vec![maintenance]
        );
        assert!(manager
            .record_maintenance_diagnostic(None)
            .await
            .diagnostics
            .is_empty());
        assert!(manager
            .get_snapshot(&[])
            .await
            .unwrap()
            .diagnostics
            .is_empty());
    }

    #[tokio::test]
    async fn changed_roots_require_new_durable_approval_after_maintenance_and_restart() {
        for transition in [
            "refresh",
            "register-replaced",
            "register-moved",
            "unregister-replaced",
            "restart-replaced",
            "restart-moved",
        ] {
            let (_temp, mut manager) = manager().await;
            let metadata = tempfile::tempdir().unwrap();
            let destination = tempfile::tempdir().unwrap();
            let root = manager
                .register_project_root("project", metadata.path().into())
                .await
                .unwrap();
            let scope = ConfigScope::Project {
                project_id: "project".into(),
            };
            let kind = ConfigDocumentKind::Tools;
            let document = manager.get_document(kind, scope.clone()).await.unwrap();
            let pending = manager
                .apply_patch(ConfigPatchRequest {
                    kind,
                    scope: scope.clone(),
                    expected_etag: document.etag,
                    patch: vec![JsonPatchOperation {
                        op: "add".into(),
                        path: "/riskLevel".into(),
                        from: None,
                        value: Some(json!("strict")),
                    }],
                    source: ConfigChangeSource::Agent,
                })
                .await
                .unwrap()
                .pending_change
                .unwrap();
            let key = DocumentKey {
                kind,
                scope: scope.clone(),
            };
            let approved_path = approved_document_path(manager.root(), &key);
            let approved_before = fs::read(&approved_path).unwrap();
            let pending_path = pending_document_path(manager.root(), &key);
            let durable_before = read_durable_pending(&pending_path).unwrap().unwrap();
            let document_before = fs::read(root.join(kind.file_name())).unwrap();
            let user_root = manager.root().to_path_buf();
            if transition == "unregister-replaced" {
                manager.unregister_project_root("project").await;
            }
            let moved = transition.ends_with("moved");
            let active_metadata = if moved {
                destination.path()
            } else {
                metadata.path()
            };
            let active_root = if moved {
                let target = destination.path().join("projects/project/config");
                fs::create_dir_all(target.parent().unwrap()).unwrap();
                // Preserve the inode: a path change alone must invalidate consent.
                fs::rename(&root, &target).unwrap();
                target
            } else {
                fs::rename(&root, root.with_file_name("previous-config")).unwrap();
                fs::create_dir(&root).unwrap();
                fs::write(root.join(kind.file_name()), &document_before).unwrap();
                root.clone()
            };
            if transition.starts_with("restart") {
                drop(manager);
                manager = ConfigManager::initialize(user_root.clone()).await.unwrap();
            }
            if transition == "refresh" {
                let (changed, errors) = manager.refresh_project_roots().await;
                assert!(changed);
                assert!(errors.is_empty());
            } else {
                manager
                    .register_project_root("project", active_metadata.into())
                    .await
                    .unwrap();
            }
            let renewed = manager.list_pending_changes().await.pop().unwrap();
            assert_ne!(renewed.id, pending.id, "{transition}");
            assert_eq!(renewed.proposed_document, pending.proposed_document);
            assert_eq!(renewed.source, pending.source);
            assert_eq!(fs::read(&approved_path).unwrap(), approved_before);
            assert_eq!(
                fs::read(active_root.join(kind.file_name())).unwrap(),
                document_before
            );
            let durable_after = read_durable_pending(&pending_path).unwrap().unwrap();
            assert_eq!(durable_after.approved_etag, durable_before.approved_etag);
            assert_eq!(
                durable_after.all_changed_paths,
                durable_before.all_changed_paths
            );
            assert_eq!(durable_after.apply_modes, durable_before.apply_modes);
            assert!(
                manager.accept_pending_change(&pending.id).await.is_err(),
                "{transition}"
            );
            assert!(
                manager
                    .reject_pending_change(&pending.id, true)
                    .await
                    .is_err(),
                "{transition}"
            );

            // The new ID survives both forgetting runtime state and a process restart.
            manager.unregister_project_root("project").await;
            drop(manager);
            manager = ConfigManager::initialize(user_root).await.unwrap();
            manager
                .register_project_root("project", active_metadata.into())
                .await
                .unwrap();
            assert_eq!(manager.list_pending_changes().await[0].id, renewed.id);
            assert!(manager.accept_pending_change(&pending.id).await.is_err());
            assert_eq!(fs::read(&approved_path).unwrap(), approved_before);
            manager.accept_pending_change(&renewed.id).await.unwrap();
            assert_eq!(
                read_json_value(&approved_path).unwrap(),
                pending.proposed_document
            );
        }
    }

    #[tokio::test]
    async fn legacy_project_proposal_gets_one_new_approval_id_without_losing_its_data() {
        let (_temp, manager) = manager().await;
        let metadata = tempfile::tempdir().unwrap();
        let root = metadata.path().join("projects/project/config");
        fs::create_dir_all(&root).unwrap();
        let mut tools = sparse_document(ConfigDocumentKind::Tools);
        tools["riskLevel"] = json!("strict");
        atomic_write_json(&root.join("tools.json"), &tools).unwrap();
        manager
            .register_project_root("project", metadata.path().into())
            .await
            .unwrap();
        let old = manager.list_pending_changes().await.pop().unwrap();
        let key = DocumentKey {
            kind: ConfigDocumentKind::Tools,
            scope: old.scope.clone(),
        };
        let pending_path = pending_document_path(manager.root(), &key);
        let approved_path = approved_document_path(manager.root(), &key);
        let approved = fs::read(&approved_path).unwrap();
        let mut legacy = read_json_value(&pending_path).unwrap();
        legacy.as_object_mut().unwrap().remove("projectRoot");
        atomic_write_json(&pending_path, &legacy).unwrap();
        let user_root = manager.root().to_path_buf();
        drop(manager);
        let manager = ConfigManager::initialize(user_root).await.unwrap();
        manager
            .register_project_root("project", metadata.path().into())
            .await
            .unwrap();
        let renewed = manager.list_pending_changes().await.pop().unwrap();
        assert_ne!(renewed.id, old.id);
        assert_eq!(renewed.proposed_document, old.proposed_document);
        assert_eq!(fs::read(&approved_path).unwrap(), approved);
        assert!(manager.accept_pending_change(&old.id).await.is_err());
        manager.unregister_project_root("project").await;
        manager
            .register_project_root("project", metadata.path().into())
            .await
            .unwrap();
        assert_eq!(manager.list_pending_changes().await[0].id, renewed.id);
        manager.accept_pending_change(&renewed.id).await.unwrap();
    }

    #[tokio::test]
    async fn failed_approval_rebinding_preserves_durable_data_and_retries_without_purging_again() {
        let (_temp, manager) = manager().await;
        let metadata = tempfile::tempdir().unwrap();
        let root = manager
            .register_project_root("project", metadata.path().into())
            .await
            .unwrap();
        let mut tools = sparse_document(ConfigDocumentKind::Tools);
        tools["riskLevel"] = json!("strict");
        atomic_write_json(&root.join("tools.json"), &tools).unwrap();
        manager.get_snapshot(&["project".into()]).await.unwrap();
        let old = manager.list_pending_changes().await.pop().unwrap();
        let key = DocumentKey {
            kind: ConfigDocumentKind::Tools,
            scope: old.scope.clone(),
        };
        let pending_path = pending_document_path(manager.root(), &key);
        let approved_path = approved_document_path(manager.root(), &key);
        let durable_before = fs::read(&pending_path).unwrap();
        let approved_before = fs::read(&approved_path).unwrap();
        let failure = pending_path.with_extension("fail-write");
        fs::write(&failure, b"fail").unwrap();
        fs::rename(&root, root.with_file_name("previous-config")).unwrap();
        fs::create_dir(&root).unwrap();
        atomic_write_json(&root.join("tools.json"), &tools).unwrap();
        for expected_changed in [true, false] {
            let (changed, errors) = manager.refresh_project_roots().await;
            assert_eq!(changed, expected_changed);
            assert_eq!(errors[0].code, "config.pending.write_failed");
            assert!(manager.accept_pending_change(&old.id).await.is_err());
            assert_eq!(fs::read(&pending_path).unwrap(), durable_before);
            assert_eq!(fs::read(&approved_path).unwrap(), approved_before);
        }
        fs::remove_file(failure).unwrap();
        let (changed, errors) = manager.refresh_project_roots().await;
        assert!(changed);
        assert!(errors.is_empty());
        let renewed = manager.list_pending_changes().await.pop().unwrap();
        assert_ne!(renewed.id, old.id);
        assert_eq!(renewed.proposed_document, tools);
        manager.accept_pending_change(&renewed.id).await.unwrap();
    }

    #[tokio::test]
    async fn observed_absence_revokes_consent_even_if_root_is_restored_before_observation_or_refresh(
    ) {
        for restored_before_observation in [false, true] {
            for restart in [false, true] {
                let (_temp, mut manager) = manager().await;
                let metadata = tempfile::tempdir().unwrap();
                let root = manager
                    .register_project_root("project", metadata.path().into())
                    .await
                    .unwrap();
                let identity = DirectoryIdentity::read(&root).unwrap();
                let mut tools = sparse_document(ConfigDocumentKind::Tools);
                tools["riskLevel"] = json!("strict");
                atomic_write_json(&root.join("tools.json"), &tools).unwrap();
                manager.get_snapshot(&["project".into()]).await.unwrap();
                let original = manager.list_pending_changes().await.pop().unwrap();
                let key = DocumentKey {
                    kind: ConfigDocumentKind::Tools,
                    scope: original.scope.clone(),
                };
                let pending_path = pending_document_path(manager.root(), &key);
                let approved_path = approved_document_path(manager.root(), &key);
                let baseline = fs::read(&approved_path).unwrap();
                let hidden_root = root.with_file_name("unavailable-config");
                fs::rename(&root, &hidden_root).unwrap();
                // Workspace observed the missing directory here. Restoring it must
                // not erase the observation, regardless of when the API runs.
                if restored_before_observation {
                    fs::rename(&hidden_root, &root).unwrap();
                }
                manager
                    .observe_project_root_unavailable("project")
                    .await
                    .unwrap();
                assert_eq!(
                    manager.desired_project_root("project").await,
                    Some(root.clone())
                );
                assert!(manager.list_pending_changes().await.is_empty());
                assert!(manager.get_snapshot(&["project".into()]).await.is_err());
                assert!(manager.accept_pending_change(&original.id).await.is_err());
                let revoked = read_durable_pending(&pending_path).unwrap().unwrap();
                assert_ne!(revoked.pending.id, original.id);
                assert!(revoked.project_root.is_none());
                manager
                    .observe_project_root_unavailable("project")
                    .await
                    .unwrap();
                assert_eq!(
                    read_durable_pending(&pending_path)
                        .unwrap()
                        .unwrap()
                        .pending
                        .id,
                    revoked.pending.id,
                    "repeated absence must not churn consent IDs"
                );
                if !restored_before_observation {
                    assert!(
                        !root.exists(),
                        "observation must not recreate the missing root"
                    );
                    fs::rename(&hidden_root, &root).unwrap();
                }
                assert_eq!(DirectoryIdentity::read(&root).unwrap(), identity);
                if restart {
                    let user_root = manager.root().to_path_buf();
                    drop(manager);
                    manager = ConfigManager::initialize(user_root).await.unwrap();
                    manager
                        .register_project_root("project", metadata.path().into())
                        .await
                        .unwrap();
                } else {
                    let (changed, errors) = manager.refresh_project_roots().await;
                    assert!(changed);
                    assert!(errors.is_empty());
                }
                assert!(manager.accept_pending_change(&original.id).await.is_err());
                assert_eq!(fs::read(&approved_path).unwrap(), baseline);
                let renewed = manager.list_pending_changes().await.pop().unwrap();
                assert_ne!(renewed.id, original.id);
                assert_ne!(renewed.id, revoked.pending.id);
                manager.accept_pending_change(&renewed.id).await.unwrap();
            }
        }
    }

    #[tokio::test]
    async fn failed_observed_absence_is_retried_before_reusing_a_restored_root() {
        let (_temp, manager) = manager().await;
        let metadata = tempfile::tempdir().unwrap();
        let root = manager
            .register_project_root("project", metadata.path().into())
            .await
            .unwrap();
        let mut tools = sparse_document(ConfigDocumentKind::Tools);
        tools["riskLevel"] = json!("strict");
        atomic_write_json(&root.join("tools.json"), &tools).unwrap();
        manager.get_snapshot(&["project".into()]).await.unwrap();
        let original = manager.list_pending_changes().await.pop().unwrap();
        let key = DocumentKey {
            kind: ConfigDocumentKind::Tools,
            scope: original.scope.clone(),
        };
        let pending_path = pending_document_path(manager.root(), &key);
        let before = fs::read(&pending_path).unwrap();
        let failure = pending_path.with_extension("fail-write");
        fs::write(&failure, b"fail").unwrap();
        let hidden_root = root.with_file_name("unavailable-config");
        fs::rename(&root, &hidden_root).unwrap();
        assert_eq!(
            manager
                .observe_project_root_unavailable("project")
                .await
                .unwrap_err()
                .code,
            "config.pending.write_failed"
        );
        assert!(!root.exists());
        assert_eq!(
            manager.desired_project_root("project").await,
            Some(root.clone())
        );
        assert!(manager.list_pending_changes().await.is_empty());
        fs::rename(&hidden_root, &root).unwrap();
        let (changed, errors) = manager.refresh_project_roots().await;
        assert!(!changed);
        assert_eq!(errors[0].code, "config.pending.write_failed");
        assert_eq!(
            manager
                .register_project_root("project", metadata.path().into())
                .await
                .unwrap_err()
                .code,
            "config.pending.write_failed"
        );
        assert_eq!(fs::read(&pending_path).unwrap(), before);
        assert!(manager.accept_pending_change(&original.id).await.is_err());
        fs::remove_file(failure).unwrap();
        let (changed, errors) = manager.refresh_project_roots().await;
        assert!(changed);
        assert!(errors.is_empty());
        assert!(manager.accept_pending_change(&original.id).await.is_err());
        let renewed = manager.list_pending_changes().await.pop().unwrap();
        assert_ne!(renewed.id, original.id);
        manager.accept_pending_change(&renewed.id).await.unwrap();
    }

    #[tokio::test]
    async fn project_operations_revalidate_identity_after_waiting_for_the_file_lock() {
        for operation in ["accept", "reject", "patch", "reload", "load"] {
            for locked_file in ["document", "approved", "pending", "publication"] {
                let (_temp, manager) = manager().await;
                let metadata = tempfile::tempdir().unwrap();
                let root = manager
                    .register_project_root("project", metadata.path().into())
                    .await
                    .unwrap();
                let scope = ConfigScope::Project {
                    project_id: "project".into(),
                };
                let kind = ConfigDocumentKind::Tools;
                let document = manager.get_document(kind, scope.clone()).await.unwrap();
                let request = ConfigPatchRequest {
                    kind,
                    scope: scope.clone(),
                    expected_etag: document.etag,
                    patch: vec![JsonPatchOperation {
                        op: "add".into(),
                        path: "/riskLevel".into(),
                        from: None,
                        value: Some(json!("strict")),
                    }],
                    source: ConfigChangeSource::Agent,
                };
                let pending = if matches!(operation, "accept" | "reject") {
                    manager
                        .apply_patch(request.clone())
                        .await
                        .unwrap()
                        .pending_change
                } else {
                    None
                };
                let key = DocumentKey {
                    kind,
                    scope: scope.clone(),
                };
                let approved_path = approved_document_path(manager.root(), &key);
                let pending_path = pending_document_path(manager.root(), &key);
                let approved_before = fs::read(&approved_path).unwrap();
                let pending_before = fs::read(&pending_path).ok();
                let path = root.join(kind.file_name());
                let document_before = fs::read(&path).unwrap();
                let local_lock = manager.document_lock(&key).await;
                let locked_path = match locked_file {
                    "document" => path.clone(),
                    "approved" => approved_path.clone(),
                    "pending" => pending_path.clone(),
                    "publication" => publication_document_path(manager.root(), &key),
                    _ => unreachable!(),
                };
                let file_guard = lock_document_file(&locked_path).unwrap();
                let action = async {
                    match operation {
                        "accept" => manager
                            .accept_pending_change(&pending.as_ref().unwrap().id)
                            .await
                            .map(|_| ()),
                        "reject" => manager
                            .reject_pending_change(&pending.as_ref().unwrap().id, true)
                            .await
                            .map(|_| ()),
                        "patch" => manager.apply_patch(request).await.map(|_| ()),
                        "reload" => manager
                            .reload(kind, scope.clone(), ConfigChangeSource::ExternalEditor)
                            .await
                            .map(|_| ()),
                        "load" => {
                            manager
                                .load_document_from_path(kind, scope.clone(), path.clone(), false)
                                .await
                        }
                        _ => unreachable!(),
                    }
                };
                tokio::pin!(action);
                assert!(
                    tokio::time::timeout(std::time::Duration::from_millis(20), &mut action)
                        .await
                        .is_err()
                );
                assert!(
                    local_lock.try_lock().is_err(),
                    "{operation} must hold its document mutex while waiting for the file lock"
                );

                fs::rename(&root, root.with_file_name("previous-config")).unwrap();
                fs::create_dir(&root).unwrap();
                // Identical JSON defeats an etag-only check after the directory changes.
                fs::write(&path, &document_before).unwrap();
                drop(file_guard);
                let error = tokio::time::timeout(std::time::Duration::from_secs(1), &mut action)
                    .await
                    .expect("file lock released")
                    .unwrap_err();
                assert_eq!(
                    error.code, "config.project.root_changed",
                    "{operation}, {locked_file}"
                );
                assert_eq!(
                    fs::read(&path).unwrap(),
                    document_before,
                    "{operation}, {locked_file}"
                );
                assert_eq!(
                    fs::read(&approved_path).unwrap(),
                    approved_before,
                    "{operation}, {locked_file}"
                );
                assert_eq!(
                    fs::read(&pending_path).ok(),
                    pending_before,
                    "{operation}, {locked_file}"
                );
            }
        }
    }

    #[tokio::test]
    async fn failed_project_load_keeps_desired_root_and_recovers_with_the_same_identity() {
        for replace_registered_root in [false, true] {
            let (_temp, manager) = manager().await;
            let metadata = tempfile::tempdir().unwrap();
            let root = if replace_registered_root {
                let root = manager
                    .register_project_root("project", metadata.path().into())
                    .await
                    .unwrap();
                manager
                    .get_document(
                        ConfigDocumentKind::Tools,
                        ConfigScope::Project {
                            project_id: "project".into(),
                        },
                    )
                    .await
                    .unwrap();
                fs::rename(&root, root.with_file_name("previous-config")).unwrap();
                root
            } else {
                metadata
                    .path()
                    .canonicalize()
                    .unwrap()
                    .join("projects/project/config")
            };
            fs::create_dir_all(root.join("tools.json")).unwrap();
            let identity = DirectoryIdentity::read(&root).unwrap();
            if replace_registered_root {
                let (changed, errors) = manager.refresh_project_roots().await;
                assert!(changed, "replacement purges the old cache");
                assert_eq!(errors[0].code, "config.document.read_failed");
            } else {
                assert_eq!(
                    manager
                        .register_project_root("project", metadata.path().into())
                        .await
                        .unwrap_err()
                        .code,
                    "config.document.read_failed"
                );
            }
            assert_eq!(
                manager.desired_project_root("project").await,
                Some(root.clone())
            );
            assert!(manager.get_snapshot(&["project".into()]).await.is_err());
            for _ in 0..2 {
                let (changed, errors) = manager.refresh_project_roots().await;
                assert!(
                    !changed,
                    "failed retry must not invalidate frontend caches again"
                );
                assert_eq!(errors.len(), 1, "watcher backoff still needs the failure");
                assert_eq!(errors[0].code, "config.document.read_failed");
            }
            // A different I/O failure is still not a cache change.
            let lock_path = root.join("tools.json.lock");
            fs::remove_file(&lock_path).unwrap();
            fs::create_dir(&lock_path).unwrap();
            let (changed, errors) = manager.refresh_project_roots().await;
            assert!(!changed);
            assert_eq!(errors[0].code, "config.document.lock_failed");
            fs::remove_dir(&lock_path).unwrap();

            fs::remove_dir(root.join("tools.json")).unwrap();
            let tools = sparse_document(ConfigDocumentKind::Tools);
            atomic_write_json(&root.join("tools.json"), &tools).unwrap();
            let (changed, errors) = manager.refresh_project_roots().await;
            assert!(changed);
            assert!(errors.is_empty());
            assert_eq!(DirectoryIdentity::read(&root).unwrap(), identity);
            let snapshot = manager.get_snapshot(&["project".into()]).await.unwrap();
            let scope = ConfigScope::Project {
                project_id: "project".into(),
            };
            assert!(snapshot.documents.iter().any(|document| {
                document.kind == ConfigDocumentKind::Tools
                    && document.scope == scope
                    && document.value == tools
            }));
            let (changed, errors) = manager.refresh_project_roots().await;
            assert!(!changed);
            assert!(errors.is_empty());
            manager.unregister_project_root("project").await;
            assert!(manager.desired_project_root("project").await.is_none());
        }
    }

    #[tokio::test]
    async fn project_load_retries_preserve_already_loaded_sensitive_proposals() {
        let (_temp, manager) = manager().await;
        let metadata = tempfile::tempdir().unwrap();
        let root = metadata.path().join("projects/project/config");
        fs::create_dir_all(root.join("git.json")).unwrap();
        let mut tools = sparse_document(ConfigDocumentKind::Tools);
        tools["riskLevel"] = json!("strict");
        atomic_write_json(&root.join("tools.json"), &tools).unwrap();
        assert!(manager
            .register_project_root("project", metadata.path().into())
            .await
            .is_err());
        let pending = manager
            .list_pending_changes()
            .await
            .pop()
            .expect("tools proposal loaded before git failed");
        let key = DocumentKey {
            kind: ConfigDocumentKind::Tools,
            scope: pending.scope.clone(),
        };
        let pending_path = pending_document_path(manager.root(), &key);
        let durable = fs::read(&pending_path).unwrap();
        assert!(manager
            .register_project_root("project", metadata.path().into())
            .await
            .is_err());
        let (changed, errors) = manager.refresh_project_roots().await;
        assert!(!changed);
        assert_eq!(errors.len(), 1);
        assert_eq!(manager.list_pending_changes().await[0].id, pending.id);
        assert_eq!(fs::read(&pending_path).unwrap(), durable);
        assert!(
            manager.accept_pending_change(&pending.id).await.is_err(),
            "partially loaded project must remain unusable"
        );

        fs::remove_dir(root.join("git.json")).unwrap();
        atomic_write_json(
            &root.join("git.json"),
            &sparse_document(ConfigDocumentKind::Git),
        )
        .unwrap();
        let (changed, errors) = manager.refresh_project_roots().await;
        assert!(changed);
        assert!(errors.is_empty());
        assert_eq!(manager.list_pending_changes().await[0].id, pending.id);
        assert_eq!(fs::read(&pending_path).unwrap(), durable);
        manager.accept_pending_change(&pending.id).await.unwrap();
    }

    #[tokio::test]
    async fn missing_directory_is_purged_once_and_recovers_without_registration() {
        let (_temp, manager) = manager().await;
        let metadata = tempfile::tempdir().unwrap();
        let root = manager
            .register_project_root("project", metadata.path().into())
            .await
            .unwrap();
        manager
            .get_document(
                ConfigDocumentKind::Git,
                ConfigScope::Project {
                    project_id: "project".into(),
                },
            )
            .await
            .unwrap();
        fs::rename(&root, root.with_file_name("previous-config")).unwrap();
        let (changed, errors) = manager.refresh_project_roots().await;
        assert!(changed);
        assert_eq!(errors[0].code, "config.project.root_missing");
        let (changed, errors) = manager.refresh_project_roots().await;
        assert!(!changed);
        assert!(errors.is_empty());
        assert!(manager.get_snapshot(&[]).await.is_ok());
        assert!(manager.get_snapshot(&["project".into()]).await.is_err());
        fs::create_dir(&root).unwrap();
        assert!(manager.refresh_project_roots().await.0);
        assert!(manager.get_snapshot(&["project".into()]).await.is_ok());
    }

    #[tokio::test]
    async fn repeated_registration_does_not_replace_loaded_documents() {
        let (_temp, manager) = manager().await;
        let metadata = tempfile::tempdir().unwrap();
        manager
            .register_project_root("project", metadata.path().into())
            .await
            .unwrap();
        let scope = ConfigScope::Project {
            project_id: "project".into(),
        };
        let before = manager
            .get_document(ConfigDocumentKind::Git, scope.clone())
            .await
            .unwrap();
        manager
            .register_project_root("project", metadata.path().join("."))
            .await
            .unwrap();
        let after = manager
            .get_document(ConfigDocumentKind::Git, scope)
            .await
            .unwrap();
        assert_eq!(before.etag, after.etag);
        assert_eq!(manager.state.read().await.project_roots.len(), 1);
    }

    #[tokio::test]
    async fn unregister_does_not_deadlock_an_authorized_runtime_snapshot() {
        let (_temp, manager) = manager().await;
        let metadata = tempfile::tempdir().unwrap();
        manager
            .register_project_root("project", metadata.path().into())
            .await
            .unwrap();
        let authority = manager.lock_mcp_runtime_configuration().await;
        let unregister = manager.unregister_project_root("project");
        tokio::pin!(unregister);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut unregister)
                .await
                .is_err()
        );
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            manager.get_snapshot(&["project".into()]),
        )
        .await
        .expect("snapshot must not wait for the unregister holding the registry lock")
        .unwrap();
        drop(authority);
        unregister.await;
    }

    #[tokio::test]
    async fn unregister_waits_for_document_writes_before_forgetting_project() {
        let (_temp, manager) = manager().await;
        let metadata = tempfile::tempdir().unwrap();
        manager
            .register_project_root("project", metadata.path().into())
            .await
            .unwrap();
        let key = DocumentKey {
            kind: ConfigDocumentKind::Git,
            scope: ConfigScope::Project {
                project_id: "project".into(),
            },
        };
        let lock = manager.document_lock(&key).await;
        let guard = lock.lock().await;
        let unregister = manager.unregister_project_root("project");
        tokio::pin!(unregister);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut unregister)
                .await
                .is_err()
        );
        drop(guard);
        unregister.await;
        assert!(manager.state.read().await.project_roots.is_empty());
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
        // Keep the root for automatic retry while rejecting its unsafe configuration.
        assert_eq!(snapshot.code, "config.project.relaxation_forbidden");
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
