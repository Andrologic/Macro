//! Application command/configuration/intent coverage transferred from native fixtures.
use crate::db::agsdl_execution as repository;
use crate::{agsdl_host::HostState, ai::AiState, secrets};
use argentic_runtime::dev_fixture::ScriptedAgent as FakeExecutor;
use repository::{dto::EngineOwner, flow030::FlowState030, start030::StartCapture030};
use serde_json::{json, Value};
use sqlx::{query, query_scalar};
use std::sync::{atomic::Ordering, Arc};
use tauri::Manager;
use tokio::sync::Notify;
struct MacroFixture {
    _temp: tempfile::TempDir,
    config: crate::config::ConfigManager,
    pool: sqlx::SqlitePool,
}
struct StateView {
    state: FlowState030,
}
struct View {
    capture: StartCapture030,
    flow: StateView,
}
fn fake_executor() -> FakeExecutor {
    FakeExecutor::default()
}
struct CommandFixture {
    fixture: MacroFixture,
    peer: Arc<FakeExecutor>,
    app: tauri::App<tauri::test::MockRuntime>,
    request: crate::db::agsdl_execution::dto::EngineStartRequest,
}
impl CommandFixture {
    async fn new(executor: Arc<FakeExecutor>, with_ai: bool) -> Self {
        use crate::db::agsdl_execution::dto::{
            EngineAssociations, EngineEntry, EngineSourceOwner, EngineStartRequest,
        };
        use crate::workspace::metadata::{ProjectDto, WorkspaceState};
        let document = json!({"contract":"agsdl-0.3.0","id":"codex-demo","agents":{
        "writer":{"harness":"codex","permissions":"workspace","model":{"name":"fixture","effort":"high"}},
        "reviewer":{"harness":"codex","permissions":"read-only"}},
        "flow":{"entry":"write","steps":{
            "write":{"type":"agent","agent":"writer","maxVisits":3,"next":"review"},
            "review":{"type":"agent","agent":"reviewer","maxVisits":3,"next":{"approve":[],"revise":"write"}}}}});
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let mut fixture = MacroFixture {
            config: crate::config::ConfigManager::initialize(root.join("config"))
                .await
                .unwrap(),
            pool: crate::db::create_pool(&root.join("production-start.db"))
                .await
                .unwrap(),
            _temp: temp,
        };
        let workspace = root.join("workspace");
        let metadata = workspace.join(".macro");
        let project = workspace.join("project");
        let dir = project.join(".macro/branches/develop/plans/source");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&metadata).unwrap();
        let registered: ProjectDto = serde_json::from_value(json!({
        "id":"project", "name":"Synthetic", "path":project, "created_at":"2026-01-01", "status":"active",
        "directEdit":true, "gitSetupState":"not_git", "metadata":{"description":"", "tags":[], "team_members":[], "api_contracts":[], "dependencies":[]}
    })).unwrap();
        let mut state = WorkspaceState::default();
        state.standalone_projects.push(registered);
        std::fs::write(
            metadata.join("workspace.json"),
            serde_json::to_vec(&state).unwrap(),
        )
        .unwrap();
        std::fs::write(dir.join("plan.json"), serde_json::to_vec(&json!({
        "id":"source", "projectIds":["project"], "revision":1, "updatedAt":"time", "agsdl":{"source":document.to_string()}
    })).unwrap()).unwrap();
        let scope = EngineSourceOwner {
            project_id: "project".into(),
            plan_id: "source".into(),
            branch: "develop".into(),
        };
        let locked = crate::workspace::architect::lock_execution_source_owner(
            &workspace, &metadata, &scope, None,
        )
        .await
        .unwrap();
        let request = EngineStartRequest {
            source: locked.revision.clone(),
            profile: "macro-agsdl-030-v1".into(),
            associations: EngineAssociations::default(),
            request_id: "production-start".into(),
            entry: Some(EngineEntry {
                delivery_id: "delivery".into(),
                message_json: "{\"prompt\":\"Start\"}".into(),
            }),
        };
        drop(locked);
        let observed = argentic_runtime::api::synthetic_codex_observation();
        crate::agsdl_host_capture::test_codex_observations030()
            .lock()
            .unwrap()
            .insert(workspace.clone(), observed);
        fixture
            .config
            .register_project_root("project", metadata.clone())
            .await
            .unwrap();
        let host = HostState::new();
        executor.install(&host);
        let db = crate::commands::DbPool::default();
        db.set_ready(fixture.pool.clone()).await.unwrap();
        let mut builder = tauri::test::mock_builder()
            .manage(host)
            .manage(db)
            .manage(fixture.config.clone())
            .manage(crate::git::GitState::new())
            .manage(crate::WorkspaceMetadataRoot(Arc::new(
                tokio::sync::RwLock::new(workspace),
            )));
        if with_ai {
            builder = builder.manage(AiState::default());
        }
        let app = builder
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        Self {
            fixture,
            peer: executor,
            app,
            request,
        }
    }
    async fn start(
        &self,
    ) -> crate::db::agsdl_execution::Result<crate::db::agsdl_execution::public::PublicStartReceipt>
    {
        crate::commands::agsdl_execution::execution_start(
            self.app.handle().clone(),
            self.request.clone(),
        )
        .await
    }
    fn host(&self) -> tauri::State<'_, HostState> {
        self.app.state::<HostState>()
    }
    async fn wait(&self, system: &str) -> repository::Result<()> {
        self.peer.wait(&self.host(), system).await
    }
    async fn inspect(&self, system: &str) -> View {
        let capture: String =
            query_scalar("SELECT capture_json FROM engine_start030_requests WHERE system_id=?")
                .bind(system)
                .fetch_one(&self.fixture.pool)
                .await
                .unwrap();
        let state: String =
            query_scalar("SELECT state_json FROM engine_flow030_runs WHERE system_id=?")
                .bind(system)
                .fetch_one(&self.fixture.pool)
                .await
                .unwrap();
        View {
            capture: serde_json::from_str(&capture).unwrap(),
            flow: StateView {
                state: serde_json::from_str(&state).unwrap(),
            },
        }
    }
    async fn only_system(&self) -> String {
        query_scalar("SELECT system_id FROM engine_start030_requests")
            .fetch_one(&self.fixture.pool)
            .await
            .unwrap()
    }
    async fn interrupted(&self, system: &str) -> bool {
        query_scalar("SELECT EXISTS(SELECT 1 FROM engine_flow030_interruptions WHERE system_id=?)")
            .bind(system)
            .fetch_one(&self.fixture.pool)
            .await
            .unwrap()
    }
    async fn finish(self) {
        let workspace = self
            .fixture
            ._temp
            .path()
            .canonicalize()
            .unwrap()
            .join("workspace");
        crate::agsdl_host_capture::test_codex_observations030()
            .lock()
            .unwrap()
            .remove(&workspace);
    }
}

