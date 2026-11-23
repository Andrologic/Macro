use super::*;
use crate::{
    architect_library::{migration, storage::Storage},
    db::{
        self,
        architect_library::{storage_index as index, VersionKey},
    },
};
use tokio::process::Command;

const BLUEPRINT: &str = "11111111-1111-4111-8111-111111111111";
const FAULT_ACTIONS: &[&str] = &[
    "crash",
    "EACCES",
    "ENOSPC",
    "EIO",
    "ENAMETOOLONG",
    "EEXIST",
    "persistent-EIO",
];
const CHILD_TEST: &str = "local_backup::fault_tests::fault_child";

fn extended() -> bool {
    std::env::var_os("MACRO_TEST_PROFILE_EXHAUSTIVE").is_some()
}

fn envelope(annexes: BTreeMap<String, String>) -> Vec<u8> {
    let source = serde_json::json!({
        "contract": "agsdl-0.4.0",
        "id": "qualification",
        "title": "Profile qualification",
        "agents": {
            "reviewer": {"harness": "codex", "permissions": "read-only", "instructions": "Review."}
        }
    });
    format!(
        " \r\n {} \r\n ",
        serde_json::json!({"source": source.to_string(), "annexes": annexes})
    )
    .into_bytes()
}

async fn seed(data: &Path, rows: &[(&str, &[u8])]) {
    let pool = db::create_pool(&data.join("macro.db")).await.unwrap();
    sqlx::query(
        "INSERT INTO architect_projects(id,name) VALUES ('project','Profile qualification')",
    )
    .execute(&pool)
    .await
    .unwrap();
    for (id, bytes) in rows {
        sqlx::query(
            "INSERT INTO architect_blueprints(id,project_id,name,last_number,document)
             VALUES (?,'project','Qualification',1,CAST(? AS TEXT))",
        )
        .bind(id)
        .bind(bytes)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO architect_versions(blueprint_id,number,revision,document)
             VALUES (?,1,1,CAST(? AS TEXT))",
        )
        .bind(id)
        .bind(bytes)
        .execute(&pool)
        .await
        .unwrap();
    }
    sqlx::query("INSERT INTO architect_legacy_import VALUES (1,?,0)")
        .bind(rows.len() as i64)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}

fn generated_envelopes() -> Vec<(Vec<u8>, bool)> {
    let mut cases = vec![
        (envelope(BTreeMap::new()), false),
        (
            envelope(BTreeMap::from([
                ("CON.md".into(), "reserved".into()),
                ("a-long~1.md".into(), "8.3 alias".into()),
                ("com¹.txt".into(), "reserved".into()),
                ("trailing.".into(), "invalid component".into()),
                ("Notes/A.md".into(), "directory spelling 1".into()),
                ("notes/B.md".into(), "directory spelling 2".into()),
                ("file.md".into(), "case 1".into()),
                ("File.md".into(), "case 2".into()),
                ("café.md".into(), "NFC".into()),
                ("cafe\u{301}.md".into(), "NFD".into()),
                ("x".repeat(256), "long component".into()),
                (vec!["x"; 65].join("/"), "deep".into()),
            ])),
            false,
        ),
        (
            envelope(BTreeMap::from([(
                "large.md".into(),
                "a".repeat(if extended() { 64 << 20 } else { 9 << 20 }),
            )])),
            false,
        ),
        // This member fits the relative-path grammar, but exceeds the
        // absolute staging budget even at a short profile root.
        (
            envelope(BTreeMap::from([(
                format!("{}/end.md", vec!["x".repeat(252); 16].join("/")),
                "overlong".into(),
            )])),
            cfg!(unix),
        ),
        (
            br#" {"source":1,"annexes":{},"future":[null,true]} "#.to_vec(),
            true,
        ),
    ];
    let base = envelope(BTreeMap::from([(
        "key-position".into(),
        "value-position".into(),
    )]));
    for field in [b"key-position".as_slice(), b"value-position"] {
        let start = base
            .windows(field.len())
            .position(|window| window == field)
            .unwrap();
        for offset in 0..field.len() {
            if extended() || [0, field.len() / 2, field.len() - 1].contains(&offset) {
                let mut invalid = base.clone();
                invalid[start + offset] = 0xff;
                cases.push((invalid, true));
            }
        }
    }
    let mut extra = envelope(BTreeMap::new());
    let end = extra.iter().rposition(|byte| *byte == b'}').unwrap();
    extra.splice(end..end, br#","future":{"number":123456789012345678901234567890,"exponent":1e999,"negativeZero":-0},"future":[true,null]"#.iter().copied());
    cases.push((extra, false));
    let mut missing: serde_json::Value =
        serde_json::from_slice(&envelope(BTreeMap::new())).unwrap();
    let mut source: serde_json::Value =
        serde_json::from_str(missing["source"].as_str().unwrap()).unwrap();
    source["agents"]["reviewer"]["instructions"] =
        serde_json::json!([{"uri": format!("{}/end.md", vec!["x".repeat(252); 16].join("/"))}]);
    missing["source"] = serde_json::Value::String(source.to_string());
    cases.push((serde_json::to_vec(&missing).unwrap(), true));
    cases
}

async fn assert_originals(data: &Path, rows: &[(&str, &[u8])]) {
    let pool = db::create_pool(&data.join("macro.db")).await.unwrap();
    let storage = Storage::new(data);
    for (id, expected) in rows {
        for number in [None, Some(1)] {
            let output = data
                .parent()
                .unwrap()
                .join(format!("original-{id}-{number:?}"));
            storage
                .export_original(&pool, (*id).into(), 1, number, &output)
                .await
                .unwrap();
            assert!(
                fs::read(&output).unwrap() == *expected,
                "original bytes changed for {id}/{number:?}"
            );
            fs::remove_file(output).unwrap();
        }
    }
    pool.close().await;
}

fn artifact_hashes(archive: &Archive) -> BTreeMap<String, (String, bool)> {
    archive
        .files
        .iter()
        .filter(|(name, _)| name.starts_with(ARCHITECT_FILES))
        .map(|(name, entry)| (name.clone(), (entry.sha256.clone(), entry.executable)))
        .collect()
}

fn assert_staging_empty(data: &Path) {
    assert!(!data.join("local-backup").join(EXPORT_STAGE).exists());
    for sibling in fs::read_dir(data.parent().unwrap()).unwrap() {
        assert!(!sibling
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".backup-"));
    }
    for path in [
        data.join("local-backup/staging"),
        data.join("architect-library/staging"),
    ] {
        if path.exists() {
            assert_eq!(
                fs::read_dir(&path).unwrap().count(),
                0,
                "{}",
                path.display()
            );
        }
    }
}

