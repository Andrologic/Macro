//! Local launch preparation, independent of the desktop UI.
use crate::architect_library::{
    archive::{VersionArchive, ARCHIVE_FORMAT},
    editor_document::{MacroSettings, WorkingFolderMode},
    preview::{self, CallTarget, ImportPreview, McpTransport, Usage},
    storage::Storage,
};
use crate::config::ConfigManager;
use crate::db::{
    agsdl_execution::{dto::EngineSourceOwner, failure, Result},
    architect_library::VersionKey,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{SqliteConnection, SqlitePool};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    path::{Path, PathBuf},
};

pub(crate) mod start;

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
    folder_in_use: bool,
    blockers: Vec<Blocker>,
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
}

impl Permissions {
    fn covers(&self, other: &Self) -> bool {
        other.capabilities.is_subset(&self.capabilities)
            && other
                .mcp
                .iter()
                .all(|(name, digest)| self.mcp.get(name) == Some(digest))
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
    async fn read(pool: &SqlitePool, storage: &Storage, key: VersionKey) -> Result<Self> {
        let (_lease, archive, settings, digest, note) = storage
            .open_launch_version(pool, &key)
            .await
            .map_err(|_| storage_error())?;
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
        .map_err(|_| storage_error())
    }

    fn requires_start_message(&self, preview: &ImportPreview) -> bool {
        preview.entry_point.is_some() && self.settings.start_message_required.unwrap_or(true)
    }

    fn secret_id(&self, server: &str, name: &str) -> Result<String> {
        let digest = Sha256::digest(serde_json::to_vec(&(
            &self.key.blueprint_id,
            &self.origin,
            server,
            name,
        ))?);
        Ok(format!("architect-launch:{digest:x}"))
    }
}

fn permissions(input: &VersionInput, preview: &ImportPreview) -> Result<Permissions> {
    let mut permissions = Permissions::default();
    for (id, agent) in &preview.agents {
        if agent.usage != Usage::Reachable {
            continue;
        }
        if let Some(command) = &agent.completion_check {
            permissions.capabilities.insert(serde_json::to_string(&(
                "completionCheck",
                id,
                command,
            ))?);
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

fn secret_requirements(
    input: &VersionInput,
    preview: &ImportPreview,
) -> Result<Vec<SecretRequirement>> {
    let mut requirements = Vec::new();
    for (server_id, server) in &preview.mcp_servers {
        // Agent MCP equipment is unavailable in this engine profile. A
        // direct reachable call is the only currently qualified way to use it.
        if !direct_mcp(preview, server_id) {
            continue;
        }
        for name in &server.required_secrets {
            let stored = crate::secrets::get_api_key(&input.secret_id(server_id, name)?)
                .map_err(|_| {
                    failure(
                        "VAULT_UNAVAILABLE",
                        "secret",
                        "The local vault is unavailable",
                    )
                })?
                .is_some();
            requirements.push(SecretRequirement {
                server: server_id.clone(),
                name: name.clone(),
                stored,
            });
        }
    }
    Ok(requirements)
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

async fn folder_in_use(pool: &SqlitePool, folder: &Path) -> Result<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM architect_launch_runs launch
          JOIN engine_flow030_runs run ON run.system_id=launch.system_id
          WHERE launch.working_folder=? AND (
            json_extract(run.state_json,'$.verdict') IS NULL OR
            EXISTS(SELECT 1 FROM json_each(run.state_json,'$.activations') WHERE json_extract(value,'$.physical')=1)
          ))",
    )
    .bind(folder.to_str())
    .fetch_one(pool)
    .await?)
}

fn program_exists(name: &str, files: &[String], input: &VersionInput) -> bool {
    if files
        .iter()
        .any(|path| path == name.trim_start_matches("./"))
    {
        return input
            .archive
            .members()
            .any(|member| member.path == name.trim_start_matches("./") && member.executable);
    }
    let path = Path::new(name);
    if path.is_absolute() {
        return executable(path);
    }
    !name.contains('/')
        && ["/usr/bin", "/bin"]
            .iter()
            .any(|dir| executable(&Path::new(dir).join(name)))
}

fn executable(path: &Path) -> bool {
    path.metadata().is_ok_and(|meta| {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            meta.is_file() && meta.permissions().mode() & 0o111 != 0
        }
        #[cfg(not(unix))]
        meta.is_file()
    })
}

