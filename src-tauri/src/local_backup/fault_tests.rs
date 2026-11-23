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
const FAULT_ACTIONS: &[&str] = &["EACCES", "ENOSPC", "EIO", "ENAMETOOLONG"];
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
            true,
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
    let pool = db::open_desktop_profile(&data).await.unwrap();
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
        if id == &ids[3] {
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
    let pool = db::open_desktop_profile(&data).await.unwrap();
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
    let pool = db::open_desktop_profile(&data).await.unwrap();
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
    assert!(!crate::fs::profile::admits_file(&old_path));
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
        "backup",
        "restore.architect_written",
        "crash",
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
    assert!(!fits_win32(216, units(&allowed), 44));
    assert!(fits_win32(259, units(&allowed) - 1, 44));
    assert!(!fits_win32(260, units(&allowed) - 1, 44));
    assert!(fits_win32(250, 248, 0));
    assert!(!fits_win32(251, 249, 0));
}

async fn run_fault(data: &Path, config: &Path, mode: &str, point: &str, action: &str) {
    let child = Command::new(std::env::current_exe().unwrap())
        .kill_on_drop(true)
        .args(["--exact", CHILD_TEST, "--nocapture"])
        .env("MACRO_TEST_PROFILE_DATA", data)
        .env("MACRO_TEST_PROFILE_CONFIG", config)
        .env("MACRO_TEST_PROFILE_MODE", mode)
        .env("MACRO_TEST_PROFILE_FAULT", point)
        .env("MACRO_TEST_PROFILE_FAULT_ACTION", action)
        .output();
    let output = tokio::time::timeout(std::time::Duration::from_secs(45), child)
        .await
        .unwrap_or_else(|_| panic!("Timed out at {point}/{action}"))
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains(&format!("profile-fault: {point} {action}")),
        "{point}/{action}: {stderr}\n{}",
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
            "{point}/{action}: {stderr}\n{}",
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
        let pool = db::open_desktop_profile(&data).await.unwrap();
        let current = index::is_current(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap();
        let committed =
            std::env::var("MACRO_TEST_PROFILE_FAULT").as_deref() == Ok("migration.after_commit");
        assert_eq!(current, committed);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM conversations")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
        if !committed {
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
    } else {
        let _ = process_startup(&data, &config).await;
    }
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

const FAULT_POINTS: &[(&str, &[&str])] = &[
    (
        "migration",
        &[
            "migration.locked",
            "migration.reclaimed",
            "migration.row_read",
            "migration.stage_created",
            "migration.files_written",
            "migration.before_publish",
            "migration.after_rename",
            "migration.after_publish",
            "migration.recovery_stage_created",
            "migration.recovery_written",
            "migration.before_archive_publish",
            "migration.after_archive_publish",
            "migration.rows_planned",
            "migration.before_commit",
            "migration.after_commit",
        ],
    ),
    (
        "export",
        &[
            "backup.stage_created",
            "backup.database_captured",
            "backup.artifact_captured",
            "backup.before_export",
            "backup.export_created",
            "backup.export_written",
            "backup.after_export",
        ],
    ),
    (
        "restore",
        &[
            "restore.incoming_validated",
            "restore.rollback_preserved",
            "restore.journal_written",
            "restore.before_prune",
            "restore.after_prune",
            "restore.removed_file",
            "restore.created_file",
            "restore.architect_written",
            "restore.files_written",
            "restore.before_publish_status",
            "restore.before_install_hold",
            "restore.before_remove_journal",
        ],
    ),
    (
        "rollback",
        &[
            "rollback.archive_loaded",
            "rollback.before_prune",
            "rollback.after_prune",
            "rollback.removed_file",
            "rollback.created_file",
            "rollback.architect_written",
            "rollback.files_written",
            "rollback.before_install_hold",
            "rollback.before_remove_journal",
        ],
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

#[tokio::test]
async fn generated_profile_recovers_from_io_faults_and_process_death() {
    let started = std::time::Instant::now();
    let bytes = envelope(BTreeMap::from([("notes.md".into(), "original".into())]));
    let mut invalid = envelope(BTreeMap::from([("broken-key.md".into(), "opaque".into())]));
    let offset = invalid
        .windows(b"broken-key".len())
        .position(|part| part == b"broken-key")
        .unwrap();
    invalid[offset + 3] = 0xff;
    let rows = [
        (BLUEPRINT, bytes.as_slice()),
        ("11111111-1111-4111-8111-222222222222", invalid.as_slice()),
    ];
    let (_legacy_temp, legacy_data, _) = tests::profile().await;
    seed(&legacy_data, &rows).await;
    let source = tempfile::tempdir().unwrap();
    let source_data = source.path().join("data");
    let source_config = source.path().join("config");
    fs::create_dir(&source_config).unwrap();
    copy_fixture(&legacy_data, &source_data);
    let pool = db::open_desktop_profile(&source_data).await.unwrap();
    let row = index::draft_row(&pool, BLUEPRINT).await.unwrap();
    let artifact = index::Artifact::from_row(&row, "id").unwrap();
    let notes = Storage::new(&source_data)
        .artifact_path(&artifact)
        .join("project/notes.md");
    let relative_notes = notes.strip_prefix(&source_data).unwrap();
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let original = capture_raw(&source_data, &source_config, BTreeMap::new()).unwrap();
    let original_hashes = artifact_hashes(&original);
    fs::write(&notes, b"incoming").unwrap();
    let incoming = capture(&source_data, &source_config, BTreeMap::new(), true)
        .await
        .unwrap();
    let incoming_hashes = artifact_hashes(&incoming);
    fs::write(&notes, b"original").unwrap();
    let marker = RestoreJournal {
        preserved: format!("preserved-{}.zip", uuid::Uuid::new_v4()),
        phase: RestorePhase::Rollback,
    };
    let mut total = 0;
    for &(mode, points) in FAULT_POINTS {
        for (ordinal, &point) in points.iter().enumerate() {
            let errors = if extended() {
                FAULT_ACTIONS
            } else if ordinal < FAULT_ACTIONS.len() {
                &FAULT_ACTIONS[ordinal..][..1]
            } else {
                &[]
            };
            for action in std::iter::once("crash").chain(errors.iter().copied()) {
                let temp = tempfile::tempdir().unwrap();
                let data = temp.path().join("data");
                let config = temp.path().join("config");
                fs::create_dir(&config).unwrap();
                if mode == "migration" {
                    copy_fixture(&legacy_data, &data);
                    run_fault(&data, &config, mode, point, action).await;
                    let pool = db::open_desktop_profile(&data).await.unwrap();
                    assert!(migration::migrate(&pool, &Storage::new(&data))
                        .await
                        .unwrap());
                    pool.close().await;
                    assert_originals(&data, &rows).await;
                } else {
                    fs::create_dir(&data).unwrap();
                    copy_fixture(&source_data.join("macro.db"), &data.join("macro.db"));
                    copy_fixture(
                        &source_data.join("architect-library"),
                        &data.join("architect-library"),
                    );
                    let dir = data.join("local-backup");
                    let output = temp.path().join("backup.zip");
                    match mode {
                        "export" => queue_export(&data, &output),
                        "restore" => tests::queue_restore(&data, &incoming),
                        "rollback" => {
                            fs::create_dir_all(&dir).unwrap();
                            preserve_raw(&original, &preserved_path(&dir, &marker).unwrap())
                                .unwrap();
                            atomic(
                                &dir.join("restoring.json"),
                                &serde_json::to_vec(&marker).unwrap(),
                            )
                            .unwrap();
                            fs::write(data.join(relative_notes), b"interrupted restore").unwrap();
                        }
                        _ => unreachable!(),
                    }
                    run_fault(&data, &config, "backup", point, action).await;
                    process_startup(&data, &config).await.unwrap();
                    assert!(!dir.join("restoring.json").exists(), "{point}/{action}");
                    if mode == "export" {
                        if !output.exists() {
                            queue_export(&data, &output);
                            process_startup(&data, &config).await.unwrap();
                        }
                        let archive = load_restore_archive(&output, &data).await.unwrap();
                        assert_eq!(artifact_hashes(&archive), original_hashes);
                    }
                    let recovered = capture_raw(&data, &config, BTreeMap::new()).unwrap();
                    let actual = artifact_hashes(&recovered);
                    assert!(
                        actual == original_hashes
                            || (mode == "restore" && actual == incoming_hashes),
                        "mixed profile after {point}/{action}"
                    );
                    drop(recovered);
                    assert_originals(&data, &rows).await;
                }
                assert_staging_empty(&data);
                #[cfg(unix)]
                {
                    assert_private_tree(&data.join("architect-library"));
                    if data.join("local-backup").exists() {
                        assert_private_tree(&data.join("local-backup"));
                    }
                }
                total += 1;
            }
        }
    }
    eprintln!("{total} filesystem fault cases in {:?}", started.elapsed());
}
