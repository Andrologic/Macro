//! Local launch preparation, independent of the desktop UI.
use crate::architect_library::{
    archive::{VersionArchive, ARCHIVE_FORMAT},
    editor_document::{MacroSettings, WorkingFolderMode},
    preview::{self, CallTarget, ImportPreview, McpServer, McpTransport, Usage},
    storage::Storage,
};
use crate::config::ConfigManager;
use crate::db::{
    agsdl_execution::{dto::EngineSourceOwner, failure, Result},
    architect_library::VersionKey,
};
use argentic_runtime::{capture::ModelOverride, persistence::dto::EngineSourceRevision};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{SqliteConnection, SqlitePool};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    path::{Path, PathBuf},
};

mod resources;
pub(crate) mod start;
pub(crate) use resources::cleanup;

pub(crate) const PROJECT_ID: &str = "macro:architect-archive";
pub(crate) const BRANCH: &str = "versions";
pub(crate) const SCHEMA_VERSION: i64 = 50;
pub(crate) const SCHEMA_NAME: &str = "050_architect_launch";
fn machine_id(host_root: &Path) -> Result<String> {
    use std::io::Write;
    let path = host_root.join(".agsdl-machine-id");
    let unavailable = || {
        failure(
            "STORAGE",
            "machine",
            "The local installation identity is unavailable",
        )
    };
    if !path.exists() {
        let mut pending = tempfile::NamedTempFile::new_in(host_root).map_err(|_| unavailable())?;
        write!(pending, "{}", uuid::Uuid::new_v4()).map_err(|_| unavailable())?;
        pending.as_file().sync_all().map_err(|_| unavailable())?;
        if let Err(error) = pending.persist_noclobber(&path) {
            if error.error.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(unavailable());
            }
        }
    }
    let raw = std::fs::read_to_string(path).map_err(|_| unavailable())?;
    let id: uuid::Uuid = raw.parse().map_err(|_| unavailable())?;
    Ok(id.to_string())
}

pub(crate) async fn migrate(db: &mut SqliteConnection) -> crate::db::DbResult<()> {
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=?)")
            .bind(SCHEMA_VERSION)
            .fetch_one(&mut *db)
            .await?;
    if !exists {
        crate::db::apply_migration(
            db,
            SCHEMA_VERSION,
            SCHEMA_NAME.into(),
            include_str!("db/migrations/050_architect_launch.sql").into(),
        )
        .await?;
    }
    Ok(())
}

fn owner(blueprint_id: &str) -> EngineSourceOwner {
    EngineSourceOwner {
        project_id: PROJECT_ID.into(),
        plan_id: blueprint_id.into(),
        branch: BRANCH.into(),
    }
}

fn storage_error() -> crate::db::agsdl_execution::dto::EngineFailure {
    failure(
        "ARCHIVE_UNAVAILABLE",
        "version",
        "The version archive or its settings are unavailable",
    )
}

