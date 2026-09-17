//! Local profile archives. All profile mutations run before DB/config initialization.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use tauri::Manager;

const LIMIT: u64 = 256 * 1024 * 1024;
const PROVIDER_SECRETS_FILE: &str = "provider-secrets.json";
const PROVIDER_SECRETS_RECOVERY_FILES: &[&str] = &[
    PROVIDER_SECRETS_FILE,
    "provider-secrets.migration-pending.json",
    "provider-secrets.json.v1.bak",
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
];
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Entry {
    data: String,
    sha256: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Archive {
    format: String,
    version: u32,
    app_version: String,
    files: BTreeMap<String, Entry>,
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
pub enum BackupStatusCode {
    Exported,
    Restored,
    RolledBack,
    Failed,
    InvalidRequest,
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
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
    if !metadata.is_file() || metadata.len() > LIMIT {
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
    write: impl FnOnce(&mut fs::File) -> std::io::Result<()>,
) -> Result<()> {
    let parent = path.parent().ok_or("Missing parent")?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    write(file.as_file_mut())
        .and_then(|_| file.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    file.persist_noclobber(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("Missing parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = parent.join(format!(".backup-{}", uuid::Uuid::new_v4()));
    write_new(&tmp, bytes)?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn remove_durable(path: &Path) -> Result<()> {
    fs::remove_file(path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    fs::File::open(path.parent().ok_or("Missing parent")?)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())?;
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
    if name == "data/macro.db"
        || name == "data/state.json"
        || name.starts_with("data/direct-checkpoints/")
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
// Count the same implicit directories and depth as collect_tree_bounded.
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
    if fs::symlink_metadata(path).is_ok() {
        return Err("Choose a new backup file; existing files are preserved".into());
    }
    Ok(())
}

async fn connection(path: &Path) -> Result<SqliteConnection> {
    SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .read_only(false)
            .create_if_missing(false),
    )
    .await
    .map_err(|e| e.to_string())
}
async fn check_database(path: &Path) -> Result<()> {
    let mut db = connection(path).await?;
    let check: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&mut db)
        .await
        .map_err(|e| e.to_string())?;
    if check != "ok" {
        return Err("SQLite integrity check failed".into());
    }
    let versions: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM schema_migrations ORDER BY version")
            .fetch_all(&mut db)
            .await
            .map_err(|e| e.to_string())?;
    if versions.iter().any(|v| ![1, 2, 3, 4].contains(v))
        || !versions.contains(&1)
        || !versions.contains(&3)
        || !versions.contains(&4)
    {
        return Err("Incompatible database schema".into());
    }
    let reference_dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let reference = crate::db::create_pool(&reference_dir.path().join("reference.db"))
        .await
        .map_err(|e| e.to_string())?;
    let tables: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetch_all(&mut db).await.map_err(|e| e.to_string())?;
    let expected: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetch_all(&reference).await.map_err(|e| e.to_string())?;
    if tables != expected {
        return Err("Backup database tables do not match this Macro version".into());
    }
    for table in tables {
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
    if files.len() >= 10_000
        || files.values().map(|e| e.data.len()).sum::<usize>() + bytes.len() * 4 / 3
            > LIMIT as usize
    {
        return Err("Profile exceeds the 256 MiB backup limit".into());
    }
    files.insert(
        name,
        Entry {
            sha256: hash(&bytes),
            data: STANDARD.encode(bytes),
        },
    );
    Ok(())
}
fn collect_tree(root: &Path, path: &Path, files: &mut BTreeMap<String, Entry>) -> Result<()> {
    collect_tree_bounded(root, path, files, &mut 10_000)
}
fn collect_tree_bounded(
    root: &Path,
    path: &Path,
    files: &mut BTreeMap<String, Entry>,
    budget: &mut usize,
) -> Result<()> {
    if *budget == 0 {
        return Err("Checkpoint tree exceeds entry limit".into());
    }
    *budget -= 1;
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if meta.is_symlink() {
        return Err("Symlinks are not supported in profile backups".into());
    }
    if path.components().count() > root.components().count() + 32 {
        return Err("Checkpoint tree exceeds depth limit".into());
    }
    if meta.is_dir() {
        for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
            collect_tree_bounded(
                root,
                &entry.map_err(|e| e.to_string())?.path(),
                files,
                budget,
            )?;
        }
    } else {
        add_file(
            files,
            format!(
                "data/{}",
                path.strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/")
            ),
            read_bounded(path)?,
        )?;
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
        let active = format!("config/{file}");
        let approved = format!("config/.runtime/approved/user/{file}");
        let pending = format!("config/.runtime/pending/user/{file}");
        files.remove(&pending);

        if let Some(approved_entry) = files.get(&approved).cloned() {
            files.insert(active.clone(), approved_entry);
        }

        for name in [&active, &approved] {
            let Some(entry) = files.get_mut(name) else {
                continue;
            };
            let bytes = STANDARD.decode(&entry.data).map_err(|e| e.to_string())?;
            let mut json: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            strip_credentials(&mut json);
            let bytes = serde_json::to_vec(&json).map_err(|e| e.to_string())?;
            entry.sha256 = hash(&bytes);
            entry.data = STANDARD.encode(bytes);
        }
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
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let db_path = temp.path().join("macro.db");
    snapshot_database(&data.join("macro.db"), &db_path, portable).await?;
    let mut files = BTreeMap::new();
    add_file(&mut files, "data/macro.db".into(), read_bounded(&db_path)?)?;
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
    }
    Ok(Archive {
        format: "macro-local-profile".into(),
        version: 1,
        app_version: env!("CARGO_PKG_VERSION").into(),
        files,
        browser_sha256: hash(&serde_json::to_vec(&browser).map_err(|e| e.to_string())?),
        browser,
    })
}
async fn validate(archive: &Archive) -> Result<()> {
    if archive.format != "macro-local-profile"
        || archive.version != 1
        || archive.app_version != env!("CARGO_PKG_VERSION")
        || archive.files.len() > 10_000
    {
        return Err("Incompatible profile backup".into());
    }
    validate_checkpoint_paths(&archive.files)?;
    validate_browser(&archive.browser)?;
    if archive.browser_sha256
        != hash(&serde_json::to_vec(&archive.browser).map_err(|e| e.to_string())?)
    {
        return Err("Browser state integrity check failed".into());
    }
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let mut total = 0usize;
    for (name, entry) in &archive.files {
        destination(name, temp.path(), temp.path())?;
        total = total
            .checked_add(entry.data.len())
            .ok_or("Backup too large")?;
        if total > LIMIT as usize {
            return Err("Backup too large".into());
        }
        let bytes = STANDARD.decode(&entry.data).map_err(|e| e.to_string())?;
        if hash(&bytes) != entry.sha256 {
            return Err(format!("Integrity check failed for {name}"));
        }
        if name == "data/macro.db" {
            fs::write(temp.path().join("macro.db"), &bytes).map_err(|e| e.to_string())?;
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
    if !archive.files.contains_key("data/macro.db") {
        return Err("Backup has no database".into());
    }
    let database = temp.path().join("macro.db");
    check_database(&database).await?;
    check_database_startup(&database).await
}
fn raw_destination(name: &str, data: &Path, config: &Path) -> Result<PathBuf> {
    if ["data/macro.db-wal", "data/macro.db-shm"].contains(&name)
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
    for file in ["macro.db", "macro.db-wal", "macro.db-shm", "state.json"] {
        add_optional_raw(&mut files, format!("data/{file}"), &data.join(file))?;
    }
    for file in PROVIDER_SECRETS_RECOVERY_FILES {
        add_optional_raw(&mut files, format!("data/{file}"), &data.join(file))?;
    }
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
        browser_sha256: hash(&serde_json::to_vec(&browser).map_err(|e| e.to_string())?),
        browser,
    })
}
fn validate_raw(archive: &Archive) -> Result<()> {
    if archive.format != "macro-raw-profile" || archive.version != 1 || archive.files.len() > 10_000
    {
        return Err("Invalid preserved profile format".into());
    }
    validate_checkpoint_paths(&archive.files)?;
    validate_browser(&archive.browser)?;
    if archive.browser_sha256
        != hash(&serde_json::to_vec(&archive.browser).map_err(|e| e.to_string())?)
    {
        return Err("Preserved browser checksum mismatch".into());
    }
    let mut total = 0usize;
    for (name, entry) in &archive.files {
        raw_destination(name, Path::new("data"), Path::new("config"))?;
        total = total
            .checked_add(entry.data.len())
            .ok_or("Preserved profile too large")?;
        if total > LIMIT as usize {
            return Err("Preserved profile too large".into());
        }
        let bytes = STANDARD.decode(&entry.data).map_err(|e| e.to_string())?;
        if hash(&bytes) != entry.sha256 {
            return Err("Preserved file checksum mismatch".into());
        }
    }
    Ok(())
}
fn preserve_raw(archive: &Archive, path: &Path) -> Result<()> {
    validate_raw(archive)?;
    let bytes = serde_json::to_vec(archive).map_err(|e| e.to_string())?;
    if bytes.len() > LIMIT as usize {
        return Err("Current profile exceeds preservation limit".into());
    }
    write_new(path, &bytes)?;
    crate::secrets::harden_private_file(path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    fs::File::open(path.parent().ok_or("Missing preservation directory")?)
        .and_then(|file| file.sync_all())
        .map_err(|e| e.to_string())?;
    validate_raw(&load_archive(path)?)
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RestoreJournal {
    preserved: String,
}
fn preserved_path(dir: &Path, journal: &RestoreJournal) -> Result<PathBuf> {
    let id = journal
        .preserved
        .strip_prefix("preserved-")
        .and_then(|name| name.strip_suffix(".json"))
        .ok_or("Invalid preservation journal")?;
    uuid::Uuid::parse_str(id).map_err(|e| e.to_string())?;
    Ok(dir.join(&journal.preserved))
}

fn safe_parent(path: &Path, root: &Path) -> Result<()> {
    let mut current = root.to_path_buf();
    let relative = path.strip_prefix(root).map_err(|e| e.to_string())?;
    for part in std::iter::once(None).chain(relative.components().map(Some)) {
        if let Some(part) = part {
            current.push(part);
        }
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.is_symlink() => return Err("Profile target contains a symlink".into()),
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
        fs::remove_dir(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn apply(archive: &Archive, data: &Path, config: &Path) -> Result<()> {
    apply_files(archive, data, config, false)
}
fn apply_files(archive: &Archive, data: &Path, config: &Path, raw: bool) -> Result<()> {
    validate_profile_paths(data, config)?;
    validate_checkpoint_paths(&archive.files)?;
    let target = |name: &str| {
        if raw {
            raw_destination(name, data, config)
        } else {
            destination(name, data, config)
        }
    };
    // At startup only: SQLite and config writers have not been initialized.
    for name in archive.files.keys() {
        let path = target(name)?;
        safe_parent(
            &path,
            if name.starts_with("data/") {
                data
            } else {
                config
            },
        )?;
        if path.is_dir() && !name.starts_with("data/direct-checkpoints/") {
            return Err("Restore target is a directory".into());
        }
    }
    for suffix in ["-wal", "-shm"] {
        let path = data.join(format!("macro.db{suffix}"));
        if path.exists() {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    let mut existing = BTreeMap::new();
    collect_tree(data, &data.join("direct-checkpoints"), &mut existing)?;
    for name in existing.keys() {
        if !archive.files.contains_key(name) {
            fs::remove_file(target(name)?).map_err(|e| e.to_string())?;
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
                fs::remove_file(path).map_err(|e| e.to_string())?;
            }
        }
    }
    if !archive.files.contains_key("data/state.json") && data.join("state.json").exists() {
        fs::remove_file(data.join("state.json")).map_err(|e| e.to_string())?;
    }
    if raw && !archive.files.contains_key("data/macro.db") && data.join("macro.db").exists() {
        fs::remove_file(data.join("macro.db")).map_err(|e| e.to_string())?;
    }
    for file in PROVIDER_SECRETS_RECOVERY_FILES {
        if !archive.files.contains_key(&format!("data/{file}")) && data.join(file).exists() {
            fs::remove_file(data.join(file)).map_err(|e| e.to_string())?;
        }
    }
    for (name, entry) in &archive.files {
        let path = target(name)?;
        let bytes = STANDARD.decode(&entry.data).map_err(|e| e.to_string())?;
        atomic(&path, &bytes)?;
    }
    Ok(())
}
fn load_archive(path: &Path) -> Result<Archive> {
    serde_json::from_slice(&read_bounded(path)?).map_err(|e| e.to_string())
}

async fn load_restore_archive(path: &Path) -> Result<Archive> {
    let mut archive = load_archive(path)?;
    if archive.format == "macro-raw-profile" {
        validate_raw(&archive)?;
        let temp = tempfile::tempdir().map_err(|error| error.to_string())?;
        for name in ["data/macro.db", "data/macro.db-wal", "data/macro.db-shm"] {
            if let Some(entry) = archive.files.get(name) {
                let bytes = STANDARD
                    .decode(&entry.data)
                    .map_err(|error| error.to_string())?;
                write_new(
                    &temp.path().join(name.strip_prefix("data/").unwrap()),
                    &bytes,
                )?;
            }
        }
        let normalized = temp.path().join("normalized.db");
        snapshot_database(&temp.path().join("macro.db"), &normalized, true).await?;
        archive.files.remove("data/macro.db-wal");
        archive.files.remove("data/macro.db-shm");
        archive.files.remove("data/macro.db");
        for file in PROVIDER_SECRETS_RECOVERY_FILES {
            archive.files.remove(&format!("data/{file}"));
        }
        add_file(
            &mut archive.files,
            "data/macro.db".into(),
            read_bounded(&normalized)?,
        )?;
        make_config_files_portable(&mut archive.files)?;
        archive.format = "macro-local-profile".into();
    }
    validate(&archive).await?;
    Ok(archive)
}

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

/// Called before any subsystem opens the profile. An interrupted mutation rolls back first.
pub async fn process_startup(data: &Path, config: &Path) -> Result<()> {
    process_startup_with_preserver(data, config, preserve_raw).await
}
async fn process_startup_with_preserver(
    data: &Path,
    config: &Path,
    preserve: fn(&Archive, &Path) -> Result<()>,
) -> Result<()> {
    let dir = data.join("local-backup");
    safe_parent(&dir, dir.parent().ok_or("Missing profile root")?)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let journal = dir.join("restoring.json");
    if journal.exists() {
        let marker: RestoreJournal =
            serde_json::from_slice(&read_bounded(&journal)?).map_err(|e| e.to_string())?;
        let original = load_archive(&preserved_path(&dir, &marker)?)?;
        validate_raw(&original)?;
        apply_files(&original, data, config, true)?;
        let status = BackupStatus {
            message: String::new(),
            code: Some(BackupStatusCode::RolledBack),
            path: None,
            browser: Some(original.browser),
        };
        atomic(
            &dir.join("status.json"),
            &serde_json::to_vec(&status).map_err(|e| e.to_string())?,
        )?;
        // A recovered request must not replay the failed restore on this launch.
        if dir.join("request.json").exists() {
            remove_durable(&dir.join("request.json"))?;
        }
        remove_durable(&journal)?;
    }
    let request_path = dir.join("request.json");
    if !request_path.exists() {
        return Ok(());
    }
    let request: Request = match read_bounded(&request_path)
        .and_then(|bytes| serde_json::from_slice(&bytes).map_err(|e| e.to_string()))
    {
        Ok(request) => request,
        Err(error) => {
            let quarantined = dir.join(format!("invalid-request-{}.json", uuid::Uuid::new_v4()));
            fs::rename(&request_path, &quarantined).map_err(|e| e.to_string())?;
            let status = BackupStatus {
                message: error,
                code: Some(BackupStatusCode::InvalidRequest),
                path: Some(quarantined.to_string_lossy().into()),
                browser: None,
            };
            atomic(
                &dir.join("status.json"),
                &serde_json::to_vec(&status).map_err(|e| e.to_string())?,
            )?;
            return Ok(());
        }
    };
    let result = async {
        if request.operation == "export" {
            validate_export_path(Path::new(&request.path), data, config)?;
            let archive = capture(data, config, request.browser, true).await?;
            validate(&archive).await?;
            let bytes = serde_json::to_vec(&archive).map_err(|e| e.to_string())?;
            if bytes.len() > LIMIT as usize { return Err("Archive exceeds the 256 MiB limit".into()); }
            write_new(Path::new(&request.path), &bytes)?;
            Ok(BackupStatus { message: String::new(), code: Some(BackupStatusCode::Exported), path: Some(request.path), browser: None })
        } else if request.operation == "restore" {
            let archive = load_restore_archive(&dir.join("incoming.json")).await?;
            let original = capture_raw(data, config, request.browser)?;
            let marker = RestoreJournal { preserved: format!("preserved-{}.json", uuid::Uuid::new_v4()) };
            let preservation = preserved_path(&dir, &marker)?;
            preserve(&original, &preservation)?;
            atomic(&journal, &serde_json::to_vec(&marker).map_err(|e| e.to_string())?)?;
            if let Err(error) = apply(&archive, data, config) {
                apply_files(&original, data, config, true).map_err(|rollback| format!("Restore failed: {error}. Rollback failed: {rollback}. Original preserved in {}", dir.display()))?;
                remove_durable(&journal)?;
                return Err(error);
            }
            let status = BackupStatus { message: String::new(), code: Some(BackupStatusCode::Restored), path: Some(preservation.to_string_lossy().into()), browser: Some(archive.browser) };
            atomic(&dir.join("status.json"), &serde_json::to_vec(&status).map_err(|e| e.to_string())?)?;
            remove_durable(&request_path)?;
            remove_durable(&journal)?;
            Ok(status)
        } else { Err("Unknown backup operation".into()) }
    }.await;
    if journal.exists() {
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
    atomic(
        &dir.join("status.json"),
        &serde_json::to_vec(&status).map_err(|e| e.to_string())?,
    )?;
    if request_path.exists() {
        remove_durable(&request_path)?;
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
    static SCHEDULE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = SCHEDULE_LOCK.lock().await;
    if !confirmed
        || !["export", "restore"].contains(&operation.as_str())
        || !Path::new(&path).is_absolute()
    {
        return Err("Explicit confirmation and an absolute file path are required".into());
    }
    validate_browser(&browser)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("local-backup");
    safe_parent(&dir, dir.parent().ok_or("Missing profile root")?)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if dir.join("request.json").exists() {
        return Err("A profile operation is already pending. Restart Macro first.".into());
    }
    if operation == "restore" {
        let archive = load_restore_archive(Path::new(&path)).await?;
        atomic(
            &dir.join("incoming.json"),
            &serde_json::to_vec(&archive).map_err(|e| e.to_string())?,
        )?;
    } else {
        let config = crate::config::resolve_config_root(
            &app.path().app_config_dir().map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.message)?;
        validate_export_path(
            Path::new(&path),
            dir.parent().ok_or("Missing profile root")?,
            &config,
        )?;
    }
    write_new(
        &dir.join("request.json"),
        &serde_json::to_vec(&Request {
            operation,
            path,
            browser,
        })
        .map_err(|e| e.to_string())?,
    )?;
    Ok(())
}
#[tauri::command]
pub fn local_backup_status(app: tauri::AppHandle) -> Result<BackupStatus> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("local-backup/status.json");
    if !path.exists() {
        return Ok(BackupStatus::default());
    }
    serde_json::from_slice(&read_bounded(&path)?).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn local_backup_acknowledge(app: tauri::AppHandle) -> Result<()> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("local-backup/status.json");
    let mut status = local_backup_status(app)?;
    status.browser = None;
    atomic(
        &path,
        &serde_json::to_vec(&status).map_err(|e| e.to_string())?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn profile() -> (tempfile::TempDir, PathBuf, PathBuf) {
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
        pool.close().await;
        (temp, data, config)
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
        db.close().await.unwrap();
        // The supported legacy upgrader adds this column at the end of the table.
        let pool = crate::db::create_pool(&database).await.unwrap();
        pool.close().await;
        let archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        validate(&archive).await.unwrap();
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
        assert!(validate(&archive).await.is_err());
        queue_restore(&data, &archive);
        process_startup(&data, &config).await.unwrap();
        assert_eq!(fs::read(data.join("macro.db")).unwrap(), before);
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
        validate(&archive).await.unwrap();
        queue_restore(&data, &archive);
        let dir = data.join("local-backup");
        // Fail after application, when the success status should be published.
        fs::create_dir(dir.join("status.json")).unwrap();
        assert!(process_startup(&data, &config).await.is_err());
        assert!(object.join("new").exists());
        assert!(dir.join("restoring.json").exists());
        fs::remove_dir(dir.join("status.json")).unwrap();
        process_startup(&data, &config).await.unwrap();
        assert_eq!(fs::read(&object).unwrap(), b"original leaf");
        assert!(!dir.join("restoring.json").exists());
        assert!(!dir.join("request.json").exists());
        let recovered = capture_raw(&data, &config, BTreeMap::new()).unwrap();
        assert_eq!(
            recovered.files.keys().collect::<Vec<_>>(),
            original.files.keys().collect::<Vec<_>>()
        );
        for (name, entry) in original.files {
            assert_eq!(recovered.files[&name].sha256, entry.sha256);
        }
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
        validate(&archive).await.unwrap();
        apply(&archive, &data, &config).unwrap();
        validate_raw(&capture_raw(&data, &config, BTreeMap::new()).unwrap()).unwrap();
        let deep = format!("data/direct-checkpoints/{}leaf", "d/".repeat(31));
        add_file(&mut archive.files, deep, vec![]).unwrap();
        assert!(validate(&archive).await.unwrap_err().contains("depth"));
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
        assert!(validate(&archive)
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
        assert!(validate(&archive)
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
        validate(&archive).await.unwrap();
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
        let archive = load_archive(&path).unwrap_or_else(|error| {
            panic!(
                "{error}: {}",
                fs::read_to_string(dir.join("status.json")).unwrap()
            )
        });
        validate(&archive).await.unwrap();
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
        let rollback = load_archive(&preserved).unwrap();
        validate_raw(&rollback).unwrap();
        validate(&load_restore_archive(&preserved).await.unwrap())
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
    async fn rejects_tampering_and_future_versions_without_touching_original() {
        let (_temp, data, config) = profile().await;
        let original = fs::read(data.join("macro.db")).unwrap();
        let mut archive = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        archive.version = 2;
        assert!(validate(&archive).await.is_err());
        archive.version = 1;
        archive.files.get_mut("data/macro.db").unwrap().sha256 = "bad".into();
        assert!(validate(&archive).await.is_err());
        assert_eq!(fs::read(data.join("macro.db")).unwrap(), original);
    }
    #[tokio::test]
    async fn startup_recovers_interrupted_restore_and_preserves_rollback_archive() {
        let (_temp, data, config) = profile().await;
        let original = capture_raw(&data, &config, BTreeMap::new()).unwrap();
        let dir = data.join("local-backup");
        fs::create_dir_all(&dir).unwrap();
        let marker = RestoreJournal {
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
    async fn portable_restore_detaches_provider_secrets_and_keeps_them_in_rollback() {
        let (_temp, data, config) = profile().await;
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

        for file in PROVIDER_SECRETS_RECOVERY_FILES {
            assert!(!data.join(file).exists(), "{file} must be detached");
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
        let rollback = load_archive(&preserved).unwrap();
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
    fn queue_restore(data: &Path, archive: &Archive) {
        let dir = data.join("local-backup");
        fs::create_dir_all(&dir).unwrap();
        atomic(
            &dir.join("incoming.json"),
            &serde_json::to_vec(archive).unwrap(),
        )
        .unwrap();
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
            "stable-windows-x86_64"
        )
        .unwrap());
        queue_restore(&data, &archive);
        // This is the updater gate called first at startup: the old Stable
        // preference must not authorize activation before restore validation.
        assert!(!crate::app_updates::target_matches_persisted_channel(
            &data,
            "stable-windows-x86_64"
        )
        .unwrap());
        process_startup(&data, &config).await.unwrap();
        assert!(!has_pending_startup_work(&data).unwrap());
        assert!(!crate::app_updates::target_matches_persisted_channel(
            &data,
            "stable-windows-x86_64"
        )
        .unwrap());
        assert!(crate::app_updates::target_matches_persisted_channel(
            &data,
            "preview-windows-x86_64"
        )
        .unwrap());
        // An interrupted restoration also blocks even without a request file.
        fs::write(data.join("local-backup/restoring.json"), b"interrupted").unwrap();
        assert!(!crate::app_updates::target_matches_persisted_channel(
            &data,
            "preview-windows-x86_64"
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
        let raw = load_archive(&preserved).unwrap();
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
            assert!(validate(&archive).await.is_err());
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

        assert!(validate(&archive).await.is_err());
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

        let error = validate(&archive).await.expect_err("reject extra trigger");
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

        let error = validate(&archive)
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

        let portable = load_restore_archive(&raw_path).await.unwrap();
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
}
