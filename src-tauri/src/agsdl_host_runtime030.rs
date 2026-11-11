//! Event-driven 0.3 dispatch. Provider futures and physical joins never run in
//! the supervisor's dispatch pass. The existing controller owns result policy.
use crate::{
    agsdl_host::HostState,
    agsdl_host_dispatch030::{self as dispatch, JoinedOwnedAgent030, SourceOwnership030},
    agsdl_host_flow030::{self as flow, FlowWorkAttempt030, NativeFlowInspection030},
    agsdl_host_work_admission030::{
        prepare_effective_agent_work030, AttestedWorkPolicy030, PolicyLeases030,
        PreparedEffectiveAgentWork030,
    },
    ai::stream_tasks::{OwnedOperation030, StreamTasks},
    config::ConfigManager,
    db::agsdl_execution::{
        dto::{EngineContext, EngineOwner},
        failure,
        flow030::{FlowEffect030, FlowEffectKind030, PrepareRef030, Producer030},
        flow_store030::FlowView030,
        flow_work_protocol030,
        start030::StartCapture030,
        work_protocol030::{NativeCall030, ProtocolDecision030, ProtocolEvent030},
        Result,
    },
};
use futures::{future::BoxFuture, stream::FuturesUnordered, FutureExt, StreamExt};
use serde_json::Value;
use sqlx::{Connection, SqlitePool};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::Manager;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

pub(crate) trait AgentExecutor030: Send + Sync {
    /// Local preparation only. No provider IO while configuration leases live.
    fn prepare(&self, work: PreparedEffectiveAgentWork030) -> Result<AttestedWorkPolicy030>;
    /// Return only after native resources have ended or have been attached to
    /// StreamTasks cleanups. turnEnded is logical, never physical evidence.
    fn run(
        &self,
        work: AgentWork030,
        events: WorkEventSink030,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<()>>;
}

pub(crate) struct AgentWork030 {
    pub attempt: FlowWorkAttempt030,
    pub capture: StartCapture030,
    pub effect: FlowEffect030,
    pub policy: crate::agsdl_permissions::EffectivePolicy,
    pub tasks: StreamTasks,
    pub steer: crate::agsdl_host_steer030::SteerInbox030,
}

pub(crate) type EventWriter030 = Arc<
    dyn Fn(
            FlowWorkAttempt030,
            String,
            Value,
            CancellationToken,
        ) -> BoxFuture<'static, Result<ProtocolDecision030>>
        + Send
        + Sync,
>;

pub(crate) type CompletionPort030 = Arc<
    dyn Fn(
            FlowWorkAttempt030,
            crate::db::agsdl_execution::work_protocol030::CheckRequest030,
            CancellationToken,
        ) -> BoxFuture<'static, Result<Value>>
        + Send
        + Sync,
>;

#[derive(Clone)]
pub(crate) struct EventEmitter030 {
    pub event: EventWriter030,
    pub check: CompletionPort030,
}

/// The host supplies admission and persistence; dispatch only owns the future.
pub(crate) type SteerDeliveryPort030 = Arc<
    dyn Fn(
            FlowEffect030,
            FlowWorkAttempt030,
            crate::agsdl_host_steer030::SteerSender030,
        ) -> BoxFuture<'static, Result<bool>>
        + Send
        + Sync,
>;

/// Bound to one admitted attempt. Adapters cannot forge a physicalEnded event;
/// finish_agent_work030 obtains that fact from the native ownership registry.
#[derive(Clone)]
pub(crate) struct WorkEventSink030 {
    attempt: FlowWorkAttempt030,
    emitter: EventEmitter030,
    sequence: Arc<AtomicU64>,
    serial: Arc<tokio::sync::Mutex<()>>,
}
impl WorkEventSink030 {
    pub(crate) async fn emit(
        &self,
        body: Value,
        cancel: &CancellationToken,
    ) -> Result<ProtocolDecision030> {
        if body.get("kind").and_then(Value::as_str) == Some("physicalEnded") {
            return Err(failure(
                "AUTHORITY",
                "work",
                "Physical end requires a native join",
            ));
        }
        let decision = {
            let _serial = self.serial.lock().await;
            let label = format!("event-{}", self.sequence.fetch_add(1, Ordering::Relaxed));
            (self.emitter.event)(self.attempt.clone(), label, body, cancel.clone()).await?
        };
        if let Some(check) = &decision.check {
            // Effect IO must not hold the event serializer. Stop and machine
            // deadlines need to commit while the owned check is still running.
            let completed =
                (self.emitter.check)(self.attempt.clone(), check.clone(), cancel.clone()).await?;
            return Box::pin(self.emit(completed, cancel)).await;
        }
        Ok(decision)
    }
}

pub(crate) fn native_event_emitter030<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    pool: SqlitePool,
    config: ConfigManager,
    tasks: StreamTasks,
    project: String,
) -> EventEmitter030 {
    let (check_app, check_pool, check_config, check_tasks, check_project) = (
        app.clone(),
        pool.clone(),
        config.clone(),
        tasks.clone(),
        project.clone(),
    );
    EventEmitter030 {
        event: Arc::new(move |attempt, label, body, cancel| {
            let (app, pool, config, tasks, project) = (
                app.clone(),
                pool.clone(),
                config.clone(),
                tasks.clone(),
                project.clone(),
            );
            Box::pin(async move {
                let host = app.state::<HostState>();
                emit_work_event030(
                    &host, &pool, &config, &tasks, &attempt, &project, &label, body, &cancel,
                )
                .await
            })
        }),
        check: Arc::new(move |attempt, check, cancel| {
            let (app, pool, config, tasks, project) = (
                check_app.clone(),
                check_pool.clone(),
                check_config.clone(),
                check_tasks.clone(),
                check_project.clone(),
            );
            Box::pin(async move {
                let host = app.state::<HostState>();
                crate::agsdl_host_completion030::execute(
                    &host, &pool, &config, &tasks, &attempt, &project, &check, &cancel,
                )
                .await
            })
        }),
    }
}

