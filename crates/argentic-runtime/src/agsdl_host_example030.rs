//! Scripted executors for in-process native 0.3 tests. They never invoke
//! a provider, tool, process, or network endpoint.
use crate::persistence::{
    failure,
    flow030::{FlowEffect030, FlowEffectKind030},
    Result,
};
use crate::{
    agsdl_host::HostState,
    agsdl_host_flow030::FlowWorkAttempt030,
    host::HostContext,
    persistence::{flow_work_protocol030, work_dto030::ProtocolDecision030},
    tasks::StreamTasks,
};
use sqlx::SqlitePool;
use tokio_util::sync::CancellationToken;

const ADAPTER: &str = "macro-example030-qa/1";
const VERSION: &str = "1.0.0";
/// Issued by the adapter itself, not deserialized from a registry or IPC.
pub(crate) struct ExampleObservation030 {
    _private: (),
}

pub(crate) struct ExampleAdapter030;

/// A started example remains owned by the registry while the native timeline
/// decides when to deliver its result. The mailbox does not carry authority.
#[path = "agsdl_host_example_human030.rs"]
mod human;
use human::*;

struct ScriptedWork030 {
    key: crate::agsdl_host_scenario030::WorkKey030,
    attempt: FlowWorkAttempt030,
    human: crate::agsdl_host_human030::OwnedHumanWork030,
    plan_lock: Option<std::sync::Arc<crate::agsdl_host_work_admission030::NativePlanLock030>>,
    send: tokio::sync::oneshot::Sender<crate::agsdl_host_scenario030::ExampleResult030>,
    protocol: tokio::sync::mpsc::Sender<ScriptedAgentEvent030>,
    result: tokio::sync::oneshot::Receiver<Result<()>>,
    steer: crate::agsdl_host_steer030::SteerSender030,
}

struct ScriptedCall030 {
    key: crate::agsdl_host_scenario030::WorkKey030,
    request_id: String,
    human: crate::agsdl_host_human030::OwnedHumanWork030,
    driver: crate::agsdl_host_calls030::SyntheticCallDriver030,
    result: tokio::sync::oneshot::Receiver<Result<crate::agsdl_host_calls030::JoinedCall030>>,
}

async fn start_scripted_call030(
    app: &HostState,
    pool: &SqlitePool,
    tasks: &StreamTasks,
    owner: &crate::persistence::dto::EngineOwner,
    effect: &FlowEffect030,
    cancelled: &CancellationToken,
) -> Result<ScriptedCall030> {
    use crate::agsdl_host_call_authority030::NativeCallAuthority030;
    use crate::agsdl_host_calls030 as calls;
    let host = app;
    let lease = host.start_lease().await?;
    let broker = lease.call_data030()?;
    drop(lease);
    let authority = NativeCallAuthority030::capture(&host, owner).await?;
    let attempt = calls::reserve_call030(pool, &authority, effect).await?;
    match calls::prepare_call030(pool, &authority, &broker, &attempt, cancelled).await? {
        calls::CallPreparation030::Ready => {}
        _ => {
            return Err(failure(
                "CORRELATION",
                "example",
                "Pinned command preparation failed",
            ))
        }
    }
    drop(authority);
    let key = scripted_work_key030(effect)?;
    let claim = crate::agsdl_host_flow030::claim_expected(
        host.flow030(),
        &host,
        pool,
        &effect.identity,
        &effect.id,
    )
    .await?
    .ok_or_else(|| failure("STALE_REFERENCE", "call", "Pinned call Start changed"))?;
    if claim.effect() != effect {
        return Err(failure("CORRELATION", "call", "Pinned call claim differs"));
    }
    let request_id = claim.request_id();
    let (driver_send, driver_recv) = tokio::sync::oneshot::channel();
    let (result_send, result) = tokio::sync::oneshot::channel();
    let clock_broker = host
        .flow030()
        .humans
        .broker(&host, pool, &effect.identity)
        .await?;
    let (app, pool, owner, cancelled) =
        (app.clone(), pool.clone(), owner.clone(), cancelled.clone());
    claim
        .handoff_host(tasks, async move {
            let host = app;
            let result = async {
                let authority = NativeCallAuthority030::capture(&host, &owner).await?;
                let control = crate::agsdl_host_calls::Control {
                    stop: CancellationToken::new(),
                    machine_timeout: CancellationToken::new(),
                };
                let (driver, owned) =
                    calls::launch_synthetic030(&pool, &authority, &attempt, control).await?;
                drop(authority);
                driver_send
                    .send(driver)
                    .map_err(|_| failure("UNCERTAIN", "call", "Call timeline closed"))?;
                let joined = owned.join().await?;
                let authority = NativeCallAuthority030::capture(&host, &owner).await?;
                match calls::finish_joined_call030(&pool, &authority, &broker, &joined, &cancelled)
                    .await?
                {
                    calls::CallSettlement030::Terminal { .. } => Ok(joined),
                    calls::CallSettlement030::Diagnostic { .. } => {
                        Err(failure("UNCERTAIN", "call", "Pinned call has a diagnostic"))
                    }
                }
            }
            .await;
            let _ = result_send.send(result);
        })
        .await?;
    let human = clock_broker;
    let human_work = human.admit_host_work(&host, &effect.id).await?;
    human.pump(&host, &CancellationToken::new()).await?;
    let driver = driver_recv
        .await
        .map_err(|_| failure("UNCERTAIN", "call", "Call launch did not acknowledge"))?;
    Ok(ScriptedCall030 {
        key,
        request_id,
        human: human_work,
        driver,
        result,
    })
}

