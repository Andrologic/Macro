use super::*;
use crate::agsdl_host::HostState;
use crate::architect_library::{migration, project::ImportCandidate};
use crate::db::agsdl_execution::{discovery030::RunListRequest030, intents::ExecutionIntentScope};
use argentic_runtime::{
    api::{self, StreamTasks},
    dev_fixture::ScriptedAgent,
    source::OpenedSource,
};
use std::{
    fs,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

async fn archive_fixture(data: &Path, manifest: Value) -> (SqlitePool, VersionKey) {
    archive_fixture_with_mcp(data, manifest, &[]).await
}

async fn archive_fixture_with_mcp(
    data: &Path,
    mut manifest: Value,
    files: &[(&str, bool)],
) -> (SqlitePool, VersionKey) {
    let project = tempfile::tempdir_in(data).unwrap();
    for &(name, executable) in files {
        let path = project.path().join(name);
        let script = if name == "relative-interpreter" {
            "#!  bin/sh\nexit 0\n"
        } else {
            "#!/bin/sh\nexit 0\n"
        };
        fs::write(&path, script).unwrap();
        #[cfg(unix)]
        if executable {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        #[cfg(not(unix))]
        let _ = executable;
    }
    if let Some(secrets) = manifest.get_mut("secrets") {
        fs::write(project.path().join("secrets.json"), secrets.to_string()).unwrap();
        *secrets = json!({"file":"secrets.json"});
    }
    fs::write(project.path().join("agsdl.json"), manifest.to_string()).unwrap();
    import_archive_fixture(data, project.path()).await
}

async fn import_archive_fixture(data: &Path, project: &Path) -> (SqlitePool, VersionKey) {
    let pool = crate::db::create_pool(&data.join("launch.db"))
        .await
        .unwrap();
    sqlx::query("INSERT INTO architect_legacy_import VALUES (1,0,0)")
        .execute(&pool)
        .await
        .unwrap();
    let storage = Storage::new(data);
    migration::migrate(&pool, &storage).await.unwrap();
    sqlx::query("INSERT INTO architect_projects(id,name) VALUES ('demo','Demo')")
        .execute(&pool)
        .await
        .unwrap();
    let mut archive = Vec::new();
    OpenedSource::open_path(project)
        .unwrap()
        .write_archive(&mut archive)
        .unwrap();
    let path = data.join("fixture.agsdl");
    fs::write(&path, archive).unwrap();
    let staging = tempfile::tempdir_in(data).unwrap();
    let candidate = ImportCandidate::open(&path, staging.path()).unwrap();
    let imported = storage
        .import_project(&pool, "demo", "Example system", &candidate)
        .await
        .unwrap();
    assert!(imported.version.is_some());
    (
        pool,
        VersionKey {
            blueprint_id: imported.draft.summary.id,
            number: 1,
        },
    )
}

fn manifest() -> Value {
    json!({
        "projectFormat":"agsdl-project-1", "contract":"agsdl-0.4.0", "id":"sample",
        "agents":{"worker":{"harness":"codex","permissions":"read-only"}},
        "flow":{"entry":"run","steps":{"run":{"type":"agent","agent":"worker","prompt":"Respond with OK."}}}
    })
}

#[tokio::test]
async fn archive_launch_admits_pinned_snapshot_and_rediscovers_named_run() {
    let data = tempfile::tempdir().unwrap();
    let mut document = manifest();
    document["mcpServers"] = json!({"unused":{"url":"https://example.invalid/mcp"}});
    document["secrets"] = json!({"unused":["UNUSED_TOKEN"]});
    let (pool, version) = archive_fixture(data.path(), document).await;
    let manager = ConfigManager::initialize(data.path().join("config"))
        .await
        .unwrap();
    crate::agsdl_host_capture::test_codex_observations030()
        .lock()
        .unwrap()
        .insert(
            manager.root().to_owned(),
            api::synthetic_codex_observation(),
        );
    let machine = machine_id(manager.root()).unwrap();
    let host = HostState::new();
    let executor = Arc::new(ScriptedAgent::default());
    executor.install(&host);
    let tasks = StreamTasks::default();
    let storage = Storage::new(data.path());
    let input = VersionInput::read(&pool, &storage, version.clone())
        .await
        .unwrap();
    let preview = input.preview().unwrap();
    {
        let policy = manager.lock_execution_tools(PROJECT_ID).await.unwrap();
        let (blockers, servers) = requirements(
            &input,
            &preview,
            &call_permissions(&policy).unwrap(),
            LOCAL_MCP_SUPPORTED,
        );
        assert!(secret_requirements(&input, &servers).unwrap().is_empty());
        assert!(blockers.is_empty());
    }
    let mut review = permissions(&input, &preview).unwrap();
    {
        let policy = manager.lock_execution_tools(PROJECT_ID).await.unwrap();
        record_host_permissions(&mut review, &policy.agsdl_host_permissions).unwrap();
    }
    let token = consent_token(
        &mut pool.acquire().await.unwrap(),
        &input,
        &review,
        &machine,
    )
    .await
    .unwrap();
    let launch = |token| {
        start::launch(
            start::Runtime {
                host: &host,
                manager: &manager,
                pool: &pool,
                app_data: data.path(),
                tasks: tasks.clone(),
            },
            start::LaunchRequest {
                version: version.clone(),
                configuration: LaunchConfiguration::default(),
                start_message: Some("Start".into()),
                name: Some("Morning run".into()),
                consent_token: token,
                folder_reuse_token: None,
                model_overrides: BTreeMap::new(),
            },
        )
    };
    let denied = launch(None).await.err().expect("consent required");
    assert_eq!(denied.code, "CONSENT_REQUIRED", "{denied:?}");
    assert!(!manager.root().join("agsdl-snapshots").exists());
    assert!(!data.path().join("agsdl-working-folders").exists());
    let receipt = launch(token).await.unwrap();
    assert!(consent_token(
        &mut pool.acquire().await.unwrap(),
        &input,
        &review,
        &machine
    )
    .await
    .unwrap()
    .is_none());
    let mut narrowed = Permissions::default();
    assert!(consent_token(
        &mut pool.acquire().await.unwrap(),
        &input,
        &narrowed,
        &machine
    )
    .await
    .unwrap()
    .is_none());
    narrowed.capabilities.insert("worker:write".into());
    assert!(consent_token(
        &mut pool.acquire().await.unwrap(),
        &input,
        &narrowed,
        &machine
    )
    .await
    .unwrap()
    .is_some());

    let id = &receipt.receipt.identity.system_start_id;
    let folder = PathBuf::from(read_folder(&pool, id).await.unwrap());
    assert!(
        folder.is_dir()
            && folder.starts_with(
                data.path()
                    .join("agsdl-working-folders")
                    .canonicalize()
                    .unwrap()
            )
    );
    let (snapshot, owns_folder): (String, bool) = sqlx::query_as(
        "SELECT retained_snapshot_id,owns_working_folder FROM architect_launch_runs WHERE system_id=?",
    ).bind(id).fetch_one(&pool).await.unwrap();
    assert!(owns_folder);
    let private: Value = serde_json::from_str(&receipt.capture.private_capture_json).unwrap();
    let scope: Value = serde_json::from_str(private["callScopeJson"].as_str().unwrap()).unwrap();
    assert_eq!(scope["projectSnapshot"], snapshot);
    assert_eq!(scope["root"], json!(folder));
    let retained = manager.root().join("agsdl-snapshots").join(&snapshot);
    assert!(retained.is_dir());
    assert!(fs::metadata(retained.join("project/agsdl.json"))
        .unwrap()
        .permissions()
        .readonly());
    #[cfg(unix)]
    assert!(fs::metadata(retained.join("project"))
        .unwrap()
        .permissions()
        .readonly());
    assert!(!retained.starts_with(&folder));
    assert!(!folder.starts_with(&retained));
    drop(input);
    assert!(storage
        .delete_version(&pool, version.clone())
        .await
        .is_err());

    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let verdict: Option<String> = sqlx::query_scalar("SELECT json_extract(state_json,'$.verdict') FROM engine_flow030_runs WHERE system_id=?")
                .bind(id).fetch_one(&pool).await.unwrap();
            if let Some(verdict) = verdict {
                assert_eq!(verdict, "succeeded");
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await.unwrap();
    assert_eq!(executor.starts.load(Ordering::SeqCst), 1);

    pool.close().await;
    let pool = crate::db::create_pool(&data.path().join("launch.db"))
        .await
        .unwrap();
    migration::startup(&pool, data.path()).await.unwrap();
    api::interrupt_previous_runs(&pool).await.unwrap();
    let orphan_snapshot = retained.parent().unwrap().join("a".repeat(64));
    fs::create_dir_all(orphan_snapshot.join("project")).unwrap();
    fs::write(orphan_snapshot.join("project/agsdl.json"), "orphan").unwrap();
    resources::seal_snapshot(&orphan_snapshot.join("project"), &folder).unwrap();
    let db_key = resources::database_owner(&pool, manager.root())
        .await
        .unwrap()
        .key;
    fs::write(
        orphan_snapshot.with_extension("owners.json"),
        json!([db_key]).to_string(),
    )
    .unwrap();
    let staging = retained.parent().unwrap().join(".tmpAbandoned");
    fs::create_dir(&staging).unwrap();
    let folder_without_run = resources::new_working_folder(data.path(), &db_key)
        .unwrap()
        .keep();
    fs::write(folder_without_run.join("pre-commit"), "interrupted").unwrap();
    resources::cleanup(&pool, data.path(), manager.root())
        .await
        .unwrap();
    assert!(retained.is_dir() && folder.is_dir());
    assert!(!orphan_snapshot.exists() && !staging.exists() && !folder_without_run.exists());
    let records = run_systems(&pool).await.unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].run_name.as_deref(), Some("Morning run"));
    let scope = ExecutionIntentScope {
        owner: owner(&version.blueprint_id),
        conversation_id: version.blueprint_id.clone(),
    };
    let page = crate::db::operate_inbox::list_runs(
        &pool,
        RunListRequest030 {
            owner: scope.owner.clone(),
            after: None,
            limit: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(&page.runs[0].summary.system_start_id, id);
    let proof =
        crate::db::agsdl_execution::intents::read_archive_run_correlation(&pool, &scope, id)
            .await
            .unwrap();
    assert_eq!(&proof.receipt.system_start_id, id);
    resources::remove_snapshot(&retained).unwrap();
    crate::agsdl_host_capture::test_codex_observations030()
        .lock()
        .unwrap()
        .remove(manager.root());
}

#[tokio::test]
async fn a_completion_check_that_runs_on_more_answers_needs_new_consent() {
    let data = tempfile::tempdir().unwrap();
    let mut doc = manifest();
    doc["agents"]["worker"]["permissions"] = json!("workspace");
    doc["agents"]["worker"]["completionCheck"] = json!({"command":"echo check","choices":["done"]});
    doc["flow"]["steps"]["run"]["next"] = json!({"done":[],"retry":[]});
    let (pool, initial) = archive_fixture(data.path(), doc.clone()).await;
    let storage = Storage::new(data.path());
    let manager = manager_for_test(data.path()).await;
    observe_fixture(&manager);
    let machine = machine_id(manager.root()).unwrap();
    let input = VersionInput::read(&pool, &storage, initial.clone())
        .await
        .unwrap();
    let mut projected = input.preview().unwrap();
    let summary = |preview: &ImportPreview| permissions(&input, preview).unwrap();
    let restricted = summary(&projected);
    assert_eq!(
        projected.agents["worker"]
            .completion_check_max_failures
            .as_deref(),
        Some("3")
    );
    let mut larger_budget = input.preview().unwrap();
    larger_budget
        .agents
        .get_mut("worker")
        .unwrap()
        .completion_check_max_failures = Some("4".into());
    assert!(!restricted.covers(&summary(&larger_budget)));
    assert!(summary(&larger_budget).covers(&restricted));
    let legacy: CompletionCheck = serde_json::from_value(json!({
        "command": "echo check",
        "choices": ["done"],
    }))
    .unwrap();
    assert!(!legacy.covers(&restricted.completion_checks["worker"]));
    projected
        .agents
        .get_mut("worker")
        .unwrap()
        .completion_check_choices = vec!["retry".into(), "done".into()];
    let two_choices = summary(&projected);
    assert!(two_choices.covers(&restricted));
    assert!(!restricted.covers(&two_choices));
    projected
        .agents
        .get_mut("worker")
        .unwrap()
        .completion_check_choices
        .reverse();
    assert!(two_choices.covers(&summary(&projected)));
    projected
        .agents
        .get_mut("worker")
        .unwrap()
        .completion_check_choices
        .clear();
    let all_results = summary(&projected);
    assert!(all_results.covers(&two_choices));
    assert!(!two_choices.covers(&all_results));
    let legacy: Permissions = serde_json::from_value(json!({
        "capabilities": ["worker:read", "worker:write", "worker:shell", "worker:delegate",
            "[\"completionCheck\",\"worker\",\"echo check\"]"],
        "mcp": {}
    }))
    .unwrap();
    assert!(!legacy.covers(&restricted));

    let mut approved = restricted;
    let policy = manager.lock_execution_tools(PROJECT_ID).await.unwrap();
    record_host_permissions(&mut approved, &policy.agsdl_host_permissions).unwrap();
    drop(policy);
    sqlx::query("INSERT INTO architect_launch_consents VALUES (?,?,?,?)")
        .bind(&initial.blueprint_id)
        .bind(initial.number)
        .bind(machine)
        .bind(serde_json::to_string(&approved).unwrap())
        .execute(&pool)
        .await
        .unwrap();
    assert!(preview(&manager, &pool, data.path(), initial.clone(), None)
        .await
        .consent_token
        .is_none());
    drop(input);

    doc["agents"]["worker"]["completionCheck"]
        .as_object_mut()
        .unwrap()
        .remove("choices");
    doc["agents"]["worker"]["completionCheck"]["maxFailures"] = json!(4);
    let draft = storage
        .open_draft_project(&pool, &initial.blueprint_id)
        .await
        .unwrap();
    let batch = serde_json::from_value(json!({
        "files": [{"kind":"write","path":"agsdl.json","text":doc.to_string()}],
    }))
    .unwrap();
    let saved = storage
        .edit_project(
            &pool,
            &initial.blueprint_id,
            draft.project.revision,
            batch,
            true,
        )
        .await
        .unwrap();
    storage
        .freeze(
            &pool,
            initial.blueprint_id.clone(),
            saved.revision,
            None,
            None,
        )
        .await
        .unwrap();
    let expanded = VersionKey {
        number: 2,
        ..initial
    };
    let prepared = preview(&manager, &pool, data.path(), expanded, None).await;
    assert!(prepared.permissions.agents["worker"]
        .completion_check_choices
        .is_empty());
    assert_eq!(
        prepared.permissions.agents["worker"]
            .completion_check_max_failures
            .as_deref(),
        Some("4")
    );
    assert!(prepared.consent_token.is_some());
}

#[tokio::test]
async fn retained_snapshot_cleanup_obeys_both_profiles() {
    let data = tempfile::tempdir().unwrap();
    let first = tempfile::tempdir_in(data.path()).unwrap();
    let second = tempfile::tempdir_in(data.path()).unwrap();
    let manager = manager_for_test(data.path()).await;
    observe_fixture(&manager);
    let (first_pool, first_version) = archive_fixture(first.path(), manifest()).await;
    let (second_pool, second_version) = archive_fixture(second.path(), manifest()).await;
    let first_host = HostState::new();
    let second_host = HostState::new();
    let executor = Arc::new(ScriptedAgent::default());
    executor.install(&first_host);
    let second_executor = Arc::new(ScriptedAgent::default());
    second_executor.install(&second_host);

    let prepared = preview(
        &manager,
        &first_pool,
        first.path(),
        first_version.clone(),
        None,
    )
    .await;
    let first_run = start::launch(
        runtime(&first_host, &manager, &first_pool, first.path()),
        request(first_version, prepared.consent_token),
    )
    .await
    .unwrap();
    let first_scope = run_scope(&first_run.capture);
    let first_id = &first_scope.system_start_id;
    executor.wait(&first_host, first_id).await.unwrap();
    let id: String = sqlx::query_scalar("SELECT retained_snapshot_id FROM architect_launch_runs")
        .fetch_one(&first_pool)
        .await
        .unwrap();
    let root = manager.root().join("agsdl-snapshots");
    let snapshot = root.join(&id);
    let legacy = root.join("b".repeat(64));
    fs::create_dir(&legacy).unwrap();

    resources::cleanup(&second_pool, second.path(), manager.root())
        .await
        .unwrap();
    assert!(snapshot.is_dir() && legacy.is_dir());

    let prepared = preview(
        &manager,
        &second_pool,
        second.path(),
        second_version.clone(),
        None,
    )
    .await;
    let second_run = start::launch(
        runtime(&second_host, &manager, &second_pool, second.path()),
        request(second_version, prepared.consent_token),
    )
    .await
    .unwrap();
    let second_scope = run_scope(&second_run.capture);
    let second_id = &second_scope.system_start_id;
    second_executor.wait(&second_host, second_id).await.unwrap();
    let shared_id: String =
        sqlx::query_scalar("SELECT retained_snapshot_id FROM architect_launch_runs")
            .fetch_one(&second_pool)
            .await
            .unwrap();
    assert_eq!(id, shared_id);

    let first_folder = read_folder(&first_pool, first_id).await.unwrap();
    let second_folder = read_folder(&second_pool, second_id).await.unwrap();
    let mut wrong = first_scope.clone();
    wrong.snapshot_id = second_scope.snapshot_id.clone() + "-other";
    assert_eq!(
        delete_run(&first_pool, first.path(), manager.root(), wrong)
            .await
            .unwrap_err()
            .code,
        "CORRELATION"
    );
    delete_run(
        &first_pool,
        first.path(),
        manager.root(),
        first_scope.clone(),
    )
    .await
    .unwrap();
    assert!(snapshot.is_dir());
    assert!(!Path::new(&first_folder).exists());
    assert!(Path::new(&second_folder).is_dir());
    assert_deleted(&first_pool, first_id).await;

    delete_run(
        &first_pool,
        first.path(),
        manager.root(),
        first_scope.clone(),
    )
    .await
    .unwrap();
    delete_run(
        &second_pool,
        second.path(),
        manager.root(),
        second_scope.clone(),
    )
    .await
    .unwrap();
    assert!(!Path::new(&second_folder).exists());
    assert_deleted(&second_pool, second_id).await;
    assert!(!snapshot.exists());
    assert!(legacy.is_dir());
}

async fn snapshot_with_run(data: &Path, manager: &ConfigManager) -> (SqlitePool, PathBuf) {
    let (pool, version) = archive_fixture(data, manifest()).await;
    observe_fixture(manager);
    let prepared = preview(manager, &pool, data, version.clone(), None).await;
    let host = HostState::new();
    let executor = Arc::new(ScriptedAgent::default());
    executor.install(&host);
    let run = start::launch(
        runtime(&host, manager, &pool, data),
        request(version, prepared.consent_token),
    )
    .await
    .unwrap();
    executor
        .wait(&host, &run.capture.identity.system_start_id)
        .await
        .unwrap();
    let snapshot: String =
        sqlx::query_scalar("SELECT retained_snapshot_id FROM architect_launch_runs")
            .fetch_one(&pool)
            .await
            .unwrap();
    (pool, manager.root().join("agsdl-snapshots").join(snapshot))
}

async fn delete_launch_rows(pool: &SqlitePool) {
    sqlx::query("DELETE FROM architect_launch_runs")
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn restored_database_reclaims_its_unreferenced_snapshot() {
    let data = tempfile::tempdir().unwrap();
    let manager = manager_for_test(data.path()).await;
    let (pool, snapshot) = snapshot_with_run(data.path(), &manager).await;
    delete_launch_rows(&pool).await;
    let replacement = data.path().join("replacement.db");
    sqlx::query("VACUUM INTO ?")
        .bind(replacement.to_str())
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let database = data.path().join("launch.db");
    fs::rename(replacement, &database).unwrap();
    let restored = crate::db::create_pool(&database).await.unwrap();
    resources::cleanup(&restored, data.path(), manager.root())
        .await
        .unwrap();
    assert!(!snapshot.exists());
}

#[tokio::test]
async fn two_profiles_restored_from_one_backup_keep_separate_snapshot_ownership() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let manager = manager_for_test(first.path()).await;
    let (original, snapshot) = snapshot_with_run(first.path(), &manager).await;
    let second_db = second.path().join("launch.db");
    sqlx::query("VACUUM INTO ?")
        .bind(second_db.to_str())
        .execute(&original)
        .await
        .unwrap();
    let restored = crate::db::create_pool(&second_db).await.unwrap();
    resources::cleanup(&restored, second.path(), manager.root())
        .await
        .unwrap();
    let id = |pool: SqlitePool| async move {
        sqlx::query_scalar::<_, String>("SELECT id FROM architect_launch_database")
            .fetch_one(&pool)
            .await
            .unwrap()
    };
    assert_ne!(id(original.clone()).await, id(restored.clone()).await);

    delete_launch_rows(&original).await;
    resources::cleanup(&original, first.path(), manager.root())
        .await
        .unwrap();
    assert!(snapshot.is_dir());

    delete_launch_rows(&restored).await;
    resources::cleanup(&restored, second.path(), manager.root())
        .await
        .unwrap();
    assert!(!snapshot.exists());
}

#[tokio::test]
async fn renamed_database_reclaims_its_unreferenced_snapshot() {
    let data = tempfile::tempdir().unwrap();
    let manager = manager_for_test(data.path()).await;
    let (pool, snapshot) = snapshot_with_run(data.path(), &manager).await;
    delete_launch_rows(&pool).await;
    pool.close().await;
    let renamed = data.path().join("renamed.db");
    fs::rename(data.path().join("launch.db"), &renamed).unwrap();
    let moved = crate::db::create_pool(&renamed).await.unwrap();
    resources::cleanup(&moved, data.path(), manager.root())
        .await
        .unwrap();
    assert!(!snapshot.exists());
}

async fn manager_for_test(data: &Path) -> ConfigManager {
    ConfigManager::initialize(data.join("config"))
        .await
        .unwrap()
}

fn observe_fixture(manager: &ConfigManager) {
    crate::agsdl_host_capture::test_codex_observations030()
        .lock()
        .unwrap()
        .insert(
            manager.root().to_owned(),
            api::synthetic_codex_observation(),
        );
}

fn request(version: VersionKey, token: Option<String>) -> start::LaunchRequest {
    start::LaunchRequest {
        version,
        consent_token: token,
        configuration: Default::default(),
        name: None,
        start_message: Some("Start".into()),
        folder_reuse_token: None,
        model_overrides: BTreeMap::new(),
    }
}

fn runtime<'a>(
    host: &'a HostState,
    manager: &'a ConfigManager,
    pool: &'a SqlitePool,
    data: &'a Path,
) -> start::Runtime<'a> {
    start::Runtime {
        host,
        manager,
        pool,
        app_data: data,
        tasks: StreamTasks::default(),
    }
}

async fn set_host_ceiling(manager: &ConfigManager, permissions: Value) {
    use crate::config::{ConfigChangeSource, ConfigDocumentKind, ConfigScope};
    let document = manager
        .get_document(ConfigDocumentKind::Tools, ConfigScope::User)
        .await
        .unwrap();
    let mut value = document.value;
    value["agsdlHostPermissions"] = permissions;
    fs::write(document.file_path, serde_json::to_vec(&value).unwrap()).unwrap();
    let pending = manager
        .reload(
            ConfigDocumentKind::Tools,
            ConfigScope::User,
            ConfigChangeSource::ExternalEditor,
        )
        .await
        .unwrap()
        .pending
        .unwrap();
    manager.accept_pending_change(&pending.id).await.unwrap();
}

async fn preview(
    manager: &ConfigManager,
    pool: &SqlitePool,
    data: &Path,
    version: VersionKey,
    configuration: Option<LaunchConfiguration>,
) -> LaunchPreview {
    prepare(manager, pool, data, version, configuration, BTreeMap::new())
        .await
        .unwrap()
}

#[tokio::test]
async fn mcp_requirements_use_reachable_calls_and_refuse_unqualified_launch() {
    let data = tempfile::tempdir().unwrap();
    let mut doc = manifest();
    doc["mcpServers"] = json!({
        "used":{"command":["never-installed-for-launch-test"]},
        "spare":{"command":["also-unused-for-launch-test"]}
    });
    doc["secrets"] = json!({"used":["TEST_TOKEN"],"spare":["UNUSED_TOKEN"]});
    doc["flow"] = json!({"entry":"tool","steps":{"tool":{"type":"call","mcp":{"server":"used","tool":"hello"}}}});
    let (pool, version) = archive_fixture(data.path(), doc).await;
    let manager = manager_for_test(data.path()).await;
    let prepared = preview(&manager, &pool, data.path(), version.clone(), None).await;
    assert!(prepared.secrets.is_empty());
    assert!(prepared
        .blockers
        .iter()
        .any(|blocker| blocker.code == "mcpRetainedProgramRequired"));
    let host = HostState::new();
    let refused = start::launch(
        runtime(&host, &manager, &pool, data.path()),
        request(version.clone(), prepared.consent_token),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(refused.code, prepared.blockers[0].code);
    assert!(!manager.root().join("agsdl-snapshots").exists());
    assert!(set_secret(
        &manager,
        &pool,
        data.path(),
        version,
        "used",
        "TEST_TOKEN",
        "value"
    )
    .await
    .is_err());
}

#[tokio::test]
async fn archive_remote_mcp_reports_missing_runtime_support() {
    let data = tempfile::tempdir().unwrap();
    let (pool, version) = if let Some(path) = std::env::var_os("MACRO_TEST_REVIEW_PROJECT") {
        import_archive_fixture(data.path(), Path::new(&path)).await
    } else {
        let mut doc = manifest();
        doc["mcpServers"] = json!({"issues":{"url":"https://mcp.example.com/issues"}});
        doc["agents"]["worker"]["mcpServers"] = json!(["issues"]);
        doc["agents"]["worker"]["permissions"] =
            json!({"preset":"read-only","rules":[{"action":"mcp","effect":"allow"}]});
        doc["secrets"] = json!({"issues":["ISSUES_TOKEN"]});
        archive_fixture(data.path(), doc).await
    };
    let manager = manager_for_test(data.path()).await;
    observe_fixture(&manager);
    let input = VersionInput::read(&pool, &Storage::new(data.path()), version.clone())
        .await
        .unwrap();
    let authored = input.archive.source().authored_json();
    let slice = api::product_slice(authored, None).unwrap();
    assert_eq!(slice.pointer, "/mcpServers/issues/url");
    let codex = api::validate_codex_document(&serde_json::from_str(authored).unwrap()).unwrap_err();
    assert_eq!(codex.code, "HARNESS_CAPABILITY");
    drop(input);

    let prepared = preview(&manager, &pool, data.path(), version.clone(), None).await;
    assert_eq!(prepared.blockers[0].code, "mcpRemoteUnsupported");
    assert_eq!(prepared.blockers[0].subject, "issues");
    let server = &prepared.permissions.mcp_servers["issues"];
    assert!(
        matches!(&server.transport, McpTransport::Remote { url } if url == "https://mcp.example.com/issues")
    );
    assert_eq!(server.required_secrets, ["ISSUES_TOKEN"]);
    assert!(prepared.secrets.is_empty());

    let host = HostState::new();
    let refused = start::launch(
        runtime(&host, &manager, &pool, data.path()),
        request(version, prepared.consent_token),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(refused.code, "mcpRemoteUnsupported");
}

#[test]
fn project_open_preserves_the_reserved_secret_location() {
    let project = tempfile::tempdir().unwrap();
    let mut doc = manifest();
    doc["mcpServers"] = json!({"used":{"command":["sh"]}});
    doc["secrets"] = json!({"file":"secrets.json"});
    fs::write(project.path().join("agsdl.json"), doc.to_string()).unwrap();
    fs::write(project.path().join("secrets.json"), r#"{"used":["PATH"]}"#).unwrap();
    let error = match ImportCandidate::open(project.path(), project.path()) {
        Err(error) => error,
        Ok(_) => panic!("opened a project with a reserved MCP secret"),
    };
    let error = library_error(error);
    assert_eq!(error.code, "MCP_SECRET_RESERVED");
    let location = error.source.unwrap();
    assert_eq!(location.path, "secrets.json");
    assert_eq!(location.pointer, "/used/0");
}

#[tokio::test]
async fn mcp_qualifies_retained_code_and_defends_against_legacy_secret_names() {
    let data = tempfile::tempdir().unwrap();
    let mut doc = manifest();
    doc["mcpServers"] = json!({"used":{"command":["sh","serve.sh"]}});
    doc["mcpFiles"] = json!({"used":["serve.sh","program","relative-interpreter"]});
    doc["flow"] = json!({"entry":"tool","steps":{"tool":{"type":"call","mcp":{"server":"used","tool":"hello"}}}});
    let (pool, version) = archive_fixture_with_mcp(
        data.path(),
        doc,
        &[
            ("serve.sh", false),
            ("program", true),
            ("relative-interpreter", true),
        ],
    )
    .await;
    let input = VersionInput::read(&pool, &Storage::new(data.path()), version)
        .await
        .unwrap();
    let mut preview = input.preview().unwrap();
    let server = preview.mcp_servers.get_mut("used").unwrap();
    server.required_secrets.clear();
    for command in [
        vec!["/bin/cat"],
        vec!["cat"],
        vec!["./undeclared"],
        vec!["serve.sh"],
        vec!["/bin/sh", "-c", "exit 0"],
        vec!["sh", "../serve.sh"],
    ] {
        server.transport = McpTransport::Local {
            command: command.into_iter().map(str::to_owned).collect(),
        };
        assert_eq!(
            qualify_mcp(&input, "used", server).unwrap_err().code,
            "mcpRetainedProgramRequired"
        );
    }
    for command in [vec!["sh", "./serve.sh"], vec!["/bin/sh", "serve.sh"]] {
        server.transport = McpTransport::Local {
            command: command.into_iter().map(str::to_owned).collect(),
        };
        assert!(qualify_mcp(&input, "used", server).is_ok());
    }
    #[cfg(unix)]
    {
        server.transport = McpTransport::Local {
            command: vec!["./program".into()],
        };
        assert!(qualify_mcp(&input, "used", server).is_ok());
        server.transport = McpTransport::Local {
            command: vec!["./relative-interpreter".into()],
        };
        assert_eq!(
            qualify_mcp(&input, "used", server).unwrap_err().code,
            "mcpAbsoluteInterpreterRequired"
        );
    }
    for name in [
        "PATH",
        "ENV",
        "BASH_ENV",
        "BASHOPTS",
        "SHELLOPTS",
        "PS4",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
    ] {
        server.transport = McpTransport::Local {
            command: vec!["sh".into(), "serve.sh".into()],
        };
        server.required_secrets = vec![name.into()];
        assert_eq!(
            qualify_mcp(&input, "used", server).unwrap_err().code,
            "mcpReservedSecret"
        );
    }
}

#[tokio::test]
async fn mcp_vault_provider_is_scoped_and_reloads_only_declared_values() {
    let _guard = crate::secrets::lock_test_store();
    let data = tempfile::tempdir().unwrap();
    crate::secrets::init(data.path()).unwrap();
    let mut doc = manifest();
    doc["mcpServers"] = json!({"used":{"command":["sh","./serve.sh"]},"spare":{"command":["sh"]}});
    doc["mcpFiles"] = json!({"used":["serve.sh"]});
    doc["secrets"] = json!({"used":["TOKEN","SECOND"],"spare":["UNUSED"]});
    doc["flow"] = json!({"entry":"tool","steps":{"tool":{"type":"call","mcp":{"server":"used","tool":"hello"}}}});
    let (pool, version) = archive_fixture_with_mcp(data.path(), doc, &[("serve.sh", false)]).await;
    let input = VersionInput::read(&pool, &Storage::new(data.path()), version)
        .await
        .unwrap();
    let projected = input.preview().unwrap();
    let manager = manager_for_test(data.path()).await;
    {
        let policy = manager.lock_execution_tools(PROJECT_ID).await.unwrap();
        let (blockers, servers) = requirements(
            &input,
            &projected,
            &call_permissions(&policy).unwrap(),
            true,
        );
        assert_eq!(blockers[0].code, "mcpWorkspaceRequired");
        assert!(servers.is_empty());
    }
    set_host_ceiling(&manager, json!("workspace")).await;
    let policy = manager.lock_execution_tools(PROJECT_ID).await.unwrap();
    let (blockers, servers) = requirements(
        &input,
        &projected,
        &call_permissions(&policy).unwrap(),
        true,
    );
    assert!(blockers.is_empty());
    assert_eq!(servers.len(), 1);
    let names = servers["used"].clone();
    let provider = secret_provider(&input, servers.clone());
    let source = input.source_revision();
    assert!(provider(&source, "used", &names).is_none());
    for name in &names {
        crate::secrets::set_api_key(&input.secret_id("used", name).unwrap(), name).unwrap();
    }
    assert!(secret_requirements(&input, &servers)
        .unwrap()
        .iter()
        .all(|secret| secret.stored));
    assert!(provider(&source, "spare", &names).is_none());
    assert!(provider(&source, "used", &names[..1]).is_none());
    let mut foreign = source.clone();
    foreign.owner.plan_id = "another-blueprint".into();
    assert!(provider(&foreign, "used", &names).is_none());
    assert_ne!(
        input.secret_id("used", "TOKEN").unwrap(),
        secret_id(&input.key.blueprint_id, r#"["origin",1]"#, "used", "TOKEN").unwrap()
    );
    crate::secrets::set_api_key(&input.secret_id("used", "TOKEN").unwrap(), "changed").unwrap();
    let values = provider(&source, "used", &names).unwrap();
    assert_eq!(
        values,
        BTreeMap::from([
            ("TOKEN".into(), "changed".into()),
            ("SECOND".into(), "SECOND".into())
        ])
    );
}

#[tokio::test]
async fn model_override_changes_the_run_registry_and_leaves_version_frozen() {
    let data = tempfile::tempdir().unwrap();
    let mut doc = manifest();
    doc["agents"]["worker"]["model"] = json!({"name":"missing-model"});
    let (pool, version) = archive_fixture(data.path(), doc).await;
    let manager = manager_for_test(data.path()).await;
    observe_fixture(&manager);
    let first = preview(&manager, &pool, data.path(), version.clone(), None).await;
    assert_eq!(first.available_models, ["fixture"]);
    assert_eq!(first.blockers[0].code, "modelUnavailable");
    let host = HostState::new();
    let executor = Arc::new(ScriptedAgent::default());
    executor.install(&host);
    let mut launch = request(version.clone(), first.consent_token.clone());
    let resources = resources::launch_lease(manager.root()).await.unwrap();
    let refused = tokio::time::timeout(
        Duration::from_secs(5),
        start::launch(runtime(&host, &manager, &pool, data.path()), launch),
    )
    .await
    .expect("Codex qualification must run while another profile holds the resource lease")
    .unwrap_err();
    drop(resources);
    assert_eq!(refused.code, "MODEL_UNAVAILABLE");
    assert!(!manager.root().join("agsdl-snapshots").exists());

    launch = request(version.clone(), first.consent_token);
    launch.model_overrides.insert(
        "worker".into(),
        ModelOverride {
            name: "fixture".into(),
            effort: None,
        },
    );
    let receipt = start::launch(runtime(&host, &manager, &pool, data.path()), launch)
        .await
        .unwrap();
    executor
        .wait(&host, &receipt.capture.identity.system_start_id)
        .await
        .unwrap();
    let projection = host
        .runtime_projection(
            &pool,
            api::RuntimeProjectionQuery030 {
                system_start_id: receipt.capture.identity.system_start_id.clone(),
                source: receipt.capture.source.clone(),
                snapshot_id: None,
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!(projection.model_overrides["worker"].name, "fixture");
    assert_eq!(
        projection.model_overrides["worker"].effort.as_deref(),
        Some("medium")
    );
    let after = preview(&manager, &pool, data.path(), version, None).await;
    assert_eq!(after.blockers[0].code, "modelUnavailable");
    assert!(receipt.capture.authored_source.contains("missing-model"));
    remove_test_snapshot(&pool, &manager, &receipt.capture.identity.system_start_id).await;
}

async fn remove_test_snapshot(pool: &SqlitePool, manager: &ConfigManager, id: &str) {
    let snapshot: String = sqlx::query_scalar(
        "SELECT retained_snapshot_id FROM architect_launch_runs WHERE system_id=?",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .unwrap();
    resources::remove_snapshot(&manager.root().join("agsdl-snapshots").join(snapshot)).unwrap();
}

#[tokio::test]
async fn admission_rechecks_folder_sharing_after_two_unoccupied_previews() {
    let data = tempfile::tempdir().unwrap();
    let chosen = tempfile::tempdir().unwrap();
    let (pool, version) = archive_fixture(data.path(), manifest()).await;
    let storage = Storage::new(data.path());
    let draft = storage
        .open_draft_project(&pool, &version.blueprint_id)
        .await
        .unwrap();
    let batch = serde_json::from_value(json!({
        "files": [],
        "settings": {"workingFolderMode":"atLaunch", "startMessageRequired":false},
    }))
    .unwrap();
    let saved = storage
        .edit_project(
            &pool,
            &version.blueprint_id,
            draft.project.revision,
            batch,
            true,
        )
        .await
        .unwrap();
    storage
        .freeze(
            &pool,
            version.blueprint_id.clone(),
            saved.revision,
            None,
            None,
        )
        .await
        .unwrap();
    let version = VersionKey {
        number: 2,
        ..version
    };
    let manager = manager_for_test(data.path()).await;
    observe_fixture(&manager);
    let folder = Some(chosen.path().to_owned());
    let first = preview(
        &manager,
        &pool,
        data.path(),
        version.clone(),
        Some(LaunchConfiguration {
            working_folder: folder.clone(),
        }),
    )
    .await;
    let second = preview(
        &manager,
        &pool,
        data.path(),
        version.clone(),
        Some(LaunchConfiguration {
            working_folder: folder,
        }),
    )
    .await;
    assert!(first.folder_reuse_token.is_none() && second.folder_reuse_token.is_none());
    assert!(!second.start_message_required);
    let host = HostState::new();
    let executor = Arc::new(ScriptedAgent {
        cleanup: Some(Arc::new(tokio::sync::Notify::new())),
        submitted: Some(Arc::new(tokio::sync::Notify::new())),
        independent_finish: true,
        ..Default::default()
    });
    executor.install(&host);
    let launch = |plan: &LaunchPreview| {
        let mut request = request(version.clone(), plan.consent_token.clone());
        request.configuration = plan.configuration.clone();
        request.folder_reuse_token = plan.folder_reuse_token.clone();
        start::launch(runtime(&host, &manager, &pool, data.path()), request)
    };
    let first_run = launch(&first).await.unwrap();
    tokio::time::timeout(
        Duration::from_secs(10),
        executor.submitted.as_ref().unwrap().notified(),
    )
    .await
    .unwrap();
    let error = launch(&second).await.err().unwrap();
    assert_eq!(error.code, "WORKING_FOLDER_IN_USE");
    assert_eq!(
        delete_run(
            &pool,
            data.path(),
            manager.root(),
            run_scope(&first_run.capture),
        )
        .await
        .unwrap_err()
        .code,
        "RUN_NOT_FINISHED"
    );
    let confirmed = preview(
        &manager,
        &pool,
        data.path(),
        version.clone(),
        Some(second.configuration),
    )
    .await;
    assert!(confirmed.folder_reuse_token.is_some());

    #[cfg(unix)]
    let other_run = {
        let path = chosen.path().canonicalize().unwrap();
        let renamed = tempfile::tempdir().unwrap();
        let backup = renamed.path().join("original");
        fs::rename(&path, &backup).unwrap();
        fs::create_dir(&path).unwrap();
        let mut moved = preview(
            &manager,
            &pool,
            data.path(),
            version.clone(),
            Some(LaunchConfiguration {
                working_folder: Some(backup.clone()),
            }),
        )
        .await;
        assert!(moved.folder_reuse_token.take().is_some());
        assert_eq!(
            launch(&moved).await.err().unwrap().code,
            "WORKING_FOLDER_IN_USE"
        );
        assert_eq!(
            launch(&confirmed).await.err().unwrap().code,
            "WORKING_FOLDER_CHANGED"
        );
        fs::remove_dir(&path).unwrap();
        fs::rename(&backup, &path).unwrap();

        let alias = renamed.path().join("alias");
        std::os::unix::fs::symlink(&path, &alias).unwrap();
        let mut alias_preview = preview(
            &manager,
            &pool,
            data.path(),
            version.clone(),
            Some(LaunchConfiguration {
                working_folder: Some(alias.clone()),
            }),
        )
        .await;
        assert_eq!(
            alias_preview.configuration.working_folder.as_deref(),
            Some(path.as_path())
        );
        assert_eq!(
            alias_preview.folder_reuse_token,
            confirmed.folder_reuse_token
        );
        let other_folder = renamed.path().join("other");
        fs::create_dir(&other_folder).unwrap();
        let other = preview(
            &manager,
            &pool,
            data.path(),
            version.clone(),
            Some(LaunchConfiguration {
                working_folder: Some(other_folder.clone()),
            }),
        )
        .await;
        let other_run = launch(&other).await.unwrap();
        tokio::time::timeout(
            Duration::from_secs(10),
            executor.submitted.as_ref().unwrap().notified(),
        )
        .await
        .unwrap();
        fs::remove_file(&alias).unwrap();
        std::os::unix::fs::symlink(&other_folder, &alias).unwrap();
        alias_preview.configuration.working_folder = Some(alias);
        assert_eq!(
            launch(&alias_preview).await.err().unwrap().code,
            "WORKING_FOLDER_CHANGED"
        );
        other_run
    };

    let second_run = launch(&confirmed).await.unwrap();
    assert_ne!(
        first_run.capture.identity.system_start_id,
        second_run.capture.identity.system_start_id
    );
    tokio::time::timeout(
        Duration::from_secs(10),
        executor.submitted.as_ref().unwrap().notified(),
    )
    .await
    .unwrap();
    executor.cleanup.as_ref().unwrap().notify_waiters();
    executor
        .wait(&host, &first_run.capture.identity.system_start_id)
        .await
        .unwrap();
    executor
        .wait(&host, &second_run.capture.identity.system_start_id)
        .await
        .unwrap();
    #[cfg(unix)]
    executor
        .wait(&host, &other_run.capture.identity.system_start_id)
        .await
        .unwrap();
    let first_scope = run_scope(&first_run.capture);
    let chosen_path = read_folder(&pool, &first_scope.system_start_id)
        .await
        .unwrap();
    let user_file = Path::new(&chosen_path).join("run-user-content");
    fs::write(&user_file, "keep").unwrap();
    delete_run(&pool, data.path(), manager.root(), first_scope.clone())
        .await
        .unwrap();
    assert_deleted(&pool, &first_scope.system_start_id).await;
    assert_eq!(fs::read_to_string(&user_file).unwrap(), "keep");
    delete_run(
        &pool,
        data.path(),
        manager.root(),
        run_scope(&second_run.capture),
    )
    .await
    .unwrap();
    #[cfg(unix)]
    delete_run(
        &pool,
        data.path(),
        manager.root(),
        run_scope(&other_run.capture),
    )
    .await
    .unwrap();
    assert_eq!(fs::read_to_string(user_file).unwrap(), "keep");
}

#[tokio::test]
async fn archive_write_approval_uses_admitted_folder_and_current_ceiling() {
    use crate::agsdl_host_action_approval030::ArchiveActionPolicy030;
    let data = tempfile::tempdir().unwrap();
    let mut doc = manifest();
    doc["agents"]["worker"]["permissions"] = json!("workspace");
    let (pool, version) = archive_fixture(data.path(), doc).await;
    let manager = manager_for_test(data.path()).await;
    set_host_ceiling(
        &manager,
        json!({
            "preset":"workspace", "reviewer":"person",
            "rules":[{"action":"write","effect":"ask"}],
        }),
    )
    .await;
    observe_fixture(&manager);
    let prepared = preview(&manager, &pool, data.path(), version.clone(), None).await;
    let host = HostState::new();
    let executor = Arc::new(ScriptedAgent::default());
    executor.install(&host);
    let receipt = start::launch(
        runtime(&host, &manager, &pool, data.path()),
        request(version, prepared.consent_token),
    )
    .await
    .unwrap();
    let id = &receipt.capture.identity.system_start_id;
    executor.wait(&host, id).await.unwrap();
    let folder = PathBuf::from(read_folder(&pool, id).await.unwrap());
    let file = folder.join("existing.txt");
    fs::write(&file, "fixture").unwrap();
    let payload = |path: &Path| {
        json!({"nativeRequest":{"params":{"command":"echo approved > existing.txt",
        "additionalPermissions":{"fileSystem":{"write":[path]}}}}})
    };
    let policy = ArchiveActionPolicy030 {
        pool: pool.clone(),
        config: manager.clone(),
    };
    assert!(
        policy
            .lock_decision(&receipt.capture, &payload(&file))
            .await
            .unwrap()
            .0
    );
    let external = data.path().canonicalize().unwrap().join("outside.txt");
    fs::write(&external, "outside").unwrap();
    assert!(
        !policy
            .lock_decision(&receipt.capture, &payload(&external))
            .await
            .unwrap()
            .0
    );
    set_host_ceiling(&manager, json!("read-only")).await;
    assert!(
        !policy
            .lock_decision(&receipt.capture, &payload(&file))
            .await
            .unwrap()
            .0
    );
    let backup = folder.with_extension("old");
    fs::rename(&folder, &backup).unwrap();
    fs::create_dir(&folder).unwrap();
    assert_eq!(
        policy
            .lock_decision(&receipt.capture, &payload(&file))
            .await
            .err()
            .unwrap()
            .code,
        "CAPTURE_CHANGED"
    );
    remove_test_snapshot(&pool, &manager, id).await;
}

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
#[tokio::test]
#[ignore = "requires a disposable Macro data directory with a logged-in Codex 0.171.0 private profile"]
async fn real_codex_read_only_launch_from_archive() {
    let data = PathBuf::from(
        std::env::var_os("MACRO_ARCHIVE_SMOKE_DATA").expect("disposable data directory"),
    );
    let manager = manager_for_test(&data).await;
    let (pool, version) = archive_fixture(&data, manifest()).await;
    let prepared = preview(&manager, &pool, &data, version.clone(), None).await;
    assert!(
        prepared.blockers.is_empty(),
        "{}",
        serde_json::to_string(&prepared.blockers).unwrap()
    );
    let host = HostState::new();
    let receipt = start::launch(
        runtime(&host, &manager, &pool, &data),
        request(version, prepared.consent_token),
    )
    .await
    .unwrap();
    let id = &receipt.capture.identity.system_start_id;
    let run = tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let page = host
                .runtime_projection(
                    &pool,
                    api::RuntimeProjectionQuery030 {
                        system_start_id: id.clone(),
                        source: receipt.capture.source.clone(),
                        snapshot_id: None,
                    },
                    None,
                )
                .await
                .unwrap();
            if page.verdict.is_some() {
                break page;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("native launch did not complete");
    remove_test_snapshot(&pool, &manager, id).await;
    assert_eq!(run.verdict.as_deref(), Some("succeeded"));
    assert!(run
        .items
        .iter()
        .any(|item| matches!(item, api::RuntimeProjectionItem030::Instance { .. })));
    eprintln!("Codex 0.171.0 archive launch succeeded; systemStartId={id}");
}

fn run_scope(
    capture: &argentic_runtime::persistence::start030::StartCapture030,
) -> api::RuntimeProjectionScope030 {
    api::RuntimeProjectionScope030 {
        system_start_id: capture.identity.system_start_id.clone(),
        snapshot_id: capture.identity.snapshot_id.clone(),
        source: capture.source.clone(),
    }
}

async fn assert_deleted(pool: &SqlitePool, id: &str) {
    for table in [
        "engine_flow030_runs",
        "engine_start030_requests",
        "engine_flow030_events",
        "engine_flow030_clock",
        "operate_inbox_runs",
        "operate_inbox_threads",
        "architect_launch_runs",
        "operate_run_deletions",
        "operate_shutdown_holds",
    ] {
        let count: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT count(*) FROM {table} WHERE system_id=?"
        )))
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(count, 0, "{table}");
    }
    let uses: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM architect_version_uses WHERE kind='execution' AND owner_id=?",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(uses, 0);
    assert!(sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(pool)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn archive_operator_replays_the_exact_receipt_after_retirement() {
    let data = tempfile::tempdir().unwrap();
    let (pool, version) = archive_fixture(data.path(), manifest()).await;
    let manager = manager_for_test(data.path()).await;
    observe_fixture(&manager);
    let host = HostState::new();
    let executor = Arc::new(ScriptedAgent::default());
    executor.install(&host);
    let preview = preview(&manager, &pool, data.path(), version.clone(), None).await;
    let run = start::launch(
        runtime(&host, &manager, &pool, data.path()),
        request(version, preview.consent_token),
    )
    .await
    .unwrap();
    let scope = run_scope(&run.capture);
    executor.wait(&host, &scope.system_start_id).await.unwrap();

    // The scripted Codex tests cover live dispatch and loss of the native ack.
    // Exercise the Macro fallback for the same durable format after restart.
    let key = "pause-before-retirement";
    let event_id = format!("operator:{:x}", Sha256::digest(key.as_bytes()));
    let receipt = json!({"eventId":event_id,"revision":"1","effectIds":[]});
    sqlx::query(
        "INSERT INTO engine_flow030_events
        (system_id,invocation_id,event_id,event_json,receipt_json) VALUES (?,?,?,?,?)",
    )
    .bind(&scope.system_start_id)
    .bind(&run.capture.identity.flow_invocation_id)
    .bind(&event_id)
    .bind(json!({"kind":{"Operator":{"Pause":{"activation_ids":[]}}}}).to_string())
    .bind(receipt.to_string())
    .execute(&pool)
    .await
    .unwrap();
    api::interrupt_previous_runs(&pool).await.unwrap();
    let restarted = HostState::new();
    let request = api::OperatorRequest {
        scope,
        request_id: key.into(),
        action: api::OperatorAction::PauseRun,
    };
    let replay = crate::db::operate_inbox::control_run(&restarted, &pool, request.clone())
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(replay).unwrap(), receipt);
    let wrong = api::OperatorRequest {
        action: api::OperatorAction::ResumeRun,
        ..request
    };
    assert_eq!(
        crate::db::operate_inbox::control_run(&restarted, &pool, wrong)
            .await
            .unwrap_err()
            .code,
        "CONFLICT"
    );
}