/// Native binding for the port, alongside the existing work-event binding.
/// Delivery must continue independently while the supervisor reads or ticks:
/// its admission lock is released only after the consumer acknowledgment.
fn native_steer_port030<R: tauri::Runtime>(
    app: Option<tauri::AppHandle<R>>,
    pool: SqlitePool,
) -> SteerDeliveryPort030 {
    Arc::new(move |effect, attempt, sender| {
        let (app, pool) = (app.clone(), pool.clone());
        let task = tokio::spawn(async move {
            let app = app.ok_or_else(|| {
                failure("HOST_CAPABILITY", "delivery", "Host application is absent")
            })?;
            let host = app.state::<HostState>();
            let Some(claim) =
                flow::claim_expected(host.flow030(), &host, &pool, &effect.identity, &effect.id)
                    .await?
            else {
                return Ok(true);
            };
            claim.deliver_steer030(&attempt, &sender).await
        });
        Box::pin(async move {
            task.await
                .map_err(|_| failure("UNCERTAIN", "delivery", "Steer task was lost"))?
        })
    })
}

pub(crate) struct StartedAgent030 {
    pub steer: crate::agsdl_host_steer030::SteerSender030,
    pub timeout: CancellationToken,
    pub attempt: FlowWorkAttempt030,
    pub cancel: CancellationToken,
    returned: watch::Receiver<Option<Result<()>>>,
}
impl StartedAgent030 {
    async fn returned(&mut self) -> Result<()> {
        loop {
            if let Some(result) = self.returned.borrow_and_update().clone() {
                return result;
            }
            self.returned
                .changed()
                .await
                .map_err(|_| failure("INTERRUPTED", "work", "Executor completion was lost"))?;
        }
    }
}

/// Prepare outside SQL admission, then release only the acknowledged handoff.
/// The factory records the attempt synchronously; it never waits on an agent.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn start_agent_work030(
    host: &HostState,
    pool: &SqlitePool,
    config: &ConfigManager,
    tasks: &StreamTasks,
    owner: &EngineOwner,
    effect: &FlowEffect030,
    executor: Arc<dyn AgentExecutor030>,
    emitter: EventEmitter030,
    cancel: CancellationToken,
) -> Result<StartedAgent030> {
    let inspection = flow::inspect_run(host.flow030(), host, pool, owner).await?;
    let prepared = prepare_effective_agent_work030(config, &inspection, effect).await?;
    let effective = prepared.policy().clone();
    let policy = executor.prepare(prepared)?;
    let claim = flow::claim_expected(host.flow030(), host, pool, &effect.identity, &effect.id)
        .await?
        .ok_or_else(|| failure("STALE_REFERENCE", "work", "Expected agent start changed"))?;
    if claim.effect() != effect {
        return Err(failure(
            "CORRELATION",
            "work",
            "Claimed agent start differs",
        ));
    }
    let (steer, inbox) = crate::agsdl_host_steer030::channel030();
    let (returned, receiver) = watch::channel(None);
    let mut started = None;
    let work_cancel = cancel.clone();
    let timeout = CancellationToken::new();
    let work_timeout = timeout.clone();
    let effect = effect.clone();
    let tasks_owned = tasks.clone();
    claim
        .handoff_agent(tasks, policy, |attempt| {
            started = Some(attempt.clone());
            let events = WorkEventSink030 {
                attempt: attempt.clone(),
                emitter,
                sequence: Arc::new(AtomicU64::new(0)),
                serial: Default::default(),
            };
            let work = AgentWork030 {
                attempt,
                capture: inspection.capture,
                effect,
                policy: effective,
                tasks: tasks_owned,
                steer: inbox,
            };
            async move {
                let running = executor.run(work, events.clone(), work_cancel.clone());
                tokio::pin!(running);
                let result = tokio::select! {
                    biased;
                    _ = work_timeout.cancelled() => {
                        // This branch runs inside the native owned parent. The
                        // controller records TIMEOUT before provider cleanup.
                        let stopping = events.emit(serde_json::json!({"kind":"stop","reason":"TIMEOUT"}), &CancellationToken::new()).await;
                        work_cancel.cancel();
                        let result = running.await;
                        stopping.and(result)
                    }
                    result = &mut running => result,
                };
                if result.is_err() {
                    if !work_cancel.is_cancelled() {
                        let failure = events
                            .emit(
                                serde_json::json!({"kind":"stop","reason":"AGENT_FAILED"}),
                                &CancellationToken::new(),
                            )
                            .await;
                        if let Err(error) = failure {
                            returned.send_replace(Some(Err(error)));
                            return;
                        }
                    }
                }
                returned.send_replace(Some(Ok(())));
            }
        })
        .await?;
    Ok(StartedAgent030 {
        steer,
        timeout,
        attempt: started
            .ok_or_else(|| failure("INTERRUPTED", "work", "Owned attempt was not constructed"))?,
        cancel,
        returned: receiver,
    })
}

pub(crate) async fn finish_agent_work030(
    host: &HostState,
    pool: &SqlitePool,
    tasks: &StreamTasks,
    attempt: &FlowWorkAttempt030,
    cancel: &CancellationToken,
) -> Result<JoinedOwnedAgent030> {
    let joined = dispatch::join_owned_agent030(tasks, attempt).await?;
    flow_work_protocol030::finish_joined_agent030(host, pool, &joined, cancel).await?;
    Ok(joined)
}

/// Hooks for script mailboxes and optional host executors. The production
/// dispatcher retains ordering, route dispatch and final notifications.
pub(crate) trait EffectDriver030: Send {
    fn before_pass(&mut self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn owns_effect(&self, _id: &str) -> bool {
        false
    }
    fn start_agent(&mut self, effect: FlowEffect030) -> BoxFuture<'_, Result<()>>;
    fn start_host(
        &mut self,
        inspection: NativeFlowInspection030,
        effect: FlowEffect030,
    ) -> BoxFuture<'_, Result<()>>;
    fn steer(&mut self, effect: FlowEffect030) -> BoxFuture<'_, Result<()>>;
    fn stop(&mut self, effect: FlowEffect030) -> BoxFuture<'_, Result<()>>;
    fn source_owner<'a>(
        &'a self,
        reference: &PrepareRef030,
        producer: &Producer030,
    ) -> SourceOwnership030<'a>;
}