fn scripted_work_key030(
    effect: &FlowEffect030,
) -> Result<crate::agsdl_host_scenario030::WorkKey030> {
    let FlowEffectKind030::Start {
        step: Some(step),
        item_json,
        occurrence,
        ..
    } = &effect.kind
    else {
        return Err(failure("CORRELATION", "example", "Scripted start differs"));
    };
    let item = if item_json.is_some() {
        Some(
            occurrence
                .as_ref()
                .ok_or_else(|| failure("CORRELATION", "example", "Item occurrence is absent"))?
                .item_index
                .clone(),
        )
    } else {
        None
    };
    Ok(crate::agsdl_host_scenario030::WorkKey030 {
        step: step.clone(),
        item,
    })
}

struct ScriptedExecutor030 {
    channels: std::sync::Mutex<Option<ScriptedChannels030>>,
    plan_lock: std::sync::Mutex<
        Option<std::sync::Arc<crate::agsdl_host_work_admission030::NativePlanLock030>>,
    >,
}
struct ScriptedChannels030 {
    outcome: tokio::sync::oneshot::Receiver<crate::agsdl_host_scenario030::ExampleResult030>,
    protocol: tokio::sync::mpsc::Receiver<ScriptedAgentEvent030>,
    steer: crate::agsdl_host_steer030::SteerInbox030,
    result: tokio::sync::oneshot::Sender<Result<()>>,
}
impl crate::agsdl_host_runtime030::AgentExecutor030 for ScriptedExecutor030 {
    fn prepare(
        &self,
        work: crate::agsdl_host_work_admission030::PreparedEffectiveAgentWork030,
    ) -> Result<crate::agsdl_host_work_admission030::AttestedWorkPolicy030> {
        let policy = crate::agsdl_host_work_admission030::AttestedWorkPolicy030::from_example(
            work,
            &ExampleAdapter030::observe(),
        )?;
        *self
            .plan_lock
            .lock()
            .map_err(|_| failure("INTERRUPTED", "work", "Scripted plan lock unavailable"))? =
            policy.plan_lock();
        Ok(policy)
    }
    fn run(
        &self,
        work: crate::agsdl_host_runtime030::AgentWork030,
        events: crate::agsdl_host_runtime030::WorkEventSink030,
        cancel: CancellationToken,
    ) -> futures::future::BoxFuture<'static, Result<()>> {
        let channels = self.channels.lock().unwrap().take();
        Box::pin(async move {
            let mut channels = channels
                .ok_or_else(|| failure("CORRELATION", "work", "Scripted executor already ran"))?;
            let result = async {
                let mut deliveries = Vec::new();
                let outcome = loop {
                    tokio::select! {
                        _ = cancel.cancelled() => return Ok(()),
                        value = &mut channels.outcome => break value.map_err(|_| failure("INTERRUPTED", "work", "Scripted outcome closed"))?,
                        delivery = channels.steer.receive() => {
                            let Some(delivery) = delivery else { return Ok(()); };
                            deliveries.push(delivery.effect().clone());
                            delivery.acknowledge(&work.tasks, &work.attempt)?;
                        }
                        Some(event) = channels.protocol.recv() => {
                            let result = events.emit(event.body, &cancel).await;
                            let _ = event.reply.send(result);
                        }
                    }
                };
                match outcome {
                    crate::agsdl_host_scenario030::ExampleResult030::Failed(code) => {
                        expect_kind(&events.emit(serde_json::json!({"kind":"stop","reason":code}), &cancel).await?, "stopping")?;
                    }
                    crate::agsdl_host_scenario030::ExampleResult030::Returned { text, submit_json } => {
                        if let Some(text) = text {
                            expect_kind(&events.emit(serde_json::json!({"kind":"visibleText","messageId":"example","textParts":[text]}), &cancel).await?, "waiting")?;
                        }
                        expect_kind(&events.emit(serde_json::json!({"kind":"submit","callId":"example","argumentsJson":submit_json}), &cancel).await?, "accepted")?;
                    }
                }
                Ok(())
            }.await;
            let _ = channels.result.send(result.clone());
            result
        })
    }
}