fn library_error(
    error: crate::architect_library::Error,
) -> crate::db::agsdl_execution::dto::EngineFailure {
    use argentic_runtime::persistence::dto::{SourceDiagnostic, SourceErrorKind};
    let diagnostic = error.diagnostic();
    if !matches!(
        diagnostic.code.as_str(),
        "GRAPH_LIMIT" | "INPUT_LIMIT" | "ARCHIVE_LAYOUT" | "ARCHIVE_LIMIT" | "ARCHIVE_INTEGRITY"
    ) {
        return storage_error();
    }
    let mut error = failure(&diagnostic.code, &diagnostic.pointer, &diagnostic.message);
    error.source = diagnostic.file.map(|path| {
        Box::new(SourceDiagnostic {
            path,
            pointer: diagnostic.pointer,
            kind: SourceErrorKind::InvalidContent,
        })
    });
    error
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LaunchConfiguration {
    pub working_folder: Option<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LaunchPreview {
    version: VersionKey,
    note: Option<String>,
    start_message_required: bool,
    start_message_hint: Option<String>,
    working_folder_mode: WorkingFolderMode,
    configuration: LaunchConfiguration,
    folder_reuse_token: Option<String>,
    blockers: Vec<Blocker>,
    available_models: Vec<String>,
    permissions: ImportPreview,
    consent_token: Option<String>,
    secrets: Vec<SecretRequirement>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Blocker {
    code: &'static str,
    subject: String,
}

impl Blocker {
    fn new(code: &'static str, subject: impl Into<String>) -> Self {
        Self {
            code,
            subject: subject.into(),
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
struct Permissions {
    capabilities: BTreeSet<String>,
    mcp: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    completion_checks: BTreeMap<String, CompletionCheck>,
}

#[derive(Serialize, Deserialize)]
struct CompletionCheck {
    command: String,
    choices: BTreeSet<String>,
}

impl CompletionCheck {
    fn covers(&self, requested: &Self) -> bool {
        self.command == requested.command
            && (self.choices.is_empty()
                || (!requested.choices.is_empty() && requested.choices.is_subset(&self.choices)))
    }
}

impl Permissions {
    fn covers(&self, other: &Self) -> bool {
        other.capabilities.is_subset(&self.capabilities)
            && other
                .mcp
                .iter()
                .all(|(name, digest)| self.mcp.get(name) == Some(digest))
            && other.completion_checks.iter().all(|(agent, check)| {
                self.completion_checks
                    .get(agent)
                    .is_some_and(|known| known.covers(check))
            })
    }
}

struct VersionInput {
    _lease: File,
    key: VersionKey,
    archive: VersionArchive,
    settings: MacroSettings,
    digest: String,
    note: Option<String>,
    origin: String,
}

impl VersionInput {
    fn source_revision(&self) -> EngineSourceRevision {
        EngineSourceRevision {
            owner: owner(&self.key.blueprint_id),
            revision: self.key.number.to_string(),
            source_sha256: self.archive.source().source_sha256(),
        }
    }

    async fn read(pool: &SqlitePool, storage: &Storage, key: VersionKey) -> Result<Self> {
        let (_lease, archive, settings, digest, note) = storage
            .open_launch_version(pool, &key)
            .await
            .map_err(|error| match error {
                crate::db::DbError::Architect(error) => library_error(error),
                _ => storage_error(),
            })?;
        // Adaptation creates a separate blueprint and cannot inherit vault
        // entries. The locally recorded origin participates in the key.
        let origin: (Option<String>, Option<i64>) = sqlx::query_as(
            "SELECT origin_blueprint_id,origin_number FROM architect_blueprints WHERE id=?",
        )
        .bind(&key.blueprint_id)
        .fetch_one(pool)
        .await?;
        let origin = serde_json::to_string(&origin)?;
        Ok(Self {
            _lease,
            key,
            archive,
            settings,
            digest,
            note,
            origin,
        })
    }

    fn preview(&self) -> Result<ImportPreview> {
        preview::inspect(
            self.archive.source(),
            ARCHIVE_FORMAT,
            self.digest.clone(),
            false,
        )
        .map_err(library_error)
    }

    fn requires_start_message(&self, preview: &ImportPreview) -> bool {
        preview.entry_point.is_some() && self.settings.start_message_required.unwrap_or(true)
    }

    fn secret_id(&self, server: &str, name: &str) -> Result<String> {
        secret_id(&self.key.blueprint_id, &self.origin, server, name)
    }
}

fn secret_id(blueprint: &str, origin: &str, server: &str, name: &str) -> Result<String> {
    let digest = Sha256::digest(serde_json::to_vec(&(blueprint, origin, server, name))?);
    Ok(format!("architect-launch:{digest:x}"))
}

fn vault_error() -> crate::db::agsdl_execution::dto::EngineFailure {
    failure(
        "VAULT_UNAVAILABLE",
        "secret",
        "The local vault is unavailable",
    )
}

fn permissions(input: &VersionInput, preview: &ImportPreview) -> Result<Permissions> {
    let mut permissions = Permissions::default();
    for (id, agent) in &preview.agents {
        if agent.usage != Usage::Reachable {
            continue;
        }
        if let Some(command) = &agent.completion_check {
            permissions.completion_checks.insert(
                id.clone(),
                CompletionCheck {
                    command: command.clone(),
                    choices: agent.completion_check_choices.iter().cloned().collect(),
                },
            );
        }
        let requested = &agent.permissions;
        let simple = requested.directories.is_empty()
            && requested.outside.is_none()
            && requested.reviewer.is_none()
            && requested.rules.is_empty();
        let preset = requested.preset.as_deref().unwrap_or("read-only");
        let actions = match (simple, preset) {
            (true, "read-only") => &["read"][..],
            (true, "workspace") => &["read", "write", "shell", "delegate"][..],
            _ => {
                permissions
                    .capabilities
                    .insert(serde_json::to_string(&(id, requested))?);
                continue;
            }
        };
        for action in actions {
            permissions.capabilities.insert(format!("{id}:{action}"));
        }
    }
    for call in &preview.direct_calls {
        if call.usage == Usage::Reachable {
            match &call.target {
                CallTarget::Shell { command } => {
                    permissions
                        .capabilities
                        .insert(serde_json::to_string(&("shell", command))?);
                }
                CallTarget::Mcp { server, tool } => {
                    permissions
                        .capabilities
                        .insert(serde_json::to_string(&("mcp", server, tool))?);
                }
            }
        }
    }
    for (id, server) in &preview.mcp_servers {
        if server.usage == Usage::DeclaredOnly {
            continue;
        }
        let assets: BTreeMap<_, _> = input
            .archive
            .members()
            .filter(|member| server.packaged_files.iter().any(|path| path == member.path))
            .map(|member| {
                (
                    member.path,
                    (
                        format!("{:x}", Sha256::digest(member.bytes)),
                        member.executable,
                    ),
                )
            })
            .collect();
        let digest = Sha256::digest(serde_json::to_vec(&(
            &server.transport,
            &server.required_secrets,
            assets,
        ))?);
        permissions.mcp.insert(id.clone(), format!("{digest:x}"));
    }
    for reference in &preview.external_references {
        if reference.usage != Usage::DeclaredOnly {
            permissions
                .capabilities
                .insert(serde_json::to_string(&(&reference.kind, &reference.uri))?);
        }
    }
    Ok(permissions)
}

fn record_host_permissions(
    summary: &mut Permissions,
    policy: &crate::agsdl_permissions::RequestedPermissions,
) -> Result<()> {
    summary.capabilities.insert(serde_json::to_string(policy)?);
    Ok(())
}

pub(crate) async fn schema_ready(pool: &SqlitePool) -> Result<bool> {
    Ok(
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=?)")
            .bind(SCHEMA_VERSION)
            .fetch_one(pool)
            .await?,
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunRecord {
    owner: EngineSourceOwner,
    system_label: String,
    system_start_id: String,
    version: VersionKey,
    run_name: Option<String>,
}

pub(crate) async fn run_systems(pool: &SqlitePool) -> Result<Vec<RunRecord>> {
    if !schema_ready(pool).await? {
        return Ok(Vec::new());
    }
    let rows: Vec<(String, String, String, i64, Option<String>)> = sqlx::query_as(
        "SELECT launch.blueprint_id, blueprint.name, launch.system_id, launch.number, launch.run_name
         FROM architect_launch_runs launch JOIN architect_blueprints blueprint ON blueprint.id=launch.blueprint_id
         ORDER BY blueprint.name, launch.blueprint_id, launch.system_id",
    ).fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(
            |(id, system_label, system_start_id, number, run_name)| RunRecord {
                owner: owner(&id),
                system_label,
                system_start_id,
                version: VersionKey {
                    blueprint_id: id,
                    number,
                },
                run_name,
            },
        )
        .collect())
}

pub(crate) async fn read_folder(pool: &SqlitePool, id: &str) -> Result<String> {
    if schema_ready(pool).await? {
        if let Some(folder) =
            sqlx::query_scalar("SELECT working_folder FROM architect_launch_runs WHERE system_id=?")
                .bind(id)
                .fetch_optional(pool)
                .await?
        {
            return Ok(folder);
        }
    }
    Err(failure(
        "NOT_FOUND",
        "workingFolder",
        "The run folder is unavailable",
    ))
}

pub(crate) async fn current_run_folder(
    pool: &SqlitePool,
    capture: &crate::db::agsdl_execution::start030::StartCapture030,
    scope: &Value,
) -> Result<PathBuf> {
    let identity = &capture.identity;
    let folder: Option<String> = sqlx::query_scalar(
        "SELECT launch.working_folder FROM architect_launch_runs launch
         JOIN engine_start030_requests start ON start.system_id=launch.system_id
         WHERE launch.system_id=? AND launch.blueprint_id=? AND CAST(launch.number AS TEXT)=?
           AND launch.retained_snapshot_id=? AND start.invocation_id=?
           AND start.snapshot_id=? AND start.capture_epoch=?",
    )
    .bind(&identity.system_start_id)
    .bind(&capture.source.owner.plan_id)
    .bind(&capture.source.revision)
    .bind(scope["projectSnapshot"].as_str())
    .bind(&identity.flow_invocation_id)
    .bind(&identity.snapshot_id)
    .bind(&identity.epoch)
    .fetch_optional(pool)
    .await?;
    let folder = folder
        .filter(|folder| scope["root"] == folder.as_str())
        .ok_or_else(|| {
            failure(
                "CAPTURE_CHANGED",
                "approval",
                "Admitted archive folder differs from capture",
            )
        })?;
    let folder = PathBuf::from(folder);
    if folder.canonicalize().ok().as_ref() != Some(&folder) {
        return Err(failure(
            "CAPTURE_CHANGED",
            "approval",
            "Admitted archive folder was replaced",
        ));
    }
    Ok(folder)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretRequirement {
    server: String,
    name: String,
    stored: bool,
}

fn direct_mcp(preview: &ImportPreview, id: &str) -> bool {
    preview.direct_calls.iter().any(|call| {
        call.usage == Usage::Reachable
            && matches!(&call.target, CallTarget::Mcp { server, .. } if server == id)
    })
}

type ServerSecrets = BTreeMap<String, Vec<String>>;

fn secret_requirements(
    input: &VersionInput,
    servers: &ServerSecrets,
) -> Result<Vec<SecretRequirement>> {
    let mut requirements = Vec::new();
    for (server, names) in servers {
        for name in names {
            let stored = crate::secrets::get_api_key(&input.secret_id(server, name)?)
                .map_err(|_| vault_error())?
                .is_some_and(|value| !value.is_empty() && !value.contains('\0'));
            requirements.push(SecretRequirement {
                server: server.clone(),
                name: name.clone(),
                stored,
            });
        }
    }
    Ok(requirements)
}

fn secret_provider(
    input: &VersionInput,
    servers: ServerSecrets,
) -> std::sync::Arc<argentic_runtime::host::McpSecretProvider> {
    let source = input.source_revision();
    let origin = input.origin.clone();
    std::sync::Arc::new(move |revision, server, requested| {
        if revision != &source || servers.get(server)?.as_slice() != requested {
            return None;
        }
        requested
            .iter()
            .map(|name| {
                let key = secret_id(&source.owner.plan_id, &origin, server, name).ok()?;
                let value = crate::secrets::get_api_key(&key).ok()??;
                (!value.is_empty() && !value.contains('\0')).then(|| (name.clone(), value))
            })
            .collect()
    })
}

async fn consent_token(
    db: &mut SqliteConnection,
    input: &VersionInput,
    permissions: &Permissions,
    machine: &str,
) -> Result<Option<String>> {
    let known: Option<String> = sqlx::query_scalar(
        "SELECT permissions_json FROM architect_launch_consents
         WHERE blueprint_id=? AND machine_id=?
         ORDER BY (number=?) DESC, number DESC LIMIT 1",
    )
    .bind(&input.key.blueprint_id)
    .bind(machine)
    .bind(input.key.number)
    .fetch_optional(db)
    .await?;
    if let Some(known) = known {
        if serde_json::from_str::<Permissions>(&known)?.covers(permissions) {
            return Ok(None);
        }
    }
    let digest = Sha256::digest(serde_json::to_vec(&(
        &input.key,
        &input.digest,
        machine,
        permissions,
    ))?);
    Ok(Some(format!("{digest:x}")))
}

async fn saved_configuration(pool: &SqlitePool, blueprint_id: &str) -> Result<LaunchConfiguration> {
    let json: Option<String> = sqlx::query_scalar(
        "SELECT configuration_json FROM architect_launch_configurations WHERE blueprint_id=?",
    )
    .bind(blueprint_id)
    .fetch_optional(pool)
    .await?;
    Ok(json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()?
        .unwrap_or_default())
}

fn chosen_folder(folder: &Path, app_data: &Path, host_root: &Path) -> Option<PathBuf> {
    if !folder.is_absolute() {
        return None;
    }
    let folder = folder.canonicalize().ok()?;
    for private in [app_data, host_root] {
        let private = private.canonicalize().ok()?;
        if folder.starts_with(&private) || private.starts_with(&folder) {
            return None;
        }
    }
    folder.is_dir().then_some(folder)
}

fn folder_reuse_token(scope: &Value) -> Result<String> {
    let folder = (&scope["root"], &scope["rootIdentity"]);
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&folder)?)
    ))
}

async fn folder_in_use(db: &mut SqliteConnection, folder: &Path) -> Result<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM architect_launch_runs launch
          JOIN engine_flow030_runs run ON run.system_id=launch.system_id
          WHERE launch.working_folder=? AND (
            json_extract(run.state_json,'$.verdict') IS NULL OR
            EXISTS(SELECT 1 FROM json_each(run.state_json,'$.activations') WHERE json_extract(value,'$.physical')=1)
          ))",
    )
    .bind(folder.to_str())
    .fetch_one(db)
    .await?)
}

