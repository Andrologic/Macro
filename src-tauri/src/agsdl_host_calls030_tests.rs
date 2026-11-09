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
async fn fixture_parts() -> (
    tempfile::TempDir,
    SqlitePool,
    TestAuthority,
    FlowIdentity030,
) {
    let temp = tempfile::TempDir::new().unwrap();
    let pool = crate::db::create_pool(&temp.path().join("calls.db"))
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
    (temp, pool, authority, id)
}
impl Fixture {
    pub async fn new(declaration: &str) -> Self {
        let (temp, pool, authority, id) = fixture_parts().await;
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
            timeout_ms_json: serde_json::from_str::<serde_json::Value>(declaration)
                .unwrap()
                .get("timeoutMs")
                .map(ToString::to_string),
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
        if serde_json::from_str::<serde_json::Value>(declaration)
            .unwrap()
            .get("onError")
            .is_some()
        {
            plan.routes.push(Route030 {
                source: vec!["tests".into()],
                kind: "error".into(),
                key: None,
                declaration_json: "\"tests\"".into(),
                inherited: false,
                targets: vec![crate::db::agsdl_execution::flow030::Target030::Step {
                    address: vec!["tests".into()],
                    message_json: None,
                    each_path_json: None,
                    concurrency_json: None,
                    max_json: None,
                }],
            });
        }
        let event = FlowEvent030 {
            identity: id.clone(),
            event_id: "enter".into(),
            expected_revision: "0".into(),
            kind: FlowEventKind030::Enter {
                message_json: "{}".into(),
            },
        };
        let transition = flow030::reduce(&plan, &FlowState030::new(id.clone()), &event).unwrap();
        Self::seed(temp, pool, authority, id, plan, vec![(event, transition)]).await
    }
    async fn seed(
        temp: tempfile::TempDir,
        pool: SqlitePool,
        authority: TestAuthority,
        id: FlowIdentity030,
        plan: FlowPlan030,
        history: Vec<(FlowEvent030, flow030::FlowTransition030)>,
    ) -> Self {
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
        let state = &history.last().unwrap().1.state;
        let effect = history
            .iter()
            .flat_map(|(_, t)| &t.effects)
            .find(|e| {
                if let flow030::FlowEffectKind030::Start {
                    work, agent: None, ..
                } = &e.kind
                {
                    state
                        .activations
                        .iter()
                        .any(|a| a.id == work.activation_id && a.phase == "running")
                } else {
                    false
                }
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
            .bind(serde_json::to_string(state).unwrap())
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
        for (event, transition) in &history {
            sqlx::query("INSERT INTO engine_flow030_events VALUES(?,?,?,?,?,NULL)")
                .bind("system")
                .bind("flow")
                .bind(&event.event_id)
                .bind(serde_json::to_string(event).unwrap())
                .bind(serde_json::to_string(&transition.receipt).unwrap())
                .execute(&mut *tx)
                .await
                .unwrap();
            for e in &transition.effects {
                sqlx::query("INSERT INTO engine_flow030_outbox VALUES(?,?,?,?,?,?,'pending',NULL)")
                    .bind("system")
                    .bind("flow")
                    .bind(&e.id)
                    .bind(&event.event_id)
                    .bind(serde_json::to_string(e).unwrap())
                    .bind("owner")
                    .execute(&mut *tx)
                    .await
                    .unwrap();
            }
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
    async fn shared_call() -> Self {
        Self::with_origin(
            r#"{"type":"call","command":"never execute","next":{"passed":"j1","failed":"j2"}}"#,
            true,
            r#"{"choice":"approve","results":{"items":["x","y"]}}"#,
        )
        .await
    }
    async fn input_call(declaration: &str, input: &str) -> Self {
        Self::with_origin(declaration, false, input).await
    }
    async fn with_origin(declaration: &str, shared: bool, input: &str) -> Self {
        let (temp, pool, authority, id) = fixture_parts().await;
        let mut plan: FlowPlan030 = if shared {
            serde_json::from_str(include_str!(
                "../tests/fixtures/agsdl030_shared_stop_active_compiled_plan.json"
            ))
            .unwrap()
        } else {
            serde_json::from_str(include_str!(
                "../tests/fixtures/agsdl030_compiled_plan.json"
            ))
            .unwrap()
        };
        if shared {
            let call = plan.steps.iter_mut().find(|s| s.address == ["a"]).unwrap();
            call.r#type = "call".into();
            call.agent = None;
            call.instance = None;
            call.delivery = None;
            call.submission_contract_json = None;
            call.declaration_json = declaration.into();
            for route in &mut plan.routes {
                if route.source == ["a"] {
                    route.key = route
                        .key
                        .as_deref()
                        .map(|k| if k == "one" { "passed" } else { "failed" }.into());
                }
            }
            for join in &mut plan.joins {
                join.accept = join
                    .accept
                    .iter()
                    .map(|k| if k == "one" { "passed" } else { "failed" }.into())
                    .collect();
            }
        } else {
            let call = Step030 {
                address: vec!["a".into()],
                scope: vec![],
                r#type: "call".into(),
                declaration_json: declaration.into(),
                agent: None,
                instance: None,
                delivery: None,
                max_visits_json: None,
                timeout_ms_json: None,
                submission_contract_json: None,
            };
            let mut origin = plan
                .steps
                .iter()
                .find(|s| s.r#type == "agent")
                .unwrap()
                .clone();
            origin.address = vec!["o".into()];
            origin.scope = vec![];
            origin.declaration_json = r#"{"type":"agent","agent":"worker","next":"a"}"#.into();
            plan.entry = Some(vec!["o".into()]);
            plan.steps = vec![origin, call];
            plan.joins.clear();
            plan.handlers.clear();
            plan.scopes.clear();
            plan.routes = vec![
                Route030 {
                    source: vec!["o".into()],
                    kind: "normal".into(),
                    key: None,
                    declaration_json: "\"a\"".into(),
                    inherited: false,
                    targets: vec![flow030::Target030::Step {
                        address: vec!["a".into()],
                        message_json: None,
                        each_path_json: None,
                        concurrency_json: None,
                        max_json: None,
                    }],
                },
                Route030 {
                    source: vec!["a".into()],
                    kind: "normal".into(),
                    key: None,
                    declaration_json: "[]".into(),
                    inherited: false,
                    targets: vec![],
                },
            ];
        }
        let mut state = FlowState030::new(id.clone());
        let mut history = vec![];
        let mut send = |kind: FlowEventKind030| {
            let event = FlowEvent030 {
                identity: id.clone(),
                event_id: format!("fixture:{}", history.len()),
                expected_revision: state.revision.clone(),
                kind,
            };
            let t = flow030::reduce(&plan, &state, &event).unwrap();
            state = t.state.clone();
            history.push((event, t));
        };
        send(FlowEventKind030::Enter {
            message_json: "{}".into(),
        });
        // Native synthetic origin receipt only seeds this unit fixture; no
        // provider/agent execution or authority is qualified by these tests.
        drop(send);
        let origin = state
            .activations
            .iter()
            .find(|a| a.phase == "running")
            .unwrap();
        let event = FlowEvent030 {
            identity: id.clone(),
            event_id: "fixture:origin-result".into(),
            expected_revision: state.revision.clone(),
            kind: FlowEventKind030::WorkResult {
                work: WorkRef030 {
                    activation_id: origin.id.clone(),
                    start_effect_id: origin.start_effect_id.clone().unwrap(),
                    agent_instance_id: origin.instance_id.clone(),
                },
                result: flow030::WorkResult030::Completed {
                    output_json: input.into(),
                    route_key: shared.then(|| "approve".into()),
                },
                physical: Some(flow030::PhysicalEvidence030 {
                    native_receipt_id: "fixture-origin-joined".into(),
                    descendants_joined: true,
                }),
            },
        };
        let t = flow030::reduce(&plan, &state, &event).unwrap();
        state = t.state.clone();
        history.push((event, t));
        let preparation = state
            .preparations
            .iter()
            .find(|p| p.status == "pending")
            .unwrap();
        let route = plan
            .routes
            .iter()
            .find(|r| {
                r.source == preparation.reference.route.source
                    && r.kind == preparation.reference.route.kind
                    && r.key == preparation.reference.route.key
            })
            .unwrap();
        let batches = route
            .targets
            .iter()
            .enumerate()
            .map(|(ordinal, target)| flow030::PreparedBatch030 {
                target_ordinal: ordinal,
                target: target.clone(),
                items: (0..if shared { 2 } else { 1 })
                    .map(|index| flow030::PreparedItem030 {
                        message_json: None,
                        item_json: shared
                            .then(|| if index == 0 { "\"x\"" } else { "\"y\"" }.into()),
                        occurrence: flow030::DeliveryOccurrence030 {
                            native_receipt_id: "fixture-prepare".into(),
                            target_ordinal: ordinal,
                            item_index: index.to_string(),
                        },
                    })
                    .collect(),
            })
            .collect();
        let event = FlowEvent030 {
            identity: id.clone(),
            event_id: "fixture:prepared".into(),
            expected_revision: state.revision.clone(),
            kind: FlowEventKind030::Prepared {
                reference: preparation.reference.clone(),
                native_receipt_id: "fixture-prepare".into(),
                result: flow030::PreparedResult030::Ready { batches },
            },
        };
        let t = flow030::reduce(&plan, &state, &event).unwrap();
        history.push((event, t));
        Self::seed(temp, pool, authority, id, plan, history).await
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

// Synthetic durable 040 rows exercise the call verifier independently of a clock.
async fn clock_decision(f: &Fixture, attempt: &CallAttempt030, variant: &str) {
    let mut reference = attempt.work().clone();
    let mut generation = attempt.generation().to_owned();
    let mut owner = attempt.owner_epoch().to_owned();
    let mut identity = attempt.identity().clone();
    if variant == "activation" {
        reference.activation_id.push_str("-foreign");
    }
    if variant == "visit" {
        reference.start_effect_id.push_str("-foreign-visit");
        sqlx::query("INSERT INTO engine_flow030_outbox SELECT system_id,invocation_id,?,event_id,effect_json,owner_epoch,status,settlement_json FROM engine_flow030_outbox WHERE effect_id=?")
            .bind(&reference.start_effect_id).bind(&attempt.work().start_effect_id).execute(&f.pool).await.unwrap();
        sqlx::query("INSERT INTO engine_flow030_handoffs SELECT system_id,invocation_id,?,owner_epoch,generation,receipt_json FROM engine_flow030_handoffs WHERE effect_id=?")
            .bind(&reference.start_effect_id).bind(&attempt.work().start_effect_id).execute(&f.pool).await.unwrap();
    }
    if variant == "generation" {
        generation.push_str("-foreign");
    }
    if variant == "owner" {
        owner.push_str("-foreign");
    }
    if variant == "snapshot" {
        identity.snapshot_id.push_str("-foreign");
    }
    let work = json!({"identity":identity,"owner":{"systemStartId":identity.system_start_id,"ownerEpoch":owner},
        "generation":generation,"reference":reference,"kind":"call","providerAttemptId":null});
    sqlx::query("INSERT INTO engine_flow030_clock_works(system_id,invocation_id,activation_id,start_effect_id,owner_epoch,generation,kind,work_json,admitted_ms,timeout_json) VALUES(?,?,?,?,?,?,'call',?,'0',?)")
        .bind(&f.id.system_start_id).bind(&f.id.flow_invocation_id).bind(&reference.activation_id)
        .bind(&reference.start_effect_id).bind(owner).bind(generation).bind(work.to_string())
        .bind(if variant == "no-budget" { None } else { Some("100") })
        .execute(&f.pool).await.unwrap();
    sqlx::query("INSERT INTO engine_flow030_clock_controls(system_id,invocation_id,activation_id,receipt_id,reason,observed_ms) VALUES(?,?,?,?,'TIMEOUT','100')")
        .bind(&f.id.system_start_id).bind(&f.id.flow_invocation_id).bind(&reference.activation_id)
        .bind(uuid::Uuid::new_v4().to_string()).execute(&f.pool).await.unwrap();
}

pub(crate) async fn finish_terminal(
    pool: &SqlitePool,
    authority: &TestAuthority,
    broker: &CallDataBroker030,
    joined: &JoinedCall030,
    cancel: &CancellationToken,
) -> Result<CallReceipt030> {
    match super::finish_joined_call030(pool, authority, broker, joined, cancel).await? {
        CallSettlement030::Terminal { receipt } => Ok(receipt),
        CallSettlement030::Diagnostic { diagnostic } => {
            panic!("Unexpected diagnostic: {:?}", diagnostic.value())
        }
    }
}
async fn stop_before_launch_receipt(
    pool: &SqlitePool,
    authority: &TestAuthority,
    attempt: &CallAttempt030,
) -> Result<CallReceipt030> {
    match super::stop_before_launch030(pool, authority, attempt).await? {
        CallSettlement030::Terminal { receipt } => Ok(receipt),
        CallSettlement030::Diagnostic { diagnostic } => {
            panic!("Unexpected diagnostic: {:?}", diagnostic.value())
        }
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
pub(crate) async fn worker_completion(broker: &CallDataBroker030) -> HostRouteCompletion030 {
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
    HostRouteCompletion030 {
        ticket: job.ticket,
        generation: job.generation.clone(),
        input_digest: job.input_digest,
        output: crate::agsdl_host_route030::HostRouteOutput030::Ready {
            result_json: String::from_utf8(output.stdout).unwrap(),
        },
    }
}
pub(crate) async fn worker_once(broker: &CallDataBroker030) {
    let completion = worker_completion(broker).await;
    broker
        .complete(&completion.generation.clone(), completion)
        .unwrap();
}
pub(crate) async fn prepare(f: &Fixture, broker: &CallDataBroker030, attempt: &CallAttempt030) {
    let cancel = CancellationToken::new();
    let (result, ()) = tokio::join!(
        prepare_call030(&f.pool, &f.authority, broker, attempt, &cancel),
        worker_once(broker)
    );
    assert!(matches!(result.unwrap(), CallPreparation030::Ready));
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
        finish_terminal(&f.pool, &f.authority, broker, joined, &cancel),
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
        finish_terminal(
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
            read_call_receipt030(&f.pool, &f.authority, &f.id, joined.attempt().work())
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
            read_call_receipt030(&f.pool, &f.authority, &f.id, joined.attempt().work())
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
    let receipt = finish_terminal(
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
    assert!(stop_before_launch_receipt(&f.pool, &f.authority, &attempt)
        .await
        .is_err());
    f.stop().await;
    let receipt = stop_before_launch_receipt(&f.pool, &f.authority, &attempt)
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
        stop_before_launch_receipt(&f.pool, &f.authority, &attempt)
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
    let f = Fixture::new(r#"{"type":"call","command":"never execute","timeoutMs":100}"#).await;
    let broker = CallDataBroker030::default();
    let attempt = f.reserve().await;
    prepare(&f, &broker, &attempt).await;
    f.handoff(&attempt).await;
    clock_decision(&f, &attempt, "valid").await;
    let control = control();
    let timeout = control.machine_timeout.clone();
    let (_driver, owned) = launch_synthetic030(&f.pool, &f.authority, &attempt, control)
        .await
        .unwrap();
    record_call_cause030(&f.pool, &f.authority, &attempt)
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
    let receipt = finish_terminal(
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

#[tokio::test]
async fn stop_uses_joined_physical_end_when_normalizer_is_unavailable() {
    for stop_after_raw_commit in [false, true] {
        let f = Fixture::new(r#"{"type":"call","command":"never execute"}"#).await;
        let broker = CallDataBroker030::default();
        let joined = joined(&f, &broker, command(0, "late output")).await;
        let cancel = CancellationToken::new();
        let receipt = if stop_after_raw_commit {
            let finish = finish_terminal(&f.pool, &f.authority, &broker, &joined, &cancel);
            let stop_and_close = async {
                let _ = broker.next().await.unwrap();
                assert_eq!(
                    sqlx::query_scalar::<_, String>("SELECT status FROM engine_flow030_calls")
                        .fetch_one(&f.pool)
                        .await
                        .unwrap(),
                    "received"
                );
                f.stop().await;
                broker.close();
                cancel.cancel();
            };
            let (result, ()) = tokio::join!(finish, stop_and_close);
            result.unwrap()
        } else {
            f.stop().await;
            broker.close();
            cancel.cancel();
            finish_terminal(&f.pool, &f.authority, &broker, &joined, &cancel)
                .await
                .unwrap()
        };
        assert_eq!(receipt.status(), "stopped");
        assert!(receipt.work_result().unwrap().is_none());
        assert!(!f.state().await.activations[0].physical);
        assert_eq!(f.state().await.verdict.as_deref(), Some("cancelled"));
        assert_eq!(
            read_call_receipt030(&f.pool, &f.authority, &f.id, joined.attempt().work())
                .await
                .unwrap(),
            Some(receipt)
        );
    }
}

#[tokio::test]
async fn terminal_commit_sets_full_on_its_own_connection_after_normalization() {
    let f = Fixture::new(r#"{"type":"call","command":"never execute"}"#).await;
    let broker = CallDataBroker030::default();
    let joined = joined(&f, &broker, command(0, "done")).await;
    // One connection makes the interleaving deterministic: after raw receipt
    // commit, return that connection with WAL NORMAL before terminal acquire.
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with((*f.pool.connect_options()).clone())
        .await
        .unwrap();
    let cancel = CancellationToken::new();
    let finish = finish_terminal(&pool, &f.authority, &broker, &joined, &cancel);
    let worker = async {
        let completion = worker_completion(&broker).await;
        sqlx::query("PRAGMA synchronous=NORMAL")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA synchronous")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
        broker
            .complete(&completion.generation.clone(), completion)
            .unwrap();
    };
    let (receipt, ()) = tokio::join!(finish, worker);
    assert_eq!(receipt.unwrap().status(), "succeeded");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA synchronous")
            .fetch_one(&pool)
            .await
            .unwrap(),
        2
    );
    pool.close().await;
}

#[tokio::test]
async fn mcp_operand_failure_is_durable_before_handoff_and_selects_on_error() {
    let f = Fixture::new(r#"{"type":"call","mcp":{"server":"server","tool":"tool"},"arguments":{"n":{"path":["missing"]}},"onError":"tests"}"#).await;
    let broker = CallDataBroker030::default();
    let attempt = f.reserve().await;
    let cancel = CancellationToken::new();
    let (prepared, ()) = tokio::join!(
        prepare_call030(&f.pool, &f.authority, &broker, &attempt, &cancel),
        worker_once(&broker)
    );
    let CallPreparation030::Failed { receipt } = prepared.unwrap() else {
        panic!("Missing durable operand failure")
    };
    let Some(flow030::WorkResult030::Failed { error }) = receipt.work_result().unwrap() else {
        panic!()
    };
    assert_eq!(error.code, "OPERAND");
    assert_eq!(receipt.status(), "failed");
    assert!(!f.state().await.activations[0].physical);
    assert_eq!(f.state().await.activations[0].phase, "preparing");
    let rows: Vec<String> = sqlx::query_scalar("SELECT effect_json FROM engine_flow030_outbox")
        .fetch_all(&f.pool)
        .await
        .unwrap();
    assert!(rows.iter().any(|raw| matches!(serde_json::from_str::<FlowEffect030>(raw).unwrap().kind,
        flow030::FlowEffectKind030::PrepareRoute { reference,producer } if reference.route.kind == "error"
            && serde_json::from_str::<serde_json::Value>(&producer.output_json).unwrap()["error"]["code"] == "OPERAND")));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM engine_flow030_handoffs")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        0
    );
    assert!(
        launch_synthetic030(&f.pool, &f.authority, &attempt, control())
            .await
            .is_err()
    );
    broker.close();
    let before = f.state().await;
    assert_eq!(
        read_call_receipt030(&f.pool, &f.authority, &f.id, attempt.work())
            .await
            .unwrap(),
        Some(receipt)
    );
    assert_eq!(f.state().await, before);
}

#[test]
fn joined_witness_struct_literal_is_rejected_by_the_rust_compiler() {
    // Compile the actual sealed module, not a copy of its field definitions.
    // Production-only dependencies are absent in this small privacy harness;
    // the QA-only join impl is cfg-disabled. A positive control prevents a
    // missing import/syntax error from making the negative case pass by chance.
    let source = include_str!("agsdl_host_calls030.rs");
    let start = source.find("mod joined {").unwrap();
    let end = source
        .find("pub(crate) use joined::JoinedCall030;")
        .unwrap()
        + "pub(crate) use joined::JoinedCall030;".len();
    let actual = &source[start..end];
    let prefix = "#![allow(dead_code)]\n#[derive(Debug)] struct CallAttempt030;\n#[derive(Debug)] struct CancellationToken; impl CancellationToken { async fn cancelled(&self){} }\nmod protocol { #[derive(Debug)] pub enum CallEnd030 { Stopped } }\nmod owner { use super::{CallAttempt030,protocol,CancellationToken};\n";
    let control = "}\nfn inspect(w: &owner::JoinedCall030) { let _=(w.attempt(),w.end(),w.receipt_id()); }\nfn main(){}\n";
    let attack = "}\nfn main(){ let _=owner::JoinedCall030 { attempt:CallAttempt030,end:protocol::CallEnd030::Stopped,receipt_id:String::from(\"forged\"),stop:CancellationToken,timeout:CancellationToken }; }\n";
    let tmp = tempfile::TempDir::new().unwrap();
    let compile = |tail: &str| {
        let file = tmp.path().join("proof.rs");
        std::fs::write(&file, [prefix, actual, tail].concat()).unwrap();
        crate::core::process::background_command("rustc")
            .args([
                "--edition=2021",
                "--crate-name=call_join_privacy",
                "--emit=metadata",
            ])
            .arg(&file)
            .arg("-o")
            .arg(tmp.path().join("proof.rmeta"))
            .output()
            .unwrap()
    };
    let positive = compile(control);
    assert!(
        positive.status.success(),
        "{}",
        String::from_utf8_lossy(&positive.stderr)
    );
    let negative = compile(attack);
    let error = String::from_utf8_lossy(&negative.stderr);
    assert!(!negative.status.success());
    assert!(error.contains("E0451"), "{error}");
    for field in ["attempt", "end", "receipt_id", "stop", "timeout"] {
        assert!(error.contains(field), "{error}");
    }
}

#[tokio::test]
async fn genuine_deferred_foreign_key_commit_failure_keeps_the_call_fenced() {
    let f = Fixture::new(r#"{"type":"call","command":"never execute"}"#).await;
    let broker = CallDataBroker030::default();
    let joined = joined(&f, &broker, command(0, "must roll back")).await;
    sqlx::raw_sql("CREATE TABLE call_commit_parent(id INTEGER PRIMARY KEY);\nCREATE TABLE call_commit_child(id INTEGER REFERENCES call_commit_parent(id) DEFERRABLE INITIALLY DEFERRED);\nCREATE TRIGGER call_commit_fault AFTER UPDATE OF status ON engine_flow030_calls WHEN NEW.status='terminal' BEGIN INSERT INTO call_commit_child(id) VALUES(42); END;")
        .execute(&f.pool).await.unwrap();
    let cancel = CancellationToken::new();
    let (result, ()) = tokio::join!(
        finish_terminal(&f.pool, &f.authority, &broker, &joined, &cancel),
        worker_once(&broker)
    );
    assert_eq!(result.unwrap_err().code, "COMMIT_UNCERTAIN");
    // The deferred constraint fails at COMMIT, after marker installation. SQLx
    // rolls back the terminal state and reducer event together, retaining raw.
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM engine_flow030_calls")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        "received"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM engine_flow030_events WHERE event_id=?")
            .bind(format!("call:{}:terminal", joined.attempt().call_id()))
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        0
    );
    assert!(f.state().await.activations[0].physical);
    assert!(f.authority.call_commits().require_clear(&f.id).is_err());
    assert!(inspect_call_commit030(&f.pool, &f.authority, &f.id)
        .await
        .is_err());
    assert!(f.authority.call_commits().require_clear(&f.id).is_err());
    assert!(
        launch_synthetic030(&f.pool, &f.authority, joined.attempt(), control())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn native_stop_signal_interrupts_a_normalizer_that_never_answers() {
    let f = Fixture::new(r#"{"type":"call","command":"never execute"}"#).await;
    let broker = CallDataBroker030::default();
    let attempt = f.reserve().await;
    prepare(&f, &broker, &attempt).await;
    f.handoff(&attempt).await;
    let control = control();
    let stop = control.stop.clone();
    let (driver, owned) = launch_synthetic030(&f.pool, &f.authority, &attempt, control)
        .await
        .unwrap();
    driver.send(command(0, "returned before stop")).unwrap();
    let joined = owned.join().await.unwrap();
    let cancel = CancellationToken::new();
    let finish = finish_terminal(&f.pool, &f.authority, &broker, &joined, &cancel);
    let stop_without_worker_answer = async {
        let _unanswered_job = broker.next().await.unwrap();
        f.stop().await;
        stop.cancel();
    };
    let (result, ()) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(finish, stop_without_worker_answer)
    })
    .await
    .expect("Physical Stop must not wait for a normalizer response");
    assert_eq!(result.unwrap().status(), "stopped");
    assert!(!f.state().await.activations[0].physical);
}

#[tokio::test]
async fn persisted_timeout_wins_over_returned_before_machine_notification() {
    let f = Fixture::new(r#"{"type":"call","command":"never execute","timeoutMs":100}"#).await;
    let broker = CallDataBroker030::default();
    let attempt = f.reserve().await;
    prepare(&f, &broker, &attempt).await;
    f.handoff(&attempt).await;
    clock_decision(&f, &attempt, "valid").await;
    let control = control();
    let notification = control.machine_timeout.clone();
    let (driver, owned) = launch_synthetic030(&f.pool, &f.authority, &attempt, control)
        .await
        .unwrap();
    let cause = record_call_cause030(&f.pool, &f.authority, &attempt)
        .await
        .unwrap();
    assert_eq!(
        record_call_cause030(&f.pool, &f.authority, &attempt)
            .await
            .unwrap(),
        cause
    );
    assert!(!notification.is_cancelled());
    driver.send(command(0, "late success preserved")).unwrap();
    let joined = owned.join().await.unwrap();
    assert!(matches!(
        joined.end(),
        protocol::CallEnd030::Returned { .. }
    ));
    broker.close();
    let receipt = finish_terminal(
        &f.pool,
        &f.authority,
        &broker,
        &joined,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let Some(flow030::WorkResult030::Failed { error }) = receipt.work_result().unwrap() else {
        panic!("Late return won against durable timeout")
    };
    assert_eq!(error.code, "TIMEOUT");
    let raw: serde_json::Value = serde_json::from_str(
        &sqlx::query_scalar::<_, String>("SELECT received_json FROM engine_flow030_calls")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(raw["end"]["kind"], "returned");
    assert_eq!(raw["end"]["event"]["stdout"], "late success preserved");
    assert!(!f.state().await.activations[0].physical);
    assert_eq!(
        read_call_receipt030(&f.pool, &f.authority, &f.id, attempt.work())
            .await
            .unwrap(),
        Some(receipt)
    );
}

#[tokio::test]
async fn durable_timeout_interrupts_pending_normalization_after_raw_commit() {
    let f = Fixture::new(r#"{"type":"call","command":"never execute","timeoutMs":100}"#).await;
    let broker = CallDataBroker030::default();
    let attempt = f.reserve().await;
    prepare(&f, &broker, &attempt).await;
    f.handoff(&attempt).await;
    let control = control();
    let notification = control.machine_timeout.clone();
    let (driver, owned) = launch_synthetic030(&f.pool, &f.authority, &attempt, control)
        .await
        .unwrap();
    driver.send(command(0, "already returned")).unwrap();
    let joined = owned.join().await.unwrap();
    let cancel = CancellationToken::new();
    let finish = finish_terminal(&f.pool, &f.authority, &broker, &joined, &cancel);
    let expire = async {
        let _unanswered = broker.next().await.unwrap();
        clock_decision(&f, &attempt, "valid").await;
        record_call_cause030(&f.pool, &f.authority, &attempt)
            .await
            .unwrap();
        notification.cancel();
    };
    let (result, ()) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(finish, expire)
    })
    .await
    .unwrap();
    let Some(flow030::WorkResult030::Failed { error }) = result.unwrap().work_result().unwrap()
    else {
        panic!()
    };
    assert_eq!(error.code, "TIMEOUT");
}

#[tokio::test]
async fn machine_notification_without_durable_cause_cannot_mint_timeout() {
    let f = Fixture::new(r#"{"type":"call","command":"never execute"}"#).await;
    let broker = CallDataBroker030::default();
    let attempt = f.reserve().await;
    prepare(&f, &broker, &attempt).await;
    f.handoff(&attempt).await;
    let control = control();
    let notification = control.machine_timeout.clone();
    let (_driver, owned) = launch_synthetic030(&f.pool, &f.authority, &attempt, control)
        .await
        .unwrap();
    notification.cancel();
    let joined = owned.join().await.unwrap();
    assert!(finish_terminal(
        &f.pool,
        &f.authority,
        &broker,
        &joined,
        &CancellationToken::new()
    )
    .await
    .is_err());
    assert!(
        read_call_receipt030(&f.pool, &f.authority, &f.id, attempt.work())
            .await
            .unwrap()
            .is_none()
    );
    assert!(f.state().await.activations[0].physical);
}

#[tokio::test]
async fn shared_call_diagnostic_commits_once_without_normalizer_or_reducer_replay() {
    let f = Fixture::shared_call().await;
    let broker = CallDataBroker030::default();
    let joined = joined(&f, &broker, command(0, "shared result")).await;
    let before = f.state().await;
    let effects: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_flow030_outbox")
        .fetch_one(&f.pool)
        .await
        .unwrap();
    let cancel = CancellationToken::new();
    let (result, ()) = tokio::join!(
        super::finish_joined_call030(&f.pool, &f.authority, &broker, &joined, &cancel),
        worker_once(&broker)
    );
    let CallSettlement030::Diagnostic { diagnostic } = result.unwrap() else {
        panic!("Expected shared cancellation diagnostic")
    };
    assert_eq!(
        diagnostic.value()["code"],
        "UNSPECIFIED_SHARED_CANCELLATION"
    );
    assert_eq!(f.state().await, before);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM engine_flow030_outbox")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        effects
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM engine_flow030_calls")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        "received"
    );
    let row = sqlx::query(
        "SELECT receipt_json,diagnostic_json FROM engine_flow030_events WHERE event_id=?",
    )
    .bind(diagnostic.event_id())
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert!(row.get::<Option<&str>, _>("receipt_json").is_none());
    assert!(row
        .get::<Option<&str>, _>("diagnostic_json")
        .unwrap()
        .contains("UNSPECIFIED_SHARED_CANCELLATION"));
    assert!(
        read_call_receipt030(&f.pool, &f.authority, &f.id, joined.attempt().work())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        launch_synthetic030(&f.pool, &f.authority, joined.attempt(), control())
            .await
            .is_err()
    );
    broker.close();
    cancel.cancel();
    let CallPreparation030::Diagnostic {
        diagnostic: prepared_diagnostic,
    } = prepare_call030(&f.pool, &f.authority, &broker, joined.attempt(), &cancel)
        .await
        .unwrap()
    else {
        panic!("Preparation replayed a diagnosed call")
    };
    assert_eq!(prepared_diagnostic, diagnostic);
    let CallSettlement030::Diagnostic {
        diagnostic: stopped_diagnostic,
    } = super::stop_before_launch030(&f.pool, &f.authority, joined.attempt())
        .await
        .unwrap()
    else {
        panic!("Stop invented a terminal for a diagnosed call")
    };
    assert_eq!(stopped_diagnostic, diagnostic);
    for _ in 0..2 {
        let CallSettlement030::Diagnostic {
            diagnostic: repeated,
        } = super::finish_joined_call030(&f.pool, &f.authority, &broker, &joined, &cancel)
            .await
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(repeated, diagnostic);
    }
    assert_eq!(
        read_call_diagnostic030(&f.pool, &f.authority, &f.id, joined.attempt().work())
            .await
            .unwrap(),
        Some(diagnostic)
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM engine_flow030_call_diagnostics")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(f.state().await, before);
}

#[tokio::test]
async fn mcp_negative_zero_index_agrees_between_typescript_preparation_and_native_verifier() {
    let f=Fixture::input_call(r#"{"type":"call","mcp":{"server":"server","tool":"tool"},"arguments":{"item":{"path":["xs",-0]}}}"#,
        r#"{"xs":[{"n":9007199254740993}]}"#).await;
    let broker = CallDataBroker030::default();
    let attempt = f.reserve().await;
    prepare(&f, &broker, &attempt).await;
    let prepared: PreparedCall030 = serde_json::from_str(
        &sqlx::query_scalar::<_, String>("SELECT prepared_json FROM engine_flow030_calls")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
    )
    .unwrap();
    let PreparedCall030::Mcp { arguments_json, .. } = &prepared else {
        panic!()
    };
    assert!(arguments_json.contains("9007199254740993"));
    protocol::validate_prepared(&attempt, &prepared).unwrap();
    assert!(protocol::require_operand_failure(&attempt).is_err());
}

#[tokio::test]
async fn timeout_without_clock_decision_is_refused() {
    let f = Fixture::new(r#"{"type":"call","command":"never execute","timeoutMs":100}"#).await;
    let broker = CallDataBroker030::default();
    let attempt = f.reserve().await;
    prepare(&f, &broker, &attempt).await;
    f.handoff(&attempt).await;
    let (_driver, _owned) = launch_synthetic030(&f.pool, &f.authority, &attempt, control())
        .await
        .unwrap();
    assert!(record_call_cause030(&f.pool, &f.authority, &attempt)
        .await
        .is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_flow030_call_causes")
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn timeout_without_budget_or_for_foreign_clock_work_is_refused() {
    for variant in [
        "no-budget",
        "unauthored-budget",
        "activation",
        "visit",
        "generation",
        "owner",
        "snapshot",
    ] {
        let declaration = if variant == "unauthored-budget" {
            r#"{"type":"call","command":"never execute"}"#
        } else {
            r#"{"type":"call","command":"never execute","timeoutMs":100}"#
        };
        let f = Fixture::new(declaration).await;
        let broker = CallDataBroker030::default();
        let attempt = f.reserve().await;
        prepare(&f, &broker, &attempt).await;
        f.handoff(&attempt).await;
        let (_driver, _owned) = launch_synthetic030(&f.pool, &f.authority, &attempt, control())
            .await
            .unwrap();
        clock_decision(&f, &attempt, variant).await;
        assert!(
            record_call_cause030(&f.pool, &f.authority, &attempt)
                .await
                .is_err(),
            "{variant}"
        );
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_flow030_call_causes")
            .fetch_one(&f.pool)
            .await
            .unwrap();
        assert_eq!(count, 0, "{variant}");
    }
}

#[tokio::test]
async fn timeout_cannot_be_written_after_a_normal_terminal() {
    let f = Fixture::new(r#"{"type":"call","command":"never execute","timeoutMs":100}"#).await;
    let broker = CallDataBroker030::default();
    let joined = joined(&f, &broker, command(0, "done")).await;
    let receipt = finish(&f, &broker, &joined).await;
    assert_eq!(receipt.status(), "succeeded");
    clock_decision(&f, joined.attempt(), "valid").await;
    assert!(
        record_call_cause030(&f.pool, &f.authority, joined.attempt())
            .await
            .is_err()
    );
    assert_eq!(
        read_call_receipt030(&f.pool, &f.authority, &f.id, joined.attempt().work())
            .await
            .unwrap(),
        Some(receipt)
    );
}

#[tokio::test]
async fn concurrent_clock_timeout_and_stop_always_publish_stop() {
    let f = Fixture::new(r#"{"type":"call","command":"never execute","timeoutMs":100}"#).await;
    let broker = CallDataBroker030::default();
    let attempt = f.reserve().await;
    prepare(&f, &broker, &attempt).await;
    f.handoff(&attempt).await;
    let (driver, owned) = launch_synthetic030(&f.pool, &f.authority, &attempt, control())
        .await
        .unwrap();
    clock_decision(&f, &attempt, "valid").await;
    let stop = async {
        let _guard = f.authority.gate.lock().await;
        f.stop().await;
    };
    let (cause, ()) =
        tokio::join!(biased; record_call_cause030(&f.pool, &f.authority, &attempt), stop);
    assert!(
        cause.is_ok(),
        "The timeout attestation must commit before the queued Stop"
    );
    assert!(record_call_cause030(&f.pool, &f.authority, &attempt)
        .await
        .is_err());
    driver.send(command(0, "late return")).unwrap();
    let joined = owned.join().await.unwrap();
    broker.close();
    let receipt = finish_terminal(
        &f.pool,
        &f.authority,
        &broker,
        &joined,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(receipt.status(), "stopped");
    assert!(receipt.work_result().unwrap().is_none());
    assert!(!f.state().await.activations[0].physical);
}

#[test]
fn timeout_proof_fields_cannot_be_constructed_outside_protocol() {
    let source = include_str!("db/agsdl_execution/call_protocol030.rs");
    let start = source.find("pub(crate) struct CallStopCause030 {").unwrap();
    let end = start + source[start..].find('}').unwrap() + 1;
    let actual = &source[start..end];
    let tmp = tempfile::TempDir::new().unwrap();
    let compile = |tail: &str| {
        let file = tmp.path().join("proof.rs");
        std::fs::write(
            &file,
            format!("#![allow(dead_code)]\nmod protocol {{ {actual} }}\n{tail}"),
        )
        .unwrap();
        crate::core::process::background_command("rustc")
            .args([
                "--edition=2021",
                "--crate-name=call_timeout_privacy",
                "--emit=metadata",
            ])
            .arg(&file)
            .arg("-o")
            .arg(tmp.path().join("proof.rmeta"))
            .output()
            .unwrap()
    };
    assert!(
        compile("fn inspect(_: &protocol::CallStopCause030) {} fn main() {}")
            .status
            .success()
    );
    let result=compile("fn main(){ let _=protocol::CallStopCause030 { clock_receipt_id:String::new(),observed_ms:String::new(),timeout_json:String::new() }; }");
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("E0451"));
}

#[tokio::test]
async fn clock_commit_before_supervisor_attestation_already_overrides_late_return() {
    let f = Fixture::new(r#"{"type":"call","command":"never execute","timeoutMs":100}"#).await;
    let broker = CallDataBroker030::default();
    let joined = joined(&f, &broker, command(0, "late")).await;
    clock_decision(&f, joined.attempt(), "valid").await;
    // No call cause API and no timeout notification have run yet.
    broker.close();
    let receipt = finish_terminal(
        &f.pool,
        &f.authority,
        &broker,
        &joined,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let Some(flow030::WorkResult030::Failed { error }) = receipt.work_result().unwrap() else {
        panic!()
    };
    assert_eq!(error.code, "TIMEOUT");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM engine_flow030_call_causes")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        1
    );
}