#[tokio::test]
async fn shutdown_rechecks_consent_and_retries_without_losing_physical_ownership() {
    let _secret_guard = secrets::lock_test_store();
    let secret_root = tempfile::tempdir().unwrap();
    secrets::init(secret_root.path()).unwrap();
    let executor = Arc::new(FakeExecutor {
        cleanup: Some(Arc::new(Notify::new())),
        ..fake_executor()
    });
    let f = CommandFixture::new(executor.clone(), true).await;
    let receipt = f.start().await.unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        executor.started.notified(),
    )
    .await
    .unwrap();
    let host = f.host();
    let ai = f.app.state::<AiState>();
    assert_eq!(
        host.prepare_shutdown(&f.fixture.pool, &ai.stream_tasks, &[])
            .await
            .unwrap_err()
            .code,
        "SHUTDOWN_ACTIVITY_CHANGED"
    );
    assert!(host.begin_start().await.is_ok());
    assert!(!f.interrupted(&receipt.system_start_id).await);
    let approved = host.shutdown_active_runs(&f.fixture.pool).await.unwrap();
    assert_eq!(approved, [receipt.system_start_id.clone()]);
    {
        let attempt = host.prepare_shutdown(&f.fixture.pool, &ai.stream_tasks, &approved);
        tokio::pin!(attempt);
        tokio::select! {
            result = &mut attempt => panic!("shutdown returned before physical cleanup: {result:?}"),
            _ = executor.cancelled.notified() => (),
            _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => panic!("shutdown did not reach native Stop"),
        }
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(25), &mut attempt)
                .await
                .is_err(),
            "shutdown must wait for the retained executor's physical cleanup"
        );
        // Dropping just this waiter models an incomplete IPC attempt. The
        // registry still owns the executor and its eventual cleanup receipt.
    }
    assert!(
        host.inspect_start_session().await.is_ok(),
        "cleanup leases must remain live"
    );
    assert_eq!(f.start().await.unwrap_err().code, "SHUTDOWN_PENDING");
    assert_eq!(
        host.shutdown_active_runs(&f.fixture.pool).await.unwrap(),
        approved
    );
    assert!(f.interrupted(&receipt.system_start_id).await);
    executor.cleanup.as_ref().unwrap().notify_one();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        host.prepare_shutdown(&f.fixture.pool, &ai.stream_tasks, &approved),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(host.inspect_start_session().await.is_err());
    assert!(host
        .shutdown_active_runs(&f.fixture.pool)
        .await
        .unwrap()
        .is_empty());
    let status: String = query_scalar("SELECT status FROM engine_flow030_owners")
        .fetch_one(&f.fixture.pool)
        .await
        .unwrap();
    assert_eq!(status, "revoked");
    assert_eq!(
        executor.starts.load(Ordering::SeqCst),
        1,
        "no late successor after Stop"
    );
    drop(ai);
    drop(host);
    f.finish().await;
}