async fn start_scripted_work030(
    app: &HostState,
    pool: &SqlitePool,
    config: &HostContext,
    tasks: &StreamTasks,
    owner: &crate::persistence::dto::EngineOwner,
    effect: &FlowEffect030,
    cancelled: &CancellationToken,
) -> Result<ScriptedWork030> {
    use crate::agsdl_host_runtime030::{native_event_emitter030, start_agent_work030};
    let host = app;
    let inspection =
        crate::agsdl_host_flow030::inspect_run(host.flow030(), &host, pool, owner).await?;
    let broker = host
        .flow030()
        .humans
        .broker(&host, pool, &effect.identity)
        .await?;
    let (result_send, result) = tokio::sync::oneshot::channel();
    let (send, outcome) = tokio::sync::oneshot::channel();
    let (steer, inbox) = crate::agsdl_host_steer030::channel030();
    let (protocol, protocol_recv) = tokio::sync::mpsc::channel(1);
    let executor = std::sync::Arc::new(ScriptedExecutor030 {
        channels: std::sync::Mutex::new(Some(ScriptedChannels030 {
            outcome,
            protocol: protocol_recv,
            steer: inbox,
            result: result_send,
        })),
        plan_lock: Default::default(),
    });
    let emitter = native_event_emitter030(
        app.clone(),
        pool.clone(),
        config.clone(),
        tasks.clone(),
        inspection.capture.source.owner.project_id,
    );
    let started = start_agent_work030(
        &host,
        pool,
        config,
        tasks,
        owner,
        effect,
        executor.clone(),
        emitter,
        cancelled.child_token(),
    )
    .await?;
    let plan_lock = executor.plan_lock.lock().unwrap().clone();
    let human = broker.admit_agent(&host, &started.attempt).await?;
    broker.pump(&host, &CancellationToken::new()).await?;
    Ok(ScriptedWork030 {
        key: scripted_work_key030(effect)?,
        attempt: started.attempt,
        human,
        plan_lock,
        send,
        protocol,
        result,
        steer,
    })
}

/// Drain eligible effects before the next timeline event. Agent starts are
/// attached to owned parents and wait for the corresponding native mailbox.
async fn quiesce_scenario030(
    app: &HostState,
    pool: &SqlitePool,
    config: &HostContext,
    tasks: &StreamTasks,
    owner: &crate::persistence::dto::EngineOwner,
    humans: &mut ScenarioHumans030,
    works: &mut Vec<ScriptedWork030>,
    calls: &mut Vec<ScriptedCall030>,
    joined_calls: &std::collections::BTreeMap<String, crate::agsdl_host_calls030::JoinedCall030>,
    joined: &std::collections::BTreeMap<String, crate::agsdl_host_dispatch030::JoinedOwnedAgent030>,
    cancelled: &CancellationToken,
) -> Result<crate::persistence::flow_store030::FlowView030> {
    let host = app;
    let mut driver = ScenarioDriver030 {
        app,
        pool,
        config,
        tasks,
        owner,
        humans,
        works,
        calls,
        joined_calls,
        joined,
        cancelled,
    };
    crate::agsdl_host_runtime030::drain_effects030(
        &host,
        pool,
        tasks,
        owner,
        &mut driver,
        cancelled,
    )
    .await
}