#[cfg(unix)]
fn assert_private_tree(root: &Path) {
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        fs::metadata(root).unwrap().permissions().mode() & 0o777,
        0o700,
        "{}",
        root.display()
    );
    for entry in fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        let meta = fs::symlink_metadata(&path).unwrap();
        assert_eq!(meta.permissions().mode() & 0o077, 0, "{}", path.display());
        if meta.is_dir() {
            assert_private_tree(&path);
        }
    }
}

#[tokio::test]
async fn generated_legacy_profiles_preserve_exact_originals() {
    let (_temp, data, config) = tests::profile().await;
    let cases = generated_envelopes();
    let ids: Vec<_> = (0..cases.len())
        .map(|n| format!("11111111-1111-4111-8111-{n:012}"))
        .collect();
    let rows: Vec<_> = ids
        .iter()
        .zip(&cases)
        .map(|(id, (bytes, _))| (id.as_str(), bytes.as_slice()))
        .collect();
    seed(&data, &rows).await;
    let raw_copy = data
        .parent()
        .unwrap()
        .join("local-backup")
        .join("large-step1.zip");
    fs::create_dir(raw_copy.parent().unwrap()).unwrap();
    // A cutover leaves free SQLite pages behind. Raw preservation must
    // round-trip those pages exactly, including the invalid UTF-8 rows.
    let raw = capture_raw(&data, &config, BTreeMap::new()).unwrap();
    assert!(raw.files["data/macro.db"].native.is_some());
    publish_new(&raw_copy, |file| bundle::write(&raw, file)).unwrap();
    drop(raw);
    let original_database = fs::read(data.join("macro.db")).unwrap();
    let preserved = load_archive(&raw_copy, &data).unwrap();
    apply_files(&preserved, &data, &config, true).unwrap();
    drop(preserved);
    assert_eq!(fs::read(data.join("macro.db")).unwrap(), original_database);
    let pool = open_and_migrate(&data).await.unwrap();
    let storage = Storage::new(&data);
    let after_first = index::artifact_references(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    assert!(migration::migrate(&pool, &storage).await.unwrap());
    let after_retry = index::artifact_references(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    assert_eq!(format!("{after_first:?}"), format!("{after_retry:?}"));
    for (id, (_, recovery)) in ids.iter().zip(&cases) {
        let row = index::draft_row(&pool, id).await.unwrap();
        let artifact = index::Artifact::from_row(&row, "id").unwrap();
        assert_eq!(
            artifact.state == index::StorageState::Recovery,
            *recovery,
            "{id}"
        );
        let key = VersionKey {
            blueprint_id: id.clone(),
            number: 1,
        };
        let row = index::version_row(&pool, &key).await.unwrap();
        let artifact = index::Artifact::from_row(&row, "blueprint_id").unwrap();
        assert_eq!(
            artifact.state == index::StorageState::Recovery,
            *recovery,
            "{id}"
        );
        if id == &ids[3] && *recovery {
            let repaired = storage
                .adapt_version(&pool, key, "project".into(), "Repair".into())
                .await
                .unwrap();
            let repaired = serde_json::to_value(repaired).unwrap();
            let repair_id = repaired
                .as_object()
                .unwrap()
                .get("id")
                .unwrap()
                .as_str()
                .unwrap();
            let output = data.parent().unwrap().join("repair-original.json");
            storage
                .export_original(&pool, repair_id.into(), 1, None, &output)
                .await
                .unwrap();
            assert_eq!(fs::read(output).unwrap(), cases[3].0);
        }
    }
    pool.close().await;
    assert_originals(&data, &rows).await;
    let archive = capture(&data, &config, BTreeMap::new(), true)
        .await
        .unwrap();
    let before = artifact_hashes(&archive);
    let (restored_temp, restored_data, restored_config) = tests::profile().await;
    let path = restored_temp.path().join("portable.zip");
    publish_new(&path, |file| bundle::write(&archive, file)).unwrap();
    drop(archive);
    let incoming = load_restore_archive(&path, &restored_data).await.unwrap();
    tests::queue_restore(&restored_data, &incoming);
    drop(incoming);
    process_startup(&restored_data, &restored_config)
        .await
        .unwrap();
    assert_originals(&restored_data, &rows).await;
    let after = capture_raw(&restored_data, &restored_config, BTreeMap::new()).unwrap();
    assert_eq!(before, artifact_hashes(&after));
    drop(after);
    assert_staging_empty(&restored_data);
    #[cfg(unix)]
    {
        assert_private_tree(&restored_data.join("architect-library"));
        assert_private_tree(&restored_data.join("local-backup"));
    }
    eprintln!(
        "{} adversarial draft/version pairs round-tripped",
        cases.len()
    );
}

#[tokio::test]
async fn desktop_opens_the_legacy_index_when_an_artifact_directory_is_unusable() {
    let (_temp, data, config) = tests::profile().await;
    let bytes = envelope(BTreeMap::new());
    let rows = [(BLUEPRINT, bytes.as_slice())];
    seed(&data, &rows).await;
    let storage = Storage::new(&data);
    let state = data
        .join("architect-library/blueprints")
        .join(BLUEPRINT)
        .join("drafts");
    fs::create_dir_all(state.parent().unwrap()).unwrap();
    fs::write(&state, b"not a directory").unwrap();
    let pool = open_and_migrate(&data).await.unwrap();
    assert!(!index::is_current(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap());
    assert!(migration::startup(&pool, &data).await.is_err());
    let legacy = capture(&data, &config, BTreeMap::new(), true)
        .await
        .unwrap();
    assert!(artifact_hashes(&legacy).is_empty());
    drop(legacy);
    fs::remove_file(state).unwrap();
    assert!(migration::migrate(&pool, &storage).await.unwrap());
    pool.close().await;
    assert_originals(&data, &rows).await;
}

#[cfg(unix)]
#[tokio::test]
async fn old_native_limit_path_can_be_restored_and_rolled_back() {
    use std::os::unix::ffi::OsStrExt;

    let (_temp, data, config) = tests::profile().await;
    let bytes = envelope(BTreeMap::new());
    seed(&data, &[(BLUEPRINT, &bytes)]).await;
    let pool = open_and_migrate(&data).await.unwrap();
    let storage = Storage::new(&data);
    let row = index::draft_row(&pool, BLUEPRINT).await.unwrap();
    let artifact = index::Artifact::from_row(&row, "id").unwrap();
    let root = storage.artifact_path(&artifact).join("project");
    pool.close().await;
    let length = libc::PATH_MAX as usize - root.as_os_str().as_bytes().len() - 2;
    let member: String = (1..=length)
        .map(|n| {
            if (n % 127 == 0 && n < length - 2) || n == length - 1 {
                '/'
            } else {
                'x'
            }
        })
        .collect();
    let old_path = root.join(&member);
    assert_eq!(
        old_path.as_os_str().as_bytes().len(),
        libc::PATH_MAX as usize - 1
    );
    assert!(!crate::fs::profile::fits_export_destination(&old_path));
    fs::create_dir_all(old_path.parent().unwrap()).unwrap();
    create_private_file(&old_path, false)
        .unwrap()
        .write_all(b"incoming")
        .unwrap();
    let incoming = capture(&data, &config, BTreeMap::new(), true)
        .await
        .unwrap();
    let path = data.parent().unwrap().join("portable.zip");
    publish_new(&path, |file| bundle::write(&incoming, file)).unwrap();
    drop(incoming);
    fs::write(&old_path, b"before restore").unwrap();
    let incoming = load_restore_archive(&path, &data).await.unwrap();
    tests::queue_restore(&data, &incoming);
    drop(incoming);
    run_fault(
        &data,
        &config,
        "restore",
        "write:library/project/",
        "crash",
        1,
    )
    .await;
    process_startup(&data, &config).await.unwrap();
    assert_eq!(fs::read(&old_path).unwrap(), b"before restore");
    let incoming = load_restore_archive(&path, &data).await.unwrap();
    tests::queue_restore(&data, &incoming);
    drop(incoming);
    process_startup(&data, &config).await.unwrap();
    assert_eq!(fs::read(&old_path).unwrap(), b"incoming");
    assert_staging_empty(&data);
}

#[test]
fn win32_path_budget_counts_utf16_and_directory_margin() {
    use crate::fs::profile::fits_win32;
    let units = |path: &str| path.encode_utf16().count();
    let allowed = "é".repeat(55) + &"🐈".repeat(80);
    assert_eq!(units(&allowed), 215);
    assert!(fits_win32(260, units(&allowed), 0));
    assert!(fits_win32(30_000, 29_999, 0));
    assert!(fits_win32(32_750, 32_748, 0));
    assert!(!fits_win32(32_750, 32_748, 44));
    assert!(!fits_win32(32_767, 32_748, 0));
}

async fn open_and_migrate(data: &Path) -> crate::db::DbResult<sqlx::SqlitePool> {
    let pool = db::open_desktop_profile(data).await?;
    if let Err(error) = crate::architect_library::migration::startup(&pool, data).await {
        tracing::warn!(%error, "Architect library cutover will retry");
    }
    Ok(pool)
}

#[derive(Debug, PartialEq, Eq)]
struct MigrationOutcome {
    blueprint: String,
    number: i64,
    state: index::StorageState,
    diagnostics: Vec<String>,
}

async fn migration_outcomes(pool: &sqlx::SqlitePool, data: &Path) -> Vec<MigrationOutcome> {
    // Each row retains its conversion diagnostics alongside the original bytes.
    // The messages in these fixtures are stable, so compare the whole diagnostic.
    let storage = Storage::new(data);
    let rows: Vec<(String, i64, String, String)> = sqlx::query_as(
        "SELECT rows.blueprint_id, rows.number, rows.storage_state, originals.artifact_id
         FROM (SELECT id AS blueprint_id, 0 AS number, revision, storage_state FROM architect_blueprints
               UNION ALL SELECT blueprint_id, number, revision, storage_state FROM architect_versions) AS rows
         JOIN architect_library_originals AS originals
         ON (rows.blueprint_id, rows.number, rows.revision) =
            (originals.blueprint_id, originals.version_number, originals.revision)
         ORDER BY 1, 2",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|(blueprint, number, state, original)| {
            let artifact = index::Artifact {
                blueprint_id: blueprint.clone(),
                id: uuid::Uuid::parse_str(&original).unwrap(),
                state: index::StorageState::Recovery,
                sha256: None,
            };
            let diagnostics =
                fs::read(storage.artifact_path(&artifact).join("diagnostics.json")).unwrap();
            MigrationOutcome {
                blueprint,
                number,
                state: index::StorageState::parse(&state).unwrap(),
                diagnostics: serde_json::from_slice(&diagnostics).unwrap(),
            }
        })
        .collect()
}

async fn assert_migration_recovery(
    legacy_data: &Path,
    expected: &[MigrationOutcome],
    data: &Path,
    config: &Path,
    point: &str,
    action: &str,
    nth: usize,
) {
    copy_fixture(legacy_data, data);
    run_fault(data, config, "migration", point, action, nth).await;
    let pool = db::open_desktop_profile(data).await.unwrap();
    assert!(migration::migrate(&pool, &Storage::new(data))
        .await
        .unwrap());
    assert_eq!(
        migration_outcomes(&pool, data).await,
        expected,
        "{point}/{nth}/{action}"
    );
    pool.close().await;
}

#[tokio::test]
async fn disk_full_during_migration_keeps_rows_retryable() {
    let (_temp, legacy_data, _) = tests::profile().await;
    let bytes = envelope(BTreeMap::from([("notes.md".into(), "original".into())]));
    let rows = [(BLUEPRINT, bytes.as_slice())];
    seed(&legacy_data, &rows).await;

    let temp = tempfile::tempdir().unwrap();
    let baseline = temp.path().join("baseline");
    copy_fixture(&legacy_data, &baseline);
    let pool = open_and_migrate(&baseline).await.unwrap();
    let expected = migration_outcomes(&pool, &baseline).await;
    assert_eq!(
        expected.iter().map(|row| row.state).collect::<Vec<_>>(),
        [index::StorageState::Draft, index::StorageState::Archive]
    );
    pool.close().await;

    let data = temp.path().join("data");
    let config = temp.path().join("config");
    assert_migration_recovery(
        &legacy_data,
        &expected,
        &data,
        &config,
        "write:/staging/.draft-",
        "ENOSPC",
        1,
    )
    .await;
    assert_originals(&data, &rows).await;
}

fn child_command(test: &str) -> Command {
    let mut child = Command::new(std::env::current_exe().unwrap());
    child
        .kill_on_drop(true)
        .args(["--exact", test, "--nocapture"]);
    child
}

async fn run_fault(data: &Path, config: &Path, mode: &str, point: &str, action: &str, nth: usize) {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        child_command(CHILD_TEST)
            .env("MACRO_TEST_PROFILE_DATA", data)
            .env("MACRO_TEST_PROFILE_CONFIG", config)
            .env("MACRO_TEST_PROFILE_MODE", mode)
            .env("MACRO_TEST_PROFILE_FAULT", point)
            .env("MACRO_TEST_PROFILE_FAULT_ACTION", action)
            .env("MACRO_TEST_PROFILE_FAULT_NTH", nth.to_string())
            .output(),
    )
    .await
    .unwrap_or_else(|_| panic!("Timed out at {mode}/{point}/{action}"))
    .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    let operation = point.split_once(':').unwrap().0;
    let errno = action.trim_start_matches("persistent-");
    assert!(
        stderr.contains(&format!("profile-fault: {operation} {errno} ")),
        "{mode}/{point}/{nth}/{action}: {stderr}\n{}",
        String::from_utf8_lossy(&output.stdout)
    );
    if action == "crash" {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(output.status.signal(), Some(libc::SIGKILL));
        }
        #[cfg(not(unix))]
        assert_eq!(output.status.code(), Some(79));
    } else {
        assert!(
            output.status.success(),
            "{mode}/{point}/{nth}/{action}: {stderr}\n{}",
            String::from_utf8_lossy(&output.stdout)
        );
    }
}