#[tokio::test]
async fn execution_start_attaches_supervisor_and_completes_write_review() {
    let _secret_guard = secrets::lock_test_store();
    let secret_root = tempfile::tempdir().unwrap();
    secrets::init(secret_root.path()).unwrap();
    let executor = Arc::new(fake_executor());
    let f = CommandFixture::new(executor.clone(), true).await;
    // No repository is required by Start or history, even beneath another repo.
    let parent_repo = git2::Repository::init(f.fixture._temp.path()).unwrap();
    let workspace = f
        .fixture
        ._temp
        .path()
        .canonicalize()
        .unwrap()
        .join("workspace");
    assert!(!workspace.join(".git").exists());
    let receipt = tokio::time::timeout(std::time::Duration::from_secs(15), f.start())
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        f.wait(&receipt.system_start_id),
    )
    .await
    .unwrap()
    .unwrap();
    let owner = EngineOwner {
        system_start_id: receipt.system_start_id.clone(),
        owner_epoch: "0".into(),
    };
    let result = f.inspect(&owner.system_start_id).await;
    assert_eq!(result.flow.state.verdict.as_deref(), Some("succeeded"));
    assert_eq!(executor.starts.load(Ordering::SeqCst), 2);
    assert!(result
        .flow
        .state
        .activations
        .iter()
        .any(|activation| activation.agent.as_deref() == Some("reviewer")
            && activation
                .message_json
                .as_deref()
                .is_some_and(|message| message.contains("Synthetic draft"))));
    // Replaying the same command returns the retained run, even after completion.
    assert_eq!(
        f.start().await.unwrap().system_start_id,
        receipt.system_start_id
    );
    assert_eq!(executor.starts.load(Ordering::SeqCst), 2);
    assert!(!f.interrupted(&receipt.system_start_id).await);
    let history = crate::commands::agsdl_execution::list_runs030_scoped(
        &f.fixture.pool,
        &workspace,
        crate::db::agsdl_execution::discovery030::RunListRequest030 {
            owner: receipt.snapshot.source.owner.clone(),
            after: None,
            limit: Some(20),
        },
    )
    .await
    .unwrap();
    assert_eq!(history.runs.len(), 1);
    assert_eq!(history.runs[0].system_start_id, receipt.system_start_id);
    assert!(!parent_repo
        .path()
        .join(crate::git::MACRO_WORKTREE_DIR_NAME)
        .exists());

    // A fresh host has no resident owner for this run. Historical observation
    // must still work, without reattaching a supervisor or starting an agent.
    let fresh_host = HostState::new();
    let query = crate::agsdl_host_projection030::RuntimeProjectionQuery030 {
        system_start_id: receipt.system_start_id.clone(),
        source: result.capture.source.clone(),
        snapshot_id: Some(result.capture.identity.snapshot_id.clone()),
    };
    let historical =
        crate::agsdl_host_projection030::read(&fresh_host, &f.fixture.pool, query.clone(), None)
            .await
            .unwrap();
    assert_eq!(historical.verdict.as_deref(), Some("succeeded"));
    assert_eq!(
        historical.flow_invocation_id,
        result.capture.identity.flow_invocation_id
    );
    let mut wrong_scope = query;
    wrong_scope.source.owner.branch = "another-branch".into();
    assert_eq!(
        crate::agsdl_host_projection030::read(&fresh_host, &f.fixture.pool, wrong_scope, None)
            .await
            .unwrap_err()
            .code,
        "CORRELATION"
    );
    assert_eq!(executor.starts.load(Ordering::SeqCst), 2);

    let root = f.fixture._temp.path().canonicalize().unwrap();
    let dir = root.join("workspace/project/.macro/branches/develop/plans/source");
    let mut plan: Value =
        serde_json::from_slice(&std::fs::read(dir.join("plan.json")).unwrap()).unwrap();
    let mut unsupported: Value =
        serde_json::from_str(plan["agsdl"]["source"].as_str().unwrap()).unwrap();
    unsupported["agents"]["writer"]["planFirst"] = json!("ask");
    plan["agsdl"]["source"] = json!(unsupported.to_string());
    plan["revision"] = json!(2);
    std::fs::write(dir.join("plan.json"), serde_json::to_vec(&plan).unwrap()).unwrap();
    let workspace = root.join("workspace");
    let locked = crate::workspace::architect::lock_execution_source_owner(
        &workspace,
        &workspace.join(".macro"),
        &f.request.source.owner,
        None,
    )
    .await
    .unwrap();
    let mut refused = f.request.clone();
    refused.source = locked.revision.clone();
    refused.request_id = "unsupported-start".into();
    drop(locked);
    let error = crate::commands::agsdl_execution::execution_start(f.app.handle().clone(), refused)
        .await
        .err()
        .unwrap();
    assert_eq!(error.code, "UNSUPPORTED_030_FEATURE");
    let count: i64 = query_scalar("SELECT COUNT(*) FROM engine_start030_requests")
        .fetch_one(&f.fixture.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    f.finish().await;
}