struct ScenarioDriver030<'a> {
    app: &'a HostState,
    pool: &'a SqlitePool,
    config: &'a HostContext,
    tasks: &'a StreamTasks,
    owner: &'a crate::persistence::dto::EngineOwner,
    humans: &'a mut ScenarioHumans030,
    works: &'a mut Vec<ScriptedWork030>,
    calls: &'a mut Vec<ScriptedCall030>,
    joined_calls: &'a std::collections::BTreeMap<String, crate::agsdl_host_calls030::JoinedCall030>,
    joined:
        &'a std::collections::BTreeMap<String, crate::agsdl_host_dispatch030::JoinedOwnedAgent030>,
    cancelled: &'a CancellationToken,
}
impl crate::agsdl_host_runtime030::EffectDriver030 for ScenarioDriver030<'_> {
    fn owns_effect(&self, id: &str) -> bool {
        self.works.iter().any(|w| w.attempt.start_effect_id() == id)
            || self
                .calls
                .iter()
                .any(|c| c.human.reference().start_effect_id == id)
            || self
                .humans
                .approvals
                .iter()
                .any(|a| a.work.reference().start_effect_id == id)
    }
    fn before_pass(&mut self) -> futures::future::BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            settle_humans030(
                self.app,
                self.pool,
                self.tasks,
                self.humans,
                self.works,
                self.cancelled,
            )
            .await
        })
    }
    fn start_agent(&mut self, effect: FlowEffect030) -> futures::future::BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let (app, pool, config, tasks, owner, cancelled, works) = (
                self.app,
                self.pool,
                self.config,
                self.tasks,
                self.owner,
                self.cancelled,
                &mut *self.works,
            );

            let key = scripted_work_key030(&effect)?;
            if works.iter().any(|existing| existing.key == key) {
                return Err(failure(
                    "CORRELATION",
                    "example",
                    "Scripted work key is ambiguous",
                ));
            }
            let work =
                start_scripted_work030(app, pool, config, tasks, owner, &effect, cancelled).await?;
            works.push(work);
            Ok(())
        })
    }
    fn start_host(
        &mut self,
        inspection: crate::agsdl_host_flow030::NativeFlowInspection030,
        effect: FlowEffect030,
    ) -> futures::future::BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let (app, pool, tasks, owner, cancelled, humans, works, calls) = (
                self.app,
                self.pool,
                self.tasks,
                self.owner,
                self.cancelled,
                &mut *self.humans,
                &mut *self.works,
                &mut *self.calls,
            );
            let host = app;
            match &effect.kind {
                FlowEffectKind030::Start {
                    agent: None,
                    step: Some(step),
                    ..
                } if serde_json::from_str::<crate::persistence::flow030::FlowPlan030>(
                    &inspection.capture.compiled_plan_json,
                )?
                .steps
                .iter()
                .any(|s| s.address == *step && s.r#type == "approval") =>
                {
                    let key = scripted_work_key030(&effect)?;
                    let claim = crate::agsdl_host_flow030::claim_expected(
                        host.flow030(),
                        &host,
                        pool,
                        &effect.identity,
                        &effect.id,
                    )
                    .await?
                    .ok_or_else(|| {
                        failure("STALE_REFERENCE", "approval", "Approval Start changed")
                    })?;
                    claim.handoff_host(tasks, std::future::pending()).await?;
                    let work = humans.broker.admit_host_work(&host, &effect.id).await?;
                    humans.broker.pump(&host, cancelled).await?;
                    humans.approvals.push(ScriptedApproval030 { key, work });
                }
                FlowEffectKind030::Start { agent: None, .. } => {
                    let key = scripted_work_key030(&effect)?;
                    if calls.iter().any(|c| c.key == key) || works.iter().any(|w| w.key == key) {
                        return Err(failure(
                            "CORRELATION",
                            "call",
                            "Pinned call key is ambiguous",
                        ));
                    }
                    calls.push(
                        start_scripted_call030(app, pool, tasks, owner, &effect, cancelled).await?,
                    );
                }
                _ => return Err(failure("CORRELATION", "work", "Expected host start")),
            }
            Ok(())
        })
    }
    fn steer(&mut self, effect: FlowEffect030) -> futures::future::BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let (app, pool, tasks, works) = (self.app, self.pool, self.tasks, &mut *self.works);
            let host = app;
            let FlowEffectKind030::Steer { work, .. } = &effect.kind else {
                unreachable!()
            };

            let matching = works
                .iter()
                .filter(|w| {
                    w.attempt.work().activation_id == work.activation_id
                        && w.attempt.start_effect_id() == work.start_effect_id
                        && w.attempt.work().agent_instance_id == work.agent_instance_id
                })
                .collect::<Vec<_>>();
            if matching.len() != 1 {
                return Err(failure("CORRELATION", "steer", "Steer work is not unique"));
            }
            let claim = crate::agsdl_host_flow030::claim_expected(
                host.flow030(),
                &host,
                pool,
                &effect.identity,
                &effect.id,
            )
            .await?
            .ok_or_else(|| failure("STALE_REFERENCE", "steer", "Steer claim changed"))?;
            claim
                .deliver_steer030(&matching[0].attempt, &matching[0].steer)
                .await?;
            Ok(())
        })
    }
    fn stop(&mut self, effect: FlowEffect030) -> futures::future::BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let (app, pool, tasks, owner, works) = (
                self.app,
                self.pool,
                self.tasks,
                self.owner,
                &mut *self.works,
            );
            let host = app;
            let FlowEffectKind030::StopWork { work, .. } = &effect.kind else {
                unreachable!()
            };

            let matching = works
                .iter()
                .enumerate()
                .filter(|(_, w)| {
                    w.attempt.work().activation_id == work.activation_id
                        && w.attempt.start_effect_id() == work.start_effect_id
                        && w.attempt.work().agent_instance_id == work.agent_instance_id
                })
                .map(|(i, _)| i)
                .collect::<Vec<_>>();
            if matching.len() != 1 {
                return Err(failure("CORRELATION", "stop", "Stopped work is not unique"));
            }
            let index = matching[0];
            crate::agsdl_host_dispatch030::dispatch_stop_work030(
                &host,
                pool,
                tasks,
                owner,
                &effect,
                &works[index].attempt,
            )
            .await?;
            works.remove(index);
            Ok(())
        })
    }
    fn source_owner<'a>(
        &'a self,
        reference: &crate::persistence::flow030::PrepareRef030,
        producer: &crate::persistence::flow030::Producer030,
    ) -> crate::agsdl_host_dispatch030::SourceOwnership030<'a> {
        use crate::agsdl_host_dispatch030::SourceOwnership030;
        if ["approval", "compose"].contains(&producer.kind.as_str()) {
            SourceOwnership030::Host
        } else if let Some(call) = self.joined_calls.get(&reference.activation_id) {
            SourceOwnership030::Call(call)
        } else {
            self.joined
                .get(&reference.activation_id)
                .or_else(|| self.humans.joined.get(&reference.activation_id))
                .map_or(SourceOwnership030::Join, SourceOwnership030::Agent)
        }
    }
}

