//! Local profile archives. All profile mutations run before DB/config initialization.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use tauri::Manager;

const LIMIT: u64 = 256 * 1024 * 1024;
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
    pub message: String,
    pub browser: Option<BTreeMap<String, String>>,
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
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
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
fn destination(name: &str, data: &Path, config: &Path) -> Result<PathBuf> {
    if name.contains('\\') || name.contains(':') || name.len() > 4096 {
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
    let unexpected: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE type IN ('trigger', 'view')")
            .fetch_one(&mut db)
            .await
            .map_err(|e| e.to_string())?;
    if unexpected != 0 {
        return Err("Backup contains unsupported database triggers or views".into());
    }
    let versions: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM schema_migrations ORDER BY version")
            .fetch_all(&mut db)
            .await
            .map_err(|e| e.to_string())?;
    if versions.iter().any(|v| ![1, 2, 3].contains(v))
        || !versions.contains(&1)
        || !versions.contains(&3)
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
    if !path.exists() {
        return Ok(());
    }
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
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
async fn capture(
    data: &Path,
    config: &Path,
    browser: BTreeMap<String, String>,
    portable: bool,
) -> Result<Archive> {
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
                let mut bytes = read_bounded(&path)?;
                if portable {
                    let mut json: serde_json::Value =
                        serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                    strip_credentials(&mut json);
                    bytes = serde_json::to_vec(&json).map_err(|e| e.to_string())?;
                }
                add_file(&mut files, format!("config/{relative}"), bytes)?;
            }
        }
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
    check_database(&temp.path().join("macro.db")).await
}
fn safe_parent(path: &Path, root: &Path) -> Result<()> {
    let mut current = root.to_path_buf();
    for part in path
        .strip_prefix(root)
        .map_err(|e| e.to_string())?
        .components()
    {
        current.push(part);
        if let Ok(meta) = fs::symlink_metadata(&current) {
            if meta.is_symlink() {
                return Err("Restore target contains a symlink".into());
            }
        }
    }
    Ok(())
}
fn apply(archive: &Archive, data: &Path, config: &Path) -> Result<()> {
    // At startup only: SQLite and config writers have not been initialized.
    for name in archive.files.keys() {
        let path = destination(name, data, config)?;
        safe_parent(
            &path,
            if name.starts_with("data/") {
                data
            } else {
                config
            },
        )?;
        if path.is_dir() {
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
            fs::remove_file(destination(name, data, config)?).map_err(|e| e.to_string())?;
        }
    }
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
    for (name, entry) in &archive.files {
        let path = destination(name, data, config)?;
        let bytes = STANDARD.decode(&entry.data).map_err(|e| e.to_string())?;
        atomic(&path, &bytes)?;
    }
    Ok(())
}
fn load_archive(path: &Path) -> Result<Archive> {
    serde_json::from_slice(&read_bounded(path)?).map_err(|e| e.to_string())
}

/// Called before any subsystem opens the profile. An interrupted mutation rolls back first.
pub async fn process_startup(data: &Path, config: &Path) -> Result<()> {
    let dir = data.join("local-backup");
    safe_parent(&dir, dir.parent().ok_or("Missing profile root")?)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let journal = dir.join("restoring.json");
    if journal.exists() {
        let original = load_archive(&dir.join("rollback.json"))?;
        validate(&original).await?;
        apply(&original, data, config)?;
        let status = BackupStatus {
            message: "Interrupted restoration rolled back. Previous profile recovered.".into(),
            browser: Some(original.browser),
        };
        atomic(
            &dir.join("status.json"),
            &serde_json::to_vec(&status).map_err(|e| e.to_string())?,
        )?;
        fs::remove_file(&journal).map_err(|e| e.to_string())?;
    }
    let request_path = dir.join("request.json");
    if !request_path.exists() {
        return Ok(());
    }
    let request: Request =
        serde_json::from_slice(&read_bounded(&request_path)?).map_err(|e| e.to_string())?;
    fs::remove_file(&request_path).map_err(|e| e.to_string())?;
    let result = async {
        if request.operation == "export" {
            let archive = capture(data, config, request.browser, true).await?;
            validate(&archive).await?;
            let bytes = serde_json::to_vec(&archive).map_err(|e| e.to_string())?;
            if bytes.len() > LIMIT as usize { return Err("Archive exceeds the 256 MiB limit".into()); }
            write_new(Path::new(&request.path), &bytes)?;
            Ok(BackupStatus { message: format!("Backup saved: {}", request.path), browser: None })
        } else if request.operation == "restore" {
            let archive = load_archive(&dir.join("incoming.json"))?; validate(&archive).await?;
            let original = capture(data, config, request.browser, false).await?;
            validate(&original).await?;
            let rollback_bytes = serde_json::to_vec(&original).map_err(|e| e.to_string())?;
            if rollback_bytes.len() > LIMIT as usize { return Err("Previous profile exceeds the rollback limit".into()); }
            atomic(&dir.join("rollback.json"), &rollback_bytes)?;
            atomic(&journal, b"{}")?;
            if let Err(error) = apply(&archive, data, config) {
                apply(&original, data, config).map_err(|rollback| format!("Restore failed: {error}. Rollback failed: {rollback}. Original preserved in {}", dir.display()))?;
                fs::remove_file(&journal).map_err(|e| e.to_string())?;
                return Err(error);
            }
            let status = BackupStatus { message: format!("Profile restored. Previous profile retained in {}", dir.join("rollback.json").display()), browser: Some(archive.browser) };
            atomic(&dir.join("status.json"), &serde_json::to_vec(&status).map_err(|e| e.to_string())?)?;
            fs::remove_file(&journal).map_err(|e| e.to_string())?;
            Ok(status)
        } else { Err("Unknown backup operation".into()) }
    }.await;
    if journal.exists() {
        return Err(result
            .err()
            .unwrap_or_else(|| "Restore interrupted; recovery journal retained".into()));
    }
    let status = result.unwrap_or_else(|error: String| BackupStatus {
        message: format!("Backup operation failed; original profile preserved: {error}"),
        browser: None,
    });
    atomic(
        &dir.join("status.json"),
        &serde_json::to_vec(&status).map_err(|e| e.to_string())?,
    )
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
        let archive = load_archive(Path::new(&path))?;
        validate(&archive).await?;
        atomic(
            &dir.join("incoming.json"),
            &serde_json::to_vec(&archive).map_err(|e| e.to_string())?,
        )?;
    } else if Path::new(&path).exists() {
        return Err("Choose a new backup file; existing files are preserved".into());
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
        let rollback = load_archive(&dir.join("rollback.json")).unwrap();
        validate(&rollback).await.unwrap();
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
        let original = capture(&data, &config, BTreeMap::new(), false)
            .await
            .unwrap();
        let dir = data.join("local-backup");
        fs::create_dir_all(&dir).unwrap();
        atomic(
            &dir.join("rollback.json"),
            &serde_json::to_vec(&original).unwrap(),
        )
        .unwrap();
        atomic(&dir.join("restoring.json"), b"{}").unwrap();
        fs::write(data.join("macro.db"), b"failed replacement").unwrap();
        process_startup(&data, &config).await.unwrap();
        check_database(&data.join("macro.db")).await.unwrap();
        assert!(dir.join("rollback.json").exists());
        assert!(!dir.join("restoring.json").exists());
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
}
