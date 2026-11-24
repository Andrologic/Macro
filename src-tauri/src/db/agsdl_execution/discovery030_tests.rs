use super::super::{
    dto::{EngineAssociations, EngineEntry},
    flow030::{
        reduce, DeliveryOccurrence030, FlowEffectKind030, FlowEvent030, FlowEventKind030,
        FlowIdentity030, FlowTransition030, Instance030, OperatorEvent030, PhysicalEvidence030,
        PreparedBatch030, PreparedItem030, PreparedResult030, WorkRef030, WorkResult030,
    },
    SqlitePool,
};
use super::*;
use crate::db::create_pool;
use serde_json::{json, Value};
use tempfile::TempDir;

async fn list_runs030(pool: &SqlitePool, request: RunListRequest030) -> Result<RunPage030> {
    let mut tx = pool.begin().await?;
    let page = list_runs_in_transaction030(&mut tx, request).await?;
    tx.commit().await?;
    Ok(page)
}

fn owner(project: &str, branch: &str) -> EngineSourceOwner {
    EngineSourceOwner {
        project_id: project.into(),
        plan_id: "plan".into(),
        branch: branch.into(),
    }
}
fn request(scope: EngineSourceOwner, after: Option<String>, limit: u32) -> RunListRequest030 {
    RunListRequest030 {
        owner: scope,
        after,
        limit: Some(limit),
    }
}
async fn database() -> (TempDir, SqlitePool) {
    let temp = TempDir::new().unwrap();
    let pool = create_pool(&temp.path().join("discovery.db"))
        .await
        .unwrap();
    (temp, pool)
}
async fn seed(
    pool: &SqlitePool,
    key: &str,
    scope: EngineSourceOwner,
    status: &str,
    bad_hash: bool,
) {
    seed_plan(pool, key, scope, status, bad_hash, fork_plan()).await;
}

fn fork_plan() -> FlowPlan030 {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/agsdl030_compiled_plan.json"
    ))
    .unwrap()
}

async fn seed_plan(
    pool: &SqlitePool,
    key: &str,
    scope: EngineSourceOwner,
    status: &str,
    bad_hash: bool,
    mut plan: FlowPlan030,
) -> (FlowPlan030, FlowState030) {
    plan.versions.runtime = format!("runtime-{key}");
    let authored = plan.document_json.clone();
    let source = EngineSourceRevision {
        owner: scope,
        revision: "9007199254740993".into(),
        source_sha256: format!("{:x}", Sha256::digest(authored.as_bytes())),
    };
    plan.source = serde_json::to_value(&source).unwrap();
    let versions: EngineVersions =
        serde_json::from_value(serde_json::to_value(&plan.versions).unwrap()).unwrap();
    let identity = FlowIdentity030 {
        system_start_id: format!("system-{key}"),
        flow_invocation_id: format!("invocation-{key}"),
        snapshot_id: format!("snapshot-{key}"),
        epoch: format!("capture-{key}"),
    };
    let start = EngineStartRequest {
        source: source.clone(),
        profile: versions.profile.clone(),
        associations: EngineAssociations::default(),
        request_id: format!("request-{key}"),
        entry: plan.entry.as_ref().map(|_| EngineEntry {
            delivery_id: format!("delivery-{key}"),
            message_json: "{\"secret\":\"PRIVATE_MESSAGE\"}".into(),
        }),
    };
    let mut state = FlowState030::new(identity.clone());
    let enter = start.entry.as_ref().map(|entry| {
        let transition = reduce(
            &plan,
            &state,
            &FlowEvent030 {
                identity: identity.clone(),
                event_id: "start:enter".into(),
                expected_revision: "0".into(),
                kind: FlowEventKind030::Enter {
                    message_json: entry.message_json.clone(),
                },
            },
        )
        .unwrap();
        state = transition.state;
        transition.receipt
    });
    let plan_json = serde_json::to_string(&plan).unwrap();
    let capture = StartCapture030 {
        identity: identity.clone(),
        source: source.clone(),
        versions,
        authored_source: authored,
        compiled_plan_json: plan_json.clone(),
        registry_json: "{\"private\":\"PRIVATE_REGISTRY\"}".into(),
        private_capture_json: "{\"private\":\"PRIVATE_CAPTURE\"}".into(),
    };
    let receipt = StartReceipt030 {
        identity: identity.clone(),
        enter,
    };
    let hash = if bad_hash {
        "0".repeat(64)
    } else {
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&capture).unwrap())
        )
    };
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO engine_flow030_runs(system_id,invocation_id,snapshot_id,epoch,source_json,plan_json,state_json) VALUES(?,?,?,?,?,?,?)")
        .bind(&identity.system_start_id).bind(&identity.flow_invocation_id).bind(&identity.snapshot_id).bind(&identity.epoch)
        .bind(serde_json::to_string(&source).unwrap()).bind(plan_json).bind(serde_json::to_string(&state).unwrap()).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO engine_start030_requests(request_id,request_json,system_id,invocation_id,snapshot_id,capture_epoch,capture_json,receipt_json) VALUES(?,?,?,?,?,?,?,?)")
        .bind(&start.request_id).bind(serde_json::to_string(&start).unwrap()).bind(&identity.system_start_id).bind(&identity.flow_invocation_id)
        .bind(&identity.snapshot_id).bind(&identity.epoch).bind(serde_json::to_string(&capture).unwrap()).bind(serde_json::to_string(&receipt).unwrap()).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO engine_flow030_owners(system_id,invocation_id,snapshot_id,capture_epoch,owner_epoch,generation,status,capture_sha256) VALUES(?,?,?,?,'1','native-generation',?,?)")
        .bind(&identity.system_start_id).bind(&identity.flow_invocation_id).bind(&identity.snapshot_id).bind(&identity.epoch).bind(status).bind(hash).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    (plan, state)
}

