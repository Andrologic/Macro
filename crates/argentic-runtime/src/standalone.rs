//! Single-process host using the production Start transaction and supervisor.
//! Loading inputs never starts a provider. Only explicit preflight/Start may
//! observe Codex, and both require the caller's `allow_codex` opt-in.
use crate::{
    api::{self, HumanSubmission, StartSession, StreamTasks},
    host::{
        ActionPolicyLease, ActionPolicySource, HostContext, HostPolicyLease, PolicyFuture,
        PolicySource, ProjectPolicyLease,
    },
    persistence::{
        self,
        dto::*,
        failure,
        flow030::{FlowEffect030, FlowIdentity030},
        flow_store030::{Authority030, CheckFuture, StoreError030},
        start030::{self, RetainedStart030, StartAuthority030, StartCapture030},
        Result,
    },
    Engine,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{SqliteConnection, SqlitePool};
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::sync::{OwnedRwLockReadGuard, RwLock};

/// The exact policy file is approved by its SHA-256 at construction. It cannot
/// change during this process. Agent requests are still intersected with it.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub owner: EngineSourceOwner,
    pub source_revision: String,
    pub permissions: crate::permissions::RequestedPermissions,
    pub read_only: bool,
}
fn digest(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
fn io_error(_: std::io::Error) -> EngineFailure {
    failure(
        "SOURCE_UNAVAILABLE",
        "host",
        "Standalone input or storage is unavailable",
    )
}
fn read(path: &Path) -> Result<Vec<u8>> {
    // A source is a regular file, never a device, directory or unbounded stream.
    let meta = std::fs::symlink_metadata(path).map_err(io_error)?;
    if !meta.file_type().is_file() || meta.len() > 8 * 1024 * 1024 {
        return Err(failure(
            "SOURCE_UNAVAILABLE",
            "host",
            "Expected a regular input file of at most 8 MiB",
        ));
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(io_error)?
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(failure("INPUT_LIMIT", "host", "Input grew beyond 8 MiB"));
    }
    Ok(bytes)
}
struct Inputs {
    workspace: PathBuf,
    scope: Value,
    source_path: PathBuf,
    authored: String,
    source: EngineSourceRevision,
    policy_path: PathBuf,
    policy_bytes: Vec<u8>,
    policy: Policy,
    policy_digest: String,
}
impl Inputs {
    fn verify(&self) -> Result<()> {
        if read(&self.source_path)? != self.authored.as_bytes()
            || read(&self.policy_path)? != self.policy_bytes
            || scope(&self.workspace, &self.policy.owner)? != self.scope
        {
            return Err(failure(
                "CAPTURE_CHANGED",
                "source",
                "Source, approved policy or workspace identity changed",
            ));
        }
        Ok(())
    }
    fn permissions(&self) -> Value {
        // No Macro tools are offered. Native Codex uses its captured sandbox,
        // the approved ceiling and the engine-owned human approval protocol.
        json!({"mode":"Implement", "readOnly":self.policy.read_only,
            "allowedToolIds":[], "riskLevel":"strict", "agsdlHostPermissions":self.policy.permissions})
    }
}
fn scope(root: &Path, owner: &EngineSourceOwner) -> Result<Value> {
    let root = root.canonicalize().map_err(io_error)?;
    let identity = crate::content_io::admitted::workspace_root_identity(&root)
        .map_err(|_| {
            failure(
                "SOURCE_UNAVAILABLE",
                "scope",
                "Workspace identity is unavailable",
            )
        })?
        .observation_key()
        .ok_or_else(|| failure("UNSUPPORTED", "scope", "Workspace identity is unqualified"))?;
    Ok(
        json!({"projectId":owner.project_id,"root":root,"rootIdentity":identity,"sourceOwner":owner}),
    )
}
#[derive(Clone)]
struct Policies(Arc<RwLock<Inputs>>);
impl Policies {
    async fn acquire(&self) -> Result<OwnedRwLockReadGuard<Inputs>> {
        let guard = self.0.clone().read_owned().await;
        guard.verify()?;
        Ok(guard)
    }
}
impl PolicySource for Policies {
    fn lock_project<'a>(&'a self, project: &'a str) -> PolicyFuture<'a, ProjectPolicyLease> {
        Box::pin(async move {
            let guard = self.acquire().await?;
            if project != guard.policy.owner.project_id {
                return Err(failure(
                    "PERMISSION",
                    "project",
                    "Project is outside the approved policy",
                ));
            }
            Ok(ProjectPolicyLease::new(
                json!({"riskLevel":"strict"}),
                guard.policy.permissions.clone(),
                guard,
            ))
        })
    }
    fn lock_ceiling(&self) -> PolicyFuture<'_, HostPolicyLease> {
        Box::pin(async move {
            let guard = self.acquire().await?;
            Ok(HostPolicyLease::new(
                guard.policy.permissions.clone(),
                guard.policy_digest.clone(),
                guard,
            ))
        })
    }
}
impl ActionPolicySource for Policies {
    fn lock_current<'a>(
        &'a self,
        capture: &'a StartCapture030,
        payload: &'a Value,
    ) -> PolicyFuture<'a, ActionPolicyLease> {
        Box::pin(async move {
            use crate::permissions::*;
            let guard = self.acquire().await?;
            let private: Value = serde_json::from_str(&capture.private_capture_json)?;
            let captured_scope: Value = serde_json::from_str(
                private["callScopeJson"]
                    .as_str()
                    .ok_or_else(|| failure("CORRELATION", "scope", "Captured scope is absent"))?,
            )?;
            if capture.source != guard.source || captured_scope != guard.scope {
                return Err(failure(
                    "CAPTURE_CHANGED",
                    "approval",
                    "Current source or scope differs from the capture",
                ));
            }
            let policy = normalize_requested(
                guard.policy.permissions.clone(),
                PathContext {
                    workspace: guard.workspace.clone(),
                    home: std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| {
                        failure("PERMISSION", "approval", "Native home is absent")
                    })?,
                },
            )
            .map_err(|_| {
                failure(
                    "PERMISSION",
                    "approval",
                    "Approved policy cannot be normalized",
                )
            })?;
            let path = payload
                .pointer("/nativeRequest/params/additionalPermissions/fileSystem/write/0")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    failure("CORRELATION", "approval", "Native write scope is absent")
                })?;
            let allowed = !guard.policy.read_only
                && evaluate_requested(&policy, &ActionRequest::Write { path: path.into() })
                    .is_ok_and(|e| e != Effect::Deny)
                && evaluate_requested(
                    &policy,
                    &ActionRequest::Shell {
                        command: payload["nativeRequest"]["params"]["command"]
                            .as_str()
                            .unwrap_or("")
                            .into(),
                    },
                )
                .is_ok_and(|e| e == Effect::Allow);
            Ok(ActionPolicyLease::new(allowed, guard))
        })
    }
}