#[tokio::test]
async fn execution_stop_waits_for_fake_executor_physical_end() {
    let _secret_guard = secrets::lock_test_store();
    let secret_root = tempfile::tempdir().unwrap();
    secrets::init(secret_root.path()).unwrap();
    let executor = Arc::new(FakeExecutor {
        cleanup: Some(Arc::new(Notify::new())),
        ..fake_executor()
    });
    let f = CommandFixture::new(executor.clone(), true).await;
    let receipt = f.start().await.unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        executor.started.notified(),
    )
    .await
    .unwrap();
    assert_eq!(
        f.start().await.unwrap().system_start_id,
        receipt.system_start_id
    );
    assert_eq!(executor.starts.load(Ordering::SeqCst), 1);
    let app = f.app.handle().clone();
    let system = receipt.system_start_id.clone();
    let mut stop = tokio::spawn(async move {
        crate::commands::agsdl_execution::execution_stop(
            app.clone(),
            app.state(),
            app.state(),
            crate::db::agsdl_execution::dto::EngineStopRequest {
                system_start_id: system,
                request_id: "command-stop".into(),
                activation_id: None,
            },
        )
        .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        executor.cancelled.notified(),
    )
    .await
    .unwrap();
    let app = f.app.handle().clone();
    let system = receipt.system_start_id.clone();
    let mut ensure = tokio::spawn(async move {
        crate::commands::agsdl_execution::execution_ensure_stop(
            app,
            crate::db::agsdl_execution::intents::ExecutionEnsureStopRequest {
                system_start_id: system,
                activation_id: None,
            },
        )
        .await
    });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut stop)
            .await
            .is_err(),
        "Stop returned before the executor's physical end"
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut ensure)
            .await
            .is_err(),
        "EnsureStop returned before physical end"
    );
    executor.cleanup.as_ref().unwrap().notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(5), stop)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), ensure)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(executor.starts.load(Ordering::SeqCst), 1);
    let owner = EngineOwner {
        system_start_id: receipt.system_start_id,
        owner_epoch: "0".into(),
    };
    let result = f.inspect(&owner.system_start_id).await;
    assert_eq!(result.flow.state.verdict.as_deref(), Some("cancelled"));
    assert!(result
        .flow
        .state
        .activations
        .iter()
        .all(|work| !work.physical));
    f.finish().await;
}

