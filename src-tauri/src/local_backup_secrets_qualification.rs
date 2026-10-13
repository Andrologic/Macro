//! Synthetic secret consumers and fresh-process qualification. Never opens the OS vault.
use super::tests::{profile, queue_restore};
use super::*;
use serde_json::{json, Value};

fn pilot_state(configuration_id: &str) -> Value {
    json!({"schemaVersion":1,"values":{
        "unrelated": {"text":"preserved é"},
        "macro_pilot_native_v1": {
            "configurationId":configuration_id,"relayOrigin":"https://relay.example",
            "account":{"contract_version":"1.0","type":"account","account_id":"account:synthetic","identity":{"provider":"github","subject":"synthetic","login":"synthetic"},"revision":1},
            "deviceSession":{"contract_version":"1.0","type":"device_session","ref":{"type":"session","account_id":"account:synthetic","session_id":"session:test-01"},"device_id":"device:test-01","state":"active","issued_at":"2026-10-13T00:00:00Z","expires_at":"2099-01-01T00:00:00Z","revision":1},
            "instance":{"ref":{"instance_id":"instance:test-01"}},
            "instanceCreationId":"creation:test-01","attempt":{"attemptKey":"attempt:test-01"},
            "pendingSecretCleanup":[{"configuration_id":configuration_id,"relay_origin":"https://relay.example","kind":"poll_secret","resource_id":"attempt:test-01"}]
        }
    }})
}
fn proof(name: &str, bytes: &[u8]) {
    if let Some(root) = std::env::var_os("MACRO_BACKUP_PROOF_DIR") {
        fs::write(PathBuf::from(root).join(name), bytes).unwrap();
    }
}
fn oauth_id(context: &str) -> String {
    crate::commands::mcp::qualification_oauth_id(
        &crate::commands::mcp::McpRuntimeKey {
            server_id: "synthetic_server".into(),
            project_id: Some(context.into()),
            project_ids: vec![context.into()],
            config_generation: 1,
        },
        "https://resource.invalid/mcp",
    )
}
fn keys(context: &str) -> Vec<String> {
    vec![
        format!("provider_{context}"),
        "macro-ai".into(),
        format!("speech:{context}"),
        format!("speech-provider:{context}"),
        "mcp-env:synthetic_server:API_TOKEN".into(),
        "mcp-env:synthetic_server:Authorization".into(),
        "mcp-oauth-client:synthetic_server".into(),
        oauth_id(context),
        "web-search:brave".into(),
        "web-search:tavily".into(),
        "macro-installation:macro-ai".into(),
        "__macro_ai_installation_identity".into(),
    ]
}
fn key_value(id: &str) -> String {
    if id.starts_with("mcp-oauth:") {
        let credentials: rmcp::transport::auth::StoredCredentials = serde_json::from_value(
            json!({"client_id":"synthetic-client","token_response":{"access_token":"synthetic-oauth-access","token_type":"bearer","refresh_token":"synthetic-oauth-refresh"},"granted_scopes":["synthetic-scope"]}),
        ).unwrap();
        serde_json::to_string(&credentials).unwrap()
    } else if id == "macro-installation:macro-ai" || id == "__macro_ai_installation_identity" {
        json!({"installation_id":"synthetic-installation","installation_proof":"synthetic-installation-proof"}).to_string()
    } else {
        format!("synthetic-secret-{id}")
    }
}
fn chatgpt_secret() -> crate::secrets::ChatGptSecret {
    crate::secrets::ChatGptSecret {
        access_token: format!(
            "e30.{}.synthetic",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"exp":4070908800}"#)
        ),
        refresh_token: "synthetic-chatgpt-refresh".into(),
        access_token_expires_at: Some("2099-01-01T00:00:00Z".into()),
        account_id: Some("synthetic-account".into()),
        auth_source: "synthetic".into(),
    }
}
pub(super) async fn seed(data: &Path, config: &Path, context: &str, version: u8) {
    let api_keys: BTreeMap<String, String> = keys(context)
        .into_iter()
        .map(|id| {
            let value = key_value(&id);
            (id, value)
        })
        .collect();
    let session = if version < 2 {
        json!({"version":1,"kind":"chatgpt","payload":{
            "access_token":chatgpt_secret().access_token,"refresh_token":"synthetic-chatgpt-refresh",
            "id_token":"synthetic-legacy-id","account_id":"synthetic-account","client_id":null,"last_refresh":null,"source":"synthetic"}})
    } else {
        serde_json::to_value(chatgpt_secret()).unwrap()
    };
    let mut file =
        json!({"version":version,"chatgpt_sessions":{format!("chatgpt_{context}"): session}});
    if version < 2 {
        file["api_keys"] = json!(api_keys);
    } else {
        let mut namespaces =
            json!({"providers":{},"speech":{},"mcp":{},"webSearch":{},"system":{}});
        for (id, value) in api_keys {
            let ns = if id.starts_with("speech") {
                "speech"
            } else if id.starts_with("mcp") {
                "mcp"
            } else if id.starts_with("web-search") {
                "webSearch"
            } else if id.starts_with("macro-installation") {
                "system"
            } else {
                "providers"
            };
            namespaces[ns][id] = json!(value);
        }
        file["namespaces"] = namespaces;
    }
    let bytes = serde_json::to_vec_pretty(&file).unwrap();
    atomic(&data.join(PROVIDER_SECRETS_FILE), &bytes).unwrap();
    // Both generations exercise a pending migration before canonical replacement.
    if version < 2 {
        let backup = format!("provider-secrets.json.v{version}.bak");
        atomic(&data.join(&backup), &bytes).unwrap();
        atomic(&data.join("provider-secrets.migration-pending.json"), &serde_json::to_vec(&json!({
            "from_version":version,"source_sha256":hash(&bytes),"target_sha256":hash(b"synthetic-target"),"backup_file":backup
        })).unwrap()).unwrap();
    }
    let state = pilot_state(&format!("config:{context}-01"));
    atomic(
        &data.join("state.json"),
        &serde_json::to_vec_pretty(&state).unwrap(),
    )
    .unwrap();
    let provider_doc = json!({"$schema":"providers.schema.json","schemaVersion":1,"providers":{
        format!("provider_{context}"):{"providerType":"openai","name":"Synthetic provider é","enabled":false,"baseUrl":format!("https://{context}.invalid/v1"),"isLocal":false,
        "options":{"apiKey":"synthetic-config-key","api_key":"synthetic-config-key","accessToken":"synthetic-config-access","refreshToken":"synthetic-config-refresh","clientSecret":"synthetic-config-client","password":"synthetic-config-password","env":{"TOKEN":"synthetic-config-env"},"headers":{"Authorization":"synthetic-config-header"},"nonSecret":"retained é"}}}});
    for relative in [
        "providers.json",
        ".runtime/approved/user/providers.json",
        ".runtime/pending/user/providers.json",
    ] {
        atomic(
            &config.join(relative),
            &serde_json::to_vec(&provider_doc).unwrap(),
        )
        .unwrap();
    }
    let pool = crate::db::create_pool(&data.join("macro.db"))
        .await
        .unwrap();
    for (id, kind) in [
        (format!("provider_{context}"), "openai"),
        (format!("chatgpt_{context}"), "chatgpt"),
    ] {
        crate::db::repository::upsert_provider_config_by_id(
            &pool,
            &id,
            "Synthetic",
            "openai",
            "https://synthetic.invalid/v1",
            false,
        )
        .await
        .unwrap();
        sqlx::query("UPDATE provider_configs SET provider_type=?, api_key='synthetic-sqlite-key',has_stored_api_key=1,auth_status='authenticated',auth_source='synthetic',token_expires_at='2099-01-01T00:00:00Z' WHERE id=?").bind(kind).bind(id).execute(&pool).await.unwrap();
    }
    sqlx::query("UPDATE speech_provider_configs SET has_stored_api_key=1")
        .execute(&pool)
        .await
        .unwrap();
    // The journal cannot recreate a token. Use a distinct missing provider to avoid intentional deletion of the rollback session.
    sqlx::query("INSERT OR REPLACE INTO app_settings (key,value_json,updated_at) VALUES ('chatgpt.auth_disconnect:absent', '{\"providerId\":\"absent\",\"createdAt\":\"2026-10-13\"}','2026-10-13')").execute(&pool).await.unwrap();
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}
fn assert_raw(actual: &Archive, expected: &Archive) {
    assert_eq!(
        actual.files.keys().collect::<Vec<_>>(),
        expected.files.keys().collect::<Vec<_>>()
    );
    for (name, entry) in &expected.files {
        assert_eq!(actual.files[name].data, entry.data, "{name}");
    }
}
fn private(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600,
            "{}",
            path.display()
        );
    }
}
pub(super) fn reopen(root: &Path, mode: &str, context: &str, other: &str) {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "local_backup::secrets_qualification::secret_consumer_child",
            "--ignored",
            "--nocapture",
        ])
        .current_dir(root)
        .env("MACRO_SECRET_CHILD_ROOT", root)
        .env("MACRO_SECRET_CHILD_MODE", mode)
        .env("MACRO_SECRET_CONTEXT", context)
        .env("MACRO_SECRET_OTHER_CONTEXT", other)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "mode={mode}: {} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    println!(
        "new_process mode={mode} {}",
        String::from_utf8_lossy(&output.stdout)
    );
}
#[tokio::test]
#[ignore = "synthetic subprocess entry, called by qualification parents"]
async fn secret_consumer_child() {
    let root = PathBuf::from(std::env::var_os("MACRO_SECRET_CHILD_ROOT").unwrap());
    let mode = std::env::var("MACRO_SECRET_CHILD_MODE").unwrap();
    let context = std::env::var("MACRO_SECRET_CONTEXT").unwrap();
    let other = std::env::var("MACRO_SECRET_OTHER_CONTEXT").unwrap();
    let data = root.join("data");
    let config = root.join("config");
    process_startup(&data, &config).await.unwrap();
    let attached = mode == "rollback";
    if attached && root.join("expected-raw.json").exists() {
        let expected = load_archive(&root.join("expected-raw.json")).unwrap();
        assert_raw(
            &capture_raw(&data, &config, BTreeMap::new()).unwrap(),
            &expected,
        );
        for name in expected.files.keys() {
            let path = raw_destination(name, &data, &config).unwrap();
            private(&path);
        }
    }
    let state = crate::state_manager::StateManager::initialize(&data)
        .unwrap()
        .snapshot()
        .await;
    assert_eq!(state.values["unrelated"]["text"], "preserved é");
    let pilot = &state.values["macro_pilot_native_v1"];
    assert_eq!(pilot["relayOrigin"], "https://relay.example");
    let old_configuration = format!("config:{context}-01");
    crate::commands::pilot_secrets::qualification_backup_context(
        pilot,
        &old_configuration,
        attached,
    );
    if attached {
        assert_eq!(
            pilot["deviceSession"]["ref"]["session_id"],
            "session:test-01"
        );
    } else {
        assert_ne!(pilot["configurationId"], old_configuration);
        for field in [
            "account",
            "deviceSession",
            "instance",
            "instanceAccess",
            "instanceCreationId",
            "attempt",
            "pendingSecretCleanup",
        ] {
            assert!(pilot.get(field).is_none(), "{field}");
        }
    }
    let manager = crate::config::ConfigManager::initialize(config.clone())
        .await
        .unwrap();
    let snapshot = manager.get_snapshot(&[]).await.unwrap();
    assert!(snapshot.effective.contains_key("providers"));
    crate::secrets::init(&data).unwrap();
    let pool = crate::db::create_pool(&data.join("macro.db"))
        .await
        .unwrap();
    crate::ai::chatgpt::recover_auth_mutations(&pool)
        .await
        .unwrap();
    for id in keys(&context) {
        let value = crate::secrets::get_api_key(&id).unwrap();
        assert_eq!(value, attached.then(|| key_value(&id)), "{id}");
    }
    if !attached {
        for id in keys(&other) {
            assert!(
                crate::secrets::get_api_key(&id).unwrap().is_none(),
                "other {id}"
            );
        }
    }
    assert_eq!(
        crate::ai::macro_ai::access_token().unwrap(),
        attached.then(|| key_value("macro-ai"))
    );
    let session = crate::secrets::get_chatgpt_secret(&format!("chatgpt_{context}")).unwrap();
    assert_eq!(session.is_some(), attached);
    if let Some(session) = session {
        assert_eq!(session.access_token, chatgpt_secret().access_token);
        assert_eq!(session.refresh_token, chatgpt_secret().refresh_token);
        assert_eq!(session.auth_source, "synthetic");
        assert_eq!(session.account_id.as_deref(), Some("synthetic-account"));
    }
    if !attached {
        assert!(
            crate::secrets::get_chatgpt_secret(&format!("chatgpt_{other}"))
                .unwrap()
                .is_none()
        );
    }
    crate::commands::mcp::qualification_backup_consumers(&context, attached).await;
    let (key,stored,status,source,expiry):(Option<String>,i64,Option<String>,Option<String>,Option<String>)=sqlx::query_as("SELECT api_key,has_stored_api_key,auth_status,auth_source,token_expires_at FROM provider_configs WHERE id=?").bind(format!("provider_{context}")).fetch_one(&pool).await.unwrap();
    if attached {
        assert_eq!(key.as_deref(), Some("synthetic-sqlite-key"));
        assert_eq!(stored, 1);
        assert_eq!(status.as_deref(), Some("authenticated"));
    } else {
        assert_eq!(
            (key, stored, status, source, expiry),
            (None, 0, None, None, None)
        );
    }
    let flags: i64 =
        sqlx::query_scalar("SELECT SUM(has_stored_api_key) FROM speech_provider_configs")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(flags > 0, attached);
    let text: String = sqlx::query_scalar("SELECT content FROM messages WHERE id='message'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(text, "Representative transcript");
    let document: Value =
        serde_json::from_slice(&fs::read(config.join("providers.json")).unwrap()).unwrap();
    let provider = &document["providers"][format!("provider_{context}")];
    assert_eq!(provider["options"]["nonSecret"], "retained é");
    assert_eq!(provider["name"], "Synthetic provider é");
    assert_eq!(provider["baseUrl"], format!("https://{context}.invalid/v1"));
    if !attached {
        assert!(provider["options"].get("apiKey").is_none());
        assert_eq!(provider["options"]["env"], json!({}));
        assert_eq!(provider["options"]["headers"], json!({}));
        assert!(!config.join(".runtime/pending/user/providers.json").exists());
        assert!(!data
            .join("provider-secrets.migration-pending.json")
            .exists());
        for v in [0, 1] {
            assert!(!data
                .join(format!("provider-secrets.json.v{v}.bak"))
                .exists());
        }
    }
    private(&data.join(PROVIDER_SECRETS_FILE));
    pool.close().await;
    println!("pid={} mode={mode} stores=state,config,secrets,sqlite,recover_auth mcp_adapter=load/save fake_pilot_four_kinds=true full_tauri=false",std::process::id());
}
#[tokio::test]
async fn portable_all_secret_families_detach_after_two_fresh_processes() {
    for version in [0, 1, 2] {
        for scenario in ["same", "changed-endpoint", "different-ids"] {
            let receiver = if scenario == "different-ids" {
                "receiver"
            } else {
                "source"
            };
            let (temp, data, config) = profile().await;
            seed(&data, &config, "source", version).await;
            let archive = capture(&data, &config, BTreeMap::new(), true)
                .await
                .unwrap();
            for name in archive.files.keys() {
                assert!(!name.contains("provider-secrets"));
            }
            for entry in archive.files.values() {
                let bytes = STANDARD.decode(&entry.data).unwrap();
                for sentinel in [
                    "synthetic-secret-",
                    "synthetic-sqlite-key",
                    "synthetic-config-",
                    "synthetic-chatgpt-refresh",
                    "synthetic-oauth-access",
                ] {
                    assert!(
                        !bytes
                            .windows(sentinel.len())
                            .any(|part| part == sentinel.as_bytes()),
                        "export leaked {sentinel}"
                    );
                }
            }
            seed(&data, &config, receiver, version).await;
            if scenario == "changed-endpoint" {
                for relative in ["providers.json", ".runtime/approved/user/providers.json"] {
                    let path = config.join(relative);
                    let mut document: Value =
                        serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                    document["providers"]["provider_source"]["baseUrl"] =
                        json!("https://changed-receiver.invalid/v1");
                    fs::write(path, serde_json::to_vec(&document).unwrap()).unwrap();
                }
            }
            queue_restore(&data, &archive);
            reopen(temp.path(), "portable", "source", receiver);
            reopen(temp.path(), "portable", "source", receiver);
            println!(
                "portable version={version} scenario={scenario} receiver={receiver} restarts=2"
            );
        }
    }
}
#[tokio::test]
async fn chosen_raw_preservation_is_portable_not_internal_rollback() {
    let (temp, data, config) = profile().await;
    seed(&data, &config, "source", 0).await;
    let raw = capture_raw(&data, &config, BTreeMap::new()).unwrap();
    let path = temp.path().join("chosen-raw.json");
    preserve_raw(&raw, &path).unwrap();
    private(&path);
    let portable = load_restore_archive(&path).await.unwrap();
    for name in portable.files.keys() {
        assert!(!name.contains("provider-secrets"));
    }
    queue_restore(&data, &portable);
    reopen(temp.path(), "portable", "source", "source");
    reopen(temp.path(), "portable", "source", "source");
}
#[tokio::test]
async fn internal_rollback_restores_all_families_and_context_together() {
    for version in [0, 1, 2] {
        let (temp, data, config) = profile().await;
        seed(&data, &config, "source", 2).await;
        let portable = capture(&data, &config, BTreeMap::new(), true)
            .await
            .unwrap();
        seed(&data, &config, "receiver", version).await;
        let expected = capture_raw(&data, &config, BTreeMap::new()).unwrap();
        fs::write(
            temp.path().join("expected-raw.json"),
            serde_json::to_vec(&expected).unwrap(),
        )
        .unwrap();
        queue_restore(&data, &portable);
        // Real I/O error after complete replacement, before status publication. Journal remains.
        let dir = data.join("local-backup");
        fs::create_dir(dir.join("status.json")).unwrap();
        assert!(process_startup(&data, &config).await.is_err());
        assert!(dir.join("restoring.json").exists());
        fs::remove_dir(dir.join("status.json")).unwrap();
        let journal: RestoreJournal =
            serde_json::from_slice(&fs::read(dir.join("restoring.json")).unwrap()).unwrap();
        private(&preserved_path(&dir, &journal).unwrap());
        reopen(temp.path(), "rollback", "receiver", "source");
        // Initialization can legitimately migrate v0/v1, so compare bytes only at the first recovery boundary.
        fs::remove_file(temp.path().join("expected-raw.json")).unwrap();
        reopen(temp.path(), "rollback", "receiver", "source");
        println!("rollback version={version} status_io_failure=true restarts=2 raw_bytes_before_init=true");
    }
}
#[tokio::test]
async fn portable_state_does_not_reassociate_pilot_vault() {
    let (_temp, data, config) = profile().await;
    let original = pilot_state("config:source-01");
    fs::write(
        data.join("state.json"),
        serde_json::to_vec(&original).unwrap(),
    )
    .unwrap();
    let archive = capture(&data, &config, BTreeMap::new(), true)
        .await
        .unwrap();
    let exported: Value = serde_json::from_slice(
        &STANDARD
            .decode(&archive.files["data/state.json"].data)
            .unwrap(),
    )
    .unwrap();
    proof(
        "pilot-original-state.json",
        &serde_json::to_vec_pretty(&original).unwrap(),
    );
    proof(
        "pilot-portable-state.json",
        &serde_json::to_vec_pretty(&exported).unwrap(),
    );
    crate::commands::pilot_secrets::qualification_backup_context(
        &exported["values"]["macro_pilot_native_v1"],
        "config:source-01",
        false,
    );
}
#[tokio::test]
async fn older_portable_archive_detaches_pilot_on_load() {
    let (temp, data, config) = profile().await;
    let mut archive = capture(&data, &config, BTreeMap::new(), true)
        .await
        .unwrap();
    add_file(
        &mut archive.files,
        "data/state.json".into(),
        serde_json::to_vec(&pilot_state("config:source-01")).unwrap(),
    )
    .unwrap();
    let path = temp.path().join("old-portable.json");
    fs::write(&path, serde_json::to_vec(&archive).unwrap()).unwrap();
    let normalized = load_restore_archive(&path).await.unwrap();
    let state: Value = serde_json::from_slice(
        &STANDARD
            .decode(&normalized.files["data/state.json"].data)
            .unwrap(),
    )
    .unwrap();
    assert_ne!(
        state["values"]["macro_pilot_native_v1"]["configurationId"],
        "config:source-01"
    );
}
#[tokio::test]
async fn private_recovery_read_and_publication_errors_preserve_whole_profile() {
    let (_temp, data, config) = profile().await;
    seed(&data, &config, "source", 2).await;
    let portable = capture(&data, &config, BTreeMap::new(), true)
        .await
        .unwrap();
    let before = capture_raw(&data, &config, BTreeMap::new()).unwrap();
    fs::remove_file(data.join(PROVIDER_SECRETS_FILE)).unwrap();
    fs::create_dir(data.join(PROVIDER_SECRETS_FILE)).unwrap();
    assert!(capture_raw(&data, &config, BTreeMap::new()).is_err());
    fs::remove_dir(data.join(PROVIDER_SECRETS_FILE)).unwrap();
    atomic(
        &data.join(PROVIDER_SECRETS_FILE),
        &STANDARD
            .decode(&before.files["data/provider-secrets.json"].data)
            .unwrap(),
    )
    .unwrap();
    let dir = data.join("local-backup");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("preserved-{}.json", uuid::Uuid::new_v4()));
    fs::create_dir(&path).unwrap();
    assert!(preserve_raw(&before, &path).is_err());
    assert_raw(
        &capture_raw(&data, &config, BTreeMap::new()).unwrap(),
        &before,
    );
    // A symlink is a real path refusal before mutation, not simulated EACCES.
    #[cfg(unix)]
    {
        let store = data.join(PROVIDER_SECRETS_FILE);
        let held = data.join("held-synthetic-store");
        fs::rename(&store, &held).unwrap();
        std::os::unix::fs::symlink(&held, &store).unwrap();
        queue_restore(&data, &portable);
        process_startup(&data, &config).await.unwrap();
        assert!(!dir.join("restoring.json").exists());
        fs::remove_file(&store).unwrap();
        fs::rename(&held, &store).unwrap();
        assert_raw(
            &capture_raw(&data, &config, BTreeMap::new()).unwrap(),
            &before,
        );
    }
}

