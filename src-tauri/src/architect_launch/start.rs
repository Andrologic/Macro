use super::*;
use crate::agsdl_host::HostState;
use crate::agsdl_host_capture::{self as capture, CompilationCapture};
use crate::db::agsdl_execution::{
    dto::{EngineEntry, EngineSourceRevision, EngineStartRequest},
    flow030::{FlowEffect030, FlowIdentity030},
    flow_store030::{Authority030, CheckFuture, StoreError030},
    start030::{self, RetainedStart030, StartAuthority030, StartCapture030},
};
use argentic_runtime::{
    api::{CodexObservation, StartSession, StreamTasks},
    host::ActionPolicySource,
};
use std::{fs, sync::Arc};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LaunchRequest {
    pub version: VersionKey,
    pub configuration: LaunchConfiguration,
    pub start_message: Option<String>,
    pub name: Option<String>,
    pub consent_token: Option<String>,
}

pub(crate) struct Runtime<'a> {
    pub host: &'a HostState,
    pub manager: &'a ConfigManager,
    pub pool: &'a SqlitePool,
    pub app_data: &'a Path,
    pub tasks: StreamTasks,
    pub action_policy: Arc<dyn ActionPolicySource>,
}

fn launch_failure(code: &str, pointer: &str) -> crate::db::agsdl_execution::dto::EngineFailure {
    failure(code, pointer, "The archive launch could not be admitted")
}

// Lot E must hold an exclusive lease on this same file while reading
// architect_launch_runs and removing unreferenced snapshots.
pub(crate) async fn snapshot_lease(host_root: &Path, exclusive: bool) -> Result<File> {
    let path = host_root.join(".agsdl-snapshot-lifetime.lock");
    tokio::task::spawn_blocking(move || {
        let mut options = fs::OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let file = options.open(path)?;
        if exclusive {
            fs2::FileExt::lock_exclusive(&file)?;
        } else {
            fs2::FileExt::lock_shared(&file)?;
        }
        Ok::<_, std::io::Error>(file)
    })
    .await
    .map_err(|_| launch_failure("STORAGE", "projectSnapshot"))?
    .map_err(|_| launch_failure("STORAGE", "projectSnapshot"))
}

pub(super) fn scope_for(folder: &Path, owner: &EngineSourceOwner) -> Result<Value> {
    let identity = crate::fs::operations::workspace_root_identity(folder)
        .ok()
        .and_then(|identity| identity.observation_key())
        .ok_or_else(|| launch_failure("WORKING_FOLDER_UNAVAILABLE", "workingFolder"))?;
    Ok(json!({
        "projectId": owner.project_id, "sourceOwner": owner,
        "root": folder, "rootIdentity": identity,
    }))
}

