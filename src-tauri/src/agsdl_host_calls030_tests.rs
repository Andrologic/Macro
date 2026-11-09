//! Real calls030.ts pure worker over native tickets; no fixture commands or MCP
//! servers run. The SQL policy/transport capability is explicitly synthetic.
use super::*;
use crate::db::agsdl_execution::{
    flow030::{self, FlowEvent030, FlowEventKind030, FlowPlan030, FlowState030, Route030, Step030},
    flow_store030::{self, StoreError030},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::Row;
use tokio::io::AsyncWriteExt;

pub(crate) struct TestAuthority {
    pub gate: Arc<Mutex<()>>,
    pub qualified: bool,
    pub commits: CallCommitFence030,
}
impl crate::db::agsdl_execution::flow_store030::Authority030 for TestAuthority {
    fn owner<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        id: &'a FlowIdentity030,
    ) -> CheckFuture<'a> {
        Box::pin(async move {
            let row = sqlx::query("SELECT capture_epoch,snapshot_id,owner_epoch,generation,status FROM engine_flow030_owners WHERE system_id=? AND invocation_id=?")
                .bind(&id.system_start_id).bind(&id.flow_invocation_id).fetch_optional(db).await?.ok_or(StoreError030::Authority)?;
            if row.get::<&str, _>("capture_epoch") == id.epoch
                && row.get::<&str, _>("snapshot_id") == id.snapshot_id
                && row.get::<&str, _>("owner_epoch") == "owner"
                && row.get::<&str, _>("generation") == "generation"
                && row.get::<&str, _>("status") == "live"
            {
                Ok(())
            } else {
                Err(StoreError030::Authority)
            }
        })
    }
    fn effect<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        effect: &'a FlowEffect030,
    ) -> CheckFuture<'a> {
        Box::pin(async move { self.owner(db, &effect.identity).await })
    }
    fn settlement<'a>(
        &'a self,
        _db: &'a mut SqliteConnection,
        _effect: &'a FlowEffect030,
        _receipt: &'a serde_json::Value,
    ) -> CheckFuture<'a> {
        Box::pin(async { Ok(()) })
    }
    fn owner_epoch(&self) -> &str {
        "owner"
    }
}
impl CallAuthority030 for TestAuthority {
    fn ensure_live(&self) -> Result<()> {
        Ok(())
    }
    fn call_commits(&self) -> &CallCommitFence030 {
        &self.commits
    }
    fn generation(&self) -> &str {
        "generation"
    }
    fn admission_lock(&self) -> Arc<Mutex<()>> {
        self.gate.clone()
    }
    fn qualify_tx<'a>(
        &'a self,
        _db: &'a mut SqliteConnection,
        _capture: &'a StartCapture030,
        _effect: &'a FlowEffect030,
        _declaration: &'a str,
    ) -> CheckFuture<'a> {
        Box::pin(async move {
            if self.qualified {
                Ok(())
            } else {
                Err(StoreError030::Authority)
            }
        })
    }
}
pub(crate) struct Fixture {
    pub _temp: tempfile::TempDir,
    pub pool: SqlitePool,
    pub authority: TestAuthority,
    pub id: FlowIdentity030,
    pub effect: FlowEffect030,
}
impl Fixture {
    pub async fn new(declaration: &str) -> Self {
        let temp = tempfile::TempDir::new().unwrap();
        let pool = crate::db::create_pool(&temp.path().join("calls.db"))
            .await
            .unwrap();
        // Registration belongs to the integrator's DB migration registry.
        sqlx::raw_sql(include_str!(
            "db/migrations/039_execution_call_protocol030.sql"
        ))
        .execute(&pool)
        .await
        .unwrap();
        let id = FlowIdentity030 {
            system_start_id: "system".into(),
            flow_invocation_id: "flow".into(),
            snapshot_id: "snapshot".into(),
            epoch: "capture".into(),
        };
        let authority = TestAuthority {
            gate: Arc::new(Mutex::new(())),
            qualified: true,
            commits: CallCommitFence030::default(),
        };
        let mut plan: FlowPlan030 = serde_json::from_str(include_str!(
            "../tests/fixtures/agsdl030_compiled_plan.json"
        ))
        .unwrap();
        plan.entry = Some(vec!["tests".into()]);
        plan.agents.clear();
        plan.joins.clear();
        plan.handlers.clear();
        plan.scopes.clear();
        plan.steps = vec![Step030 {
            address: vec!["tests".into()],
            scope: vec![],
            r#type: "call".into(),
            declaration_json: declaration.into(),
            agent: None,
            instance: None,
            delivery: None,
            max_visits_json: None,
            timeout_ms_json: None,
            submission_contract_json: None,
        }];
        plan.routes = vec![Route030 {
            source: vec!["tests".into()],
            kind: "normal".into(),
            key: None,
            declaration_json: "[]".into(),
            targets: vec![],
            inherited: false,
        }];
        let plan_json = serde_json::to_string(&plan).unwrap();
        let capture = StartCapture030 {
            identity: id.clone(),
            source: serde_json::from_value(plan.source.clone()).unwrap(),
            versions: serde_json::from_value(serde_json::to_value(&plan.versions).unwrap())
                .unwrap(),
            authored_source: "{}".into(),
            compiled_plan_json: plan_json.clone(),
            registry_json: "{}".into(),
            private_capture_json: "{}".into(),
        };
        let raw = serde_json::to_string(&capture).unwrap();
        let transition = flow030::reduce(
            &plan,
            &FlowState030::new(id.clone()),
            &FlowEvent030 {
                identity: id.clone(),
                event_id: "enter".into(),
                expected_revision: "0".into(),
                kind: FlowEventKind030::Enter {
                    message_json: "{}".into(),
                },
            },
        )
        .unwrap();
        let effect = transition
            .effects
            .iter()
            .find(|e| {
                matches!(
                    e.kind,
                    crate::db::agsdl_execution::flow030::FlowEffectKind030::Start { .. }
                )
            })
            .unwrap()
            .clone();
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("INSERT INTO engine_flow030_runs VALUES(?,?,?,?,?,?,?)")
            .bind("system")
            .bind("flow")
            .bind("snapshot")
            .bind("capture")
            .bind(plan.source.to_string())
            .bind(plan_json)
            .bind(serde_json::to_string(&transition.state).unwrap())
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO engine_flow030_owners(system_id,invocation_id,snapshot_id,capture_epoch,owner_epoch,generation,status,capture_sha256) VALUES(?,?,?,?,?,?,?,?)")
            .bind("system").bind("flow").bind("snapshot").bind("capture").bind("owner").bind("generation").bind("live").bind(format!("{:x}",Sha256::digest(raw.as_bytes()))).execute(&mut *tx).await.unwrap();
        sqlx::query("INSERT INTO engine_start030_requests VALUES(?,?,?,?,?,?,?,?)")
            .bind("request")
            .bind("{}")
            .bind("system")
            .bind("flow")
            .bind("snapshot")
            .bind("capture")
            .bind(raw)
            .bind("{}")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO engine_flow030_events VALUES(?,?,?,?,?,NULL)")
            .bind("system")
            .bind("flow")
            .bind("enter")
            .bind("{}")
            .bind(serde_json::to_string(&transition.receipt).unwrap())
            .execute(&mut *tx)
            .await
            .unwrap();
        for e in &transition.effects {
            sqlx::query("INSERT INTO engine_flow030_outbox VALUES(?,?,?,?,?,?,'pending',NULL)")
                .bind("system")
                .bind("flow")
                .bind(&e.id)
                .bind("enter")
                .bind(serde_json::to_string(e).unwrap())
                .bind("owner")
                .execute(&mut *tx)
                .await
                .unwrap();
        }
        tx.commit().await.unwrap();
        Self {
            _temp: temp,
            pool,
            authority,
            id,
            effect,
        }
    }
    pub async fn reserve(&self) -> CallAttempt030 {
        reserve_call030(&self.pool, &self.authority, &self.effect)
            .await
            .unwrap()
    }
    pub async fn handoff(&self, attempt: &CallAttempt030) {
        // Stand-in for DispatchLease030::handoff_host's durable registry commit.
        let mut tx = self.pool.begin().await.unwrap();
        flow_store030::claim_tx(&mut tx, &self.authority, &self.id, &self.effect.id)
            .await
            .unwrap();
        let receipt = json!({"kind":"nativeOwnedHandoff030","identity":self.id,"effectId":self.effect.id,
            "ownerEpoch":"owner","generation":"generation","requestId":format!("flow030:system:{}", self.effect.id)});
        sqlx::query("INSERT INTO engine_flow030_handoffs VALUES(?,?,?,?,?,?)")
            .bind("system")
            .bind("flow")
            .bind(&self.effect.id)
            .bind("owner")
            .bind("generation")
            .bind(receipt.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        flow_store030::settle_tx(
            &mut tx,
            &self.authority,
            &self.id,
            &self.effect.id,
            &receipt,
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(attempt.effect(), &self.effect);
    }
    pub async fn state(&self) -> FlowState030 {
        serde_json::from_str(
            &sqlx::query_scalar::<_, String>("SELECT state_json FROM engine_flow030_runs")
                .fetch_one(&self.pool)
                .await
                .unwrap(),
        )
        .unwrap()
    }
    pub async fn stop(&self) {
        let state = self.state().await;
        let mut tx = self.pool.begin().await.unwrap();
        flow_store030::apply_tx(
            &mut tx,
            &self.authority,
            &FlowEvent030 {
                identity: self.id.clone(),
                event_id: "stop".into(),
                expected_revision: state.revision,
                kind: FlowEventKind030::Stop,
            },
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
    }
}

pub(crate) fn control() -> Control {
    Control {
        stop: CancellationToken::new(),
        machine_timeout: CancellationToken::new(),
    }
}
pub(crate) fn command(code: i32, stdout: &str) -> CallEvent030 {
    CallEvent030::CommandReceipt {
        stdout: stdout.into(),
        stderr: "stderr".into(),
        exit_code: code,
    }
}

/// Run precisely the existing normalizer, preserving JSON tokens inside its
/// string payload. The command is Bun's pure worker, never the authored call.
pub(crate) async fn worker_once(broker: &CallDataBroker030) {
    let job = broker.next().await.unwrap();
    let script = r#"import {prepareCall030,commandOutput030,mcpOutput030} from './src/services/agsdlExecution/calls030';
const j=JSON.parse(await Bun.stdin.text()), i=JSON.parse(j.inputJson); let result;
try { if(i.operation==='prepare') result={kind:'prepared',prepared:prepareCall030(i.stepJson,i.source)};
else result={kind:'completed',outputJson:i.prepared.kind==='command'?commandOutput030(i.prepared,i.receipt):mcpOutput030(i.receipt)}; }
catch(e) { if(typeof e.code!=='string') throw e; result={kind:'failed',code:e.code}; }
process.stdout.write(JSON.stringify(result));"#;
    let mut child = crate::core::process::background_tokio_command("bun")
        .args(["-e", script])
        .current_dir(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap(),
        )
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
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    broker
        .complete(
            &job.generation,
            HostRouteCompletion030 {
                ticket: job.ticket,
                generation: job.generation.clone(),
                input_digest: job.input_digest,
                output: crate::agsdl_host_route030::HostRouteOutput030::Ready {
                    result_json: String::from_utf8(output.stdout).unwrap(),
                },
            },
        )
        .unwrap();
}
pub(crate) async fn prepare(f: &Fixture, broker: &CallDataBroker030, attempt: &CallAttempt030) {
    let cancel = CancellationToken::new();
    let (result, ()) = tokio::join!(
        prepare_call030(&f.pool, &f.authority, broker, attempt, &cancel),
        worker_once(broker)
    );
    result.unwrap();
}
pub(crate) async fn joined(
    f: &Fixture,
    broker: &CallDataBroker030,
    event: CallEvent030,
) -> JoinedCall030 {
    let attempt = f.reserve().await;
    prepare(f, broker, &attempt).await;
    f.handoff(&attempt).await;
    let (driver, owned) = launch_synthetic030(&f.pool, &f.authority, &attempt, control())
        .await
        .unwrap();
    driver.send(event).unwrap();
    owned.join().await.unwrap()
}
pub(crate) async fn finish(
    f: &Fixture,
    broker: &CallDataBroker030,
    joined: &JoinedCall030,
) -> CallReceipt030 {
    let cancel = CancellationToken::new();
    let (result, ()) = tokio::join!(
        finish_joined_call030(&f.pool, &f.authority, broker, joined, &cancel),
        worker_once(broker)
    );
    result.unwrap()
}

#[tokio::test]
async fn command_normalizer_and_native_terminal_are_durable_and_idempotent() {
    let f = Fixture::new(r#"{"type":"call","command":"never execute","parse":"lines"}"#).await;
    let broker = CallDataBroker030::default();
    let joined = joined(&f, &broker, command(1, "src/a.ts\n\nsrc/b.ts\r\nlast\r")).await;
    let receipt = finish(&f, &broker, &joined).await;
    assert_eq!(receipt.status(), "failed");
    assert!(receipt.physical().descendants_joined);
    let Some(crate::db::agsdl_execution::flow030::WorkResult030::Completed {
        output_json,
        route_key,
    }) = receipt.work_result().unwrap()
    else {
        panic!("Normal failed outcome became a failure")
    };
    assert_eq!(route_key.as_deref(), Some("failed"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&output_json).unwrap()["data"]["value"],
        json!(["src/a.ts", "src/b.ts", "last\r"])
    );
    assert_eq!(
        finish_joined_call030(
            &f.pool,
            &f.authority,
            &broker,
            &joined,
            &CancellationToken::new()
        )
        .await
        .unwrap(),
        receipt
    );
    let state = f.state().await;
    assert_eq!(state.verdict.as_deref(), Some("succeeded"));
    assert!(!state.activations[0].physical);
    assert!(state.instances.is_empty());
    assert_eq!(state.events.len(), 2);
    for _ in 0..3 {
        assert_eq!(
            read_call_receipt030(&f.pool, &f.authority, &f.id, joined.attempt.work())
                .await
                .unwrap(),
            Some(receipt.clone())
        );
    }
    assert!(
        launch_synthetic030(&f.pool, &f.authority, joined.attempt(), control())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn json_invalid_is_output_invalid_even_for_failed_exit() {
    for code in [0, 1] {
        let f = Fixture::new(r#"{"type":"call","command":"never execute","parse":"json"}"#).await;
        let broker = CallDataBroker030::default();
        let joined = joined(&f, &broker, command(code, "Error: cannot find module\n")).await;
        let receipt = finish(&f, &broker, &joined).await;
        let Some(crate::db::agsdl_execution::flow030::WorkResult030::Failed { error }) =
            receipt.work_result().unwrap()
        else {
            panic!()
        };
        assert_eq!(error.code, "OUTPUT_INVALID");
        assert_eq!(f.state().await.verdict.as_deref(), Some("failed"));
        assert_eq!(
            read_call_receipt030(&f.pool, &f.authority, &f.id, joined.attempt.work())
                .await
                .unwrap(),
            Some(receipt)
        );
    }
}

#[tokio::test]
async fn mcp_is_error_remains_normal_failed_and_human_hook_checks_server() {
    let f = Fixture::new(r#"{"type":"call","mcp":{"server":"github","tool":"create_issue"},"arguments":{"title":{"value":"Nightly"}},"answerTimeoutMs":600000}"#).await;
    let broker = CallDataBroker030::default();
    let attempt = f.reserve().await;
    prepare(&f, &broker, &attempt).await;
    f.handoff(&attempt).await;
    let (driver, owned) = launch_synthetic030(&f.pool, &f.authority, &attempt, control())
        .await
        .unwrap();
    let mut tx = f.pool.begin().await.unwrap();
    protocol::require_live_mcp_tx(&mut tx, &f.authority, &attempt, "github")
        .await
        .unwrap();
    assert!(
        protocol::require_live_mcp_tx(&mut tx, &f.authority, &attempt, "another")
            .await
            .is_err()
    );
    tx.commit().await.unwrap();
    assert_eq!(
        attempt.answer_timeout_ms_json().unwrap().as_deref(),
        Some("600000")
    );
    driver
        .send(CallEvent030::ToolReturned {
            is_error: true,
            text: "ignored".into(),
            structured_content_json: Some(
                r#"{"error":"Creation declined.","number":9007199254740993}"#.into(),
            ),
        })
        .unwrap();
    let joined = owned.join().await.unwrap();
    let receipt = finish(&f, &broker, &joined).await;
    let Some(crate::db::agsdl_execution::flow030::WorkResult030::Completed { output_json, .. }) =
        receipt.work_result().unwrap()
    else {
        panic!()
    };
    assert!(output_json.contains("9007199254740993"));
    assert_eq!(receipt.status(), "failed");
    assert_eq!(f.state().await.verdict.as_deref(), Some("succeeded"));
    let mut tx = f.pool.begin().await.unwrap();
    assert!(
        protocol::require_live_mcp_tx(&mut tx, &f.authority, &attempt, "github")
            .await
            .is_err()
    );
}

#[tokio::test]
async fn startup_failure_is_call_failed_and_not_a_normal_outcome() {
    let f = Fixture::new(r#"{"type":"call","command":"never execute"}"#).await;
    let broker = CallDataBroker030::default();
    let joined = joined(&f, &broker, CallEvent030::StartFailed).await;
    let receipt = finish_joined_call030(
        &f.pool,
        &f.authority,
        &broker,
        &joined,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let Some(crate::db::agsdl_execution::flow030::WorkResult030::Failed { error }) =
        receipt.work_result().unwrap()
    else {
        panic!()
    };
    assert_eq!(error.code, "CALL_FAILED");
    assert!(!f.state().await.activations[0].physical);
}

#[tokio::test]
async fn stop_before_launch_proves_not_started_and_takes_no_error_route() {
    let f = Fixture::new(r#"{"type":"call","command":"never execute"}"#).await;
    let attempt = f.reserve().await;
    assert!(stop_before_launch030(&f.pool, &f.authority, &attempt)
        .await
        .is_err());
    f.stop().await;
    let receipt = stop_before_launch030(&f.pool, &f.authority, &attempt)
        .await
        .unwrap();
    assert_eq!(receipt.status(), "stopped");
    assert!(receipt.work_result().unwrap().is_none());
    assert_eq!(f.state().await.verdict.as_deref(), Some("cancelled"));
    assert!(
        launch_synthetic030(&f.pool, &f.authority, &attempt, control())
            .await
            .is_err()
    );
    assert_eq!(
        stop_before_launch030(&f.pool, &f.authority, &attempt)
            .await
            .unwrap(),
        receipt
    );
}

#[tokio::test]
async fn unqualified_call_and_command_as_agent_are_refused_without_reservation() {
    let mut f = Fixture::new(r#"{"type":"call","command":"never execute"}"#).await;
    f.authority.qualified = false;
    assert_eq!(
        reserve_call030(&f.pool, &f.authority, &f.effect)
            .await
            .unwrap_err()
            .code,
        "AUTHORITY"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM engine_flow030_calls")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        0
    );
    f.authority.qualified = true;
    let mut forged = f.effect.clone();
    if let crate::db::agsdl_execution::flow030::FlowEffectKind030::Start { work, .. } =
        &mut forged.kind
    {
        work.agent_instance_id = Some("borrowed-agent".into());
    }
    assert!(reserve_call030(&f.pool, &f.authority, &forged)
        .await
        .is_err());
}

#[tokio::test]
async fn machine_timeout_requires_native_join_before_publishing_failure() {
    let f = Fixture::new(r#"{"type":"call","command":"never execute"}"#).await;
    let broker = CallDataBroker030::default();
    let attempt = f.reserve().await;
    prepare(&f, &broker, &attempt).await;
    f.handoff(&attempt).await;
    let control = control();
    let timeout = control.machine_timeout.clone();
    let (_driver, owned) = launch_synthetic030(&f.pool, &f.authority, &attempt, control)
        .await
        .unwrap();
    timeout.cancel();
    assert!(f.state().await.activations[0].physical);
    assert!(
        read_call_receipt030(&f.pool, &f.authority, &f.id, attempt.work())
            .await
            .unwrap()
            .is_none()
    );
    let joined = owned.join().await.unwrap();
    let receipt = finish_joined_call030(
        &f.pool,
        &f.authority,
        &broker,
        &joined,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let Some(crate::db::agsdl_execution::flow030::WorkResult030::Failed { error }) =
        receipt.work_result().unwrap()
    else {
        panic!()
    };
    assert_eq!(error.code, "TIMEOUT");
    assert!(!f.state().await.activations[0].physical);
    assert_eq!(
        read_call_receipt030(&f.pool, &f.authority, &f.id, attempt.work())
            .await
            .unwrap(),
        Some(receipt)
    );
}

#[tokio::test]
async fn call_timeline_event_rejects_outcome_physical_facts_and_fractional_exit_status() {
    for raw in [
        r#"{"kind":"commandReceipt","exitCode":0.5}"#,
        r#"{"kind":"commandReceipt","exitCode":0,"outcome":"passed"}"#,
        r#"{"kind":"commandReceipt","exitCode":0,"descendantsJoined":true}"#,
        r#"{"kind":"toolReturned","isError":false,"nativeCallId":"forged"}"#,
    ] {
        assert!(serde_json::from_str::<CallEvent030>(raw).is_err());
    }
    assert_eq!(
        serde_json::from_str::<CallEvent030>(r#"{"kind":"commandReceipt","exitCode":1}"#).unwrap(),
        CallEvent030::CommandReceipt {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: 1
        }
    );
}