pub(crate) fn next_effect030(
    inspection: &NativeFlowInspection030,
    owns: impl Fn(&str) -> bool,
) -> Result<Option<FlowEffect030>> {
    let mut next = None;
    for row in &inspection.flow.effects {
        let effect: FlowEffect030 = serde_json::from_value(
            row.get("effect")
                .cloned()
                .ok_or_else(|| failure("CORRELATION", "effect", "Effect payload is absent"))?,
        )?;
        match row.get("status").and_then(Value::as_str) {
            Some("uncertain") if !owns(&effect.id) => {
                return Err(failure(
                    "INTERRUPTED",
                    "effect",
                    "Claimed effect has no known process owner; it will not be retried",
                ))
            }
            Some("pending")
                if !owns(&effect.id)
                    && crate::db::agsdl_execution::flow_store030::eligible(
                        &inspection.flow.state,
                        &effect,
                    ) =>
            {
                if next.is_none() {
                    next = Some(effect);
                }
            }
            Some("settled")
                if matches!(&effect.kind, FlowEffectKind030::Start { work, .. }
                if inspection.flow.state.activations.iter().any(|a| a.id == work.activation_id && a.physical))
                    && !owns(&effect.id) =>
            {
                return Err(failure(
                    "INTERRUPTED",
                    "work",
                    "Admitted work has no known process owner; it will not be restarted",
                ));
            }
            _ => (),
        }
    }
    Ok(next)
}

pub(crate) async fn drain_effects030(
    host: &HostState,
    pool: &SqlitePool,
    tasks: &StreamTasks,
    owner: &EngineOwner,
    driver: &mut dyn EffectDriver030,
    cancel: &CancellationToken,
) -> Result<FlowView030> {
    // Yield after a bounded batch; the supervisor immediately runs another
    // batch when effects remain, allowing Stop/completions between batches.
    for _ in 0..256 {
        if cancel.is_cancelled() {
            return Err(failure(
                "INTERRUPTED",
                "runtime",
                "Supervisor was cancelled",
            ));
        }
        driver.before_pass().await?;
        let inspection = flow::inspect_run(host.flow030(), host, pool, owner).await?;
        let Some(effect) = next_effect030(&inspection, |id| driver.owns_effect(id))? else {
            return Ok(inspection.flow);
        };
        match &effect.kind {
            FlowEffectKind030::Start { agent: Some(_), .. } => {
                if let Err(error) = driver.start_agent(effect.clone()).await {
                    // Stop can invalidate a pending Start between selection,
                    // local preparation and claim. It did not start a provider.
                    let fresh = flow::inspect_run(host.flow030(), host, pool, owner).await?;
                    let unclaimed =
                        fresh.flow.effects.iter().any(|row| {
                            row["status"] == "pending" && row["effect"]["id"] == effect.id
                        });
                    if !fresh.flow.state.stopping || !unclaimed {
                        return Err(error);
                    }
                }
            }
            FlowEffectKind030::Start { agent: None, .. } => {
                driver.start_host(inspection, effect).await?
            }
            FlowEffectKind030::Steer { .. } => driver.steer(effect).await?,
            FlowEffectKind030::StopWork { .. } => driver.stop(effect).await?,
            FlowEffectKind030::PrepareRoute {
                reference,
                producer,
            } => {
                dispatch::dispatch_source_route030(
                    host,
                    pool,
                    owner,
                    reference,
                    driver.source_owner(reference, producer),
                    cancel,
                )
                .await?;
            }
            FlowEffectKind030::Failure { .. }
            | FlowEffectKind030::Return { .. }
            | FlowEffectKind030::RunEnded { .. } => {
                let claim =
                    flow::claim_expected(host.flow030(), host, pool, &effect.identity, &effect.id)
                        .await?
                        .ok_or_else(|| {
                            failure("STALE_REFERENCE", "effect", "Expected notification changed")
                        })?;
                let request = claim.request_id();
                claim.handoff_host(tasks, async {}).await?;
                if !tasks.cancel_owned(&request).await.map_err(|_| {
                    failure("UNCERTAIN", "effect", "Notification cleanup is unresolved")
                })? {
                    return Err(failure(
                        "INTERRUPTED",
                        "effect",
                        "Notification owner is absent",
                    ));
                }
            }
        }
    }
    flow::inspect_run(host.flow030(), host, pool, owner)
        .await
        .map(|value| value.flow)
}

