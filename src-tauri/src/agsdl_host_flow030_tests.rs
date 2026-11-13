//! Exercises the real flow façade with a locally seeded capture. This does not
//! qualify production capture, providers or operating-system confinement.
use super::*;
use crate::agsdl_host_flow030 as flow;
use crate::db::agsdl_execution::{
    flow030::{FlowEvent030, FlowEventKind030, FlowIdentity030, FlowPlan030, FlowState030},
    start030::StartCapture030,
};
use sha2::{Digest, Sha256};

/// Real 02 compilation and 03 policy for the in-process example adapter.
/// SQL flow/owner rows in the calling tests remain explicit fixtures.
#[cfg(feature = "agsdl-engine-qa")]
async fn example_agent_capture(
    root: &std::path::Path,
    identity: &FlowIdentity030,
) -> (StartCapture030, crate::config::ConfigManager) {
    let workspace = root.join("agent-workspace");
    let metadata = root.join("agent-metadata");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&metadata).unwrap();
    let manager = crate::config::ConfigManager::initialize(root.join("agent-config"))
        .await
        .unwrap();
    manager
        .register_project_root("project", metadata)
        .await
        .unwrap();
    let document: serde_json::Value = serde_json::from_str(include_str!(
        "../../dev/agsdl/fixtures/v0.3/conformance/runs/error-route.json"
    ))
    .unwrap();
    let authored = document["document"].to_string();
    let source_sha = format!("{:x}", Sha256::digest(authored.as_bytes()));
    let source: crate::db::agsdl_execution::dto::EngineSourceRevision = serde_json::from_value(serde_json::json!({
        "owner":{"projectId":"project","planId":"source","branch":"develop"},"revision":"1","sourceSha256":source_sha
    })).unwrap();
    let root_id = crate::fs::operations::workspace_root_identity(&workspace)
        .unwrap()
        .observation_key()
        .unwrap();
    let scope = serde_json::json!({"projectId":"project","root":workspace,"rootIdentity":root_id,"sourceOwner":source.owner});
    let observation = crate::agsdl_host_example030::ExampleAdapter030::observe()
        .registry(&document["document"], &authored, &source_sha, &scope)
        .unwrap();
    let mut registry = observation;
    registry["format"] = serde_json::json!("macro-agsdl-registry/030");
    registry["version"] = serde_json::json!(format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(&registry).unwrap())
    ));
    registry["hostCapabilities"] = serde_json::json!([]);
    let receipt = crate::agsdl_host_compiler::CompileBroker::default()
        .compile_native(
            "generation",
            source.clone(),
            authored.clone(),
            registry.to_string(),
            &tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
    let compiled: serde_json::Value = serde_json::from_str(&receipt.result_json).unwrap();
    let plan = compiled["compiledPlanJson"]
        .as_str()
        .expect("real compiler plan")
        .to_owned();
    let tools = manager.lock_execution_tools("project").await.unwrap();
    let permissions = crate::agsdl_host_tools::permissions("Implement", false, &tools.tools)
        .unwrap()
        .to_string();
    drop(tools);
    let capture = StartCapture030 { identity: identity.clone(), source, versions: serde_json::from_value(serde_json::from_str::<serde_json::Value>(&plan).unwrap()["versions"].clone()).unwrap(),
        authored_source: authored, compiled_plan_json: plan, registry_json: registry.to_string(),
        private_capture_json: serde_json::json!({"format":"macro-native-flow-capture/030","callPermissionsJson":permissions,"callScopeJson":scope.to_string()}).to_string() };
    (capture, manager)
}