async fn persist_state(pool: &SqlitePool, system_id: &str, state: &FlowState030) {
    sqlx::query("UPDATE engine_flow030_runs SET state_json=? WHERE system_id=?")
        .bind(serde_json::to_string(state).unwrap())
        .bind(system_id)
        .execute(pool)
        .await
        .unwrap();
}

fn complete_work(
    plan: &FlowPlan030,
    state: &FlowState030,
    work: WorkRef030,
    choice: Option<&str>,
) -> FlowTransition030 {
    let event_id = format!("complete-{}", work.activation_id);
    reduce(
        plan,
        state,
        &FlowEvent030 {
            identity: state.identity.clone(),
            expected_revision: state.revision.clone(),
            event_id: event_id.clone(),
            kind: FlowEventKind030::WorkResult {
                work,
                result: WorkResult030::Completed {
                    output_json: choice.map_or_else(
                        || "{}".into(),
                        |choice| json!({"choice": choice}).to_string(),
                    ),
                    route_key: choice.map(str::to_owned),
                },
                physical: Some(PhysicalEvidence030 {
                    native_receipt_id: event_id,
                    descendants_joined: true,
                }),
            },
        },
    )
    .unwrap()
}

fn prepare_fork(plan: &FlowPlan030, state: &FlowState030) -> FlowTransition030 {
    let reference = state.preparations[0].reference.clone();
    let native_receipt_id = "prepare-fork";
    let batches = plan.routes[0]
        .targets
        .iter()
        .enumerate()
        .map(|(ordinal, target)| PreparedBatch030 {
            target_ordinal: ordinal,
            target: target.clone(),
            items: vec![PreparedItem030 {
                message_json: Some("{}".into()),
                item_json: None,
                occurrence: DeliveryOccurrence030 {
                    native_receipt_id: native_receipt_id.into(),
                    target_ordinal: ordinal,
                    item_index: "0".into(),
                },
            }],
        })
        .collect();
    reduce(
        plan,
        state,
        &FlowEvent030 {
            identity: state.identity.clone(),
            expected_revision: state.revision.clone(),
            event_id: native_receipt_id.into(),
            kind: FlowEventKind030::Prepared {
                reference,
                native_receipt_id: native_receipt_id.into(),
                result: PreparedResult030::Ready { batches },
            },
        },
    )
    .unwrap()
}