pub(crate) async fn drive_scenario030(
    app: &HostState,
    pool: &SqlitePool,
    config: &HostContext,
    tasks: &StreamTasks,
    owner: &crate::persistence::dto::EngineOwner,
    scenario: crate::agsdl_host_scenario030::PinnedScenario030,
    cancelled: &CancellationToken,
) -> Result<crate::persistence::flow_store030::FlowView030> {
    use crate::agsdl_host_scenario030::TimelineEvent030;
    let host = app;
    let clock = host.flow030().humans.virtual_clock().await?;
    let inspection =
        crate::agsdl_host_flow030::inspect_run(host.flow030(), &host, pool, owner).await?;
    let broker = host
        .flow030()
        .humans
        .broker(&host, pool, &inspection.capture.identity)
        .await?;
    let mut humans = ScenarioHumans030 {
        broker,
        clock,
        approvals: Vec::new(),
        joined: Default::default(),
    };
    let mut works: Vec<ScriptedWork030> = Vec::new();
    let mut calls: Vec<ScriptedCall030> = Vec::new();
    let mut joined_calls = std::collections::BTreeMap::new();
    let mut joined = std::collections::BTreeMap::new();
    for event in scenario.timeline {
        let view = quiesce_scenario030(
            app,
            pool,
            config,
            tasks,
            owner,
            &mut humans,
            &mut works,
            &mut calls,
            &joined_calls,
            &joined,
            cancelled,
        )
        .await?;
        match event {
            TimelineEvent030::Elapse(ms) => {
                let end = crate::agsdl_host_clock030::Clock030::now_ms(humans.clock.as_ref())
                    .checked_add(ms)
                    .ok_or_else(|| failure("INPUT_LIMIT", "clock", "Elapse overflow"))?;
                loop {
                    humans.broker.tick(&host).await?;
                    humans.broker.pump(&host, cancelled).await?;
                    quiesce_scenario030(
                        app,
                        pool,
                        config,
                        tasks,
                        owner,
                        &mut humans,
                        &mut works,
                        &mut calls,
                        &joined_calls,
                        &joined,
                        cancelled,
                    )
                    .await?;
                    let now = crate::agsdl_host_clock030::Clock030::now_ms(humans.clock.as_ref());
                    if now == end {
                        break;
                    }
                    let wake = humans.broker.next_wake_ms().await?.unwrap_or(end - now);
                    if wake == 0 {
                        return Err(failure("CORRELATION", "clock", "Unsettled due control"));
                    }
                    humans.clock.advance_to(end.min(now.saturating_add(wake)))?;
                }
            }
            TimelineEvent030::Request { key, kind } => {
                let agent = works.iter().find(|w| w.key == key);
                let call = calls.iter().find(|w| w.key == key);
                let work = agent
                    .map(|w| &w.human)
                    .or_else(|| call.map(|w| &w.human))
                    .ok_or_else(|| failure("CORRELATION", "human", "Request work absent"))?;
                let payload = if kind == "plan" {
                    let agent =
                        agent.ok_or_else(|| failure("CORRELATION", "plan", "Plan work absent"))?;
                    let plan_id = format!("plan:{}", work.work_id());
                    agent
                        .plan_lock
                        .as_ref()
                        .ok_or_else(|| failure("CORRELATION", "plan", "Plan lock absent"))?
                        .presented(&agent.attempt, &plan_id)
                        .await?;
                    emit_scripted_agent030(agent,"plan",serde_json::json!({"kind":"planPresented","planId":plan_id,"text":"Pinned QA plan"})).await?;
                    serde_json::json!({"planId":plan_id,"text":"Pinned QA plan"})
                } else {
                    serde_json::json!({"question":"Pinned QA request"})
                };
                humans.broker.open(&host, work, &kind, payload).await?;
                humans.broker.pump(&host, cancelled).await?;
            }
            TimelineEvent030::Answer { key, answer } => {
                let work = works
                    .iter()
                    .find(|w| w.key == key)
                    .map(|w| &w.human)
                    .or_else(|| calls.iter().find(|w| w.key == key).map(|w| &w.human))
                    .ok_or_else(|| failure("CORRELATION", "human", "Answer work absent"))?;
                submit_scripted_human030(
                    &host,
                    pool,
                    owner,
                    &humans.broker,
                    work,
                    crate::agsdl_host_human030::HumanAnswer030::Decision {
                        decision: answer,
                        comment: String::new(),
                    },
                    cancelled,
                )
                .await?;
            }
            TimelineEvent030::Running(expected) => {
                let mut actual = works
                    .iter()
                    .map(|w| (w.key.step.clone(), w.key.item.clone()))
                    .chain(
                        calls
                            .iter()
                            .map(|c| (c.key.step.clone(), c.key.item.clone())),
                    )
                    .collect::<Vec<_>>();
                actual.extend(
                    humans
                        .approvals
                        .iter()
                        .map(|a| (a.key.step.clone(), a.key.item.clone())),
                );
                let mut expected = expected
                    .into_iter()
                    .map(|w| (w.step, w.item))
                    .collect::<Vec<_>>();
                actual.sort();
                expected.sort();
                let physical = view.state.activations.iter().filter(|a| a.physical).count();
                if actual != expected
                    || physical != works.len() + calls.len() + humans.approvals.len()
                    || works.iter().any(|work| {
                        !view
                            .state
                            .activations
                            .iter()
                            .any(|a| a.id == work.attempt.work().activation_id && a.physical)
                    })
                {
                    return Err(failure(
                        "CORRELATION",
                        "example",
                        "Running work differs from pinned timeline",
                    ));
                }
            }
            TimelineEvent030::Command { key, receipt } => {
                let matching = calls
                    .iter()
                    .enumerate()
                    .filter(|(_, c)| c.key == key)
                    .map(|(i, _)| i)
                    .collect::<Vec<_>>();
                if matching.len() != 1 || works.iter().any(|w| w.key == key) {
                    return Err(failure(
                        "CORRELATION",
                        "call",
                        "Command timeline work is not unique",
                    ));
                }
                let call = calls.remove(matching[0]);
                call.driver.send(receipt)?;
                let witness = call
                    .result
                    .await
                    .map_err(|_| failure("UNCERTAIN", "call", "Owned call result unavailable"))??;
                if !tasks
                    .cancel_owned(&call.request_id)
                    .await
                    .map_err(|_| failure("UNCERTAIN", "call", "Call parent did not join"))?
                {
                    return Err(failure("CORRELATION", "call", "Call parent is absent"));
                }
                humans.broker.retire(&host, &call.human).await?;
                humans.broker.pump(&host, cancelled).await?;
                joined_calls.insert(witness.attempt().work().activation_id.clone(), witness);
            }
            TimelineEvent030::Work { key, outcome } => {
                if let Some(approval) = humans.approvals.iter().find(|a| a.key == key) {
                    let crate::agsdl_host_scenario030::ExampleResult030::Returned {
                        submit_json,
                        ..
                    } = outcome
                    else {
                        return Err(failure("CORRELATION", "approval", "Approval answer absent"));
                    };
                    let value: serde_json::Value = serde_json::from_str(&submit_json)?;
                    let choice = value["choice"]
                        .as_str()
                        .ok_or_else(|| {
                            failure("CORRELATION", "approval", "Approval choice absent")
                        })?
                        .to_owned();
                    let comment = value["comment"].as_str().unwrap_or("").to_owned();
                    submit_scripted_human030(
                        &host,
                        pool,
                        owner,
                        &humans.broker,
                        &approval.work,
                        crate::agsdl_host_human030::HumanAnswer030::Approval { choice, comment },
                        cancelled,
                    )
                    .await?;
                    continue;
                }
                let matches = works
                    .iter()
                    .enumerate()
                    .filter(|(_, work)| work.key == key)
                    .map(|(i, _)| i)
                    .collect::<Vec<_>>();
                if matches.len() != 1 {
                    return Err(failure(
                        "CORRELATION",
                        "example",
                        "Timeline work is not unique",
                    ));
                }
                let work = works.remove(matches[0]);
                work.send
                    .send(outcome)
                    .map_err(|_| failure("UNCERTAIN", "example", "Owned work mailbox closed"))?;
                let witness = crate::agsdl_host_runtime030::finish_agent_work030(
                    &host,
                    pool,
                    tasks,
                    &work.attempt,
                    cancelled,
                )
                .await?;
                work.result.await.map_err(|_| {
                    failure(
                        "UNCERTAIN",
                        "example",
                        "Owned example completion is unavailable",
                    )
                })??;
                let host = app;
                humans.broker.retire(&host, &work.human).await?;
                humans.broker.pump(&host, cancelled).await?;
                joined.insert(witness.attempt().work().activation_id.clone(), witness);
            }
        }
    }
    let view = quiesce_scenario030(
        app,
        pool,
        config,
        tasks,
        owner,
        &mut humans,
        &mut works,
        &mut calls,
        &joined_calls,
        &joined,
        cancelled,
    )
    .await?;
    if !humans.approvals.is_empty()
        || !works.is_empty()
        || !calls.is_empty()
        || view.state.verdict.is_none()
        || view.state.activations.iter().any(|a| a.physical)
        || view.effects.iter().any(|row| {
            matches!(
                row.get("status").and_then(serde_json::Value::as_str),
                Some("pending" | "uncertain")
            )
        })
    {
        return Err(failure(
            "UNCERTAIN",
            "example",
            "Scenario did not finish physically and durably",
        ));
    }
    Ok(view)
}