#[tokio::test]
async fn execution_start_attachment_failure_releases_waiters_even_when_marker_fails() {
    let _secret_guard = secrets::lock_test_store();
    let secret_root = tempfile::tempdir().unwrap();
    secrets::init(secret_root.path()).unwrap();
    for fail_marker in [false, true] {
        // Missing managed state fails after commit, before supervisor attachment.
        let f = CommandFixture::new(Arc::new(fake_executor()), false).await;
        if fail_marker {
            query("CREATE TRIGGER fail_marker BEFORE INSERT ON engine_flow030_interruptions BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END").execute(&f.fixture.pool).await.unwrap();
        }
        assert!(f.start().await.is_err());
        let system = f.only_system().await;
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(2), f.wait(&system))
                .await
                .unwrap()
                .is_err()
        );
        assert_eq!(f.interrupted(&system).await, !fail_marker);
        if fail_marker {
            query("DROP TRIGGER fail_marker")
                .execute(&f.fixture.pool)
                .await
                .unwrap();
            argentic_runtime::api::interrupt_previous_runs(&f.fixture.pool)
                .await
                .unwrap();
            assert!(f.interrupted(&system).await);
        }
        f.finish().await;
    }
}

#[tokio::test]
async fn supervisor_error_and_panic_mark_interrupted_and_release_waiters() {
    let _secret_guard = secrets::lock_test_store();
    let secret_root = tempfile::tempdir().unwrap();
    secrets::init(secret_root.path()).unwrap();
    for panic in [false, true] {
        let f = CommandFixture::new(Arc::new(fake_executor()), true).await;
        f.peer.install_failure(&f.host(), panic);
        let receipt = f.start().await.unwrap();
        let error = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            f.wait(&receipt.system_start_id),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert_eq!(
            error.code,
            if panic {
                "INTERRUPTED"
            } else {
                "HOST_CAPABILITY"
            }
        );
        assert!(f.interrupted(&receipt.system_start_id).await);
        f.finish().await;
    }
}

