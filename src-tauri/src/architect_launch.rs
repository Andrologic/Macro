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
use crate::secrets::archive_mcp::{self, ArchiveMcpKey};
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

mod legacy_mcp;
use legacy_mcp::secret_requirements;
mod resources;
pub(crate) mod start;
pub(crate) use resources::cleanup;

pub(crate) mod mcp;

pub(crate) const PROJECT_ID: &str = "macro:architect-archive";
pub(crate) const BRANCH: &str = "versions";
pub(crate) const SCHEMA_VERSION: i64 = 50;
pub(crate) const SCHEMA_NAME: &str = "050_architect_launch";
pub(crate) const OWNER_SCHEMA_VERSION: i64 = 51;
pub(crate) const OWNER_SCHEMA_NAME: &str = "051_architect_launch_ownership";
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
    migrate_through(db, OWNER_SCHEMA_VERSION).await
}

pub(crate) async fn migrate_through(
    db: &mut SqliteConnection,
    through: i64,
) -> crate::db::DbResult<()> {
    for (version, name, schema) in [
        (
            SCHEMA_VERSION,
            SCHEMA_NAME,
            include_str!("db/migrations/050_architect_launch.sql"),
        ),
        (
            OWNER_SCHEMA_VERSION,
            OWNER_SCHEMA_NAME,
            include_str!("db/migrations/051_architect_launch_ownership.sql"),
        ),
    ] {
        if version > through {
            break;
        }
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=?)")
                .bind(version)
                .fetch_one(&mut *db)
                .await?;
        if !exists {
            crate::db::apply_migration(db, version, name.into(), schema.into()).await?;
        }
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
        "GRAPH_LIMIT"
            | "INPUT_LIMIT"
            | "ARCHIVE_LAYOUT"
            | "ARCHIVE_LIMIT"
            | "ARCHIVE_INTEGRITY"
            | "MCP_SECRET_RESERVED"
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
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub remote_mcp: mcp::RemoteConfigurations,
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
    agent_mcp: BTreeMap<String, BTreeMap<String, mcp::AgentAccess>>,
    remote_mcp: BTreeMap<String, mcp::RemoteGrant>,
    remote_mcp_setup: BTreeMap<String, mcp::RemoteSetup>,
    mcp_direct_tools: BTreeMap<String, BTreeSet<String>>,
    mcp_notes: Vec<mcp::UnusedServer>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Blocker {
    code: &'static str,
    subject: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    codex_platform: Option<&'static str>,
}

impl Blocker {
    fn new(code: &'static str, subject: impl Into<String>) -> Self {
        Self {
            code,
            subject: subject.into(),
            codex_platform: None,
        }
    }

    fn codex(code: impl Into<String>) -> Self {
        let mut blocker = Self::new("codexUnavailable", code);
        if blocker.subject == "CODEX_VERSION_UNQUALIFIED" {
            blocker.codex_platform = Some(match (std::env::consts::OS, std::env::consts::ARCH) {
                ("macos", "aarch64") => "macosArm64",
                ("linux", "aarch64") => "linuxArm64",
                _ => "unsupported",
            });
        }
        blocker
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
    #[serde(default)]
    max_failures: Option<String>,
}

impl CompletionCheck {
    fn covers(&self, requested: &Self) -> bool {
        self.command == requested.command
            && self
                .max_failures
                .as_deref()
                .zip(requested.max_failures.as_deref())
                .is_some_and(|(known, requested)| {
                    known == requested
                        || known
                            .parse::<u64>()
                            .ok()
                            .zip(requested.parse::<u64>().ok())
                            .is_some_and(|(known, requested)| known >= requested)
                })
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

    fn secret_id(
        &self,
        server: &str,
        name: &str,
        launch: &mcp::LaunchMcp,
    ) -> Result<ArchiveMcpKey> {
        secret_id(&self.key.blueprint_id, &self.origin, server, name, launch)
    }
}

fn secret_id(
    blueprint: &str,
    origin: &str,
    server: &str,
    name: &str,
    launch: &mcp::LaunchMcp,
) -> Result<ArchiveMcpKey> {
    let material = if let Some(remote) = launch.remote.get(server) {
        let destination = remote.credential_binding(name).ok_or_else(vault_error)?;
        serde_json::to_vec(&(
            "archive-mcp-credential/1",
            blueprint,
            origin,
            server,
            name,
            destination,
        ))?
    } else {
        let fingerprint = launch.stdio.get(server).ok_or_else(vault_error)?;
        serde_json::to_vec(&(
            "archive-mcp-stdio-credential/1",
            blueprint,
            origin,
            server,
            name,
            fingerprint,
        ))?
    };
    Ok(ArchiveMcpKey::from_digest(Sha256::digest(material).into()))
}

fn vault_error() -> crate::db::agsdl_execution::dto::EngineFailure {
    failure(
        "VAULT_UNAVAILABLE",
        "secret",
        "The local vault is unavailable",
    )
}

fn permissions(preview: &ImportPreview, launch_mcp: &mcp::LaunchMcp) -> Result<Permissions> {
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
                    max_failures: agent.completion_check_max_failures.clone(),
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
    for (agent, servers) in &launch_mcp.agents {
        for (server, access) in servers {
            if access.equipped {
                permissions.capabilities.insert(serde_json::to_string(&(
                    "agent-mcp",
                    agent,
                    server,
                ))?);
            }
        }
    }
    for call in &preview.direct_calls {
        if let (Usage::Reachable, CallTarget::Shell { command }) = (call.usage, &call.target) {
            permissions
                .capabilities
                .insert(serde_json::to_string(&("shell", command))?);
        }
    }
    for (server, tools) in &launch_mcp.direct_tools {
        for tool in tools {
            permissions
                .capabilities
                .insert(serde_json::to_string(&("mcp", server, tool))?);
        }
    }
    for (id, remote) in &launch_mcp.remote {
        let digest = Sha256::digest(serde_json::to_vec(&("archive-mcp-http-consent/2", remote))?);
        permissions.mcp.insert(id.clone(), format!("{digest:x}"));
    }
    for (id, fingerprint) in &launch_mcp.stdio {
        let digest = Sha256::digest(serde_json::to_vec(&(
            "archive-mcp-stdio-consent/1",
            fingerprint,
            &preview.mcp_servers[id].required_secrets,
        ))?);
        permissions.mcp.insert(id.clone(), format!("{digest:x}"));
    }
    for reference in &preview.external_references {
        if reference.usage != Usage::DeclaredOnly
            && reference.kind != preview::ReferenceKind::McpEndpoint
        {
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
    legacy_reset_required: bool,
}

type ServerSecrets = BTreeMap<String, Vec<String>>;

fn secret_provider(
    input: &VersionInput,
    launch_mcp: &mcp::LaunchMcp,
) -> Result<std::sync::Arc<argentic_runtime::host::McpSecretProvider>> {
    let source = input.source_revision();
    let mut servers = BTreeMap::new();
    for (server, names) in &launch_mcp.secrets {
        let keys = names
            .iter()
            .map(|name| Ok((name.clone(), input.secret_id(server, name, launch_mcp)?)))
            .collect::<Result<Vec<_>>>()?;
        servers.insert(server.clone(), keys);
    }
    Ok(std::sync::Arc::new(move |revision, server, requested| {
        if revision != &source {
            return None;
        }
        let keys = servers.get(server)?;
        if !keys.iter().map(|(name, _)| name).eq(requested) {
            return None;
        }
        keys.iter()
            .map(|(name, key)| {
                let value = archive_mcp::get(key).ok()??;
                mcp::valid_secret(&value, false).then(|| (name.clone(), value))
            })
            .collect()
    }))
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

async fn saved_configuration(
    db: &mut SqliteConnection,
    blueprint_id: &str,
) -> Result<LaunchConfiguration> {
    let json: Option<String> = sqlx::query_scalar(
        "SELECT configuration_json FROM architect_launch_configurations WHERE blueprint_id=?",
    )
    .bind(blueprint_id)
    .fetch_optional(db)
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

async fn folder_in_use(db: &mut SqliteConnection, scope: &Value) -> Result<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM architect_launch_runs launch
          JOIN engine_flow030_runs run ON run.system_id=launch.system_id
          JOIN engine_start030_requests start ON start.system_id=launch.system_id
          WHERE (
            json_extract(run.state_json,'$.verdict') IS NULL OR
            EXISTS(SELECT 1 FROM json_each(run.state_json,'$.activations') WHERE json_extract(value,'$.physical')=1)
          ) AND (
            launch.working_folder=? OR
            json_extract(json_extract(json_extract(start.capture_json,'$.privateCaptureJson'),
              '$.callScopeJson'),'$.rootIdentity')=?
          ))",
    )
    .bind(scope["root"].as_str())
    .bind(scope["rootIdentity"].as_str())
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
        return Ok(());
    };
    let files = &server.packaged_files;
    let program_required = || Blocker::new("mcpRetainedProgramRequired", id);
    let program = command.first().ok_or_else(program_required)?;
    if let Some(path) = declared_mcp_path(program, files) {
        let member = input
            .archive
            .members()
            .find(|member| member.path == path && member.executable)
            .ok_or_else(program_required)?;
        // Match Argentic's private RetainedSource::allows_shebang check.
        let prefix = &member.bytes[..member.bytes.len().min(256)];
        if !prefix.strip_prefix(b"#!").is_none_or(|line| {
            line.iter().find(|&&byte| !matches!(byte, b' ' | b'\t')) == Some(&b'/')
        }) {
            return Err(Blocker::new("mcpAbsoluteInterpreterRequired", id));
        }
    } else if !matches!(program.as_str(), "sh" | "/bin/sh")
        || command
            .get(1)
            .and_then(|script| declared_mcp_path(script, files))
            .is_none()
    {
        return Err(program_required());
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
    ceiling: &crate::agsdl_permissions::RequestedPermissions,
    root: &Path,
    local_mcp_supported: bool,
    configuration: &LaunchConfiguration,
) -> Result<(Vec<Blocker>, mcp::LaunchMcp)> {
    let document = serde_json::from_str(input.archive.source().authored_json())?;
    let report = argentic_runtime::api::qualify_product(&document, None, Some(ceiling))?;
    let mut blockers = Vec::new();
    let mut launch_mcp = mcp::LaunchMcp {
        agents: mcp::agent_access(&document, preview, ceiling, root, &report.mcp_servers)?,
        qualification: report.mcp_servers,
        ..Default::default()
    };
    let workspace_calls = policy["agsdlHostPermissions"] == "workspace"
        && matches!(
            ceiling,
            crate::agsdl_permissions::RequestedPermissions::Preset(
                crate::agsdl_permissions::Preset::Workspace
            )
        )
        && !crate::core::tool_policy::agsdl_native_read_only(policy);
    for (id, server) in &preview.mcp_servers {
        let qualified = launch_mcp.qualification.get(id).ok_or_else(storage_error)?;
        if !qualified.is_used() {
            launch_mcp.notes.push(mcp::UnusedServer {
                server: id.clone(),
                unsupported_endpoint: qualified.diagnostic.is_some(),
            });
            continue;
        }
        if qualified.blocking_diagnostic().is_some() {
            blockers.push(Blocker::new("mcpEndpointUnsupported", id));
            continue;
        }
        let direct = !qualified.direct_call_steps.is_empty();
        if direct {
            let tools = qualified
                .direct_call_steps
                .iter()
                .map(|step| {
                    document
                        .pointer(step)
                        .and_then(|call| call["mcp"]["tool"].as_str())
                        .map(str::to_owned)
                        .ok_or_else(storage_error)
                })
                .collect::<Result<BTreeSet<_>>>()?;
            launch_mcp.direct_tools.insert(id.clone(), tools);
        }
        match &server.transport {
            McpTransport::Remote { url } => {
                if direct && !workspace_calls {
                    blockers.push(Blocker::new("mcpWorkspaceRequired", id));
                    continue;
                }
                let parsed = url::Url::parse(url).map_err(|_| storage_error())?;
                let default = mcp::RemoteSettings::default();
                let settings = configuration
                    .remote_mcp
                    .get(id)
                    .and_then(|endpoints| endpoints.get(parsed.as_str()))
                    .unwrap_or(&default);
                launch_mcp.remote_setup.insert(
                    id.clone(),
                    mcp::RemoteSetup::new(&parsed, &server.required_secrets, settings),
                );
                match mcp::RemoteGrant::new(parsed, &server.required_secrets, settings) {
                    Ok(grant) => {
                        launch_mcp.remote.insert(id.clone(), grant);
                    }
                    Err(code) => {
                        blockers.push(Blocker::new(code, id));
                        continue;
                    }
                }
            }
            McpTransport::Local { command } => {
                if let Err(blocker) = qualify_mcp(input, id, server) {
                    blockers.push(blocker);
                    continue;
                }
                if !local_mcp_supported {
                    blockers.push(Blocker::new("mcpIsolationUnavailable", id));
                    continue;
                }
                if direct && !workspace_calls {
                    blockers.push(Blocker::new("mcpWorkspaceRequired", id));
                    continue;
                }
                let fingerprint =
                    mcp::stdio_fingerprint(&input.archive, command, &server.packaged_files)
                        .ok_or_else(storage_error)?;
                launch_mcp.stdio.insert(id.clone(), fingerprint);
            }
        }
        launch_mcp
            .secrets
            .insert(id.clone(), server.required_secrets.clone());
    }
    for (id, agent) in &preview.agents {
        if agent.usage == Usage::Reachable && agent.harness != "codex" {
            blockers.push(Blocker::new("unsupportedHarness", id));
        }
    }
    Ok((blockers, launch_mcp))
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
    let mut configuration = match configuration {
        Some(configuration) => configuration,
        None => saved_configuration(&mut *pool.acquire().await?, &input.key.blueprint_id).await?,
    };
    let ceiling = manager
        .lock_agsdl_host_permissions()
        .await
        .map_err(|_| failure("PERMISSION", "policy", "The launch policy is unavailable"))?;
    let policy = manager
        .lock_execution_tools(PROJECT_ID)
        .await
        .map_err(|_| failure("PERMISSION", "policy", "The launch policy is unavailable"))?;
    let call_policy = call_permissions(&policy)?;
    let (mut blockers, launch_mcp) = requirements(
        &input,
        &permissions_preview,
        &call_policy,
        ceiling.permissions(),
        app_data,
        LOCAL_MCP_SUPPORTED,
        &configuration,
    )?;
    let mut summary = permissions(&permissions_preview, &launch_mcp)?;
    record_host_permissions(&mut summary, &policy.agsdl_host_permissions)?;
    record_host_permissions(&mut summary, ceiling.permissions())?;
    drop(policy);
    drop(ceiling);
    let mut reuse_token = None;
    if input.settings.working_folder_mode == WorkingFolderMode::AtLaunch {
        let folder = configuration
            .working_folder
            .as_deref()
            .and_then(|path| chosen_folder(path, app_data, manager.root()));
        if let Some(folder) = folder {
            let scope = start::scope_for(&folder, &owner(&input.key.blueprint_id))?;
            if folder_in_use(&mut *pool.acquire().await?, &scope).await? {
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
                if codex_write_unqualified(&permissions_preview, &call_policy, &observed) {
                    blockers.push(Blocker::codex("CODEX_WRITE_PROFILE_UNQUALIFIED"));
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
            Err(error) => blockers.push(Blocker::codex(error.code)),
        }
    }
    let secrets = secret_requirements(pool, &Storage::new(app_data), &input, &launch_mcp).await?;
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
        agent_mcp: launch_mcp.agents,
        remote_mcp: launch_mcp.remote,
        remote_mcp_setup: launch_mcp.remote_setup,
        mcp_direct_tools: launch_mcp.direct_tools,
        mcp_notes: launch_mcp.notes,
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
    configuration: Option<LaunchConfiguration>,
) -> Result<()> {
    let input = VersionInput::read(pool, &Storage::new(app_data), key).await?;
    let preview = input.preview()?;
    let configuration = match configuration {
        Some(configuration) => configuration,
        None => saved_configuration(&mut *pool.acquire().await?, &input.key.blueprint_id).await?,
    };
    let ceiling = manager
        .lock_agsdl_host_permissions()
        .await
        .map_err(|_| failure("PERMISSION", "policy", "The launch policy is unavailable"))?;
    let policy = manager
        .lock_execution_tools(PROJECT_ID)
        .await
        .map_err(|_| failure("PERMISSION", "policy", "The launch policy is unavailable"))?;
    let (_, launch_mcp) = requirements(
        &input,
        &preview,
        &call_permissions(&policy)?,
        ceiling.permissions(),
        app_data,
        LOCAL_MCP_SUPPORTED,
        &configuration,
    )?;
    if !launch_mcp
        .secrets
        .get(server)
        .is_some_and(|names| names.iter().any(|secret| secret == name))
        || !mcp::valid_secret(value, launch_mcp.remote.contains_key(server))
    {
        return Err(failure(
            "INVALID_LAUNCH_SECRET",
            "secret",
            "The secret is not required by this version or has no value",
        ));
    }
    archive_mcp::set(&input.secret_id(server, name, &launch_mcp)?, value).map_err(|_| vault_error())
}

#[cfg(test)]
mod tests;
