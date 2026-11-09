use super::*;
use crate::agsdl_host_clock030::{HostClockCompletion030, HostClockJob030};
use crate::db::agsdl_execution::flow030::{Activation030, Instance030};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::AsyncWriteExt;

#[derive(Default)]
struct TestClock(AtomicU64);
impl Clock030 for TestClock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}
impl TestClock {
    fn at(&self, ms: u64) {
        self.0.store(ms, Ordering::SeqCst);
    }
}
struct Fixture {
    _tmp: tempfile::TempDir,
    host: HostState,
    broker: HumanBroker030,
    clock: Arc<TestClock>,
    scope: HumanScope030,
    attempt: FlowWorkAttempt030,
}
async fn fixture(kind: &str, timeout: Option<u64>, answer_timeout: Option<u64>) -> Fixture {
    let tmp = tempfile::TempDir::new().unwrap();
    let pool = crate::db::create_pool(&tmp.path().join("human.db"))
        .await
        .unwrap();
    sqlx::raw_sql(include_str!(
        "db/migrations/040_execution_flow_human_clock030.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    let attempt = FlowWorkAttempt030::registry_fixture030("provider-attempt");
    let id = attempt.identity().clone();
    let owner = attempt.owner().clone();
    let reference = WorkRef030 {
        activation_id: attempt.work().activation_id.clone(),
        start_effect_id: attempt.start_effect_id().into(),
        agent_instance_id: (kind == "agent")
            .then(|| attempt.work().agent_instance_id.clone())
            .flatten(),
    };
    let mut plan: FlowPlan030 = serde_json::from_str(include_str!(
        "../tests/fixtures/agsdl030_compiled_plan.json"
    ))
    .unwrap();
    let mut step = plan.steps[0].clone();
    step.address = vec!["work".into()];
    step.r#type = kind.into();
    step.timeout_ms_json = timeout.map(|t| t.to_string());
    step.declaration_json = json!({"type":kind,"title":"Review","next":{"publish":"done","revise":"work"},"answerTimeoutMs":answer_timeout}).to_string();
    step.agent = (kind == "agent").then(|| attempt.agent().into());
    plan.steps = vec![step];
    let authored = json!({"agents":{attempt.agent():{"answerTimeoutMs":answer_timeout}}});
    // Absence is meaningful: null is not a positive duration.
    let mut authored = authored;
    if answer_timeout.is_none() {
        authored["agents"][attempt.agent()]
            .as_object_mut()
            .unwrap()
            .remove("answerTimeoutMs");
    }
    if answer_timeout.is_none() {
        let mut decl: Value = serde_json::from_str(&plan.steps[0].declaration_json).unwrap();
        decl.as_object_mut().unwrap().remove("answerTimeoutMs");
        plan.steps[0].declaration_json = decl.to_string();
    }
    let capture = StartCapture030 {
        identity: id.clone(),
        source: serde_json::from_value(plan.source.clone()).unwrap(),
        versions: serde_json::from_value(serde_json::to_value(&plan.versions).unwrap()).unwrap(),
        authored_source: authored.to_string(),
        compiled_plan_json: serde_json::to_string(&plan).unwrap(),
        registry_json: "{}".into(),
        private_capture_json: "{}".into(),
    };
    let scope = HumanScope030 {
        system_start_id: id.system_start_id.clone(),
        source: capture.source.clone(),
    };
    let capture_raw = serde_json::to_string(&capture).unwrap();
    let mut state = FlowState030::new(id.clone());
    state.activations.push(Activation030 {
        id: reference.activation_id.clone(),
        step: attempt.work().step.clone(),
        agent: (kind == "agent").then(|| attempt.agent().into()),
        selector: Some(Instance030::Shared),
        delivery: "queue".into(),
        instance_id: reference.agent_instance_id.clone(),
        sender: None,
        context: vec![],
        phase: "running".into(),
        physical: true,
        physical_wait_groups: vec![],
        start_effect_id: Some(reference.start_effect_id.clone()),
        stop_effect_id: None,
        input_json: "{}".into(),
        message_json: Some(
            "{\"prompt\":\"Draft\",\"resources\":{\"comment\":\"Checked twice.\"}}".into(),
        ),
        item_json: None,
        occurrence: None,
        producer: None,
        result: None,
    });
    let effect = FlowEffect030 {
        id: reference.start_effect_id.clone(),
        identity: id.clone(),
        revision: "1".into(),
        kind: FlowEffectKind030::Start {
            work: reference.clone(),
            step: attempt.work().step.clone(),
            agent: (kind == "agent").then(|| attempt.agent().into()),
            input_json: "{}".into(),
            message_json: state.activations[0].message_json.clone(),
            item_json: None,
            occurrence: None,
            sender: None,
        },
    };
    let handoff = json!({"kind":"nativeOwnedHandoff030","requestId":format!("flow030:{}:{}",id.system_start_id,reference.start_effect_id),"identity":id,"effectId":reference.start_effect_id,"ownerEpoch":owner.owner_epoch,"generation":attempt.generation(),"workAttempt":if kind=="agent" {serde_json::to_value(&attempt).unwrap()} else {Value::Null}});
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO engine_flow030_runs VALUES(?,?,?,?,?,?,?)")
        .bind(&id.system_start_id)
        .bind(&id.flow_invocation_id)
        .bind(&id.snapshot_id)
        .bind(&id.epoch)
        .bind(plan.source.to_string())
        .bind(serde_json::to_string(&plan).unwrap())
        .bind(serde_json::to_string(&state).unwrap())
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_start030_requests VALUES(?,?,?,?,?,?,?,?)")
        .bind("request")
        .bind("{}")
        .bind(&id.system_start_id)
        .bind(&id.flow_invocation_id)
        .bind(&id.snapshot_id)
        .bind(&id.epoch)
        .bind(&capture_raw)
        .bind("{}")
        .execute(&mut *tx)
        .await
        .unwrap();
    let digest = format!("{:x}", Sha256::digest(capture_raw.as_bytes()));
    sqlx::query("INSERT INTO engine_flow030_owners VALUES(?,?,?,?,?,?,?,?)")
        .bind(&id.system_start_id)
        .bind(&id.flow_invocation_id)
        .bind(&id.snapshot_id)
        .bind(&id.epoch)
        .bind(&owner.owner_epoch)
        .bind(attempt.generation())
        .bind("live")
        .bind(&digest)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_events VALUES(?,?,?,?,?,NULL)")
        .bind(&id.system_start_id)
        .bind(&id.flow_invocation_id)
        .bind("seed")
        .bind("{}")
        .bind("{}")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_outbox VALUES(?,?,?,?,?,?,?,?)")
        .bind(&id.system_start_id)
        .bind(&id.flow_invocation_id)
        .bind(&reference.start_effect_id)
        .bind("seed")
        .bind(serde_json::to_string(&effect).unwrap())
        .bind(&owner.owner_epoch)
        .bind("settled")
        .bind("{}")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO engine_flow030_handoffs VALUES(?,?,?,?,?,?)")
        .bind(&id.system_start_id)
        .bind(&id.flow_invocation_id)
        .bind(&reference.start_effect_id)
        .bind(&owner.owner_epoch)
        .bind(attempt.generation())
        .bind(handoff.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    if kind == "agent" {
        sqlx::query("INSERT INTO engine_flow030_work_admissions VALUES(?,?,?,?,?,?,?,?,?,?,?)")
            .bind(&id.system_start_id)
            .bind(&id.flow_invocation_id)
            .bind(&reference.activation_id)
            .bind(&reference.start_effect_id)
            .bind(&owner.owner_epoch)
            .bind(attempt.generation())
            .bind(&digest)
            .bind("{}")
            .bind("{}")
            .bind("{}")
            .bind("{}")
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    let clock = Arc::new(TestClock::default());
    let host = crate::agsdl_host::route_attestation_test_host030(owner, attempt.generation());
    let broker = HumanBroker030::attach(&host, pool, id, clock.clone(), Arc::default())
        .await
        .unwrap();
    Fixture {
        _tmp: tmp,
        host,
        broker,
        clock,
        scope,
        attempt,
    }
}
async fn evaluate(job: &HostClockJob030) -> HostClockOutput030 {
    let script = "import {evaluateHumanClockJob030} from './src/services/agsdlExecution/humanAnswer030'; process.stdout.write(JSON.stringify(evaluateHumanClockJob030(JSON.parse(await Bun.stdin.text()))));";
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
        .write_all(&serde_json::to_vec(job).unwrap())
        .await
        .unwrap();
    let output = child.wait_with_output().await.unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
async fn pump(f: &Fixture) -> Value {
    let cancel = CancellationToken::new();
    let (result, ()) = tokio::join!(f.broker.pump(&f.host, &cancel), async {
        let job = f.broker.jobs.next().await.unwrap();
        let output = evaluate(&job).await;
        f.broker
            .jobs
            .complete(
                &job.generation,
                HostClockCompletion030 {
                    ticket: job.ticket.clone(),
                    generation: job.generation.clone(),
                    input_digest: job.input_digest.clone(),
                    output,
                },
            )
            .unwrap();
    });
    serde_json::from_str(&result.unwrap().unwrap().receipt_json).unwrap()
}
fn submission(f: &Fixture, id: &str, revision: &str, answer: HumanAnswer030) -> HumanSubmission030 {
    HumanSubmission030 {
        scope: f.scope.clone(),
        request_id: id.into(),
        expected_revision: revision.into(),
        answer,
    }
}
fn yes() -> HumanAnswer030 {
    HumanAnswer030::Decision {
        decision: "yes".into(),
        comment: "".into(),
    }
}

#[tokio::test]
async fn native_hour_wait_union_then_exact_machine_timeout() {
    let f = fixture("agent", Some(60000), None).await;
    let work = f.broker.admit_agent(&f.host, &f.attempt).await.unwrap();
    pump(&f).await;
    f.clock.at(30000);
    let first = f
        .broker
        .open(&f.host, &work, "ask", json!({"action":"synthetic-read"}))
        .await
        .unwrap();
    pump(&f).await;
    let second = f
        .broker
        .open(&f.host, &work, "ask", json!({"action":"synthetic-read-2"}))
        .await
        .unwrap();
    pump(&f).await;
    f.clock.at(3630000);
    f.broker
        .submit(
            &f.host,
            submission(&f, &first, "0", yes()),
            HumanOrigin030::Person,
        )
        .await
        .unwrap();
    let receipt = pump(&f).await;
    assert_eq!(
        receipt["clocks"][0]["snapshot"]["elapsedMachineMs"],
        "30000"
    );
    assert_eq!(
        receipt["clocks"][0]["snapshot"]["openHumanRequests"],
        json!([second])
    );
    assert!(f.broker.timeout_controls().await.unwrap().is_empty());
    f.broker
        .submit(
            &f.host,
            submission(&f, &second, "0", yes()),
            HumanOrigin030::Person,
        )
        .await
        .unwrap();
    pump(&f).await;
    f.clock.at(3659999);
    f.broker.tick(&f.host).await.unwrap();
    assert_eq!(pump(&f).await["expiredWorkIds"], json!([]));
    f.clock.at(3660000);
    f.broker.tick(&f.host).await.unwrap();
    assert_eq!(pump(&f).await["expiredWorkIds"], json!([work.work_id()]));
    let controls = f.broker.timeout_controls().await.unwrap();
    assert_eq!(controls.len(), 1);
    assert_eq!(controls[0].work_id(), work.work_id());
    let reason: String = sqlx::query_scalar("SELECT reason FROM engine_flow030_clock_controls")
        .fetch_one(&f.broker.pool)
        .await
        .unwrap();
    assert_eq!(reason, "TIMEOUT");
}

#[tokio::test]
async fn native_approval_arbitrary_choice_comment_and_timeout_late_answer() {
    let f = fixture("approval", Some(86400000), None).await;
    let work = f
        .broker
        .admit_host_work(&f.host, f.attempt.start_effect_id())
        .await
        .unwrap();
    pump(&f).await;
    let request = f.broker.oldest_open(&work).await.unwrap().unwrap();
    f.broker
        .submit(
            &f.host,
            submission(
                &f,
                &request,
                "0",
                HumanAnswer030::Approval {
                    choice: "revise".into(),
                    comment: "Corriger le titre.".into(),
                },
            ),
            HumanOrigin030::Person,
        )
        .await
        .unwrap();
    pump(&f).await;
    let decision = f.broker.take_resolution(&f.host, &request).await.unwrap();
    let output = decision.approval_output().unwrap();
    assert_eq!(output["choice"], "revise");
    assert_eq!(output["comment"], "Corriger le titre.");
    assert_eq!(output["message"]["resources"]["comment"], "Checked twice.");
    assert!(f.broker.take_resolution(&f.host, &request).await.is_err());
    f.broker.acknowledge(&f.host, &decision).await.unwrap();
    assert_eq!(pump(&f).await["pendingResolutions"], json!([]));
    let g = fixture("approval", Some(86400000), None).await;
    let work = g
        .broker
        .admit_host_work(&g.host, g.attempt.start_effect_id())
        .await
        .unwrap();
    pump(&g).await;
    let request = g.broker.oldest_open(&work).await.unwrap().unwrap();
    g.clock.at(86400000);
    g.broker
        .submit(
            &g.host,
            submission(
                &g,
                &request,
                "0",
                HumanAnswer030::Approval {
                    choice: "publish".into(),
                    comment: "".into(),
                },
            ),
            HumanOrigin030::Person,
        )
        .await
        .unwrap();
    let result = pump(&g).await;
    assert_eq!(
        result["pendingResolutions"][0]["failure"],
        "APPROVAL_TIMEOUT"
    );
    assert_eq!(result["nativeAnswers"][0]["accepted"], false);
    assert!(g
        .broker
        .take_resolution(&g.host, &request)
        .await
        .unwrap()
        .approval_output()
        .is_err());
}

#[tokio::test]
async fn native_intermediate_deadline_and_plan_resolution_precede_terminal() {
    for kind in ["ask", "plan", "question"] {
        let f = fixture("agent", Some(60000), Some(600000)).await;
        let work = f.broker.admit_agent(&f.host, &f.attempt).await.unwrap();
        pump(&f).await;
        let request = f
            .broker
            .open(
                &f.host,
                &work,
                kind,
                json!({"planId":"plan","text":"Synthetic plan","nativeCallId":"call"}),
            )
            .await
            .unwrap();
        pump(&f).await;
        assert_eq!(f.broker.next_wake_ms().await.unwrap(), Some(600000));
        // Driver must stabilize here before consuming the final 1 ms.
        f.clock.at(600000);
        f.broker.tick(&f.host).await.unwrap();
        let result = pump(&f).await;
        assert_eq!(result["pendingResolutions"][0]["resolvedAtMs"], "600000");
        let decision = f.broker.take_resolution(&f.host, &request).await.unwrap();
        if kind == "plan" {
            assert_eq!(decision.plan_event().unwrap()["kind"], "planResolved");
            assert_eq!(
                decision.resolution()["workActions"][0]["action"],
                "PLAN_REJECTED"
            );
        } else {
            assert_eq!(
                decision.resolution()["workActions"][0]["action"],
                "continue"
            );
        }
        f.broker.acknowledge(&f.host, &decision).await.unwrap();
        pump(&f).await;
        f.clock.at(600001);
        f.broker.tick(&f.host).await.unwrap();
        assert_eq!(
            pump(&f).await["clocks"][0]["snapshot"]["elapsedMachineMs"],
            "1"
        );
        assert!(f.broker.timeout_controls().await.unwrap().is_empty());
    }
}

#[tokio::test]
async fn native_rejects_forged_scope_revision_visit_and_owner() {
    let f = fixture("approval", Some(10), None).await;
    let work = f
        .broker
        .admit_host_work(&f.host, f.attempt.start_effect_id())
        .await
        .unwrap();
    pump(&f).await;
    let request = f.broker.oldest_open(&work).await.unwrap().unwrap();
    let answer = HumanAnswer030::Approval {
        choice: "publish".into(),
        comment: "".into(),
    };
    assert!(f
        .broker
        .submit(
            &f.host,
            submission(&f, &request, "9", answer.clone()),
            HumanOrigin030::Person
        )
        .await
        .is_err());
    let mut forged = submission(&f, &request, "0", answer.clone());
    forged.scope.source.owner.project_id = "foreign".into();
    assert!(f
        .broker
        .submit(&f.host, forged, HumanOrigin030::Person)
        .await
        .is_err());
    let wrong_host = crate::agsdl_host::route_attestation_test_host030(
        EngineOwner {
            system_start_id: f.broker.identity.system_start_id.clone(),
            owner_epoch: "foreign".into(),
        },
        f.attempt.generation(),
    );
    assert!(f
        .broker
        .submit(
            &wrong_host,
            submission(&f, &request, "0", answer.clone()),
            HumanOrigin030::Person
        )
        .await
        .is_err());
    let mut db = f.broker.pool.acquire().await.unwrap();
    let raw: String = sqlx::query_scalar("SELECT state_json FROM engine_flow030_runs")
        .fetch_one(&mut *db)
        .await
        .unwrap();
    let mut state: FlowState030 = serde_json::from_str(&raw).unwrap();
    state.activations[0].phase = "done".into();
    sqlx::query("UPDATE engine_flow030_runs SET state_json=?")
        .bind(serde_json::to_string(&state).unwrap())
        .execute(&mut *db)
        .await
        .unwrap();
    drop(db);
    assert!(f
        .broker
        .submit(
            &f.host,
            submission(&f, &request, "0", answer),
            HumanOrigin030::Person
        )
        .await
        .is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_flow030_human_submissions")
        .fetch_one(&f.broker.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn native_reconstruction_retains_budget_and_never_replays_reserved_delivery() {
    let f = fixture("agent", Some(60000), Some(10)).await;
    let work = f.broker.admit_agent(&f.host, &f.attempt).await.unwrap();
    pump(&f).await;
    let request = f
        .broker
        .open(&f.host, &work, "ask", json!({"action":"synthetic"}))
        .await
        .unwrap();
    pump(&f).await;
    f.clock.at(10);
    f.broker.tick(&f.host).await.unwrap();
    pump(&f).await;
    let decision = f.broker.take_resolution(&f.host, &request).await.unwrap();
    let reopened = HumanBroker030::attach(
        &f.host,
        f.broker.pool.clone(),
        f.broker.identity.clone(),
        f.clock.clone(),
        Arc::default(),
    )
    .await
    .unwrap();
    assert!(reopened
        .pump(&f.host, &CancellationToken::new())
        .await
        .unwrap()
        .is_none());
    assert!(reopened.take_resolution(&f.host, &request).await.is_err());
    let existing = reopened.admit_agent(&f.host, &f.attempt).await.unwrap();
    assert_eq!(existing.work_id(), work.work_id());
    assert!(reopened
        .pump(&f.host, &CancellationToken::new())
        .await
        .unwrap()
        .is_none());
    // An uncertain reservation is readable and may only be acked by its owner.
    reopened.acknowledge(&f.host, &decision).await.unwrap();
    let foreign_generation =
        crate::agsdl_host::route_attestation_test_host030(f.broker.owner.clone(), "new-generation");
    assert!(HumanBroker030::attach(
        &foreign_generation,
        f.broker.pool.clone(),
        f.broker.identity.clone(),
        f.clock.clone(),
        Arc::default()
    )
    .await
    .is_err());
}

#[tokio::test]
async fn native_plan_gate_rejects_mutation_until_correlated_person_accepts() {
    use crate::agsdl_host_work_admission030::NativePlanLock030;
    let f = fixture("agent", None, None).await;
    let work = f.broker.admit_agent(&f.host, &f.attempt).await.unwrap();
    pump(&f).await;
    let gate = NativePlanLock030::fixture030(&f.attempt);
    assert!(gate.authorize(&f.attempt, false).await.is_err());
    drop(gate.authorize(&f.attempt, true).await.unwrap());
    gate.presented(&f.attempt, "p1").await.unwrap();
    let request = f
        .broker
        .open(
            &f.host,
            &work,
            "plan",
            json!({"planId":"p1","text":"First plan"}),
        )
        .await
        .unwrap();
    pump(&f).await;
    assert!(gate.authorize(&f.attempt, false).await.is_err());
    f.broker
        .submit(
            &f.host,
            submission(
                &f,
                &request,
                "0",
                HumanAnswer030::Decision {
                    decision: "no".into(),
                    comment: "Réviser.".into(),
                },
            ),
            HumanOrigin030::Person,
        )
        .await
        .unwrap();
    pump(&f).await;
    let declined = f.broker.take_resolution(&f.host, &request).await.unwrap();
    gate.resolve(&f.attempt, &declined).await.unwrap();
    assert!(gate.authorize(&f.attempt, false).await.is_err());
    f.broker.acknowledge(&f.host, &declined).await.unwrap();
    pump(&f).await;
    gate.presented(&f.attempt, "p2").await.unwrap();
    assert!(gate.resolve(&f.attempt, &declined).await.is_err());
    let request = f
        .broker
        .open(
            &f.host,
            &work,
            "plan",
            json!({"planId":"p2","text":"Revised plan"}),
        )
        .await
        .unwrap();
    pump(&f).await;
    f.broker
        .submit(
            &f.host,
            submission(&f, &request, "0", yes()),
            HumanOrigin030::Person,
        )
        .await
        .unwrap();
    pump(&f).await;
    let accepted = f.broker.take_resolution(&f.host, &request).await.unwrap();
    gate.resolve(&f.attempt, &accepted).await.unwrap();
    let permit = gate.authorize(&f.attempt, false).await.unwrap();
    // Holding the permit keeps an actual RwLock read guard, so a concurrent
    // plan-state writer cannot cross the physical operation it authorizes.
    assert!(tokio::time::timeout(
        std::time::Duration::from_millis(1),
        gate.presented(&f.attempt, "p3")
    )
    .await
    .is_err());
    drop(permit);
}

#[cfg(all(feature = "agsdl-engine-qa", debug_assertions))]
#[tokio::test]
async fn native_large_elapse_stabilizes_at_intermediate_deadlines() {
    use crate::agsdl_host_clock030::VirtualClock030;
    let mut f = fixture("agent", Some(60000), Some(600000)).await;
    let clock = Arc::new(VirtualClock030::default());
    f.broker.clock = clock.clone();
    let work = f.broker.admit_agent(&f.host, &f.attempt).await.unwrap();
    pump(&f).await;
    let request = f
        .broker
        .open(&f.host, &work, "ask", json!({"action":"synthetic"}))
        .await
        .unwrap();
    pump(&f).await;
    let jobs = f.broker.jobs.clone();
    let resident = tokio::spawn(async move {
        while let Ok(job) = jobs.next().await {
            let output = evaluate(&job).await;
            jobs.complete(
                &job.generation,
                HostClockCompletion030 {
                    ticket: job.ticket.clone(),
                    generation: job.generation.clone(),
                    input_digest: job.input_digest.clone(),
                    output,
                },
            )
            .unwrap();
        }
    });
    let boundaries = std::sync::Mutex::new(Vec::new());
    f.broker.elapse_qa(&f.host,&clock,600001,&CancellationToken::new(),|| async {
        boundaries.lock().unwrap().push(clock.now_ms());
        if clock.now_ms() == 600000 {
            // The first pass is before tick; the second follows its commit.
            let raw: Option<String> = sqlx::query_scalar("SELECT resolution_json FROM engine_flow030_human_requests WHERE request_id=?")
                .bind(&request).fetch_one(&f.broker.pool).await?;
            if raw.is_some() {
                let decision = f.broker.take_resolution(&f.host,&request).await?;
                f.broker.acknowledge(&f.host,&decision).await?;
                f.broker.pump(&f.host,&CancellationToken::new()).await?;
            }
        }
        Ok(())
    }).await.unwrap();
    assert!(boundaries.lock().unwrap().contains(&600000));
    let raw: String = sqlx::query_scalar("SELECT receipt_json FROM engine_flow030_clock")
        .fetch_one(&f.broker.pool)
        .await
        .unwrap();
    let receipt: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(receipt["clocks"][0]["snapshot"]["elapsedMachineMs"], "1");
    assert_eq!(clock.now_ms(), 600001);
    f.broker.jobs.close();
    resident.await.unwrap();
}

#[tokio::test]
async fn native_protocol_answer_requires_attested_validator_and_preserves_exact_bytes() {
    struct Validator;
    impl QuestionValidator030 for Validator {
        fn validate(&self, payload: &Value, answer: &str) -> Result<()> {
            require(
                payload["protocolReceiptId"] == "native-protocol-receipt"
                    && answer == "{\"count\":9007199254740993}",
                "Protocol answer schema differs",
            )
        }
    }
    let f = fixture("call", Some(60000), Some(600000)).await;
    let work = f
        .broker
        .admit_host_work(&f.host, f.attempt.start_effect_id())
        .await
        .unwrap();
    pump(&f).await;
    let request = f.broker.open_question(&f.host,&work,json!({"nativeCallId":"native-call","protocolReceiptId":"native-protocol-receipt","schema":"count"}),Arc::new(Validator)).await.unwrap();
    pump(&f).await;
    assert!(f
        .broker
        .submit(
            &f.host,
            submission(
                &f,
                &request,
                "0",
                HumanAnswer030::Question {
                    answer_json: "{\"count\":false}".into()
                }
            ),
            HumanOrigin030::Person
        )
        .await
        .is_err());
    let exact = "{\"count\":9007199254740993}";
    f.broker
        .submit(
            &f.host,
            submission(
                &f,
                &request,
                "0",
                HumanAnswer030::Question {
                    answer_json: exact.into(),
                },
            ),
            HumanOrigin030::Person,
        )
        .await
        .unwrap();
    pump(&f).await;
    let decision = f.broker.take_resolution(&f.host, &request).await.unwrap();
    assert_eq!(
        f.broker
            .protocol_answer(&decision)
            .await
            .unwrap()
            .as_deref(),
        Some(exact)
    );
    assert!(f.broker.timeout_controls().await.unwrap().is_empty());
}

#[cfg(all(feature = "agsdl-engine-qa", debug_assertions))]
#[tokio::test]
async fn qa_submission_is_explicitly_synthetic_person_in_the_product_service() {
    let f = fixture("agent", None, None).await;
    let work = f.broker.admit_agent(&f.host, &f.attempt).await.unwrap();
    pump(&f).await;
    let request = f
        .broker
        .open(&f.host, &work, "ask", json!({"action":"synthetic"}))
        .await
        .unwrap();
    pump(&f).await;
    f.broker
        .submit(
            &f.host,
            submission(&f, &request, "0", yes()),
            HumanOrigin030::SyntheticPerson,
        )
        .await
        .unwrap();
    pump(&f).await;
    let origin: String = sqlx::query_scalar("SELECT origin FROM engine_flow030_human_submissions")
        .fetch_one(&f.broker.pool)
        .await
        .unwrap();
    assert_eq!(origin, "synthetic-person");
}