fn declared_mcp_path(argument: &str, files: &[String]) -> Option<String> {
    use std::path::Component;

    // Match Argentic's retained path lookup, including relative path aliases.
    if argument.contains('\\') {
        return None;
    }
    let mut parts = Vec::new();
    for part in Path::new(argument).components() {
        match part {
            Component::Normal(part) => parts.push(part.to_str()?),
            Component::CurDir => (),
            Component::ParentDir => {
                parts.pop()?;
            }
            _ => return None,
        }
    }
    let path = parts.join("/");
    files.contains(&path).then_some(path)
}

fn qualify_mcp(
    input: &VersionInput,
    id: &str,
    server: &McpServer,
) -> std::result::Result<(), Blocker> {
    let McpTransport::Local { command } = &server.transport else {
        return Err(Blocker::new("mcpIsolationUnavailable", id));
    };
    let files = &server.packaged_files;
    let qualified = command.first().is_some_and(|program| {
        if let Some(path) = declared_mcp_path(program, files) {
            return input
                .archive
                .members()
                .any(|member| member.path == path && member.executable);
        }
        matches!(program.as_str(), "sh" | "/bin/sh")
            && command
                .get(1)
                .and_then(|script| declared_mcp_path(script, files))
                .is_some()
    });
    if !qualified {
        return Err(Blocker::new("mcpRetainedProgramRequired", id));
    }
    // Argentic gives local calls a fixed PATH and refuses these launcher names.
    if let Some(name) = server.required_secrets.iter().find(|name| {
        matches!(
            name.as_str(),
            "PATH" | "ENV" | "BASH_ENV" | "BASHOPTS" | "SHELLOPTS" | "PS4"
        ) || name.starts_with("LD_")
            || name.starts_with("DYLD_")
    }) {
        return Err(Blocker::new("mcpReservedSecret", format!("{id} · {name}")));
    }
    Ok(())
}

