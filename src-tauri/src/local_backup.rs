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
            .pragma("recursive_triggers", "ON")
            .read_only(false)
            .create_if_missing(false),
    )
    .await
    .map_err(|e| e.to_string())
}
// Only remove objects from our freshly built reference, never from an archive.
async fn remove_reference_e_schema(db: &mut SqliteConnection, versions: &[i64]) -> Result<()> {
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
    if versions
        .iter()
        .any(|v| !crate::db::SUPPORTED_MIGRATION_VERSIONS.contains(v))
        || !versions.contains(&1)
        || !versions.contains(&3)
        || !versions.contains(&4)
    {
        return Err("Incompatible database schema".into());
    }
    let stamps: Vec<(i64, String)> = sqlx::query_as("SELECT version, name FROM schema_migrations")
        .fetch_all(&mut db)
        .await
        .map_err(|e| e.to_string())?;
    let stamped = |version, name: &str| stamps.iter().any(|(v, n)| *v == version && n == name);
    if versions.contains(&13)
        && (!versions.contains(&12) || !stamped(13, "013_conversation_content_versions"))
    {
        return Err("Incompatible database schema".into());
    }
    if versions.contains(&14)
        && (!versions.contains(&13) || !stamped(14, "014_conversation_catalog_version"))
    {
        return Err("Incompatible database schema".into());
    }
    if (versions.contains(&15) && (!versions.contains(&14) || !stamped(15, "015_inactive_storage")))
        || (versions.contains(&16)
            && (!versions.contains(&15) || !stamped(16, "016_source_capture")))
    {
        return Err("Incompatible database schema".into());
    }
    if versions.contains(&17) && (!versions.contains(&16) || !stamped(17, "017_chat_admission")) {
        return Err("Incompatible database schema".into());
    }
    if versions.contains(&18) && (!versions.contains(&17) || !stamped(18, "018_connect_transfer")) {
        return Err("Incompatible database schema".into());
    }

    if versions.contains(&19) && (!versions.contains(&18) || !stamped(19, "019_connect_publication")) {
        return Err("Incompatible database schema".into());
    }
    if versions.contains(&20) && (!versions.contains(&19) || !stamped(20, "020_connect_archive_lifecycle")) {
        return Err("Incompatible database schema".into());
    }
    let legacy_trace = stamped(6, "006_pilot_tool_trace_revisions");
    let legacy_management = stamped(7, "007_conversation_management");
    let has_trace =
        versions.contains(&10) || legacy_trace || stamped(5, "005_pilot_tool_trace_revisions");
    let has_management = versions.contains(&11) || legacy_management;
    let reference_dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let reference = crate::db::create_pool(&reference_dir.path().join("reference.db"))
        .await
        .map_err(|e| e.to_string())?;
    // Compare the archive with the schema its migration stamps describe. Do
    // not migrate the untrusted archive until its original objects pass this
    // strict comparison; startup validation migrates a temporary copy later.
    if !versions.contains(&20) {
        crate::db::connect_transfer::remove_reader_reference_in(&mut *reference.acquire().await.map_err(|e|e.to_string())?)
            .await.map_err(|e|e.to_string())?;
    }
    if !versions.contains(&19) {
        crate::db::connect_transfer::remove_publication_reference_in(&mut *reference.acquire().await.map_err(|e|e.to_string())?)
            .await.map_err(|e|e.to_string())?;
    }
    if !versions.contains(&18) {
        crate::db::connect_transfer::remove_reference_schema_in(&mut *reference.acquire().await.map_err(|e| e.to_string())?)
            .await.map_err(|e| e.to_string())?;
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
    let tables: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetch_all(&mut db).await.map_err(|e| e.to_string())?;
    let expected: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetch_all(&reference).await.map_err(|e| e.to_string())?;
    if tables != expected {
        return Err("Backup database tables do not match this Macro version".into());
    }
    for table in tables {
        if table.starts_with("connect_")
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
// Native authentication identities must not reconnect to an existing OS vault.
// Keep the relay address and display label, but allocate a new configuration context.
fn make_state_file_portable(files: &mut BTreeMap<String, Entry>) -> Result<()> {
    let Some(entry) = files.get_mut("data/state.json") else {
        return Ok(());
    };
    let bytes = STANDARD
        .decode(&entry.data)
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
        make_state_file_portable(&mut files)?;
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
    #[serde(default)]
    phase: RestorePhase,
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
    } else {
        // Verify original checksums before detaching identities in older portable archives.
        validate(&archive).await?;
    }
    make_state_file_portable(&mut archive.files)?;
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
    let data = data.to_owned();
    let config = config.to_owned();
    let runtime = tokio::runtime::Handle::current();
    #[cfg(not(test))]
    let owner = crate::secrets::policy::POLICY.clone();
    #[cfg(test)]
    let owner = std::sync::Arc::new(crate::secrets::policy::PolicyOwner::for_test(&data));
    crate::secrets::blocking::run(move || {
        owner.startup(&data, |rotate| {
            runtime.block_on(process_startup_locked(&data, &config, preserve, rotate))
        })
    }).await.map_err(|error| error.to_string())?
}

async fn process_startup_locked(
    data: &Path,
    config: &Path,
    preserve: fn(&Archive, &Path) -> Result<()>,
    rotate_before_journal_removal: &dyn Fn() -> std::result::Result<(), crate::secrets::SecretError>,
) -> Result<()> {
    let dir = data.join("local-backup");
    safe_parent(&dir, dir.parent().ok_or("Missing profile root")?)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let journal = dir.join("restoring.json");
    if journal.exists() {
        let mut marker: RestoreJournal =
            serde_json::from_slice(&read_bounded(&journal)?).map_err(|e| e.to_string())?;
        if marker.phase == RestorePhase::Rollback {
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
            // Raw rollback is complete. A failed nonce rotation must not apply it again.
            marker.phase = RestorePhase::InstallHold;
            atomic(&journal, &serde_json::to_vec(&marker).map_err(|e| e.to_string())?)?;
        }
        install_restore_hold(data).await?;
        // A recovered request must not replay the failed restore on this launch.
        if dir.join("request.json").exists() {
            remove_durable(&dir.join("request.json"))?;
        }
        rotate_before_journal_removal().map_err(|error| error.to_string())?;
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
            let mut marker = RestoreJournal { preserved: format!("preserved-{}.json", uuid::Uuid::new_v4()), phase: RestorePhase::Rollback };
            let preservation = preserved_path(&dir, &marker)?;
            preserve(&original, &preservation)?;
            atomic(&journal, &serde_json::to_vec(&marker).map_err(|e| e.to_string())?)?;
            if let Err(error) = apply(&archive, data, config) {
                apply_files(&original, data, config, true).map_err(|rollback| format!("Restore failed: {error}. Rollback failed: {rollback}. Original preserved in {}", dir.display()))?;
                let status = BackupStatus { message: error.clone(), code: Some(BackupStatusCode::Failed), path: None, browser: None };
                atomic(&dir.join("status.json"), &serde_json::to_vec(&status).map_err(|e| e.to_string())?)?;
                marker.phase = RestorePhase::InstallHold;
                atomic(&journal, &serde_json::to_vec(&marker).map_err(|e| e.to_string())?)?;
                install_restore_hold(data).await?;
                rotate_before_journal_removal().map_err(|error| error.to_string())?;
                remove_durable(&journal)?;
                return Err(error);
            }
            let status = BackupStatus { message: String::new(), code: Some(BackupStatusCode::Restored), path: Some(preservation.to_string_lossy().into()), browser: Some(archive.browser) };
            atomic(&dir.join("status.json"), &serde_json::to_vec(&status).map_err(|e| e.to_string())?)?;
            marker.phase = RestorePhase::InstallHold;
            atomic(&journal, &serde_json::to_vec(&marker).map_err(|e| e.to_string())?)?;
            install_restore_hold(data).await?;
            remove_durable(&request_path)?;
            rotate_before_journal_removal().map_err(|error| error.to_string())?;
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
    fn assert_empty_policy(data: &Path) {
        let value: serde_json::Value = serde_json::from_slice(&fs::read(data.join(PROVIDER_SECRETS_FILE)).unwrap()).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 4);
        assert_eq!(value["version"], 2);
        let epoch = uuid::Uuid::parse_str(value["policyEpoch"].as_str().unwrap()).unwrap();
        assert!(!epoch.is_nil());
        assert_eq!(value["namespaces"].as_object().unwrap().len(), 5);
        assert!(value["namespaces"].as_object().unwrap().values().all(|map| map.as_object().unwrap().is_empty()));
        assert!(value["chatgpt_sessions"].as_object().unwrap().is_empty());
    }

    #[test]
    fn policy_restore_crash_child() {
        use std::io::{BufRead, Write};
        let Some(data) = std::env::var_os("MACRO_POLICY_RESTORE_CRASH_DATA") else { return };
        let config = PathBuf::from(std::env::var_os("MACRO_POLICY_RESTORE_CRASH_CONFIG").unwrap());
        let data = PathBuf::from(data);
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            let handle = tokio::runtime::Handle::current();
            let owner = crate::secrets::policy::PolicyOwner::for_test(&data);
            crate::secrets::blocking::run(move || {
                owner.startup(&data, |_| handle.block_on(process_startup_locked(&data, &config, preserve_raw, &|| {
                    println!("synthetic-restore-lock-held");
                    std::io::stdout().flush().unwrap();
                    let mut command = String::new();
                    std::io::stdin().lock().read_line(&mut command).unwrap();
                    std::process::exit(73);
                })))
            }).await.unwrap().unwrap();
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
            fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
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
        let marker = RestoreJournal { preserved: preserved_name, phase: RestorePhase::Rollback };
        atomic(&directory.join("restoring.json"), &serde_json::to_vec(&marker).unwrap()).unwrap();
        let mut child = Child(std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "local_backup::tests::policy_restore_crash_child", "--nocapture"])
            .env("MACRO_POLICY_RESTORE_CRASH_DATA", &data)
            .env("MACRO_POLICY_RESTORE_CRASH_CONFIG", &config)
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::inherit())
            .spawn().unwrap());
        let stdout = child.0.stdout.take().unwrap();
        let (held_tx, held_rx) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in std::io::BufReader::new(stdout).lines() {
                if line.unwrap().contains("synthetic-restore-lock-held") {
                    held_tx.send(()).unwrap(); break;
                }
            }
        });
        held_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        reader.join().unwrap();
        let (captured_tx, captured_rx) = mpsc::channel();
        let capture_owner = owner.clone();
        let capture = std::thread::spawn(move || {
            captured_tx.send(capture_owner.qualification_stamp().is_ok()).unwrap();
        });
        let excluded = captured_rx.recv_timeout(Duration::from_millis(50)).is_err();
        child.0.stdin.take().unwrap().write_all(b"crash\n").unwrap();
        let status = child.0.wait().unwrap();
        let refused = !captured_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        capture.join().unwrap();
        assert!(excluded);
        assert_eq!(status.code(), Some(73));
        assert!(refused);
        assert_eq!(fs::read(data.join(PROVIDER_SECRETS_FILE)).unwrap(), old_bytes);
        assert_eq!(fs::read(&preserved).unwrap(), archive_bytes);
        let pending: RestoreJournal = serde_json::from_slice(&fs::read(directory.join("restoring.json")).unwrap()).unwrap();
        assert!(pending.phase == RestorePhase::InstallHold);
        assert!(owner.qualification_stamp().is_err());
        // A closed-profile repair must survive retry: the raw archive is not applied twice.
        let mut repaired: serde_json::Value = serde_json::from_slice(&old_bytes).unwrap();
        repaired["namespaces"]["providers"]["synthetic"] = serde_json::json!("repair-before-retry");
        fs::write(data.join(PROVIDER_SECRETS_FILE), serde_json::to_vec(&repaired).unwrap()).unwrap();
        process_startup(&data, &config).await.unwrap();
        let after: serde_json::Value = serde_json::from_slice(&fs::read(data.join(PROVIDER_SECRETS_FILE)).unwrap()).unwrap();
        assert_eq!(after["namespaces"]["providers"]["synthetic"], "repair-before-retry");
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
        validate(&archive).await.unwrap();

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
            20
        );
        restored.close().await.unwrap();

        // Restore installs the current schema and read-only ownership before startup.
        let pool = crate::db::create_pool(&database).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT MAX(version) FROM schema_migrations")
                .fetch_one(&pool)
                .await
                .unwrap(),
            20
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
    async fn database_validation_accepts_current_and_rejects_unknown_migration_versions() {
        let (_temp, data, _config) = profile().await;
        let database = data.join("macro.db");
        check_database(&database).await.unwrap();
        let mut db = connection(&database).await.unwrap();
        let version: i64 = sqlx::query_scalar("SELECT MAX(version) FROM schema_migrations")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(version, 20);
        sqlx::query("INSERT INTO schema_migrations VALUES (99, 'future', 'synthetic')")
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
        assert_eq!(
            check_database(&database).await.unwrap_err(),
            "Incompatible database schema"
        );
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
        validate(&archive).await.unwrap();
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
        validate(&archive).await.unwrap();
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
        validate(&archive).await.unwrap();
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
        validate(&archive).await.unwrap();
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
        validate(&archive).await.unwrap();
        let path = temp.path().join("recovery.json");
        write_new(&path, &serde_json::to_vec(&archive).unwrap()).unwrap();
        assert_eq!(load_restore_archive(&path).await.unwrap().browser, browser);

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
        let original = load_archive(&preserved).unwrap();
        validate_raw(&original).unwrap();
        assert_eq!(original.browser, browser);

        // An interrupted native replacement recovers the same complete browser snapshot.
        atomic(
            &dir.join("restoring.json"),
            &serde_json::to_vec(&RestoreJournal {
                phase: RestorePhase::Rollback,
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
            phase: RestorePhase::Rollback,
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
    async fn chat_admission_restore_hold_phase_does_not_reapply_rollback() {
        let (_temp, data, config) = profile().await;
        let original = capture_raw(&data, &config, BTreeMap::new()).unwrap();
        let dir = data.join("local-backup");
        fs::create_dir_all(&dir).unwrap();
        let marker = RestoreJournal {
            phase: RestorePhase::InstallHold,
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
    pub(super) fn queue_restore(data: &Path, archive: &Archive) {
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

    #[tokio::test]
    async fn connect_transfer_restore_preserves_raw_prefix_and_import_lease_before_ready() {
        let (_temp,data,config)=profile().await;
        let path=data.join("macro.db");
        let mut db=connection(&path).await.unwrap();
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
        let archive=capture(&data,&config,BTreeMap::new(),true).await.unwrap();
        validate(&archive).await.unwrap();queue_restore(&data,&archive);
        process_startup(&data,&config).await.unwrap();
        let mut db=connection(&path).await.unwrap();
        let held:(i64,String,i64)=sqlx::query_as("SELECT restore_hold,phase,inactive_import_id FROM connect_transfers").fetch_one(&mut db).await.unwrap();
        assert_eq!(held,(1,"reconciliation_required".into(),1));
        let prefix:(i64,i64,i64)=sqlx::query_as("SELECT next_sequence,next_offset,eof FROM connect_raw_prefix").fetch_one(&mut db).await.unwrap();
        assert_eq!(prefix,(1,2,0));
        assert_eq!(sqlx::query_scalar::<_,Vec<u8>>("SELECT data FROM connect_raw_chunks").fetch_one(&mut db).await.unwrap(),b"ab");
        assert!(sqlx::query("DELETE FROM e_inactive_fragments").execute(&mut db).await.is_err());
        assert_eq!(sqlx::query_scalar::<_,String>("SELECT mode FROM chat_admission_owners WHERE conversation_id='conversation'").fetch_one(&mut db).await.unwrap(),"restore_hold");
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
            20
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
        let (_temp,data,config)=tests::profile().await;
        let path=data.join("macro.db");
        let mut db=connection(&path).await.unwrap();
        assert_eq!(sqlx::query_scalar::<_,i64>("PRAGMA recursive_triggers").fetch_one(&mut db).await.unwrap(),1);
        assert_eq!(sqlx::query_scalar::<_,i64>("PRAGMA trusted_schema").fetch_one(&mut db).await.unwrap(),1);
        sqlx::raw_sql("INSERT INTO conversations(id,title,scope_mode,project_id,created_at,updated_at) VALUES('foreign','Foreign','Chat','project','t','t');
            INSERT INTO agent_runs(id,parent_conversation_id,agent_profile,depth,status,prompt,attempt_count,created_at,updated_at,started_at) VALUES('run','conversation','synthetic',1,'running','Synthetic',1,'t','t','t');
            INSERT INTO conversation_goals(goal_id,conversation_id,revision,objective,success_criteria_json,status,created_at,updated_at) VALUES('goal','conversation',1,'Synthetic','[]','auditing','t','t'),('foreign-goal','foreign',1,'Other','[]','active_ready','t','t');
            INSERT INTO conversation_goal_audits(audit_id,conversation_id,goal_id,goal_revision,executor_turn_id,current_run_id,status,created_at,updated_at) VALUES('audit','conversation','goal',1,'turn','run','running','t','t');
            INSERT INTO conversation_goal_audit_runs(audit_id,run_id,attempt,linked_at) VALUES('audit','run',1,'t');")
            .execute(&mut db).await.unwrap();
        db.close().await.unwrap();
        let archive=capture(&data,&config,BTreeMap::new(),true).await.unwrap();
        tests::queue_restore(&data,&archive);
        process_startup(&data,&config).await.unwrap();
        let status:BackupStatus=serde_json::from_slice(&fs::read(data.join("local-backup/status.json")).unwrap()).unwrap();
        assert_eq!(status.code,Some(BackupStatusCode::Restored));
        let pool=crate::db::create_pool(&path).await.unwrap();
        assert_eq!(sqlx::query_scalar::<_,String>("SELECT status FROM agent_runs WHERE id='run'").fetch_one(&pool).await.unwrap(),"interrupted");
        assert_eq!(sqlx::query_scalar::<_,String>("SELECT status FROM conversation_goals WHERE goal_id='goal'").fetch_one(&pool).await.unwrap(),"paused");
        assert_eq!(sqlx::query_scalar::<_,String>("SELECT mode FROM chat_admission_owners WHERE conversation_id='conversation'").fetch_one(&pool).await.unwrap(),"restore_hold");
        // These are the same official init_db reconcilers, now idempotent after
        // restore installed its hold. No ordinary writer is opened afterward.
        assert_eq!(crate::db::agent_runs::reconcile_active_agent_runs_after_restart(&pool).await.unwrap(),0);
        assert_eq!(crate::db::conversation_goals::reconcile_audits_after_restart(&pool).await.unwrap(),0);
        crate::db::tool_invocations::reconcile_pending_after_restart(&pool).await.unwrap();
        crate::db::chat_admission::reconcile_after_restart(&pool).await.unwrap();
        let owner=crate::core::db_state::DbPool::default();owner.set_ready(pool.clone()).await.unwrap();
        sqlx::query("UPDATE conversation_goals SET objective='Still writable' WHERE goal_id='foreign-goal'").execute(&pool).await.unwrap();
        assert!(sqlx::query("UPDATE conversation_goals SET objective='forbidden' WHERE goal_id='goal'").execute(&pool).await.is_err());
        owner.set_initializing().await;
        pool.close().await;
    }

    #[tokio::test]
    async fn exact_v15_v16_restore_preserves_inactive_bytes_and_holds_chat_before_ready() {
        for version in [15, 16] {
            let (_temp, data, config) = tests::profile().await;
            let path = data.join("macro.db");
            let mut db = connection(&path).await.unwrap();
            crate::db::chat_admission::remove_reference_schema_in(&mut db).await.unwrap();
            remove_reference_e_schema(&mut db, &(1..=version).collect::<Vec<_>>()).await.unwrap();
            sqlx::query("DELETE FROM schema_migrations WHERE version>?").bind(version).execute(&mut db).await.unwrap();
            // These are opaque stored bytes, not a portable-semantic fixture or
            // an authority to open E. Backup must preserve even an incomplete import.
            sqlx::raw_sql("INSERT INTO e_inactive_domain VALUES(1,1048576,8);
                INSERT INTO e_inactive_imports VALUES(1,printf('%064d',1),'{}',0,0,0,7,512,1,1,10000,1000,1,NULL);
                INSERT INTO e_inactive_records VALUES(1,0,'{}',0,NULL,NULL,NULL,NULL,7,0,x'',x'');
                INSERT INTO e_inactive_fragments VALUES(1,0,0,zeroblob(32),x'00010203feff00',7,7,1);")
                .execute(&mut db).await.unwrap();
            let source_version: Option<(String, i64)> = if version == 16 {
                Some(sqlx::query_as("SELECT incarnation,revision FROM e_source_version WHERE singleton=1").fetch_one(&mut db).await.unwrap())
            } else { None };
            db.close().await.unwrap();
            let before = fs::read(&path).unwrap();
            check_database(&path).await.unwrap();
            assert_eq!(fs::read(&path).unwrap(), before);
            let archive = capture(&data, &config, BTreeMap::new(), true).await.unwrap();
            tests::queue_restore(&data, &archive);
            process_startup(&data, &config).await.unwrap();
            let status: BackupStatus = serde_json::from_slice(&fs::read(data.join("local-backup/status.json")).unwrap()).unwrap();
            assert_eq!(status.code, Some(BackupStatusCode::Restored));
            let pool = crate::db::create_pool(&path).await.unwrap();
            assert_eq!(sqlx::query_scalar::<_,i64>("SELECT MAX(version) FROM schema_migrations").fetch_one(&pool).await.unwrap(),20);
            assert_eq!(sqlx::query_scalar::<_,String>("SELECT mode FROM chat_admission_owners WHERE conversation_id='conversation'").fetch_one(&pool).await.unwrap(),"restore_hold");
            assert_eq!(sqlx::query_scalar::<_,Vec<u8>>("SELECT data FROM e_inactive_fragments WHERE import_id=1").fetch_one(&pool).await.unwrap(),vec![0,1,2,3,254,255,0]);
            assert_eq!(sqlx::query_scalar::<_,String>("SELECT begin_json FROM e_inactive_imports WHERE id=1").fetch_one(&pool).await.unwrap(),"{}");
            assert_eq!(crate::db::repository::list_messages(&pool,"conversation").await.unwrap()[0].content,"Representative transcript");
            if let Some(expected) = source_version {
                assert_eq!(sqlx::query_as::<_,(String,i64)>("SELECT incarnation,revision FROM e_source_version WHERE singleton=1").fetch_one(&pool).await.unwrap(),expected);
            }
            let owner = crate::core::db_state::DbPool::default();
            owner.set_ready(pool.clone()).await.unwrap();
            assert!(sqlx::query("UPDATE messages SET content='forbidden' WHERE id='message'").execute(&pool).await.is_err());
            assert_eq!(crate::db::inactive_storage::InactiveStorage::closed(pool.clone()).begin(b"{}").await.unwrap_err(),"inactive_storage_disabled");
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
            20
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
    async fn connect_publication_backup_accepts_exact_pre019_and_rejects_missing019_guard() {
        let (_temp,data,_config)=tests::profile().await;
        let path=data.join("macro.db");
        let mut connection=connection(&path).await.unwrap();
        crate::db::connect_transfer::remove_publication_reference_in(&mut connection).await.unwrap();
        sqlx::query("DELETE FROM schema_migrations WHERE version>=19").execute(&mut connection).await.unwrap();
        connection.close().await.unwrap();
        check_database(&path).await.unwrap();
        let pool=crate::db::create_pool(&path).await.unwrap();
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT MAX(version) FROM schema_migrations").fetch_one(&pool).await.unwrap(),20);
        sqlx::query("DROP TRIGGER connect_preparation_metadata").execute(&pool).await.unwrap();pool.close().await;
        assert!(check_database(&path).await.is_err());
    }
}