#[tokio::test]
async fn initialization_clears_warm_api_and_chatgpt_caches_after_portable_and_rollback() {
    let _guard = crate::secrets::lock_test_store();
    let (_temp, data, config) = profile().await;
    seed(&data, &config, "source", 2).await;
    let portable = capture(&data, &config, BTreeMap::new(), true)
        .await
        .unwrap();
    let original = capture_raw(&data, &config, BTreeMap::new()).unwrap();
    crate::secrets::init(&data).unwrap();
    for id in keys("source") {
        assert!(crate::secrets::get_api_key(&id).unwrap().is_some());
    }
    assert!(crate::secrets::get_chatgpt_secret("chatgpt_source")
        .unwrap()
        .is_some());
    queue_restore(&data, &portable);
    process_startup(&data, &config).await.unwrap();
    crate::secrets::init(&data).unwrap();
    for id in keys("source") {
        assert!(crate::secrets::get_api_key(&id).unwrap().is_none());
    }
    assert!(crate::secrets::get_chatgpt_secret("chatgpt_source")
        .unwrap()
        .is_none());
    apply_files(&original, &data, &config, true).unwrap();
    crate::secrets::init(&data).unwrap();
    for id in keys("source") {
        assert_eq!(
            crate::secrets::get_api_key(&id).unwrap(),
            Some(key_value(&id))
        );
    }
    assert!(crate::secrets::get_chatgpt_secret("chatgpt_source")
        .unwrap()
        .is_some());
}
#[cfg(unix)]
#[tokio::test]
async fn unreadable_secret_aborts_preservation_before_any_replacement() {
    use std::os::unix::fs::PermissionsExt;
    let (_temp, data, config) = profile().await;
    seed(&data, &config, "source", 2).await;
    let portable = capture(&data, &config, BTreeMap::new(), true)
        .await
        .unwrap();
    let original = capture_raw(&data, &config, BTreeMap::new()).unwrap();
    let path = data.join(PROVIDER_SECRETS_FILE);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
    let error = fs::read(&path).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
    queue_restore(&data, &portable);
    process_startup(&data, &config).await.unwrap();
    assert!(!data.join("local-backup/restoring.json").exists());
    let status: BackupStatus =
        serde_json::from_slice(&fs::read(data.join("local-backup/status.json")).unwrap()).unwrap();
    assert_eq!(status.code, Some(BackupStatusCode::Failed));
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert_raw(
        &capture_raw(&data, &config, BTreeMap::new()).unwrap(),
        &original,
    );
}
