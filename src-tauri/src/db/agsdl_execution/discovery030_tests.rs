use super::super::{
    dto::{EngineAssociations, EngineEntry},
    flow030::{reduce, FlowEvent030, FlowEventKind030, FlowIdentity030},
};
use super::*;
use crate::db::create_pool;
use tempfile::TempDir;

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
    let mut plan: FlowPlan030 = serde_json::from_str(include_str!(
        "../../../tests/fixtures/agsdl030_compiled_plan.json"
    ))
    .unwrap();
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
        entry: Some(EngineEntry {
            delivery_id: format!("delivery-{key}"),
            message_json: "{\"secret\":\"PRIVATE_MESSAGE\"}".into(),
        }),
    };
    let event = FlowEvent030 {
        identity: identity.clone(),
        event_id: "start:enter".into(),
        expected_revision: "0".into(),
        kind: FlowEventKind030::Enter {
            message_json: start.entry.as_ref().unwrap().message_json.clone(),
        },
    };
    let transition = reduce(&plan, &FlowState030::new(identity.clone()), &event).unwrap();
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
        enter: Some(transition.receipt),
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
        .bind(serde_json::to_string(&source).unwrap()).bind(plan_json).bind(serde_json::to_string(&transition.state).unwrap()).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO engine_start030_requests(request_id,request_json,system_id,invocation_id,snapshot_id,capture_epoch,capture_json,receipt_json) VALUES(?,?,?,?,?,?,?,?)")
        .bind(&start.request_id).bind(serde_json::to_string(&start).unwrap()).bind(&identity.system_start_id).bind(&identity.flow_invocation_id)
        .bind(&identity.snapshot_id).bind(&identity.epoch).bind(serde_json::to_string(&capture).unwrap()).bind(serde_json::to_string(&receipt).unwrap()).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO engine_flow030_owners(system_id,invocation_id,snapshot_id,capture_epoch,owner_epoch,generation,status,capture_sha256) VALUES(?,?,?,?,'1','native-generation',?,?)")
        .bind(&identity.system_start_id).bind(&identity.flow_invocation_id).bind(&identity.snapshot_id).bind(&identity.epoch).bind(status).bind(hash).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
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
    sqlx::query("UPDATE engine_flow030_runs SET state_json=? WHERE system_id='system-finishing'")
        .bind(serde_json::to_string(&state).unwrap())
        .execute(&pool)
        .await
        .unwrap();
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