#[tokio::test]
async fn fault_child() {
    let Some(data) = std::env::var_os("MACRO_TEST_PROFILE_DATA").map(PathBuf::from) else {
        return;
    };
    let config = PathBuf::from(std::env::var_os("MACRO_TEST_PROFILE_CONFIG").unwrap());
    let mode = std::env::var("MACRO_TEST_PROFILE_MODE").unwrap();
    if mode == "migration" {
        let pool = open_and_migrate(&data).await.unwrap();
        let current = index::is_current(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM conversations")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
        if !current {
            let bytes: Vec<u8> = sqlx::query_scalar(
                "SELECT CAST(document AS BLOB) FROM architect_blueprints WHERE id=?",
            )
            .bind(BLUEPRINT)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(
                bytes,
                envelope(BTreeMap::from([("notes.md".into(), "original".into())]))
            );
        }
        pool.close().await;
        return;
    }
    let dir = data.join("local-backup");
    if mode == "stage" {
        let archive = bundle::load(&data.parent().unwrap().join("fixture.zip")).unwrap();
        stage_incoming(&dir, &archive).unwrap_err();
        assert!(!dir.join("request.json").exists());
        process_startup(&data, &config).await.unwrap();
        return;
    }

    let action = std::env::var("MACRO_TEST_PROFILE_FAULT_ACTION").unwrap();
    let attempts = if action.starts_with("persistent-") {
        2
    } else {
        1
    };
    for _ in 0..attempts {
        let startup = process_startup(&data, &config).await;
        let journal = dir.join("restoring.json");
        assert_eq!(
            startup.is_err(),
            journal.exists(),
            "startup/journal mismatch: {startup:?}"
        );
        if let Err(recovery) = startup {
            assert!(matches!(mode.as_str(), "restore" | "rollback"));
            assert!(!recovery.diagnostics.is_empty());
            assert!(recovery.preserved_archive.unwrap().is_file());
        } else {
            let pool = db::open_desktop_profile(&data).await.unwrap();
            assert_database(&pool).await;
            pool.close().await;
        }
    }
}

async fn assert_database(pool: &sqlx::SqlitePool) -> String {
    let title: String =
        sqlx::query_scalar("SELECT title FROM conversations WHERE id='conversation'")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT content FROM messages WHERE id='message'")
            .fetch_one(pool)
            .await
            .unwrap(),
        "Representative transcript"
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT value_json FROM app_settings WHERE key='agentCodeCheckpoints:conversation'"
        )
        .fetch_one(pool)
        .await
        .unwrap(),
        "{broken but preserved"
    );
    title
}

