//! Macro starts with the local profile open or displays profile recovery.
//! Restore and rollback finish before any normal profile service opens SQLite or config.
use crate::architect_library::{
    editor_document::{portable_path, Paths},
    private_directory,
    storage::{self, Storage},
};
use crate::db::architect_library::storage_index;
use crate::fs::profile::{
    self, create_private_file, create_private_root, fits_existing_file, fits_export_destination,
    ProfileFile,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::Arc,
};
use tauri::Manager;

mod bundle;
mod launch;

const ARCHITECT_FILES: &str = "data/architect-library/blueprints/";
const LIMIT: u64 = 256 * 1024 * 1024;
const DATABASE_ENTRIES: &[&str] = &["data/macro.db", "data/macro.db-wal", "data/macro.db-shm"];
// Keep small DB entries readable by existing profile bundle readers.
const INLINE_DATABASE_LIMIT: u64 = 16 * 1024 * 1024;
const PROVIDER_SECRETS_FILE: &str = "provider-secrets.json";
const PROVIDER_SECRETS_RECOVERY_FILES: &[&str] = &[
    PROVIDER_SECRETS_FILE,
    "provider-secrets.migration-pending.json",
    "provider-secrets.json.v1.bak",
    "provider-secrets.json.v0.bak",
];
const CONFIG_FILES: &[&str] = &[
    "settings.json",
    "agents.json",
    "providers.json",
    "tools.json",
    "skills.json",
    "git.json",
    "runtime.json",
];
const CLIENT_KEYS: &[&str] = &[
    "macro_chat_message_images",
    "macro_chat_composer_drafts_v1",
    "macro_chat_questionnaire_drafts",
    "macro_chat_queued_submissions_v1",
    "macro_chat_unsaved_assistant_responses_v1",
];
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Entry {
    data: String,
    sha256: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    executable: bool,
    #[serde(skip)]
    native: Option<bundle::NativeEntry>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Archive {
    format: String,
    version: u32,
    app_version: String,
    files: BTreeMap<String, Entry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    launch: Option<launch::Manifest>,
    browser: BTreeMap<String, String>,
    browser_sha256: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    operation: String,
    path: String,
    browser: BTreeMap<String, String>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(ts_rs::TS)]
pub struct BackupStatus {
    // Legacy messages remain readable as diagnostics after an upgrade.
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub code: Option<BackupStatusCode>,
    #[serde(default)]
    pub path: Option<String>,
    pub browser: Option<BTreeMap<String, String>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(ts_rs::TS)]
pub enum BackupStatusCode {
    Exported,
    Restored,
    RolledBack,
    Failed,
    InvalidRequest,
}

fn staging_root(dir: &Path) -> Result<PathBuf> {
    let root = dir.join("staging");
    storage::ensure_dir(dir, &root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn private_staging(data: &Path) -> Result<tempfile::TempDir> {
    let dir = data.join("local-backup");
    storage::ensure_dir(data, &dir).map_err(|error| error.to_string())?;
    let stage = private_directory(&staging_root(&dir)?, "b-").map_err(|error| error.to_string())?;
    Ok(stage)
}

fn backup_lock(dir: &Path) -> Result<fs::File> {
    let lock = dir.join(".lock");
    if fs::symlink_metadata(&lock)
        .is_ok_and(|meta| !meta.is_file() || storage::is_link_or_reparse_point(&meta))
    {
        return Err("Invalid profile backup lock".into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(&lock).map_err(|error| error.to_string())?;
    profile::lock_exclusive(&file, &lock).map_err(|error| error.to_string())?;
    Ok(file)
}

fn reclaim_backup_staging(dir: &Path) -> Result<()> {
    let root = staging_root(dir)?;
    for entry in fs::read_dir(&root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            profile::remove_dir_all(entry.path()).map_err(|error| error.to_string())?;
        } else {
            profile::remove_file(entry.path()).map_err(|error| error.to_string())?;
        }
    }
    sync_directory(&root)
}

const EXPORT_STAGE: &str = "export-staging.json";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExportStage {
    directory: PathBuf,
    id: uuid::Uuid,
}

impl ExportStage {
    fn path(&self) -> PathBuf {
        self.directory.join(format!(".backup-{}", self.id))
    }
}

fn reclaim_export_staging(dir: &Path) -> Result<()> {
    let record = dir.join(EXPORT_STAGE);
    if !record.try_exists().map_err(|error| error.to_string())? {
        return Ok(());
    }
    let stage: ExportStage =
        serde_json::from_slice(&read_bounded(&record)?).map_err(|error| error.to_string())?;
    if !stage.directory.is_absolute()
        || stage
            .directory
            .canonicalize()
            .map_err(|error| error.to_string())?
            != stage.directory
    {
        return Err("Profile backup staging directory changed".into());
    }
    match profile::remove_file(stage.path()) {
        Ok(()) => sync_directory(&stage.directory)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    remove_durable(&record)
}

/// The destination can be on another filesystem. Record the private sibling
/// before creating it so a killed writer can be cleaned up on the next launch.
fn publish_export(dir: &Path, path: &Path, archive: &Archive) -> Result<()> {
    let stage = ExportStage {
        directory: path
            .parent()
            .ok_or("Missing export directory")?
            .canonicalize()
            .map_err(|error| error.to_string())?,
        id: uuid::Uuid::new_v4(),
    };
    let temporary = stage.path();
    let record = dir.join(EXPORT_STAGE);
    let bytes = serde_json::to_vec(&stage).map_err(|error| error.to_string())?;
    write_atomically(&record, &staging_root(dir)?, false, |file| {
        file.write_all(&bytes)
    })?;
    let result = (|| {
        let mut file = create_private_file(&temporary, false).map_err(|error| error.to_string())?;
        bundle::write(archive, &mut file)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        drop(file);
        profile::rename_without_replacement(&temporary, path).map_err(|error| error.to_string())?;
        sync_directory(&stage.directory)
    })();
    result.and(reclaim_export_staging(dir))
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn entry_hash(bytes: &[u8], executable: bool) -> String {
    let mut digest = entry_digest(executable);
    digest.update(bytes);
    format!("{:x}", digest.finalize())
}
fn entry_digest(executable: bool) -> Sha256 {
    let mut digest = Sha256::new();
    if executable {
        digest.update(b"macro-backup-executable\0");
    }
    digest
}
fn client_key(key: &str) -> bool {
    CLIENT_KEYS.contains(&key)
        || key.starts_with("agentCodeCheckpoints:")
        || key.starts_with("agentCodeReplayRecovery:")
}
fn validate_browser(browser: &BTreeMap<String, String>) -> Result<()> {
    if browser.len() > 10_000
        || browser
            .iter()
            .any(|(k, v)| !client_key(k) || k.len() > 4096 || v.len() > 40_000_000)
        || browser.values().map(String::len).sum::<usize>() > 50_000_000
    {
        return Err("Invalid or oversized browser state".into());
    }
    Ok(())
}
fn read_bounded(path: &Path) -> Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || storage::is_link_or_reparse_point(&metadata) || metadata.len() > LIMIT
    {
        return Err("Backup entry is not a bounded regular file".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > LIMIT {
        return Err("Backup entry exceeds size limit".into());
    }
    Ok(bytes)
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    publish_new(path, |file| file.write_all(bytes))
}
fn publish_new(
    path: &Path,
    write: impl FnOnce(&mut ProfileFile<&mut fs::File>) -> io::Result<()>,
) -> Result<()> {
    write_atomically(path, path.parent().ok_or("Missing parent")?, false, write)
}

fn write_atomically(
    path: &Path,
    staging: &Path,
    replace: bool,
    write: impl FnOnce(&mut ProfileFile<&mut fs::File>) -> io::Result<()>,
) -> Result<()> {
    let mut file = tempfile::NamedTempFile::new_in(staging).map_err(|e| e.to_string())?;
    write(&mut ProfileFile::new(file.as_file_mut(), path)).map_err(|e| e.to_string())?;
    profile::sync_file(file.as_file(), path).map_err(|e| e.to_string())?;
    profile::persist(file, path, replace).map_err(|e| e.to_string())?;
    sync_parent(path)?;
    sync_directory(staging)
}

fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("Missing parent")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    write_atomically(path, &staging_root(parent)?, true, |file| {
        file.write_all(bytes)
    })
}

fn sync_parent(path: &Path) -> Result<()> {
    sync_directory(path.parent().ok_or("Missing parent")?)
}

fn sync_directory(path: &Path) -> Result<()> {
    profile::sync_directory(path).map_err(|error| error.to_string())
}

fn write_journaled(path: &Path, name: &str, entry: &Entry) -> Result<ProfileFile<fs::File>> {
    let mut file =
        create_private_file(path, entry.executable).map_err(|error| error.to_string())?;
    entry
        .copy_verified(name, &mut file)
        .map_err(|error| error.to_string())?;
    Ok(file)
}

const FILE_SYNC_BATCH: usize = 128;

// Nothing can publish restore status until all data and directories are
// durable. A bounded batch lets the filesystem group concurrent syncs.
fn sync_written_files(files: &mut Vec<ProfileFile<fs::File>>) -> Result<()> {
    let sync = |files: &[ProfileFile<fs::File>]| files.iter().try_for_each(ProfileFile::sync_all);
    let result = if files.len() < 32 {
        sync(files)
    } else {
        std::thread::scope(|scope| {
            let workers: Vec<_> = files
                .chunks(files.len().div_ceil(8))
                .map(|files| scope.spawn(move || sync(files)))
                .collect();
            for worker in workers {
                worker
                    .join()
                    .map_err(|_| io::Error::other("Profile file sync worker failed"))??;
            }
            Ok(())
        })
    };
    result.map_err(|error| error.to_string())?;
    files.clear();
    Ok(())
}

fn remove_durable(path: &Path) -> Result<()> {
    profile::remove_file(path).map_err(|error| error.to_string())?;
    sync_parent(path)
}
fn remove_journal(path: &Path) -> Result<()> {
    profile::remove_file(path).map_err(|error| error.to_string())?;
    if let Err(error) = sync_parent(path) {
        // A crash may replay InstallHold. The installed files and status are
        // already durable and safe to open on this launch.
        tracing::warn!(%error, "Could not sync removed profile recovery journal");
    }
    Ok(())
}

fn remove_incoming(dir: &Path) -> io::Result<()> {
    match profile::remove_file(dir.join("incoming.json")) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

fn cleanup_incoming(dir: &Path) {
    if let Err(error) = remove_incoming(dir) {
        tracing::warn!(%error, "Could not remove the unused profile restore staging file");
    }
}

fn stage_incoming(dir: &Path, archive: &Archive) -> Result<()> {
    // The request is published only after this file is complete and durable.
    // An interrupted write leaves an unreferenced incoming.json for startup.
    remove_incoming(dir).map_err(|error| error.to_string())?;
    let mut file = create_private_file(&dir.join("incoming.json"), false)
        .map_err(|error| error.to_string())?;
    bundle::write(archive, &mut file)
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())?;
    sync_directory(dir)
}

fn architect_artifact_prefix(name: &str) -> Option<&str> {
    let relative = name.strip_prefix(ARCHITECT_FILES)?;
    let mut parts = relative.splitn(4, '/');
    let blueprint = parts.next()?;
    let kind = parts.next()?;
    let artifact = parts.next()?;
    let member = parts.next()?;
    if !storage::valid_blueprint_directory(blueprint) || !storage::canonical_uuid(artifact) {
        return None;
    }
    let valid = match kind {
        "drafts" => {
            matches!(member, storage::SETTINGS | storage::AUTHORING)
                || member.strip_prefix("project/").is_some_and(portable_path)
        }
        "versions" => matches!(
            member,
            "version.agsdl" | storage::SETTINGS | storage::AUTHORING
        ),
        "recovery" => matches!(
            member,
            storage::ORIGINAL | storage::AUTHORING | "diagnostics.json"
        ),
        _ => false,
    };
    valid.then(|| &name[..name.len() - member.len()])
}

fn validate_architect_paths(files: &BTreeMap<String, Entry>) -> Result<()> {
    let mut paths = Paths::default();
    for (name, entry) in files {
        if name.starts_with(ARCHITECT_FILES) {
            let prefix =
                architect_artifact_prefix(name).ok_or("Unexpected Architect backup entry")?;
            if !paths.reserve(name)
                || (entry.executable && !name[prefix.len()..].starts_with("project/"))
            {
                return Err("Invalid Architect backup entry".into());
            }
        } else if entry.executable && !launch::file(name) {
            return Err("Unexpected executable backup entry".into());
        }
    }
    Ok(())
}

fn destination(name: &str, data: &Path, config: &Path) -> Result<PathBuf> {
    if name.contains('\\')
        || name.contains(':')
        || name.len() > 4096
        || name
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("Unsafe backup path".into());
    }
    if Path::new(name)
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Unsafe backup path".into());
    }
    if launch::destination_path(name) {
        return if let Some(relative) = name.strip_prefix("data/") {
            Ok(data.join(relative))
        } else {
            Ok(config.join(name.strip_prefix("config/").unwrap()))
        };
    }
    if name == "data/macro.db"
        || name == "data/state.json"
        || name.starts_with("data/direct-checkpoints/")
        || architect_artifact_prefix(name).is_some()
    {
        return Ok(data.join(name.strip_prefix("data/").unwrap()));
    }
    if let Some(relative) = name.strip_prefix("config/") {
        if CONFIG_FILES.contains(&relative) {
            return Ok(config.join(relative));
        }
        if let Some(file) = relative
            .strip_prefix(".runtime/approved/user/")
            .or_else(|| relative.strip_prefix(".runtime/pending/user/"))
        {
            if CONFIG_FILES.contains(&file) {
                return Ok(config.join(relative));
            }
        }
    }
    Err("Unexpected backup entry".into())
}
// Count the same implicit directories and depth as the checkpoint walk.
fn validate_checkpoint_paths(files: &BTreeMap<String, Entry>) -> Result<()> {
    let mut nodes = BTreeSet::new();
    for name in files
        .keys()
        .filter(|name| name.starts_with("data/direct-checkpoints/"))
    {
        let relative = Path::new(name.strip_prefix("data/").unwrap());
        if relative.components().count() > 32 {
            return Err("Checkpoint tree exceeds depth limit".into());
        }
        for ancestor in relative
            .ancestors()
            .filter(|path| !path.as_os_str().is_empty())
        {
            if ancestor != relative
                && files.contains_key(&format!(
                    "data/{}",
                    ancestor.to_string_lossy().replace('\\', "/")
                ))
            {
                return Err("Checkpoint path is both a file and a directory".into());
            }
            nodes.insert(ancestor.to_path_buf());
            if nodes.len() > 10_000 {
                return Err("Checkpoint tree exceeds entry limit".into());
            }
        }
    }
    Ok(())
}

fn validate_export_path(path: &Path, data: &Path, config: &Path) -> Result<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("An absolute backup path without parent traversal is required".into());
    }
    let parent = path
        .parent()
        .ok_or("Missing export directory")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    for root in [data, config] {
        // Both profile roots are initialized before scheduling or startup capture.
        let root = root.canonicalize().map_err(|e| e.to_string())?;
        if parent.starts_with(root) {
            return Err(
                "Backup destination must be outside the profile and configuration directories"
                    .into(),
            );
        }
    }
    let file = path.file_name().ok_or("Missing backup filename")?;
    if !fits_export_destination(&parent.join(file)) {
        return Err("Backup destination exceeds the filesystem path limit".into());
    }
    if fs::symlink_metadata(path).is_ok() {
        return Err("Choose a new backup file; existing files are preserved".into());
    }
    Ok(())
}

async fn connection(path: &Path) -> Result<SqliteConnection> {
    SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .pragma("recursive_triggers", "ON")
            .read_only(false)
            .create_if_missing(false),
    )
    .await
    .map_err(|e| e.to_string())
}
// Only remove objects from our freshly built reference, never from an archive.
pub(crate) async fn remove_reference_e_schema(
    db: &mut SqliteConnection,
    versions: &[i64],
) -> Result<()> {
    if !versions.contains(&16) {
        let triggers: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'e_source_version_*'")
            .fetch_all(&mut *db).await.map_err(|e| e.to_string())?;
        for name in triggers {
            sqlx::query(sqlx::AssertSqlSafe(format!("DROP TRIGGER {name}")))
                .execute(&mut *db)
                .await
                .map_err(|e| e.to_string())?;
        }
        sqlx::raw_sql("DROP TABLE e_source_relations; DROP TABLE e_source_fragments; DROP TABLE e_source_fields; DROP TABLE e_source_captures; DROP TABLE e_source_version;")
            .execute(&mut *db).await.map_err(|e| e.to_string())?;
    }
    if !versions.contains(&15) {
        sqlx::raw_sql("DROP TABLE e_inactive_mapping; DROP TABLE e_inactive_fragments; DROP TABLE e_inactive_records; DROP TABLE e_inactive_imports; DROP TABLE e_inactive_domain;")
            .execute(db).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Let the pinned runtime materialize its lazy recovery schema on a disposable
/// database. Compare only objects absent from its initial schema, and never
/// execute DDL read from the archive.
async fn argentic_optional_schema() -> Result<BTreeMap<String, Vec<String>>> {
    let engine = argentic_runtime::sqlite::memory()
        .await
        .map_err(|e| e.to_string())?;
    let query = "SELECT tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL
        ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name";
    let before: BTreeSet<(String, String)> = sqlx::query_as::<_, (String, String)>(query)
        .fetch_all(&engine)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();
    seed_paused_schema_probe(&engine).await?;
    argentic_runtime::api::interrupt_previous_runs(&engine)
        .await
        .map_err(|e| e.message)?;
    let after: Vec<(String, String)> = sqlx::query_as(query)
        .fetch_all(&engine)
        .await
        .map_err(|e| e.to_string())?;
    engine.close().await;
    let mut optional = BTreeMap::<String, Vec<String>>::new();
    for (table, ddl) in after {
        if !before.contains(&(table.clone(), ddl.clone())) {
            optional.entry(table).or_default().push(ddl);
        }
    }
    Ok(optional)
}

async fn seed_paused_schema_probe(pool: &sqlx::SqlitePool) -> Result<()> {
    sqlx::raw_sql(r#"
        INSERT INTO engine_flow030_runs VALUES ('schema','flow','snapshot','epoch','{}',
            '{"versions":{"contract":"agsdl-0.4.0"}}','{"paused":true}');
        INSERT INTO engine_flow030_owners VALUES ('schema','flow','snapshot','epoch','1','previous','live',
            '0000000000000000000000000000000000000000000000000000000000000000');
    "#).execute(pool).await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn check_database(path: &Path) -> Result<()> {
    let mut db = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .read_only(true)
            .pragma("recursive_triggers", "ON"),
    )
    .await
    .map_err(|e| e.to_string())?;
    let check: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&mut db)
        .await
        .map_err(|e| e.to_string())?;
    if check != "ok" {
        return Err("SQLite integrity check failed".into());
    }
    let versions = crate::db::migration_history::canonical_versions(&mut db)
        .await
        .map_err(|e| e.to_string())?;
    if !versions.contains(&1) || !versions.contains(&3) || !versions.contains(&4) {
        return Err("Incompatible database schema".into());
    }
    let has_trace = versions.contains(&10);
    let has_management = versions.contains(&11);
    let legacy_trace: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=6 AND name='006_pilot_tool_trace_revisions')").fetch_one(&mut db).await.map_err(|e|e.to_string())?;
    let legacy_management: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=7 AND name='007_conversation_management')").fetch_one(&mut db).await.map_err(|e|e.to_string())?;
    let reference_dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let reference = crate::db::create_pool(&reference_dir.path().join("reference.db"))
        .await
        .map_err(|e| e.to_string())?;
    let has_ledger: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='migration_identity_history')").fetch_one(&mut db).await.map_err(|e|e.to_string())?;
    if !has_ledger {
        let unified: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version>=20 AND (version,name) NOT IN ((20,'020_connect_archive_lifecycle'),(21,'021_connect_target_abort'),(22,'022_connect_target_activation')))")
                .fetch_one(&mut db)
                .await
                .map_err(|e| e.to_string())?;
        if unified {
            return Err("Unified migration history is missing its identity ledger".into());
        }
        sqlx::query("DROP TABLE migration_identity_history")
            .execute(&reference)
            .await
            .map_err(|e| e.to_string())?;
    }
    crate::db::migration_history::remove_reference_schema(
        &mut *reference.acquire().await.map_err(|e| e.to_string())?,
        &versions,
    )
    .await
    .map_err(|e| e.to_string())?;
    // Compare the archive with the schema its migration stamps describe. Do
    // not migrate the untrusted archive until its original objects pass this
    // strict comparison; startup validation migrates a temporary copy later.
    if versions.contains(&storage_index::VERSION) {
        let mut tx = reference.begin().await.map_err(|e| e.to_string())?;
        storage_index::begin_cutover(&mut tx)
            .await
            .map_err(|e| e.to_string())?;
        storage_index::finish_cutover(&mut tx)
            .await
            .map_err(|e| e.to_string())?;
        if versions.contains(&crate::architect_launch::SCHEMA_VERSION) {
            let through = if versions.contains(&crate::architect_launch::OWNER_SCHEMA_VERSION) {
                crate::architect_launch::OWNER_SCHEMA_VERSION
            } else {
                crate::architect_launch::SCHEMA_VERSION
            };
            crate::architect_launch::migrate_through(&mut tx, through)
                .await
                .map_err(|e| e.to_string())?;
        }
        tx.commit().await.map_err(|e| e.to_string())?;
    }
    if !versions.contains(&47) {
        sqlx::query("DROP TABLE architect_legacy_import")
            .execute(&reference)
            .await
            .map_err(|error| error.to_string())?;
    }
    if !versions.contains(&46) {
        crate::db::architect_library::remove_reference_schema(
            &mut *reference.acquire().await.map_err(|e| e.to_string())?,
        )
        .await
        .map_err(|e| e.to_string())?;
    }
    if !versions.contains(&45) {
        crate::db::connect_transfer::remove_target_activation_reference_in(
            &mut *reference.acquire().await.map_err(|e| e.to_string())?,
        )
        .await
        .map_err(|e| e.to_string())?;
    }
    if !versions.contains(&44) {
        crate::db::connect_transfer::remove_target_abort_reference_in(
            &mut *reference.acquire().await.map_err(|e| e.to_string())?,
        )
        .await
        .map_err(|e| e.to_string())?;
    }
    if !versions.contains(&43) {
        crate::db::connect_transfer::remove_reader_reference_in(
            &mut *reference.acquire().await.map_err(|e| e.to_string())?,
        )
        .await
        .map_err(|e| e.to_string())?;
    }
    if !versions.contains(&19) {
        crate::db::connect_transfer::remove_publication_reference_in(
            &mut *reference.acquire().await.map_err(|e| e.to_string())?,
        )
        .await
        .map_err(|e| e.to_string())?;
    }
    if !versions.contains(&18) {
        crate::db::connect_transfer::remove_reference_schema_in(
            &mut *reference.acquire().await.map_err(|e| e.to_string())?,
        )
        .await
        .map_err(|e| e.to_string())?;
    }
    if !versions.contains(&17) {
        crate::db::chat_admission::remove_reference_schema(&reference)
            .await
            .map_err(|e| e.to_string())?;
    }
    remove_reference_e_schema(
        &mut *reference.acquire().await.map_err(|e| e.to_string())?,
        &versions,
    )
    .await?;
    if !versions.contains(&14) {
        crate::db::conversation_catalog::remove_reference_schema(&reference)
            .await
            .map_err(|e| e.to_string())?;
    }
    if !versions.contains(&13) {
        crate::db::conversation_content::remove_reference_schema(&reference)
            .await
            .map_err(|e| e.to_string())?;
    }
    if !versions.contains(&12) {
        // Version 12 added these tables. An older archive must match its own
        // schema, without accepting newer undeclared tables as extra objects.
        for statement in [
            "DROP TABLE pilot_file_chunks",
            "DROP TABLE pilot_file_sends",
            "DROP TABLE pilot_message_attachments",
            "DROP TABLE pilot_file_transfers",
            "DROP TABLE pilot_file_sources",
            "DROP TABLE pilot_file_binding_history",
            "DROP TABLE pilot_file_authorities",
        ] {
            sqlx::query(statement)
                .execute(&reference)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    if !has_management {
        for statement in [
            "DROP TRIGGER conversation_management_insert",
            "DROP TRIGGER conversation_management_update",
            "DROP TRIGGER conversation_response_insert",
            "DROP TRIGGER conversation_response_update",
            "DROP TABLE conversation_response_versions",
            "DROP TABLE conversation_action_receipts",
            "DROP TABLE conversation_management",
        ] {
            sqlx::query(statement)
                .execute(&reference)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    if !has_trace {
        for statement in [
            "DROP TRIGGER messages_tool_trace_revision_insert",
            "DROP TRIGGER messages_tool_trace_revision_delete",
            "DROP TRIGGER messages_tool_trace_revision_update_same_conversation",
            "DROP TRIGGER messages_tool_trace_revision_update_conversation",
            "DROP TABLE conversation_tool_trace_revisions",
        ] {
            sqlx::query(statement)
                .execute(&reference)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    if !versions.contains(&9) {
        sqlx::query("DROP TRIGGER conversation_goal_audit_run_status")
            .execute(&reference)
            .await
            .map_err(|e| e.to_string())?;
        for statement in [
            "DROP TABLE conversation_goal_audit_runs",
            "DROP TABLE conversation_goal_audits",
            "DROP TABLE conversation_goals",
        ] {
            sqlx::query(statement)
                .execute(&reference)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    if !versions.contains(&8) {
        sqlx::query("DROP TABLE agent_run_transitions")
            .execute(&reference)
            .await
            .map_err(|e| e.to_string())?;
    }
    if !versions.contains(&7) || legacy_management {
        sqlx::query("DROP TABLE tool_invocations")
            .execute(&reference)
            .await
            .map_err(|e| e.to_string())?;
    }
    if !versions.contains(&6) || legacy_trace {
        sqlx::query("ALTER TABLE messages DROP COLUMN generation_attempts_json")
            .execute(&reference)
            .await
            .map_err(|e| e.to_string())?;
    }
    let table_query = "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
    let tables: Vec<String> = sqlx::query_scalar(table_query)
        .fetch_all(&mut db)
        .await
        .map_err(|e| e.to_string())?;
    let mut expected: Vec<String> = sqlx::query_scalar(table_query)
        .fetch_all(&reference)
        .await
        .map_err(|e| e.to_string())?;
    let mut optional_tables = BTreeSet::new();
    if versions.contains(&41)
        && tables
            .iter()
            .any(|table| expected.binary_search(table).is_err())
    {
        for (table, ddl) in argentic_optional_schema().await? {
            if tables.contains(&table) && !expected.contains(&table) {
                for statement in ddl {
                    sqlx::raw_sql(sqlx::AssertSqlSafe(statement))
                        .execute(&reference)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                optional_tables.insert(table.clone());
                expected.push(table);
            }
        }
        expected.sort();
    }
    if tables != expected {
        return Err("Backup database tables do not match this Macro version".into());
    }
    for table in tables {
        if matches!(
            table.as_str(),
            "architect_projects"
                | "architect_legacy_import"
                | "architect_blueprints"
                | "architect_versions"
                | "architect_library_originals"
                | "architect_version_uses"
        ) || optional_tables.contains(&table)
            || table.starts_with("engine_")
            || table.starts_with("operate_inbox_")
            || table.starts_with("architect_launch_")
            || table == "migration_identity_history"
            || table.starts_with("connect_")
            || table.starts_with("chat_admission_")
            || table.starts_with("e_inactive_")
            || table.starts_with("e_source_")
            || table == "conversation_catalog_version"
            || table == "conversation_content_versions"
            || table == "tool_invocations"
            || table == "agent_run_transitions"
            || table == "conversation_goals"
            || table.starts_with("conversation_goal_")
        {
            // This table has no legacy schema variants. Compare its full DDL
            // so a backup cannot omit its CHECK constraints while retaining
            // the same columns, foreign key, and indexes.
            let query = "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?";
            let actual: String = sqlx::query_scalar(query)
                .bind(&table)
                .fetch_one(&mut db)
                .await
                .map_err(|e| e.to_string())?;
            let expected: String = sqlx::query_scalar(query)
                .bind(&table)
                .fetch_one(&reference)
                .await
                .map_err(|e| e.to_string())?;
            if actual != expected {
                return Err(format!("Incompatible backup table constraints: {table}"));
            }
        }
        let query =
            "SELECT name || ':' || type || ':' || pk FROM pragma_table_info(?) ORDER BY name";
        let actual: Vec<String> = sqlx::query_scalar(query)
            .bind(&table)
            .fetch_all(&mut db)
            .await
            .map_err(|e| e.to_string())?;
        let expected: Vec<String> = sqlx::query_scalar(query)
            .bind(&table)
            .fetch_all(&reference)
            .await
            .map_err(|e| e.to_string())?;
        if actual != expected {
            return Err(format!("Incompatible backup table: {table}"));
        }
        // Compare constraints structurally: legacy ALTER TABLE migrations can
        // produce equivalent ordinary tables with different SQL text/order.
        type ForeignKey = (i64, i64, String, String, String, String, String, String);
        let query = r#"SELECT id, seq, "table", "from", "to", on_update, on_delete, match
            FROM pragma_foreign_key_list(?) ORDER BY id, seq"#;
        let actual: Vec<ForeignKey> = sqlx::query_as(query)
            .bind(&table)
            .fetch_all(&mut db)
            .await
            .map_err(|e| e.to_string())?;
        let expected: Vec<ForeignKey> = sqlx::query_as(query)
            .bind(&table)
            .fetch_all(&reference)
            .await
            .map_err(|e| e.to_string())?;
        if actual != expected {
            return Err(format!("Incompatible backup foreign keys: {table}"));
        }
    }
    let schema_query = r#"
        SELECT type || ':' || name || ':' || sql
        FROM sqlite_master
        WHERE type IN ('trigger', 'view')
           OR (type = 'table' AND lower(trim(sql)) LIKE 'create virtual table%')
           OR (type = 'index' AND sql IS NOT NULL)
        ORDER BY type, name
    "#;
    let actual_schema: Vec<String> = sqlx::query_scalar(schema_query)
        .fetch_all(&mut db)
        .await
        .map_err(|e| e.to_string())?;
    let expected_schema: Vec<String> = sqlx::query_scalar(schema_query)
        .fetch_all(&reference)
        .await
        .map_err(|e| e.to_string())?;
    if actual_schema != expected_schema {
        return Err("Backup database schema objects do not match this Macro version".into());
    }
    if versions.contains(&14) {
        crate::db::conversation_catalog::validate_schema(&mut db)
            .await
            .map_err(|e| e.to_string())?;
    }
    reference.close().await;
    let violations = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut db)
        .await
        .map_err(|e| e.to_string())?;
    if !violations.is_empty() {
        return Err("SQLite foreign key check failed".into());
    }
    db.close().await.map_err(|e| e.to_string())
}

async fn check_database_startup(path: &Path) -> Result<()> {
    let pool = crate::db::create_pool(path)
        .await
        .map_err(|error| format!("Database startup check failed: {error}"))?;
    pool.close().await;
    Ok(())
}
async fn snapshot_database(source: &Path, target: &Path, portable: bool) -> Result<()> {
    let mut db = connection(source).await?;
    write_new(target, &[])?;
    sqlx::query("VACUUM INTO ?")
        .bind(target.to_string_lossy().as_ref())
        .execute(&mut db)
        .await
        .map_err(|e| e.to_string())?;
    db.close().await.map_err(|e| e.to_string())?;
    if portable {
        let mut copy = connection(target).await?;
        sqlx::query("UPDATE provider_configs SET api_key = NULL, has_stored_api_key = 0, auth_status = NULL, auth_source = NULL, token_expires_at = NULL").execute(&mut copy).await.map_err(|e| e.to_string())?;
        sqlx::query("UPDATE speech_provider_configs SET has_stored_api_key = 0")
            .execute(&mut copy)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("VACUUM")
            .execute(&mut copy)
            .await
            .map_err(|e| e.to_string())?;
        copy.close().await.map_err(|e| e.to_string())?;
    }
    check_database(target).await
}
fn add_file(files: &mut BTreeMap<String, Entry>, name: String, bytes: Vec<u8>) -> Result<()> {
    add_file_with_mode(files, name, bytes, false)
}

fn add_file_with_mode(
    files: &mut BTreeMap<String, Entry>,
    name: String,
    bytes: Vec<u8>,
    executable: bool,
) -> Result<()> {
    if files
        .values()
        .filter(|entry| entry.native.is_none())
        .count()
        >= 10_000
        || files.values().map(|e| e.data.len()).sum::<usize>() + bytes.len() * 4 / 3
            > LIMIT as usize
    {
        return Err("Profile exceeds the 256 MiB backup limit".into());
    }
    files.insert(
        name,
        Entry {
            sha256: entry_hash(&bytes, executable),
            executable,
            data: STANDARD.encode(bytes),
            native: None,
        },
    );
    Ok(())
}
fn add_database_file(
    files: &mut BTreeMap<String, Entry>,
    snapshot: &Arc<tempfile::TempDir>,
    name: &str,
    path: &Path,
) -> Result<()> {
    let meta = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !meta.is_file() || storage::is_link_or_reparse_point(&meta) {
        return Err("Database backup entry is not a regular file".into());
    }
    if meta.len() <= INLINE_DATABASE_LIMIT {
        return add_file(files, name.into(), read_bounded(path)?);
    }
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    files.insert(name.into(), bundle::stage(snapshot, name, file, false)?);
    Ok(())
}

fn archive_relative_path(path: &Path) -> Result<String> {
    path.components()
        .map(|component| match component {
            Component::Normal(part) => part
                .to_str()
                .filter(|part| !part.contains('\\'))
                .ok_or("Invalid backup filename".to_owned()),
            _ => Err("Invalid backup path".into()),
        })
        .collect::<Result<Vec<_>>>()
        .map(|parts| parts.join("/"))
}
fn collect_tree(root: &Path, path: &Path, files: &mut BTreeMap<String, Entry>) -> Result<()> {
    walk_tree(root, path, &mut Some(10_000), &mut |name, path, _| {
        add_file(files, name, read_bounded(path)?)
    })
}

fn collect_artifacts(
    root: &Path,
    path: &Path,
    files: &mut BTreeMap<String, Entry>,
    snapshot: &Arc<tempfile::TempDir>,
) -> Result<()> {
    walk_tree(root, path, &mut None, &mut |name, path, metadata| {
        stage_artifact(files, snapshot, name, path, metadata)
    })
}

fn stage_artifact(
    files: &mut BTreeMap<String, Entry>,
    snapshot: &Arc<tempfile::TempDir>,
    name: String,
    path: &Path,
    metadata: &fs::Metadata,
) -> Result<()> {
    #[cfg(unix)]
    let executable = {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    };
    #[cfg(not(unix))]
    let executable = {
        let _ = metadata;
        false
    };
    let source = fs::File::open(path).map_err(|error| error.to_string())?;
    let entry = bundle::stage(snapshot, &name, source, executable)?;
    files.insert(name, entry);
    Ok(())
}

fn walk_tree(
    root: &Path,
    path: &Path,
    budget: &mut Option<usize>,
    visit: &mut impl FnMut(String, &Path, &fs::Metadata) -> Result<()>,
) -> Result<()> {
    if let Some(remaining) = budget {
        *remaining = remaining
            .checked_sub(1)
            .ok_or("Checkpoint tree exceeds entry limit")?;
    }
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if storage::is_link_or_reparse_point(&meta) {
        return Err("Symlinks are not supported in profile backups".into());
    }
    let relative = path.strip_prefix(root).map_err(|e| e.to_string())?;
    let project = relative.starts_with("architect-library/blueprints")
        || relative.starts_with(crate::architect_launch::resources::SNAPSHOTS);
    let depth = if project { 70 } else { 32 };
    if relative.components().count() > depth {
        return Err("Backup tree exceeds depth limit".into());
    }
    if meta.is_dir() {
        for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
            walk_tree(
                root,
                &entry.map_err(|e| e.to_string())?.path(),
                budget,
                visit,
            )?;
        }
    } else if meta.is_file() {
        let name = format!("data/{}", archive_relative_path(relative)?);
        visit(name, path, &meta)?;
    } else {
        return Err("Backup entry is not a regular file".into());
    }
    Ok(())
}
fn strip_credentials(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            for key in ["env", "headers"] {
                if map.contains_key(key) {
                    map.insert(key.into(), serde_json::json!({}));
                }
            }
            for key in [
                "apiKey",
                "api_key",
                "accessToken",
                "refreshToken",
                "password",
                "clientSecret",
            ] {
                map.remove(key);
            }
            for value in map.values_mut() {
                strip_credentials(value);
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(strip_credentials),
        _ => {}
    }
}
fn make_config_files_portable(files: &mut BTreeMap<String, Entry>) -> Result<()> {
    for file in CONFIG_FILES {
        make_config_file_portable(files, file)?;
    }
    Ok(())
}

fn make_config_file_portable(files: &mut BTreeMap<String, Entry>, file: &str) -> Result<()> {
    let active = format!("config/{file}");
    let approved = format!("config/.runtime/approved/user/{file}");
    let pending = format!("config/.runtime/pending/user/{file}");
    for name in [&active, &approved, &pending] {
        if let Some(entry) = files.get(name) {
            entry
                .copy_verified(name, io::sink())
                .map_err(|error| error.to_string())?;
        }
    }
    files.remove(&pending);

    let has_approved = files.contains_key(&approved);
    let source = if has_approved { &approved } else { &active };
    if let Some(entry) = files.get_mut(source) {
        let bytes = STANDARD.decode(&entry.data).map_err(|e| e.to_string())?;
        let mut json: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        // A raw-only Tools document cannot establish consent for a legacy executable.
        if file == "tools.json" && !has_approved {
            if let Some(object) = json.as_object_mut() {
                object.remove("languageServer");
            }
        }
        strip_credentials(&mut json);
        let bytes = serde_json::to_vec(&json).map_err(|e| e.to_string())?;
        entry.sha256 = hash(&bytes);
        entry.data = STANDARD.encode(bytes);
        if has_approved {
            let entry = entry.clone();
            files.insert(active, entry);
        }
    }
    Ok(())
}
// Native authentication identities must not reconnect to an existing OS vault.
// Keep the relay address and display label, but allocate a new configuration context.
fn make_state_file_portable(files: &mut BTreeMap<String, Entry>) -> Result<()> {
    let Some(entry) = files.get_mut("data/state.json") else {
        return Ok(());
    };
    let mut bytes = Vec::new();
    entry
        .copy_verified("data/state.json", &mut bytes)
        .map_err(|error| error.to_string())?;
    crate::state_manager::validate_backup_state(&bytes)?;
    let mut snapshot: crate::state_manager::StateSnapshot =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if let Some(pilot) = snapshot.values.get_mut("macro_pilot_native_v1") {
        let mut detached = serde_json::json!({
            "configurationId": format!("config:{}", uuid::Uuid::new_v4().simple()),
            "relayOrigin": pilot.get("relayOrigin").filter(|value| value.is_string()).cloned(),
        });
        if let Some(label) = pilot
            .get("pendingInstanceLabel")
            .filter(|value| value.is_string())
        {
            detached["pendingInstanceLabel"] = label.clone();
        }
        *pilot = detached;
    }
    let bytes = serde_json::to_vec(&snapshot).map_err(|error| error.to_string())?;
    entry.sha256 = hash(&bytes);
    entry.data = STANDARD.encode(bytes);
    Ok(())
}
async fn architect_references(database: &Path) -> Result<Vec<storage_index::Artifact>> {
    let mut db = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(database)
            .read_only(true),
    )
    .await
    .map_err(|error| error.to_string())?;
    storage_index::artifact_references(&mut db)
        .await
        .map_err(|error| error.to_string())
}

fn architect_prefix(data: &Path, artifact: &Path) -> Result<String> {
    let path = artifact
        .strip_prefix(data)
        .map_err(|error| error.to_string())?;
    Ok(format!("data/{}/", archive_relative_path(path)?))
}

async fn validate_architect_artifacts(
    database: &Path,
    data: &Path,
    files: &BTreeMap<String, Entry>,
) -> Result<()> {
    let storage = Storage::new(data);
    let mut expected = BTreeSet::new();
    for artifact in architect_references(database).await? {
        let prefix = architect_prefix(data, &storage.artifact_path(&artifact))?;
        let archive_digest = files
            .get(&format!("{prefix}version.agsdl"))
            .map(|entry| entry.sha256.as_str());
        expected.insert(prefix);
        storage
            .validate_artifact(&artifact, archive_digest)
            .map_err(|error| error.to_string())?;
    }
    let actual: BTreeSet<_> = files
        .keys()
        .filter_map(|name| architect_artifact_prefix(name))
        .map(str::to_owned)
        .collect();
    if actual != expected {
        return Err("Architect backup files do not match the database".into());
    }
    Ok(())
}

async fn capture(
    data: &Path,
    config: &Path,
    browser: BTreeMap<String, String>,
    portable: bool,
) -> Result<Archive> {
    validate_profile_paths(data, config)?;
    validate_browser(&browser)?;
    let temp = private_staging(data)?;
    let db_path = temp.path().join("macro.db");
    let storage = Storage::new(data);
    let lease = storage.lease(false).await;
    let _launch_lease = launch::lease(config).await?;
    snapshot_database(&data.join("macro.db"), &db_path, portable).await?;
    let references = architect_references(&db_path).await?;
    let _lease = match lease {
        Ok(lease) => Some(lease),
        Err(_) if references.is_empty() => None,
        Err(error) => return Err(error.to_string()),
    };
    let mut files = BTreeMap::new();
    let artifacts = Arc::new(private_staging(data)?);
    add_database_file(&mut files, &artifacts, "data/macro.db", &db_path)?;
    for artifact in references {
        let path = storage.artifact_path(&artifact);
        safe_parent(&path, data)?;
        collect_artifacts(data, &path, &mut files, &artifacts)?;
    }
    if data.join("state.json").exists() {
        add_file(
            &mut files,
            "data/state.json".into(),
            read_bounded(&data.join("state.json"))?,
        )?;
    }
    collect_tree(data, &data.join("direct-checkpoints"), &mut files)?;
    for file in CONFIG_FILES {
        for relative in [
            file.to_string(),
            format!(".runtime/approved/user/{file}"),
            format!(".runtime/pending/user/{file}"),
        ] {
            if portable && relative.starts_with(".runtime/pending/") {
                continue;
            }
            let approved = config.join(format!(".runtime/approved/user/{file}"));
            let path = if portable && approved.exists() {
                approved
            } else {
                config.join(&relative)
            };
            if path.exists() {
                add_file(
                    &mut files,
                    format!("config/{relative}"),
                    read_bounded(&path)?,
                )?;
            }
        }
    }
    if portable {
        make_config_files_portable(&mut files)?;
        make_state_file_portable(&mut files)?;
    }
    let mut archive = Archive {
        format: "macro-local-profile".into(),
        version: 1,
        app_version: env!("CARGO_PKG_VERSION").into(),
        files,
        launch: None,
        browser_sha256: hash(&serde_json::to_vec(&browser).map_err(|e| e.to_string())?),
        browser,
    };
    launch::capture(&mut archive, &db_path, data, config, false).await?;
    Ok(archive)
}
async fn validate(archive: &Archive, data: &Path) -> Result<()> {
    if archive.format != "macro-local-profile"
        || archive.version != 1
        || archive.app_version != env!("CARGO_PKG_VERSION")
        || archive
            .files
            .values()
            .filter(|entry| entry.native.is_none())
            .count()
            > 10_000
    {
        return Err("Incompatible profile backup".into());
    }
    validate_checkpoint_paths(&archive.files)?;
    validate_architect_paths(&archive.files)?;
    launch::validate_paths(archive)?;
    validate_browser(&archive.browser)?;
    if archive.browser_sha256
        != hash(&serde_json::to_vec(&archive.browser).map_err(|e| e.to_string())?)
    {
        return Err("Browser state integrity check failed".into());
    }
    let temp = private_staging(data)?;
    let mut total = 0usize;
    let mut draft_inventories = BTreeMap::<&str, (usize, u64)>::new();
    for (name, entry) in &archive.files {
        total = total
            .checked_add(entry.data.len())
            .ok_or("Backup too large")?;
        if total > LIMIT as usize {
            return Err("Backup too large".into());
        }
        if launch::file(name) {
            entry
                .copy_verified(name, io::sink())
                .map_err(|error| error.to_string())?;
            continue;
        }
        let path = destination(name, temp.path(), temp.path())?;
        if name == "data/macro.db" {
            copy_entry_to_file(entry, name, &path)?;
            continue;
        }
        if let Some(prefix) = architect_artifact_prefix(name) {
            let member = &name[prefix.len()..];
            if let Some(project_file) = member.strip_prefix("project/") {
                let (count, bytes) = draft_inventories.entry(prefix).or_default();
                *count += 1;
                *bytes = bytes.saturating_add(entry.size(name)?);
                // Draft validation checks inventory, manifest presence and sidecars.
                // Stream the other members without extending their live paths.
                if project_file != crate::architect_library::project::MANIFEST {
                    entry
                        .copy_verified(name, io::sink())
                        .map_err(|error| error.to_string())?;
                    continue;
                }
            }
            storage::ensure_staging_dir(
                temp.path(),
                path.parent().ok_or("Missing artifact parent")?,
            )
            .map_err(|error| error.to_string())?;
            let output = create_private_file(&path, false).map_err(|error| error.to_string())?;
            entry
                .copy_verified(name, output)
                .map_err(|error| error.to_string())?;
            continue;
        }
        let bytes = STANDARD.decode(&entry.data).map_err(|e| e.to_string())?;
        if entry_hash(&bytes, entry.executable) != entry.sha256 {
            return Err(format!("Integrity check failed for {name}"));
        }
        if name == "data/state.json" {
            crate::state_manager::validate_backup_state(&bytes)?;
        }
        if name.starts_with("config/") {
            let value: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            if !name.contains("/pending/") {
                let kind = crate::config::ConfigDocumentKind::ALL
                    .into_iter()
                    .find(|kind| name.ends_with(kind.file_name()))
                    .ok_or("Unknown configuration kind")?;
                let validation = crate::config::validate_document(
                    kind,
                    &crate::config::ConfigScope::User,
                    &value,
                );
                if !validation.valid || validation.read_only {
                    return Err(format!("Invalid configuration: {name}"));
                }
            }
        }
    }
    if draft_inventories.values().any(|(count, bytes)| {
        !crate::architect_library::project_editor::inventory_fits(*count, *bytes)
    }) {
        return Err("Architect draft exceeds the editor inventory limit".into());
    }
    if !archive.files.contains_key("data/macro.db") {
        return Err("Backup has no database".into());
    }
    let database = temp.path().join("macro.db");
    check_database(&database).await?;
    validate_architect_artifacts(&database, temp.path(), &archive.files).await?;
    launch::validate(archive, &database).await?;
    check_database_startup(&database).await
}
fn raw_destination(name: &str, data: &Path, config: &Path) -> Result<PathBuf> {
    if DATABASE_ENTRIES.contains(&name)
        || name
            .strip_prefix("data/")
            .is_some_and(|name| PROVIDER_SECRETS_RECOVERY_FILES.contains(&name))
    {
        return Ok(data.join(name.strip_prefix("data/").unwrap()));
    }
    destination(name, data, config)
}
fn add_optional_raw(files: &mut BTreeMap<String, Entry>, name: String, path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => add_file(files, name, read_bounded(path)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}
fn capture_raw(data: &Path, config: &Path, browser: BTreeMap<String, String>) -> Result<Archive> {
    validate_profile_paths(data, config)?;
    validate_browser(&browser)?;
    let mut files = BTreeMap::new();
    let artifacts = Arc::new(private_staging(data)?);
    for &name in DATABASE_ENTRIES {
        let path = data.join(name.strip_prefix("data/").unwrap());
        match fs::symlink_metadata(&path) {
            Ok(_) => add_database_file(&mut files, &artifacts, name, &path)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    add_optional_raw(
        &mut files,
        "data/state.json".into(),
        &data.join("state.json"),
    )?;
    for file in PROVIDER_SECRETS_RECOVERY_FILES {
        add_optional_raw(&mut files, format!("data/{file}"), &data.join(file))?;
    }
    let blueprints = data.join("architect-library/blueprints");
    safe_parent(&blueprints, data)?;
    collect_artifacts(data, &blueprints, &mut files, &artifacts)?;
    let checkpoints = data.join("direct-checkpoints");
    match fs::symlink_metadata(&checkpoints) {
        Ok(_) => collect_tree(data, &checkpoints, &mut files)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    for file in CONFIG_FILES {
        for relative in [
            file.to_string(),
            format!(".runtime/approved/user/{file}"),
            format!(".runtime/pending/user/{file}"),
        ] {
            add_optional_raw(
                &mut files,
                format!("config/{relative}"),
                &config.join(relative),
            )?;
        }
    }
    Ok(Archive {
        format: "macro-raw-profile".into(),
        version: 1,
        app_version: env!("CARGO_PKG_VERSION").into(),
        files,
        launch: None,
        browser_sha256: hash(&serde_json::to_vec(&browser).map_err(|e| e.to_string())?),
        browser,
    })
}
async fn capture_raw_with_launch(
    data: &Path,
    config: &Path,
    browser: BTreeMap<String, String>,
) -> Result<Archive> {
    let mut archive = capture_raw(data, config, browser)?;
    launch::capture(&mut archive, &data.join("macro.db"), data, config, true).await?;
    Ok(archive)
}

fn validate_raw(archive: &Archive) -> Result<()> {
    check_raw_manifest(archive)?;
    for (name, entry) in &archive.files {
        entry
            .copy_verified(name, io::sink())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn check_raw_manifest(archive: &Archive) -> Result<()> {
    if archive.format != "macro-raw-profile"
        || archive.version != 1
        || archive
            .files
            .values()
            .filter(|entry| entry.native.is_none())
            .count()
            > 10_000
    {
        return Err("Invalid preserved profile format".into());
    }
    validate_checkpoint_paths(&archive.files)?;
    validate_architect_paths(&archive.files)?;
    launch::validate_paths(archive)?;
    validate_browser(&archive.browser)?;
    if archive.browser_sha256
        != hash(&serde_json::to_vec(&archive.browser).map_err(|e| e.to_string())?)
    {
        return Err("Preserved browser checksum mismatch".into());
    }
    let mut total = 0usize;
    for (name, entry) in &archive.files {
        if !launch::file(name) {
            raw_destination(name, Path::new("data"), Path::new("config"))?;
        }
        total = total
            .checked_add(entry.data.len())
            .ok_or("Preserved profile too large")?;
        if total > LIMIT as usize {
            return Err("Preserved profile too large".into());
        }
    }
    Ok(())
}
fn preserve_raw(archive: &Archive, path: &Path) -> Result<()> {
    check_raw_manifest(archive)?;
    for (name, entry) in &archive.files {
        if entry.native.is_none() {
            entry
                .copy_verified(name, io::sink())
                .map_err(|error| error.to_string())?;
        }
    }
    let directory = path.parent().ok_or("Missing preservation directory")?;
    write_atomically(path, &staging_root(directory)?, false, |file| {
        bundle::write(archive, file)
    })?;
    crate::secrets::harden_private_file(path).map_err(|error| error.to_string())?;
    sync_directory(directory)
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RestoreJournal {
    preserved: String,
    #[serde(default)]
    phase: RestorePhase,
    #[serde(default)]
    launch: launch::SnapshotRollback,
}
#[derive(Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RestorePhase {
    #[default]
    Rollback,
    InstallHold,
}

async fn install_restore_hold(data: &Path) -> Result<()> {
    let path = data.join("macro.db");
    if !path.exists() {
        return Ok(());
    }
    // No runtime is alive here. Validate/migrate before making the restored
    // profile available; retain restoring.json if any step fails.
    crate::db::restore_admission_hold(&path)
        .await
        .map_err(|e| e.to_string())
}
fn preserved_path(dir: &Path, journal: &RestoreJournal) -> Result<PathBuf> {
    let id = journal
        .preserved
        .strip_prefix("preserved-")
        .and_then(|name| {
            name.strip_suffix(".zip")
                .or_else(|| name.strip_suffix(".json"))
        })
        .ok_or("Invalid preservation journal")?;
    uuid::Uuid::parse_str(id).map_err(|e| e.to_string())?;
    Ok(dir.join(&journal.preserved))
}

// Resolve a relocated profile root before checking its managed descendants.
fn resolve_backup_root(root: &Path) -> Result<PathBuf> {
    if fs::symlink_metadata(root).is_ok_and(|meta| storage::is_link_or_reparse_point(&meta)) {
        root.canonicalize().map_err(|error| error.to_string())
    } else {
        Ok(root.to_owned())
    }
}

fn resolve_backup_roots(data: &Path, config: &Path) -> Result<(PathBuf, PathBuf)> {
    let data = resolve_backup_root(data)?;
    #[cfg(test)]
    if profile::mutated("skip-config-root-resolution") {
        return Ok((data, config.to_owned()));
    }
    Ok((data, resolve_backup_root(config)?))
}

fn safe_parent(path: &Path, root: &Path) -> Result<()> {
    let mut current = root.to_path_buf();
    let relative = path.strip_prefix(root).map_err(|e| e.to_string())?;
    for part in std::iter::once(None).chain(relative.components().map(Some)) {
        if let Some(part) = part {
            current.push(part);
        }
        match fs::symlink_metadata(&current) {
            Ok(meta) if storage::is_link_or_reparse_point(&meta) => {
                return Err("Profile target contains a symlink".into())
            }
            Ok(_) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}
fn validate_profile_paths(data: &Path, config: &Path) -> Result<()> {
    for file in [
        "macro.db",
        "macro.db-wal",
        "macro.db-shm",
        "state.json",
        "direct-checkpoints",
    ]
    .into_iter()
    .chain(PROVIDER_SECRETS_RECOVERY_FILES.iter().copied())
    {
        safe_parent(&data.join(file), data)?;
    }
    for file in CONFIG_FILES {
        for relative in [
            file.to_string(),
            format!(".runtime/approved/user/{file}"),
            format!(".runtime/pending/user/{file}"),
        ] {
            safe_parent(&config.join(relative), config)?;
        }
    }
    Ok(())
}
// The tree has already passed collect_tree's link/depth/node checks. Remove only
// empty directories, never recursively delete user files.
fn remove_empty_checkpoint_dirs(path: &Path) -> Result<()> {
    if !path.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            remove_empty_checkpoint_dirs(&entry.path())?;
        }
    }
    if fs::read_dir(path)
        .map_err(|e| e.to_string())?
        .next()
        .is_none()
    {
        profile::remove_dir(path).map_err(|e| e.to_string())?;
        sync_parent(path)?;
    }
    Ok(())
}

fn prune_rollback_artifacts(
    root: &Path,
    path: &Path,
    files: &BTreeMap<String, Entry>,
) -> Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let relative = path.strip_prefix(root).map_err(|error| error.to_string())?;
    if storage::is_link_or_reparse_point(&metadata) || relative.components().count() > 70 {
        return Err("Invalid Architect rollback path".into());
    }
    if metadata.is_dir() {
        for entry in path.read_dir().map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            prune_rollback_artifacts(root, &entry.path(), files)?;
        }
        if path
            .read_dir()
            .map_err(|error| error.to_string())?
            .next()
            .is_none()
        {
            profile::remove_dir(path).map_err(|error| error.to_string())?;
            sync_parent(path)?;
        }
    } else if !metadata.is_file() {
        return Err("Invalid Architect rollback file".into());
    } else {
        let name = format!("data/{}", archive_relative_path(relative)?);
        if !files.contains_key(&name) {
            remove_durable(path)?;
        }
    }
    Ok(())
}

fn apply(archive: &Archive, data: &Path, config: &Path) -> Result<()> {
    apply_files(archive, data, config, false)
}
fn check_restore_targets(archive: &Archive, data: &Path, config: &Path, raw: bool) -> Result<()> {
    validate_profile_paths(data, config)?;
    validate_checkpoint_paths(&archive.files)?;
    validate_architect_paths(&archive.files)?;
    launch::validate_paths(archive)?;
    launch::check_targets(archive, data, config)?;
    let target = |name: &str| {
        if raw {
            raw_destination(name, data, config)
        } else {
            destination(name, data, config)
        }
    };
    // At startup only: SQLite and config writers have not been initialized.
    for name in archive.files.keys() {
        if launch::file(name) {
            continue;
        }
        let path = target(name)?;
        if !fits_existing_file(&path) {
            return Err(format!(
                "Profile file {name:?} exceeds the destination filesystem path limit"
            ));
        }
        safe_parent(
            &path,
            if name.starts_with("data/") {
                data
            } else {
                config
            },
        )?;
        if path.is_dir()
            && !name.starts_with("data/direct-checkpoints/")
            && !name.starts_with(ARCHITECT_FILES)
        {
            return Err("Restore target is a directory".into());
        }
    }
    Ok(())
}

fn check_restore_space(
    incoming: &Archive,
    original: &Archive,
    data: &Path,
    config: &Path,
    available_space: impl Fn(&Path) -> io::Result<u64>,
) -> Result<()> {
    let footprint = |archive: &Archive, prefix: &str| -> Result<u64> {
        archive
            .files
            .iter()
            .filter(|(name, _)| name.starts_with(prefix))
            .try_fold(0u64, |total, (name, entry)| {
                // Round up to allow for filesystem blocks; deletion can only
                // increase the space available to redo a journaled write.
                let size = entry.size(name)?;
                Ok(total.saturating_add(size.saturating_add(4095) & !4095))
            })
    };
    let data_bytes = footprint(incoming, "data/")?.max(footprint(original, "data/")?);
    let config_bytes = footprint(incoming, "config/")?.max(footprint(original, "config/")?);
    let config_volume = config
        .ancestors()
        .find(|path| path.is_dir())
        .ok_or("Missing configuration volume")?;
    let free_data = available_space(data).map_err(|error| error.to_string())?;
    let free_config = available_space(config_volume).map_err(|error| error.to_string())?;
    let preservation =
        footprint(original, "data/")?.saturating_add(footprint(original, "config/")?);
    let insufficient_space = free_data
        < preservation
            .saturating_add(data_bytes)
            .saturating_add(config_bytes)
        || free_config < config_bytes;
    #[cfg(test)]
    let insufficient_space = insufficient_space && !profile::mutated("skip-restore-space-check");
    if insufficient_space {
        return Err("Insufficient free disk space to restore and recover the profile".into());
    }
    Ok(())
}

fn apply_files(archive: &Archive, data: &Path, config: &Path, raw: bool) -> Result<()> {
    check_restore_targets(archive, data, config, raw)?;
    let target = |name: &str| {
        if raw {
            raw_destination(name, data, config)
        } else {
            destination(name, data, config)
        }
    };
    if raw {
        // Rollback can encounter both trees plus an interrupted temporary
        // write. Compare paths without reading unfinished files or imposing
        // the capture limit on the union of the two trees.
        let blueprints = data.join("architect-library/blueprints");
        safe_parent(&blueprints, data)?;
        #[cfg(test)]
        let prune = !profile::mutated("skip-rollback-pruning");
        #[cfg(not(test))]
        let prune = true;
        if prune {
            prune_rollback_artifacts(data, &blueprints, &archive.files)?;
        }
    } else {
        // An incoming portable backup only replaces the artifacts it contains.
        let prefixes: BTreeSet<_> = archive
            .files
            .keys()
            .filter_map(|name| architect_artifact_prefix(name))
            .collect();
        for prefix in prefixes {
            let path = data.join(prefix.strip_prefix("data/").unwrap().trim_end_matches('/'));
            walk_tree(data, &path, &mut None, &mut |name, path, _| {
                if !archive.files.contains_key(&name) {
                    remove_durable(path)?;
                }
                Ok(())
            })?;
            remove_empty_checkpoint_dirs(&path)?;
        }
    }
    for suffix in ["-wal", "-shm"] {
        let path = data.join(format!("macro.db{suffix}"));
        if path.exists() {
            remove_durable(&path)?;
        }
    }
    let mut existing = BTreeMap::new();
    collect_tree(data, &data.join("direct-checkpoints"), &mut existing)?;
    for name in existing.keys() {
        if !archive.files.contains_key(name) {
            remove_durable(&target(name)?)?;
        }
    }
    remove_empty_checkpoint_dirs(&data.join("direct-checkpoints"))?;
    for file in CONFIG_FILES {
        for relative in [
            file.to_string(),
            format!(".runtime/approved/user/{file}"),
            format!(".runtime/pending/user/{file}"),
        ] {
            let name = format!("config/{relative}");
            let path = config.join(relative);
            if !archive.files.contains_key(&name) && path.exists() {
                remove_durable(&path)?;
            }
        }
    }
    if !archive.files.contains_key("data/state.json") && data.join("state.json").exists() {
        remove_durable(&data.join("state.json"))?;
    }
    if raw && !archive.files.contains_key("data/macro.db") && data.join("macro.db").exists() {
        remove_durable(&data.join("macro.db"))?;
    }
    for file in PROVIDER_SECRETS_RECOVERY_FILES {
        if !archive.files.contains_key(&format!("data/{file}")) && data.join(file).exists() {
            remove_durable(&data.join(file))?;
        }
    }
    // Remove every previous file before creating any replacement. If two
    // archive members alias on this filesystem, create_new fails instead of
    // deleting the preceding member and publishing a partial restore.
    let files = || archive.files.iter().filter(|(name, _)| !launch::file(name));
    let targets = files()
        .map(|(name, _)| target(name))
        .collect::<Result<Vec<_>>>()?;
    for path in &targets {
        match profile::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    let mut directories = BTreeSet::new();
    let mut written = Vec::with_capacity(FILE_SYNC_BATCH);
    for ((name, entry), path) in files().zip(targets) {
        let root = if name.starts_with("data/") {
            data
        } else {
            config
        };
        let parent = path.parent().ok_or("Missing profile file parent")?;
        if !directories.contains(parent) {
            storage::ensure_dir(root, root).map_err(|error| error.to_string())?;
            storage::ensure_staging_dir(root, parent).map_err(|error| error.to_string())?;
            directories.extend(
                parent
                    .ancestors()
                    .take_while(|dir| dir.starts_with(root))
                    .map(Path::to_owned),
            );
        }
        written.push(write_journaled(&path, name, entry)?);
        if written.len() == FILE_SYNC_BATCH {
            sync_written_files(&mut written)?;
        }
    }
    sync_written_files(&mut written)?;
    for directory in directories.into_iter().rev() {
        sync_directory(&directory)?;
    }
    Ok(())
}
fn copy_entry_to_file(entry: &Entry, name: &str, path: &Path) -> Result<()> {
    let output = create_private_file(path, false).map_err(|error| error.to_string())?;
    entry
        .copy_verified(name, output)
        .map_err(|error| error.to_string())
}

fn load_archive(path: &Path, _data: &Path) -> Result<Archive> {
    bundle::load(path)
}

async fn load_restore_archive(path: &Path, data: &Path) -> Result<Archive> {
    let mut archive = load_archive(path, data)?;
    if archive.format == "macro-raw-profile" {
        validate_raw(&archive)?;
        let temp = private_staging(data)?;
        for &name in DATABASE_ENTRIES {
            if let Some(entry) = archive.files.get(name) {
                copy_entry_to_file(
                    entry,
                    name,
                    &temp.path().join(name.strip_prefix("data/").unwrap()),
                )?;
            }
        }
        let normalized = temp.path().join("normalized.db");
        snapshot_database(&temp.path().join("macro.db"), &normalized, true).await?;
        let storage = Storage::new(temp.path());
        let mut referenced = BTreeSet::new();
        for artifact in architect_references(&normalized).await? {
            referenced.insert(architect_prefix(
                temp.path(),
                &storage.artifact_path(&artifact),
            )?);
        }
        archive.files.retain(|name, _| {
            architect_artifact_prefix(name).is_none_or(|prefix| referenced.contains(prefix))
        });
        launch::filter_preserved(&mut archive, &normalized).await?;
        archive.files.remove("data/macro.db-wal");
        archive.files.remove("data/macro.db-shm");
        archive.files.remove("data/macro.db");
        for file in PROVIDER_SECRETS_RECOVERY_FILES {
            archive.files.remove(&format!("data/{file}"));
        }
        add_database_file(
            &mut archive.files,
            &Arc::new(temp),
            "data/macro.db",
            &normalized,
        )?;
        make_config_files_portable(&mut archive.files)?;
        archive.format = "macro-local-profile".into();
    } else {
        // Conversion checks the original checksum of each entry it changes.
        make_config_file_portable(&mut archive.files, "tools.json")?;
    }
    make_state_file_portable(&mut archive.files)?;
    validate(&archive, data).await?;
    Ok(archive)
}

#[cfg(test)]
mod fault_tests;

/// Updater activation must leave the application version unchanged until queued
/// backup work and interrupted restoration recovery have run.
pub(crate) fn has_pending_startup_work(data: &Path) -> Result<bool> {
    let directory = data.join("local-backup");
    for name in ["request.json", "restoring.json"] {
        if directory
            .join(name)
            .try_exists()
            .map_err(|error| error.to_string())?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProfileRecoveryKind {
    Startup,
    Restore,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRecovery {
    pub(crate) kind: ProfileRecoveryKind,
    pub(crate) diagnostics: String,
    preserved_archive: Option<PathBuf>,
}

impl ProfileRecovery {
    pub(crate) fn startup_step<T>(
        context: &str,
        result: std::result::Result<T, impl std::fmt::Display>,
    ) -> std::result::Result<T, Self> {
        result.map_err(|error| {
            let diagnostics = format!("{context}: {error}");
            tracing::error!(%diagnostics, "Profile startup failed");
            Self {
                kind: ProfileRecoveryKind::Startup,
                diagnostics,
                preserved_archive: None,
            }
        })
    }
}

#[derive(Default)]
pub(crate) struct StartupRecovery(pub(crate) Option<ProfileRecovery>);

pub(crate) fn guard_profile_commands<R: tauri::Runtime>(
    dispatch: impl Fn(tauri::ipc::Invoke<R>) -> bool,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool {
    move |invoke| {
        let webview = invoke.message.webview();
        if webview
            .try_state::<StartupRecovery>()
            .is_some_and(|state| state.0.is_some())
            && !matches!(
                invoke.message.command(),
                "profile_startup_recovery"
                    | "profile_recovery_retry"
                    | "profile_recovery_reveal"
                    | "show_main_window"
                    | "window_close"
                    | "window_minimize"
            )
        {
            invoke.resolver.reject("Profile recovery is required");
            return true;
        }
        dispatch(invoke)
    }
}

/// A failed recovery blocks opening the profile, while the application shell
/// remains available to report the failure and restart.
pub async fn process_startup(
    data: &Path,
    config: &Path,
) -> std::result::Result<(), ProfileRecovery> {
    let startup = process_startup_with_preserver(data, config, preserve_raw).await;
    #[cfg(test)]
    if profile::mutated("ignore-recovery-error") {
        return Ok(());
    }
    startup.map_err(|diagnostics| {
        let resolved = resolve_backup_root(data);
        let data = resolved.as_deref().unwrap_or(data);
        let dir = data.join("local-backup");
        let journal = dir.join("restoring.json");
        let kind = if safe_parent(&dir, data).is_ok() && fs::symlink_metadata(&journal).is_ok() {
            ProfileRecoveryKind::Restore
        } else {
            ProfileRecoveryKind::Startup
        };
        let preserved_archive = safe_parent(&journal, data)
            .and_then(|()| read_bounded(&journal))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .and_then(|marker| preserved_path(&dir, &marker).ok());
        tracing::error!(%diagnostics, "Profile recovery is required");
        ProfileRecovery {
            kind,
            diagnostics,
            preserved_archive,
        }
    })
}

#[tauri::command]
pub(crate) fn profile_startup_recovery(
    state: tauri::State<'_, StartupRecovery>,
) -> Option<ProfileRecovery> {
    state.0.clone()
}

#[tauri::command]
pub(crate) fn profile_recovery_retry(
    app: tauri::AppHandle,
    state: tauri::State<'_, StartupRecovery>,
) -> Result<()> {
    if state.0.is_none() {
        return Err("Profile recovery is not active".into());
    }
    app.request_restart();
    Ok(())
}

#[tauri::command]
pub(crate) fn profile_recovery_reveal(
    app: tauri::AppHandle,
    state: tauri::State<'_, StartupRecovery>,
) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let recovery = state.0.as_ref().ok_or("Profile recovery is not active")?;
    if recovery.kind != ProfileRecoveryKind::Restore {
        return Err("Restore recovery is not active".into());
    }
    if let Some(path) = &recovery.preserved_archive {
        app.opener().reveal_item_in_dir(path)
    } else {
        // An unreadable journal cannot identify which archive belongs to it.
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("local-backup");
        app.opener()
            .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
    }
    .map_err(|error| error.to_string())
}

fn publish_status(dir: &Path, status: &BackupStatus) -> Result<()> {
    atomic(
        &dir.join("status.json"),
        &serde_json::to_vec(status).map_err(|error| error.to_string())?,
    )
}

fn finish_request_best_effort(dir: &Path, request: &Path, status: &BackupStatus) {
    let published = match publish_status(dir, status) {
        Ok(()) => true,
        Err(error) => {
            tracing::warn!(%error, "Could not publish profile backup status");
            false
        }
    };
    if request.exists() {
        let retired = if published {
            remove_durable(request)
        } else {
            let quarantined = dir.join(format!("unreported-request-{}.json", uuid::Uuid::new_v4()));
            profile::rename(request, &quarantined)
                .map_err(|error| error.to_string())
                .and_then(|()| sync_directory(dir))
        };
        if let Err(error) = retired {
            tracing::warn!(%error, "Could not retire profile backup request");
            return;
        }
    }
    cleanup_incoming(dir);
}

async fn process_startup_with_preserver(
    data: &Path,
    config: &Path,
    preserve: fn(&Archive, &Path) -> Result<()>,
) -> Result<()> {
    create_private_root(data).map_err(|error| error.to_string())?;
    let (data, config) = resolve_backup_roots(data, config)?;
    let runtime = tokio::runtime::Handle::current();
    #[cfg(not(test))]
    let owner = crate::secrets::policy::POLICY.clone();
    #[cfg(test)]
    let owner = std::sync::Arc::new(crate::secrets::policy::PolicyOwner::for_test(&data));
    crate::secrets::blocking::run(move || {
        owner.startup(&data, |rotate| {
            runtime.block_on(process_startup_locked(&data, &config, preserve, rotate))
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn process_startup_locked(
    data: &Path,
    config: &Path,
    preserve: fn(&Archive, &Path) -> Result<()>,
    rotate_before_journal_removal: &dyn Fn()
        -> std::result::Result<(), crate::secrets::SecretError>,
) -> Result<()> {
    let dir = data.join("local-backup");
    let journal = dir.join("restoring.json");
    let _backup_lock = match (|| {
        safe_parent(&dir, data)?;
        storage::ensure_dir(data, &dir).map_err(|error| error.to_string())?;
        backup_lock(&dir)
    })() {
        Ok(lock) => lock,
        Err(error)
            if fs::symlink_metadata(&journal)
                .is_err_and(|error| error.kind() == io::ErrorKind::NotFound) =>
        {
            tracing::warn!(%error, "Profile backup startup work will retry");
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    if let Err(error) = reclaim_backup_staging(&dir) {
        tracing::warn!(%error, "Could not reclaim profile backup staging");
    }
    if let Err(error) = reclaim_export_staging(&dir) {
        tracing::warn!(%error, "Could not reclaim profile export staging");
    }
    if let Err(error) = Storage::new(data).reclaim_inspection_staging() {
        tracing::warn!(%error, "Could not reclaim Architect inspection staging");
    }
    let recovery_pending = || match fs::symlink_metadata(&journal) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    };
    if recovery_pending()? {
        let mut marker: RestoreJournal = serde_json::from_slice(&read_bounded(&journal)?)
            .map_err(|error| format!("Invalid restore journal {}: {error}", journal.display()))?;
        if marker.phase == RestorePhase::Rollback {
            let storage = Storage::new(data);
            let _lease = storage
                .lease(true)
                .await
                .map_err(|error| error.to_string())?;
            let _launch_lease = launch::lease(config).await?;
            let original = load_archive(&preserved_path(&dir, &marker)?, data)?;
            validate_raw(&original)?;
            launch::apply_working(&original, data, &BTreeMap::new(), true)?;
            apply_files(&original, data, config, true)?;
            launch::rollback_snapshots(config, &marker.launch)?;
            let status = BackupStatus {
                message: String::new(),
                code: Some(BackupStatusCode::RolledBack),
                path: None,
                browser: Some(original.browser),
            };
            publish_status(&dir, &status)?;
            // Raw rollback is complete. A failed nonce rotation must not apply it again.
            marker.phase = RestorePhase::InstallHold;
            atomic(
                &journal,
                &serde_json::to_vec(&marker).map_err(|e| e.to_string())?,
            )?;
        }
        install_restore_hold(data).await?;
        // A recovered request must not replay the failed restore on this launch.
        if dir.join("request.json").exists() {
            remove_durable(&dir.join("request.json"))?;
        }
        rotate_before_journal_removal().map_err(|error| error.to_string())?;
        remove_journal(&journal)?;
    }
    let request_path = dir.join("request.json");
    if !request_path.exists() {
        cleanup_incoming(&dir);
        return Ok(());
    }
    let request: Request = match read_bounded(&request_path)
        .and_then(|bytes| serde_json::from_slice(&bytes).map_err(|e| e.to_string()))
    {
        Ok(request) => request,
        Err(error) => {
            let quarantined = dir.join(format!("invalid-request-{}.json", uuid::Uuid::new_v4()));
            match profile::rename(&request_path, &quarantined) {
                Ok(()) => finish_request_best_effort(
                    &dir,
                    &request_path,
                    &BackupStatus {
                        message: error,
                        code: Some(BackupStatusCode::InvalidRequest),
                        path: Some(quarantined.to_string_lossy().into()),
                        browser: None,
                    },
                ),
                Err(rename) => {
                    tracing::warn!(%error, %rename, "Could not quarantine invalid profile backup request")
                }
            }
            return Ok(());
        }
    };
    let result = async {
        if request.operation == "export" {
            validate_export_path(Path::new(&request.path), data, config)?;
            let archive = capture(data, config, request.browser, true).await?;
            validate(&archive, data).await?;
            publish_export(&dir, Path::new(&request.path), &archive)?;
            Ok(BackupStatus { message: String::new(), code: Some(BackupStatusCode::Exported), path: Some(request.path), browser: None })
        } else if request.operation == "restore" {
            let storage = Storage::new(data);
            let _lease = storage.lease(true).await.map_err(|error| error.to_string())?;
            let mut archive = load_restore_archive(&dir.join("incoming.json"), data).await?;
            check_restore_targets(&archive, data, config, false)?;
            if archive.launch.is_some() && !config.exists() {
                create_private_root(config).map_err(|e| e.to_string())?;
            }
            let _launch_lease = launch::lease(config).await?;
            let original = capture_raw_with_launch(data, config, request.browser).await?;
            let mut marker = RestoreJournal {
                preserved: format!("preserved-{}.zip", uuid::Uuid::new_v4()),
                phase: RestorePhase::Rollback,
                launch: launch::SnapshotRollback::default(),
            };
            let mut working = BTreeMap::new();
            if archive.launch.is_some() {
                let owner = crate::architect_launch::resources::reserve_backup_owner(data, config)
                    .map_err(|error| error.message)?;
                marker.launch = launch::plan_snapshots(&archive, config, &owner)?;
                working = launch::relocate_working(&mut archive, data, &owner).await?;
            }
            let preservation = preserved_path(&dir, &marker)?;
            check_restore_space(&archive, &original, data, config, profile::available_space)?;
            preserve(&original, &preservation)?;
            drop(original);
            atomic(&journal, &serde_json::to_vec(&marker).map_err(|e| e.to_string())?)?;
            let applied = launch::apply_snapshots(&archive, config, &marker.launch)
                .and_then(|()| launch::apply_working(&archive, data, &working, false))
                .and_then(|diagnostics| apply(&archive, data, config).map(|()| diagnostics));
            let diagnostics = match applied {
                Ok(diagnostics) => diagnostics,
                Err(error) => {
                    let original = load_archive(&preservation, data)?;
                    validate_raw(&original)?;
                    launch::apply_working(&original, data, &BTreeMap::new(), true)
                        .and_then(|_| apply_files(&original, data, config, true))
                        .and_then(|()| launch::rollback_snapshots(config, &marker.launch))
                        .map_err(|rollback| format!("Restore failed: {error}. Rollback failed: {rollback}. Original preserved in {}", dir.display()))?;
                    let status = BackupStatus { message: error.clone(), code: Some(BackupStatusCode::Failed), path: None, browser: None };
                    publish_status(&dir, &status)?;
                    marker.phase = RestorePhase::InstallHold;
                    atomic(&journal, &serde_json::to_vec(&marker).map_err(|e| e.to_string())?)?;
                    install_restore_hold(data).await?;
                    remove_durable(&request_path)?;
                    rotate_before_journal_removal().map_err(|error| error.to_string())?;
                    remove_journal(&journal)?;
                    return Err(error);
                }
            };
            let status = BackupStatus { message: diagnostics, code: Some(BackupStatusCode::Restored), path: Some(preservation.to_string_lossy().into()), browser: Some(archive.browser) };
            publish_status(&dir, &status)?;
            marker.phase = RestorePhase::InstallHold;
            atomic(&journal, &serde_json::to_vec(&marker).map_err(|e| e.to_string())?)?;
            install_restore_hold(data).await?;
            remove_durable(&request_path)?;
            rotate_before_journal_removal().map_err(|error| error.to_string())?;
            remove_journal(&journal)?;
            Ok(status)
        } else { Err("Unknown backup operation".into()) }
    }.await;
    if recovery_pending()? {
        return Err(result
            .err()
            .unwrap_or_else(|| "Restore interrupted; recovery journal retained".into()));
    }
    let status = result.unwrap_or_else(|error: String| BackupStatus {
        message: error,
        code: Some(BackupStatusCode::Failed),
        path: None,
        browser: None,
    });
    if status.code == Some(BackupStatusCode::Restored) {
        // Already published durably before releasing the restore journal.
        cleanup_incoming(&dir);
    } else {
        finish_request_best_effort(&dir, &request_path, &status);
    }
    Ok(())
}

#[tauri::command]
pub async fn local_backup_schedule(
    app: tauri::AppHandle,
    operation: String,
    path: String,
    browser: BTreeMap<String, String>,
    confirmed: bool,
) -> Result<()> {
    if !confirmed
        || !["export", "restore"].contains(&operation.as_str())
        || !Path::new(&path).is_absolute()
    {
        return Err("Explicit confirmation and an absolute file path are required".into());
    }
    validate_browser(&browser)?;
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let config = crate::config::resolve_config_root(
        &app.path().app_config_dir().map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.message)?;
    schedule_backup(
        &data,
        &config,
        Request {
            operation,
            path,
            browser,
        },
    )
    .await
}

async fn schedule_backup(data: &Path, config: &Path, request: Request) -> Result<()> {
    let (data, config) = resolve_backup_roots(data, config)?;
    let dir = data.join("local-backup");
    safe_parent(&dir, &data)?;
    storage::ensure_dir(&data, &dir).map_err(|error| error.to_string())?;
    let lock_dir = dir.clone();
    let _backup_lock = tokio::task::spawn_blocking(move || backup_lock(&lock_dir))
        .await
        .map_err(|error| error.to_string())??;
    if dir.join("request.json").exists() || dir.join("restoring.json").exists() {
        return Err("A profile operation is already pending. Restart Macro first.".into());
    }
    let path = Path::new(&request.path);
    if request.operation == "restore" {
        let archive = load_restore_archive(path, &data).await?;
        check_restore_targets(&archive, &data, &config, false)?;
        stage_incoming(&dir, &archive)?;
    } else {
        validate_export_path(path, &data, &config)?;
    }
    let bytes = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    write_atomically(
        &dir.join("request.json"),
        &staging_root(&dir)?,
        false,
        |file| file.write_all(&bytes),
    )
}
#[tauri::command]
pub fn local_backup_status(app: tauri::AppHandle) -> Result<BackupStatus> {
    let data = resolve_backup_root(&app.path().app_data_dir().map_err(|e| e.to_string())?)?;
    let path = data.join("local-backup/status.json");
    if !path.exists() {
        return Ok(BackupStatus::default());
    }
    match safe_parent(&path, &data)
        .and_then(|()| read_bounded(&path))
        .and_then(|bytes| serde_json::from_slice(&bytes).map_err(|error| error.to_string()))
    {
        Ok(status) => Ok(status),
        Err(error) => {
            tracing::warn!(%error, "Could not read profile backup status");
            Ok(BackupStatus::default())
        }
    }
}
#[tauri::command]
pub fn local_backup_acknowledge(app: tauri::AppHandle) -> Result<()> {
    let data = resolve_backup_root(&app.path().app_data_dir().map_err(|e| e.to_string())?)?;
    let path = data.join("local-backup/status.json");
    let dir = path.parent().ok_or("Missing backup directory")?;
    if !dir.exists() {
        return Ok(());
    }
    let _backup_lock = backup_lock(dir)?;
    let mut status = local_backup_status(app)?;
    status.browser = None;
    atomic(
        &path,
        &serde_json::to_vec(&status).map_err(|e| e.to_string())?,
    )
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn exports_after_restarting_a_paused_030_run_and_rejects_changed_optional_ddl() {
        let (temp, data, config) = profile().await;
        let database = data.join("macro.db");
        let pool = crate::db::create_pool(&database).await.unwrap();
        seed_paused_schema_probe(&pool).await.unwrap();
        pool.close().await;

        let reopened = crate::db::create_pool(&database).await.unwrap();
        argentic_runtime::api::interrupt_previous_runs(&reopened)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM engine_flow030_interruption_clock")
                .fetch_one(&reopened)
                .await
                .unwrap(),
            1
        );
        reopened.close().await;
        let target = temp.path().join("restarted.zip");
        schedule_backup(
            &data,
            &config,
            Request {
                operation: "export".into(),
                path: target.to_str().unwrap().into(),
                browser: BTreeMap::new(),
            },
        )
        .await
        .unwrap();
        process_startup(&data, &config).await.unwrap();
        load_restore_archive(&target, &data).await.unwrap();

        let mut connection = connection(&database).await.unwrap();
        sqlx::raw_sql("DROP TABLE engine_flow030_interruption_clock;
            CREATE TABLE engine_flow030_interruption_clock (
                system_id TEXT PRIMARY KEY NOT NULL REFERENCES engine_flow030_interruptions(system_id),
                ticket_json TEXT
            )").execute(&mut connection).await.unwrap();
        connection.close().await.unwrap();
        let error = check_database(&database).await.unwrap_err();
        assert!(
            error.contains("engine_flow030_interruption_clock"),
            "{error}"
        );
    }

    use super::*;
    fn assert_empty_policy(data: &Path) {
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(data.join(PROVIDER_SECRETS_FILE)).unwrap()).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 4);
        assert_eq!(value["version"], 2);
        let epoch = uuid::Uuid::parse_str(value["policyEpoch"].as_str().unwrap()).unwrap();
        assert!(!epoch.is_nil());
        assert_eq!(value["namespaces"].as_object().unwrap().len(), 5);
        assert!(value["namespaces"]
            .as_object()
            .unwrap()
            .values()
            .all(|map| map.as_object().unwrap().is_empty()));
        assert!(value["chatgpt_sessions"].as_object().unwrap().is_empty());
    }

    #[test]
    fn policy_restore_crash_child() {
        use std::io::{BufRead, Write};
        let Some(data) = std::env::var_os("MACRO_POLICY_RESTORE_CRASH_DATA") else {
            return;
        };
        let config = PathBuf::from(std::env::var_os("MACRO_POLICY_RESTORE_CRASH_CONFIG").unwrap());
        let data = PathBuf::from(data);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let handle = tokio::runtime::Handle::current();
            let owner = crate::secrets::policy::PolicyOwner::for_test(&data);
            crate::secrets::blocking::run(move || {
                owner.startup(&data, |_| {
                    handle.block_on(process_startup_locked(
                        &data,
                        &config,
                        preserve_raw,
                        &|| {
                            println!("synthetic-restore-lock-held");
                            std::io::stdout().flush().unwrap();
                            let mut command = String::new();
                            std::io::stdin().lock().read_line(&mut command).unwrap();
                            std::process::exit(73);
                        },
                    ))
                })
            })
            .await
            .unwrap()
            .unwrap();
        });
        panic!("crash hook was not reached");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn interrupted_raw_restore_never_revalidates_an_old_policy_stamp() {
        use std::io::{BufRead, Write};
        use std::sync::{mpsc, Arc};
        use std::time::Duration;
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let (_temp, data, config) = profile().await;
        let owner = Arc::new(crate::secrets::policy::PolicyOwner::for_test(&data));
        owner.startup(&data, |_| Ok(())).unwrap();
        let old_stamp = owner.qualification_stamp().unwrap();
        let old_bytes = fs::read(data.join(PROVIDER_SECRETS_FILE)).unwrap();
        let original = capture_raw(&data, &config, BTreeMap::new()).unwrap();
        let directory = data.join("local-backup");
        fs::create_dir_all(&directory).unwrap();
        let preserved_name = format!("preserved-{}.json", uuid::Uuid::new_v4());
        let preserved = directory.join(&preserved_name);
        preserve_raw(&original, &preserved).unwrap();
        let archive_bytes = fs::read(&preserved).unwrap();
        let writer = crate::secrets::policy::PolicyOwner::for_test(&data);
        writer.startup(&data, |_| Ok(())).unwrap();
        assert!(owner.qualification_stamp().unwrap() != old_stamp);
        let marker = RestoreJournal {
            preserved: preserved_name,
            phase: RestorePhase::Rollback,
            launch: launch::SnapshotRollback::default(),
        };
        atomic(
            &directory.join("restoring.json"),
            &serde_json::to_vec(&marker).unwrap(),
        )
        .unwrap();
        let mut child = Child(
            crate::core::process::background_command(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "local_backup::tests::policy_restore_crash_child",
                    "--nocapture",
                ])
                .env("MACRO_POLICY_RESTORE_CRASH_DATA", &data)
                .env("MACRO_POLICY_RESTORE_CRASH_CONFIG", &config)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::inherit())
                .spawn()
                .unwrap(),
        );
        let stdout = child.0.stdout.take().unwrap();
        let (held_tx, held_rx) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in std::io::BufReader::new(stdout).lines() {
                if line.unwrap().contains("synthetic-restore-lock-held") {
                    held_tx.send(()).unwrap();
                    break;
                }
            }
        });
        held_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        reader.join().unwrap();
        let (captured_tx, captured_rx) = mpsc::channel();
        let capture_owner = owner.clone();
        let capture = std::thread::spawn(move || {
            captured_tx
                .send(capture_owner.qualification_stamp().is_ok())
                .unwrap();
        });
        let excluded = captured_rx.recv_timeout(Duration::from_millis(50)).is_err();
        child.0.stdin.take().unwrap().write_all(b"crash\n").unwrap();
        let status = child.0.wait().unwrap();
        let refused = !captured_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        capture.join().unwrap();
        assert!(excluded);
        assert_eq!(status.code(), Some(73));
        assert!(refused);
        assert_eq!(
            fs::read(data.join(PROVIDER_SECRETS_FILE)).unwrap(),
            old_bytes
        );
        assert_eq!(fs::read(&preserved).unwrap(), archive_bytes);
        let pending: RestoreJournal =
            serde_json::from_slice(&fs::read(directory.join("restoring.json")).unwrap()).unwrap();
        assert!(pending.phase == RestorePhase::InstallHold);
        assert!(owner.qualification_stamp().is_err());
        // A closed-profile repair must survive retry: the raw archive is not applied twice.
        let mut repaired: serde_json::Value = serde_json::from_slice(&old_bytes).unwrap();
        repaired["namespaces"]["providers"]["synthetic"] = serde_json::json!("repair-before-retry");
        fs::write(
            data.join(PROVIDER_SECRETS_FILE),
            serde_json::to_vec(&repaired).unwrap(),
        )
        .unwrap();
        process_startup(&data, &config).await.unwrap();
        let after: serde_json::Value =
            serde_json::from_slice(&fs::read(data.join(PROVIDER_SECRETS_FILE)).unwrap()).unwrap();
        assert_eq!(
            after["namespaces"]["providers"]["synthetic"],
            "repair-before-retry"
        );
        assert!(owner.qualification_stamp().unwrap() != old_stamp);
        assert_eq!(fs::read(&preserved).unwrap(), archive_bytes);
        assert!(!directory.join("restoring.json").exists());
    }

    pub(super) async fn profile() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let config = temp.path().join("config");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&config).unwrap();
        let pool = crate::db::create_pool(&data.join("macro.db"))
            .await
            .unwrap();
        sqlx::query("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conversation', 'Original', '2026-09-05', '2026-09-05')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('message', 'conversation', 'user', 'Representative transcript', '2026-09-05')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO app_settings (key,value_json,updated_at) VALUES ('agentCodeCheckpoints:conversation','{broken but preserved','2026-09-05')").execute(&pool).await.unwrap();
        // Tests comparing the database file must capture committed WAL pages too.
        // Pool closure can finish before SQLite's background close checkpoints them.
        let (busy, _, _): (i64, i64, i64) = sqlx::query_as("PRAGMA wal_checkpoint(TRUNCATE)")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(busy, 0);
        pool.close().await;
        (temp, data, config)
    }

    pub(super) async fn remove_post_catalog_schema(db: &mut SqliteConnection) {
        crate::db::migration_tests::drop_agsdl(db).await;
        crate::db::chat_admission::remove_reference_schema_in(db)
            .await
            .unwrap();
        remove_reference_e_schema(db, &[]).await.unwrap();
        sqlx::query("DELETE FROM schema_migrations WHERE version>14")
            .execute(db)
            .await
            .unwrap();
    }
    async fn remove_content_schema(db: &mut SqliteConnection) {
        remove_post_catalog_schema(db).await;
        crate::db::conversation_catalog::remove_reference_schema_in(db)
            .await
            .unwrap();
        sqlx::query("DELETE FROM schema_migrations WHERE version=14")
            .execute(&mut *db)
            .await
            .unwrap();
        let names: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'content_versions_*'").fetch_all(&mut *db).await.unwrap();
        for name in names {
            sqlx::query(sqlx::AssertSqlSafe(format!("DROP TRIGGER {name}")))
                .execute(&mut *db)
                .await
                .unwrap();
        }
        sqlx::raw_sql("DROP TABLE conversation_content_versions; DELETE FROM schema_migrations WHERE version=13;").execute(&mut *db).await.unwrap();
    }

    async fn remove_post_v4_schema(db: &mut SqliteConnection) {
        remove_v9_schema(db).await;
        sqlx::query("DROP TABLE agent_run_transitions")
            .execute(&mut *db)
            .await
            .unwrap();
        sqlx::query("DROP TABLE tool_invocations")
            .execute(&mut *db)
            .await
            .unwrap();
        sqlx::query("ALTER TABLE messages DROP COLUMN generation_attempts_json")
            .execute(&mut *db)
            .await
            .unwrap();
        sqlx::query("DELETE FROM schema_migrations WHERE version >= 5")
            .execute(&mut *db)
            .await
            .unwrap();
    }

    async fn remove_v9_schema(db: &mut SqliteConnection) {
        remove_content_schema(db).await;
        for statement in [
            "DROP TABLE pilot_file_chunks",
            "DROP TABLE pilot_file_sends",
            "DROP TABLE pilot_message_attachments",
            "DROP TABLE pilot_file_transfers",
            "DROP TABLE pilot_file_sources",
            "DROP TABLE pilot_file_binding_history",
            "DROP TABLE pilot_file_authorities",
        ] {
            sqlx::query(statement).execute(&mut *db).await.unwrap();
        }
        for statement in [
            "DROP TRIGGER conversation_management_insert",
            "DROP TRIGGER conversation_management_update",
            "DROP TRIGGER conversation_response_insert",
            "DROP TRIGGER conversation_response_update",
            "DROP TABLE conversation_response_versions",
            "DROP TABLE conversation_action_receipts",
            "DROP TABLE conversation_management",
            "DROP TRIGGER messages_tool_trace_revision_insert",
            "DROP TRIGGER messages_tool_trace_revision_delete",
            "DROP TRIGGER messages_tool_trace_revision_update_same_conversation",
            "DROP TRIGGER messages_tool_trace_revision_update_conversation",
            "DROP TABLE conversation_tool_trace_revisions",
            "DELETE FROM schema_migrations WHERE version >= 10",
        ] {
            sqlx::query(statement).execute(&mut *db).await.unwrap();
        }
        sqlx::query("DROP TRIGGER conversation_goal_audit_run_status")
            .execute(&mut *db)
            .await
            .unwrap();
        for statement in [
            "DROP TABLE conversation_goal_audit_runs",
            "DROP TABLE conversation_goal_audits",
            "DROP TABLE conversation_goals",
        ] {
            sqlx::query(statement).execute(&mut *db).await.unwrap();
        }
        sqlx::query("DELETE FROM schema_migrations WHERE version = 9")
            .execute(&mut *db)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn malformed_request_is_quarantined_and_does_not_block_repeated_startup() {
        let (_temp, data, config) = profile().await;
        let before = fs::read(data.join("macro.db")).unwrap();
        let dir = data.join("local-backup");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("request.json"), b"{truncated").unwrap();
        process_startup(&data, &config).await.unwrap();
        process_startup(&data, &config).await.unwrap();
        let status: BackupStatus =
            serde_json::from_slice(&fs::read(dir.join("status.json")).unwrap()).unwrap();
        assert_eq!(status.code, Some(BackupStatusCode::InvalidRequest));
        assert_eq!(fs::read(status.path.unwrap()).unwrap(), b"{truncated");
        assert_eq!(fs::read(data.join("macro.db")).unwrap(), before);
        assert!(!dir.join("request.json").exists());
    }

    #[test]
    fn interrupted_preparation_never_publishes_a_partial_request() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("request.json");
        assert!(publish_new(&path, |file| {
            file.write_all(b"{partial")?;
            Err(std::io::Error::other("synthetic write failure"))
        })
        .is_err());
        assert!(!path.exists());
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
        write_new(&path, b"{} ").unwrap();
        assert_eq!(fs::read(path).unwrap(), b"{} ");
    }

    #[test]
    fn new_publication_never_overwrites_an_existing_file_or_leaves_temporary_files() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("request.json");
        write_new(&path, b"original").unwrap();
        assert!(write_new(&path, b"replacement").is_err());
        assert_eq!(fs::read(path).unwrap(), b"original");
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn export_rejects_internal_destinations_including_canonical_aliases() {
        let (temp, data, config) = profile().await;
        let dir = data.join("local-backup");
        fs::create_dir_all(&dir).unwrap();
        for path in [
            dir.join("status.json"),
            config.join("new.json"),
            data.join("state.json"),
        ] {
            assert!(validate_export_path(&path, &data, &config).is_err());
        }
        assert!(validate_export_path(&temp.path().join("export.json"), &data, &config).is_ok());
        #[cfg(unix)]
        {
            let alias = temp.path().join("alias");
            std::os::unix::fs::symlink(&dir, &alias).unwrap();
            assert!(validate_export_path(&alias.join("export.json"), &data, &config).is_err());
        }
        atomic(
            &dir.join("request.json"),
            &serde_json::to_vec(&Request {
                operation: "export".into(),
                path: dir.join("status.json").to_string_lossy().into(),
                browser: BTreeMap::new(),
            })
            .unwrap(),
        )
        .unwrap();
        process_startup(&data, &config).await.unwrap();
        let status: BackupStatus =
            serde_json::from_slice(&fs::read(dir.join("status.json")).unwrap()).unwrap();
        assert_eq!(status.code, Some(BackupStatusCode::Failed));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_symbolic_config_ancestors_even_when_archive_omits_configuration() {
        let (temp, data, config) = profile().await;
        let archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        let outside = temp.path().join("outside");
        fs::create_dir_all(outside.join("approved/user")).unwrap();
        let external = outside.join("approved/user/settings.json");
        fs::write(&external, b"synthetic external bytes").unwrap();
        std::os::unix::fs::symlink(&outside, config.join(".runtime")).unwrap();
        assert!(capture_raw(&data, &config, BTreeMap::new()).is_err());
        assert!(capture(&data, &config, BTreeMap::new(), true)
            .await
            .is_err());
        assert!(apply(&archive, &data, &config).is_err());
        assert_eq!(fs::read(&external).unwrap(), b"synthetic external bytes");
    }

    #[tokio::test]
    async fn restores_pre_v5_archive_before_migrating_restored_database() {
        let (temp, data, config) = profile().await;
        let database = data.join("macro.db");
        let mut db = connection(&database).await.unwrap();
        // Preserve a representative pre-v5 archive, including its older schema.
        remove_post_v4_schema(&mut db).await;
        db.close().await.unwrap();
        let archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        let archived_database = temp.path().join("archived-v4.db");
        fs::write(
            &archived_database,
            STANDARD
                .decode(&archive.files["data/macro.db"].data)
                .unwrap(),
        )
        .unwrap();
        let mut archived = connection(&archived_database).await.unwrap();
        let versions: Vec<i64> =
            sqlx::query_scalar("SELECT version FROM schema_migrations ORDER BY version")
                .fetch_all(&mut archived)
                .await
                .unwrap();
        assert_eq!(versions, [1, 3, 4]);
        archived.close().await.unwrap();
        validate(&archive, &data).await.unwrap();

        // Change the source without running migrations, so restoration must recover it.
        let mut db = connection(&database).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT MAX(version) FROM schema_migrations")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            4
        );
        sqlx::query("UPDATE conversations SET title = 'Changed' WHERE id = 'conversation'")
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
        queue_restore(&data, &archive);
        process_startup(&data, &config).await.unwrap();
        let status: BackupStatus =
            serde_json::from_slice(&fs::read(data.join("local-backup/status.json")).unwrap())
                .unwrap();
        assert_eq!(status.code, Some(BackupStatusCode::Restored));
        let mut restored = connection(&database).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT MAX(version) FROM schema_migrations")
                .fetch_one(&mut restored)
                .await
                .unwrap(),
            crate::db::operate_inbox::DELETE_SCHEMA_VERSION
        );
        restored.close().await.unwrap();

        // Restore installs the current schema and read-only ownership before startup.
        let pool = crate::db::create_pool(&database).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT MAX(version) FROM schema_migrations")
                .fetch_one(&pool)
                .await
                .unwrap(),
            crate::db::operate_inbox::DELETE_SCHEMA_VERSION
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT title FROM conversations WHERE id = 'conversation'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            "Original"
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT content FROM message_search WHERE message_search MATCH 'Representative'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            "Representative transcript"
        );
        pool.close().await;
    }

    #[tokio::test]
    async fn historical_archives_validate_before_and_after_migration_without_loss() {
        for variant in 0..6 {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("archive.db");
            let mut c = crate::db::migration_tests::historical_database(&path, variant).await;
            sqlx::raw_sql("INSERT INTO conversations(id,title,created_at,updated_at) VALUES('preserved','Synthetic','original','original'); INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES('preserved-message','preserved','user','Keep café transcript','original');").execute(&mut c).await.unwrap();
            if variant >= 2 {
                sqlx::query("INSERT INTO engine_systems VALUES('preserved-system','request','{}','{}','{}','{}')").execute(&mut c).await.unwrap();
            }
            c.close().await.unwrap();
            let original = fs::read(&path).unwrap();
            check_database(&path)
                .await
                .unwrap_or_else(|e| panic!("historical variant {variant}: {e}"));
            assert_eq!(fs::read(&path).unwrap(), original);
            let pool = crate::db::create_pool(&path).await.unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, String>(
                    "SELECT content FROM messages WHERE id='preserved-message'"
                )
                .fetch_one(&pool)
                .await
                .unwrap(),
                "Keep café transcript"
            );
            if variant >= 2 {
                assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='engine_systems'").fetch_one(&pool).await.unwrap(), 0);
            }
            pool.close().await;
            check_database(&path).await.unwrap();
        }
    }

    #[tokio::test]
    async fn validates_both_published_v10_archive_schemas_without_migrating_them() {
        for visible_search in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let database = temp.path().join("published.db");
            let mut old =
                crate::db::migration_tests::published_branch_database(&database, visible_search)
                    .await;
            let stamps: Vec<(i64, String, String)> = sqlx::query_as(
                "SELECT version,name,applied_at FROM schema_migrations ORDER BY version",
            )
            .fetch_all(&mut old)
            .await
            .unwrap();
            check_database(&database).await.unwrap();
            assert_eq!(
                sqlx::query_as::<_, (i64, String, String)>(
                    "SELECT version,name,applied_at FROM schema_migrations ORDER BY version"
                )
                .fetch_all(&mut old)
                .await
                .unwrap(),
                stamps
            );
            sqlx::query("UPDATE schema_migrations SET name='unknown_010' WHERE version=10")
                .execute(&mut old)
                .await
                .unwrap();
            assert!(check_database(&database).await.is_err());
        }
    }

    #[tokio::test]
    async fn database_validation_accepts_current_and_rejects_unknown_migration_versions() {
        let (_temp, data, _config) = profile().await;
        let database = data.join("macro.db");
        check_database(&database).await.unwrap();
        let mut db = connection(&database).await.unwrap();
        let version: i64 = sqlx::query_scalar("SELECT MAX(version) FROM schema_migrations")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(version, crate::db::operate_inbox::DELETE_SCHEMA_VERSION);
        sqlx::query("INSERT INTO schema_migrations VALUES (99, 'future', 'synthetic')")
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
        assert!(check_database(&database)
            .await
            .unwrap_err()
            .contains("Unknown migration identity 99/future"));
    }

    #[tokio::test]
    async fn validates_v6_archive_without_migrating_the_source() {
        let (_temp, data, config) = profile().await;
        let database = data.join("macro.db");
        let mut db = connection(&database).await.unwrap();
        remove_v9_schema(&mut db).await;
        sqlx::query("DROP TABLE agent_run_transitions")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query("DELETE FROM schema_migrations WHERE version = 8")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query("DROP TABLE tool_invocations")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query("DELETE FROM schema_migrations WHERE version = 7")
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
        let archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        validate(&archive, &data).await.unwrap();
        let mut source = connection(&database).await.unwrap();
        let version: i64 = sqlx::query_scalar("SELECT MAX(version) FROM schema_migrations")
            .fetch_one(&mut source)
            .await
            .unwrap();
        assert_eq!(version, 6);
        let missing: Option<String> =
            sqlx::query_scalar("SELECT name FROM sqlite_master WHERE name = 'tool_invocations'")
                .fetch_optional(&mut source)
                .await
                .unwrap();
        assert!(missing.is_none());
    }

    #[tokio::test]
    async fn validates_v7_archive_with_tool_journal_without_migrating_source() {
        let (_temp, data, config) = profile().await;
        let database = data.join("macro.db");
        let mut db = connection(&database).await.unwrap();
        remove_v9_schema(&mut db).await;
        sqlx::query("DROP TABLE agent_run_transitions")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query("DELETE FROM schema_migrations WHERE version = 8")
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
        let archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        validate(&archive, &data).await.unwrap();
        let mut source = connection(&database).await.unwrap();
        let version: i64 = sqlx::query_scalar("SELECT MAX(version) FROM schema_migrations")
            .fetch_one(&mut source)
            .await
            .unwrap();
        assert_eq!(version, 7);
        let tool_table: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'tool_invocations'",
        )
        .fetch_one(&mut source)
        .await
        .unwrap();
        assert_eq!(tool_table, 1);
    }

    #[tokio::test]
    async fn validates_v8_archive_without_migrating_source() {
        let (_temp, data, config) = profile().await;
        let database = data.join("macro.db");
        let mut db = connection(&database).await.unwrap();
        remove_v9_schema(&mut db).await;
        db.close().await.unwrap();
        let archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        validate(&archive, &data).await.unwrap();
        let mut source = connection(&database).await.unwrap();
        let version: i64 = sqlx::query_scalar("SELECT MAX(version) FROM schema_migrations")
            .fetch_one(&mut source)
            .await
            .unwrap();
        assert_eq!(version, 8);
        let goals: Option<String> =
            sqlx::query_scalar("SELECT name FROM sqlite_master WHERE name = 'conversation_goals'")
                .fetch_optional(&mut source)
                .await
                .unwrap();
        assert!(goals.is_none());
    }

    #[tokio::test]
    async fn rejects_v8_archive_with_weakened_transition_constraints() {
        let (_temp, data, _config) = profile().await;
        let database = data.join("macro.db");
        let mut db = connection(&database).await.unwrap();
        let table_sql: String = sqlx::query_scalar(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_run_transitions'",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        let weakened = table_sql.replace(" CHECK (sequence >= 0)", "");
        assert_ne!(weakened, table_sql);
        sqlx::query("DROP TABLE agent_run_transitions")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query(sqlx::AssertSqlSafe(weakened))
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
        assert_eq!(
            check_database(&database).await.unwrap_err(),
            "Incompatible backup table constraints: agent_run_transitions"
        );
    }

    #[tokio::test]
    async fn rejects_v7_archive_with_weakened_tool_journal_constraints() {
        let (_temp, data, _config) = profile().await;
        let database = data.join("macro.db");
        let mut db = connection(&database).await.unwrap();
        let table_sql: String = sqlx::query_scalar(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tool_invocations'",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        let index_sql: String = sqlx::query_scalar(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_tool_invocations_unresolved'",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        let weakened =
            table_sql.replace(" CHECK (status IN ('pending', 'completed', 'unknown'))", "");
        assert_ne!(weakened, table_sql);
        sqlx::query("DROP TABLE tool_invocations")
            .execute(&mut db)
            .await
            .unwrap();
        // Both statements come from this test database's own migration DDL.
        sqlx::query(sqlx::AssertSqlSafe(weakened))
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query(sqlx::AssertSqlSafe(index_sql))
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();

        assert_eq!(
            check_database(&database).await.unwrap_err(),
            "Incompatible backup table constraints: tool_invocations"
        );
    }

    #[tokio::test]
    async fn accepts_constraints_after_legacy_column_upgrade() {
        let (_temp, data, config) = profile().await;
        let database = data.join("macro.db");
        let mut db = connection(&database).await.unwrap();
        sqlx::query("DROP INDEX idx_messages_conversation_turn")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query("ALTER TABLE messages DROP COLUMN turn_id")
            .execute(&mut db)
            .await
            .unwrap();
        // This fixture represents a pre-v5 database, not damage after migration.
        remove_post_v4_schema(&mut db).await;
        db.close().await.unwrap();
        // The supported legacy upgrader adds this column at the end of the table.
        let pool = crate::db::create_pool(&database).await.unwrap();
        pool.close().await;
        let archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        validate(&archive, &data).await.unwrap();
    }

    #[tokio::test]
    async fn rejects_missing_foreign_key_before_profile_replacement() {
        let (temp, data, config) = profile().await;
        let before = fs::read(data.join("macro.db")).unwrap();
        let mut archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        let database = temp.path().join("missing-foreign-key.db");
        fs::write(
            &database,
            STANDARD
                .decode(&archive.files["data/macro.db"].data)
                .unwrap(),
        )
        .unwrap();
        let mut db = connection(&database).await.unwrap();
        // Synthetic fixture: keep the declared columns but remove the schema constraint.
        sqlx::query("PRAGMA writable_schema=ON")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query("UPDATE sqlite_master SET sql=replace(sql, 'FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE', '') WHERE name='messages'").execute(&mut db).await.unwrap();
        // Remove the trailing separator left by the removed final constraint.
        sqlx::query(
            "UPDATE sqlite_master SET sql=replace(sql, ',\n    \n)', '\n)') WHERE name='messages'",
        )
        .execute(&mut db)
        .await
        .unwrap();
        db.close().await.unwrap();
        let mut changed = connection(&database).await.unwrap();
        let foreign_keys = sqlx::query("PRAGMA foreign_key_list(messages)")
            .fetch_all(&mut changed)
            .await
            .unwrap();
        assert!(foreign_keys.is_empty());
        let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_one(&mut changed)
            .await
            .unwrap();
        assert_eq!(integrity, "ok");
        changed.close().await.unwrap();
        add_file(
            &mut archive.files,
            "data/macro.db".into(),
            fs::read(database).unwrap(),
        )
        .unwrap();
        assert!(validate(&archive, &data).await.is_err());
        queue_restore(&data, &archive);
        process_startup(&data, &config).await.unwrap();
        assert_eq!(fs::read(data.join("macro.db")).unwrap(), before);
    }

    #[tokio::test]
    async fn startup_cleans_unreferenced_incoming_backup_only() {
        let (_temp, data, config) = profile().await;
        let dir = data.join("local-backup");
        fs::create_dir(&dir).unwrap();
        let incoming = dir.join("incoming.json");
        let preserved = dir.join(format!("preserved-{}.zip", uuid::Uuid::new_v4()));
        fs::write(&incoming, b"incomplete, unreferenced backup").unwrap();
        fs::write(&preserved, b"rollback preservation").unwrap();
        process_startup(&data, &config).await.unwrap();
        assert!(!incoming.exists());
        assert_eq!(fs::read(preserved).unwrap(), b"rollback preservation");
    }

    #[tokio::test]
    async fn interrupted_restore_recovers_file_directory_transitions_without_replaying_request() {
        let (_temp, data, config) = profile().await;
        let object = data.join("direct-checkpoints/synthetic/object");
        fs::create_dir_all(object.parent().unwrap()).unwrap();
        fs::write(&object, b"original leaf").unwrap();
        let original = capture_raw(&data, &config, BTreeMap::new()).unwrap();
        let mut archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        archive
            .files
            .remove("data/direct-checkpoints/synthetic/object");
        add_file(
            &mut archive.files,
            "data/direct-checkpoints/synthetic/object/new".into(),
            b"new leaf".to_vec(),
        )
        .unwrap();
        validate(&archive, &data).await.unwrap();
        queue_restore(&data, &archive);
        let dir = data.join("local-backup");
        // Fail after application, when the success status should be published.
        fs::create_dir(dir.join("status.json")).unwrap();
        assert!(process_startup(&data, &config).await.is_err());
        assert!(object.join("new").exists());
        assert!(dir.join("restoring.json").exists());
        assert!(dir.join("incoming.json").is_file());
        let marker: RestoreJournal =
            serde_json::from_slice(&fs::read(dir.join("restoring.json")).unwrap()).unwrap();
        let preserved = preserved_path(&dir, &marker).unwrap();
        fs::remove_dir(dir.join("status.json")).unwrap();
        process_startup(&data, &config).await.unwrap();
        assert_eq!(fs::read(&object).unwrap(), b"original leaf");
        assert!(!dir.join("restoring.json").exists());
        assert!(!dir.join("request.json").exists());
        assert!(!dir.join("incoming.json").exists());
        assert!(preserved.is_file());
        let recovered = capture_raw(&data, &config, BTreeMap::new()).unwrap();
        // Startup creates the empty policy document; all archived files remain checked below.
        assert_empty_policy(&data);
        assert!(!original.files.contains_key("data/provider-secrets.json"));
        super::qualification::assert_held_files(&recovered, &original).await;
        process_startup(&data, &config).await.unwrap();
        assert_eq!(fs::read(object).unwrap(), b"original leaf");
    }

    #[tokio::test]
    async fn archive_checkpoint_limits_match_capture_and_recovery() {
        let (_temp, data, config) = profile().await;
        let mut archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        let valid = format!("data/direct-checkpoints/{}leaf", "d/".repeat(30));
        add_file(&mut archive.files, valid.clone(), b"boundary".to_vec()).unwrap();
        validate(&archive, &data).await.unwrap();
        apply(&archive, &data, &config).unwrap();
        validate_raw(&capture_raw(&data, &config, BTreeMap::new()).unwrap()).unwrap();
        let deep = format!("data/direct-checkpoints/{}leaf", "d/".repeat(31));
        add_file(&mut archive.files, deep, vec![]).unwrap();
        assert!(validate(&archive, &data)
            .await
            .unwrap_err()
            .contains("depth"));
        archive
            .files
            .retain(|key, _| !key.starts_with("data/direct-checkpoints/"));
        for index in 0..5000 {
            add_file(
                &mut archive.files,
                format!("data/direct-checkpoints/{index}/leaf"),
                vec![],
            )
            .unwrap();
        }
        assert!(validate(&archive, &data)
            .await
            .unwrap_err()
            .contains("entry limit"));
        archive
            .files
            .retain(|key, _| !key.starts_with("data/direct-checkpoints/"));
        add_file(
            &mut archive.files,
            "data/direct-checkpoints/object".into(),
            vec![],
        )
        .unwrap();
        add_file(
            &mut archive.files,
            "data/direct-checkpoints/object/leaf".into(),
            vec![],
        )
        .unwrap();
        assert!(validate(&archive, &data)
            .await
            .unwrap_err()
            .contains("both a file"));
    }
    #[tokio::test]
    async fn round_trip_preserves_transcript_checkpoints_and_browser_data() {
        let (_temp, data, config) = profile().await;
        let browser = BTreeMap::from([(
            "macro_chat_message_images".into(),
            "{\"message\":[]}".into(),
        )]);
        let archive = capture(&data, &config, browser.clone(), true)
            .await
            .unwrap();
        validate(&archive, &data).await.unwrap();
        let mut db = connection(&data.join("macro.db")).await.unwrap();
        sqlx::query("UPDATE conversations SET title='Changed'")
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
        apply(&archive, &data, &config).unwrap();
        let mut db = connection(&data.join("macro.db")).await.unwrap();
        let title: String =
            sqlx::query_scalar("SELECT title FROM conversations WHERE id='conversation'")
                .fetch_one(&mut db)
                .await
                .unwrap();
        let raw: String = sqlx::query_scalar(
            "SELECT value_json FROM app_settings WHERE key='agentCodeCheckpoints:conversation'",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(title, "Original");
        assert_eq!(raw, "{broken but preserved");
        assert_eq!(archive.browser, browser);
        let indexed_message: String = sqlx::query_scalar(
            "SELECT messages.id FROM message_search JOIN messages ON messages.rowid = message_search.rowid WHERE message_search MATCH 'Representative'",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(indexed_message, "message");
    }

    #[tokio::test]
    async fn v9_backup_restores_goal_criteria_and_audit_run_link() {
        use crate::db::conversation_goals::{
            self, ActivateConversationGoalInput, ClaimConversationGoalAuditInput,
        };
        use crate::db::models::CreateAgentRunInput;
        let (_temp, data, config) = profile().await;
        let database = data.join("macro.db");
        let pool = crate::db::create_pool(&database).await.unwrap();
        sqlx::query("UPDATE conversations SET project_id = 'project' WHERE id = 'conversation'")
            .execute(&pool)
            .await
            .unwrap();
        conversation_goals::activate_goal(
            &pool,
            ActivateConversationGoalInput {
                conversation_id: "conversation".into(),
                goal_id: "goal".into(),
                objective: "Finish".into(),
                success_criteria: vec!["Check tests".into()],
                provider_id: None,
                model_id: None,
                reasoning_effort: None,
                replace_goal_id: None,
                replace_revision: None,
            },
        )
        .await
        .unwrap();
        conversation_goals::update_goal(
            &pool,
            conversation_goals::UpdateConversationGoalInput {
                conversation_id: "conversation".into(),
                goal_id: "goal".into(),
                expected_revision: 1,
                objective: "Finish".into(),
                success_criteria: vec!["Check tests".into()],
                status: conversation_goals::GoalStatus::AuditPending,
                reason: None,
            },
        )
        .await
        .unwrap();
        sqlx::query("INSERT INTO messages (id, conversation_id, turn_id, role, content, created_at) VALUES ('executor', 'conversation', 'turn', 'assistant', 'Done', '2026-09-05')")
            .execute(&pool).await.unwrap();
        crate::db::goal_audit_transitions::record_goal_audit_transition(&pool,
            crate::db::goal_audit_transitions::RecordGoalAuditTransitionInput {
              descriptor: Some(CreateAgentRunInput {
                id: Some("run".into()),
                parent_conversation_id: "conversation".into(),
                child_conversation_id: None,
                agent_profile: "goal_auditor".into(),
                depth: 1,
                prompt: "Audit".into(),
                model_metadata_json: None,
              }),
              audit_claim: Some(ClaimConversationGoalAuditInput {
                audit_id: "audit".into(), conversation_id: "conversation".into(),
                goal_id: "goal".into(), expected_revision: 2,
                executor_turn_id: "turn".into(), run_id: "run".into(),
              }),
              audit_resume: None,
              transition: crate::db::goal_audit_transitions::GoalAuditTransition {
                run_id: "run".into(), parent_conversation_id: "conversation".into(),
                sequence: 0, previous_state: None,
                state: crate::db::models::AgentRunStatus::Queued,
                occurred_at: chrono::Utc::now().timestamp_millis(),
                snapshot: serde_json::json!({"runId": "run", "parentConversationId": "conversation", "state": "queued"}),
                result: None,
              },
              usage: crate::db::models::AgentRunUsageInput::default(),
            }
        )
        .await
        .unwrap();
        pool.close().await;
        let archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        validate(&archive, &data).await.unwrap();
        let mut db = connection(&database).await.unwrap();
        sqlx::query("UPDATE conversation_goals SET objective = 'Changed'")
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
        apply(&archive, &data, &config).unwrap();
        let pool = crate::db::create_pool(&database).await.unwrap();
        let goal = conversation_goals::get_current_goal(&pool, "conversation")
            .await
            .unwrap()
            .unwrap();
        let project_id: Option<String> =
            sqlx::query_scalar("SELECT project_id FROM conversations WHERE id = 'conversation'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(project_id.as_deref(), Some("project"));
        assert_eq!(goal.objective, "Finish");
        assert_eq!(goal.success_criteria, ["Check tests"]);
        let audit = conversation_goals::get_audit(&pool, "audit")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(audit.current_run_id, "run");
        let linked: String = sqlx::query_scalar(
            "SELECT run_id FROM conversation_goal_audit_runs WHERE audit_id = 'audit'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(linked, "run");
    }
    #[tokio::test]
    async fn startup_export_and_restore_round_trip_with_attachments_and_preferences() {
        let (temp, data, config) = profile().await;
        let mut db = connection(&data.join("macro.db")).await.unwrap();
        sqlx::query("INSERT INTO conversation_citations (id,conversation_id,message_id,type,scope,source,title,content,created_at,updated_at) VALUES ('attachment','conversation','message','file','conversation','user','notes.txt','attachment contents','2026-09-05','2026-09-05')").execute(&mut db).await.unwrap();
        db.close().await.unwrap();
        fs::write(
            config.join("settings.json"),
            br#"{"$schema":"settings.schema.json","schemaVersion":1,"language":"fr"}"#,
        )
        .unwrap();
        let checkpoint = data.join("direct-checkpoints/example/objects");
        fs::create_dir_all(&checkpoint).unwrap();
        fs::write(checkpoint.join("snapshot"), b"code snapshot").unwrap();
        let dir = data.join("local-backup");
        fs::create_dir_all(&dir).unwrap();
        let path = temp.path().join("export.json");
        let request = Request { operation: "export".into(), path: path.to_string_lossy().into(), browser: BTreeMap::from([("macro_chat_message_images".into(), r#"{"message":[{"id":"image","mimeType":"image/png","dataUrl":"data:image/png;base64,YQ==","createdAt":"2026-09-05"}]}"#.into())]) };
        atomic(
            &dir.join("request.json"),
            &serde_json::to_vec(&request).unwrap(),
        )
        .unwrap();
        process_startup(&data, &config).await.unwrap();
        let archive = load_archive(&path, &data).unwrap_or_else(|error| {
            panic!(
                "{error}: {}",
                fs::read_to_string(dir.join("status.json")).unwrap()
            )
        });
        validate(&archive, &data).await.unwrap();
        fs::write(
            config.join("settings.json"),
            br#"{"$schema":"settings.schema.json","schemaVersion":1,"language":"en"}"#,
        )
        .unwrap();
        fs::write(checkpoint.join("snapshot"), b"modified").unwrap();
        atomic(
            &dir.join("incoming.json"),
            &serde_json::to_vec(&archive).unwrap(),
        )
        .unwrap();
        atomic(
            &dir.join("request.json"),
            &serde_json::to_vec(&Request {
                operation: "restore".into(),
                path: path.to_string_lossy().into(),
                browser: BTreeMap::new(),
            })
            .unwrap(),
        )
        .unwrap();
        process_startup(&data, &config).await.unwrap();
        assert!(
            String::from_utf8(fs::read(config.join("settings.json")).unwrap())
                .unwrap()
                .contains("fr")
        );
        assert_eq!(
            fs::read(checkpoint.join("snapshot")).unwrap(),
            b"code snapshot"
        );
        let mut db = connection(&data.join("macro.db")).await.unwrap();
        let content: String =
            sqlx::query_scalar("SELECT content FROM conversation_citations WHERE id='attachment'")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(content, "attachment contents");
        let preserved = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("preserved-")
            })
            .unwrap();
        assert!(!dir.join("incoming.json").exists());
        let rollback = load_archive(&preserved, &data).unwrap();
        validate_raw(&rollback).unwrap();
        validate(
            &load_restore_archive(&preserved, &data).await.unwrap(),
            &data,
        )
        .await
        .unwrap();
        assert_eq!(
            STANDARD
                .decode(&rollback.files["data/direct-checkpoints/example/objects/snapshot"].data)
                .unwrap(),
            b"modified"
        );
    }
    #[tokio::test]
    async fn recovery_browser_state_round_trips_and_historical_restore_preserves_replaced_values() {
        let (temp, data, config) = profile().await;
        let browser = BTreeMap::from([
            (
                "macro_chat_queued_submissions_v1".into(),
                r#"[{"id":"accepted-turn","input":{"content":"Queued instruction"}}]"#.into(),
            ),
            (
                "macro_chat_unsaved_assistant_responses_v1".into(),
                r#"{"fallback":{"id":"fallback","content":"Recovered answer"}}"#.into(),
            ),
        ]);
        let archive = capture(&data, &config, browser.clone(), true)
            .await
            .unwrap();
        validate(&archive, &data).await.unwrap();
        let path = temp.path().join("recovery.json");
        write_new(&path, &serde_json::to_vec(&archive).unwrap()).unwrap();
        assert_eq!(
            load_restore_archive(&path, &data).await.unwrap().browser,
            browser
        );

        // Version 1 archives predating recovery keys remain valid and replace the whole browser profile.
        let historical = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        let dir = data.join("local-backup");
        fs::create_dir_all(&dir).unwrap();
        atomic(
            &dir.join("incoming.json"),
            &serde_json::to_vec(&historical).unwrap(),
        )
        .unwrap();
        atomic(
            &dir.join("request.json"),
            &serde_json::to_vec(&Request {
                operation: "restore".into(),
                path: path.to_string_lossy().into(),
                browser: browser.clone(),
            })
            .unwrap(),
        )
        .unwrap();
        process_startup(&data, &config).await.unwrap();
        let status: BackupStatus =
            serde_json::from_slice(&fs::read(dir.join("status.json")).unwrap()).unwrap();
        assert_eq!(status.browser, Some(BTreeMap::new()));
        let preserved = PathBuf::from(status.path.unwrap());
        let original = load_archive(&preserved, &data).unwrap();
        validate_raw(&original).unwrap();
        assert_eq!(original.browser, browser);

        // An interrupted native replacement recovers the same complete browser snapshot.
        atomic(
            &dir.join("restoring.json"),
            &serde_json::to_vec(&RestoreJournal {
                phase: RestorePhase::Rollback,
                launch: launch::SnapshotRollback::default(),
                preserved: preserved.file_name().unwrap().to_string_lossy().into(),
            })
            .unwrap(),
        )
        .unwrap();
        fs::write(data.join("macro.db"), b"partial replacement").unwrap();
        process_startup(&data, &config).await.unwrap();
        check_database(&data.join("macro.db")).await.unwrap();
        let recovered: BackupStatus =
            serde_json::from_slice(&fs::read(dir.join("status.json")).unwrap()).unwrap();
        assert_eq!(recovered.browser, Some(browser));
        assert!(preserved.exists());
    }
    #[tokio::test]
    async fn rejects_tampering_and_future_versions_without_touching_original() {
        let (_temp, data, config) = profile().await;
        let original = fs::read(data.join("macro.db")).unwrap();
        let mut archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        archive.version = 2;
        assert!(validate(&archive, &data).await.is_err());
        archive.version = 1;
        archive.files.get_mut("data/macro.db").unwrap().sha256 = "bad".into();
        assert!(validate(&archive, &data).await.is_err());
        assert_eq!(fs::read(data.join("macro.db")).unwrap(), original);
    }
    #[tokio::test]
    async fn startup_recovers_interrupted_restore_and_preserves_rollback_archive() {
        let (_temp, data, config) = profile().await;
        let original = capture_raw(&data, &config, BTreeMap::new()).unwrap();
        let dir = data.join("local-backup");
        fs::create_dir_all(&dir).unwrap();
        let marker = RestoreJournal {
            phase: RestorePhase::Rollback,
            launch: launch::SnapshotRollback::default(),
            preserved: format!("preserved-{}.json", uuid::Uuid::new_v4()),
        };
        let preserved = preserved_path(&dir, &marker).unwrap();
        preserve_raw(&original, &preserved).unwrap();
        atomic(
            &dir.join("restoring.json"),
            &serde_json::to_vec(&marker).unwrap(),
        )
        .unwrap();
        fs::write(data.join("macro.db"), b"failed replacement").unwrap();
        process_startup(&data, &config).await.unwrap();
        check_database(&data.join("macro.db")).await.unwrap();
        assert!(preserved.exists());
        assert!(!dir.join("restoring.json").exists());
    }
    #[tokio::test]
    async fn architect_library_rollback_removes_unpublished_files_before_next_restore() {
        let (_temp, data, config) = profile().await;
        let original = capture_raw(&data, &config, BTreeMap::new()).unwrap();
        let incoming = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        let dir = data.join("local-backup");
        fs::create_dir_all(&dir).unwrap();
        let marker = RestoreJournal {
            phase: RestorePhase::Rollback,
            launch: launch::SnapshotRollback::default(),
            preserved: format!("preserved-{}.json", uuid::Uuid::new_v4()),
        };
        preserve_raw(&original, &preserved_path(&dir, &marker).unwrap()).unwrap();
        atomic(
            &dir.join("restoring.json"),
            &serde_json::to_vec(&marker).unwrap(),
        )
        .unwrap();
        let introduced = data
            .join("architect-library/blueprints")
            .join(uuid::Uuid::new_v4().to_string())
            .join("versions")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&introduced).unwrap();
        fs::write(
            introduced.join(format!(".backup-{}", uuid::Uuid::new_v4())),
            b"durable but unpublished",
        )
        .unwrap();

        process_startup(&data, &config).await.unwrap();
        assert!(!introduced.exists());
        queue_restore(&data, &incoming);
        process_startup(&data, &config).await.unwrap();
        let status: BackupStatus =
            serde_json::from_slice(&fs::read(dir.join("status.json")).unwrap()).unwrap();
        assert_eq!(
            status.code,
            Some(BackupStatusCode::Restored),
            "{}",
            status.message
        );
    }

    #[tokio::test]
    async fn chat_admission_restore_hold_phase_does_not_reapply_rollback() {
        let (_temp, data, config) = profile().await;
        let original = capture_raw(&data, &config, BTreeMap::new()).unwrap();
        let dir = data.join("local-backup");
        fs::create_dir_all(&dir).unwrap();
        let marker = RestoreJournal {
            phase: RestorePhase::InstallHold,
            launch: launch::SnapshotRollback::default(),
            preserved: format!("preserved-{}.json", uuid::Uuid::new_v4()),
        };
        preserve_raw(&original, &preserved_path(&dir, &marker).unwrap()).unwrap();
        let mut db = connection(&data.join("macro.db")).await.unwrap();
        sqlx::query("UPDATE messages SET content='installed replacement' WHERE id='message'")
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
        atomic(
            &dir.join("restoring.json"),
            &serde_json::to_vec(&marker).unwrap(),
        )
        .unwrap();
        process_startup(&data, &config).await.unwrap();
        let mut db = connection(&data.join("macro.db")).await.unwrap();
        let value: (String, String) = sqlx::query_as("SELECT m.content,o.mode FROM messages m JOIN chat_admission_owners o ON o.conversation_id=m.conversation_id WHERE m.id='message'")
            .fetch_one(&mut db).await.unwrap();
        assert_eq!(
            value,
            ("installed replacement".into(), "restore_hold".into())
        );
        assert!(
            sqlx::query("UPDATE messages SET content='late' WHERE id='message'")
                .execute(&mut db)
                .await
                .is_err()
        );
        assert!(!dir.join("restoring.json").exists());
    }

    #[tokio::test]
    async fn chat_admission_restore_invalid_schema_retains_the_hold_journal() {
        let (_temp, data, config) = profile().await;
        let dir = data.join("local-backup");
        fs::create_dir_all(&dir).unwrap();
        let marker = RestoreJournal {
            phase: RestorePhase::InstallHold,
            launch: launch::SnapshotRollback::default(),
            preserved: format!("preserved-{}.json", uuid::Uuid::new_v4()),
        };
        let mut db = connection(&data.join("macro.db")).await.unwrap();
        sqlx::query("DROP TRIGGER chat_admission_messages_update")
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
        atomic(
            &dir.join("restoring.json"),
            &serde_json::to_vec(&marker).unwrap(),
        )
        .unwrap();
        assert!(process_startup(&data, &config).await.is_err());
        assert!(dir.join("restoring.json").exists());
    }

    #[tokio::test]
    async fn portable_tools_backup_keeps_approved_legacy_value_and_drops_pending_changes() {
        use crate::config::{ConfigDocumentKind, ConfigManager, ConfigScope};
        use serde_json::json;

        let (temp, data, config) = profile().await;
        let initial = ConfigManager::initialize(config.clone()).await.unwrap();
        let scope = ConfigScope::User;
        let kind = ConfigDocumentKind::Tools;
        let mut approved = initial
            .get_document(kind, scope.clone())
            .await
            .unwrap()
            .value;
        drop(initial);
        approved["languageServer"] = json!({"enabled": false, "executable": "/example/approved"});
        approved["riskLevel"] = json!("strict");
        let mut raw = approved.clone();
        raw["languageServer"] = json!({"enabled": true, "executable": "/example/pending"});
        raw["riskLevel"] = json!("yolo");
        let active_path = config.join("tools.json");
        let approved_path = config.join(".runtime/approved/user/tools.json");
        let pending_path = config.join(".runtime/pending/user/tools.json");
        let raw_bytes = serde_json::to_vec_pretty(&raw).unwrap();
        fs::write(&active_path, &raw_bytes).unwrap();
        fs::write(&approved_path, serde_json::to_vec(&approved).unwrap()).unwrap();
        fs::create_dir_all(pending_path.parent().unwrap()).unwrap();
        // Reproduce the full-document shape written before LSP was retired.
        fs::write(&pending_path, serde_json::to_vec(&json!({
            "pending": {
                "id": "legacy-tools-approval",
                "document": "tools",
                "scope": {"type": "user"},
                "source": "agent",
                "changedPaths": ["/languageServer/enabled", "/languageServer/executable", "/riskLevel"],
                "reasons": ["/languageServer exige une approbation utilisateur.", "/riskLevel exige une approbation utilisateur."],
                "proposedDocument": raw,
                "proposedEtag": format!("sha256:{}", hash(&serde_json::to_vec(&raw).unwrap())),
                "createdAt": "2026-09-05T00:00:00Z",
            },
            "approvedEtag": format!("sha256:{}", hash(&serde_json::to_vec(&approved).unwrap())),
            "allChangedPaths": ["/languageServer/enabled", "/languageServer/executable", "/riskLevel"],
            "applyModes": ["live"],
        })).unwrap()).unwrap();

        let exported = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        assert_eq!(fs::read(&active_path).unwrap(), raw_bytes);
        let legacy = capture(&data, &config, BTreeMap::new(), false)
            .await
            .unwrap();
        let migrated = ConfigManager::initialize(config.clone()).await.unwrap();
        assert_eq!(
            migrated.list_pending_changes().await[0].changed_paths,
            ["/riskLevel"]
        );
        assert_eq!(fs::read(&active_path).unwrap(), raw_bytes);
        let after_migration = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        drop(migrated);

        let archived_tools = |archive: &Archive, name: &str| {
            let bytes = STANDARD.decode(&archive.files[name].data).unwrap();
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()
        };
        let active = "config/tools.json";
        let baseline = "config/.runtime/approved/user/tools.json";
        let pending = "config/.runtime/pending/user/tools.json";
        for archive in [&exported, &after_migration] {
            assert_eq!(archived_tools(archive, active), approved);
            assert_eq!(archived_tools(archive, baseline), approved);
            assert!(!archive.files.contains_key(pending));
        }
        let archive_path = temp.path().join("legacy.json");
        fs::write(&archive_path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let restored = load_restore_archive(&archive_path, &data).await.unwrap();
        assert_eq!(archived_tools(&restored, active), approved);
        assert!(!restored.files.contains_key(pending));
        let mut unproven = legacy;
        unproven.files.remove(baseline);
        fs::write(&archive_path, serde_json::to_vec(&unproven).unwrap()).unwrap();
        let restored_unproven = load_restore_archive(&archive_path, &data).await.unwrap();
        assert!(archived_tools(&restored_unproven, active)
            .get("languageServer")
            .is_none());

        queue_restore(&data, &exported);
        process_startup(&data, &config).await.unwrap();
        let restored = ConfigManager::initialize(config).await.unwrap();
        assert_eq!(
            restored.get_document(kind, scope).await.unwrap().value,
            approved
        );
        assert!(restored.list_pending_changes().await.is_empty());
    }

    #[tokio::test]
    async fn portable_restore_detaches_provider_secrets_and_keeps_them_in_rollback() {
        let (_temp, data, config) = profile().await;
        let legacy_tools = br#"{
  "$schema": "./schemas/v1/tools.schema.json",
  "schemaVersion": 1,
  "languageServer": {
    "executable": "/example/language-server",
    "arguments": ["macro-secret://providers/synthetic-provider"]
  }
}"#;
        fs::write(config.join("tools.json"), legacy_tools).unwrap();
        let approved_tools = config.join(".runtime/approved/user/tools.json");
        fs::create_dir_all(approved_tools.parent().unwrap()).unwrap();
        fs::write(approved_tools, legacy_tools).unwrap();
        let provider_document = |base_url: &str| {
            serde_json::json!({
                "$schema": "providers.schema.json",
                "schemaVersion": 1,
                "providers": {
                    "synthetic-provider": {
                        "providerType": "openai",
                        "name": "Synthetic provider",
                        "enabled": false,
                        "baseUrl": base_url,
                        "isLocal": false
                    }
                }
            })
        };
        fs::write(
            config.join("providers.json"),
            serde_json::to_vec(&provider_document("https://restored.invalid/v1")).unwrap(),
        )
        .unwrap();
        let archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();

        fs::write(
            config.join("providers.json"),
            serde_json::to_vec(&provider_document("https://current.invalid/v1")).unwrap(),
        )
        .unwrap();
        let secret_bytes = br#"{
  "version": 2,
  "namespaces": {
    "providers": { "synthetic-provider": "synthetic-secret" }
  },
  "chatgpt_sessions": {}
}"#;
        fs::write(data.join(PROVIDER_SECRETS_FILE), secret_bytes).unwrap();
        let migration_backup = br#"{
  "version": 1,
  "api_keys": { "synthetic-provider": "synthetic-secret" }
}"#;
        fs::write(data.join("provider-secrets.json.v1.bak"), migration_backup).unwrap();
        let migration_journal = serde_json::json!({
            "from_version": 1,
            "source_sha256": hash(migration_backup),
            "target_sha256": hash(secret_bytes),
            "backup_file": "provider-secrets.json.v1.bak"
        });
        let migration_journal_bytes = serde_json::to_vec_pretty(&migration_journal).unwrap();
        fs::write(
            data.join("provider-secrets.migration-pending.json"),
            &migration_journal_bytes,
        )
        .unwrap();

        queue_restore(&data, &archive);
        process_startup(&data, &config).await.unwrap();
        let status: BackupStatus =
            serde_json::from_slice(&fs::read(data.join("local-backup/status.json")).unwrap())
                .unwrap();
        assert!(
            status.code == Some(BackupStatusCode::Restored),
            "unexpected restore status: {}",
            status.message
        );

        assert_empty_policy(&data);
        for file in PROVIDER_SECRETS_RECOVERY_FILES {
            if *file != PROVIDER_SECRETS_FILE {
                assert!(!data.join(file).exists(), "{file} must be detached");
            }
        }
        let _secret_store_guard = crate::secrets::lock_test_store();
        crate::secrets::init(&data).expect("initialize detached secret store");
        assert!(crate::secrets::get_api_key("synthetic-provider")
            .expect("read detached provider key")
            .is_none());
        let restored: serde_json::Value =
            serde_json::from_slice(&fs::read(config.join("providers.json")).unwrap()).unwrap();
        assert_eq!(
            restored.pointer("/providers/synthetic-provider/baseUrl"),
            Some(&serde_json::json!("https://restored.invalid/v1"))
        );
        let restored_tools: serde_json::Value =
            serde_json::from_slice(&fs::read(config.join("tools.json")).unwrap()).unwrap();
        assert_eq!(
            restored_tools,
            serde_json::from_slice::<serde_json::Value>(legacy_tools).unwrap()
        );

        let dir = data.join("local-backup");
        let preserved = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("preserved-")
            })
            .unwrap();
        let rollback = load_archive(&preserved, &data).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&preserved).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(
            STANDARD
                .decode(&rollback.files["data/provider-secrets.json"].data)
                .unwrap(),
            secret_bytes
        );
        assert_eq!(
            STANDARD
                .decode(&rollback.files["data/provider-secrets.json.v1.bak"].data)
                .unwrap(),
            migration_backup
        );
        assert_eq!(
            STANDARD
                .decode(&rollback.files["data/provider-secrets.migration-pending.json"].data)
                .unwrap(),
            migration_journal_bytes
        );
        assert_eq!(
            STANDARD
                .decode(&rollback.files["config/tools.json"].data)
                .unwrap(),
            legacy_tools
        );

        apply_files(&rollback, &data, &config, true).unwrap();
        assert_eq!(
            fs::read(data.join(PROVIDER_SECRETS_FILE)).unwrap(),
            secret_bytes
        );
        crate::secrets::init(&data).expect("initialize recovered secret store");
        assert_eq!(
            crate::secrets::get_api_key("synthetic-provider")
                .expect("read recovered provider key")
                .as_deref(),
            Some("synthetic-secret")
        );
        let recovered: serde_json::Value =
            serde_json::from_slice(&fs::read(config.join("providers.json")).unwrap()).unwrap();
        assert_eq!(
            recovered.pointer("/providers/synthetic-provider/baseUrl"),
            Some(&serde_json::json!("https://current.invalid/v1"))
        );
    }
    pub(super) fn queue_restore(data: &Path, archive: &Archive) {
        let dir = data.join("local-backup");
        fs::create_dir_all(&dir).unwrap();
        stage_incoming(&dir, archive).unwrap();
        atomic(
            &dir.join("request.json"),
            &serde_json::to_vec(&Request {
                operation: "restore".into(),
                path: String::new(),
                browser: BTreeMap::new(),
            })
            .unwrap(),
        )
        .unwrap();
    }
    #[tokio::test]
    async fn architect_library_restores_frozen_document_history_and_usage() {
        use crate::db::architect_library as library;
        use crate::legacy_agsdl_import::{migrate_profile, LegacyImportStatus, LegacyLocalStorage};

        let (_temp, data, config) = profile().await;
        let path = data.join("macro.db");
        let pool = crate::db::create_pool(&path).await.unwrap();
        sqlx::query("UPDATE conversations SET scope_mode='Architect' WHERE id='conversation'")
            .execute(&pool)
            .await
            .unwrap();
        let legacy = serde_json::json!({
            "id":"original","title":"Blueprint","projectId":"old-project","conversationId":"conversation",
            "status":"archived","archivedFromStatus":"draft",
            "agsdl":{"revision":7,"source":" {\"contract\":\"agsdl-0.3.0\"}\n","annexes":{"notes":"original"}}
        });
        let local = LegacyLocalStorage::Snapshot(BTreeMap::from([(
            "macro_architect_plan:main:original".into(),
            legacy.to_string(),
        )]));
        let completed = migrate_profile(&pool, Ok(vec![data.clone()]), None, local)
            .await
            .unwrap();
        assert_eq!(
            completed.status,
            LegacyImportStatus::Complete,
            "{:?}",
            completed.issues
        );
        assert_eq!(completed.inserted, 1);
        let id: String = sqlx::query_scalar("SELECT id FROM architect_blueprints")
            .fetch_one(&pool)
            .await
            .unwrap();
        let key =
            || serde_json::from_value(serde_json::json!({"blueprintId": id, "number": 1})).unwrap();
        let usage = || {
            serde_json::from_value(serde_json::json!({"kind":"schedule", "ownerId":"daily"}))
                .unwrap()
        };
        library::record_use(&pool, key(), usage()).await.unwrap();
        pool.close().await;
        let archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        let pool = crate::db::create_pool(&path).await.unwrap();
        library::release_use(&pool, key(), usage()).await.unwrap();
        library::delete_version(&pool, key()).await.unwrap();
        pool.close().await;
        queue_restore(&data, &archive);
        process_startup(&data, &config).await.unwrap();

        let pool = crate::db::create_pool(&path).await.unwrap();
        let version =
            serde_json::to_value(library::get_version(&pool, key()).await.unwrap()).unwrap();
        assert_eq!(version["document"]["source"], legacy["agsdl"]["source"]);
        assert_eq!(version["document"]["annexes"], legacy["agsdl"]["annexes"]);
        assert!(library::delete_version(&pool, key()).await.is_err());
        let draft = serde_json::to_value(library::get_draft(&pool, id).await.unwrap()).unwrap();
        assert_eq!(draft["history"]["status"], "archived");
        assert_eq!(draft["history"]["archivedFromStatus"], "draft");
        assert_eq!(draft["history"]["legacyConversationId"], "conversation");
        assert_eq!(draft["conversationId"], "conversation");
        let retried = migrate_profile(
            &pool,
            Ok(vec![data.join("missing")]),
            None,
            LegacyLocalStorage::Unavailable("offline after restore".into()),
        )
        .await
        .unwrap();
        assert_eq!(retried.status, LegacyImportStatus::Complete);
        assert_eq!((retried.inserted, retried.already_imported), (0, 1));
    }

    fn assert_private_artifact_staging(archive: &Archive, data: &Path) {
        let mut count = 0;
        for (name, entry) in &archive.files {
            if !name.starts_with(ARCHITECT_FILES) {
                continue;
            }
            count += 1;
            let Some(bundle::NativeEntry::Staged(stage)) = &entry.native else {
                panic!("{name} is not staged");
            };
            let root = stage.path();
            #[cfg(windows)]
            assert!(root.starts_with(data));
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = data;
                let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
                let path = bundle::staged_path(root, name);
                assert_eq!(mode(&path), 0o600, "{name}");
                for parent in path
                    .ancestors()
                    .skip(1)
                    .take_while(|parent| parent.starts_with(root))
                {
                    assert_eq!(mode(parent), 0o700, "{}", parent.display());
                }
            }
        }
        assert!(count > 0);
    }

    #[tokio::test]
    async fn architect_library_artifacts_round_trip_with_recovery_and_executable_metadata() {
        use crate::architect_library::{migration, storage::Storage};
        use crate::db::architect_library::{self as library, storage_index, VersionKey};
        let (_temp, data, config) = profile().await;
        let path = data.join("macro.db");
        let pool = crate::db::create_pool(&path).await.unwrap();
        sqlx::raw_sql(
            "INSERT INTO architect_projects(id,name) VALUES ('project','Systems');
            INSERT INTO architect_legacy_import VALUES (1,0,0);",
        )
        .execute(&pool)
        .await
        .unwrap();
        let source = serde_json::json!({
            "contract":"agsdl-0.4.0","id":"test-suite","title":"Étude",
            "agents":{"reviewer":{"harness":"codex","permissions":"read-only"}},
            "skills":{"example":{"uri":"skill/SKILL.md"}},
            "flow":{"entry":"review","steps":{"review":{"type":"agent","agent":"reviewer"}}}
        });
        let envelope = serde_json::json!({
            "source": source.to_string(),
            "annexes":{"skill/SKILL.md":"---\nname: example\ndescription: Example\n---\n", "skill/file.sh":"example\r\n"},
        });
        let invalid = " {\"source\":\"{bad\",\"annexes\":{}} ";
        sqlx::query(
            "INSERT INTO architect_blueprints(id,project_id,name,last_number,document)
             VALUES ('blueprint','project','Étude',1,?)",
        )
        .bind(envelope.to_string())
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO architect_versions(blueprint_id,number,revision,note,document)
            VALUES ('blueprint',1,1,'Recover me',?)",
        )
        .bind(invalid)
        .execute(&pool)
        .await
        .unwrap();
        let storage = Storage::new(&data);
        migration::migrate(&pool, &storage).await.unwrap();
        let draft = storage_index::draft_row(&pool, "blueprint").await.unwrap();
        let artifact = storage_index::Artifact::from_row(&draft, "id").unwrap();
        let script = storage
            .artifact_path(&artifact)
            .join("project/skill/file.sh");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        }
        storage
            .freeze(&pool, "blueprint".into(), 1, Some("saved".into()), None)
            .await
            .unwrap();
        let version = |number| VersionKey {
            blueprint_id: "blueprint".into(),
            number,
        };
        library::record_use(
            &pool,
            version(2),
            serde_json::from_value(serde_json::json!({"kind":"schedule", "ownerId":"daily"}))
                .unwrap(),
        )
        .await
        .unwrap();
        let archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        validate(&archive, &data).await.unwrap();
        assert_private_artifact_staging(&archive, &data);
        let archived_script = archive
            .files
            .iter()
            .find(|(name, _)| name.ends_with("/project/skill/file.sh"))
            .unwrap();
        let mut script_bytes = Vec::new();
        archived_script
            .1
            .copy_verified(archived_script.0, &mut script_bytes)
            .unwrap();
        assert_eq!(script_bytes, b"example\r\n");
        assert_eq!(archived_script.1.executable, cfg!(unix));

        let mut incomplete = archive.clone();
        let version_name = incomplete
            .files
            .keys()
            .find(|name| name.ends_with("/version.agsdl"))
            .unwrap()
            .clone();
        incomplete.files.remove(&version_name);
        assert!(validate(&incomplete, &data).await.is_err());
        let mut tampered = archive.clone();
        tampered
            .files
            .get_mut(archived_script.0)
            .unwrap()
            .executable = !archived_script.1.executable;
        assert!(validate(&tampered, &data).await.is_err());

        pool.close().await;
        fs::write(&script, "changed").unwrap();
        queue_restore(&data, &archive);
        let extracted = load_archive(&data.join("local-backup/incoming.json"), &data).unwrap();
        assert!(extracted
            .files
            .iter()
            .filter(|(name, _)| name.starts_with(ARCHITECT_FILES))
            .all(|(_, entry)| matches!(entry.native, Some(bundle::NativeEntry::Zip { .. }))));
        drop(extracted);
        process_startup(&data, &config).await.unwrap();
        let status: BackupStatus =
            serde_json::from_slice(&fs::read(data.join("local-backup/status.json")).unwrap())
                .unwrap();
        assert_eq!(
            status.code,
            Some(BackupStatusCode::Restored),
            "{}",
            status.message
        );
        assert_eq!(fs::read(&script).unwrap(), b"example\r\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_ne!(
                fs::metadata(&script).unwrap().permissions().mode() & 0o111,
                0
            );
        }
        let pool = crate::db::create_pool(&path).await.unwrap();
        let version_row = storage_index::version_row(&pool, &version(2))
            .await
            .unwrap();
        let artifact = storage_index::Artifact::from_row(&version_row, "blueprint_id").unwrap();
        let opened = storage.open_archive(&artifact).unwrap();
        assert_eq!(
            opened
                .members()
                .find(|file| file.path == "skill/file.sh")
                .unwrap()
                .executable,
            cfg!(unix)
        );
        assert!(storage.delete_version(&pool, version(2)).await.is_err());
        let output = data.join("original.json");
        storage
            .export_original(&pool, "blueprint".into(), 1, Some(1), &output)
            .await
            .unwrap();
        assert_eq!(fs::read_to_string(output).unwrap(), invalid);
        pool.close().await;

        // The restore's raw preservation uses the same managed paths and can
        // recover a file after an interrupted replacement.
        let original = capture_raw(&data, &config, BTreeMap::new()).unwrap();
        assert_private_artifact_staging(&original, &data);
        let dir = data.join("local-backup");
        let marker = RestoreJournal {
            preserved: format!("preserved-{}.json", uuid::Uuid::new_v4()),
            phase: RestorePhase::Rollback,
            launch: launch::SnapshotRollback::default(),
        };
        preserve_raw(&original, &preserved_path(&dir, &marker).unwrap()).unwrap();
        fs::write(
            dir.join("restoring.json"),
            serde_json::to_vec(&marker).unwrap(),
        )
        .unwrap();
        fs::write(&script, "interrupted").unwrap();
        process_startup(&data, &config).await.unwrap();
        assert_eq!(fs::read(&script).unwrap(), b"example\r\n");
    }

    #[tokio::test]
    async fn large_architect_import_survives_portable_backup_and_interrupted_restore() {
        use crate::architect_library::{migration, project::ImportCandidate};
        const SIZE: u64 = 193 * 1024 * 1024;

        let (temp, data, config) = profile().await;
        let pool = crate::db::create_pool(&data.join("macro.db"))
            .await
            .unwrap();
        sqlx::raw_sql(
            "INSERT INTO architect_projects(id,name) VALUES ('project','Systems');
             INSERT INTO architect_legacy_import VALUES (1,0,0);",
        )
        .execute(&pool)
        .await
        .unwrap();
        let storage = Storage::new(&data);
        migration::migrate(&pool, &storage).await.unwrap();
        let folder = temp.path().join("import");
        fs::create_dir_all(folder.join("skill")).unwrap();
        fs::write(
            folder.join("agsdl.json"),
            r#"{"projectFormat":"agsdl-project-1","contract":"agsdl-0.4.0","id":"example","agents":{},"skills":{"example":{"uri":"skill/SKILL.md"}}}"#,
        ).unwrap();
        fs::write(
            folder.join("skill/SKILL.md"),
            "---\nname: example\ndescription: Example\n---\n",
        )
        .unwrap();
        let asset = folder.join("skill/large.bin");
        let file = fs::File::create(&asset).unwrap();
        file.set_len(SIZE).unwrap();
        (&file).write_all(b"Original").unwrap();
        drop(file);
        let candidate = ImportCandidate::open(&folder, &data).unwrap();
        let imported = storage
            .import_project(&pool, "project", "Large import", &candidate)
            .await
            .unwrap();
        drop(candidate);
        let row = storage_index::draft_row(&pool, &imported.draft.summary.id)
            .await
            .unwrap();
        let artifact = storage_index::Artifact::from_row(&row, "id").unwrap();
        let saved_asset = storage
            .artifact_path(&artifact)
            .join("project/skill/large.bin");
        pool.close().await;

        let dir = data.join("local-backup");
        fs::create_dir_all(&dir).unwrap();
        let export = temp.path().join("portable.zip");
        atomic(
            &dir.join("request.json"),
            &serde_json::to_vec(&Request {
                operation: "export".into(),
                path: export.to_string_lossy().into(),
                browser: BTreeMap::new(),
            })
            .unwrap(),
        )
        .unwrap();
        process_startup(&data, &config).await.unwrap();
        let exported = load_archive(&export, &data).unwrap();
        let (name, entry) = exported
            .files
            .iter()
            .find(|(name, _)| name.ends_with("/large.bin"))
            .unwrap();
        assert!(entry.data.is_empty());
        assert_eq!(entry.size(name).unwrap(), SIZE);

        fs::OpenOptions::new()
            .write(true)
            .open(&saved_asset)
            .unwrap()
            .write_all(b"Replaced")
            .unwrap();
        queue_restore(&data, &exported);
        drop(exported);
        fs::remove_file(dir.join("status.json")).unwrap();
        // Interrupt after the incoming backup has been applied.
        fs::create_dir(dir.join("status.json")).unwrap();
        assert!(process_startup(&data, &config).await.is_err());
        let prefix = |path: &Path| {
            let mut bytes = [0; 8];
            fs::File::open(path)
                .unwrap()
                .read_exact(&mut bytes)
                .unwrap();
            bytes
        };
        assert_eq!(&prefix(&saved_asset), b"Original");
        fs::remove_dir(dir.join("status.json")).unwrap();
        process_startup(&data, &config).await.unwrap();
        assert_eq!(&prefix(&saved_asset), b"Replaced");
        assert_eq!(fs::metadata(saved_asset).unwrap().len(), SIZE);
        assert!(!dir.join("restoring.json").exists());
    }

    #[tokio::test]
    async fn architect_library_v45_archive_preserves_legacy_conversation_links() {
        use crate::legacy_agsdl_import::{import_profile, LegacyImportStatus, LegacyLocalStorage};

        let (_temp, data, config) = profile().await;
        let path = data.join("macro.db");
        let mut db = connection(&path).await.unwrap();
        crate::db::operate_inbox::remove_reference_schema(&mut db)
            .await
            .unwrap();
        crate::db::architect_library::remove_reference_schema(&mut db)
            .await
            .unwrap();
        sqlx::raw_sql(
            "DROP TABLE architect_legacy_import; DELETE FROM schema_migrations WHERE version>45;
             INSERT INTO conversations(id,title,scope_mode,created_at,updated_at) VALUES('old-chat','Design','Architect','now','now');
             INSERT INTO architect_plan_conversation_sync(conversation_id,plan_id,target_branch,updated_at)
             VALUES('old-chat','legacy','main','now');",
        )
        .execute(&mut db)
        .await
        .unwrap();
        db.close().await.unwrap();
        let archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        let mut original = connection(&path).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT max(version) FROM schema_migrations")
                .fetch_one(&mut original)
                .await
                .unwrap(),
            45
        );
        sqlx::query("DELETE FROM architect_plan_conversation_sync")
            .execute(&mut original)
            .await
            .unwrap();
        original.close().await.unwrap();

        queue_restore(&data, &archive);
        process_startup(&data, &config).await.unwrap();
        let pool = crate::db::create_pool(&path).await.unwrap();
        let storage = Storage::new(&data);
        crate::architect_library::migration::migrate(&pool, &storage)
            .await
            .unwrap();
        let local = LegacyLocalStorage::Snapshot(BTreeMap::from([(
            "macro_architect_plan:main:legacy".into(),
            serde_json::json!({"id":"legacy","agsdl":{
                "revision":1,"source":"{\"contract\":\"agsdl-0.3.0\"}","annexes":{}
            }})
            .to_string(),
        )]));
        let report = import_profile(&pool, Some(&storage), Ok(vec![data.clone()]), None, local)
            .await
            .unwrap();
        assert_eq!(
            report.status,
            LegacyImportStatus::Complete,
            "{:?}",
            report.issues
        );
        assert_eq!(report.inserted, 1);
        crate::architect_library::migration::startup(&pool, &data)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT conversation_id FROM architect_blueprints")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "old-chat"
        );
    }

    #[tokio::test]
    async fn architect_library_v46_backup_resumes_without_overwriting_an_edited_import() {
        use crate::db::architect_library as library;
        use crate::legacy_agsdl_import::{migrate_profile, LegacyLocalStorage};
        let (_temp, data, config) = profile().await;
        let path = data.join("macro.db");
        let pool = crate::db::create_pool(&path).await.unwrap();
        let local = || {
            LegacyLocalStorage::Snapshot(BTreeMap::from([(
                "macro_architect_plan:main:stable".into(),
                serde_json::json!({"id":"stable","status":"archived","agsdl":{
                    "revision":4,"source":"{\"contract\":\"agsdl-0.3.0\"}","annexes":{}
                }})
                .to_string(),
            )]))
        };
        migrate_profile(&pool, Ok(vec![data.clone()]), None, local())
            .await
            .unwrap();
        let id: String = sqlx::query_scalar("SELECT id FROM architect_blueprints")
            .fetch_one(&pool)
            .await
            .unwrap();
        library::save_draft(
            &pool,
            id.clone(),
            1,
            serde_json::from_value(serde_json::json!({"source":"edited", "annexes":{}})).unwrap(),
        )
        .await
        .unwrap();
        // Reconstruct the pre-marker schema in the disposable profile.
        crate::db::operate_inbox::remove_reference_schema(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
        sqlx::raw_sql(
            "UPDATE architect_blueprints SET conversation_id='old-orphan';
             DROP TABLE architect_legacy_import; DELETE FROM schema_migrations WHERE version IN (47,48,52);",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
        let archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        queue_restore(&data, &archive);
        process_startup(&data, &config).await.unwrap();
        let pool = crate::db::create_pool(&path).await.unwrap();
        let done = migrate_profile(&pool, Ok(vec![data.clone()]), None, local())
            .await
            .unwrap();
        assert_eq!((done.inserted, done.already_imported), (0, 1));
        let draft =
            serde_json::to_value(library::get_draft(&pool, id.clone()).await.unwrap()).unwrap();
        assert_eq!(draft["document"]["source"], "edited");
        assert_eq!(draft["archived"], true);
        assert_eq!(draft["revision"], 2);
        assert_eq!(draft["history"]["legacyConversationId"], "old-orphan");
        let versions = library::list_versions(&pool, id).await.unwrap();
        assert_eq!(versions.len(), 1);
    }

    #[tokio::test]
    async fn pending_restore_defers_updater_until_restored_channel_is_loaded() {
        let (_temp, data, config) = profile().await;
        fs::write(
            data.join("state.json"),
            br#"{"schemaVersion":1,"values":{"updateChannel":"preview"}}"#,
        )
        .unwrap();
        let archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        fs::write(
            data.join("state.json"),
            br#"{"schemaVersion":1,"values":{"updateChannel":"stable"}}"#,
        )
        .unwrap();
        assert!(crate::app_updates::target_matches_persisted_channel(
            &data,
            "stable-windows-x86_64",
            "windows-x86_64"
        )
        .unwrap());
        queue_restore(&data, &archive);
        // This is the updater gate called first at startup: the old Stable
        // preference must not authorize activation before restore validation.
        assert!(!crate::app_updates::target_matches_persisted_channel(
            &data,
            "stable-windows-x86_64",
            "windows-x86_64"
        )
        .unwrap());
        process_startup(&data, &config).await.unwrap();
        assert!(!has_pending_startup_work(&data).unwrap());
        assert!(!crate::app_updates::target_matches_persisted_channel(
            &data,
            "stable-windows-x86_64",
            "windows-x86_64"
        )
        .unwrap());
        assert!(crate::app_updates::target_matches_persisted_channel(
            &data,
            "preview-windows-x86_64",
            "windows-x86_64"
        )
        .unwrap());
        // An interrupted restoration also blocks even without a request file.
        fs::write(data.join("local-backup/restoring.json"), b"interrupted").unwrap();
        assert!(!crate::app_updates::target_matches_persisted_channel(
            &data,
            "preview-windows-x86_64",
            "windows-x86_64"
        )
        .unwrap());
    }

    #[tokio::test]
    async fn restores_valid_archive_over_corrupt_profile_and_preserves_exact_original_bytes() {
        let (_temp, data, config) = profile().await;
        fs::write(
            config.join("runtime.json"),
            br#"{"$schema":"runtime.schema.json","schemaVersion":1}"#,
        )
        .unwrap();
        fs::write(
            data.join("state.json"),
            br#"{"schemaVersion":1,"values":{}}"#,
        )
        .unwrap();
        let archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        for (path, bytes) in [
            (data.join("macro.db"), &b"damaged database"[..]),
            (data.join("macro.db-wal"), &b"damaged wal"[..]),
            (config.join("runtime.json"), &b"{damaged runtime"[..]),
            (data.join("state.json"), &b"damaged state"[..]),
        ] {
            fs::write(path, bytes).unwrap();
        }
        assert!(crate::core::config::test_load_config_from_runtime_file(
            config.join("runtime.json")
        )
        .is_ok());
        queue_restore(&data, &archive);
        process_startup(&data, &config).await.unwrap();
        check_database(&data.join("macro.db")).await.unwrap();
        assert!(crate::core::config::test_load_config_from_runtime_file(
            config.join("runtime.json")
        )
        .is_ok());
        let dir = data.join("local-backup");
        let preserved = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("preserved-")
            })
            .unwrap();
        let raw = load_archive(&preserved, &data).unwrap();
        validate_raw(&raw).unwrap();
        for (name, bytes) in [
            ("data/macro.db", &b"damaged database"[..]),
            ("data/macro.db-wal", &b"damaged wal"[..]),
            ("config/runtime.json", &b"{damaged runtime"[..]),
            ("data/state.json", &b"damaged state"[..]),
        ] {
            assert_eq!(STANDARD.decode(&raw.files[name].data).unwrap(), bytes);
        }
    }
    #[tokio::test]
    async fn preservation_failure_leaves_damaged_current_files_untouched() {
        let (_temp, data, config) = profile().await;
        let archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        fs::write(data.join("macro.db"), b"current damaged bytes").unwrap();
        queue_restore(&data, &archive);
        process_startup_with_preserver(&data, &config, |_, _| {
            Err("Injected preservation write failure".into())
        })
        .await
        .unwrap();
        assert_eq!(
            fs::read(data.join("macro.db")).unwrap(),
            b"current damaged bytes"
        );
        assert!(!data.join("local-backup/restoring.json").exists());
        assert!(fs::read_to_string(data.join("local-backup/status.json"))
            .unwrap()
            .contains("Injected preservation"));
    }
    #[tokio::test]
    async fn rejects_invalid_and_future_native_state_before_replacing_profile() {
        let (_temp, data, config) = profile().await;
        let current = fs::read(data.join("macro.db")).unwrap();
        for bytes in [
            b"not json".as_slice(),
            br#"{"schemaVersion":999,"values":{}}"#.as_slice(),
        ] {
            let mut archive = capture(&data, &config, BTreeMap::new(), true)
                .await
                .unwrap();
            add_file(&mut archive.files, "data/state.json".into(), bytes.to_vec()).unwrap();
            assert!(validate(&archive, &data).await.is_err());
            queue_restore(&data, &archive);
            process_startup(&data, &config).await.unwrap();
            assert_eq!(fs::read(data.join("macro.db")).unwrap(), current);
        }
    }
    #[tokio::test]
    async fn rejects_database_that_cannot_recreate_unique_indexes_before_replacing_profile() {
        let (temp, data, config) = profile().await;
        let current = fs::read(data.join("macro.db")).unwrap();
        let mut archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        let database = temp.path().join("archive.db");
        let entry = archive.files.get_mut("data/macro.db").unwrap();
        fs::write(&database, STANDARD.decode(&entry.data).unwrap()).unwrap();
        let mut db = connection(&database).await.unwrap();
        sqlx::query("DROP INDEX idx_git_repositories_path")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO git_repositories (id, project_id, path, created_at, updated_at) VALUES ('repo-1', 'project-1', '/duplicate', '2026-09-05', '2026-09-05'), ('repo-2', 'project-2', '/duplicate', '2026-09-05', '2026-09-05')")
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
        let bytes = fs::read(database).unwrap();
        entry.sha256 = hash(&bytes);
        entry.data = STANDARD.encode(bytes);

        assert!(validate(&archive, &data).await.is_err());
        queue_restore(&data, &archive);
        process_startup(&data, &config).await.unwrap();

        assert_eq!(fs::read(data.join("macro.db")).unwrap(), current);
        assert!(!data.join("local-backup/restoring.json").exists());
    }

    #[tokio::test]
    async fn rejects_database_with_non_reference_trigger() {
        let (temp, data, config) = profile().await;
        let mut archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        let database = temp.path().join("archive-trigger.db");
        let entry = archive.files.get_mut("data/macro.db").unwrap();
        fs::write(&database, STANDARD.decode(&entry.data).unwrap()).unwrap();
        let mut db = connection(&database).await.unwrap();
        sqlx::query(
            "CREATE TRIGGER unexpected_backup_trigger AFTER INSERT ON settings BEGIN SELECT 1; END",
        )
        .execute(&mut db)
        .await
        .unwrap();
        db.close().await.unwrap();
        let bytes = fs::read(database).unwrap();
        entry.sha256 = hash(&bytes);
        entry.data = STANDARD.encode(bytes);

        let error = validate(&archive, &data)
            .await
            .expect_err("reject extra trigger");
        assert!(error.contains("schema objects do not match"));
    }

    #[tokio::test]
    async fn rejects_database_with_modified_message_search_definition() {
        let (temp, data, config) = profile().await;
        let mut archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        let database = temp.path().join("archive-modified-search.db");
        let entry = archive.files.get_mut("data/macro.db").unwrap();
        fs::write(&database, STANDARD.decode(&entry.data).unwrap()).unwrap();
        let mut db = connection(&database).await.unwrap();
        sqlx::query("DROP TABLE message_search")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query(
            "CREATE VIRTUAL TABLE message_search USING fts5(content, content = 'messages', content_rowid = 'rowid', tokenize = 'porter')",
        )
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO message_search(message_search) VALUES ('rebuild')")
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
        let bytes = fs::read(database).unwrap();
        entry.sha256 = hash(&bytes);
        entry.data = STANDARD.encode(bytes);

        let error = validate(&archive, &data)
            .await
            .expect_err("reject modified FTS definition");
        assert!(error.contains("schema objects do not match"));
    }
    #[tokio::test]
    async fn sqlite_wal_snapshot_includes_committed_rows_and_removes_credentials() {
        let (_temp, data, _config) = profile().await;
        let pool = crate::db::create_pool(&data.join("macro.db"))
            .await
            .unwrap();
        sqlx::query("UPDATE provider_configs SET api_key='portable-secret-sentinel'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE conversations SET title='WAL committed'")
            .execute(&pool)
            .await
            .unwrap();
        let target = data.join("snapshot.db");
        snapshot_database(&data.join("macro.db"), &target, true)
            .await
            .unwrap();
        let bytes = fs::read(&target).unwrap();
        assert!(!bytes.windows(24).any(|v| v == b"portable-secret-sentinel"));
        let mut db = connection(&target).await.unwrap();
        let title: String =
            sqlx::query_scalar("SELECT title FROM conversations WHERE id='conversation'")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(title, "WAL committed");
        pool.close().await;
    }

    #[tokio::test]
    async fn user_raw_restore_scrubs_provider_auth_but_preserves_raw_rollback() {
        let (temp, data, config) = profile().await;
        let pool = crate::db::create_pool(&data.join("macro.db"))
            .await
            .unwrap();
        crate::db::repository::upsert_provider_config_by_id(
            &pool,
            "synthetic-provider",
            "Synthetic provider",
            "openai",
            "https://current.invalid/v1",
            false,
        )
        .await
        .unwrap();
        sqlx::query(
            r#"
            UPDATE provider_configs
            SET api_key = 'portable-secret-sentinel',
                has_stored_api_key = 1,
                auth_status = 'authenticated',
                auth_source = 'oauth',
                token_expires_at = '2099-01-01T00:00:00Z'
            WHERE id = 'synthetic-provider'
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        // This fixture captures raw SQLite files immediately after closing the pool.
        let (busy, _, _): (i64, i64, i64) = sqlx::query_as("PRAGMA wal_checkpoint(TRUNCATE)")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(busy, 0);
        pool.close().await;

        let provider_document = |base_url: &str, sentinel: &str| {
            serde_json::json!({
                "$schema": "providers.schema.json",
                "schemaVersion": 1,
                "providers": {
                    "synthetic-provider": {
                        "providerType": "openai",
                        "name": "Synthetic provider",
                        "enabled": false,
                        "baseUrl": base_url,
                        "isLocal": false,
                        "options": {
                            "apiKey": sentinel,
                            "headers": { "Authorization": sentinel },
                            "env": { "SYNTHETIC_TOKEN": sentinel }
                        }
                    }
                }
            })
        };
        let approved_dir = config.join(".runtime/approved/user");
        let pending_dir = config.join(".runtime/pending/user");
        fs::create_dir_all(&approved_dir).unwrap();
        fs::create_dir_all(&pending_dir).unwrap();
        fs::write(
            config.join("providers.json"),
            serde_json::to_vec(&provider_document(
                "https://current.invalid/v1",
                "active-secret-sentinel",
            ))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            approved_dir.join("providers.json"),
            serde_json::to_vec(&provider_document(
                "https://approved.invalid/v1",
                "approved-secret-sentinel",
            ))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            pending_dir.join("providers.json"),
            serde_json::to_vec(&provider_document(
                "https://pending.invalid/v1",
                "pending-secret-sentinel",
            ))
            .unwrap(),
        )
        .unwrap();

        let raw = capture_raw(&data, &config, BTreeMap::new()).unwrap();
        let raw_path = temp.path().join("raw-profile.json");
        preserve_raw(&raw, &raw_path).unwrap();

        let portable = load_restore_archive(&raw_path, &data).await.unwrap();
        let portable_db = temp.path().join("portable.db");
        fs::write(
            &portable_db,
            STANDARD
                .decode(&portable.files["data/macro.db"].data)
                .unwrap(),
        )
        .unwrap();
        let mut portable_connection = connection(&portable_db).await.unwrap();
        let portable_auth: (
            Option<String>,
            i64,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = sqlx::query_as(
            r#"
                SELECT api_key, has_stored_api_key, auth_status, auth_source, token_expires_at
                FROM provider_configs
                WHERE id = 'synthetic-provider'
                "#,
        )
        .fetch_one(&mut portable_connection)
        .await
        .unwrap();
        assert_eq!(portable_auth, (None, 0, None, None, None));
        portable_connection.close().await.unwrap();

        assert!(!portable
            .files
            .contains_key("config/.runtime/pending/user/providers.json"));
        for name in [
            "config/providers.json",
            "config/.runtime/approved/user/providers.json",
        ] {
            let bytes = STANDARD.decode(&portable.files[name].data).unwrap();
            assert_eq!(portable.files[name].sha256, hash(&bytes));
            let document: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(
                document.pointer("/providers/synthetic-provider/baseUrl"),
                Some(&serde_json::json!("https://approved.invalid/v1"))
            );
            assert!(document
                .pointer("/providers/synthetic-provider/options/apiKey")
                .is_none());
            assert_eq!(
                document.pointer("/providers/synthetic-provider/options/headers"),
                Some(&serde_json::json!({}))
            );
            assert_eq!(
                document.pointer("/providers/synthetic-provider/options/env"),
                Some(&serde_json::json!({}))
            );
        }

        let (_rollback_temp, rollback_data, rollback_config) = profile().await;
        apply_files(&raw, &rollback_data, &rollback_config, true).unwrap();
        let mut rollback_connection = connection(&rollback_data.join("macro.db")).await.unwrap();
        let rollback_auth: (
            Option<String>,
            i64,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = sqlx::query_as(
            r#"
                SELECT api_key, has_stored_api_key, auth_status, auth_source, token_expires_at
                FROM provider_configs
                WHERE id = 'synthetic-provider'
                "#,
        )
        .fetch_one(&mut rollback_connection)
        .await
        .unwrap();
        assert_eq!(
            rollback_auth,
            (
                Some("portable-secret-sentinel".to_string()),
                1,
                Some("authenticated".to_string()),
                Some("oauth".to_string()),
                Some("2099-01-01T00:00:00Z".to_string())
            )
        );
        rollback_connection.close().await.unwrap();

        for (path, expected_url, expected_secret) in [
            (
                rollback_config.join("providers.json"),
                "https://current.invalid/v1",
                "active-secret-sentinel",
            ),
            (
                rollback_config.join(".runtime/approved/user/providers.json"),
                "https://approved.invalid/v1",
                "approved-secret-sentinel",
            ),
            (
                rollback_config.join(".runtime/pending/user/providers.json"),
                "https://pending.invalid/v1",
                "pending-secret-sentinel",
            ),
        ] {
            let document: serde_json::Value =
                serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
            assert_eq!(
                document.pointer("/providers/synthetic-provider/baseUrl"),
                Some(&serde_json::json!(expected_url))
            );
            assert_eq!(
                document.pointer("/providers/synthetic-provider/options/apiKey"),
                Some(&serde_json::json!(expected_secret))
            );
            assert_eq!(
                document.pointer("/providers/synthetic-provider/options/headers/Authorization"),
                Some(&serde_json::json!(expected_secret))
            );
            assert_eq!(
                document.pointer("/providers/synthetic-provider/options/env/SYNTHETIC_TOKEN"),
                Some(&serde_json::json!(expected_secret))
            );
        }
    }

    #[tokio::test]
    async fn connect_transfer_restore_preserves_raw_prefix_and_import_lease_before_ready() {
        let (_temp, data, config) = profile().await;
        let path = data.join("macro.db");
        let mut db = connection(&path).await.unwrap();
        // Incomplete opaque storage is preserved; no ready/pin or producer
        // authority is claimed by this synthetic backup fixture.
        sqlx::raw_sql("INSERT INTO e_inactive_domain VALUES(1,1048576,64);
            INSERT INTO e_inactive_imports VALUES(1,printf('%064d',1),'{}',0,0,0,2,512,0,0,1,1,0,NULL);
            INSERT INTO e_inactive_records VALUES(1,0,'{}',0,NULL,NULL,NULL,NULL,2,1,x'',x'');
            INSERT INTO e_inactive_fragments VALUES(1,0,0,zeroblob(32),x'6162',2,2,1);
            INSERT INTO connect_transfers(transfer_id,local_role,relay_origin,account_id,source_instance_id,source_conversation_id,source_epoch,target_instance_id,source_generation,target_generation,binding_digest,binding_json,expectation_json,reserve_request,fingerprint,inactive_import_id,phase,charge_bytes)
              VALUES('00000000-0000-4000-8000-000000000001','target','https://relay.invalid','account','source','conversation',1,'target','sg','tg',zeroblob(32),x'7b7d',x'7b7d',x'7b7d',zeroblob(32),1,'receiving',512);
            INSERT INTO connect_raw_prefix VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','tg',x'7b7d',zeroblob(32),4,1,2,0,512);
            INSERT INTO connect_raw_chunks VALUES('00000000-0000-4000-8000-000000000001',0,0,zeroblob(32),x'6162',0,256);")
            .execute(&mut db).await.unwrap();
        db.close().await.unwrap();
        let archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        validate(&archive, &data).await.unwrap();
        queue_restore(&data, &archive);
        process_startup(&data, &config).await.unwrap();
        let mut db = connection(&path).await.unwrap();
        let held: (i64, String, i64) =
            sqlx::query_as("SELECT restore_hold,phase,inactive_import_id FROM connect_transfers")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(held, (1, "reconciliation_required".into(), 1));
        let prefix: (i64, i64, i64) =
            sqlx::query_as("SELECT next_sequence,next_offset,eof FROM connect_raw_prefix")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(prefix, (1, 2, 0));
        assert_eq!(
            sqlx::query_scalar::<_, Vec<u8>>("SELECT data FROM connect_raw_chunks")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            b"ab"
        );
        assert!(sqlx::query("DELETE FROM e_inactive_fragments")
            .execute(&mut db)
            .await
            .is_err());
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT mode FROM chat_admission_owners WHERE conversation_id='conversation'"
            )
            .fetch_one(&mut db)
            .await
            .unwrap(),
            "restore_hold"
        );
        db.close().await.unwrap();
    }
}

#[cfg(test)]
#[path = "local_backup_qualification.rs"]
mod qualification;

#[cfg(test)]
#[path = "local_backup_secrets_qualification.rs"]
mod secrets_qualification;

#[cfg(test)]
mod content_backup_tests {
    use super::*;
    async fn strip_content(db: &mut SqliteConnection) {
        tests::remove_post_catalog_schema(db).await;
        crate::db::conversation_catalog::remove_reference_schema_in(db)
            .await
            .unwrap();
        sqlx::query("DELETE FROM schema_migrations WHERE version=14")
            .execute(&mut *db)
            .await
            .unwrap();
        let names:Vec<String>=sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'content_versions_*'").fetch_all(&mut *db).await.unwrap();
        for name in names {
            sqlx::query(sqlx::AssertSqlSafe(format!("DROP TRIGGER {name}")))
                .execute(&mut *db)
                .await
                .unwrap();
        }
        sqlx::raw_sql("DROP TABLE conversation_content_versions; DELETE FROM schema_migrations WHERE version=13").execute(db).await.unwrap();
    }
    #[tokio::test]
    async fn pre13_archive_validation_preserves_original_then_migrates_only_copy() {
        let (temp, data, _config) = tests::profile().await;
        let original = data.join("macro.db");
        let mut db = connection(&original).await.unwrap();
        strip_content(&mut db).await;
        db.close().await.unwrap();
        let before = fs::read(&original).unwrap();
        check_database(&original).await.unwrap();
        assert_eq!(fs::read(&original).unwrap(), before);
        let copy = temp.path().join("migration-copy.db");
        fs::copy(&original, &copy).unwrap();
        check_database_startup(&copy).await.unwrap();
        check_database(&copy).await.unwrap();
        let mut db = connection(&copy).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT MAX(version) FROM schema_migrations")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            crate::db::operate_inbox::DELETE_SCHEMA_VERSION
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM conversation_content_versions")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            1
        );
        db.close().await.unwrap();
        assert_eq!(fs::read(&original).unwrap(), before);
    }
    #[tokio::test]
    async fn schema13_rejects_missing_unknown_and_modified_objects() {
        for mutation in [
            "DROP TRIGGER content_versions_messages_insert",
            "DROP TABLE conversation_content_versions",
            "CREATE TRIGGER content_versions_unexpected AFTER INSERT ON settings BEGIN SELECT 1; END",
            "CREATE TRIGGER unrelated_unexpected AFTER INSERT ON settings BEGIN SELECT 1; END",
            "PRAGMA writable_schema=ON; UPDATE sqlite_master SET sql=replace(sql, 'AND revision >= 0', 'AND revision >= -1') WHERE name='conversation_content_versions'; PRAGMA writable_schema=OFF; PRAGMA schema_version=999",
            "DELETE FROM schema_migrations WHERE version=13",
            "UPDATE schema_migrations SET name='wrong' WHERE version=13",
        ] {
            let (_temp,data,_config)=tests::profile().await;
            let path=data.join("macro.db");
            let mut db=connection(&path).await.unwrap();
            tests::remove_post_catalog_schema(&mut db).await;
            crate::db::conversation_catalog::remove_reference_schema_in(&mut db).await.unwrap();
            sqlx::query("DELETE FROM schema_migrations WHERE version=14").execute(&mut db).await.unwrap();
            sqlx::raw_sql(mutation).execute(&mut db).await.unwrap(); db.close().await.unwrap();
            let before=fs::read(&path).unwrap();
            assert!(check_database(&path).await.is_err(),"accepted {mutation}");
            assert_eq!(fs::read(&path).unwrap(),before);
        }
    }
}

#[cfg(test)]
mod content_legacy_backup_tests {
    use super::*;
    #[tokio::test]
    async fn restore_reconciles_linked_running_goal_before_hold_and_keeps_foreign_goal_writable() {
        let (_temp, data, config) = tests::profile().await;
        let path = data.join("macro.db");
        let mut db = connection(&path).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA recursive_triggers")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA trusted_schema")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            1
        );
        sqlx::raw_sql("INSERT INTO conversations(id,title,scope_mode,project_id,created_at,updated_at) VALUES('foreign','Foreign','Chat','project','t','t');
            INSERT INTO agent_runs(id,parent_conversation_id,agent_profile,depth,status,prompt,attempt_count,created_at,updated_at,started_at) VALUES('run','conversation','synthetic',1,'running','Synthetic',1,'t','t','t');
            INSERT INTO conversation_goals(goal_id,conversation_id,revision,objective,success_criteria_json,status,created_at,updated_at) VALUES('goal','conversation',1,'Synthetic','[]','auditing','t','t'),('foreign-goal','foreign',1,'Other','[]','active_ready','t','t');
            INSERT INTO conversation_goal_audits(audit_id,conversation_id,goal_id,goal_revision,executor_turn_id,current_run_id,status,created_at,updated_at) VALUES('audit','conversation','goal',1,'turn','run','running','t','t');
            INSERT INTO conversation_goal_audit_runs(audit_id,run_id,attempt,linked_at) VALUES('audit','run',1,'t');")
            .execute(&mut db).await.unwrap();
        db.close().await.unwrap();
        let archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        tests::queue_restore(&data, &archive);
        process_startup(&data, &config).await.unwrap();
        let status: BackupStatus =
            serde_json::from_slice(&fs::read(data.join("local-backup/status.json")).unwrap())
                .unwrap();
        assert_eq!(status.code, Some(BackupStatusCode::Restored));
        let pool = crate::db::create_pool(&path).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT status FROM agent_runs WHERE id='run'")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "interrupted"
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT status FROM conversation_goals WHERE goal_id='goal'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            "paused"
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT mode FROM chat_admission_owners WHERE conversation_id='conversation'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            "restore_hold"
        );
        // These are the same official init_db reconcilers, now idempotent after
        // restore installed its hold. No ordinary writer is opened afterward.
        assert_eq!(
            crate::db::agent_runs::reconcile_active_agent_runs_after_restart(&pool)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            crate::db::conversation_goals::reconcile_audits_after_restart(&pool)
                .await
                .unwrap(),
            0
        );
        crate::db::tool_invocations::reconcile_pending_after_restart(&pool)
            .await
            .unwrap();
        crate::db::chat_admission::reconcile_after_restart(&pool)
            .await
            .unwrap();
        let owner = crate::core::db_state::DbPool::default();
        owner.set_ready(pool.clone()).await.unwrap();
        sqlx::query(
            "UPDATE conversation_goals SET objective='Still writable' WHERE goal_id='foreign-goal'",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert!(sqlx::query(
            "UPDATE conversation_goals SET objective='forbidden' WHERE goal_id='goal'"
        )
        .execute(&pool)
        .await
        .is_err());
        owner.set_initializing().await;
        pool.close().await;
    }

    #[tokio::test]
    async fn exact_v15_v16_restore_preserves_inactive_bytes_and_holds_chat_before_ready() {
        for version in [15, 16] {
            let (_temp, data, config) = tests::profile().await;
            let path = data.join("macro.db");
            let mut db = connection(&path).await.unwrap();
            crate::db::migration_tests::drop_agsdl(&mut db).await;
            crate::db::chat_admission::remove_reference_schema_in(&mut db)
                .await
                .unwrap();
            remove_reference_e_schema(&mut db, &(1..=version).collect::<Vec<_>>())
                .await
                .unwrap();
            sqlx::query("DELETE FROM schema_migrations WHERE version>?")
                .bind(version)
                .execute(&mut db)
                .await
                .unwrap();
            // These are opaque stored bytes, not a portable-semantic fixture or
            // an authority to open E. Backup must preserve even an incomplete import.
            sqlx::raw_sql("INSERT INTO e_inactive_domain VALUES(1,1048576,8);
                INSERT INTO e_inactive_imports VALUES(1,printf('%064d',1),'{}',0,0,0,7,512,1,1,10000,1000,1,NULL);
                INSERT INTO e_inactive_records VALUES(1,0,'{}',0,NULL,NULL,NULL,NULL,7,0,x'',x'');
                INSERT INTO e_inactive_fragments VALUES(1,0,0,zeroblob(32),x'00010203feff00',7,7,1);")
                .execute(&mut db).await.unwrap();
            let source_version: Option<(String, i64)> = if version == 16 {
                Some(
                    sqlx::query_as(
                        "SELECT incarnation,revision FROM e_source_version WHERE singleton=1",
                    )
                    .fetch_one(&mut db)
                    .await
                    .unwrap(),
                )
            } else {
                None
            };
            db.close().await.unwrap();
            let before = fs::read(&path).unwrap();
            check_database(&path).await.unwrap();
            assert_eq!(fs::read(&path).unwrap(), before);
            let archive = capture(&data, &config, BTreeMap::new(), true)
                .await
                .unwrap();
            tests::queue_restore(&data, &archive);
            process_startup(&data, &config).await.unwrap();
            let status: BackupStatus =
                serde_json::from_slice(&fs::read(data.join("local-backup/status.json")).unwrap())
                    .unwrap();
            assert_eq!(status.code, Some(BackupStatusCode::Restored));
            let pool = crate::db::create_pool(&path).await.unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT MAX(version) FROM schema_migrations")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                crate::db::operate_inbox::DELETE_SCHEMA_VERSION
            );
            assert_eq!(
                sqlx::query_scalar::<_, String>(
                    "SELECT mode FROM chat_admission_owners WHERE conversation_id='conversation'"
                )
                .fetch_one(&pool)
                .await
                .unwrap(),
                "restore_hold"
            );
            assert_eq!(
                sqlx::query_scalar::<_, Vec<u8>>(
                    "SELECT data FROM e_inactive_fragments WHERE import_id=1"
                )
                .fetch_one(&pool)
                .await
                .unwrap(),
                vec![0, 1, 2, 3, 254, 255, 0]
            );
            assert_eq!(
                sqlx::query_scalar::<_, String>(
                    "SELECT begin_json FROM e_inactive_imports WHERE id=1"
                )
                .fetch_one(&pool)
                .await
                .unwrap(),
                "{}"
            );
            assert_eq!(
                crate::db::repository::list_messages(&pool, "conversation")
                    .await
                    .unwrap()[0]
                    .content,
                "Representative transcript"
            );
            if let Some(expected) = source_version {
                assert_eq!(
                    sqlx::query_as::<_, (String, i64)>(
                        "SELECT incarnation,revision FROM e_source_version WHERE singleton=1"
                    )
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                    expected
                );
            }
            let owner = crate::core::db_state::DbPool::default();
            owner.set_ready(pool.clone()).await.unwrap();
            assert!(
                sqlx::query("UPDATE messages SET content='forbidden' WHERE id='message'")
                    .execute(&pool)
                    .await
                    .is_err()
            );
            assert_eq!(
                crate::db::inactive_storage::InactiveStorage::closed(pool.clone())
                    .begin(b"{}")
                    .await
                    .unwrap_err(),
                "inactive_storage_disabled"
            );
            owner.set_initializing().await;
            pool.close().await;
        }
    }

    #[tokio::test]
    async fn exact_v5_v9_and_v12_archives_validate_before_copy_migration() {
        for version in [5, 9, 12] {
            let (temp, data, _config) = tests::profile().await;
            let original = data.join("macro.db");
            let mut db = connection(&original).await.unwrap();
            tests::remove_post_catalog_schema(&mut db).await;
            crate::db::conversation_catalog::remove_reference_schema_in(&mut db)
                .await
                .unwrap();
            let names:Vec<String>=sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'content_versions_*'").fetch_all(&mut db).await.unwrap();
            for name in names {
                sqlx::query(sqlx::AssertSqlSafe(format!("DROP TRIGGER {name}")))
                    .execute(&mut db)
                    .await
                    .unwrap();
            }
            sqlx::query("DROP TABLE conversation_content_versions")
                .execute(&mut db)
                .await
                .unwrap();
            if version < 12 {
                for statement in [
                    "DROP TABLE pilot_file_chunks",
                    "DROP TABLE pilot_file_sends",
                    "DROP TABLE pilot_message_attachments",
                    "DROP TABLE pilot_file_transfers",
                    "DROP TABLE pilot_file_sources",
                    "DROP TABLE pilot_file_binding_history",
                    "DROP TABLE pilot_file_authorities",
                    "DROP TRIGGER conversation_management_insert",
                    "DROP TRIGGER conversation_management_update",
                    "DROP TRIGGER conversation_response_insert",
                    "DROP TRIGGER conversation_response_update",
                    "DROP TABLE conversation_response_versions",
                    "DROP TABLE conversation_action_receipts",
                    "DROP TABLE conversation_management",
                    "DROP TRIGGER messages_tool_trace_revision_insert",
                    "DROP TRIGGER messages_tool_trace_revision_delete",
                    "DROP TRIGGER messages_tool_trace_revision_update_same_conversation",
                    "DROP TRIGGER messages_tool_trace_revision_update_conversation",
                    "DROP TABLE conversation_tool_trace_revisions",
                ] {
                    sqlx::query(statement).execute(&mut db).await.unwrap();
                }
            }
            if version == 5 {
                for statement in [
                    "DROP TRIGGER conversation_goal_audit_run_status",
                    "DROP TABLE conversation_goal_audit_runs",
                    "DROP TABLE conversation_goal_audits",
                    "DROP TABLE conversation_goals",
                    "DROP TABLE agent_run_transitions",
                    "DROP TABLE tool_invocations",
                    "ALTER TABLE messages DROP COLUMN generation_attempts_json",
                ] {
                    sqlx::query(statement).execute(&mut db).await.unwrap();
                }
            }
            sqlx::query("DELETE FROM schema_migrations WHERE version > ?")
                .bind(version)
                .execute(&mut db)
                .await
                .unwrap();
            db.close().await.unwrap();
            let before = fs::read(&original).unwrap();
            check_database(&original).await.unwrap();
            assert_eq!(fs::read(&original).unwrap(), before);
            let copy = temp.path().join("copy.db");
            fs::copy(&original, &copy).unwrap();
            check_database_startup(&copy).await.unwrap();
            check_database(&copy).await.unwrap();
            let pool = crate::db::create_pool(&copy).await.unwrap();
            assert_eq!(
                crate::db::repository::list_messages(&pool, "conversation")
                    .await
                    .unwrap()[0]
                    .content,
                "Representative transcript"
            );
            pool.close().await;
            assert_eq!(fs::read(&original).unwrap(), before);
        }
    }
}