/// Host extensions must start their work and return promptly. They own their
/// physical completion and wake the registry when native state changes.
pub(crate) trait HostExecutor030<R: tauri::Runtime = tauri::Wry>: Send + Sync {
    fn start(
        &self,
        app: tauri::AppHandle<R>,
        inspection: NativeFlowInspection030,
        effect: FlowEffect030,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<Option<crate::agsdl_host_call_executor030::StartedCall030>>>;
}
pub(crate) trait RuntimeClock030: Send + Sync {
    fn tracks_humans(&self) -> bool {
        false
    }
    fn tick(&self) -> BoxFuture<'_, Result<()>>;
    fn next_wake(&self) -> BoxFuture<'_, Result<Option<std::time::Duration>>>;
}
pub(crate) struct Executors030<R: tauri::Runtime = tauri::Wry> {
    pub agents: Arc<dyn AgentExecutor030>,
    pub calls: Option<Arc<dyn HostExecutor030<R>>>,
    pub humans: Option<Arc<dyn HostExecutor030<R>>>,
    pub clock: Option<Arc<dyn RuntimeClock030>>,
}

#[cfg(test)]
pub(crate) struct TestAgentExecutor030(pub Arc<dyn AgentExecutor030>);

struct SupervisorHandle030 {
    wake: watch::Sender<u64>,
    cancel: CancellationToken,
    task: Option<tokio::task::JoinHandle<()>>,
    outcome: Option<Result<()>>,
}
#[derive(Default)]
pub(crate) struct RuntimeRegistry030(Mutex<BTreeMap<String, SupervisorHandle030>>);
impl RuntimeRegistry030 {
    pub(crate) fn is_registered(&self, system: &str) -> Result<bool> {
        self.0
            .lock()
            .map(|handles| handles.contains_key(system))
            .map_err(|_| {
                failure(
                    "RUNTIME_UNAVAILABLE",
                    "runtime",
                    "Supervisor registry is unavailable",
                )
            })
    }
    pub(crate) fn reserve(&self, system: &str) -> Result<()> {
        let mut handles = self.0.lock().map_err(|_| {
            failure(
                "RUNTIME_UNAVAILABLE",
                "runtime",
                "Supervisor registry is unavailable",
            )
        })?;
        if handles.contains_key(system) {
            return Err(failure(
                "CORRELATION",
                "runtime",
                "Run already has a supervisor",
            ));
        }
        let (wake, _) = watch::channel(0);
        handles.insert(
            system.into(),
            SupervisorHandle030 {
                wake,
                cancel: CancellationToken::new(),
                task: None,
                outcome: None,
            },
        );
        Ok(())
    }
    pub(crate) fn fail_reservation(
        &self,
        system: &str,
        error: crate::db::agsdl_execution::dto::EngineFailure,
    ) {
        if let Ok(mut handles) = self.0.lock() {
            if let Some(handle) = handles.get_mut(system) {
                if handle.task.is_none() && handle.outcome.is_none() {
                    handle.outcome = Some(Err(error));
                    handle
                        .wake
                        .send_modify(|revision| *revision = revision.wrapping_add(1));
                }
            }
        }
    }
    pub(crate) fn wake(&self, system: &str) {
        if let Ok(handles) = self.0.lock() {
            if let Some(handle) = handles.get(system) {
                handle
                    .wake
                    .send_modify(|revision| *revision = revision.wrapping_add(1));
            }
        }
    }
    pub(crate) fn cancel(&self, system: &str) {
        if let Ok(handles) = self.0.lock() {
            if let Some(handle) = handles.get(system) {
                handle.cancel.cancel();
            }
        }
    }
    pub(crate) async fn wait(&self, system: &str) -> Result<()> {
        let mut wake = {
            let handles = self.0.lock().map_err(|_| {
                failure(
                    "RUNTIME_UNAVAILABLE",
                    "runtime",
                    "Supervisor registry is unavailable",
                )
            })?;
            handles
                .get(system)
                .ok_or_else(|| {
                    failure(
                        "RUNTIME_UNAVAILABLE",
                        "runtime",
                        "Run supervisor is unavailable",
                    )
                })?
                .wake
                .subscribe()
        };
        loop {
            wake.borrow_and_update();
            if let Some(outcome) = self.outcome(system) {
                return outcome;
            }
            wake.changed()
                .await
                .map_err(|_| failure("INTERRUPTED", "runtime", "Supervisor wake channel closed"))?;
        }
    }
    pub(crate) fn outcome(&self, system: &str) -> Option<Result<()>> {
        self.0.lock().ok()?.get(system)?.outcome.clone()
    }
}

struct LiveAgent030 {
    steer: crate::agsdl_host_steer030::SteerSender030,
    timeout: CancellationToken,
    attempt: FlowWorkAttempt030,
    cancel: CancellationToken,
    stop: Option<(String, flow::ClaimedStopWork030)>,
}
struct NativeDriver030<'a, R: tauri::Runtime> {
    app: Option<&'a tauri::AppHandle<R>>,
    emitter: Arc<dyn Fn(String) -> EventEmitter030 + Send + Sync>,
    host: &'a HostState,
    pool: &'a SqlitePool,
    config: &'a ConfigManager,
    tasks: &'a StreamTasks,
    owner: &'a EngineOwner,
    executors: &'a Executors030<R>,
    active: BTreeMap<String, LiveAgent030>,
    joining: FuturesUnordered<BoxFuture<'a, (String, Result<JoinedOwnedAgent030>)>>,
    joined: BTreeMap<String, JoinedOwnedAgent030>,
    ready: BTreeMap<String, JoinedOwnedAgent030>,
    approvals: BTreeMap<String, String>,
    calls: BTreeMap<String, (CancellationToken, String, CancellationToken)>,
    call_joins: FuturesUnordered<
        BoxFuture<
            'a,
            (
                String,
                Result<Option<crate::agsdl_host_calls030::JoinedCall030>>,
            ),
        >,
    >,
    joined_calls: BTreeMap<String, crate::agsdl_host_calls030::JoinedCall030>,
    steer_delivery: SteerDeliveryPort030,
    steering: FuturesUnordered<BoxFuture<'a, (String, Result<bool>)>>,
    in_flight: BTreeSet<String>,
}
impl<R: tauri::Runtime> EffectDriver030 for NativeDriver030<'_, R> {
    fn before_pass(&mut self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let Some(clock) = &self.executors.clock else {
                return Ok(());
            };
            let view =
                flow::inspect_run(self.host.flow030(), self.host, self.pool, self.owner).await?;
            if view.flow.state.stopping || view.flow.state.verdict.is_some() {
                return Ok(());
            }
            if !clock.tracks_humans() {
                return Ok(());
            }
            clock.tick().await?;
            let fresh =
                flow::inspect_run(self.host.flow030(), self.host, self.pool, self.owner).await?;
            for (work, effect) in self.approvals.clone() {
                if fresh
                    .flow
                    .state
                    .activations
                    .iter()
                    .any(|a| a.id == work && !a.physical)
                {
                    self.approvals.remove(&work);
                    self.in_flight.remove(&effect);
                }
            }
            let broker = self
                .host
                .flow030()
                .humans
                .broker(self.host, self.pool, &view.capture.identity)
                .await?;
            for control in broker.timeout_controls().await? {
                if let Some(live) = self.active.get(&control.work_id().to_owned()) {
                    live.timeout.cancel();
                } else if let Some((_, _, timeout)) = self.calls.get(control.work_id()) {
                    timeout.cancel();
                }
            }
            Ok(())
        })
    }

    fn owns_effect(&self, id: &str) -> bool {
        self.in_flight.contains(id)
    }
    fn start_agent(&mut self, effect: FlowEffect030) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let inspection =
                flow::inspect_run(self.host.flow030(), self.host, self.pool, self.owner).await?;
            let emitter = (self.emitter)(inspection.capture.source.owner.project_id);
            let mut started = start_agent_work030(
                self.host,
                self.pool,
                self.config,
                self.tasks,
                self.owner,
                &effect,
                self.executors.agents.clone(),
                emitter,
                CancellationToken::new(),
            )
            .await?;
            if self
                .executors
                .clock
                .as_ref()
                .is_some_and(|clock| clock.tracks_humans())
            {
                let broker = self
                    .host
                    .flow030()
                    .humans
                    .broker(self.host, self.pool, &inspection.capture.identity)
                    .await?;
                let _operation = broker.operation.lock().await;
                let admitted = async {
                    broker.admit_agent(self.host, &started.attempt).await?;
                    broker.pump(self.host, &CancellationToken::new()).await?;
                    Ok::<_, crate::db::agsdl_execution::dto::EngineFailure>(())
                }
                .await;
                if let Err(error) = admitted {
                    let fresh =
                        flow::inspect_run(self.host.flow030(), self.host, self.pool, self.owner)
                            .await?;
                    if !fresh.flow.state.stopping {
                        return Err(error);
                    }
                }
            }
            let key = started.attempt.work().activation_id.clone();
            self.in_flight.insert(effect.id.clone());
            self.active.insert(
                key.clone(),
                LiveAgent030 {
                    steer: started.steer.clone(),
                    timeout: started.timeout.clone(),
                    attempt: started.attempt.clone(),
                    cancel: started.cancel.clone(),
                    stop: None,
                },
            );
            let tasks = self.tasks;
            self.joining.push(Box::pin(async move {
                // Even executor errors do not bypass the physical join.
                let result = started.returned().await;
                let joined = dispatch::join_owned_agent030(tasks, &started.attempt).await;
                (
                    key,
                    match joined {
                        Ok(joined) => result.map(|_| joined),
                        Err(error) => Err(error),
                    },
                )
            }));
            Ok(())
        })
    }
    fn start_host(
        &mut self,
        inspection: NativeFlowInspection030,
        effect: FlowEffect030,
    ) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let plan: crate::db::agsdl_execution::flow030::FlowPlan030 =
                serde_json::from_str(&inspection.capture.compiled_plan_json)?;
            let approval = matches!(&effect.kind, FlowEffectKind030::Start {step:Some(step),..} if plan.steps.iter().any(|s| s.address == *step && s.r#type == "approval"));
            let executor = if approval {
                &self.executors.humans
            } else {
                &self.executors.calls
            };
            let started = executor
                .as_ref()
                .ok_or_else(|| {
                    failure(
                        "HOST_CAPABILITY",
                        if approval { "approval" } else { "call" },
                        "This host executor is not connected",
                    )
                })?
                .start(
                    self.app
                        .ok_or_else(|| {
                            failure("HOST_CAPABILITY", "host", "Host application is absent")
                        })?
                        .clone(),
                    inspection,
                    effect.clone(),
                    CancellationToken::new(),
                )
                .await?;
            if approval {
                if let FlowEffectKind030::Start { work, .. } = &effect.kind {
                    self.approvals
                        .insert(work.activation_id.clone(), effect.id.clone());
                    self.in_flight.insert(effect.id.clone());
                }
            }
            if let Some(started) = started {
                let key = started.attempt.work().activation_id.clone();
                self.in_flight.insert(started.attempt.effect().id.clone());
                self.calls.insert(
                    key.clone(),
                    (
                        started.cancel,
                        started.attempt.effect().id.clone(),
                        started.timeout,
                    ),
                );
                let tasks = self.tasks;
                self.call_joins.push(Box::pin(async move {
                    let result = started
                        .result
                        .await
                        .map_err(|_| {
                            failure("INTERRUPTED", "call", "Call owner ended without a result")
                        })
                        .and_then(|r| r);
                    let cleanup = tasks.cancel_owned(&started.request_id).await;
                    (
                        key,
                        match cleanup {
                            Ok(true) => result,
                            _ => Err(failure(
                                "UNCERTAIN",
                                "call",
                                "Call ownership cleanup did not complete",
                            )),
                        },
                    )
                }));
            }
            Ok(())
        })
    }
    fn steer(&mut self, effect: FlowEffect030) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let FlowEffectKind030::Steer { work, .. } = &effect.kind else {
                unreachable!()
            };
            let live = self.active.get(&work.activation_id).ok_or_else(|| {
                failure("INTERRUPTED", "delivery", "Steer recipient has no owner")
            })?;
            // The adapter has already observed the end. Let its terminal event
            // settle before claiming any offer that can no longer be sent.
            if live.steer.is_closed() {
                self.in_flight.insert(effect.id);
                return Ok(());
            }
            let future =
                (self.steer_delivery)(effect.clone(), live.attempt.clone(), live.steer.clone());
            let id = effect.id;
            self.in_flight.insert(id.clone());
            self.steering
                .push(Box::pin(async move { (id, future.await) }));
            Ok(())
        })
    }
    fn stop(&mut self, effect: FlowEffect030) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let FlowEffectKind030::StopWork { work, .. } = &effect.kind else {
                unreachable!()
            };
            if let Some((cancel, _, _)) = self.calls.get(&work.activation_id) {
                let claim = flow::claim_expected(
                    self.host.flow030(),
                    self.host,
                    self.pool,
                    &effect.identity,
                    &effect.id,
                )
                .await?
                .ok_or_else(|| failure("STALE_REFERENCE", "call", "Call stop changed"))?;
                let request = claim.request_id();
                claim.handoff_host(self.tasks, async {}).await?;
                self.tasks
                    .cancel_owned(&request)
                    .await
                    .map_err(|_| failure("UNCERTAIN", "call", "Call stop handoff failed"))?;
                cancel.cancel();
                return Ok(());
            }
            if self.executors.humans.is_some() && work.agent_instance_id.is_none() {
                let claim = flow::claim_expected(
                    self.host.flow030(),
                    self.host,
                    self.pool,
                    &effect.identity,
                    &effect.id,
                )
                .await?
                .ok_or_else(|| failure("STALE_REFERENCE", "approval", "Approval stop changed"))?;
                let request = claim.request_id();
                claim.handoff_host(self.tasks, async {}).await?;
                self.tasks
                    .cancel_owned(&request)
                    .await
                    .map_err(|_| failure("UNCERTAIN", "approval", "Stop owner did not join"))?;
                let parent = format!(
                    "flow030:{}:{}",
                    effect.identity.system_start_id, work.start_effect_id
                );
                if !self
                    .tasks
                    .cancel_owned(&parent)
                    .await
                    .map_err(|_| failure("UNCERTAIN", "approval", "Approval owner did not join"))?
                {
                    return Err(failure("INTERRUPTED", "approval", "Approval owner absent"));
                }
                let lease = self.host.start_lease().await?;
                let control = self
                    .host
                    .flow030()
                    .retiring_controls(lease.generation())?
                    .into_iter()
                    .find(|control| control.identity() == &effect.identity)
                    .ok_or_else(|| failure("INTERRUPTED", "approval", "Flow owner absent"))?;
                drop(lease);
                let view = control.read(self.pool).await?;
                control.apply(self.pool, &crate::db::agsdl_execution::flow030::FlowEvent030 {
                    identity: effect.identity.clone(), event_id: format!("approval-stop:{}", effect.id), expected_revision: view.state.revision,
                    kind: crate::db::agsdl_execution::flow030::FlowEventKind030::PhysicalEnded {
                        work: work.clone(), stop_effect_id: Some(effect.id.clone()),
                        evidence: crate::db::agsdl_execution::flow030::PhysicalEvidence030 { native_receipt_id: parent, descendants_joined: true },
                    },
                }).await?;
                return Ok(());
            }
            let Some(live) = self.active.get_mut(&work.activation_id) else {
                let lease = self.host.start_lease().await?;
                let control = self
                    .host
                    .flow030()
                    .retiring_controls(lease.generation())?
                    .into_iter()
                    .find(|control| control.identity() == &effect.identity)
                    .ok_or_else(|| {
                        failure("INTERRUPTED", "work", "Stopped run has no process owner")
                    })?;
                drop(lease);
                return control
                    .settle_unadmitted(self.host.flow030(), self.pool, work)
                    .await?
                    .map(|_| ())
                    .ok_or_else(|| {
                        failure(
                            "INTERRUPTED",
                            "work",
                            "Stopped work has no known owner or unadmitted start",
                        )
                    });
            };
            let claim = flow::claim_expected_stop_work(
                self.host.flow030(),
                self.host,
                self.pool,
                &effect,
                &live.attempt,
            )
            .await?
            .ok_or_else(|| failure("STALE_REFERENCE", "stop", "Stop effect changed"))?;
            live.stop = Some((effect.id.clone(), claim.into_stop_work(&live.attempt)?));
            self.in_flight.insert(effect.id);
            // Cooperative cancellation keeps the resource owner alive until
            // the executor has terminated its process group and cleanups.
            live.cancel.cancel();
            Ok(())
        })
    }
    fn source_owner<'a>(
        &'a self,
        reference: &PrepareRef030,
        producer: &Producer030,
    ) -> SourceOwnership030<'a> {
        if let Some(joined) = self.joined_calls.get(&reference.activation_id) {
            SourceOwnership030::Call(joined)
        } else if ["approval", "compose", "call"].contains(&producer.kind.as_str()) {
            SourceOwnership030::Host
        } else {
            self.joined
                .get(&reference.activation_id)
                .map_or(SourceOwnership030::Join, SourceOwnership030::Agent)
        }
    }
}