fn queue_export(data: &Path, path: &Path) {
    atomic(
        &data.join("local-backup/request.json"),
        &serde_json::to_vec(&Request {
            operation: "export".into(),
            path: path.to_str().unwrap().into(),
            browser: BTreeMap::new(),
        })
        .unwrap(),
    )
    .unwrap();
}

// Each entry names an actual filesystem operation and the affected path.
const FAULT_POINTS: &[(&str, &str, usize, &str)] = &[
    (
        "migration",
        "lock:data/architect-library/.lock",
        1,
        "EACCES",
    ),
    ("migration", "mkdir:/staging/.draft-", 1, "ENOSPC"),
    ("migration", "create:/staging/.draft-", 1, "EEXIST"),
    ("migration", "write:/staging/.draft-", 1, "ENOSPC"),
    ("migration", "sync-file:/staging/.recovery-", 1, "EIO"),
    ("migration", "rename:/versions/", 1, "crash"),
    ("migration", "sync-dir:/drafts", 1, "crash"),
    (
        "migration",
        "rename:/architect-library/migration/",
        2,
        "crash",
    ),
    (
        "migration",
        "remove-tree:/architect-library/migration",
        1,
        "persistent-EIO",
    ),
    (
        "export",
        "lock:data/local-backup/.lock",
        1,
        "persistent-EIO",
    ),
    (
        "export",
        "remove-tree:/staging/abandoned-export",
        1,
        "persistent-EIO",
    ),
    ("export", "mkdir:/local-backup/staging/b-", 1, "EACCES"),
    ("export", "write:/.backup-", 1, "crash"),
    ("export", "rename:/backup.zip", 1, "EIO"),
    (
        "export",
        "unlink:data/local-backup/export-staging.json",
        1,
        "crash",
    ),
    (
        "export",
        "write:data/local-backup/status.json",
        1,
        "persistent-EIO",
    ),
    ("invalid", "rename:/invalid-request-", 1, "persistent-EIO"),
    (
        "stage",
        "write:data/local-backup/incoming.json",
        1,
        "ENOSPC",
    ),
    (
        "stage",
        "sync-file:data/local-backup/incoming.json",
        1,
        "EIO",
    ),
    ("restore", "space:data/", 1, "ENOSPC"),
    ("restore", "write:/preserved-", 1, "ENOSPC"),
    ("restore", "rename:/preserved-", 1, "crash"),
    (
        "restore",
        "rename:data/local-backup/restoring.json",
        1,
        "EIO",
    ),
    (
        "restore",
        "rename:data/local-backup/restoring.json",
        2,
        "EIO",
    ),
    ("restore", "unlink:config/skills.json", 1, "EACCES"),
    (
        "restore",
        "unlink:data/direct-checkpoints/old.bin",
        1,
        "crash",
    ),
    ("restore", "write:library/project/notes.md", 1, "crash"),
    ("restore", "write:data/macro.db", 1, "persistent-EIO"),
    ("restore", "sync-file:data/macro.db", 1, "EIO"),
    ("restore", "sync-dir:library/project", 1, "EIO"),
    (
        "restore",
        "write:data/local-backup/status.json",
        1,
        "persistent-EIO",
    ),
    (
        "restore",
        "unlink:data/local-backup/restoring.json",
        1,
        "crash",
    ),
    (
        "rollback",
        "lock:data/local-backup/.lock",
        1,
        "persistent-EIO",
    ),
    ("rollback", "unlink:/project/new.md", 1, "persistent-EIO"),
    ("rollback", "write:data/state.json", 1, "ENOSPC"),
    (
        "rollback",
        "write:data/provider-secrets.json.v0.bak",
        1,
        "EIO",
    ),
    ("rollback", "write:config/skills.json", 1, "crash"),
    (
        "rollback",
        "rename:data/local-backup/status.json",
        1,
        "persistent-EIO",
    ),
    (
        "rollback",
        "unlink:data/local-backup/restoring.json",
        1,
        "EIO",
    ),
];