fn call_permissions(policy: &crate::config::ExecutionToolsLease) -> Result<Value> {
    let mut permissions = crate::agsdl_host_tools::permissions("Implement", false, &policy.tools)?;
    permissions["agsdlHostPermissions"] = serde_json::to_value(&policy.agsdl_host_permissions)?;
    Ok(permissions)
}

fn requirements(
    input: &VersionInput,
    preview: &ImportPreview,
    policy: &Value,
    local_mcp_supported: bool,
) -> (Vec<Blocker>, ServerSecrets) {
    let mut blockers = Vec::new();
    let mut servers = BTreeMap::new();
    let has_calls = preview
        .direct_calls
        .iter()
        .any(|call| call.usage == Usage::Reachable);
    let calls_refused = has_calls
        && argentic_runtime::api::product_slice(input.archive.source().authored_json(), None)
            .is_some();
    for (id, server) in &preview.mcp_servers {
        let reachable = direct_mcp(preview, id);
        let equipment = preview
            .agents
            .values()
            .any(|agent| agent.usage == Usage::Reachable && agent.mcp_servers.contains(id));
        if !reachable && !equipment {
            continue;
        }
        if let Err(blocker) = qualify_mcp(input, id, server) {
            blockers.push(blocker);
        } else if equipment || !local_mcp_supported || calls_refused {
            blockers.push(Blocker::new("mcpIsolationUnavailable", id));
        } else if policy["agsdlHostPermissions"] != "workspace"
            || crate::core::tool_policy::agsdl_native_read_only(policy)
        {
            blockers.push(Blocker::new("mcpWorkspaceRequired", id));
        } else {
            servers.insert(id.clone(), server.required_secrets.clone());
        }
    }
    for (id, agent) in &preview.agents {
        if agent.usage == Usage::Reachable && agent.harness != "codex" {
            blockers.push(Blocker::new("unsupportedHarness", id));
        }
    }
    (blockers, servers)
}

