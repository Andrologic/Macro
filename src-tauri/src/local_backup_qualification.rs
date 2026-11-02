//! Native qualification only: no AppHandle, WebView, provider traffic or production fault hook.
use super::tests::{profile, queue_restore};
use super::*;

fn browser_fixture(label: &str) -> BTreeMap<String, String> {
    BTreeMap::from([
        (
            "macro_chat_message_images".into(),
            format!(
                r#"{{"message":[{{"id":"image-{label}","mimeType":"image/png","dataUrl":"data:image/png;base64,YQ==","createdAt":"2026-10-13"}}]}}"#
            ),
        ),
        (
            "macro_chat_composer_drafts_v1".into(),
            format!(r#"{{"conversation":"draft-{label}"}}"#),
        ),
        ("macro_chat_questionnaire_drafts".into(), "{}".into()),
        (
            "macro_chat_queued_submissions_v1".into(),
            format!(
                r#"[{{"id":"queue-{label}","conversationId":"conversation","turnId":"turn-{label}","input":{{"content":"instruction-{label}"}}}}]"#
            ),
        ),
        (
            "macro_chat_unsaved_assistant_responses_v1".into(),
            format!(
                r#"{{"fallback":{{"id":"fallback","conversationId":"conversation","content":"answer-{label}"}}}}"#
            ),
        ),
        (
            "agentCodeCheckpoints:conversation".into(),
            format!("checkpoint-{label}"),
        ),
        (
            "agentCodeReplayRecovery:conversation".into(),
            format!("replay-{label}"),
        ),
    ])
}

// Optional proof export, confined to an explicitly assigned directory. Source profiles remain temporary.
fn proof(name: &str, bytes: &[u8]) {
    if let Some(root) = std::env::var_os("MACRO_BACKUP_PROOF_DIR") {
        fs::write(PathBuf::from(root).join(name), bytes).unwrap();
    }
}
fn status(data: &Path) -> BackupStatus {
    serde_json::from_slice(&fs::read(data.join("local-backup/status.json")).unwrap()).unwrap()
}
// Startup now joins policy initialization. Compare every credential, including raw
// legacy session fields, separately from the fresh epoch and migration journal.
fn assert_initialized_policy(actual: &Archive, expected: &Archive) {
    use serde_json::{json, Value};
    let decode = |entry: &Entry| -> Value {
        serde_json::from_slice(&STANDARD.decode(&entry.data).unwrap()).unwrap()
    };
    let current = decode(&actual.files["data/provider-secrets.json"]);
    let previous = expected.files.get("data/provider-secrets.json").map(decode)
        .unwrap_or_else(|| json!({}));
    assert_eq!(current.as_object().unwrap().len(), 4);
    assert_eq!(current["version"], 2);
    assert!(!uuid::Uuid::parse_str(current["policyEpoch"].as_str().unwrap()).unwrap().is_nil());
    assert_ne!(current["policyEpoch"], previous["policyEpoch"]);
    assert_eq!(current["namespaces"].as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>(),
        ["mcp", "providers", "speech", "system", "webSearch"]);
    let flatten = |value: &Value| {
        let mut entries = BTreeMap::new();
        for map in value.get("api_keys").into_iter().chain(
            value.get("namespaces").and_then(Value::as_object).into_iter().flat_map(|maps| maps.values())) {
            for (id, secret) in map.as_object().unwrap() {
                assert!(secret.is_string());
                assert!(entries.insert(id.clone(), secret.clone()).is_none());
            }
        }
        entries
    };
    assert_eq!(flatten(&current), flatten(&previous));
    assert_eq!(current["chatgpt_sessions"], previous.get("chatgpt_sessions").cloned().unwrap_or_else(|| json!({})));
    assert!(!actual.files.contains_key("data/provider-secrets.migration-pending.json"));
    if let Some(entry) = expected.files.get("data/provider-secrets.migration-pending.json") {
        let journal = decode(entry);
        let backup = format!("data/{}", journal["backup_file"].as_str().unwrap());
        assert_eq!(hash(&STANDARD.decode(&expected.files[&backup].data).unwrap()), journal["source_sha256"].as_str().unwrap());
        assert_eq!(actual.files[&backup].data, expected.files[&backup].data);
    }
}

fn assert_startup_files(actual: &Archive, expected: &Archive, held_database: bool) {
    assert_initialized_policy(actual, expected);
    let ordinary = |name: &&String| name.as_str() != "data/provider-secrets.json"
        && name.as_str() != "data/provider-secrets.migration-pending.json";
    assert_eq!(actual.files.keys().filter(ordinary).collect::<Vec<_>>(),
        expected.files.keys().filter(ordinary).collect::<Vec<_>>());
    for (name, entry) in &expected.files {
        if ordinary(&name) && !(held_database && name == "data/macro.db") {
            assert_eq!(actual.files[name].data, entry.data, "{name}");
        }
    }
}
fn assert_raw_files(actual: &Archive, expected: &Archive) {
    assert_startup_files(actual, expected, false);
}

// Restore changes local ownership and uncertain work; policy initialization
// rotates authority. Every other SQL value and managed file remains identical.
pub(super) async fn assert_held_files(actual: &Archive, expected: &Archive) {
    use sqlx::Row;
    assert_startup_files(actual, expected, true);
    let temp = tempfile::tempdir().unwrap();
    let mut snapshots = Vec::new();
    for (label, archive) in [("actual", actual), ("expected", expected)] {
        let path = temp.path().join(format!("{label}.db"));
        fs::write(
            &path,
            STANDARD
                .decode(&archive.files["data/macro.db"].data)
                .unwrap(),
        )
        .unwrap();
        let mut db = connection(&path).await.unwrap();
        let tables: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetch_all(&mut db).await.unwrap();
        let mut snapshot = BTreeMap::new();
        for table in tables {
            let columns: Vec<String> =
                sqlx::query_scalar("SELECT name FROM pragma_table_info(?) ORDER BY cid")
                    .bind(&table)
                    .fetch_all(&mut db)
                    .await
                    .unwrap();
            let projections: Vec<String> = columns.iter().map(|column| {
                let expression = match (label, table.as_str(), column.as_str()) {
                    ("expected", "chat_admission_owners", "mode") => "CASE WHEN mode IN ('open','frozen') THEN 'restore_hold' ELSE mode END".into(),
                    ("expected", "chat_admission_owners", "revision") => "revision+CASE WHEN mode IN ('open','frozen') THEN 1 ELSE 0 END".into(),
                    ("expected", "chat_admission_owners", "browser_reconciled") => "CASE WHEN mode IN ('open','frozen') THEN 0 ELSE browser_reconciled END".into(),
                    ("expected", "chat_admission_owners", "runtime_generation") => "CASE WHEN mode IN ('open','frozen') THEN NULL ELSE runtime_generation END".into(),
                    ("expected", "chat_admission_operations", "phase") => "CASE WHEN phase IN ('prepared','dispatched') THEN 'unknown' ELSE phase END".into(),
                    ("expected", "chat_admission_operations", "revision") => "revision+CASE WHEN phase IN ('prepared','dispatched') THEN 1 ELSE 0 END".into(),
                    _ => format!("\"{}\"", column.replace('"', "\"\"")),
                };
                format!("typeof({expression}) || ':' || hex(CAST({expression} AS BLOB))")
            }).collect();
            let sql = format!(
                "SELECT {} FROM \"{}\"",
                projections.join(","),
                table.replace('"', "\"\"")
            );
            let mut rows: Vec<Vec<String>> = sqlx::query(sqlx::AssertSqlSafe(sql))
                .fetch_all(&mut db)
                .await
                .unwrap()
                .into_iter()
                .map(|row| {
                    (0..columns.len())
                        .map(|i| row.get::<String, _>(i))
                        .collect()
                })
                .collect();
            rows.sort();
            snapshot.insert(table, rows);
        }
        db.close().await.unwrap();
        snapshots.push(snapshot);
    }
    assert_eq!(
        snapshots[0].keys().collect::<Vec<_>>(),
        snapshots[1].keys().collect::<Vec<_>>()
    );
    for (table, rows) in &snapshots[1] {
        assert_eq!(&snapshots[0][table], rows, "restored table {table}");
    }
}

#[tokio::test]
async fn startup_wal_round_trip_preserves_all_message_and_conversation_fields_on_reopen() {
    let (temp, data, config) = profile().await;
    let pool = crate::db::create_pool(&data.join("macro.db"))
        .await
        .unwrap();
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE conversations SET description='description', scope_mode='project', task_id='task', group_id='group', project_id='project', provider_id='synthetic-provider', model_id='synthetic-model', reasoning_effort='medium', is_pinned=1, last_message='summary', message_count=3").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO conversations (id,title,description,scope_mode,created_at,updated_at) VALUES ('second','Second','second description','global','2026-10-13','2026-10-13')").execute(&pool).await.unwrap();
    for id in ["z-last", "a-first"] {
        sqlx::query("INSERT INTO messages (id,conversation_id,turn_id,role,content,created_at,token_count,tool_traces_json,hidden_context,provider_input_items_json,provider_turn_state_json,context_refs_json,completion_reason,generation_attempts_json) VALUES (?,'conversation','turn','assistant',?,'2026-10-13',17,'[{\"tool\":\"synthetic\"}]','hidden','[{\"input\":1}]','{\"state\":2}','[{\"ref\":3}]','completed','[{\"attempt\":4}]')").bind(id).bind(format!("Content {id} é")).execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO conversation_citations (id,conversation_id,message_id,type,scope,source,title,content,created_at,updated_at) VALUES ('citation','conversation','a-first','file','conversation','user','synthetic.txt','Citation é','2026-10-13','2026-10-13')").execute(&pool).await.unwrap();
    let before_conversations = serde_json::to_value(
        crate::db::repository::list_conversations(&pool)
            .await
            .unwrap(),
    )
    .unwrap();
    let before_messages = serde_json::to_value(
        crate::db::repository::list_messages(&pool, "conversation")
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(before_messages[1]["id"], "a-first");
    assert_eq!(before_messages[2]["id"], "z-last");
    assert!(
        fs::metadata(data.join("macro.db-wal")).unwrap().len() > 32,
        "committed WAL must exist while writer remains open"
    );
    assert!(
        !fs::read(data.join("macro.db"))
            .unwrap()
            .windows("Content a-first é".len())
            .any(|bytes| bytes == "Content a-first é".as_bytes()),
        "new message must not have reached the main database"
    );
    let approved = config.join(".runtime/approved/user");
    let pending = config.join(".runtime/pending/user");
    fs::create_dir_all(&approved).unwrap();
    fs::create_dir_all(&pending).unwrap();
    let settings = br#"{"$schema":"settings.schema.json","schemaVersion":1,"language":"fr"}"#;
    fs::write(approved.join("settings.json"), settings).unwrap();
    fs::write(
        config.join("settings.json"),
        br#"{"$schema":"settings.schema.json","schemaVersion":1,"language":"en"}"#,
    )
    .unwrap();
    fs::write(pending.join("settings.json"), b"unapproved proposal").unwrap();
    let checkpoint = data.join("direct-checkpoints/synthetic/objects/one");
    fs::create_dir_all(checkpoint.parent().unwrap()).unwrap();
    fs::write(&checkpoint, b"checkpoint bytes\0\xff").unwrap();
    let browser = browser_fixture("restored");
    let archive_path = temp.path().join("portable.json");
    let dir = data.join("local-backup");
    fs::create_dir_all(&dir).unwrap();
    atomic(
        &dir.join("request.json"),
        &serde_json::to_vec(&Request {
            operation: "export".into(),
            path: archive_path.to_string_lossy().into(),
            browser: browser.clone(),
        })
        .unwrap(),
    )
    .unwrap();
    // Executes the real native export branch with a committed, uncheckpointed WAL.
    process_startup(&data, &config).await.unwrap();
    assert_eq!(status(&data).code, Some(BackupStatusCode::Exported));
    let archive = load_restore_archive(&archive_path).await.unwrap();
    assert!(!archive
        .files
        .contains_key("config/.runtime/pending/user/settings.json"));
    pool.close().await;
    let changed = crate::db::create_pool(&data.join("macro.db"))
        .await
        .unwrap();
    sqlx::query("UPDATE messages SET content='changed'")
        .execute(&changed)
        .await
        .unwrap();
    sqlx::query("UPDATE conversations SET title='changed'")
        .execute(&changed)
        .await
        .unwrap();
    changed.close().await;
    fs::write(&checkpoint, b"changed checkpoint").unwrap();
    queue_restore(&data, &archive);
    process_startup(&data, &config).await.unwrap();
    let result = status(&data);
    assert_eq!(result.code, Some(BackupStatusCode::Restored));
    assert_eq!(result.browser.as_ref(), Some(&browser));
    proof(
        "restored-status.json",
        &fs::read(dir.join("status.json")).unwrap(),
    );
    proof(
        "restored-browser-expected.json",
        &serde_json::to_vec_pretty(&browser).unwrap(),
    );
    assert_eq!(fs::read(&checkpoint).unwrap(), b"checkpoint bytes\0\xff");
    let restored_settings: serde_json::Value =
        serde_json::from_slice(&fs::read(config.join("settings.json")).unwrap()).unwrap();
    assert_eq!(restored_settings["language"], "fr");
    assert!(!pending.join("settings.json").exists());
    // Open twice via the real pool/migrations and compare every serialized public field and order.
    for _ in 0..2 {
        let reopened = crate::db::create_pool(&data.join("macro.db"))
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(
                crate::db::repository::list_conversations(&reopened)
                    .await
                    .unwrap()
            )
            .unwrap(),
            before_conversations
        );
        assert_eq!(
            serde_json::to_value(
                crate::db::repository::list_messages(&reopened, "conversation")
                    .await
                    .unwrap()
            )
            .unwrap(),
            before_messages
        );
        let citation: String =
            sqlx::query_scalar("SELECT content FROM conversation_citations WHERE id='citation'")
                .fetch_one(&reopened)
                .await
                .unwrap();
        assert_eq!(citation, "Citation é");
        let checkpoints: String = sqlx::query_scalar(
            "SELECT value_json FROM app_settings WHERE key='agentCodeCheckpoints:conversation'",
        )
        .fetch_one(&reopened)
        .await
        .unwrap();
        assert_eq!(checkpoints, "{broken but preserved");
        reopened.close().await;
    }
    proof("roundtrip-fields.json", &serde_json::to_vec_pretty(&serde_json::json!({"conversations":before_conversations,"messages":before_messages,"reopens":2,"committedWal":true})).unwrap());
}

#[tokio::test]
async fn invalid_incoming_and_real_write_failure_do_not_replace_profile() {
    let (_temp, data, config) = profile().await;
    let archive = capture(&data, &config, BTreeMap::new(), true)
        .await
        .unwrap();
    let expected = capture_raw(&data, &config, BTreeMap::new()).unwrap();
    let mut checksum = archive.clone();
    checksum.files.get_mut("data/macro.db").unwrap().sha256 = "bad".into();
    let mut version = archive.clone();
    version.version = 99;
    let mut app_version = archive.clone();
    app_version.app_version = "future".into();
    let mut browser_checksum = archive.clone();
    browser_checksum.browser_sha256 = "bad".into();
    for incoming in [
        b"{truncated".to_vec(),
        serde_json::to_vec(&checksum).unwrap(),
        serde_json::to_vec(&version).unwrap(),
        serde_json::to_vec(&app_version).unwrap(),
        serde_json::to_vec(&browser_checksum).unwrap(),
    ] {
        queue_restore(&data, &archive);
        fs::write(data.join("local-backup/incoming.json"), incoming).unwrap();
        process_startup(&data, &config).await.unwrap();
        assert_eq!(status(&data).code, Some(BackupStatusCode::Failed));
        assert_raw_files(
            &capture_raw(&data, &config, BTreeMap::new()).unwrap(),
            &expected,
        );
        assert!(!data.join("local-backup/restoring.json").exists());
    }
    // Actual I/O rejection of a journal path that is a directory.
    queue_restore(&data, &archive);
    fs::create_dir(data.join("local-backup/restoring.json")).unwrap();
    // Existing journal directory is rejected before sources can be opened/replaced.
    assert!(process_startup(&data, &config).await.is_err());
    assert_raw_files(
        &capture_raw(&data, &config, BTreeMap::new()).unwrap(),
        &expected,
    );
}

// The subprocess uses helpers only at boundaries unreachable without a production hook.
// The final two phases execute process_startup until a real status-publication I/O error.
#[tokio::test]
#[ignore = "subprocess entry point; invoked only by interruption parent"]
async fn interruption_child() {
    let root = PathBuf::from(
        std::env::var_os("MACRO_BACKUP_CHILD_ROOT").expect("assigned synthetic root"),
    );
    let phase = std::env::var("MACRO_BACKUP_CHILD_PHASE").unwrap();
    let data = root.join("data");
    let config = root.join("config");
    let dir = data.join("local-backup");
    if phase == "resume" {
        process_startup(&data, &config).await.unwrap();
        process_startup(&data, &config).await.unwrap();
        return;
    }
    if phase == "replaced-before-status" {
        fs::create_dir(dir.join("status.json")).unwrap();
        assert!(process_startup(&data, &config).await.is_err());
        assert!(dir.join("restoring.json").is_file());
        fs::remove_dir(dir.join("status.json")).unwrap();
    } else {
        let original = capture_raw(&data, &config, browser_fixture("original")).unwrap();
        let marker = RestoreJournal {
            phase: RestorePhase::Rollback,
            preserved: format!("preserved-{}.json", uuid::Uuid::new_v4()),
        };
        preserve_raw(&original, &preserved_path(&dir, &marker).unwrap()).unwrap();
        if phase != "preserved-before-journal" {
            atomic(
                &dir.join("restoring.json"),
                &serde_json::to_vec(&marker).unwrap(),
            )
            .unwrap();
        }
        if phase == "partial-replacement" || phase == "rollback-before-status" {
            atomic(&config.join("settings.json"), b"partial replacement").unwrap();
            atomic(&data.join("macro.db"), b"partial database").unwrap();
            atomic(
                &data.join(PROVIDER_SECRETS_FILE),
                b"partial secret generation",
            )
            .unwrap();
            atomic(
                &data.join("provider-secrets.json.v0.bak"),
                b"partial migration backup",
            )
            .unwrap();
        }
        if phase == "rollback-before-status" {
            fs::create_dir(dir.join("status.json")).unwrap();
            assert!(process_startup(&data, &config).await.is_err());
            fs::remove_dir(dir.join("status.json")).unwrap();
        }
    }
    fs::write(root.join("child-ready"), phase).unwrap();
    loop {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn killed_subprocess_recovers_at_five_restore_boundaries() {
    use std::os::unix::process::ExitStatusExt;
    for phase in [
        "preserved-before-journal",
        "journal-before-replacement",
        "partial-replacement",
        "replaced-before-status",
        "rollback-before-status",
    ] {
        let (temp, data, config) = profile().await;
        fs::write(
            config.join("settings.json"),
            br#"{"$schema":"settings.schema.json","schemaVersion":1,"language":"fr"}"#,
        )
        .unwrap();
        let archive = capture(&data, &config, browser_fixture("restored"), true)
            .await
            .unwrap();
        let receiver_browser = browser_fixture("original");
        fs::write(
            config.join("settings.json"),
            br#"{"$schema":"settings.schema.json","schemaVersion":1,"language":"en"}"#,
        )
        .unwrap();
        super::secrets_qualification::seed(&data, &config, "receiver", 2).await;
        let expected = capture_raw(&data, &config, receiver_browser.clone()).unwrap();
        queue_restore(&data, &archive);
        atomic(
            &data.join("local-backup/request.json"),
            &serde_json::to_vec(&Request {
                operation: "restore".into(),
                path: String::new(),
                browser: receiver_browser.clone(),
            })
            .unwrap(),
        )
        .unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "local_backup::qualification::interruption_child",
                "--ignored",
                "--nocapture",
            ])
            .current_dir(temp.path())
            .env("MACRO_BACKUP_CHILD_ROOT", temp.path())
            .env("MACRO_BACKUP_CHILD_PHASE", phase)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while !temp.path().join("child-ready").exists() {
            if let Some(exit) = child.try_wait().unwrap() {
                panic!("{phase}: child exited before boundary: {exit}");
            }
            if std::time::Instant::now() > deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("{phase}: boundary timeout");
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        child.kill().unwrap();
        let exit = child.wait().unwrap();
        assert_eq!(exit.signal(), Some(9), "real SIGKILL at {phase}");
        let restarted = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "local_backup::qualification::interruption_child",
                "--ignored",
                "--nocapture",
            ])
            .current_dir(temp.path())
            .env("MACRO_BACKUP_CHILD_ROOT", temp.path())
            .env("MACRO_BACKUP_CHILD_PHASE", "resume")
            .output()
            .unwrap();
        assert!(
            restarted.status.success(),
            "{phase}: restart failed: {}",
            String::from_utf8_lossy(&restarted.stderr)
        );
        let recovered = status(&data);
        let code = if phase == "preserved-before-journal" {
            BackupStatusCode::Restored
        } else {
            BackupStatusCode::RolledBack
        };
        assert_eq!(recovered.code, Some(code));
        if phase != "preserved-before-journal" {
            assert_held_files(
                &capture_raw(&data, &config, receiver_browser.clone()).unwrap(),
                &expected,
            )
            .await;
            assert_eq!(recovered.browser.as_ref(), Some(&receiver_browser));
            if phase == "replaced-before-status" {
                proof(
                    "rollback-status.json",
                    &fs::read(data.join("local-backup/status.json")).unwrap(),
                );
                proof(
                    "rollback-browser-expected.json",
                    &serde_json::to_vec_pretty(&receiver_browser).unwrap(),
                );
            }
        }
        if phase != "preserved-before-journal" {
            super::secrets_qualification::reopen(temp.path(), "rollback", "receiver", "source");
            super::secrets_qualification::reopen(temp.path(), "rollback", "receiver", "source");
        }
        assert!(!data.join("local-backup/request.json").exists());
        assert!(!data.join("local-backup/restoring.json").exists());
        check_database(&data.join("macro.db")).await.unwrap();
        process_startup(&data, &config).await.unwrap();
        assert_eq!(status(&data).code, recovered.code);
        println!("phase={phase} signal=9 child_reaped=true restarted_subprocess_exit=0 native_restart=2 helpers={} full_tauri=false", phase != "replaced-before-status");
    }
}