fn copy_fixture(source: &Path, target: &Path) {
    if source.is_dir() {
        storage::ensure_dir(target, target).unwrap();
        for entry in fs::read_dir(source).unwrap() {
            let entry = entry.unwrap();
            copy_fixture(&entry.path(), &target.join(entry.file_name()));
        }
    } else {
        fs::copy(source, target).unwrap();
    }
}

fn private_write(path: &Path, bytes: &[u8], executable: bool) {
    if path.exists() {
        fs::remove_file(path).unwrap();
    }
    create_private_file(path, executable)
        .unwrap()
        .write_all(bytes)
        .unwrap();
}

fn status_code(dir: &Path) -> Option<BackupStatusCode> {
    let bytes = fs::read(dir.join("status.json")).ok()?;
    serde_json::from_slice::<BackupStatus>(&bytes).unwrap().code
}

fn non_database_hashes(archive: &Archive) -> BTreeMap<&str, &str> {
    archive
        .files
        .iter()
        .filter(|(name, _)| {
            !DATABASE_ENTRIES.contains(&name.as_str())
                && name.as_str() != "data/provider-secrets.json"
        })
        .map(|(name, entry)| (name.as_str(), entry.sha256.as_str()))
        .collect()
}

#[tokio::test]
async fn generated_profile_recovers_from_io_faults_and_process_death() {
    let started = std::time::Instant::now();
    let bytes = envelope(BTreeMap::from([("notes.md".into(), "original".into())]));
    let alias = envelope(BTreeMap::from([
        ("a-long-name.md".into(), "named".into()),
        ("a-long~1.md".into(), "preserve alias".into()),
        ("ı.md".into(), "dotless".into()),
        ("I.md".into(), "dotted".into()),
    ]));
    let mut invalid = envelope(BTreeMap::from([("broken-key.md".into(), "opaque".into())]));
    let offset = invalid
        .windows(b"broken-key".len())
        .position(|part| part == b"broken-key")
        .unwrap();
    invalid[offset + 3] = 0xff;
    let rows = [
        (BLUEPRINT, bytes.as_slice()),
        ("11111111-1111-4111-8111-222222222222", invalid.as_slice()),
        ("11111111-1111-4111-8111-333333333333", alias.as_slice()),
    ];
    let (_legacy_temp, legacy_data, _) = tests::profile().await;
    seed(&legacy_data, &rows).await;
    let source = tempfile::tempdir().unwrap();
    let source_data = source.path().join("data");
    let source_config = source.path().join("config");
    create_private_root(&source_config).unwrap();
    copy_fixture(&legacy_data, &source_data);
    let pool = open_and_migrate(&source_data).await.unwrap();
    let expected_migration = migration_outcomes(&pool, &source_data).await;
    assert_eq!(expected_migration.len(), rows.len() * 2);
    let row = index::draft_row(&pool, BLUEPRINT).await.unwrap();
    let artifact = index::Artifact::from_row(&row, "id").unwrap();
    let project = Storage::new(&source_data)
        .artifact_path(&artifact)
        .join("project");
    let relative_project = project.strip_prefix(&source_data).unwrap();
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;

    let checkpoints = source_data.join("direct-checkpoints");
    create_private_root(&checkpoints).unwrap();
    private_write(&checkpoints.join("old.bin"), b"old checkpoint", false);
    private_write(
        &source_config.join("skills.json"),
        br#"{"$schema":"./schemas/v1/skills.schema.json","schemaVersion":1}"#,
        false,
    );
    private_write(
        &source_data.join("state.json"),
        br#"{"schemaVersion":1,"values":{"fixture":"original"}}"#,
        false,
    );
    private_write(
        &source_data.join("provider-secrets.json.v0.bak"),
        b"provider recovery bytes",
        false,
    );
    private_write(&project.join("run.sh"), b"#!/bin/sh\nexit 0\n", true);
    let original_tree = source.path().join("original");
    copy_fixture(&source_data, &original_tree);
    let original = capture_raw(&source_data, &source_config, BTreeMap::new()).unwrap();
    let original_hashes = non_database_hashes(&original);

    let incoming_config = source.path().join("incoming-config");
    create_private_root(&incoming_config).unwrap();
    private_write(
        &incoming_config.join("settings.json"),
        br#"{"$schema":"./schemas/v1/settings.schema.json","schemaVersion":1}"#,
        false,
    );
    private_write(
        &source_data.join("state.json"),
        br#"{"schemaVersion":1,"values":{"fixture":"incoming"}}"#,
        false,
    );
    fs::remove_file(checkpoints.join("old.bin")).unwrap();
    private_write(&checkpoints.join("new.bin"), b"incoming checkpoint", false);
    private_write(&project.join("notes.md"), b"incoming", false);
    private_write(&project.join("new.md"), b"incoming-only member", false);
    let pool = db::open_desktop_profile(&source_data).await.unwrap();
    sqlx::query("UPDATE conversations SET title='Incoming' WHERE id='conversation'")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let incoming = capture(&source_data, &incoming_config, BTreeMap::new(), true)
        .await
        .unwrap();
    let incoming_hashes = non_database_hashes(&incoming);
    let fixture = source.path().join("fixture.zip");
    publish_new(&fixture, |file| bundle::write(&incoming, file)).unwrap();

    let marker = RestoreJournal {
        preserved: format!("preserved-{}.zip", uuid::Uuid::new_v4()),
        phase: RestorePhase::Rollback,
    };
    let mut total = 0;
    for &(mode, point, nth, default_action) in FAULT_POINTS {
        let actions = if extended() {
            FAULT_ACTIONS
        } else {
            std::slice::from_ref(&default_action)
        };
        for &action in actions {
            let temp = tempfile::tempdir().unwrap();
            let data = temp.path().join("data");
            let config = temp.path().join("config");
            create_private_root(&config).unwrap();
            if mode == "migration" {
                assert_migration_recovery(
                    &legacy_data,
                    &expected_migration,
                    &data,
                    &config,
                    point,
                    action,
                    nth,
                )
                .await;
                assert_originals(&data, &rows).await;
            } else {
                copy_fixture(&original_tree, &data);
                copy_fixture(&source_config, &config);
                let dir = data.join("local-backup");
                create_private_root(&dir).unwrap();
                let output = temp.path().join("backup.zip");
                match mode {
                    "export" => {
                        create_private_root(&dir.join("staging/abandoned-export")).unwrap();
                        queue_export(&data, &output);
                    }
                    "invalid" => {
                        private_write(&dir.join("request.json"), b"{broken request", false)
                    }
                    "stage" => {
                        fs::copy(&fixture, temp.path().join("fixture.zip")).unwrap();
                    }
                    "restore" => tests::queue_restore(&data, &incoming),
                    "rollback" => {
                        preserve_raw(&original, &preserved_path(&dir, &marker).unwrap()).unwrap();
                        atomic(
                            &dir.join("restoring.json"),
                            &serde_json::to_vec(&marker).unwrap(),
                        )
                        .unwrap();
                        private_write(
                            &data.join(relative_project).join("notes.md"),
                            b"interrupted restore",
                            false,
                        );
                        private_write(
                            &data.join(relative_project).join("new.md"),
                            b"incoming-only member",
                            false,
                        );
                        private_write(
                            &data.join("direct-checkpoints/new.bin"),
                            b"incoming checkpoint",
                            false,
                        );
                        private_write(&config.join("settings.json"), b"{}", false);
                    }
                    _ => unreachable!(),
                }
                run_fault(&data, &config, mode, point, action, nth).await;
                process_startup(&data, &config).await.unwrap();
                assert!(!dir.join("restoring.json").exists(), "{point}/{action}");
                let final_status = status_code(&dir);
                if mode == "export" {
                    assert!(matches!(
                        final_status,
                        None | Some(BackupStatusCode::Exported | BackupStatusCode::Failed)
                    ));
                    if !output.exists() {
                        queue_export(&data, &output);
                        process_startup(&data, &config).await.unwrap();
                        assert_eq!(
                            status_code(&dir),
                            Some(BackupStatusCode::Exported),
                            "{point}/{action}: {}",
                            fs::read_to_string(dir.join("status.json")).unwrap_or_default()
                        );
                    }
                    let archive = load_restore_archive(&output, &data).await.unwrap();
                    assert_eq!(artifact_hashes(&archive), artifact_hashes(&original));
                }
                let recovered = capture_raw(&data, &config, BTreeMap::new()).unwrap();
                let actual = non_database_hashes(&recovered);
                match mode {
                    "restore" if final_status == Some(BackupStatusCode::Restored) => {
                        assert_eq!(actual, incoming_hashes, "{point}/{action}")
                    }
                    "restore" => {
                        assert!(matches!(
                            final_status,
                            Some(BackupStatusCode::Failed | BackupStatusCode::RolledBack)
                        ));
                        assert_eq!(actual, original_hashes, "{point}/{action}");
                    }
                    "rollback" => {
                        assert_eq!(final_status, Some(BackupStatusCode::RolledBack));
                        assert_eq!(actual, original_hashes, "{point}/{action}");
                    }
                    "invalid" => {
                        assert_eq!(final_status, Some(BackupStatusCode::InvalidRequest));
                        assert_eq!(actual, original_hashes);
                    }
                    _ => assert_eq!(actual, original_hashes, "{point}/{action}"),
                }
                drop(recovered);
                let pool = db::open_desktop_profile(&data).await.unwrap();
                let expected_title = if final_status == Some(BackupStatusCode::Restored) {
                    "Incoming"
                } else {
                    "Original"
                };
                assert_eq!(
                    assert_database(&pool).await,
                    expected_title,
                    "{point}/{action}"
                );
                pool.close().await;
                assert_originals(&data, &rows).await;
            }
            assert_staging_empty(&data);
            #[cfg(unix)]
            assert_private_tree(&data);
            total += 1;
        }
    }
    eprintln!("{total} filesystem fault cases in {:?}", started.elapsed());
}