const LOCAL_MCP_SUPPORTED: bool = cfg!(all(target_os = "macos", target_arch = "aarch64"));

fn model_blockers(
    preview: &ImportPreview,
    observed: &argentic_runtime::api::CodexObservation,
    overrides: &BTreeMap<String, ModelOverride>,
) -> Vec<Blocker> {
    let mut blockers = Vec::new();
    for id in overrides.keys() {
        if !preview
            .agents
            .get(id)
            .is_some_and(|agent| agent.usage == Usage::Reachable && agent.harness == "codex")
        {
            blockers.push(Blocker::new("modelUnavailable", id));
        }
    }
    for (id, agent) in &preview.agents {
        if agent.usage != Usage::Reachable || agent.harness != "codex" {
            continue;
        }
        let (name, effort) = if let Some(model) = overrides.get(id) {
            (Some(model.name.as_str()), model.effort.as_deref())
        } else {
            (
                agent.model.as_ref().and_then(|model| model.name.as_deref()),
                agent
                    .model
                    .as_ref()
                    .and_then(|model| model.effort.as_deref()),
            )
        };
        let available = observed.models.iter().any(|model| {
            name.map_or(model["isDefault"] == true, |name| model["name"] == name)
                && effort.is_none_or(|effort| {
                    model["efforts"]
                        .as_array()
                        .is_some_and(|efforts| efforts.iter().any(|value| value == effort))
                })
        });
        if !available {
            blockers.push(Blocker::new("modelUnavailable", id));
        }
    }
    blockers
}