async fn assert_steer_history(withdraw: bool, expected_phase: &str) {
    let (_temp, pool) = database().await;
    let scope = owner("project", "feature/steer");
    seed(&pool, "other", scope.clone(), "live", false).await;
    let mut plan = fork_plan();
    plan.versions.contract = argentic_core::AGSDL_040.into();
    let mut document: Value = serde_json::from_str(&plan.document_json).unwrap();
    document["contract"] = json!(plan.versions.contract);
    for step in &mut plan.steps[1..3] {
        step.instance = Some(Instance030::Shared);
        let mut declaration: Value = serde_json::from_str(&step.declaration_json).unwrap();
        declaration.as_object_mut().unwrap().remove("instance");
        let delivery = if step.address[0] == "left" {
            declaration["next"] = json!({"yes":"join"});
            "queue"
        } else {
            "steer"
        };
        step.delivery = Some(delivery.into());
        declaration["delivery"] = json!(delivery);
        document["flow"]["steps"][&step.address[0]] = declaration.clone();
        step.declaration_json = declaration.to_string();
    }
    plan.routes[1].key = Some("yes".into());
    let join = &mut plan.joins[0];
    join.mode = "quorum".into();
    join.quorum_count_json = Some("1".into());
    join.accept = vec!["yes".into()];
    join.remaining = "stop".into();
    document["flow"]["steps"]["join"] = json!({
        "type": "join",
        "quorum": {"count": 1, "accept": ["yes"]},
        "remaining": "stop",
        "next": {"reached": [], "missed": []},
    });
    plan.steps[3].declaration_json = document["flow"]["steps"]["join"].to_string();
    plan.routes[3].key = Some("reached".into());
    let mut missed = plan.routes[3].clone();
    missed.key = Some("missed".into());
    plan.routes.push(missed);
    plan.document_json = document.to_string();

    let (plan, entered) = seed_plan(&pool, "steer", scope.clone(), "live", false, plan).await;
    let fork = &entered.activations[0];
    let completed = complete_work(
        &plan,
        &entered,
        WorkRef030 {
            activation_id: fork.id.clone(),
            start_effect_id: fork.start_effect_id.clone().unwrap(),
            agent_instance_id: None,
        },
        None,
    );
    let transition = prepare_fork(&plan, &completed.state);
    let work = transition
        .effects
        .iter()
        .find_map(|effect| match &effect.kind {
            FlowEffectKind030::Steer { work, .. } => Some(work.clone()),
            _ => None,
        })
        .expect("sender should be waiting for a steer receipt");
    let state = if withdraw {
        complete_work(&plan, &transition.state, work, Some("yes")).state
    } else {
        transition.state
    };
    assert_eq!(state.steer_deliveries[0].status, "pending");
    persist_state(&pool, "system-steer", &state).await;

    let page = list_runs030(&pool, request(scope, None, 20)).await.unwrap();
    assert_eq!(page.runs.len(), 2);
    let run = &page.runs[0];
    assert_eq!(run.system_start_id, "system-steer");
    assert!(
        run.phase_counts
            .iter()
            .any(|p| p.phase == expected_phase && p.count == "1"),
        "{:?}",
        run.phase_counts
    );
}

#[tokio::test]
async fn history_includes_steering_before_receipt() {
    assert_steer_history(false, "steering").await;
}

#[tokio::test]
async fn history_includes_a_steer_withdrawn_by_a_join_before_receipt() {
    assert_steer_history(true, "withdrawingSteer").await;
}