#[test]
fn restore_space_check_counts_preservation_and_both_volumes() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    let config = temp.path().join("config");
    fs::create_dir(&data).unwrap();
    let archive = |data_size, config_size| {
        let mut files = BTreeMap::new();
        add_file(&mut files, "data/state.json".into(), vec![0; data_size]).unwrap();
        add_file(
            &mut files,
            "config/settings.json".into(),
            vec![0; config_size],
        )
        .unwrap();
        Archive {
            format: String::new(),
            version: 0,
            app_version: String::new(),
            files,
            browser: BTreeMap::new(),
            browser_sha256: String::new(),
        }
    };
    let incoming = archive(4097, 1);
    let original = archive(1, 4097);
    let check = |data_bytes, config_bytes| {
        check_restore_space(&incoming, &original, &data, &config, |path| {
            if path == data {
                Ok(data_bytes)
            } else {
                assert_eq!(path, temp.path());
                Ok(config_bytes)
            }
        })
    };

    const DATA_REQUIRED: u64 = 7 * 4096;
    const CONFIG_REQUIRED: u64 = 2 * 4096;
    let error = "Insufficient free disk space to restore and recover the profile";
    assert_eq!(
        check(DATA_REQUIRED - 1, CONFIG_REQUIRED + 1).unwrap_err(),
        error
    );
    assert_eq!(
        check(DATA_REQUIRED + 1, CONFIG_REQUIRED - 1).unwrap_err(),
        error
    );
    assert!(check(DATA_REQUIRED, CONFIG_REQUIRED).is_ok());
    assert!(check(DATA_REQUIRED + 1, CONFIG_REQUIRED + 1).is_ok());
}