#[cfg(test)]
mod catalog_backup_tests {
    use super::*;
    use crate::commands::conversation_catalog::version;
    use crate::core::db_state::DbPool;
    use crate::db::models::ConversationCatalogVersionInput;
    #[tokio::test]
    async fn exact_schema13_is_untouched_then_only_copy_migrates_to_current() {
        let (temp, data, _config) = tests::profile().await;
        let original = data.join("macro.db");
        let mut db = connection(&original).await.unwrap();
        tests::remove_post_catalog_schema(&mut db).await;
        crate::db::conversation_catalog::remove_reference_schema_in(&mut db)
            .await
            .unwrap();
        sqlx::query("DELETE FROM schema_migrations WHERE version=14")
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
        let before = fs::read(&original).unwrap();
        check_database(&original).await.unwrap();
        assert_eq!(fs::read(&original).unwrap(), before);
        let copy = temp.path().join("copy.db");
        fs::copy(&original, &copy).unwrap();
        check_database_startup(&copy).await.unwrap();
        check_database(&copy).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT MAX(version) FROM schema_migrations")
                .fetch_one(&mut connection(&copy).await.unwrap())
                .await
                .unwrap(),
            crate::db::operate_inbox::DELETE_SCHEMA_VERSION
        );
        assert_eq!(fs::read(&original).unwrap(), before);
    }
    #[tokio::test]
    async fn schema14_archive_rejects_missing_altered_or_undeclared_catalog() {
        for mutation in [
            "DROP TRIGGER catalog_version_conversations_insert",
            "DROP TABLE conversation_catalog_version",
            "DELETE FROM conversation_catalog_version",
            "DELETE FROM schema_migrations WHERE version=14",
            "UPDATE schema_migrations SET name='wrong' WHERE version=14",
            "DELETE FROM schema_migrations WHERE version=13",
            "CREATE TRIGGER catalog_version_extra AFTER INSERT ON conversations BEGIN SELECT 1; END",
            "PRAGMA writable_schema=ON; UPDATE sqlite_master SET sql=replace(sql,'AND revision >= 0','AND revision >= -1') WHERE name='conversation_catalog_version'; PRAGMA writable_schema=OFF; PRAGMA schema_version=999",
        ] {
            let (_temp,data,_config)=tests::profile().await;let path=data.join("macro.db");
            let mut db=connection(&path).await.unwrap();sqlx::raw_sql(mutation).execute(&mut db).await.unwrap();db.close().await.unwrap();
            let before=fs::read(&path).unwrap();assert!(check_database(&path).await.is_err(),"accepted {mutation}");assert_eq!(fs::read(&path).unwrap(),before);
        }
    }
    #[tokio::test]
    async fn supported_startup_restore_keeps_durable_token_and_retires_old_generation() {
        let (_temp, data, config) = tests::profile().await;
        let path = data.join("macro.db");
        let owner = DbPool::default();
        let pool = crate::db::create_pool(&path).await.unwrap();
        owner.set_ready(pool.clone()).await.unwrap();
        let old = version(&owner, ConversationCatalogVersionInput::default())
            .await
            .unwrap();
        owner.set_initializing().await;
        pool.close().await;
        let archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        let mut db = connection(&path).await.unwrap();
        sqlx::query("UPDATE conversations SET title='new'")
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
        tests::queue_restore(&data, &archive);
        process_startup(&data, &config).await.unwrap();
        let status: BackupStatus =
            serde_json::from_slice(&fs::read(data.join("local-backup/status.json")).unwrap())
                .unwrap();
        assert_eq!(status.code, Some(BackupStatusCode::Restored));
        let pool = crate::db::create_pool(&path).await.unwrap();
        owner.set_ready(pool.clone()).await.unwrap();
        let restored = version(&owner, ConversationCatalogVersionInput::default())
            .await
            .unwrap();
        assert_eq!(old.incarnation, restored.incarnation);
        assert_eq!(old.revision, restored.revision);
        assert_ne!(old.generation, restored.generation);
        assert_eq!(
            version(
                &owner,
                ConversationCatalogVersionInput {
                    expected_token: Some(old)
                }
            )
            .await
            .unwrap_err()
            .message,
            "stale_revision"
        );
        pool.close().await;
    }

    #[tokio::test]
    async fn connect_backup_accepts_original_migration_stamps_without_an_agsdl_ledger() {
        let (_temp, data, _config) = tests::profile().await;
        let path = data.join("macro.db");
        let mut db = connection(&path).await.unwrap();
        crate::db::migration_tests::drop_agsdl(&mut db).await;
        sqlx::raw_sql(
            "DROP TABLE migration_identity_history;
             UPDATE schema_migrations SET version=20, name='020_connect_archive_lifecycle' WHERE version=43;
             UPDATE schema_migrations SET version=21, name='021_connect_target_abort' WHERE version=44;
             UPDATE schema_migrations SET version=22, name='022_connect_target_activation' WHERE version=45;",
        )
        .execute(&mut db)
        .await
        .unwrap();
        db.close().await.unwrap();

        check_database(&path).await.unwrap();
        let pool = crate::db::create_pool(&path).await.unwrap();
        let stamps: Vec<(i64, String)> =
            sqlx::query_as("SELECT version,name FROM migration_identity_history ORDER BY version")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(
            stamps,
            [
                (20, "020_connect_archive_lifecycle".into()),
                (21, "021_connect_target_abort".into()),
                (22, "022_connect_target_activation".into()),
            ]
        );
        pool.close().await;
        check_database(&path).await.unwrap();
    }

    #[tokio::test]
    async fn connect_publication_backup_accepts_exact_pre019_and_rejects_missing019_guard() {
        let (_temp, data, _config) = tests::profile().await;
        let path = data.join("macro.db");
        let mut connection = connection(&path).await.unwrap();
        crate::db::connect_transfer::remove_publication_reference_in(&mut connection)
            .await
            .unwrap();
        sqlx::query("DELETE FROM schema_migrations WHERE version IN (19,43,44,45)")
            .execute(&mut connection)
            .await
            .unwrap();
        connection.close().await.unwrap();
        check_database(&path).await.unwrap();
        let pool = crate::db::create_pool(&path).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT MAX(version) FROM schema_migrations")
                .fetch_one(&pool)
                .await
                .unwrap(),
            crate::db::operate_inbox::DELETE_SCHEMA_VERSION
        );
        sqlx::query("DROP TRIGGER connect_preparation_metadata")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        assert!(check_database(&path).await.is_err());
    }
    #[tokio::test]
    async fn engine_snapshot_constraint_tampering_is_rejected() {
        let (_temp, data, _config) = tests::profile().await;
        let path = data.join("macro.db");
        let mut db = connection(&path).await.unwrap();
        sqlx::query("PRAGMA writable_schema=ON")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query("UPDATE sqlite_master SET sql = replace(sql, 'CHECK(json_valid(state_json))', '') WHERE name='engine_flow030_runs'").execute(&mut db).await.unwrap();
        sqlx::query("PRAGMA writable_schema=OFF")
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
        assert!(check_database(&path)
            .await
            .unwrap_err()
            .contains("constraints"));
    }

    #[tokio::test]
    async fn tool_result_constraint_tampering_is_rejected() {
        let (_temp, data, _config) = tests::profile().await;
        let path = data.join("macro.db");
        let mut db = connection(&path).await.unwrap();
        sqlx::query("PRAGMA writable_schema=ON")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query("UPDATE sqlite_master SET sql = replace(sql, 'CHECK (result_json IS NULL OR json_valid(result_json))', '') WHERE name='tool_invocations'").execute(&mut db).await.unwrap();
        sqlx::query("PRAGMA writable_schema=OFF")
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
        assert!(check_database(&path)
            .await
            .unwrap_err()
            .contains("constraints"));
    }
    #[tokio::test]
    async fn protocol017_backup_validation_accepts_v16_and_rejects_missing_current_table() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("protocol-backup.db");
        let pool = crate::db::create_pool(&path).await.unwrap();
        pool.close().await;
        check_database(&path).await.unwrap();
        let mut db = connection(&path).await.unwrap();
        crate::db::migration_tests::drop_human_public(&mut db).await;
        sqlx::query("DROP TABLE engine_human_works030")
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
        assert!(check_database(&path).await.is_err());
        let mut db = connection(&path).await.unwrap();
        sqlx::raw_sql(
            "DROP TABLE engine_work_admission030;
            DROP TABLE engine_human_link_events030;
            DROP TABLE engine_human_requests030;
            DROP TABLE engine_work_checks030;
            DROP TABLE engine_work_events030;
            DROP TABLE engine_work_protocol030;
            DELETE FROM schema_migrations WHERE version IN (27,28);",
        )
        .execute(&mut db)
        .await
        .unwrap();
        db.close().await.unwrap();
        check_database(&path).await.unwrap();
        let pool = crate::db::create_pool(&path).await.unwrap();
        pool.close().await;
        check_database(&path).await.unwrap();
    }

    #[tokio::test]
    async fn admission018_backup_rejects_missing_current_table_and_accepts_v17() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("admission-backup.db");
        let pool = crate::db::create_pool(&path).await.unwrap();
        pool.close().await;
        check_database(&path).await.unwrap();
        let mut db = connection(&path).await.unwrap();
        crate::db::migration_tests::drop_human_public(&mut db).await;
        sqlx::query("DROP TABLE engine_work_admission030")
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
        assert!(check_database(&path).await.is_err());
        let mut db = connection(&path).await.unwrap();
        sqlx::query("DELETE FROM schema_migrations WHERE version=28")
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
        check_database(&path).await.unwrap();
        let pool = crate::db::create_pool(&path).await.unwrap();
        pool.close().await;
        check_database(&path).await.unwrap();
    }

    #[tokio::test]
    async fn native_flow030_exact_state_survives_export_and_restore() {
        let (temp, data, config) = tests::profile().await;
        let mut db = connection(&data.join("macro.db")).await.unwrap();
        let options = r#"{ "budget":9007199254740993, "limit":1.0 }"#;
        let evidence = r#"{ "lock":"synthetic" }"#;
        sqlx::query(
            "INSERT INTO engine_flow030_runs VALUES ('run','flow','snapshot','epoch','{}',?,?)",
        )
        .bind(options)
        .bind(evidence)
        .execute(&mut db)
        .await
        .unwrap();
        db.close().await.unwrap();
        let dir = data.join("local-backup");
        fs::create_dir_all(&dir).unwrap();
        let path = temp.path().join("admission-export.json");
        atomic(
            &dir.join("request.json"),
            &serde_json::to_vec(&Request {
                operation: "export".into(),
                path: path.to_string_lossy().into(),
                browser: BTreeMap::new(),
            })
            .unwrap(),
        )
        .unwrap();
        process_startup(&data, &config).await.unwrap();
        let archive = load_archive(&path, &data).unwrap();
        validate(&archive, &data).await.unwrap();
        let mut db = connection(&data.join("macro.db")).await.unwrap();
        sqlx::query("UPDATE engine_flow030_runs SET state_json='{}'")
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
        tests::queue_restore(&data, &archive);
        process_startup(&data, &config).await.unwrap();
        let mut restored = connection(&data.join("macro.db")).await.unwrap();
        let row: (String, String) = sqlx::query_as(
            "SELECT plan_json,state_json FROM engine_flow030_runs WHERE system_id='run'",
        )
        .fetch_one(&mut restored)
        .await
        .unwrap();
        assert_eq!(row, (options.to_owned(), evidence.to_owned()));
    }

    #[tokio::test]
    async fn historical_execution_archive_restores_then_retires_legacy_admission() {
        let (temp, target_data, config) = tests::profile().await;
        let old_data = temp.path().join("old-data");
        fs::create_dir_all(&old_data).unwrap();
        let mut old = crate::db::migration_tests::published_branch_database(
            &old_data.join("macro.db"),
            false,
        )
        .await;
        sqlx::raw_sql(include_str!(
            "db/migrations/017_execution_work_protocol.sql"
        ))
        .execute(&mut old)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "db/migrations/018_execution_work_admission.sql"
        ))
        .execute(&mut old)
        .await
        .unwrap();
        sqlx::raw_sql("INSERT INTO schema_migrations VALUES (17,'017_execution_work_protocol','date'),(18,'018_execution_work_admission','date');
            INSERT INTO engine_systems VALUES ('run','request','{}','{}','[]','{}');
            INSERT INTO engine_work_protocol030 VALUES ('run','work','{}','{}','{}','{}','0');
            INSERT INTO engine_work_admission030 VALUES ('run','work','{ \"limit\":9007199254740993 }','{ \"proof\":true }');")
            .execute(&mut old).await.unwrap();
        old.close().await.unwrap();
        let archive = capture(&old_data, &config, BTreeMap::new(), false)
            .await
            .unwrap();
        validate(&archive, &target_data).await.unwrap();
        tests::queue_restore(&target_data, &archive);
        process_startup(&target_data, &config).await.unwrap();
        let pool = crate::db::create_pool(&target_data.join("macro.db"))
            .await
            .unwrap();
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='engine_work_admission030'").fetch_one(&pool).await.unwrap(), 0);
        let stamps: Vec<(i64, String)> = sqlx::query_as("SELECT version,name FROM schema_migrations WHERE version IN (17,18,27,28) ORDER BY version")
            .fetch_all(&pool).await.unwrap();
        assert_eq!(
            stamps,
            vec![
                (17, "017_chat_admission".into()),
                (18, "018_connect_transfer".into()),
                (27, "027_execution_work_protocol".into()),
                (28, "028_execution_work_admission".into())
            ]
        );
    }
}
