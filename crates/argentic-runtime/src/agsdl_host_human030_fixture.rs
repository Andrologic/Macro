//! Shared synthetic native human fixture; no provider or application.
use super::*;
use crate::persistence::flow030::{Activation030, Instance030};
use std::sync::atomic::{AtomicU64, Ordering};
#[derive(Default)]
pub(super) struct TestClock(AtomicU64);
impl Clock030 for TestClock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}
impl TestClock {
    pub(super) fn at(&self, ms: u64) {
        self.0.store(ms, Ordering::SeqCst);
    }
}
pub(super) struct Fixture {
    #[cfg(test)]
    _tmp: tempfile::TempDir,
    pub(super) host: HostState,
    pub(super) broker: Arc<HumanBroker030>,
    pub(super) clock: Arc<TestClock>,
    pub(super) scope: HumanScope030,
    pub(super) attempt: FlowWorkAttempt030,
}
pub(super) async fn fixture(
    kind: &str,
    timeout: Option<u64>,
    answer_timeout: Option<u64>,
) -> Fixture {
    fixture_with_second_work(kind, timeout, answer_timeout, None).await
}
pub(super) async fn fixture_with_second_work(
    kind: &str,
    timeout: Option<u64>,
    answer_timeout: Option<u64>,
    second_timeout: Option<u64>,
) -> Fixture {
    #[cfg(test)]
    let tmp = tempfile::TempDir::new().unwrap();
    #[cfg(test)]
    let pool = crate::sqlite::create_file(&tmp.path().join("human.db"))
        .await
        .unwrap();
    #[cfg(not(test))]
    let pool = crate::sqlite::memory().await.unwrap();
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
    if let Some(timeout) = second_timeout {
        assert_eq!(kind, "call", "The second owned work is a native host Call");
        let mut second = plan.steps[0].clone();
        second.address = vec!["second-work".into()];
        second.timeout_ms_json = Some(timeout.to_string());
        plan.steps.push(second);
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
    if second_timeout.is_some() {
        let mut second = state.activations[0].clone();
        second.id = "second-activation".into();
        second.step = Some(vec!["second-work".into()]);
        second.start_effect_id = Some("second-start".into());
        state.activations.push(second);
    }
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
    let mut effects = vec![effect.clone()];
    if second_timeout.is_some() {
        let mut second = effect.clone();
        second.id = "second-start".into();
        let FlowEffectKind030::Start { work, step, .. } = &mut second.kind else {
            unreachable!()
        };
        work.activation_id = "second-activation".into();
        work.start_effect_id = second.id.clone();
        *step = Some(vec!["second-work".into()]);
        effects.push(second);
    }
    let clock = Arc::new(TestClock::default());
    let host =
        crate::agsdl_host::route_attestation_test_host030(owner.clone(), attempt.generation());
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
    let lease = host.start_lease().await.unwrap();
    for effect in &effects {
        let handoff = json!({"kind":"nativeOwnedHandoff030","requestId":format!("flow030:{}:{}",id.system_start_id,effect.id),"identity":id,"effectId":effect.id,"ownerEpoch":owner.owner_epoch,"generation":attempt.generation(),"workAttempt":if kind=="agent" {serde_json::to_value(&attempt).unwrap()} else {Value::Null}});
        sqlx::query("INSERT INTO engine_flow030_outbox VALUES(?,?,?,?,?,?,?,?)")
            .bind(&id.system_start_id)
            .bind(&id.flow_invocation_id)
            .bind(&effect.id)
            .bind("seed")
            .bind(serde_json::to_string(effect).unwrap())
            .bind(&owner.owner_epoch)
            .bind("uncertain")
            .bind(None::<String>)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO engine_flow030_handoffs VALUES(?,?,?,?,?,?)")
            .bind(&id.system_start_id)
            .bind(&id.flow_invocation_id)
            .bind(&effect.id)
            .bind(&owner.owner_epoch)
            .bind(attempt.generation())
            .bind(handoff.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        crate::agsdl_host_clock030::record_handoff_clock_tx(
            &mut tx,
            &lease,
            effect,
            clock.as_ref(),
        )
        .await
        .unwrap();
    }
    sqlx::query("UPDATE engine_flow030_outbox SET status='settled',settlement_json='{}'")
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
    #[cfg(test)]
    let jobs = Arc::default();
    #[cfg(not(test))]
    let jobs = host.start_lease().await.unwrap().clock_jobs030();
    let broker = HumanBroker030::attach(&host, pool, id, clock.clone(), jobs)
        .await
        .unwrap();
    Fixture {
        #[cfg(test)]
        _tmp: tmp,
        host,
        broker: Arc::new(broker),
        clock,
        scope,
        attempt,
    }
}
pub(super) fn submission(
    f: &Fixture,
    id: &str,
    revision: &str,
    answer: HumanAnswer030,
) -> HumanSubmission030 {
    HumanSubmission030 {
        scope: f.scope.clone(),
        request_id: id.into(),
        expected_revision: revision.into(),
        answer,
    }
}
pub(super) async fn stop_fence(f: &Fixture) {
    // Exercise the same native admission exclusion and durable stopping fact
    // read by the broker. Physical Stop/join remains the integrator's executor.
    let lease = f.host.start_lease().await.unwrap();
    let _gate = f.host.admission_lock().lock_owned().await;
    let mut tx = f.broker.pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    f.broker.guard(&mut tx, &lease).await.unwrap();
    let raw: String = sqlx::query_scalar("SELECT state_json FROM engine_flow030_runs")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    let mut state: FlowState030 = serde_json::from_str(&raw).unwrap();
    state.stopping = true;
    sqlx::query("UPDATE engine_flow030_runs SET state_json=?")
        .bind(serde_json::to_string(&state).unwrap())
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
}
