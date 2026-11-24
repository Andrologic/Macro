use super::*;
use crate::agsdl_host::HostState;
use crate::agsdl_host_action_approval030::ArchiveActionPolicy030;
use crate::agsdl_host_capture::{self as capture, CompilationCapture};
use crate::db::agsdl_execution::{
    dto::{EngineEntry, EngineStartRequest},
    flow030::{FlowEffect030, FlowIdentity030},
    flow_store030::{Authority030, CheckFuture, StoreError030},
    start030::{self, RetainedStart030, StartAuthority030, StartCapture030},
};
use argentic_runtime::api::{CodexObservation, StartSession, StreamTasks};
use std::{fs, sync::Arc};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LaunchRequest {
    pub version: VersionKey,
    pub configuration: LaunchConfiguration,
    pub start_message: Option<String>,
    pub launch_values: Option<Value>,
    pub name: Option<String>,
    pub consent_token: Option<String>,
    pub folder_reuse_token: Option<String>,
    #[serde(default)]
    pub model_overrides: BTreeMap<String, ModelOverride>,
}

pub(crate) struct Runtime<'a> {
    pub host: &'a HostState,
    pub manager: &'a ConfigManager,
    pub pool: &'a SqlitePool,
    pub app_data: &'a Path,
    pub tasks: StreamTasks,
}

fn launch_failure(code: &str, pointer: &str) -> crate::db::agsdl_execution::dto::EngineFailure {
    failure(code, pointer, "The archive launch could not be admitted")
}

pub(crate) fn scope_for(folder: &Path, owner: &EngineSourceOwner) -> Result<Value> {
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
    launch_occurrence(runtime, request, None).await
}