#[tokio::test]
async fn damaged_preservation_blocks_recovery_and_retains_journal_for_retry() {
    let (_temp, data, config) = profile().await;
    let original = capture_raw(&data, &config, browser_fixture("original")).unwrap();
    let dir = data.join("local-backup");
    fs::create_dir_all(&dir).unwrap();
    let marker = RestoreJournal {
        phase: RestorePhase::Rollback,
        preserved: format!("preserved-{}.json", uuid::Uuid::new_v4()),
    };
    let path = preserved_path(&dir, &marker).unwrap();
    preserve_raw(&original, &path).unwrap();
    let mut invalid = original.clone();
    invalid.files.get_mut("data/macro.db").unwrap().sha256 = "bad".into();
    fs::write(&path, serde_json::to_vec(&invalid).unwrap()).unwrap();
    atomic(
        &dir.join("restoring.json"),
        &serde_json::to_vec(&marker).unwrap(),
    )
    .unwrap();
    fs::write(data.join("macro.db"), b"interrupted replacement").unwrap();
    let error = process_startup(&data, &config).await.unwrap_err();
    assert!(error.contains("checksum"));
    assert_eq!(
        fs::read(data.join("macro.db")).unwrap(),
        b"interrupted replacement"
    );
    assert!(dir.join("restoring.json").exists());
    fs::write(&path, serde_json::to_vec(&original).unwrap()).unwrap();
    process_startup(&data, &config).await.unwrap();
    assert_eq!(status(&data).code, Some(BackupStatusCode::RolledBack));
    assert_held_files(
        &capture_raw(&data, &config, BTreeMap::new()).unwrap(),
        &original,
    )
    .await;
    assert!(path.exists());
}

#[tokio::test]
async fn version_zero_migration_backup_is_managed_with_its_profile() {
    let (_temp, data, config) = profile().await;
    fs::write(
        data.join("provider-secrets.json.v0.bak"),
        b"synthetic-v0-source",
    )
    .unwrap();
    let raw = capture_raw(&data, &config, BTreeMap::new()).unwrap();
    assert!(
        raw.files.contains_key("data/provider-secrets.json.v0.bak"),
        "supported version-zero migration backup must be preserved and detached"
    );
    let portable = capture(&data, &config, BTreeMap::new(), true)
        .await
        .unwrap();
    apply(&portable, &data, &config).unwrap();
    assert!(!data.join("provider-secrets.json.v0.bak").exists());
}