/// Called by the start integration in lot 1.5. Registration precedes both the
/// first revision read and the spawn, so concurrent validated events persist.
pub(crate) fn spawn_supervisor030<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    pool: SqlitePool,
    config: ConfigManager,
    tasks: StreamTasks,
    owner: EngineOwner,
    executors: Executors030<R>,
) -> Result<()> {
    let host = app.state::<HostState>();
    let mut handles = host.flow030().supervisors.0.lock().map_err(|_| {
        failure(
            "RUNTIME_UNAVAILABLE",
            "runtime",
            "Supervisor registry is unavailable",
        )
    })?;
    let handle = handles.get_mut(&owner.system_start_id).ok_or_else(|| {
        failure(
            "RUNTIME_UNAVAILABLE",
            "runtime",
            "Supervisor reservation is unavailable",
        )
    })?;
    if handle.task.is_some() || handle.outcome.is_some() {
        return Err(failure(
            "CORRELATION",
            "runtime",
            "Run already has a supervisor",
        ));
    }
    let receiver = handle.wake.subscribe();
    let cancel = handle.cancel.clone();
    let (task_app, system, task_cancel) =
        (app.clone(), owner.system_start_id.clone(), cancel.clone());
    let task = tokio::spawn(async move {
        let host = task_app.state::<HostState>();
        let outcome = supervise030(
            &task_app,
            &host,
            &pool,
            &config,
            &tasks,
            &owner,
            &executors,
            receiver,
            &task_cancel,
        )
        .await;
        if outcome.is_err() {
            if let Err(error) = flow::interrupt_run030(&pool, &system).await {
                tracing::error!("Failed to mark interrupted execution: {}", error.message);
            }
        }
        if let Ok(mut handles) = host.flow030().supervisors.0.lock() {
            if let Some(handle) = handles.get_mut(&system) {
                handle.outcome = Some(outcome);
                handle.task = None;
                handle
                    .wake
                    .send_modify(|revision| *revision = revision.wrapping_add(1));
            }
        };
    });
    handle.task = Some(task);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn supervise030<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    host: &HostState,
    pool: &SqlitePool,
    config: &ConfigManager,
    tasks: &StreamTasks,
    owner: &EngineOwner,
    executors: &Executors030<R>,
    wake: watch::Receiver<u64>,
    cancel: &CancellationToken,
) -> Result<()> {
    let event_app = app.clone();
    let (event_pool, event_config, event_tasks) = (pool.clone(), config.clone(), tasks.clone());
    let emitter = Arc::new(move |project| {
        native_event_emitter030(
            event_app.clone(),
            event_pool.clone(),
            event_config.clone(),
            event_tasks.clone(),
            project,
        )
    });
    supervise_with_emitter030(
        Some(app),
        host,
        pool,
        config,
        tasks,
        owner,
        executors,
        wake,
        cancel,
        emitter,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn supervise_with_emitter030<R: tauri::Runtime>(
    app: Option<&tauri::AppHandle<R>>,
    host: &HostState,
    pool: &SqlitePool,
    config: &ConfigManager,
    tasks: &StreamTasks,
    owner: &EngineOwner,
    executors: &Executors030<R>,
    mut wake: watch::Receiver<u64>,
    cancel: &CancellationToken,
    emitter: Arc<dyn Fn(String) -> EventEmitter030 + Send + Sync>,
) -> Result<()> {
    let mut driver = NativeDriver030 {
        app,
        emitter,
        host,
        pool,
        config,
        tasks,
        owner,
        executors,
        active: BTreeMap::new(),
        joining: FuturesUnordered::new(),
        joined: BTreeMap::new(),
        ready: BTreeMap::new(),
        approvals: BTreeMap::new(),
        calls: BTreeMap::new(),
        call_joins: FuturesUnordered::new(),
        joined_calls: BTreeMap::new(),
        steer_delivery: native_steer_port030(app.cloned(), pool.clone()),
        steering: FuturesUnordered::new(),
        in_flight: BTreeSet::new(),
    };
    // Keep the driver outside the unwind boundary so panic follows the same
    // cooperative cancellation and physical joins as an ordinary dispatch error.
    let outcome = std::panic::AssertUnwindSafe(async {
    loop {
        // Subscribe/mark observed BEFORE reading state. A wake during the read
        // remains unseen and changed() returns immediately on the next select.
        wake.borrow_and_update();
        let view = drain_effects030(
            host,
            pool,
            tasks,
            owner,
            &mut driver,
            &CancellationToken::new(),
        )
        .await?;
        let mut completed = false;
        for key in driver.ready.keys().cloned().collect::<Vec<_>>() {
            let joined = driver.ready.get(&key).unwrap().clone();
            let live = driver.active.get(&key).ok_or_else(|| failure("CORRELATION", "work", "Completed owner is absent"))?;
            if let Some((_, stop)) = &live.stop {
                stop.control().settle_joined_diagnostic(host.flow030(), pool, &joined, Some(stop)).await?;
            } else {
                let result = flow_work_protocol030::finish_joined_agent030(host, pool, &joined, &CancellationToken::new()).await;
                let fresh = flow::inspect_run(host.flow030(), host, pool, owner).await?;
                let physical = fresh.flow.state.activations.iter().any(|a| a.id == key && a.physical);
                if physical && fresh.flow.state.activations.iter().any(|a| a.id == key && a.stop_effect_id.is_some()) {
                    // Keep the exact join and owner. The next pass claims and
                    // settles StopWork even when Stop won during evaluation.
                    completed = true;
                    continue;
                }
                result?;
                if physical { return Err(failure("UNCERTAIN", "work", "Joined work has no terminal controller result")); }
            }
            if executors.clock.as_ref().is_some_and(|clock| clock.tracks_humans()) && live.stop.is_none() {
                let broker = host.flow030().humans.broker(host, pool, joined.attempt().identity()).await?;
                let _operation = broker.operation.lock().await;
                let fresh=flow::inspect_run(host.flow030(),host,pool,owner).await?;
                if !fresh.flow.state.stopping {broker.retire_finished(host, &key).await?;}
            }
            let live = driver.active.remove(&key).unwrap();
            driver.in_flight.remove(live.attempt.start_effect_id());
            if let Some((effect, _)) = live.stop { driver.in_flight.remove(&effect); }
            driver.ready.remove(&key);
            driver.joined.insert(key, joined);
            completed = true;
        }
        if completed { continue; }
        if view.state.verdict.is_some() && driver.active.is_empty() && driver.calls.is_empty() && driver.steering.is_empty() {
            return Ok(());
        }
        if cancel.is_cancelled() {
            for live in driver.active.values() {
                live.cancel.cancel();
            }
            for (cancel, _, _) in driver.calls.values() { cancel.cancel(); }
            return Err(failure(
                "INTERRUPTED",
                "runtime",
                "Supervisor was cancelled after physical cleanup",
            ));
        }
        if view.effects.iter().any(|row| {
            row["status"] == "pending"
                && serde_json::from_value::<FlowEffect030>(row["effect"].clone()).is_ok_and(
                    |effect| {
                        !driver.in_flight.contains(&effect.id) && crate::db::agsdl_execution::flow_store030::eligible(&view.state, &effect)
                    },
                )
        }) {
            tokio::task::yield_now().await;
            continue;
        }
        let deadline = match &executors.clock {
            Some(clock) => clock.next_wake().await?,
            None => None,
        };
        tokio::select! {
            _ = cancel.cancelled() => (),
            changed = wake.changed() => { changed.map_err(|_| failure("INTERRUPTED", "runtime", "Supervisor wake channel closed"))?; },
            Some((id, result)) = driver.steering.next(), if !driver.steering.is_empty() => {
                if result? { driver.in_flight.remove(&id); }
            },
            Some((key, joined)) = driver.call_joins.next(), if !driver.call_joins.is_empty() => {
                if let Some(joined) = joined? {
                    let authority = crate::agsdl_host_call_authority030::NativeCallAuthority030::capture(host, owner).await?;
                    let broker = host.start_lease().await?.call_data030()?;
                    match crate::agsdl_host_calls030::finish_joined_call030(pool, &authority, &broker, &joined, &CancellationToken::new()).await? {
                        crate::agsdl_host_calls030::CallSettlement030::Terminal { .. } => (),
                        _ => return Err(failure("UNCERTAIN", "call", "Call completion has a diagnostic")),
                    }
                    if executors.clock.as_ref().is_some_and(|clock| clock.tracks_humans()) {
                        let view = flow::inspect_run(host.flow030(), host, pool, owner).await?;
                        if !view.flow.state.stopping {
                            let broker = host.flow030().humans.broker(host, pool, &view.capture.identity).await?;
                            let _operation = broker.operation.lock().await;
                            broker.retire_finished(host, &key).await?;
                        }
                    }
                    driver.joined_calls.insert(key.clone(), joined);
                }
                if let Some((_, effect, _)) = driver.calls.remove(&key) { driver.in_flight.remove(&effect); }
            },
            Some((key, joined)) = driver.joining.next(), if !driver.joining.is_empty() => {
                driver.ready.insert(key, joined?);
            },
            _ = async { if let Some(duration) = deadline { tokio::time::sleep(duration).await; } else { std::future::pending::<()>().await; } } => {
                // The next dispatch pass arbitrates deadlines and joins.
            },
            // Safety net for native writers not yet wired to wake in lot 1.5.
            _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => (),
        }
    }
    }).catch_unwind().await.unwrap_or_else(|_| Err(failure(
        "INTERRUPTED", "runtime", "Supervisor panicked before physical cleanup",
    )));
    for live in driver.active.values() {
        live.cancel.cancel();
    }
    for (cancel, _, _) in driver.calls.values() {
        cancel.cancel();
    }
    let mut cleanup_error = None;
    for effect in driver.approvals.values() {
        let parent = format!("flow030:{}:{}", owner.system_start_id, effect);
        if tasks.cancel_owned(&parent).await.is_err() {
            cleanup_error.get_or_insert(failure(
                "UNCERTAIN",
                "approval",
                "Approval cleanup failed",
            ));
        }
    }
    while let Some((_, result)) = driver.call_joins.next().await {
        if let Err(error) = result {
            cleanup_error.get_or_insert(error);
        }
    }
    while let Some((_, result)) = driver.joining.next().await {
        if let Err(error) = result {
            cleanup_error.get_or_insert(error);
        }
    }
    while let Some((_, result)) = driver.steering.next().await {
        if let Err(error) = result {
            cleanup_error.get_or_insert(error);
        }
    }
    if let Some(error) = cleanup_error {
        return Err(error);
    }
    outcome
}

pub(crate) async fn emit_work_event030(
    host: &HostState,
    pool: &SqlitePool,
    config: &ConfigManager,
    tasks: &StreamTasks,
    attempt: &FlowWorkAttempt030,
    project_id: &str,
    label: &str,
    body: serde_json::Value,
    cancelled: &CancellationToken,
) -> Result<ProtocolDecision030> {
    let policies = PolicyLeases030::acquire(config, project_id).await?;
    let lease = host.start_lease().await?;
    let gate = host.admission_lock().lock_owned().await;
    host.flow030().available(attempt.identity())?;
    let parent = format!(
        "flow030:{}:{}",
        attempt.identity().system_start_id,
        attempt.start_effect_id()
    );
    tasks
        .verify_agent_scope030(&parent, attempt)
        .map_err(|_| failure("AUTHORITY", "work", "Owned agent parent is unavailable"))?;
    let mut db = pool.acquire().await?;
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    let raw_context: String = sqlx::query_scalar("SELECT context_json FROM engine_flow030_work_admissions WHERE system_id=? AND invocation_id=? AND activation_id=?")
        .bind(&attempt.identity().system_start_id).bind(&attempt.identity().flow_invocation_id)
        .bind(&attempt.work().activation_id).fetch_one(&mut *tx).await?;
    let context: EngineContext = serde_json::from_str(&raw_context)?;
    let revision: Option<String> = sqlx::query_scalar("SELECT revision FROM engine_flow030_work_state WHERE system_id=? AND invocation_id=? AND activation_id=?")
        .bind(&attempt.identity().system_start_id).bind(&attempt.identity().flow_invocation_id)
        .bind(&attempt.work().activation_id).fetch_optional(&mut *tx).await?;
    let event_id = format!("work:{}:{}", attempt.provider_attempt_id(), label);
    let event_json = serde_json::json!({"eventId":event_id,"owner":{
        "systemStartId":attempt.work().system_start_id,"activationId":attempt.work().activation_id,
        "agentInstanceId":attempt.work().agent_instance_id,"ownerEpoch":attempt.owner().owner_epoch},"event":body}).to_string();
    let input = ProtocolEvent030 {
        context: context.clone(),
        event_id: event_id.clone(),
        expected_revision: revision.unwrap_or_else(|| "0".into()),
        event_json: event_json.clone(),
        native_call: Some(NativeCall030 {
            provider_attempt_id: attempt.provider_attempt_id().into(),
            native_call_id: event_id.clone(),
        }),
        control: false,
    };
    let operation = OwnedOperation030 {
        identity: attempt.identity().clone(),
        context,
        generation: attempt.generation().into(),
        agent: attempt.agent().into(),
        provider_attempt_id: attempt.provider_attempt_id().into(),
        operation_id: event_id,
        method: "agent/event".into(),
        request_json: event_json,
    };
    lease.ensure_live()?;
    tx.rollback().await?;
    let permit = lease.attach_owned_operation030(tasks, &parent, operation)?;
    drop(db);
    drop(gate);
    drop(lease);
    flow_work_protocol030::transition_owned_agent030(
        host, pool, attempt, &input, permit, policies, cancelled,
    )
    .await
}

#[cfg(test)]
mod attachment_tests {
    use super::*;

    #[tokio::test]
    async fn stop_waits_for_a_reserved_supervisor_and_observes_attachment_failure() {
        let registry = Arc::new(RuntimeRegistry030::default());
        registry.reserve("run").unwrap();
        let waiting = {
            let registry = registry.clone();
            tokio::spawn(async move { registry.wait("run").await })
        };
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        registry.fail_reservation(
            "run",
            failure("INTERRUPTED", "runtime", "attachment failed"),
        );
        assert_eq!(waiting.await.unwrap().unwrap_err().code, "INTERRUPTED");
    }
}