#[tokio::test]
async fn profile_fault_assertions_detect_deliberate_mutations() {
    let mutations = [
        ("skip-rollback-pruning", "local_backup::tests::architect_library_rollback_removes_unpublished_files_before_next_restore"),
        ("ignore-recovery-error", "local_backup::qualification::unreadable_journal_blocks_profile_even_when_backup_lock_fails"),
        ("skip-member-checksum", "local_backup::qualification::damaged_preservation_blocks_recovery_and_retains_journal_for_retry"),
        ("classify-disk-full-as-permanent", "local_backup::fault_tests::disk_full_during_migration_keeps_rows_retryable"),
        ("skip-restore-space-check", "local_backup::fault_tests::restore_space_check_counts_preservation_and_both_volumes"),
        #[cfg(unix)]
        ("reject-symlinked-profile-root", "local_backup::fault_tests::relocated_profile_opens_and_exports_through_symlinks"),
    ];
    for (mutation, test) in mutations {
        let control = child_command(test)
            .env_remove("MACRO_TEST_PROFILE_MUTATION")
            .output()
            .await
            .unwrap();
        assert!(
            control.status.success(),
            "{test} control: {}\n{}",
            String::from_utf8_lossy(&control.stdout),
            String::from_utf8_lossy(&control.stderr)
        );
        let output = child_command(test)
            .env("MACRO_TEST_PROFILE_MUTATION", mutation)
            .output()
            .await
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(101),
            "{mutation}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains(&format!("{test} ... FAILED")));
        eprintln!("Detected mutation {mutation}");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn relocated_profile_opens_and_exports_through_symlinks() {
    use std::os::unix::fs::{symlink, PermissionsExt};

    let (temp, data, config) = tests::profile().await;
    let linked_root = temp.path().join("linked-data");
    symlink(&data, &linked_root).unwrap();
    let linked_parent = temp.path().join("linked-parent");
    symlink(temp.path(), &linked_parent).unwrap();
    let linked_ancestor = linked_parent.join(data.file_name().unwrap());

    for (index, relocated) in [&linked_root, &linked_ancestor].into_iter().enumerate() {
        fs::set_permissions(&data, fs::Permissions::from_mode(0o775)).unwrap();
        let out = temp.path().join(format!("relocated-{index}.zip"));
        create_private_root(&data.join("local-backup")).unwrap();
        queue_export(relocated, &out);
        process_startup(relocated, &config).await.unwrap();
        assert_eq!(
            status_code(&data.join("local-backup")),
            Some(BackupStatusCode::Exported),
            "{}",
            fs::read_to_string(data.join("local-backup/status.json")).unwrap_or_default()
        );
        assert!(out.is_file());
        let pool = db::open_desktop_profile(relocated).await.unwrap();
        pool.close().await;
        assert_eq!(
            fs::metadata(&data).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    let database = data.join("macro.db");
    let outside = temp.path().join("external.db");
    fs::rename(&database, &outside).unwrap();
    let external_mode = fs::metadata(&outside).unwrap().permissions().mode();
    symlink(&outside, &database).unwrap();
    assert!(db::open_desktop_profile(&linked_root).await.is_err());
    assert_eq!(
        fs::metadata(&outside).unwrap().permissions().mode(),
        external_mode
    );
}

#[cfg(unix)]
#[tokio::test]
async fn opening_legacy_profile_restricts_root_database_and_sqlite_sidecars() {
    use std::os::unix::fs::PermissionsExt;

    let (_temp, data, _) = tests::profile().await;
    fs::set_permissions(&data, fs::Permissions::from_mode(0o775)).unwrap();
    let writer = db::open_desktop_profile(&data).await.unwrap();
    sqlx::query("UPDATE conversations SET title='Active WAL'")
        .execute(&writer)
        .await
        .unwrap();
    for name in ["macro.db", "macro.db-wal", "macro.db-shm"] {
        fs::set_permissions(data.join(name), fs::Permissions::from_mode(0o644)).unwrap();
    }
    fs::set_permissions(&data, fs::Permissions::from_mode(0o775)).unwrap();
    let reopened = db::open_desktop_profile(&data).await.unwrap();
    assert_eq!(assert_database(&reopened).await, "Active WAL");
    assert_private_tree(&data);
    for name in ["macro.db", "macro.db-wal", "macro.db-shm"] {
        assert_eq!(
            fs::metadata(data.join(name)).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    reopened.close().await;
    writer.close().await;
}

#[tokio::test]
#[ignore = "500 blueprints and 10 versions each; run in release for timing"]
async fn profile_scale() {
    use std::time::Instant;

    let (temp, data, config) = tests::profile().await;
    let pool = db::open_desktop_profile(&data).await.unwrap();
    let document = envelope(BTreeMap::from([
        ("notes.md".into(), "qualification".repeat(100)),
        ("docs/reference.txt".into(), "reference".repeat(100)),
    ]));
    sqlx::query("INSERT INTO architect_projects (id,name) VALUES ('project','Benchmark')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<500)
         INSERT INTO architect_blueprints(id,project_id,name,last_number,document)
         SELECT printf('11111111-1111-4111-8111-%012d',i),'project','Blueprint',10,CAST(? AS TEXT) FROM n"
    ).bind(&document).execute(&pool).await.unwrap();
    sqlx::query(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10)
         INSERT INTO architect_versions(blueprint_id,number,revision,document)
         SELECT id,i,1,document FROM architect_blueprints CROSS JOIN n",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO architect_legacy_import VALUES (1,500,0)")
        .execute(&pool)
        .await
        .unwrap();
    let start = Instant::now();
    assert!(migration::migrate(&pool, &Storage::new(&data))
        .await
        .unwrap());
    let migration = start.elapsed();
    eprintln!("500×10 migration {migration:?}");
    pool.close().await;

    let start = Instant::now();
    let archive = capture(&data, &config, BTreeMap::new(), true)
        .await
        .unwrap();
    let capture_time = start.elapsed();
    let start = Instant::now();
    validate(&archive, &data).await.unwrap();
    let validate_time = start.elapsed();
    eprintln!("500×10 export capture {capture_time:?}, validation {validate_time:?}");
    let path = temp.path().join("benchmark.zip");
    publish_new(&path, |file| bundle::write(&archive, file)).unwrap();
    drop(archive);

    let start = Instant::now();
    let incoming = load_restore_archive(&path, &data).await.unwrap();
    let load = start.elapsed();
    eprintln!("500×10 restore input validation {load:?}");
    tests::queue_restore(&data, &incoming);
    drop(incoming);
    let start = Instant::now();
    process_startup(&data, &config).await.unwrap();
    let restore = start.elapsed();
    assert_eq!(
        status_code(&data.join("local-backup")),
        Some(BackupStatusCode::Restored)
    );
    let restored = db::open_desktop_profile(&data).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM architect_versions")
            .fetch_one(&restored)
            .await
            .unwrap(),
        5000
    );
    restored.close().await;
    eprintln!(
        "500×10, {} byte envelopes, {} byte ZIP: migration {migration:?}, export capture {capture_time:?}, export validation {validate_time:?}, restore input validation {load:?}, restore startup {restore:?}",
        document.len(), fs::metadata(path).unwrap().len()
    );
}