#[tokio::test]
async fn pages_are_scoped_stable_and_keep_revoked_history() {
    let (_temp, pool) = database().await;
    let wanted = owner("project", "feature/a");
    seed(&pool, "first", wanted.clone(), "live", false).await;
    seed(
        &pool,
        "outside-project",
        owner("other", "feature/a"),
        "live",
        false,
    )
    .await;
    seed(
        &pool,
        "outside-branch",
        owner("project", "feature/b"),
        "live",
        false,
    )
    .await;
    seed(&pool, "second", wanted.clone(), "revoked", false).await;
    let page = list_runs030(&pool, request(wanted.clone(), None, 1))
        .await
        .unwrap();
    assert_eq!(page.runs.len(), 1);
    assert_eq!(page.runs[0].system_start_id, "system-second");
    assert_eq!(page.runs[0].owner_status, "revoked");
    assert_eq!(page.runs[0].physical_pending, "1");
    assert_eq!(page.runs[0].revision, "1");
    assert_eq!(page.runs[0].verdict, None);
    assert_eq!(page.runs[0].source.revision, "9007199254740993");
    assert_eq!(page.runs[0].versions.runtime, "runtime-second");
    assert!(page.runs[0]
        .phase_counts
        .iter()
        .any(|p| p.phase == "running" && p.count == "1"));
    let serialized = serde_json::to_string(&page).unwrap();
    assert!(
        !serialized.contains("PRIVATE_")
            && !serialized.contains("capture-second")
            && !serialized.contains("native-generation")
    );
    let cursor = page.next_cursor.unwrap();
    seed(&pool, "later", wanted.clone(), "live", false).await;
    let next = list_runs030(&pool, request(wanted.clone(), Some(cursor.clone()), 1))
        .await
        .unwrap();
    assert_eq!(next.runs.len(), 1);
    assert_eq!(next.runs[0].system_start_id, "system-first");
    assert_eq!(next.runs[0].versions.runtime, "runtime-first");
    assert!(next.next_cursor.is_none());
    assert!(list_runs030(
        &pool,
        request(owner("other", "feature/a"), Some(cursor.clone()), 1)
    )
    .await
    .is_err());
    assert!(list_runs030(
        &pool,
        request(wanted.clone(), Some(format!("{cursor}=")), 1)
    )
    .await
    .is_err());
    assert!(list_runs030(
        &pool,
        request(wanted.clone(), Some("not-a-030-cursor".into()), 1)
    )
    .await
    .is_err());
    assert!(list_runs030(&pool, request(wanted.clone(), None, 0))
        .await
        .is_err());
    assert!(list_runs030(&pool, request(wanted, None, 101))
        .await
        .is_err());
}

#[tokio::test]
async fn altered_capture_digest_is_an_error_not_a_missing_run() {
    let (_temp, pool) = database().await;
    let wanted = owner("project", "feature/a");
    seed(&pool, "broken", wanted.clone(), "live", true).await;
    assert!(list_runs030(&pool, request(wanted, None, 20))
        .await
        .is_err());
}