pub(crate) async fn launch_occurrence(
    runtime: Runtime<'_>,
    request: LaunchRequest,
    occurrence: Option<schedule::Occurrence>,
) -> Result<RetainedStart030> {
    let input = VersionInput::read(
        runtime.pool,
        &Storage::new(runtime.app_data),
        request.version,
    )
    .await?;
    let preview = input.preview()?;
    let mut configuration = request.configuration;
    let owns_folder = input.settings.working_folder_mode == WorkingFolderMode::PerExecution;
    let context = runtime.manager.engine_context();
    let chosen = if owns_folder {
        configuration.working_folder = None;
        None
    } else {
        let path = configuration
            .working_folder
            .as_deref()
            .and_then(|path| chosen_folder(path, runtime.app_data, context.root()))
            .ok_or_else(|| launch_failure("workingFolderRequired", "workingFolder"))?;
        configuration.working_folder = Some(path.clone());
        Some(path)
    };

    let source = input.source_revision();
    let fields = input.settings.launch_fields().map_err(library_error)?;
    let entry = entry::encode_message(
        preview.entry_point.is_some(),
        input.requires_start_message(&preview),
        fields.as_ref(),
        request.start_message.as_deref(),
        request.launch_values.as_ref(),
    )?
    .map(|message_json| EngineEntry {
        delivery_id: Uuid::new_v4().to_string(),
        message_json,
    });
    let engine_request = EngineStartRequest {
        source,
        profile: "macro-agsdl-030-v1".into(),
        associations: Default::default(),
        request_id: Uuid::new_v4().to_string(),
        entry,
    };

    let ceiling = runtime
        .manager
        .lock_agsdl_host_permissions()
        .await
        .map_err(|_| launch_failure("PERMISSION", "policy"))?;
    let policy = runtime
        .manager
        .lock_execution_tools(PROJECT_ID)
        .await
        .map_err(|_| launch_failure("PERMISSION", "policy"))?;
    let call_permissions = call_permissions(&policy)?;
    let (blockers, launch_mcp) = requirements(
        &input,
        &preview,
        &call_permissions,
        ceiling.permissions(),
        runtime.app_data,
        LOCAL_MCP_SUPPORTED,
        &configuration,
    )?;
    if let Some(blocker) = blockers.first() {
        return Err(launch_failure(blocker.code, &blocker.subject));
    }
    let mut summary = permissions(&preview, &launch_mcp)?;
    record_host_permissions(&mut summary, &policy.agsdl_host_permissions)?;
    let host_permissions = ceiling.permissions().clone();
    record_host_permissions(&mut summary, &host_permissions)?;
    let mcp_ceiling = (!launch_mcp.agents.is_empty())
        .then(|| serde_json::to_value(&host_permissions))
        .transpose()?;
    drop(ceiling);
    let machine = machine_id(runtime.manager.root())?;
    {
        let mut db = runtime.pool.acquire().await?;
        require_consent(
            &mut db,
            &input,
            &summary,
            &machine,
            request.consent_token.as_deref(),
        )
        .await?;
    }
    let secrets = secret_requirements(
        runtime.pool,
        &Storage::new(runtime.app_data),
        &input,
        &launch_mcp,
    )
    .await?;
    if let Some(secret) = secrets.iter().find(|secret| !secret.stored) {
        return Err(launch_failure("MCP_SECRETS_UNAVAILABLE", &secret.server));
    }

    let provide_secrets = secret_provider(&input, &launch_mcp)?;
    configuration.remote_mcp = launch_mcp.remote_configuration();
    let chosen_scope = chosen
        .as_deref()
        .map(|folder| scope_for(folder, &engine_request.source.owner))
        .transpose()?;
    let observed = if needs_codex(&preview) {
        let probe;
        let scope = match &chosen_scope {
            Some(scope) => scope,
            None => {
                // The catalogue probe starts no work. Keep its empty folder
                // outside managed launch storage until admission.
                probe = tempfile::tempdir_in(runtime.app_data).map_err(|_| storage_error())?;
                &scope_for(probe.path(), &engine_request.source.owner)?
            }
        };
        let observed = observe_codex(runtime.manager, scope).await?;
        if codex_write_unqualified(&preview, &call_permissions, &observed) {
            return Err(launch_failure("CODEX_WRITE_PROFILE_UNQUALIFIED", "codex"));
        }
        if let Some(blocker) = model_blockers(&preview, &observed, &request.model_overrides).first()
        {
            return Err(launch_failure("MODEL_UNAVAILABLE", &blocker.subject));
        }
        Some(observed)
    } else {
        None
    };

    let session = runtime.host.begin_start().await?;
    let resources = resources::launch_lease(context.root()).await?;
    let database = resources::database_owner(runtime.pool, context.root()).await?;
    let private_folder = owns_folder
        .then(|| resources::new_working_folder(runtime.app_data, &database.key))
        .transpose()?;
    let (folder, root_scope) = match (chosen, chosen_scope) {
        (Some(folder), Some(scope)) => (folder, scope),
        _ => {
            let folder = private_folder
                .as_ref()
                .expect("private folder created")
                .path()
                .to_owned();
            let scope = scope_for(&folder, &engine_request.source.owner)?;
            (folder, scope)
        }
    };
    let mut scope = root_scope.clone();
    let retained = resources::retain_snapshot(
        context.root(),
        &database.key,
        input.archive.source(),
        &mut scope,
    )?;
    let snapshot = scope["projectSnapshot"]
        .as_str()
        .ok_or_else(|| launch_failure("CORRELATION", "projectSnapshot"))?;
    resources::seal_snapshot(retained.resource_root(), &folder)?;
    let authored = input.archive.source().authored_json();
    let document: Value = serde_json::from_str(authored)?;
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
        &engine_request,
        scope.clone(),
        &call_permissions,
        observed.as_ref(),
        &request.model_overrides,
    )
    .map_err(|error| input.archive.source().locate_error(error))?;
    let compiled = runtime
        .host
        .compile_document(
            engine_request.source.clone(),
            authored.to_owned(),
            registry.to_string(),
        )
        .await
        .map_err(|error| input.archive.source().locate_error(error))?;
    let material = CompilationCapture {
        source: engine_request.source.clone(),
        authored_source: authored.to_owned(),
        native_registry_json: registry.to_string(),
        display_cards_json: "[]".into(),
        native_catalogue,
        result: serde_json::from_str(&compiled.result_json)?,
        generation: compiled.generation,
        call_permissions_json: call_permissions.to_string(),
        call_scope_json: scope.to_string(),
        permission_notice030: false,
        archive_host_permissions: Some(host_permissions),
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
    let material = material
        .start_material030_checked(
            &engine_request.source,
            authored,
            "[]",
            &engine_request,
            session.generation(),
        )
        .map_err(|error| input.archive.source().locate_error(error))?;
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
            "associations":engine_request.associations, "entryUnassessed":material.entry_unassessed,
        }).to_string(),
    };
    let authority = ArchiveStart {
        session: &session,
        input: &input,
        capture,
        root_scope,
        folder: &folder,
        owns_folder,
        folder_reuse_token: request.folder_reuse_token,
        snapshot,
        configuration,
        summary,
        machine,
        token: request.consent_token,
        occurrence,
        name: request
            .name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty()),
    };
    // After commit the persisted run owns the directory. Startup reclaims it
    // if the process exits after keep() and before the transaction commits.
    if let Some(private_folder) = private_folder {
        let _ = private_folder.keep();
    }
    let started = start030::start(runtime.pool, &engine_request, &authority).await;
    drop(resources);
    // Attachment observes policy itself. In particular, do not hold a
    // config read lease across this boundary.
    drop(policy);
    let identity = &authority.capture.identity;
    let result = match started {
        Ok(started) => session
            .attach_committed_start(
                runtime.pool,
                runtime
                    .manager
                    .engine_context_with_mcp_ceiling(mcp_ceiling)
                    .with_mcp_secrets(provide_secrets)
                    .with_mcp_http(mcp::authorizer(input.source_revision(), launch_mcp.remote)),
                runtime.tasks.clone(),
                identity,
                &authority.capture,
                Arc::new(ArchiveActionPolicy030 {
                    pool: runtime.pool.clone(),
                    config: runtime.manager.clone(),
                }),
            )
            .await
            .map(|()| started),
        Err(error) => Err(error),
    };
    if let Err(error) = &result {
        let interrupted = session
            .interrupt_run(runtime.pool, &identity.system_start_id)
            .await;
        session.fail_reservation(&identity.system_start_id, error.clone());
        if owns_folder {
            // A failed acknowledgement can still have committed.
            let referenced = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM architect_launch_runs WHERE system_id=?)",
            )
            .bind(&identity.system_start_id)
            .fetch_one(runtime.pool)
            .await;
            if matches!(referenced, Ok(false)) {
                let _ = fs::remove_dir(&folder);
            }
        }
        interrupted?;
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
    // Catalogue discovery on qualified ARM64 platforms uses a read-only
    // profile. Physical work still qualifies its own effective permissions.
    let read_only = cfg!(all(
        target_arch = "aarch64",
        any(target_os = "linux", target_os = "macos")
    ));
    if let Some(observed) = argentic_runtime::api::observe_codex(&context, scope, read_only).await?
    {
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
    model_overrides: &BTreeMap<String, ModelOverride>,
) -> Result<Value> {
    let (harnesses, agents) = if let Some(observed) = observed {
        let (harness, agents) =
            capture::codex_registry030(document, &request.source.source_sha256, &scope, observed)?;
        (vec![harness], agents)
    } else {
        (Vec::new(), Vec::new())
    };
    let mut capabilities = Vec::new();
    if LOCAL_MCP_SUPPORTED {
        capabilities.push(json!({"name":"approval","support":"native","evidenceJson":"{\"runtime\":\"flow-human-clock\"}"}));
        capabilities.push(json!({"name":"call.command","support":"native","evidenceJson":"{\"transport\":\"confined-local\"}"}));
    }
    let has_remote = document["mcpServers"]
        .as_object()
        .is_some_and(|servers| servers.values().any(|server| server["url"].is_string()));
    if LOCAL_MCP_SUPPORTED || has_remote {
        capabilities.push(
            json!({"name":"call.mcp","support":"native","evidenceJson":json!({
            "streamableHttp":has_remote, "confinedStdio":LOCAL_MCP_SUPPORTED,
        }).to_string()}),
        );
    }
    let mut registry = json!({
        "format":"macro-agsdl-registry/030",
        "modules":[{"harness":"codex", "moduleJson":argentic_runtime::api::codex_module()}],
        "harnesses":harnesses, "agents":agents,
        "hostCapabilities":capabilities,
    });
    argentic_runtime::capture::apply_model_overrides(&mut registry, model_overrides)?;
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
    folder_reuse_token: Option<String>,
    snapshot: &'a str,
    configuration: LaunchConfiguration,
    summary: Permissions,
    machine: String,
    token: Option<String>,
    occurrence: Option<schedule::Occurrence>,
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
        if self.owns_folder && scope_for(self.folder, &request.source.owner)? != self.root_scope {
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
        if !self.owns_folder {
            let changed = || launch_failure("WORKING_FOLDER_CHANGED", "workingFolder");
            let scope = scope_for(self.folder, &request.source.owner).map_err(|_| changed())?;
            if scope != self.root_scope
                || self.folder.canonicalize().ok().as_deref() != Some(self.folder)
            {
                return Err(changed());
            }
            if let Some(occurrence) = &self.occurrence {
                occurrence.check_folder(&scope)?;
            }
            if let Some(confirmed) = &self.folder_reuse_token {
                if *confirmed != folder_reuse_token(&scope)? {
                    return Err(changed());
                }
            } else if folder_in_use(
                db,
                &scope,
                self.occurrence
                    .as_ref()
                    .and_then(schedule::Occurrence::overlapping_schedule),
            )
            .await?
            {
                return Err(launch_failure("WORKING_FOLDER_IN_USE", "workingFolder"));
            }
        }
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
        if let Some(occurrence) = &self.occurrence {
            occurrence.link(db, id, key).await?;
        } else {
            let mut saved = saved_configuration(db, &key.blueprint_id).await?;
            saved
                .working_folder
                .clone_from(&self.configuration.working_folder);
            for (server, endpoints) in &self.configuration.remote_mcp {
                let saved = saved.remote_mcp.entry(server.clone()).or_default();
                for (url, settings) in endpoints {
                    let saved = saved.entry(url.clone()).or_default();
                    saved.delivery.extend(settings.delivery.clone());
                    saved.address_scope = settings.address_scope;
                }
            }
            sqlx::query("INSERT INTO architect_launch_configurations(blueprint_id,configuration_json) VALUES (?,?)
              ON CONFLICT(blueprint_id) DO UPDATE SET configuration_json=excluded.configuration_json")
            .bind(&key.blueprint_id).bind(serde_json::to_string(&saved)?).execute(&mut *db).await?;
        }
        record_consent(db, key, &self.machine, &self.summary, true).await?;
        self.session.bind_capture_tx(db, capture).await
    }
}