pub(crate) async fn launch(
    runtime: Runtime<'_>,
    request: LaunchRequest,
) -> Result<RetainedStart030> {
    let input = VersionInput::read(
        runtime.pool,
        &Storage::new(runtime.app_data),
        request.version,
    )
    .await?;
    let preview = input.preview()?;
    if let Some(blocker) = requirements(&input, &preview)?.first() {
        return Err(launch_failure(blocker.code, &blocker.subject));
    }

    let session = runtime.host.begin_start().await?;
    let context = runtime.manager.engine_context();
    let _snapshots = snapshot_lease(context.root(), false).await?;
    let retained = input.archive.source().retain(context.root())?;
    let mut configuration = request.configuration;
    let private_folder;
    let owns_folder = input.settings.working_folder_mode == WorkingFolderMode::PerExecution;
    let folder = if owns_folder {
        configuration.working_folder = None;
        let root = runtime.app_data.join("agsdl-working-folders");
        fs::create_dir_all(&root).map_err(|_| launch_failure("STORAGE", "workingFolder"))?;
        private_folder = tempfile::Builder::new()
            .prefix("run-")
            .tempdir_in(root)
            .map_err(|_| launch_failure("STORAGE", "workingFolder"))?;
        private_folder
            .keep()
            .canonicalize()
            .map_err(|_| launch_failure("STORAGE", "workingFolder"))?
    } else {
        let folder = configuration
            .working_folder
            .as_deref()
            .and_then(|path| chosen_folder(path, runtime.app_data, context.root()))
            .ok_or_else(|| launch_failure("workingFolderRequired", "workingFolder"))?;
        configuration.working_folder = Some(folder.clone());
        folder
    };

    let result = admit(
        &runtime,
        &session,
        &input,
        &preview,
        configuration,
        &folder,
        owns_folder,
        retained,
        request.start_message,
        request.name,
        request.consent_token,
    )
    .await;
    if owns_folder && result.is_err() {
        // A failed acknowledgement can still have committed. Keep the folder
        // unless a fresh read confirms there is no durable owner.
        let referenced = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM architect_launch_runs WHERE working_folder=?)",
        )
        .bind(folder.to_str())
        .fetch_one(runtime.pool)
        .await;
        if matches!(referenced, Ok(false)) {
            let _ = fs::remove_dir(&folder);
        }
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn admit(
    runtime: &Runtime<'_>,
    session: &StartSession<'_>,
    input: &VersionInput,
    preview: &ImportPreview,
    configuration: LaunchConfiguration,
    folder: &Path,
    owns_folder: bool,
    retained: argentic_runtime::source::RetainedSource,
    message: Option<String>,
    name: Option<String>,
    token: Option<String>,
) -> Result<RetainedStart030> {
    let source = EngineSourceRevision {
        owner: owner(&input.key.blueprint_id),
        revision: input.key.number.to_string(),
        source_sha256: input.archive.source().source_sha256(),
    };
    let root_scope = scope_for(folder, &source.owner)?;
    let mut scope = root_scope.clone();
    retained.bind_scope(&mut scope)?;
    let snapshot = scope["projectSnapshot"]
        .as_str()
        .ok_or_else(|| launch_failure("CORRELATION", "projectSnapshot"))?;
    let message = message.unwrap_or_default();
    let entry = if preview.entry_point.is_some() {
        if input.requires_start_message(preview) && message.trim().is_empty() {
            return Err(launch_failure("START_MESSAGE_REQUIRED", "startMessage"));
        }
        Some(EngineEntry {
            delivery_id: Uuid::new_v4().to_string(),
            message_json: if input.requires_start_message(preview) {
                json!({ "prompt": message }).to_string()
            } else {
                "{}".into()
            },
        })
    } else {
        None
    };
    let request = EngineStartRequest {
        source,
        profile: "macro-agsdl-030-v1".into(),
        associations: Default::default(),
        request_id: Uuid::new_v4().to_string(),
        entry,
    };

    let policy = runtime
        .manager
        .lock_execution_tools(PROJECT_ID)
        .await
        .map_err(|_| launch_failure("PERMISSION", "policy"))?;
    let mut call_permissions =
        crate::agsdl_host_tools::permissions("Implement", false, &policy.tools)?;
    call_permissions["agsdlHostPermissions"] =
        serde_json::to_value(&policy.agsdl_host_permissions)?;
    let mut summary = permissions(input, preview)?;
    record_host_permissions(&mut summary, &policy.agsdl_host_permissions)?;
    let machine = machine_id(runtime.manager.root())?;
    {
        let mut db = runtime.pool.acquire().await?;
        require_consent(&mut db, input, &summary, &machine, token.as_deref()).await?;
    }
    let authored = input.archive.source().authored_json();
    let document: Value = serde_json::from_str(authored)?;
    let observed = if preview
        .agents
        .values()
        .any(|agent| agent.harness == "codex")
    {
        Some(observe_codex(runtime.manager, &scope).await?)
    } else {
        None
    };
    let native_catalogue = crate::agsdl_host_catalogue::ModelCapture {
        catalogue: crate::agsdl_host_catalogue::NativeModelCatalogue {
            revision: "native-codex".into(),
            models: Vec::new(),
            unavailable_providers: Vec::new(),
        },
        providers: Vec::new(),
        codex_account_digest: observed
            .as_ref()
            .map(|profile| profile.account_digest.clone()),
        claude_account_digest: None,
    };
    let registry = registry(
        &document,
        &request,
        scope.clone(),
        &call_permissions,
        observed.as_ref(),
    )?;
    let compiled = runtime
        .host
        .compile_document(
            request.source.clone(),
            authored.to_owned(),
            registry.to_string(),
        )
        .await
        .map_err(|error| input.archive.source().locate_error(error))?;
    let material = CompilationCapture {
        source: request.source.clone(),
        authored_source: authored.to_owned(),
        native_registry_json: registry.to_string(),
        display_cards_json: "[]".into(),
        native_catalogue,
        result: serde_json::from_str(&compiled.result_json)?,
        generation: compiled.generation,
        call_permissions_json: call_permissions.to_string(),
        call_scope_json: scope.to_string(),
        permission_notice030: false,
    };
    let preflight = material.public();
    if !preflight.runtime_supported || !preflight.static_valid {
        if let Some(diagnostic) = preflight.diagnostics.first() {
            return Err(input.archive.source().locate_error(failure(
                &diagnostic.code,
                &diagnostic.pointer,
                &diagnostic.message,
            )));
        }
    }
    let material = material.start_material030_checked(
        &request.source,
        authored,
        "[]",
        &request,
        session.generation(),
    )?;
    let capture = StartCapture030 {
        identity: FlowIdentity030 {
            system_start_id: Uuid::new_v4().to_string(),
            flow_invocation_id: Uuid::new_v4().to_string(),
            snapshot_id: Uuid::new_v4().to_string(),
            epoch: Uuid::new_v4().to_string(),
        },
        source: material.source,
        versions: material.versions,
        authored_source: material.authored_source,
        compiled_plan_json: material.compiled_plan_json,
        registry_json: material.registry_json,
        private_capture_json: json!({
            "format":"macro-native-flow-capture/030", "generation":material.generation,
            "nativeCatalogueJson":material.native_catalogue_json,
            "callPermissionsJson":material.call_permissions_json,
            "callScopeJson":material.call_scope_json, "displayCardsJson":material.display_cards_json,
            "associations":request.associations, "entryUnassessed":material.entry_unassessed,
        }).to_string(),
    };
    let authority = ArchiveStart {
        session,
        input,
        capture,
        root_scope,
        folder,
        owns_folder,
        snapshot,
        configuration,
        summary,
        machine,
        token,
        name: name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty()),
    };
    let started = start030::start(runtime.pool, &request, &authority).await;
    // Attachment observes policy itself. In particular, do not hold a
    // config read lease across this boundary.
    drop(policy);
    let identity = &authority.capture.identity;
    let result = match started {
        Ok(started) => session
            .attach_committed_start(
                runtime.pool,
                runtime.manager.engine_context(),
                runtime.tasks.clone(),
                identity,
                &authority.capture,
                runtime.action_policy.clone(),
            )
            .await
            .map(|()| started),
        Err(error) => Err(error),
    };
    if let Err(error) = &result {
        session
            .interrupt_run(runtime.pool, &identity.system_start_id)
            .await?;
        session.fail_reservation(&identity.system_start_id, error.clone());
    }
    result
}