/// Synthetic test admission has no external effects. Recheck the captured
/// owner/scope and exact pinned declaration in SQL callers.
pub(crate) fn qualify_synthetic_call030(
    capture: &crate::persistence::start030::StartCapture030,
    effect: &FlowEffect030,
    declaration: &str,
) -> Result<()> {
    let denied = || {
        failure(
            "AUTHORITY",
            "call",
            "Synthetic call is outside native QA capture",
        )
    };
    if effect.identity != capture.identity {
        return Err(denied());
    }
    let private: serde_json::Value = serde_json::from_str(&capture.private_capture_json)?;
    let scope: serde_json::Value =
        serde_json::from_str(private["callScopeJson"].as_str().ok_or_else(denied)?)?;
    scope["root"].as_str().ok_or_else(denied)?;
    if scope["sourceOwner"] != serde_json::to_value(&capture.source.owner)?
        || scope["projectId"].as_str() != Some(&capture.source.owner.project_id)
    {
        return Err(denied());
    }
    let _: serde_json::Value =
        serde_json::from_str(private["callPermissionsJson"].as_str().ok_or_else(denied)?)?;
    let plan: crate::persistence::flow030::FlowPlan030 =
        serde_json::from_str(&capture.compiled_plan_json)?;
    let FlowEffectKind030::Start {
        step: Some(address),
        agent: None,
        ..
    } = &effect.kind
    else {
        return Err(denied());
    };
    if plan
        .steps
        .iter()
        .filter(|s| {
            s.address == *address && s.r#type == "call" && s.declaration_json == declaration
        })
        .count()
        != 1
    {
        return Err(denied());
    }
    let call: serde_json::Value = serde_json::from_str(declaration)?;
    if !(call["command"].is_string() ^ call["mcp"].is_object())
        || !crate::agsdl_host_scenario030::PinnedScenario030::recognizes_document(
            &capture.authored_source,
        )?
    {
        return Err(denied());
    }
    Ok(())
}