fn requirements(input: &VersionInput, preview: &ImportPreview) -> Result<Vec<Blocker>> {
    let mut blockers = Vec::new();
    for (id, server) in &preview.mcp_servers {
        if server.usage == Usage::DeclaredOnly {
            continue;
        }
        // The pinned runtime cannot receive a retained MCP program or a
        // per-server environment through HostContext. Refuse before admission.
        blockers.push(Blocker::new("mcpIsolationUnavailable", id));
        if let McpTransport::Local { command } = &server.transport {
            if let Some(program) = command.first() {
                if !program_exists(program, &server.packaged_files, input) {
                    blockers.push(Blocker::new("missingProgram", program));
                }
            }
        }
    }
    for (id, agent) in &preview.agents {
        if agent.usage == Usage::Reachable && agent.harness != "codex" {
            blockers.push(Blocker::new("unsupportedHarness", id));
        }
    }
    Ok(blockers)
}

pub(crate) async fn prepare(
    manager: &ConfigManager,
    pool: &SqlitePool,
    app_data: &Path,
    key: VersionKey,
    configuration: Option<LaunchConfiguration>,
) -> Result<LaunchPreview> {
    let input = VersionInput::read(pool, &Storage::new(app_data), key).await?;
    let permissions_preview = input.preview()?;
    let mut summary = permissions(&input, &permissions_preview)?;
    let policy = manager
        .lock_execution_tools(PROJECT_ID)
        .await
        .map_err(|_| failure("PERMISSION", "policy", "The launch policy is unavailable"))?;
    record_host_permissions(&mut summary, &policy.agsdl_host_permissions)?;
    drop(policy);
    let mut configuration = match configuration {
        Some(configuration) => configuration,
        None => saved_configuration(pool, &input.key.blueprint_id).await?,
    };
    let mut blockers = requirements(&input, &permissions_preview)?;
    let folder_in_use = if input.settings.working_folder_mode == WorkingFolderMode::AtLaunch {
        if let Some(folder) = configuration
            .working_folder
            .as_deref()
            .and_then(|path| chosen_folder(path, app_data, manager.root()))
        {
            folder_in_use(pool, &folder).await?
        } else {
            blockers.push(Blocker::new("workingFolderRequired", ""));
            false
        }
    } else {
        configuration.working_folder = None;
        false
    };
    if permissions_preview
        .agents
        .values()
        .any(|agent| agent.usage == Usage::Reachable && agent.harness == "codex")
    {
        let status = argentic_runtime::api::codex_status(&manager.engine_context()).await;
        if !status.available {
            blockers.push(Blocker::new("codexUnavailable", status.code));
        } else {
            // This workspace is empty and is used only for the native model
            // and account observation. A preview never starts an agent turn.
            let probe = tempfile::tempdir_in(app_data).map_err(|_| storage_error())?;
            let scope = start::scope_for(probe.path(), &owner(&input.key.blueprint_id))?;
            match start::observe_codex(manager, &scope).await {
                Ok(observed) => {
                    for (id, agent) in &permissions_preview.agents {
                        if agent.usage != Usage::Reachable || agent.harness != "codex" {
                            continue;
                        }
                        let name = agent.model.as_ref().and_then(|model| model.name.as_deref());
                        let effort = agent
                            .model
                            .as_ref()
                            .and_then(|model| model.effort.as_deref());
                        let available = observed.models.iter().any(|model| {
                            name.map_or(model["isDefault"] == true, |name| model["name"] == name)
                                && effort.is_none_or(|effort| {
                                    model["efforts"].as_array().is_some_and(|efforts| {
                                        efforts.iter().any(|value| value == effort)
                                    })
                                })
                        });
                        if !available {
                            blockers.push(Blocker::new("modelUnavailable", id));
                        }
                    }
                }
                Err(error) => blockers.push(Blocker::new("codexUnavailable", error.code)),
            }
        }
    }
    let secrets = secret_requirements(&input, &permissions_preview)?;
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
        folder_in_use,
        blockers,
        permissions: permissions_preview,
        consent_token,
        secrets,
    })
}

pub(crate) async fn set_secret(
    pool: &SqlitePool,
    app_data: &Path,
    key: VersionKey,
    server: &str,
    name: &str,
    value: &str,
) -> Result<()> {
    let input = VersionInput::read(pool, &Storage::new(app_data), key).await?;
    let preview = input.preview()?;
    if !direct_mcp(&preview, server)
        || !preview.mcp_servers.get(server).is_some_and(|server| {
            server.usage != Usage::DeclaredOnly
                && server.required_secrets.iter().any(|secret| secret == name)
        })
        || value.is_empty()
        || value.contains('\0')
    {
        return Err(failure(
            "INVALID_LAUNCH_SECRET",
            "secret",
            "The secret is not required by this version or has no value",
        ));
    }
    crate::secrets::set_api_key(&input.secret_id(server, name)?, value).map_err(|_| {
        failure(
            "VAULT_UNAVAILABLE",
            "secret",
            "The local vault is unavailable",
        )
    })
}

#[cfg(test)]
mod tests;