async fn require_consent(
    db: &mut SqliteConnection,
    input: &VersionInput,
    summary: &Permissions,
    machine: &str,
    proposed: Option<&str>,
) -> Result<()> {
    if let Some(expected) = consent_token(db, input, summary, machine).await? {
        if proposed != Some(expected.as_str()) {
            return Err(launch_failure("CONSENT_REQUIRED", "permissions"));
        }
    }
    Ok(())
}

pub(super) async fn observe_codex(
    manager: &ConfigManager,
    scope: &Value,
) -> Result<CodexObservation> {
    #[cfg(test)]
    if let Some(observed) = capture::test_codex_observations030()
        .lock()
        .unwrap()
        .get(manager.root())
        .cloned()
    {
        return Ok(observed);
    }
    let context = manager.engine_context();
    if let Some(observed) = argentic_runtime::api::observe_codex(&context, scope, false).await? {
        return Ok(observed);
    }
    let status = argentic_runtime::api::codex_status(&context).await;
    Err(launch_failure(&status.code, "codex"))
}

fn registry(
    document: &Value,
    request: &EngineStartRequest,
    scope: Value,
    call_permissions: &Value,
    observed: Option<&CodexObservation>,
) -> Result<Value> {
    let (harnesses, agents) = if let Some(observed) = observed {
        let (harness, agents) =
            capture::codex_registry030(document, &request.source.source_sha256, &scope, observed)?;
        (vec![harness], agents)
    } else {
        (Vec::new(), Vec::new())
    };
    let mut registry = json!({
        "format":"macro-agsdl-registry/030",
        "modules":[{"harness":"codex", "moduleJson":argentic_runtime::api::codex_module()}],
        "harnesses":harnesses, "agents":agents,
        "hostCapabilities": if cfg!(all(target_os="macos", target_arch="aarch64")) {
            json!([{"name":"approval","support":"native","evidenceJson":"{\"runtime\":\"flow-human-clock\"}"},{"name":"call.command","support":"native","evidenceJson":"{\"transport\":\"confined-local\"}"}])
        } else { json!([]) }
    });
    let digest = Sha256::digest(serde_json::to_vec(&(&registry, &scope, call_permissions))?);
    registry["version"] = json!(format!("sha256:{digest:x}"));
    registry["callPermissions"] = call_permissions.clone();
    registry["callScope"] = scope;
    registry["startEntry"] = serde_json::to_value(&request.entry)?;
    Ok(registry)
}