#[cfg(feature = "agsdl-engine-qa")]
async fn example_policy_for_refusal(
    root: &std::path::Path,
    identity: &FlowIdentity030,
) -> crate::agsdl_host_work_admission030::AttestedWorkPolicy030 {
    use crate::db::agsdl_execution::{
        flow030::{self, FlowEvent030, FlowEventKind030},
        flow_store030::FlowView030,
    };
    let (capture, manager) = example_agent_capture(root, identity).await;
    let plan: FlowPlan030 = serde_json::from_str(&capture.compiled_plan_json).unwrap();
    let transition = flow030::reduce(
        &plan,
        &FlowState030::new(identity.clone()),
        &FlowEvent030 {
            identity: identity.clone(),
            event_id: "fixture-enter".into(),
            expected_revision: "0".into(),
            kind: FlowEventKind030::Enter {
                message_json: r#"{"prompt":"Start."}"#.into(),
            },
        },
    )
    .unwrap();
    let effect = transition
        .effects
        .iter()
        .find(|e| {
            matches!(
                &e.kind,
                flow030::FlowEffectKind030::Start { agent: Some(_), .. }
            )
        })
        .unwrap()
        .clone();
    let inspection = flow::NativeFlowInspection030 {
        owner: EngineOwner {
            system_start_id: identity.system_start_id.clone(),
            owner_epoch: "owner".into(),
        },
        capture,
        flow: FlowView030 {
            state: transition.state,
            events: vec![],
            effects: vec![serde_json::json!({"status":"pending","effect":effect})],
        },
    };
    let prepared = crate::agsdl_host_work_admission030::prepare_effective_agent_work030(
        &manager,
        &inspection,
        &effect,
    )
    .await
    .unwrap();
    crate::agsdl_host_work_admission030::AttestedWorkPolicy030::from_example(
        prepared,
        &crate::agsdl_host_example030::ExampleAdapter030::observe(),
    )
    .unwrap()
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
    let incarnation = Arc::new(Incarnation {
        generation: "generation".into(),
        compiler: Default::default(),
        work_protocol: Default::default(),
        route030: Default::default(),
        lifecycle: Arc::new(tokio::sync::RwLock::new(())),
        handoff: Mutex::new(()),
        live: AtomicBool::new(true),
        ready: AtomicBool::new(true),
        retired: Default::default(),
        owners: Mutex::new(BTreeMap::new()),
    });
    let host = HostState(
        Mutex::new(Some(OwnedHost {
            incarnation: incarnation.clone(),
        })),
        Arc::new(tokio::sync::Mutex::new(())),
        Default::default(),
    );

    let runtime = host.flow030();
    let git = crate::git::GitState::new();
    let retained = flow::start_linked::<tauri::Wry>(
        None,
        runtime,
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
    let replay = flow::start_linked::<tauri::Wry>(
        None,
        runtime,
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
    let controls = runtime.retiring_controls("generation").unwrap();
    assert_eq!(controls.len(), 1);
    assert!(revoke_now(&incarnation));
    fence_generation(
        &pool,
        &[EngineOwner {
            system_start_id: retained.receipt.identity.system_start_id.clone(),
            owner_epoch: "0".into(),
        }],
        "generation",
    )
    .await
    .unwrap();
    let tasks = crate::ai::stream_tasks::StreamTasks::default();
    stop_retired_flows(runtime, &pool, &tasks, "generation")
        .await
        .unwrap();
    let view = controls[0].read(&pool).await.unwrap();
    assert!(view.state.stopping || view.state.verdict.is_some());
    assert!(
        flow::claim_next(runtime, &host, &pool, &retained.receipt.identity)
            .await
            .is_err()
    );
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

#[tokio::test(flavor = "current_thread")]
async fn flow_handoff_is_owned_once_and_revocation_rejects_later_claims() {
    exercise_handoff(0).await;
}

#[tokio::test(flavor = "current_thread")]
async fn failed_handoff_never_polls_work_or_replays_uncertain_effect() {
    exercise_handoff(1).await;
}

#[tokio::test(flavor = "current_thread")]
async fn dropped_dispatch_lease_never_reissues_claim() {
    exercise_handoff(2).await;
}

#[tokio::test(flavor = "current_thread")]
async fn work_commit_readback_requires_exact_sql_receipt() {
    exercise_handoff(3).await;
}

#[tokio::test(flavor = "current_thread")]
async fn work_barrier_refuses_empty_and_pending_effect_claims() {
    exercise_handoff(4).await;
}

#[tokio::test(flavor = "current_thread")]
async fn revoked_after_handoff_commit_never_polls_owned_effect() {
    exercise_handoff(5).await;
}

#[tokio::test(flavor = "current_thread")]
async fn released_effect_remains_owned_until_cancelled_and_joined() {
    exercise_handoff(6).await;
}

#[tokio::test(flavor = "current_thread")]
#[cfg(feature = "agsdl-engine-qa")]
async fn agent_handoff_commits_the_exact_attempt_before_first_poll() {
    exercise_handoff(7).await;
}

#[tokio::test(flavor = "current_thread")]
#[cfg(feature = "agsdl-engine-qa")]
async fn failed_agent_handoff_never_polls_the_attempt() {
    exercise_handoff(8).await;
}

#[tokio::test(flavor = "current_thread")]
#[cfg(feature = "agsdl-engine-qa")]
async fn agent_revocation_after_commit_refuses_first_poll() {
    exercise_handoff(9).await;
}

#[tokio::test(flavor = "current_thread")]
#[cfg(feature = "agsdl-engine-qa")]
async fn non_agent_start_cannot_mint_an_agent_attempt() {
    exercise_handoff(10).await;
}

#[tokio::test(flavor = "current_thread")]
#[cfg(feature = "agsdl-engine-qa")]
async fn joined_terminal_uses_one_physical_work_result_and_exact_replay() {
    exercise_handoff(11).await;
}

async fn exercise_handoff(mode: u8) {
    let temp = tempfile::TempDir::new().unwrap();
    let pool = crate::db::create_pool(&temp.path().join("flow.db"))
        .await
        .unwrap();
    let identity = FlowIdentity030 {
        system_start_id: "system".into(),
        flow_invocation_id: "flow".into(),
        snapshot_id: "snapshot".into(),
        epoch: "capture".into(),
    };
    let original_plan = include_str!("../tests/fixtures/agsdl030_compiled_plan.json");
    // Explicit fixture: retain the compiled plan shape but select the agent
    // entry to exercise native ownership without invoking a provider.
    #[cfg(feature = "agsdl-engine-qa")]
    let example = if matches!(mode, 7..=9 | 11) {
        Some(example_agent_capture(temp.path(), &identity).await)
    } else {
        None
    };
    #[cfg(not(feature = "agsdl-engine-qa"))]
    let example: Option<(StartCapture030, crate::config::ConfigManager)> = None;
    let capture = if let Some((capture, _)) = &example {
        capture.clone()
    } else {
        let plan: FlowPlan030 = serde_json::from_str(original_plan).unwrap();
        StartCapture030 {
            identity: identity.clone(),
            source: serde_json::from_value(plan.source.clone()).unwrap(),
            versions: serde_json::from_value(serde_json::to_value(&plan.versions).unwrap())
                .unwrap(),
            authored_source: "{}".into(),
            compiled_plan_json: original_plan.into(),
            registry_json: "{}".into(),
            private_capture_json: "{}".into(),
        }
    };
    let plan_json = capture.compiled_plan_json.as_str();
    let plan: FlowPlan030 = serde_json::from_str(plan_json).unwrap();
    let capture_json = serde_json::to_string(&capture).unwrap();
    let capture_sha = format!("{:x}", Sha256::digest(capture_json.as_bytes()));
    let state_json = serde_json::to_string(&FlowState030::new(identity.clone())).unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO engine_flow030_runs VALUES (?,?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind("snapshot")
        .bind("capture")
        .bind(plan.source.to_string())
        .bind(plan_json)
        .bind(state_json)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_start030_requests VALUES (?,?,?,?,?,?,?,?)")
        .bind("request")
        .bind("{}")
        .bind("system")
        .bind("flow")
        .bind("snapshot")
        .bind("capture")
        .bind(&capture_json)
        .bind("{}")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_owners VALUES (?,?,?,?,?,?,?,?)")
        .bind("system")
        .bind("flow")
        .bind("snapshot")
        .bind("capture")
        .bind("owner")
        .bind("generation")
        .bind("live")
        .bind(&capture_sha)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let owner = EngineOwner {
        system_start_id: "system".into(),
        owner_epoch: "owner".into(),
    };
    let incarnation = Arc::new(Incarnation {
        generation: "generation".into(),
        compiler: Default::default(),
        work_protocol: Default::default(),
        route030: Default::default(),
        lifecycle: Arc::new(tokio::sync::RwLock::new(())),
        handoff: Mutex::new(()),
        live: AtomicBool::new(true),
        ready: AtomicBool::new(true),
        retired: Default::default(),
        owners: Mutex::new(BTreeMap::from([("system".into(), owner.clone())])),
    });
    let host = HostState(
        Mutex::new(Some(OwnedHost {
            incarnation: incarnation.clone(),
        })),
        Arc::new(tokio::sync::Mutex::new(())),
        Default::default(),
    );
    let runtime = host.flow030();
    let event = FlowEvent030 {
        identity: identity.clone(),
        event_id: "enter".into(),
        expected_revision: "0".into(),
        kind: FlowEventKind030::Enter {
            message_json: "{}".into(),
        },
    };
    flow::apply_native_event(runtime, &host, &pool, &event)
        .await
        .unwrap();
    let scope = crate::agsdl_host_projection030::RuntimeProjectionQuery030 {
        system_start_id: identity.system_start_id.clone(),
        source: capture.source.clone(),
        snapshot_id: None,
    };
    let projected = crate::agsdl_host_projection030::read(&host, &pool, scope.clone(), None)
        .await
        .unwrap();
    assert_eq!(projected.revision, "1");
    assert_eq!(projected.scope.snapshot_id, identity.snapshot_id);
    assert!(!projected.items.is_empty());
    let mut wrong_scope = scope;
    wrong_scope.snapshot_id = Some("other".into());
    assert!(
        crate::agsdl_host_projection030::read(&host, &pool, wrong_scope, None)
            .await
            .is_err()
    );
    if mode == 4 {
        use crate::db::agsdl_execution::flow030::{FlowEffect030, FlowEffectKind030};
        let raw: String = sqlx::query_scalar("SELECT effect_json FROM engine_flow030_outbox WHERE system_id='system' AND invocation_id='flow' LIMIT 1")
            .fetch_one(&pool).await.unwrap();
        let original: FlowEffect030 = serde_json::from_str(&raw).unwrap();
        let work = match &original.kind {
            FlowEffectKind030::Start { work, .. } => work.clone(),
            _ => panic!("fixture must start a work"),
        };
        sqlx::query(
            "DELETE FROM engine_flow030_outbox WHERE system_id='system' AND invocation_id='flow'",
        )
        .execute(&pool)
        .await
        .unwrap();
        let marker = runtime
            .begin_work_commit(&identity, "blocked-work", "{}", "{}")
            .unwrap();
        let generic_stop = FlowEvent030 {
            identity: identity.clone(),
            event_id: "blocked-generic-stop".into(),
            expected_revision: "1".into(),
            kind: FlowEventKind030::Stop,
        };
        assert_eq!(
            flow::apply_native_event(runtime, &host, &pool, &generic_stop)
                .await
                .unwrap_err()
                .code,
            "UNCERTAIN"
        );
        let generic_end = FlowEvent030 {
            identity: identity.clone(),
            event_id: "blocked-generic-end".into(),
            expected_revision: "1".into(),
            kind: FlowEventKind030::PhysicalEnded {
                work: work.clone(),
                stop_effect_id: None,
                evidence: crate::db::agsdl_execution::flow030::PhysicalEvidence030 {
                    native_receipt_id: "fixture-only".into(),
                    descendants_joined: true,
                },
            },
        };
        assert_eq!(
            flow::apply_native_event(runtime, &host, &pool, &generic_end)
                .await
                .unwrap_err()
                .code,
            "UNCERTAIN"
        );
        assert!(flow::claim_next(runtime, &host, &pool, &identity)
            .await
            .is_err());
        for effect in [
            original.clone(),
            FlowEffect030 {
                id: "stop-effect".into(),
                identity: identity.clone(),
                revision: "1".into(),
                kind: FlowEffectKind030::StopWork {
                    work,
                    include_descendants: true,
                },
            },
            FlowEffect030 {
                id: "ended-effect".into(),
                identity: identity.clone(),
                revision: "1".into(),
                kind: FlowEffectKind030::RunEnded {
                    verdict: "success".into(),
                },
            },
        ] {
            sqlx::query("INSERT INTO engine_flow030_outbox VALUES (?,?,?,?,?,?,?,NULL)")
                .bind("system")
                .bind("flow")
                .bind(&effect.id)
                .bind("enter")
                .bind(serde_json::to_string(&effect).unwrap())
                .bind("owner")
                .bind("pending")
                .execute(&pool)
                .await
                .unwrap();
            assert!(flow::claim_next(runtime, &host, &pool, &identity)
                .await
                .is_err());
            let status: String = sqlx::query_scalar(
                "SELECT status FROM engine_flow030_outbox WHERE system_id='system' AND effect_id=?",
            )
            .bind(&effect.id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(status, "pending");
            sqlx::query(
                "DELETE FROM engine_flow030_outbox WHERE system_id='system' AND effect_id=?",
            )
            .bind(&effect.id)
            .execute(&pool)
            .await
            .unwrap();
        }
        runtime.acknowledge_work_commit(&marker).unwrap(); // Fixture cleanup only.
        return;
    }
    let mut agent_policy: Option<crate::agsdl_host_work_admission030::AttestedWorkPolicy030> = None;
    #[cfg(feature = "agsdl-engine-qa")]
    if let Some((_, manager)) = &example {
        let inspection = flow::inspect_run(runtime, &host, &pool, &owner)
            .await
            .unwrap();
        let effect: crate::db::agsdl_execution::flow030::FlowEffect030 = serde_json::from_value(
            inspection
                .flow
                .effects
                .iter()
                .find(|row| row["status"] == "pending")
                .unwrap()["effect"]
                .clone(),
        )
        .unwrap();
        let prepared = crate::agsdl_host_work_admission030::prepare_effective_agent_work030(
            manager,
            &inspection,
            &effect,
        )
        .await
        .unwrap();
        agent_policy = Some(
            crate::agsdl_host_work_admission030::AttestedWorkPolicy030::from_example(
                prepared,
                &crate::agsdl_host_example030::ExampleAdapter030::observe(),
            )
            .unwrap(),
        );
    } else if mode == 10 {
        agent_policy = Some(example_policy_for_refusal(temp.path(), &identity).await);
    }
    let claim = flow::claim_next(runtime, &host, &pool, &identity)
        .await
        .unwrap()
        .unwrap();
    let effect_id = claim.effect().id.clone();
    let tasks = crate::ai::stream_tasks::StreamTasks::default();
    let request_id = claim.request_id();
    if mode == 10 {
        let constructed = Arc::new(AtomicBool::new(false));
        let observed = constructed.clone();
        let result = claim
            .handoff_agent(
                &tasks,
                agent_policy.take().expect("native example policy"),
                move |_| {
                    observed.store(true, Ordering::SeqCst);
                    async {}
                },
            )
            .await;
        assert!(result.is_err());
        assert!(!constructed.load(Ordering::SeqCst));
        assert!(!tasks.cancel_owned(&request_id).await.unwrap());
        return;
    }
    if mode == 2 {
        drop(claim);
        assert!(!tasks.cancel_owned(&request_id).await.unwrap());
        let status: String = sqlx::query_scalar("SELECT status FROM engine_flow030_outbox WHERE system_id='system' AND invocation_id='flow' AND effect_id=?")
            .bind(&effect_id).fetch_one(&pool).await.unwrap();
        assert_eq!(status, "uncertain");
        assert!(flow::claim_next(runtime, &host, &pool, &identity)
            .await
            .unwrap()
            .is_none());
        return;
    }
    let fail_handoff = mode == 1 || mode == 8;
    if fail_handoff {
        sqlx::query("CREATE TRIGGER reject_flow_handoff BEFORE INSERT ON engine_flow030_handoffs BEGIN SELECT RAISE(ABORT, 'test rejection'); END")
            .execute(&pool).await.unwrap();
    }
    if mode == 5 || mode == 9 {
        let hook = runtime.install_handoff_commit_hook(&identity, &effect_id);
        let polled = Arc::new(AtomicBool::new(false));
        let observed = polled.clone();
        let operation = async {
            if mode == 9 {
                claim
                    .handoff_agent(
                        &tasks,
                        agent_policy.take().expect("native example policy"),
                        |_| async move {
                            observed.store(true, Ordering::SeqCst);
                        },
                    )
                    .await
            } else {
                claim
                    .handoff_host(&tasks, async move {
                        observed.store(true, Ordering::SeqCst);
                    })
                    .await
            }
        };
        let revoke = async {
            hook.reached().await;
            assert!(revoke_now(&incarnation));
            hook.release();
        };
        let (result, ()) = tokio::join!(operation, revoke);
        assert_eq!(result.unwrap_err().code, "UNCERTAIN");
        tasks.cancel_owned(&request_id).await.unwrap();
        assert!(!polled.load(Ordering::SeqCst));
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM engine_flow030_handoffs WHERE system_id='system' AND effect_id=?",
        )
        .bind(&effect_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 1);
        return;
    }
    if mode == 6 {
        let (started, done) = tokio::sync::oneshot::channel();
        claim
            .handoff_host(&tasks, async move {
                let _ = started.send(());
                std::future::pending::<()>().await;
            })
            .await
            .unwrap();
        done.await.unwrap();
        assert!(revoke_now(&incarnation));
        assert!(tasks.cancel_owned(&request_id).await.unwrap());
        return;
    }
    if mode == 7 || mode == 11 {
        let pool_for_work = pool.clone();
        let id_for_work = effect_id.clone();
        let host_for_work = incarnation.clone();
        let tasks_for_work = tasks.clone();
        let request_for_work = request_id.clone();
        let gate_for_work = host.admission_lock();
        let (first_poll, receipt) = tokio::sync::oneshot::channel();
        claim.handoff_agent(&tasks, agent_policy.take().expect("native example policy"), move |attempt| async move {
            let raw: String = sqlx::query_scalar(
                "SELECT receipt_json FROM engine_flow030_handoffs WHERE system_id='system' AND effect_id=?",
            )
            .bind(&id_for_work)
            .fetch_one(&pool_for_work)
            .await
            .unwrap();
            let retained: serde_json::Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(retained["workAttempt"], serde_json::to_value(&attempt).unwrap());
            // Explicit fixture only: this tests ownership attribution, not a
            // durable operation claim or authorization to call a provider.
            let lease = HostStartLease {
                host: host_for_work.clone(),
                _guard: host_for_work.lifecycle.clone().read_owned().await,
            };
            let admission = gate_for_work.lock_owned().await;
            let operation = crate::ai::stream_tasks::OwnedOperation030 {
                identity: attempt.identity().clone(),
                context: crate::db::agsdl_execution::dto::EngineContext {
                    owner: attempt.owner().clone(),
                    work: attempt.work().clone(),
                    permissions_json: "{}".into(),
                    scope_json: "{}".into(),
                    registry_version: "fixture".into(),
                },
                generation: attempt.generation().into(),
                agent: attempt.agent().into(),
                provider_attempt_id: attempt.provider_attempt_id().into(),
                operation_id: "fixture-operation".into(),
                method: "turn/start".into(),
                request_json: r#"{"value":1e0}"#.into(),
            };
            let mut foreign = operation.clone();
            foreign.context.work.activation_id = "foreign".into();
            assert!(lease.attach_owned_operation030(&tasks_for_work, &request_for_work, foreign).is_err());
            let permit = lease.attach_owned_operation030(&tasks_for_work, &request_for_work, operation.clone()).unwrap();
            assert_eq!(permit.into_operation().unwrap(), operation);
            drop(admission);
            drop(lease);
            let _ = first_poll.send(attempt);
            if mode == 7 { std::future::pending::<()>().await; }
        }).await.unwrap();
        let attempt = receipt.await.unwrap();
        assert_eq!(attempt.start_effect_id(), effect_id);
        assert_eq!(attempt.identity(), &identity);
        assert_eq!(attempt.agent(), "dev");
        assert_eq!(
            attempt.work().step.as_deref(),
            Some(["build".to_string()].as_slice())
        );
        assert!(!attempt.provider_attempt_id().is_empty());
        // The handoff writer creates this admission from the real 03 policy;
        // the test never inserts its own grant.
        let context_raw: String = sqlx::query_scalar("SELECT context_json FROM engine_flow030_work_admissions WHERE system_id=? AND invocation_id=? AND activation_id=?")
            .bind(&identity.system_start_id).bind(&identity.flow_invocation_id).bind(&attempt.work().activation_id)
            .fetch_one(&pool).await.unwrap();
        let context: crate::db::agsdl_execution::dto::EngineContext =
            serde_json::from_str(&context_raw).unwrap();
        let contract = crate::agsdl_host_work::captured_work_contract030(
            &crate::agsdl_host_work::CapturedWorkPlan030 {
                system_start_id: &identity.system_start_id,
                source: &capture.source,
                versions: &capture.versions,
                compiled_plan_json: &capture.compiled_plan_json,
            },
            attempt.work(),
            attempt.agent(),
        )
        .unwrap();
        let durable_contract: String = sqlx::query_scalar("SELECT contract_json FROM engine_flow030_work_admissions WHERE system_id=? AND invocation_id=? AND activation_id=?")
            .bind(&identity.system_start_id).bind(&identity.flow_invocation_id).bind(&attempt.work().activation_id)
            .fetch_one(&pool).await.unwrap();
        assert_eq!(durable_contract, contract);
        let input = crate::db::agsdl_execution::work_dto030::ProtocolEvent030 {
            context,
            event_id: "fixture-event".into(),
            expected_revision: "0".into(),
            event_json: serde_json::json!({
                "owner": {"systemStartId": attempt.owner().system_start_id,
                    "activationId": attempt.work().activation_id,
                    "agentInstanceId": attempt.work().agent_instance_id,
                    "ownerEpoch": attempt.owner().owner_epoch},
                "eventId":"fixture-event",
                "event": if mode == 11 { serde_json::json!({"kind":"submit","callId":"fixture-call","argumentsJson":"{}"}) } else { serde_json::json!({"kind":"visibleText","messageId":"fixture-message","textParts":["hello"]}) }
            })
            .to_string(),
            native_call: Some(
                crate::db::agsdl_execution::work_dto030::NativeCall030 {
                    provider_attempt_id: attempt.provider_attempt_id().into(),
                    native_call_id: "fixture-call".into(),
                },
            ),
            control: false,
        };
        let lease = host.start_lease().await.unwrap();
        let admission = host.admission_lock().lock_owned().await;
        let mut tx = pool.begin().await.unwrap();
        crate::db::agsdl_execution::flow_work_protocol030::verify_agent_attempt_tx(
            &mut tx, &lease, &identity, &attempt, &input,
        )
        .await
        .unwrap();
        let mut foreign = input.clone();
        foreign.native_call.as_mut().unwrap().provider_attempt_id = "foreign-attempt".into();
        assert!(
            crate::db::agsdl_execution::flow_work_protocol030::verify_agent_attempt_tx(
                &mut tx, &lease, &identity, &attempt, &foreign,
            )
            .await
            .is_err()
        );
        let mut foreign_step = input.clone();
        foreign_step.context.work.step = Some(vec!["foreign".into()]);
        let mut foreign_instance = input.clone();
        foreign_instance.context.work.agent_instance_id = Some("foreign".into());
        let mut foreign_epoch = input.clone();
        foreign_epoch.context.owner.owner_epoch = "foreign".into();
        for altered in [&foreign_step, &foreign_instance, &foreign_epoch] {
            assert!(
                crate::db::agsdl_execution::flow_work_protocol030::verify_agent_attempt_tx(
                    &mut tx, &lease, &identity, &attempt, altered,
                )
                .await
                .is_err()
            );
        }
        tx.rollback().await.unwrap();
        drop(admission);
        drop(lease);
        let cancel = tokio_util::sync::CancellationToken::new();
        assert!(
            crate::db::agsdl_execution::flow_work_protocol030::transition(
                &host, &pool, &identity, &input, &cancel,
            )
            .await
            .is_err()
        );
        assert!(
            crate::db::agsdl_execution::flow_work_protocol030::transition_agent(
                &host, &pool, &attempt, &foreign, &cancel,
            )
            .await
            .is_err()
        );
        let event_count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM engine_flow030_work_events")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(event_count, 0);
        sqlx::query("INSERT INTO engine_flow030_work_authorizations VALUES (?,?,?,?,?,?,?)")
            .bind(&identity.system_start_id)
            .bind(&identity.flow_invocation_id)
            .bind(&input.event_id)
            .bind(&input.context.work.activation_id)
            .bind(serde_json::to_string(&input).unwrap())
            .bind(attempt.provider_attempt_id())
            .bind("fixture-call")
            .execute(&pool)
            .await
            .unwrap();

        let decision = crate::db::agsdl_execution::flow_work_protocol030::transition_agent(
            &host, &pool, &attempt, &input, &cancel,
        )
        .await
        .unwrap();

        assert!(!decision.receipt_json.is_empty());
        let event_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM engine_flow030_work_events WHERE decision_json IS NOT NULL",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(event_count, 1);
        if mode == 11 {
            let joined = crate::agsdl_host_dispatch030::join_owned_agent030(&tasks, &attempt)
                .await
                .unwrap();

            let before_state: String = sqlx::query_scalar(
                "SELECT state_json FROM engine_flow030_runs WHERE system_id=? AND invocation_id=?",
            )
            .bind(&identity.system_start_id)
            .bind(&identity.flow_invocation_id)
            .fetch_one(&pool)
            .await
            .unwrap();
            let before_revision = serde_json::from_str::<serde_json::Value>(&before_state).unwrap()
                ["revision"]
                .as_str()
                .unwrap()
                .to_owned();
            let terminal =
                crate::db::agsdl_execution::flow_work_protocol030::finish_joined_agent030(
                    &host, &pool, &joined, &cancel,
                )
                .await
                .unwrap();

            let terminal_json: serde_json::Value =
                serde_json::from_str(&terminal.receipt_json).unwrap();
            assert_eq!(terminal_json["decision"]["kind"], "finished");
            let rows: Vec<(String,)> = sqlx::query_as("SELECT event_json FROM engine_flow030_events WHERE system_id=? AND invocation_id=? AND event_id LIKE 'work030:terminal:%'")
                .bind(&identity.system_start_id).bind(&identity.flow_invocation_id).fetch_all(&pool).await.unwrap();
            assert_eq!(rows.len(), 1);
            let output = &terminal_json["decision"]["output"];
            let output_json =
                crate::agsdl_host_route_verifier030::accepted_output_json(output).unwrap();
            let protocol_event_id = format!("physical:{}", attempt.provider_attempt_id());
            let event = FlowEvent030 {
                identity: identity.clone(),
                event_id: flow::work_terminal_event_id030(&identity, &protocol_event_id).unwrap(),
                expected_revision: before_revision,
                kind: FlowEventKind030::WorkResult {
                    work: crate::db::agsdl_execution::flow030::WorkRef030 {
                        activation_id: attempt.work().activation_id.clone(),
                        start_effect_id: attempt.start_effect_id().to_owned(),
                        agent_instance_id: attempt.work().agent_instance_id.clone(),
                    },
                    result: crate::db::agsdl_execution::flow030::WorkResult030::Completed {
                        output_json,
                        route_key: output
                            .get("choice")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_owned),
                    },
                    physical: Some(crate::db::agsdl_execution::flow030::PhysicalEvidence030 {
                        native_receipt_id: protocol_event_id,
                        descendants_joined: true,
                    }),
                },
            };
            assert_eq!(
                serde_json::to_value(&event).unwrap(),
                serde_json::from_str::<serde_json::Value>(&rows[0].0).unwrap()
            );
            let before: (i64,) = sqlx::query_as(
                "SELECT count(*) FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=?",
            )
            .bind(&identity.system_start_id)
            .bind(&identity.flow_invocation_id)
            .fetch_one(&pool)
            .await
            .unwrap();
            flow::apply_native_event(runtime, &host, &pool, &event)
                .await
                .unwrap();
            let after: (i64,) = sqlx::query_as(
                "SELECT count(*) FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=?",
            )
            .bind(&identity.system_start_id)
            .bind(&identity.flow_invocation_id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(before, after);
            let mut stale = event.clone();
            stale.event_id = "new-terminal-for-nonrunning".into();
            let current: String = sqlx::query_scalar(
                "SELECT state_json FROM engine_flow030_runs WHERE system_id=? AND invocation_id=?",
            )
            .bind(&identity.system_start_id)
            .bind(&identity.flow_invocation_id)
            .fetch_one(&pool)
            .await
            .unwrap();
            stale.expected_revision = serde_json::from_str::<FlowState030>(&current)
                .unwrap()
                .revision;
            assert!(flow::apply_native_event(runtime, &host, &pool, &stale)
                .await
                .is_err());
            let final_count: (i64,) = sqlx::query_as(
                "SELECT count(*) FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=?",
            )
            .bind(&identity.system_start_id)
            .bind(&identity.flow_invocation_id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(before, final_count);
            return;
        }
        assert!(revoke_now(&incarnation));
        assert!(tasks.cancel_owned(&request_id).await.unwrap());
        return;
    }
    let (started, done) = tokio::sync::oneshot::channel();
    let result = if mode == 8 {
        claim
            .handoff_agent(
                &tasks,
                agent_policy.take().expect("native example policy"),
                |_| async move {
                    let _ = started.send(());
                },
            )
            .await
    } else {
        claim
            .handoff_host(&tasks, async move {
                let _ = started.send(());
            })
            .await
    };
    if fail_handoff {
        assert!(result.is_err());
        assert!(
            done.await.is_err(),
            "work was polled after the failed handoff"
        );
    } else {
        result.unwrap();
        done.await.unwrap();
    }
    tasks.cancel_owned(&request_id).await.unwrap();
    let status: String = sqlx::query_scalar("SELECT status FROM engine_flow030_outbox WHERE system_id='system' AND invocation_id='flow' AND effect_id=?")
        .bind(&effect_id).fetch_one(&pool).await.unwrap();
    assert_eq!(status, if fail_handoff { "uncertain" } else { "settled" });
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM engine_flow030_handoffs WHERE system_id='system' AND effect_id=?",
    )
    .bind(&effect_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, i64::from(!fail_handoff));
    if mode == 3 {
        // The event is synthetic: this tests durable readback, not a real 04
        // producer or provider. The Start effect itself used native handoff.
        use crate::db::agsdl_execution::{
            dto::{EngineContext, EngineWork},
            flow_work_protocol030::{self, FlowWorkTicket030},
            work_dto030::{ProtocolDecision030, ProtocolEvent030},
        };
        let owner = EngineOwner {
            system_start_id: "system".into(),
            owner_epoch: "owner".into(),
        };
        let context = EngineContext {
            owner: owner.clone(),
            work: EngineWork {
                system_start_id: "system".into(),
                flow_invocation_id: "flow".into(),
                activation_id: "fixture-work".into(),
                step: None,
                agent_instance_id: Some("fixture-instance".into()),
            },
            permissions_json: "[]".into(),
            scope_json: "{}".into(),
            registry_version: "registry".into(),
        };
        let input = ProtocolEvent030 {
            context: context.clone(),
            event_id: "fixture-event".into(),
            expected_revision: "0".into(),
            event_json: "{}".into(),
            native_call: None,
            control: false,
        };
        let ticket = FlowWorkTicket030 {
            identity: identity.clone(),
            input: input.clone(),
            ticket_id: "ticket".into(),
            generation: "generation".into(),
            flow_revision: "1".into(),
            state_json: "{}".into(),
            contract_json: "{}".into(),
            options_json: "{}".into(),
        };
        let decision = ProtocolDecision030 { state_json: "{}".into(), receipt_json: r#"{"receiptId":"fixture-work:1","owner":{"systemStartId":"system","activationId":"fixture-work","agentInstanceId":"fixture-instance","ownerEpoch":"owner"},"revision":"1","decision":{"kind":"waiting"}}"#.into(), check: None };
        let ticket_raw = serde_json::to_string(&ticket).unwrap();
        let decision_raw = serde_json::to_string(&decision).unwrap();
        sqlx::query("INSERT INTO engine_flow030_work_admissions VALUES (?,?,?,?,?,?,?,?,?,?,?)")
            .bind("system")
            .bind("flow")
            .bind("fixture-work")
            .bind(&effect_id)
            .bind("owner")
            .bind("generation")
            .bind("a".repeat(64))
            .bind(serde_json::to_string(&context).unwrap())
            .bind("{}")
            .bind("{}")
            .bind("{}")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO engine_flow030_work_authorizations VALUES (?,?,?,?,?,?,?)")
            .bind("system")
            .bind("flow")
            .bind("fixture-event")
            .bind("fixture-work")
            .bind(serde_json::to_string(&input).unwrap())
            .bind(None::<String>)
            .bind(None::<String>)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO engine_flow030_work_events VALUES (?,?,?,?,?,?)")
            .bind("system")
            .bind("flow")
            .bind("fixture-event")
            .bind("fixture-work")
            .bind(&ticket_raw)
            .bind(&decision_raw)
            .execute(&pool)
            .await
            .unwrap();
        let wrong = runtime
            .begin_work_commit(&identity, "fixture-event", &ticket_raw, "{}")
            .unwrap();
        assert!(flow_work_protocol030::inspect_work_commit(
            &host,
            &pool,
            &identity,
            "fixture-event"
        )
        .await
        .is_err());
        assert!(runtime.available(&identity).is_err());
        runtime.acknowledge_work_commit(&wrong).unwrap(); // Fixture cleanup only.
        let marker = runtime
            .begin_work_commit(&identity, "fixture-event", &ticket_raw, &decision_raw)
            .unwrap();
        assert!(runtime.available(&identity).is_err());
        sqlx::query("UPDATE engine_flow030_owners SET status='revoked' WHERE system_id='system'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(flow_work_protocol030::inspect_work_commit(
            &host,
            &pool,
            &identity,
            "fixture-event"
        )
        .await
        .is_err());
        assert!(runtime
            .pending_work_commit(&identity, "fixture-event")
            .unwrap()
            .is_some());
        // Restoring this disposable fixture is not a production resume path.
        sqlx::query("UPDATE engine_flow030_owners SET status='live' WHERE system_id='system'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(flow_work_protocol030::inspect_work_commit(
            &host,
            &pool,
            &identity,
            "fixture-event"
        )
        .await
        .unwrap()
        .is_some());
        assert!(runtime.available(&identity).is_ok());
        assert!(runtime
            .pending_work_commit(&identity, marker.event_id())
            .unwrap()
            .is_none());
        let checks: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_flow030_work_checks")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(checks, 0);
        runtime
            .begin_work_commit(&identity, "fixture-event", &ticket_raw, &decision_raw)
            .unwrap();
    }
    if mode == 3 {
        assert!(flow::claim_next(runtime, &host, &pool, &identity)
            .await
            .is_err());
    } else {
        assert!(flow::claim_next(runtime, &host, &pool, &identity)
            .await
            .unwrap()
            .is_none());
    }
    assert!(revoke_now(&incarnation));
    if mode == 3 {
        assert!(
            crate::db::agsdl_execution::flow_work_protocol030::inspect_work_commit(
                &host,
                &pool,
                &identity,
                "fixture-event"
            )
            .await
            .is_err()
        );
        assert!(runtime
            .pending_work_commit(&identity, "fixture-event")
            .unwrap()
            .is_some());
    }
    assert!(flow::claim_next(runtime, &host, &pool, &identity)
        .await
        .is_err());
}