#[tokio::test]
async fn linked_graphless_start_uses_real_compiler_job_and_durable_intent() {
    use crate::db::agsdl_execution::{
        dto::*,
        intents::{
            self, ExecutionIntentAdmission, ExecutionIntentPayload, ExecutionIntentScope,
            ExecutionIntentState, ExecutionStageIntentRequest, Submission,
        },
    };
    use crate::workspace::metadata::{ProjectDto, WorkspaceState};

    let _secret_guard = crate::secrets::lock_test_store();
    let temp = tempfile::TempDir::new().unwrap();
    crate::secrets::init(&temp.path().join("secrets")).unwrap();
    let workspace = temp.path().join("workspace");
    let metadata = workspace.join(".macro");
    let project = workspace.join("project");
    let dir = project.join(".macro/branches/develop/plans/source");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::create_dir_all(&metadata).unwrap();
    let registered: ProjectDto = serde_json::from_value(serde_json::json!({
        "id":"project", "name":"Synthetic", "path":project, "created_at":"2026-01-01", "status":"active",
        "directEdit":true, "gitSetupState":"not_git",
        "metadata":{"description":"", "tags":[], "team_members":[], "api_contracts":[], "dependencies":[]}
    })).unwrap();
    let mut state = WorkspaceState::default();
    state.standalone_projects.push(registered);
    std::fs::write(
        metadata.join("workspace.json"),
        serde_json::to_vec(&state).unwrap(),
    )
    .unwrap();
    let authored = r#"{"contract":"agsdl-0.3.0","id":"empty","agents":{}}"#;
    std::fs::write(
        dir.join("plan.json"),
        serde_json::to_vec(&serde_json::json!({
            "id":"source", "projectIds":["project"], "revision":1, "updatedAt":"time",
            "agsdl":{"source":authored}
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        dir.join("manifest.json"),
        serde_json::to_vec(&serde_json::json!({
            "planId":"source", "targetBranch":"develop", "revision":1, "updatedAt":"time",
            "conversation":{"conversationId":"conversation"}
        }))
        .unwrap(),
    )
    .unwrap();
    let scope = ExecutionIntentScope {
        owner: EngineSourceOwner {
            project_id: "project".into(),
            plan_id: "source".into(),
            branch: "develop".into(),
        },
        conversation_id: "conversation".into(),
    };
    let locked = crate::workspace::architect::lock_execution_intent_scope(
        &workspace, &metadata, &scope, None,
    )
    .await
    .unwrap();
    let request = EngineStartRequest {
        source: locked.revision.clone(),
        profile: "macro-agsdl-030-v1".into(),
        associations: EngineAssociations::default(),
        request_id: "request".into(),
        entry: None,
    };
    drop(locked);
    let pool = crate::db::create_pool(&temp.path().join("linked.db"))
        .await
        .unwrap();
    sqlx::query("INSERT INTO conversations(id,title,project_id,created_at,updated_at) VALUES('conversation','Synthetic','project','0','0')")
        .execute(&pool).await.unwrap();
    let intent = intents::stage(
        &pool,
        ExecutionStageIntentRequest {
            scope,
            intent_id: "intent".into(),
            payload: ExecutionIntentPayload::Start {
                request: request.clone(),
            },
        },
        &request.source,
    )
    .await
    .unwrap();
    let link = match intents::begin_submission(&pool, &intent.key, &request.source)
        .await
        .unwrap()
    {
        Submission::Dispatch(link) => link,
        _ => panic!("expected pending intent"),
    };
    let manager = crate::config::ConfigManager::initialize(temp.path().join("config"))
        .await
        .unwrap();
    manager
        .register_project_root("project", metadata.clone())
        .await
        .unwrap();
    let host = HostState::new();
    let git = crate::git::GitState::new();
    let retained = crate::agsdl_host_start_adapter030::start_linked::<tauri::Wry>(
        None,
        &host,
        &manager,
        &pool,
        &workspace,
        &git,
        &request,
        Some(&link),
    )
    .await
    .unwrap();

    let state_json: String = sqlx::query_scalar(
        "SELECT state_json FROM engine_flow030_runs WHERE system_id = ? AND invocation_id = ?",
    )
    .bind(&retained.receipt.identity.system_start_id)
    .bind(&retained.receipt.identity.flow_invocation_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let graphless_state: crate::db::agsdl_execution::flow030::FlowState030 =
        serde_json::from_str(&state_json).unwrap();
    assert!(graphless_state.plan_json.is_none());
    assert!(graphless_state.events.is_empty());
    assert!(!graphless_state.entered);
    let public = crate::commands::agsdl_execution::public_start030(&request, &retained);
    assert_eq!(
        public.system_start_id,
        retained.receipt.identity.system_start_id
    );
    assert_eq!(
        public.flow_invocation_id,
        retained.receipt.identity.flow_invocation_id
    );
    assert_eq!(public.snapshot.source, retained.capture.source);
    assert_eq!(public.snapshot.versions, retained.capture.versions);
    let snapshot = crate::commands::agsdl_execution::read_public_snapshot(
        &pool,
        &retained.receipt.identity.system_start_id,
    )
    .await
    .unwrap();
    assert_eq!(
        snapshot.system_start_id,
        retained.receipt.identity.system_start_id
    );
    assert_eq!(snapshot.source, request.source);
    assert_eq!(snapshot.versions, retained.capture.versions);
    assert_eq!(snapshot.authored_source, retained.capture.authored_source);
    let list_request = crate::db::agsdl_execution::discovery030::RunListRequest030 {
        owner: request.source.owner.clone(),
        after: None,
        limit: Some(10),
    };
    let page = crate::commands::agsdl_execution::list_runs030_scoped(
        &pool,
        &workspace,
        list_request.clone(),
    )
    .await
    .unwrap();
    assert_eq!(page.runs.len(), 1);
    assert_eq!(
        page.runs[0].system_start_id,
        retained.receipt.identity.system_start_id
    );
    let mut foreign = list_request;
    foreign.owner.project_id = "unknown-project".into();
    assert!(
        crate::commands::agsdl_execution::list_runs030_scoped(&pool, &workspace, foreign)
            .await
            .is_err()
    );
    let read = intents::read(&pool, &intent.key).await.unwrap().unwrap();
    match read.state {
        ExecutionIntentState::Admitted {
            admission: ExecutionIntentAdmission::Start030 { receipt },
        } => {
            assert_eq!(
                receipt.system_start_id,
                retained.receipt.identity.system_start_id
            );
            assert_eq!(receipt.versions, retained.capture.versions);
            assert_eq!(receipt.entry_delivery_id, None);
        }
        _ => panic!("expected linked 0.3 admission"),
    }
    // A lost acknowledgement must recover the committed capture, even after
    // the author edits the source. No second compiler job is available here.
    std::fs::write(
        dir.join("plan.json"),
        serde_json::to_vec(&serde_json::json!({
            "id":"source", "projectIds":["project"], "revision":2, "updatedAt":"later",
            "agsdl":{"source":"{\"contract\":\"agsdl-0.3.0\",\"id\":\"changed\",\"agents\":{}}"}
        }))
        .unwrap(),
    )
    .unwrap();
    let replay = crate::agsdl_host_start_adapter030::start_linked::<tauri::Wry>(
        None,
        &host,
        &manager,
        &pool,
        &workspace,
        &git,
        &request,
        Some(&link),
    )
    .await
    .unwrap();
    assert_eq!(replay.receipt, retained.receipt);
    assert_eq!(replay.capture.authored_source, authored);
    std::fs::write(
        dir.join("plan.json"),
        serde_json::to_vec(&serde_json::json!({
            "id":"source", "projectIds":["project"], "revision":3, "updatedAt":"later"
        }))
        .unwrap(),
    )
    .unwrap();
    let history = crate::db::agsdl_execution::discovery030::RunListRequest030 {
        owner: request.source.owner.clone(),
        after: None,
        limit: Some(10),
    };
    let page =
        crate::commands::agsdl_execution::list_runs030_scoped(&pool, &workspace, history.clone())
            .await
            .unwrap();
    assert_eq!(
        page.runs[0].system_start_id,
        retained.receipt.identity.system_start_id
    );
    assert!(crate::workspace::architect::lock_execution_source_owner(
        &workspace,
        &metadata,
        &request.source.owner,
        None,
    )
    .await
    .is_err());
    let mut foreign_plan = history;
    foreign_plan.owner.plan_id = "not-this-plan".into();
    assert!(
        crate::commands::agsdl_execution::list_runs030_scoped(&pool, &workspace, foreign_plan)
            .await
            .is_err()
    );
    std::fs::write(
        dir.join("plan.json"),
        r#"{"id":"source","projectIds":["project"],"revision":3,"agsdl":{"source":"a","source":"b"}}"#,
    )
    .unwrap();
    assert!(crate::workspace::architect::lock_execution_source_owner(
        &workspace,
        &metadata,
        &request.source.owner,
        None,
    )
    .await
    .is_err());
    let malformed = crate::db::agsdl_execution::discovery030::RunListRequest030 {
        owner: request.source.owner.clone(),
        after: None,
        limit: Some(10),
    };
    assert_eq!(
        crate::commands::agsdl_execution::list_runs030_scoped(&pool, &workspace, malformed)
            .await
            .unwrap()
            .runs
            .len(),
        1
    );
    std::fs::write(
        dir.join("plan.json"),
        serde_json::to_vec(&serde_json::json!({
            "id":"source", "projectIds":["project"], "revision":3,
            "updatedAt":"later", "archivedAt":"2026-01-01"
        }))
        .unwrap(),
    )
    .unwrap();
    let archived = crate::db::agsdl_execution::discovery030::RunListRequest030 {
        owner: request.source.owner.clone(),
        after: None,
        limit: Some(10),
    };
    assert_eq!(
        crate::commands::agsdl_execution::list_runs030_scoped(&pool, &workspace, archived)
            .await
            .unwrap()
            .runs
            .len(),
        1
    );
    let approved = host.shutdown_active_runs(&pool).await.unwrap();
    host.prepare_shutdown(
        &pool,
        &crate::ai::stream_tasks::StreamTasks::default(),
        &approved,
    )
    .await
    .unwrap();
    assert!(host.inspect_start_session().await.is_err());
    // Model on-disk corruption by bypassing the immutable-record trigger only
    // in this disposable database; the public reader must fail closed.
    sqlx::query("DROP TRIGGER engine_start030_immutable")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE engine_start030_requests SET capture_json=json_set(capture_json, '$.source.revision', '999') WHERE system_id=?")
        .bind(&retained.receipt.identity.system_start_id)
        .execute(&pool)
        .await
        .unwrap();
    let error = crate::commands::agsdl_execution::read_public_snapshot(
        &pool,
        &retained.receipt.identity.system_start_id,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "CORRELATION");
}

#[tokio::test]
async fn application_default_ceiling_reaches_the_explicit_host_port() {
    let temp = tempfile::tempdir().unwrap();
    let manager = crate::config::ConfigManager::initialize(temp.path().join("config"))
        .await
        .unwrap();
    manager
        .register_project_root("fresh-project", temp.path().join("metadata"))
        .await
        .unwrap();
    let context = manager.engine_context();
    let lease = context.lock_execution_tools("fresh-project").await.unwrap();
    assert_eq!(
        serde_json::to_value(&lease.agsdl_host_permissions).unwrap(),
        json!("read-only")
    );
    let ceiling = context.lock_agsdl_host_permissions().await.unwrap();
    assert_eq!(
        serde_json::to_value(ceiling.permissions()).unwrap(),
        json!("read-only")
    );
}

#[tokio::test]
async fn pending_application_ceiling_does_not_reach_runtime_until_accepted() {
    use crate::config::{ConfigChangeSource, ConfigDocumentKind, ConfigScope};
    let temp = tempfile::tempdir().unwrap();
    let manager = crate::config::ConfigManager::initialize(temp.path().join("config"))
        .await
        .unwrap();
    let document = manager
        .get_document(ConfigDocumentKind::Tools, ConfigScope::User)
        .await
        .unwrap();
    let mut value = document.value;
    value["agsdlHostPermissions"] = json!("workspace");
    std::fs::write(&document.file_path, serde_json::to_vec(&value).unwrap()).unwrap();
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
    let context = manager.engine_context();
    {
        let ceiling = context.lock_agsdl_host_permissions().await.unwrap();
        assert_eq!(
            serde_json::to_value(ceiling.permissions()).unwrap(),
            json!("read-only")
        );
    }
    manager.accept_pending_change(&pending.id).await.unwrap();
    let ceiling = context.lock_agsdl_host_permissions().await.unwrap();
    assert_eq!(
        serde_json::to_value(ceiling.permissions()).unwrap(),
        json!("workspace")
    );
}
