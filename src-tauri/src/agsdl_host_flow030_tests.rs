//! Exercises the real flow façade with a locally seeded capture. This does not
//! qualify production capture, providers or operating-system confinement.
use super::*;
use crate::agsdl_host_flow030 as flow;
use crate::db::agsdl_execution::{
    flow030::{FlowEvent030, FlowEventKind030, FlowIdentity030, FlowPlan030, FlowState030},
    start030::StartCapture030,
};
use sha2::{Digest, Sha256};

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
    use tokio::io::AsyncWriteExt;

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
        loads: AtomicUsize::new(0),
        owners: Mutex::new(BTreeMap::new()),
        qa_request: Mutex::new(None),
    });
    let host = HostState(
        Mutex::new(Some(OwnedHost {
            incarnation: incarnation.clone(),
            resource: 0,
        })),
        Arc::new(tokio::sync::Mutex::new(())),
        Default::default(),
        Default::default(),
    );
    let compiler = incarnation.clone();
    let worker = tokio::spawn(async move {
        let job = compiler.compiler.next().await.unwrap();
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let script = r#"import {compileHost030} from './src/services/agsdlExecution/hostCompilation';
const job=JSON.parse(await Bun.stdin.text());
process.stdout.write(await compileHost030(job.authoredSource,job.source,JSON.parse(job.registryJson)));"#;
        let mut child = tokio::process::Command::new("bun")
            .args(["-e", script])
            .current_dir(root)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(&job).unwrap())
            .await
            .unwrap();
        let output = child.wait_with_output().await.unwrap();
        assert!(
            output.status.success(),
            "compiler: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        compiler
            .compiler
            .complete(
                &job.generation,
                &job.ticket,
                String::from_utf8(output.stdout).unwrap(),
            )
            .unwrap();
    });
    let runtime = host.flow030();
    let git = crate::git::GitState::new();
    let retained = flow::start_linked(
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
    worker.await.unwrap();
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
    let replay = flow::start_linked(
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
    let plan_json = include_str!("../tests/fixtures/agsdl030_compiled_plan.json");
    let plan: FlowPlan030 = serde_json::from_str(plan_json).unwrap();
    let capture = StartCapture030 {
        identity: identity.clone(),
        source: serde_json::from_value(plan.source.clone()).unwrap(),
        versions: serde_json::from_value(serde_json::to_value(&plan.versions).unwrap()).unwrap(),
        authored_source: "{}".into(),
        compiled_plan_json: plan_json.into(),
        registry_json: "{}".into(),
        private_capture_json: "{}".into(),
    };
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
        .bind(capture_sha)
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
        loads: AtomicUsize::new(0),
        owners: Mutex::new(BTreeMap::from([("system".into(), owner)])),
        qa_request: Mutex::new(None),
    });
    let host = HostState(
        Mutex::new(Some(OwnedHost {
            incarnation: incarnation.clone(),
            resource: 0,
        })),
        Arc::new(tokio::sync::Mutex::new(())),
        Default::default(),
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
    let claim = flow::claim_next(runtime, &host, &pool, &identity)
        .await
        .unwrap()
        .unwrap();
    let effect_id = claim.effect().id.clone();
    let tasks = crate::ai::stream_tasks::StreamTasks::default();
    let request_id = claim.request_id();
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
    let fail_handoff = mode == 1;
    if fail_handoff {
        sqlx::query("CREATE TRIGGER reject_flow_handoff BEFORE INSERT ON engine_flow030_handoffs BEGIN SELECT RAISE(ABORT, 'test rejection'); END")
            .execute(&pool).await.unwrap();
    }
    let (started, done) = tokio::sync::oneshot::channel();
    let result = claim
        .handoff(&tasks, async move {
            let _ = started.send(());
        })
        .await;
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
            work_protocol030::{ProtocolDecision030, ProtocolEvent030},
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