impl ExampleAdapter030 {
    pub(crate) fn observe() -> ExampleObservation030 {
        ExampleObservation030 { _private: () }
    }
}

fn expect_kind(decision: &ProtocolDecision030, expected: &str) -> Result<()> {
    let receipt: serde_json::Value = serde_json::from_str(&decision.receipt_json)?;
    if receipt
        .pointer("/decision/kind")
        .and_then(serde_json::Value::as_str)
        != Some(expected)
    {
        return Err(failure(
            "CORRELATION",
            "example",
            "Controller decision differs from the observed example outcome",
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]

impl ExampleObservation030 {
    pub(crate) fn adapter_id(&self) -> &'static str {
        ADAPTER
    }
    pub(crate) fn version(&self) -> &'static str {
        VERSION
    }

    /// Build transport observations from this adapter and the native source
    /// lock. The later 036 writer still obtains and checks actual 03 policy.
    pub(crate) fn registry(
        &self,
        document: &serde_json::Value,
        authored_source: &str,
        source_sha256: &str,
        scope: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        use sha2::{Digest, Sha256};
        if format!("{:x}", Sha256::digest(authored_source.as_bytes())) != source_sha256
            || serde_json::from_str::<serde_json::Value>(authored_source)? != *document
        {
            return Err(failure(
                "CORRELATION",
                "example",
                "Native example source differs",
            ));
        }
        let agents = document
            .get("agents")
            .and_then(serde_json::Value::as_object)
            .ok_or_else(|| failure("CORRELATION", "example", "Example agents are absent"))?;
        if !crate::agsdl_host_scenario030::PinnedScenario030::recognizes_document(authored_source)?
            || agents.is_empty()
            || agents.values().any(|agent| {
                agent.get("harness").and_then(serde_json::Value::as_str) != Some("example")
            })
        {
            return Err(failure(
                "HARNESS_REFUSED",
                "example",
                "Example declarations are outside the pinned QA scenarios",
            ));
        }
        // This module describes the pinned conformance language. Only the
        // separately observed capabilities qualify this in-process QA adapter.
        let module = include_str!("../tests/fixtures/conformance/modules/example/module.json");
        if format!("{:x}", Sha256::digest(module.as_bytes()))
            != "95de087ea2d6a97fe36aabbc6ce0fd262c0831dc3f0aad52e2cc10949381db5f"
        {
            return Err(failure(
                "HARNESS_REFUSED",
                "example",
                "Pinned example module differs",
            ));
        }
        let evidence = serde_json::json!({"adapterId":ADAPTER,"sourceSha256":source_sha256,"kind":"native-example-qa"}).to_string();
        let capabilities = [
            "result-submission",
            "continuity",
            "permission-enforcement",
            "contained-stop",
            "response-attribution",
            "resources",
            "delivery.queue",
            "delivery.steer",
            "instance.new",
            "answer-timeout",
            "planFirst.ask",
            "reviewer.person",
        ]
        .iter()
        .map(|name| {
            let capability_evidence = match *name {
                "delivery.queue" => serde_json::json!({
                    "adapterId":ADAPTER, "sourceSha256":source_sha256,
                    "kind":"host-reducer-queue"
                })
                .to_string(),
                "instance.new" => serde_json::json!({
                    "adapterId":ADAPTER, "sourceSha256":source_sha256,
                    "kind":"native-example-qa", "instance":"fresh-per-work"
                })
                .to_string(),
                _ => evidence.clone(),
            };
            serde_json::json!({"name":name,"support":"native","evidenceJson":capability_evidence})
        })
        .collect::<Vec<_>>();
        let observed = agents.iter().map(|(name, agent)| {
            serde_json::json!({"agentName":name,"agentDeclarationJson":agent.to_string(),"settingsJson":"{}",
                "permissionsJson":serde_json::json!({"requested":agent["permissions"],"authority":"native-03-at-handoff"}).to_string(),
                "scopeJson":scope.to_string(),"evidenceJson":evidence,
                "provenanceJson":serde_json::json!({"sourceSha256":source_sha256,"agent":name}).to_string()})
        }).collect::<Vec<_>>();
        Ok(
            serde_json::json!({"modules":[{"harness":"example","moduleJson":module}],
            "harnesses":[{"harness":"example","version":VERSION,"installation":"available","adapterId":ADAPTER,
                "qualified":true,"capabilities":capabilities,
                "models":[{"name":"in-process-example","efforts":[],"defaultEffort":null}],"defaultModel":"in-process-example"}],
            "agents":observed, "hostCapabilities":[{"name":"call.command","support":"native","evidenceJson":evidence},{"name":"call.mcp","support":"native","evidenceJson":evidence},{"name":"approval","support":"native","evidenceJson":evidence}]}),
        )
    }
}