/// Owns one database lock, engine incarnation and all execution resources.
/// Keep it alive until `shutdown` succeeds, then call `close`. Dropping a value
/// is not a physical Stop receipt. No credentials are read by this API.
pub struct Host {
    engine: Engine,
    pool: SqlitePool,
    tasks: StreamTasks,
    policies: Policies,
    context: HostContext,
    _database_lock: File,
    shutdown_complete: std::sync::atomic::AtomicBool,
}
impl Host {
    /// Opens only this runtime's standalone schema. The data directory must be
    /// outside the workspace. One process owns it; a second open is refused.
    /// An existing run becomes interrupted, never adopted or restarted.
    pub async fn open(
        data: &Path,
        workspace: &Path,
        source: &Path,
        policy: &Path,
        approved_sha256: &str,
    ) -> Result<Self> {
        let workspace = workspace.canonicalize().map_err(io_error)?;
        std::fs::create_dir_all(data).map_err(io_error)?;
        let data = data.canonicalize().map_err(io_error)?;
        if data.starts_with(&workspace) || workspace.starts_with(&data) {
            return Err(failure(
                "PERMISSION",
                "data",
                "Private host data and workspace must not overlap",
            ));
        }
        let policy_bytes = read(policy)?;
        let policy_digest = digest(&policy_bytes);
        if approved_sha256 != policy_digest {
            return Err(failure(
                "PERMISSION",
                "policy",
                "Approve the exact policy SHA-256 before opening the host",
            ));
        }
        let policy_value: Policy = serde_json::from_slice(&policy_bytes)?;
        api::validate_codex_permissions(
            &serde_json::to_value(&policy_value.permissions)?,
            "policy.permissions",
        )?;
        for id in [
            &policy_value.owner.project_id,
            &policy_value.owner.plan_id,
            &policy_value.owner.branch,
        ] {
            persistence::opaque(id)?;
        }
        persistence::decimal(&policy_value.source_revision)?;
        let bytes = read(source)?;
        let source_sha256 = digest(&bytes);
        let authored = String::from_utf8(bytes)
            .map_err(|_| failure("PARSE", "source", "Source must be UTF-8"))?;
        persistence::validate_json(&authored)?;
        let inputs = Inputs {
            scope: scope(&workspace, &policy_value.owner)?,
            workspace,
            source_path: source.to_owned(),
            authored,
            source: EngineSourceRevision {
                owner: policy_value.owner.clone(),
                revision: policy_value.source_revision.clone(),
                source_sha256,
            },
            policy_path: policy.to_owned(),
            policy_bytes,
            policy: policy_value,
            policy_digest,
        };
        inputs.verify()?;
        let lock = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(data.join("engine.lock"))
            .map_err(io_error)?;
        lock.try_lock().map_err(|_| {
            failure(
                "RUNTIME_UNAVAILABLE",
                "data",
                "Standalone database is already owned",
            )
        })?;
        let database = data.join("engine.sqlite");
        if std::fs::symlink_metadata(&database).is_ok_and(|m| !m.file_type().is_file()) {
            return Err(failure(
                "STORAGE",
                "data",
                "Database must be a regular file",
            ));
        }
        let pool = if database.exists() {
            crate::sqlite::open_file(&database).await?
        } else {
            crate::sqlite::create_file(&database).await?
        };
        api::interrupt_previous_runs(&pool).await?;
        let policies = Policies(Arc::new(RwLock::new(inputs)));
        let context = HostContext::new(data, Arc::new(policies.clone()));
        Ok(Self {
            engine: Engine::new(),
            pool,
            tasks: StreamTasks::default(),
            policies,
            context,
            _database_lock: lock,
            shutdown_complete: std::sync::atomic::AtomicBool::new(false),
        })
    }
    /// Returns the source revision authenticated at open, including exact bytes' digest.
    pub async fn source(&self) -> EngineSourceRevision {
        self.policies.0.read().await.source.clone()
    }
    async fn prepare(&self, entry: Option<&EngineEntry>, allow_codex: bool) -> Result<Prepared> {
        let inputs = self.policies.acquire().await?;
        let doc: Value = serde_json::from_str(&inputs.authored)?;
        if let Some(d) = api::product_slice(&inputs.authored, None) {
            return Err(failure(&d.code, &d.pointer, &d.message));
        }
        if doc["contract"] != "agsdl-0.3.0" {
            return Err(failure(
                "UNSUPPORTED_EDITION",
                "/contract",
                "Standalone host requires AgSDL 0.3",
            ));
        }
        if doc["agents"]
            .as_object()
            .is_some_and(|a| a.values().any(|v| v["harness"] != "codex"))
            || api::declared_steps(&doc).any(|(_, s)| s["type"] == "call")
        {
            return Err(failure("UNSUPPORTED", "source", "Standalone host supports Codex and human flows; host calls and other harnesses are unavailable"));
        }
        let uses_codex = doc["agents"].as_object().is_some_and(|a| !a.is_empty());
        if uses_codex && !allow_codex {
            return Err(failure(
                "CODEX_OPT_IN_REQUIRED",
                "source",
                "Explicit Codex opt-in is required for preflight or Start",
            ));
        }
        let observed = if uses_codex {
            api::validate_codex_document(&doc)?;
            let observed =
                api::observe_codex(&self.context, &inputs.scope, inputs.policy.read_only).await?;
            match observed {
                Some(observed) => Some(observed),
                None => {
                    let status = api::codex_status(&self.context).await;
                    return Err(failure(&status.code,"engine","Official private Codex profile is not ready; consult the documented login procedure"));
                }
            }
        } else {
            None
        };
        let (harnesses, agents) = if let Some(observed) = &observed {
            let (h, a) = crate::capture::codex_registry(
                &doc,
                &inputs.source.source_sha256,
                &inputs.scope,
                observed,
            )?;
            (vec![h], a)
        } else {
            (vec![], vec![])
        };
        let observation = match &observed {
            Some(o) => {
                json!({"profile":o.profile.identity(),"accountDigest":o.account_digest,"models":o.models,"version":o.version})
            }
            None => Value::Null,
        };
        let mut registry = json!({"format":"macro-agsdl-registry/030", "modules":[{"harness":"codex","moduleJson":api::codex_module()}],
            "harnesses":harnesses,"agents":agents,"hostCapabilities": if cfg!(all(target_os="macos",target_arch="aarch64")) {
                json!([{"name":"approval","support":"native","evidenceJson":"{\"runtime\":\"flow-human-clock\"}"}])
            } else { json!([]) }});
        registry["version"] = json!(format!(
            "sha256:{}",
            digest(serde_json::to_vec(&(
                &registry,
                &observation,
                &inputs.scope,
                inputs.permissions()
            ))?)
        ));
        registry["startEntry"] = serde_json::to_value(entry)?;
        let compiled = self
            .engine
            .compile_document(
                inputs.source.clone(),
                inputs.authored.clone(),
                registry.to_string(),
            )
            .await?;
        let result: Value = serde_json::from_str(&compiled.result_json)?;
        if result.pointer("/static/valid") != Some(&json!(true))
            || result.pointer("/runtime/supported") != Some(&json!(true))
        {
            return Err(failure("UNSUPPORTED", "source", &result.to_string()));
        }
        Ok(Prepared {
            result,
            observation,
            scope: inputs.scope.clone(),
            permissions: inputs.permissions(),
            generation: compiled.generation,
        })
    }
    /// Explicitly observes Codex when needed; does not admit or start any work.
    pub async fn preflight(&self, entry: Option<&EngineEntry>, allow_codex: bool) -> Result<Value> {
        Ok(self.prepare(entry, allow_codex).await?.result)
    }
    /// Idempotent native Start. The private adapter retains real source/policy
    /// guards and delegates ownership and commit acknowledgement to the session.
    pub async fn start(
        &self,
        request_id: String,
        entry: Option<EngineEntry>,
        allow_codex: bool,
    ) -> Result<RetainedStart030> {
        let session = self.engine.begin_start().await?;
        let request = EngineStartRequest {
            source: self.source().await,
            profile: "macro-agsdl-030-v1".into(),
            associations: EngineAssociations::default(),
            request_id,
            entry,
        };
        let adapter = Start {
            host: self,
            session: &session,
            prepared: Mutex::new(None),
            capture: Mutex::new(None),
            allow_codex,
        };
        let retained = match start030::start(&self.pool, &request, &adapter).await {
            Ok(r) => r,
            Err(e) => {
                if let Some(c) = adapter
                    .capture
                    .lock()
                    .map_err(|_| failure("RUNTIME_UNAVAILABLE", "start", "Capture unavailable"))?
                    .as_ref()
                {
                    session.fail_reservation(&c.identity.system_start_id, e.clone());
                }
                return Err(e);
            }
        };
        if adapter
            .capture
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "start", "Capture unavailable"))?
            .is_some()
        {
            if let Err(e) = session
                .attach_committed_start(
                    &self.pool,
                    self.context.clone(),
                    self.tasks.clone(),
                    &retained.receipt.identity,
                    &retained.capture,
                    Arc::new(self.policies.clone()),
                )
                .await
            {
                session
                    .interrupt_run(&self.pool, &retained.receipt.identity.system_start_id)
                    .await?;
                session.fail_reservation(&retained.receipt.identity.system_start_id, e.clone());
                return Err(e);
            }
        }
        Ok(retained)
    }
    /// Captured source identities and receipts, including interrupted earlier runs.
    pub async fn runs(&self) -> Result<Vec<Value>> {
        let rows: Vec<(String, String, bool)> = sqlx::query_as("SELECT s.receipt_json,s.capture_json,EXISTS(SELECT 1 FROM engine_flow030_interruptions i WHERE i.system_id=s.system_id) FROM engine_start030_requests s ORDER BY s.request_id")
            .fetch_all(&self.pool).await?;
        rows.into_iter().map(|(receipt,capture,interrupted)| {
            let capture:StartCapture030=serde_json::from_str(&capture)?;
            Ok(json!({"receipt":serde_json::from_str::<Value>(&receipt)?,"source":capture.source,"interrupted":interrupted}))
        }).collect()
    }
    pub async fn projection(
        &self,
        query: api::RuntimeProjectionQuery030,
        next: Option<api::RuntimeProjectionContinuation030>,
    ) -> Result<api::RuntimeProjectionPage030> {
        self.engine
            .runtime_projection(&self.pool, query, next)
            .await
    }
    pub async fn humans(
        &self,
        scope: persistence::public030::HumanScope030,
        next: Option<persistence::public030::HumanContinuation030>,
    ) -> Result<persistence::public030::HumanPage030> {
        self.engine.human_page(&self.pool, scope, next).await
    }
    pub async fn submit_person(&self, answer: HumanSubmission) -> Result<String> {
        self.engine.submit_person(&self.pool, answer).await
    }
    pub async fn deliver(&self, input: api::DeliveryRequest030) -> Result<api::DeliveryReceipt030> {
        self.engine.deliver_message(&self.pool, input).await
    }
    pub async fn stop(
        &self,
        request: EngineStopRequest,
    ) -> Result<persistence::public::PublicStopState> {
        self.engine
            .request_stop(&self.pool, &self.tasks, &request)
            .await
    }
    pub async fn active_runs(&self) -> Result<Vec<String>> {
        self.engine.shutdown_active_runs(&self.pool).await
    }
    pub fn shutdown_started(&self) -> bool {
        self.engine.shutdown_started()
    }
    /// Consent only limits retirement. A timeout or error does not reopen Starts.
    pub async fn shutdown(&self, approved: &[String]) -> Result<()> {
        self.engine
            .prepare_shutdown(&self.pool, &self.tasks, approved)
            .await?;
        self.shutdown_complete
            .store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
    /// Releases storage only after real retirement. Failure retains the host so
    /// the caller can inspect and retry instead of discarding physical owners.
    pub async fn close(&self) -> Result<()> {
        if !self
            .shutdown_complete
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err(failure(
                "SHUTDOWN_PENDING",
                "host",
                "Complete native shutdown before closing storage",
            ));
        }
        self.pool.close().await;
        Ok(())
    }
}
struct Prepared {
    result: Value,
    observation: Value,
    scope: Value,
    permissions: Value,
    generation: String,
}
struct Start<'a> {
    host: &'a Host,
    session: &'a StartSession<'a>,
    prepared: Mutex<Option<Prepared>>,
    capture: Mutex<Option<StartCapture030>>,
    allow_codex: bool,
}
impl Authority030 for Start<'_> {
    fn owner<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        id: &'a FlowIdentity030,
    ) -> CheckFuture<'a> {
        Box::pin(async move {
            let capture = self
                .capture
                .lock()
                .map_err(|_| StoreError030::Authority)?
                .clone();
            self.session.check_owner_tx(db, id, capture.as_ref()).await
        })
    }
    fn effect<'a>(&'a self, _: &'a mut SqliteConnection, _: &'a FlowEffect030) -> CheckFuture<'a> {
        Box::pin(async { Err(StoreError030::Authority) })
    }
    fn settlement<'a>(
        &'a self,
        _: &'a mut SqliteConnection,
        _: &'a FlowEffect030,
        _: &'a Value,
    ) -> CheckFuture<'a> {
        Box::pin(async { Err(StoreError030::Authority) })
    }
    fn owner_epoch(&self) -> &str {
        "0"
    }
}
impl StartAuthority030 for Start<'_> {
    type SourceGuard = (
        OwnedRwLockReadGuard<Inputs>,
        tokio::sync::OwnedMutexGuard<()>,
    );
    fn require_clear(&self, r: &EngineStartRequest) -> Result<()> {
        self.session.require_clear(r)
    }
    fn begin_commit(&self, r: &EngineStartRequest, id: &FlowIdentity030) -> Result<()> {
        self.session.begin_commit(r, id, true)
    }
    fn commit_acknowledged(&self, r: &EngineStartRequest, id: &FlowIdentity030) {
        self.session.commit_acknowledged(r, id)
    }
    async fn capture(&self, r: &EngineStartRequest) -> Result<StartCapture030> {
        let p = self
            .host
            .prepare(r.entry.as_ref(), self.allow_codex)
            .await?;
        let inputs = self.host.policies.acquire().await?;
        if r.source != inputs.source || p.generation != self.session.generation() {
            return Err(failure(
                "CAPTURE_CHANGED",
                "source",
                "Source or engine changed",
            ));
        }
        let plan = p.result["compiledPlanJson"]
            .as_str()
            .ok_or_else(|| failure("CORRELATION", "plan", "Compiled plan absent"))?;
        let plan_value: Value = serde_json::from_str(plan)?;
        let capture=StartCapture030 {
            identity:FlowIdentity030 {system_start_id:uuid::Uuid::new_v4().to_string(),flow_invocation_id:uuid::Uuid::new_v4().to_string(),snapshot_id:uuid::Uuid::new_v4().to_string(),epoch:uuid::Uuid::new_v4().to_string()},
            source:inputs.source.clone(),versions:serde_json::from_value(plan_value["versions"].clone())?,authored_source:inputs.authored.clone(),compiled_plan_json:plan.into(),
            registry_json:p.result["capturedRegistryJson"].as_str().ok_or_else(||failure("CORRELATION","registry","Captured registry absent"))?.into(),
            private_capture_json:json!({"format":"macro-native-flow-capture/030","generation":p.generation,
                "callScopeJson":p.scope.to_string(),"callPermissionsJson":p.permissions.to_string(),"nativeCatalogueJson":p.observation.to_string(),
                "displayCardsJson":"[]","associations":r.associations,"entryUnassessed":p.result["entryValidation"]["unassessed"]}).to_string(),
        };
        start030::validate_capture(r, &capture)?;
        *self
            .capture
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "start", "Capture unavailable"))? =
            Some(capture.clone());
        *self
            .prepared
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "start", "Preparation unavailable"))? =
            Some(p);
        Ok(capture)
    }
    async fn lock_source(&self, r: &EngineStartRequest) -> Result<Self::SourceGuard> {
        let current = self
            .host
            .prepare(r.entry.as_ref(), self.allow_codex)
            .await?;
        let guard = self.host.policies.acquire().await?;
        {
            let old = self
                .prepared
                .lock()
                .map_err(|_| failure("RUNTIME_UNAVAILABLE", "start", "Preparation unavailable"))?;
            let old = old
                .as_ref()
                .ok_or_else(|| failure("CORRELATION", "start", "Preparation absent"))?;
            if current.result != old.result
                || current.observation != old.observation
                || current.scope != old.scope
                || current.permissions != old.permissions
                || current.generation != old.generation
            {
                return Err(failure(
                    "CAPTURE_CHANGED",
                    "source",
                    "Native capture changed before commit",
                ));
            }
        }
        let admission = self.session.lock_admission().await;
        self.session.require_clear(r)?;
        Ok((guard, admission))
    }
    async fn bind_capture_tx(
        &self,
        db: &mut SqliteConnection,
        _: &EngineStartRequest,
        c: &StartCapture030,
    ) -> Result<()> {
        self.session.bind_capture_tx(db, c).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        _temp: tempfile::TempDir,
        data: PathBuf,
        workspace: PathBuf,
        source: PathBuf,
        policy: PathBuf,
        digest: String,
    }
    impl Fixture {
        fn new(source: &str) -> Self {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path();
            let workspace = root.join("workspace");
            std::fs::create_dir(&workspace).unwrap();
            let source_path = root.join("source.json");
            std::fs::write(&source_path, source).unwrap();
            let policy = root.join("policy.json");
            let bytes=br#"{"owner":{"projectId":"project","planId":"plan","branch":"standalone"},"sourceRevision":"1","permissions":"workspace","readOnly":false}"#;
            std::fs::write(&policy, bytes).unwrap();
            let data = root.join("data");
            Self {
                _temp: temp,
                data,
                workspace,
                source: source_path,
                policy,
                digest: digest(bytes),
            }
        }
        async fn open(&self) -> Result<Host> {
            Host::open(
                &self.data,
                &self.workspace,
                &self.source,
                &self.policy,
                &self.digest,
            )
            .await
        }
    }
    const WAIT: &str = r#"{"contract":"agsdl-0.3.0","id":"standalone","agents":{},"flow":{"entry":"wait","steps":{"wait":{"type":"approval","title":"Continue?","timeoutMs":86400000,"next":{"yes":[],"no":[]}}}}}"#;
    fn entry() -> Option<EngineEntry> {
        Some(EngineEntry {
            delivery_id: "entry".into(),
            message_json: "{}".into(),
        })
    }
    #[test]
    fn operational_write_review_fixture_stays_inside_the_existing_codex_slice() {
        let raw = include_str!("../examples/fixtures/write-review.json");
        let doc: Value = serde_json::from_str(raw).unwrap();
        api::validate_codex_document(&doc).unwrap();
        assert!(api::product_slice(raw, None).is_none());
        let _: Policy =
            serde_json::from_str(include_str!("../examples/fixtures/policy.json")).unwrap();
    }
    #[tokio::test]
    async fn approved_inputs_lock_storage_and_refuse_mutation_before_any_provider() {
        let f = Fixture::new(WAIT);
        assert_eq!(
            Host::open(&f.data, &f.workspace, &f.source, &f.policy, "unapproved")
                .await
                .err()
                .unwrap()
                .code,
            "PERMISSION"
        );
        assert!(!f.data.join("engine.sqlite").exists());
        let host = f.open().await.unwrap();
        assert_eq!(f.open().await.err().unwrap().code, "RUNTIME_UNAVAILABLE");
        assert!(host.close().await.is_err());
        std::fs::write(&f.source, format!("{WAIT} ")).unwrap();
        assert_eq!(
            host.preflight(entry().as_ref(), false)
                .await
                .unwrap_err()
                .code,
            "CAPTURE_CHANGED"
        );
        std::fs::write(&f.source, WAIT).unwrap();
        std::fs::write(&f.policy, "{}").unwrap();
        assert_eq!(
            host.start("changed".into(), entry(), false)
                .await
                .err()
                .unwrap()
                .code,
            "CAPTURE_CHANGED"
        );
        host.shutdown(&[]).await.unwrap();
        host.close().await.unwrap();
    }
    #[tokio::test]
    async fn codex_requires_explicit_opt_in_and_other_harnesses_and_calls_stay_refused() {
        for (source, expected) in [
            (
                r#"{"contract":"agsdl-0.3.0","id":"optin","agents":{"worker":{"harness":"codex","permissions":"workspace"}},"flow":{"entry":"work","steps":{"work":{"type":"agent","agent":"worker","next":[]}}}}"#,
                "CODEX_OPT_IN_REQUIRED",
            ),
            (
                r#"{"contract":"agsdl-0.3.0","id":"other","agents":{"worker":{"harness":"pi"}},"flow":{"entry":"work","steps":{"work":{"type":"agent","agent":"worker"}}}}"#,
                "UNSUPPORTED_030_FEATURE",
            ),
            (
                r#"{"contract":"agsdl-0.3.0","id":"call","agents":{},"flow":{"entry":"call","steps":{"call":{"type":"call","command":"true"}}}}"#,
                "UNSUPPORTED",
            ),
        ] {
            let f = Fixture::new(source);
            let host = f.open().await.unwrap();
            assert_eq!(
                host.preflight(entry().as_ref(), false)
                    .await
                    .unwrap_err()
                    .code,
                expected
            );
            assert!(host.runs().await.unwrap().is_empty());
            host.shutdown(&[]).await.unwrap();
            host.close().await.unwrap();
        }
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[tokio::test]
    async fn standalone_real_start_human_submission_stop_and_reopen() {
        let f = Fixture::new(WAIT);
        let host = f.open().await.unwrap();
        let started = host.start("start".into(), entry(), false).await.unwrap();
        let replay = host.start("start".into(), entry(), false).await.unwrap();
        assert_eq!(started.receipt, replay.receipt);
        let id = started.receipt.identity.system_start_id.clone();
        let scope = persistence::public030::HumanScope030 {
            system_start_id: id.clone(),
            source: started.capture.source.clone(),
        };
        let page = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let page = host.humans(scope.clone(), None).await.unwrap();
                if !page.requests.is_empty() {
                    break page;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let request = &page.requests[0];
        let stale = HumanSubmission {
            scope: scope.clone(),
            request_id: request.id.clone(),
            expected_revision: "foreign".into(),
            answer: api::HumanAnswer030::Approval {
                choice: "yes".into(),
                comment: String::new(),
            },
        };
        assert!(host.submit_person(stale).await.is_err());
        host.submit_person(HumanSubmission {
            scope: scope.clone(),
            request_id: request.id.clone(),
            expected_revision: request.revision.clone(),
            answer: api::HumanAnswer030::Approval {
                choice: "yes".into(),
                comment: "Reviewed".into(),
            },
        })
        .await
        .unwrap();
        host.stop(EngineStopRequest {
            system_start_id: id.clone(),
            request_id: "stop".into(),
            activation_id: None,
        })
        .await
        .unwrap();
        let query = api::RuntimeProjectionQuery030 {
            system_start_id: id,
            source: scope.source,
            snapshot_id: None,
        };
        assert!(host
            .projection(query.clone(), None)
            .await
            .unwrap()
            .verdict
            .is_some());
        let approved = host.active_runs().await.unwrap();
        host.shutdown(&approved).await.unwrap();
        assert_eq!(
            host.start("later".into(), entry(), false)
                .await
                .err()
                .unwrap()
                .code,
            "RUNTIME_UNAVAILABLE"
        );
        host.close().await.unwrap();
        drop(host);
        let reopened = f.open().await.unwrap();
        assert_eq!(reopened.runs().await.unwrap().len(), 1);
        assert!(reopened
            .projection(query, None)
            .await
            .unwrap()
            .verdict
            .is_some());
        assert!(reopened.active_runs().await.unwrap().is_empty());
        reopened.shutdown(&[]).await.unwrap();
        reopened.close().await.unwrap();
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[tokio::test]
    async fn restart_marks_unfinished_run_interrupted_without_adoption() {
        const CHILD: &str = "ARGENTIC_SYNTHETIC_CRASH_ROOT";
        if let Some(root) = std::env::var_os(CHILD) {
            let root = PathBuf::from(root);
            let bytes = std::fs::read(root.join("policy.json")).unwrap();
            let host = Host::open(
                &root.join("data"),
                &root.join("workspace"),
                &root.join("source.json"),
                &root.join("policy.json"),
                &digest(bytes),
            )
            .await
            .unwrap();
            host.start("before-crash".into(), entry(), false)
                .await
                .unwrap();
            std::process::exit(0);
        }
        let f = Fixture::new(WAIT);
        let child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "standalone::tests::restart_marks_unfinished_run_interrupted_without_adoption",
                "--nocapture",
            ])
            .env(CHILD, f._temp.path())
            .output()
            .await
            .unwrap();
        assert!(
            child.status.success(),
            "{}",
            String::from_utf8_lossy(&child.stderr)
        );
        let host = f.open().await.unwrap();
        let runs = host.runs().await.unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0]["interrupted"], true);
        assert!(host.active_runs().await.unwrap().is_empty());
        assert!(host
            .start("before-crash".into(), entry(), false)
            .await
            .is_err());
        assert_eq!(host.runs().await.unwrap().len(), 1);
        host.shutdown(&[]).await.unwrap();
        host.close().await.unwrap();
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[tokio::test]
    async fn failed_retirement_keeps_host_inspectable_but_cannot_close_or_restart() {
        let f = Fixture::new(WAIT);
        let host = f.open().await.unwrap();
        let started = host.start("start".into(), entry(), false).await.unwrap();
        let human_scope = persistence::public030::HumanScope030 {
            system_start_id: started.receipt.identity.system_start_id.clone(),
            source: started.capture.source.clone(),
        };
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if !host
                    .humans(human_scope.clone(), None)
                    .await
                    .unwrap()
                    .requests
                    .is_empty()
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        sqlx::query("CREATE TRIGGER reject_standalone_stop BEFORE INSERT ON engine_flow030_events WHEN NEW.event_id LIKE 'retire:%' BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END")
            .execute(&host.pool).await.unwrap();
        let active = host.active_runs().await.unwrap();
        assert!(host.shutdown(&active).await.is_err());
        assert!(host.shutdown_started());
        assert!(host.close().await.is_err());
        assert_eq!(host.runs().await.unwrap().len(), 1);
        assert_eq!(
            host.start("new".into(), entry(), false)
                .await
                .err()
                .unwrap()
                .code,
            "SHUTDOWN_PENDING"
        );
        sqlx::query("DROP TRIGGER reject_standalone_stop")
            .execute(&host.pool)
            .await
            .unwrap();
        host.shutdown(&active).await.unwrap();
        host.close().await.unwrap();
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[tokio::test]
    async fn current_action_policy_retains_real_input_guard_and_refuses_foreign_capture() {
        let f = Fixture::new(WAIT);
        let host = f.open().await.unwrap();
        let started = host.start("start".into(), entry(), false).await.unwrap();
        let file = f.workspace.join("existing.txt");
        std::fs::write(&file, "before").unwrap();
        let payload = json!({"nativeRequest":{"params":{"command":"printf after > existing.txt","additionalPermissions":{"fileSystem":{"write":[file]}}}}});
        let lease = host
            .policies
            .lock_current(&started.capture, &payload)
            .await
            .unwrap();
        assert!(lease.allows());
        assert!(host.policies.0.try_write().is_err());
        drop(lease);
        assert!(host.policies.0.try_write().is_ok());
        let mut outside = payload.clone();
        outside["nativeRequest"]["params"]["additionalPermissions"]["fileSystem"]["write"] =
            json!([f._temp.path().join("outside.txt")]);
        assert!(!host
            .policies
            .lock_current(&started.capture, &outside)
            .await
            .unwrap()
            .allows());
        let mut foreign = started.capture.clone();
        foreign.source.owner.project_id = "foreign".into();
        assert!(host
            .policies
            .lock_current(&foreign, &payload)
            .await
            .is_err());
        let active = host.active_runs().await.unwrap();
        host.shutdown(&active).await.unwrap();
        host.close().await.unwrap();
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[tokio::test]
    async fn standalone_retry_retains_stop_and_requires_consent() {
        let f = Fixture::new(WAIT);
        let host = f.open().await.unwrap();
        host.start("start".into(), entry(), false).await.unwrap();
        assert_eq!(
            host.shutdown(&[]).await.unwrap_err().code,
            "SHUTDOWN_ACTIVITY_CHANGED"
        );
        assert!(!host.shutdown_started());
        let approved = host.active_runs().await.unwrap();
        host.shutdown(&approved).await.unwrap();
        assert!(host.shutdown_started());
        host.shutdown(&approved).await.unwrap();
        host.close().await.unwrap();
    }
}
