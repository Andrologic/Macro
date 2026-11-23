use super::*;
use crate::agsdl_host::HostState;
use crate::architect_library::{migration, project::ImportCandidate};
use crate::db::agsdl_execution::{discovery030::RunListRequest030, intents::ExecutionIntentScope};
use argentic_runtime::{
    api::{self, StreamTasks},
    dev_fixture::ScriptedAgent,
    host::{ActionPolicyLease, ActionPolicySource, PolicyFuture},
    source::OpenedSource,
};
use std::{
    fs,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

struct DenyActions;

impl ActionPolicySource for DenyActions {
    fn lock_current<'a>(
        &'a self,
        _capture: &'a crate::db::agsdl_execution::start030::StartCapture030,
        _payload: &'a Value,
    ) -> PolicyFuture<'a, ActionPolicyLease> {
        Box::pin(async { Ok(ActionPolicyLease::new(false, ())) })
    }
}

async fn archive_fixture(data: &Path, mut manifest: Value) -> (SqlitePool, VersionKey) {
    let pool = crate::db::create_pool(&data.join("launch.db"))
        .await
        .unwrap();
    sqlx::query("INSERT INTO architect_legacy_import VALUES (1,0,0)")
        .execute(&pool)
        .await
        .unwrap();
    let storage = Storage::new(data);
    assert!(migration::migrate(&pool, &storage).await.unwrap());
    sqlx::query("INSERT INTO architect_projects(id,name) VALUES ('demo','Demo')")
        .execute(&pool)
        .await
        .unwrap();
    let project = tempfile::tempdir_in(data).unwrap();
    if let Some(secrets) = manifest.get_mut("secrets") {
        fs::write(project.path().join("secrets.json"), secrets.to_string()).unwrap();
        *secrets = json!({"file":"secrets.json"});
    }
    fs::write(project.path().join("agsdl.json"), manifest.to_string()).unwrap();
    let mut archive = Vec::new();
    OpenedSource::open_path(project.path())
        .unwrap()
        .write_archive(&mut archive)
        .unwrap();
    let path = data.join("fixture.agsdl");
    fs::write(&path, archive).unwrap();
    let imported = storage
        .import_project(
            &pool,
            "demo",
            "Example system",
            ImportCandidate::open(&path).unwrap(),
        )
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
    assert!(secret_requirements(&input, &preview).unwrap().is_empty());
    assert!(requirements(&input, &preview).unwrap().is_empty());
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
                action_policy: Arc::new(DenyActions),
            },
            start::LaunchRequest {
                version: version.clone(),
                configuration: LaunchConfiguration::default(),
                start_message: Some("Start".into()),
                name: Some("Morning run".into()),
                consent_token: token,
            },
        )
    };
    let denied = launch(None).await.err().expect("consent required");
    assert_eq!(denied.code, "CONSENT_REQUIRED", "{denied:?}");
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
    assert!(manager
        .root()
        .join("agsdl-snapshots")
        .join(snapshot)
        .is_dir());
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
    crate::agsdl_host_capture::test_codex_observations030()
        .lock()
        .unwrap()
        .remove(manager.root());
}

#[tokio::test]
async fn mcp_requirements_use_reachable_calls_and_refuse_unqualified_launch() {
    let _guard = crate::secrets::lock_test_store();
    let data = tempfile::tempdir().unwrap();
    crate::secrets::init(data.path()).unwrap();
    let mut doc = manifest();
    doc["mcpServers"] = json!({
        "used":{"command":["never-installed-for-launch-test"]},
        "spare":{"command":["also-unused-for-launch-test"]}
    });
    doc["secrets"] = json!({"used":["TEST_TOKEN"],"spare":["UNUSED_TOKEN"]});
    doc["flow"] = json!({"entry":"tool","steps":{"tool":{"type":"call","mcp":{"server":"used","tool":"hello"}}}});
    let (pool, version) = archive_fixture(data.path(), doc).await;
    let manager = ConfigManager::initialize(data.path().join("config"))
        .await
        .unwrap();
    let first = prepare(&manager, &pool, data.path(), version.clone(), None)
        .await
        .unwrap();
    assert_eq!(first.secrets.len(), 1);
    assert_eq!(first.secrets[0].name, "TEST_TOKEN");
    assert!(!first.secrets[0].stored);
    assert!(first
        .blockers
        .iter()
        .any(|error| error.code == "missingProgram"));
    assert!(first
        .blockers
        .iter()
        .any(|error| error.code == "mcpIsolationUnavailable"));
    assert!(set_secret(
        &pool,
        data.path(),
        version.clone(),
        "spare",
        "UNUSED_TOKEN",
        "test-value"
    )
    .await
    .is_err());
    set_secret(
        &pool,
        data.path(),
        version.clone(),
        "used",
        "TEST_TOKEN",
        "test-value",
    )
    .await
    .unwrap();
    let second = prepare(&manager, &pool, data.path(), version, None)
        .await
        .unwrap();
    assert!(second.secrets[0].stored);
    assert!(!serde_json::to_string(&second)
        .unwrap()
        .contains("test-value"));
}