fn codex_write_unqualified(
    preview: &ImportPreview,
    policy: &Value,
    observed: &argentic_runtime::api::CodexObservation,
) -> bool {
    let host = &policy["agsdlHostPermissions"];
    observed.version == "0.171.0"
        && host != "read-only"
        && host["preset"] != "read-only"
        && !host["rules"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|rule| rule["action"] == "write" && rule["effect"] == "ask")
        && !crate::core::tool_policy::agsdl_native_read_only(policy)
        && preview.agents.values().any(|agent| {
            agent.usage == Usage::Reachable
                && agent.harness == "codex"
                && agent.permissions.preset.as_deref() == Some("workspace")
                && !agent
                    .permissions
                    .rules
                    .iter()
                    .any(|rule| rule.action == "write" && rule.effect == "ask")
        })
}

fn needs_codex(preview: &ImportPreview) -> bool {
    preview
        .agents
        .values()
        .any(|agent| agent.usage == Usage::Reachable && agent.harness == "codex")
}

pub(crate) async fn prepare(
    manager: &ConfigManager,
    pool: &SqlitePool,
    app_data: &Path,
    key: VersionKey,
    configuration: Option<LaunchConfiguration>,
    model_overrides: BTreeMap<String, ModelOverride>,
) -> Result<LaunchPreview> {
    let input = VersionInput::read(pool, &Storage::new(app_data), key).await?;
    let permissions_preview = input.preview()?;
    let mut summary = permissions(&input, &permissions_preview)?;
    let policy = manager
        .lock_execution_tools(PROJECT_ID)
        .await
        .map_err(|_| failure("PERMISSION", "policy", "The launch policy is unavailable"))?;
    record_host_permissions(&mut summary, &policy.agsdl_host_permissions)?;
    let permissions = call_permissions(&policy)?;
    drop(policy);
    let mut configuration = match configuration {
        Some(configuration) => configuration,
        None => saved_configuration(pool, &input.key.blueprint_id).await?,
    };
    let (mut blockers, servers) = requirements(
        &input,
        &permissions_preview,
        &permissions,
        LOCAL_MCP_SUPPORTED,
    );
    let mut reuse_token = None;
    if input.settings.working_folder_mode == WorkingFolderMode::AtLaunch {
        let folder = configuration
            .working_folder
            .as_deref()
            .and_then(|path| chosen_folder(path, app_data, manager.root()));
        if let Some(folder) = folder {
            let scope = start::scope_for(&folder, &owner(&input.key.blueprint_id))?;
            if folder_in_use(&mut *pool.acquire().await?, &folder).await? {
                reuse_token = Some(folder_reuse_token(&scope)?);
            }
            configuration.working_folder = Some(folder);
        } else {
            blockers.push(Blocker::new("workingFolderRequired", ""));
        }
    } else {
        configuration.working_folder = None;
    }
    let mut available_models = Vec::new();
    if needs_codex(&permissions_preview) {
        // A preview observes the catalogue without starting an agent turn.
        let probe = tempfile::tempdir_in(app_data).map_err(|_| storage_error())?;
        let scope = start::scope_for(probe.path(), &owner(&input.key.blueprint_id))?;
        match start::observe_codex(manager, &scope).await {
            Ok(observed) => {
                if codex_write_unqualified(&permissions_preview, &permissions, &observed) {
                    blockers.push(Blocker::new(
                        "codexUnavailable",
                        "CODEX_PROFILE_UNQUALIFIED",
                    ));
                }
                blockers.extend(model_blockers(
                    &permissions_preview,
                    &observed,
                    &model_overrides,
                ));
                available_models = observed
                    .models
                    .iter()
                    .filter_map(|model| model["name"].as_str().map(str::to_owned))
                    .collect();
            }
            Err(error) => blockers.push(Blocker::new("codexUnavailable", error.code)),
        }
    }
    let secrets = secret_requirements(&input, &servers)?;
    let mut db = pool.acquire().await?;
    let machine = machine_id(manager.root())?;
    let consent_token = consent_token(&mut db, &input, &summary, &machine).await?;
    Ok(LaunchPreview {
        start_message_required: input.requires_start_message(&permissions_preview),
        note: input.note,
        version: input.key,
        start_message_hint: input.settings.entry_message_hint,
        working_folder_mode: input.settings.working_folder_mode,
        configuration,
        folder_reuse_token: reuse_token,
        blockers,
        available_models,
        permissions: permissions_preview,
        consent_token,
        secrets,
    })
}

pub(crate) async fn set_secret(
    manager: &ConfigManager,
    pool: &SqlitePool,
    app_data: &Path,
    key: VersionKey,
    server: &str,
    name: &str,
    value: &str,
) -> Result<()> {
    let input = VersionInput::read(pool, &Storage::new(app_data), key).await?;
    let preview = input.preview()?;
    let policy = manager
        .lock_execution_tools(PROJECT_ID)
        .await
        .map_err(|_| failure("PERMISSION", "policy", "The launch policy is unavailable"))?;
    let (_, servers) = requirements(
        &input,
        &preview,
        &call_permissions(&policy)?,
        LOCAL_MCP_SUPPORTED,
    );
    if !servers
        .get(server)
        .is_some_and(|names| names.iter().any(|secret| secret == name))
        || value.is_empty()
        || value.contains('\0')
    {
        return Err(failure(
            "INVALID_LAUNCH_SECRET",
            "secret",
            "The secret is not required by this version or has no value",
        ));
    }
    crate::secrets::set_api_key(&input.secret_id(server, name)?, value).map_err(|_| vault_error())
}

#[cfg(test)]
mod tests;