struct ArchiveStart<'a> {
    session: &'a StartSession<'a>,
    input: &'a VersionInput,
    capture: StartCapture030,
    root_scope: Value,
    folder: &'a Path,
    owns_folder: bool,
    snapshot: &'a str,
    configuration: LaunchConfiguration,
    summary: Permissions,
    machine: String,
    token: Option<String>,
    name: Option<&'a str>,
}

impl Authority030 for ArchiveStart<'_> {
    fn owner<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        id: &'a FlowIdentity030,
    ) -> CheckFuture<'a> {
        Box::pin(async move {
            self.session
                .check_owner_tx(db, id, Some(&self.capture))
                .await?;
            Ok(())
        })
    }
    fn effect<'a>(
        &'a self,
        _db: &'a mut SqliteConnection,
        _effect: &'a FlowEffect030,
    ) -> CheckFuture<'a> {
        Box::pin(async { Err(StoreError030::Authority) })
    }
    fn settlement<'a>(
        &'a self,
        _db: &'a mut SqliteConnection,
        _effect: &'a FlowEffect030,
        _receipt: &'a Value,
    ) -> CheckFuture<'a> {
        Box::pin(async { Err(StoreError030::Authority) })
    }
    fn owner_epoch(&self) -> &str {
        "0"
    }
}

impl StartAuthority030 for ArchiveStart<'_> {
    type SourceGuard = tokio::sync::OwnedMutexGuard<()>;
    fn require_clear(&self, request: &EngineStartRequest) -> Result<()> {
        self.session.ensure_live()?;
        self.session.require_clear(request)
    }
    fn begin_commit(&self, request: &EngineStartRequest, identity: &FlowIdentity030) -> Result<()> {
        self.session.begin_commit(request, identity, true)
    }
    fn commit_acknowledged(&self, request: &EngineStartRequest, identity: &FlowIdentity030) {
        self.session.commit_acknowledged(request, identity);
    }
    async fn capture(&self, request: &EngineStartRequest) -> Result<StartCapture030> {
        self.require_clear(request)?;
        Ok(self.capture.clone())
    }
    async fn lock_source(&self, request: &EngineStartRequest) -> Result<Self::SourceGuard> {
        let admission = self.session.lock_admission().await;
        self.require_clear(request)?;
        if scope_for(self.folder, &request.source.owner)? != self.root_scope {
            return Err(launch_failure("CAPTURE_CHANGED", "workingFolder"));
        }
        Ok(admission)
    }
    async fn bind_capture_tx(
        &self,
        db: &mut SqliteConnection,
        request: &EngineStartRequest,
        capture: &StartCapture030,
    ) -> Result<()> {
        self.require_clear(request)?;
        if capture.identity != self.capture.identity {
            return Err(launch_failure("CORRELATION", "capture"));
        }
        require_consent(
            db,
            self.input,
            &self.summary,
            &self.machine,
            self.token.as_deref(),
        )
        .await?;
        let key = &self.input.key;
        let id = &capture.identity.system_start_id;
        let configuration = serde_json::to_string(&self.configuration)?;
        let folder = self
            .folder
            .to_str()
            .ok_or_else(|| launch_failure("WORKING_FOLDER_UNAVAILABLE", "workingFolder"))?;
        sqlx::query("INSERT INTO architect_launch_runs
              (system_id,blueprint_id,number,retained_snapshot_id,run_name,working_folder,owns_working_folder,configuration_json)
              VALUES (?,?,?,?,?,?,?,?)")
            .bind(id).bind(&key.blueprint_id).bind(key.number).bind(self.snapshot).bind(self.name)
            .bind(folder).bind(self.owns_folder).bind(&configuration).execute(&mut *db).await?;
        sqlx::query("INSERT INTO architect_version_uses(kind,owner_id,blueprint_id,number) VALUES ('execution',?,?,?)")
            .bind(id).bind(&key.blueprint_id).bind(key.number).execute(&mut *db).await?;
        sqlx::query("INSERT INTO architect_launch_configurations(blueprint_id,configuration_json) VALUES (?,?)
              ON CONFLICT(blueprint_id) DO UPDATE SET configuration_json=excluded.configuration_json")
            .bind(&key.blueprint_id).bind(configuration).execute(&mut *db).await?;
        sqlx::query("INSERT INTO architect_launch_consents(blueprint_id,number,machine_id,permissions_json) VALUES (?,?,?,?)
              ON CONFLICT(blueprint_id,number,machine_id) DO UPDATE SET permissions_json=excluded.permissions_json")
            .bind(&key.blueprint_id).bind(key.number).bind(&self.machine)
            .bind(serde_json::to_string(&self.summary)?).execute(&mut *db).await?;
        self.session.bind_capture_tx(db, capture).await
    }
}