#[tokio::test]
async fn mismatched_state_identity_and_entry_receipt_are_rejected() {
    let (_temp, pool) = database().await;
    let wanted = owner("project", "feature/a");
    seed(&pool, "one", wanted.clone(), "live", false).await;
    let raw: String = sqlx::query_scalar(
        "SELECT state_json FROM engine_flow030_runs WHERE system_id='system-one'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let mut state: FlowState030 = serde_json::from_str(&raw).unwrap();
    state.identity.snapshot_id = "substituted".into();
    sqlx::query("UPDATE engine_flow030_runs SET state_json=? WHERE system_id='system-one'")
        .bind(serde_json::to_string(&state).unwrap())
        .execute(&pool)
        .await
        .unwrap();
    assert!(list_runs030(&pool, request(wanted.clone(), None, 20))
        .await
        .is_err());
    state.identity.snapshot_id = "snapshot-one".into();
    state
        .events
        .get_mut("start:enter")
        .unwrap()
        .receipt
        .revision = "999".into();
    sqlx::query("UPDATE engine_flow030_runs SET state_json=? WHERE system_id='system-one'")
        .bind(serde_json::to_string(&state).unwrap())
        .execute(&pool)
        .await
        .unwrap();
    assert!(list_runs030(&pool, request(wanted, None, 20))
        .await
        .is_err());
}

#[tokio::test]
async fn empty_scope_and_separate_020_cursor_are_not_confused() {
    let (_temp, pool) = database().await;
    let scope = owner("absent", "feature/a");
    let page = list_runs030(&pool, request(scope.clone(), None, 20))
        .await
        .unwrap();
    assert!(page.runs.is_empty() && page.next_cursor.is_none());
    let old = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&serde_json::json!({"owner":scope,"upper":2,"before":1})).unwrap(),
    );
    assert!(
        list_runs030(&pool, request(owner("absent", "feature/a"), Some(old), 20))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn altered_flow_source_and_missing_owner_are_rejected() {
    let (_temp, pool) = database().await;
    let wanted = owner("project", "feature/a");
    seed(&pool, "one", wanted.clone(), "live", false).await;
    // Simulate corruption after removing the immutable trigger in this test DB.
    sqlx::query("DROP TRIGGER engine_flow030_capture_immutable")
        .execute(&pool)
        .await
        .unwrap();
    let wrong = EngineSourceRevision {
        owner: wanted.clone(),
        revision: "2".into(),
        source_sha256: "a".repeat(64),
    };
    sqlx::query("UPDATE engine_flow030_runs SET source_json=? WHERE system_id='system-one'")
        .bind(serde_json::to_string(&wrong).unwrap())
        .execute(&pool)
        .await
        .unwrap();
    assert!(list_runs030(&pool, request(wanted.clone(), None, 20))
        .await
        .is_err());
    let (_temp2, pool2) = database().await;
    seed(&pool2, "missing", wanted.clone(), "live", false).await;
    sqlx::query("DELETE FROM engine_flow030_owners WHERE system_id='system-missing'")
        .execute(&pool2)
        .await
        .unwrap();
    assert!(list_runs030(&pool2, request(wanted, None, 20))
        .await
        .is_err());
}

#[tokio::test]
async fn logical_completion_does_not_imply_physical_end_or_verdict() {
    let (_temp, pool) = database().await;
    let wanted = owner("project", "feature/a");
    seed(&pool, "finishing", wanted.clone(), "live", false).await;
    let raw: String = sqlx::query_scalar(
        "SELECT state_json FROM engine_flow030_runs WHERE system_id='system-finishing'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let mut state: FlowState030 = serde_json::from_str(&raw).unwrap();
    state.activations[0].phase = "done".into();
    assert!(state.activations[0].physical);
    state.verdict = None;
    persist_state(&pool, "system-finishing", &state).await;
    let page = list_runs030(&pool, request(wanted, None, 20))
        .await
        .unwrap();
    assert_eq!(page.runs[0].verdict, None);
    assert_eq!(page.runs[0].physical_pending, "1");
    assert!(page.runs[0]
        .phase_counts
        .iter()
        .any(|p| p.phase == "done" && p.count == "1"));
}

#[tokio::test]
async fn rejects_changed_initial_event_and_missing_recorded_plan() {
    for variant in 0..5 {
        let (_temp, pool) = database().await;
        let scope = owner("project", "feature/entry");
        seed(&pool, "entry", scope.clone(), "live", false).await;
        let raw: String = sqlx::query_scalar(
            "SELECT state_json FROM engine_flow030_runs WHERE system_id='system-entry'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let mut state: FlowState030 = serde_json::from_str(&raw).unwrap();
        if variant == 4 {
            state.plan_json = None;
        } else {
            let raw: String = sqlx::query_scalar("SELECT request_json FROM engine_start030_requests WHERE request_id='request-entry'")
                .fetch_one(&pool).await.unwrap();
            let start: EngineStartRequest = serde_json::from_str(&raw).unwrap();
            let mut identity = state.identity.clone();
            if variant == 1 {
                identity.epoch = "different-capture".into();
            }
            let event = FlowEvent030 {
                identity,
                event_id: if variant == 2 {
                    "other-event"
                } else {
                    "start:enter"
                }
                .into(),
                expected_revision: if variant == 3 { "9" } else { "0" }.into(),
                kind: FlowEventKind030::Enter {
                    message_json: if variant == 0 {
                        "{\"changed\":true}".into()
                    } else {
                        start.entry.unwrap().message_json
                    },
                },
            };
            state.events.get_mut("start:enter").unwrap().event_json =
                serde_json::to_string(&event).unwrap();
        }
        sqlx::query("UPDATE engine_flow030_runs SET state_json=? WHERE system_id='system-entry'")
            .bind(serde_json::to_string(&state).unwrap())
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            list_runs030(&pool, request(scope, None, 20)).await.is_err(),
            "variant {variant}"
        );
    }
}

#[tokio::test]
async fn startup_marks_only_unfinished_runs_interrupted_and_fences_them() {
    let (_temp, pool) = database().await;
    let scope = owner("project", "develop");
    seed(&pool, "unfinished", scope.clone(), "live", false).await;
    seed(&pool, "finished", scope.clone(), "live", false).await;
    sqlx::query("UPDATE engine_flow030_runs SET state_json=json_set(state_json,'$.verdict','succeeded') WHERE system_id='system-finished'")
        .execute(&pool).await.unwrap();
    crate::agsdl_host_flow030::interrupt_previous_runs030(&pool)
        .await
        .unwrap();
    crate::agsdl_host_flow030::interrupt_previous_runs030(&pool)
        .await
        .unwrap();
    let page = list_runs030(&pool, request(scope, None, 20)).await.unwrap();
    let unfinished = page
        .runs
        .iter()
        .find(|run| run.system_start_id == "system-unfinished")
        .unwrap();
    assert!(unfinished.interrupted_at.is_some());
    assert_eq!(unfinished.owner_status, "revoked");
    let finished = page
        .runs
        .iter()
        .find(|run| run.system_start_id == "system-finished")
        .unwrap();
    assert!(finished.interrupted_at.is_none());
    assert_eq!(finished.verdict.as_deref(), Some("succeeded"));
}

#[tokio::test]
async fn failed_supervisor_marks_only_its_unfinished_run() {
    let (_temp, pool) = database().await;
    let scope = owner("project", "develop");
    seed(&pool, "failed", scope.clone(), "live", false).await;
    seed(&pool, "other", scope.clone(), "live", false).await;
    crate::agsdl_host::HostState::new()
        .inspect_start_session()
        .await
        .unwrap()
        .interrupt_run(&pool, "system-failed")
        .await
        .unwrap();
    let page = list_runs030(&pool, request(scope.clone(), None, 20))
        .await
        .unwrap();
    let failed = page
        .runs
        .iter()
        .find(|run| run.system_start_id == "system-failed")
        .unwrap();
    assert!(failed.interrupted_at.is_some());
    assert_eq!(failed.owner_status, "revoked");
    let other = page
        .runs
        .iter()
        .find(|run| run.system_start_id == "system-other")
        .unwrap();
    assert!(other.interrupted_at.is_none());
    assert_eq!(other.owner_status, "live");
    argentic_runtime::api::interrupt_previous_runs(&pool)
        .await
        .unwrap();
    let page = list_runs030(&pool, request(scope, None, 20)).await.unwrap();
    let other = page
        .runs
        .iter()
        .find(|run| run.system_start_id == "system-other")
        .unwrap();
    assert_eq!(other.owner_status, "revoked");
    assert!(other.interrupted_at.is_some());
}

#[tokio::test]
async fn interrupted_run_survives_process_kill_and_database_reopen() {
    const CHILD_ROOT: &str = "MACRO_030_KILL_TEST_ROOT";
    if let Some(root) = std::env::var_os(CHILD_ROOT) {
        let root = std::path::PathBuf::from(root);
        let pool = create_pool(&root.join("restart.db")).await.unwrap();
        seed(&pool, "killed", owner("project", "develop"), "live", false).await;
        std::fs::write(root.join("ready"), b"ready").unwrap();
        std::future::pending::<()>().await;
        return;
    }
    let temp = TempDir::new().unwrap();
    let mut child = crate::core::process::background_command(std::env::current_exe().unwrap())
        .args(["--exact", "db::agsdl_execution::discovery030::tests::interrupted_run_survives_process_kill_and_database_reopen", "--nocapture"])
        .env(CHILD_ROOT, temp.path())
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .spawn().unwrap();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    while !temp.path().join("ready").exists() && tokio::time::Instant::now() < deadline {
        if child.try_wait().unwrap().is_some() {
            panic!("restart fixture exited before starting");
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let ready = temp.path().join("ready").exists();
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(ready, "restart fixture did not start");
    let pool = create_pool(&temp.path().join("restart.db")).await.unwrap();
    crate::agsdl_host_flow030::interrupt_previous_runs030(&pool)
        .await
        .unwrap();
    let page = list_runs030(&pool, request(owner("project", "develop"), None, 20))
        .await
        .unwrap();
    assert_eq!(page.runs.len(), 1);
    assert!(page.runs[0].interrupted_at.is_some());
    assert_eq!(page.runs[0].owner_status, "revoked");
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM engine_start030_requests")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn operate_list_stays_available_when_a_paused_run_defers_delivery() {
    let (_temp, pool) = database().await;
    let scope = owner("project", "develop");
    let mut graphless = fork_plan();
    graphless.versions.contract = argentic_core::AGSDL_040.into();
    graphless.entry = None;
    let (plan, mut state) =
        seed_plan(&pool, "paused", scope.clone(), "live", false, graphless).await;
    seed(&pool, "other", scope.clone(), "live", false).await;
    let event = |state: &FlowState030, id: &str, kind| {
        reduce(
            &plan,
            state,
            &FlowEvent030 {
                identity: state.identity.clone(),
                event_id: id.into(),
                expected_revision: state.revision.clone(),
                kind,
            },
        )
        .unwrap()
        .state
    };
    state = event(
        &state,
        "pause",
        FlowEventKind030::Operator(OperatorEvent030::Pause {
            activation_ids: Vec::new(),
        }),
    );
    state = event(
        &state,
        "deliver",
        FlowEventKind030::Deliver {
            agent: "worker".into(),
            instance: Instance030::Shared,
            delivery: "queue".into(),
            message_json: "{}".into(),
            sender: "user".into(),
        },
    );
    persist_state(&pool, "system-paused", &state).await;
    let list = || crate::db::operate_inbox::list_runs(&pool, request(scope.clone(), None, 20));
    let page = list().await.unwrap();
    assert_eq!(page.runs.len(), 2);
    let paused = &page
        .runs
        .iter()
        .find(|row| row.summary.system_start_id == "system-paused")
        .unwrap()
        .summary;
    assert_eq!(paused.paused, Some(true));
    assert_eq!(
        paused.phase_counts,
        vec![PhaseCount030 {
            phase: "deferred".into(),
            count: "1".into()
        }]
    );

    state = event(
        &state,
        "resume",
        FlowEventKind030::Operator(OperatorEvent030::ResumeRun),
    );
    persist_state(&pool, "system-paused", &state).await;
    let page = list().await.unwrap();
    let resumed = &page
        .runs
        .iter()
        .find(|row| row.summary.system_start_id == "system-paused")
        .unwrap()
        .summary;
    assert_eq!(resumed.paused, None);
    assert_eq!(
        resumed.phase_counts,
        vec![PhaseCount030 {
            phase: "running".into(),
            count: "1".into()
        }]
    );

    // A future phase is an ordinary count, even when this Macro build
    // has no presentation or operator action specific to it.
    state.activations[0].phase = "futureNativePhase".into();
    persist_state(&pool, "system-paused", &state).await;
    assert_eq!(list().await.unwrap().runs.len(), 2);
}
