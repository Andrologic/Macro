//! Native 0.3 flow ownership and durable dispatch. None of these operations is IPC.
//! Callers obtain a native lifecycle lease before the shared admission gate.
use crate::agsdl_host::{HostStartLease, HostState};
use crate::agsdl_host_capture::{self as capture, CompilationCapture};
use crate::agsdl_host_dispatch030::JoinedOwnedAgent030;
use crate::agsdl_host_route_attestations030::{AttestedRouteSource030, RouteSourceCommitMarker030};
use crate::agsdl_host_work_admission030::{self as work_admission, AttestedWorkPolicy030};
use crate::config::ConfigManager;
use crate::db::agsdl_execution::{
    self as repository,
    dto::{EngineOwner, EngineStartRequest, EngineStopRequest},
    failure,
    flow030::{
        DeliveryOccurrence030, Failure030, FlowEffect030, FlowEffectKind030, FlowEvent030,
        FlowEventKind030, FlowIdentity030, FlowReceipt030, FlowState030, PhysicalEvidence030,
        PrepareRef030, PreparedBatch030, PreparedResult030, Producer030, WorkRef030,
    },
    flow_store030::{self, Apply030, Authority030, CheckFuture, FlowView030, StoreError030},
    flow_work_protocol030::AcceptedWorkTerminal030,
    intents::{ExecutionIntentScope, IntentAdmissionLink},
    start030::{self, RetainedStart030, StartAuthority030, StartCapture030, StartInspection030},
    Result,
};
use crate::workspace::architect::{
    lock_execution_intent_scope, lock_execution_source_owner, LockedExecutionSource,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row, SqliteConnection, SqlitePool};
use std::{
    collections::BTreeMap,
    future::Future,
    path::Path,
    sync::{Arc, Mutex},
};
use tokio::sync::OwnedMutexGuard;

/// Process-local exclusion for a Start whose COMMIT has not been acknowledged.
/// A missing response never authorizes a second physical effect.
#[derive(Default)]
pub(crate) struct FlowHost030 {
    committing: Mutex<BTreeMap<String, FlowIdentity030>>,
    pub(crate) call_commits: crate::agsdl_host_calls030::CallCommitFence030,
    event_committing: Mutex<BTreeMap<(String, String), FlowEvent030>>,
    work_committing: Mutex<BTreeMap<(String, String), FlowWorkCommitMarker030>>,
    route_source_committing: Mutex<BTreeMap<(String, String), RouteSourceCommitMarker030>>,
    unadmitted: Mutex<BTreeMap<(String, String), Unadmitted030>>,
    controls: Mutex<BTreeMap<String, Arc<FlowControl030>>>,
    joined_diagnostics: Mutex<BTreeMap<(String, String, String), JoinedOwnedAgent030>>,
    #[cfg(test)]
    stop_commit_hooks: Mutex<BTreeMap<String, Arc<CommitTestHook030>>>,
    #[cfg(test)]
    work_commit_hooks: Mutex<BTreeMap<(String, String), Arc<CommitTestHook030>>>,
    #[cfg(test)]
    handoff_commit_hooks: Mutex<BTreeMap<(String, String), Arc<CommitTestHook030>>>,
}

/// Correlates an authenticated work decision's COMMIT, without authorizing any
/// effect. Only native persistence constructs it; it is never an IPC payload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FlowWorkCommitMarker030 {
    identity: FlowIdentity030,
    event_id: String,
    ticket_sha256: String,
    decision_sha256: String,
}
impl FlowWorkCommitMarker030 {
    pub(crate) fn identity(&self) -> &FlowIdentity030 {
        &self.identity
    }
    pub(crate) fn event_id(&self) -> &str {
        &self.event_id
    }
    pub(crate) fn ticket_sha256(&self) -> &str {
        &self.ticket_sha256
    }
    pub(crate) fn decision_sha256(&self) -> &str {
        &self.decision_sha256
    }
}

/// Native attribution for one claimed agent Start and its owned parent. It
/// carries no permission grant and cannot be reconstructed from wire JSON.
/// Only DispatchLease030 mints it from the authenticated durable effect.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlowWorkAttempt030 {
    identity: FlowIdentity030,
    owner: EngineOwner,
    generation: String,
    work: repository::dto::EngineWork,
    start_effect_id: String,
    agent: String,
    provider_attempt_id: String,
}
impl FlowWorkAttempt030 {
    /// Synthetic attribution for registry tests, never an admission or grant.
    #[cfg(test)]
    pub(crate) fn registry_fixture030(provider_attempt_id: &str) -> Self {
        Self {
            identity: FlowIdentity030 {
                system_start_id: "registry-system".into(),
                flow_invocation_id: "registry-flow".into(),
                snapshot_id: "registry-snapshot".into(),
                epoch: "registry-capture".into(),
            },
            owner: EngineOwner {
                system_start_id: "registry-system".into(),
                owner_epoch: "registry-owner".into(),
            },
            generation: "registry-generation".into(),
            work: repository::dto::EngineWork {
                system_start_id: "registry-system".into(),
                flow_invocation_id: "registry-flow".into(),
                activation_id: "registry-work".into(),
                step: Some(vec!["work".into()]),
                agent_instance_id: Some("registry-instance".into()),
            },
            start_effect_id: "registry-start".into(),
            agent: "registry-agent".into(),
            provider_attempt_id: provider_attempt_id.into(),
        }
    }
    pub(crate) fn identity(&self) -> &FlowIdentity030 {
        &self.identity
    }
    pub(crate) fn owner(&self) -> &EngineOwner {
        &self.owner
    }
    pub(crate) fn generation(&self) -> &str {
        &self.generation
    }
    pub(crate) fn work(&self) -> &repository::dto::EngineWork {
        &self.work
    }
    pub(crate) fn start_effect_id(&self) -> &str {
        &self.start_effect_id
    }
    pub(crate) fn agent(&self) -> &str {
        &self.agent
    }
    pub(crate) fn provider_attempt_id(&self) -> &str {
        &self.provider_attempt_id
    }
}

/// Correlation for the native terminal ledger, never an authority to emit it.
pub(crate) fn work_terminal_event_id030(
    identity: &FlowIdentity030,
    protocol_event_id: &str,
) -> Result<String> {
    if protocol_event_id.is_empty() {
        return Err(refused());
    }
    Ok(format!(
        "work030:terminal:{:x}",
        Sha256::digest(serde_json::to_vec(&(identity, protocol_event_id))?)
    ))
}

/// Per-runtime, per-request interleaving, absent from production builds.
#[cfg(test)]
pub(crate) struct CommitTestHook030 {
    reached: tokio::sync::Semaphore,
    proceed: tokio::sync::Semaphore,
}
#[cfg(test)]
impl CommitTestHook030 {
    pub(crate) async fn reached(&self) {
        self.reached
            .acquire()
            .await
            .expect("test hook closed")
            .forget();
    }
    pub(crate) fn release(&self) {
        self.proceed.add_permits(1);
    }
}

fn unavailable() -> repository::dto::EngineFailure {
    failure(
        "RUNTIME_UNAVAILABLE",
        "",
        "Native flow authority is unavailable",
    )
}
fn uncertain() -> repository::dto::EngineFailure {
    failure(
        "UNCERTAIN",
        "",
        "Native commit or handoff must be reconciled without replay",
    )
}
fn refused() -> repository::dto::EngineFailure {
    failure(
        "CORRELATION",
        "",
        "Native flow receipt does not match its capture",
    )
}
fn store_error(error: StoreError030) -> repository::dto::EngineFailure {
    match error {
        StoreError030::Sql(_) => failure("STORAGE", "", "Native flow storage failed"),
        StoreError030::Authority => failure("AUTHORITY", "", "Native flow owner was revoked"),
        StoreError030::Blocked => failure("FLOW_BLOCKED", "", "Flow requires an explicit Stop"),
        StoreError030::NotClaimable => {
            failure("NOT_CLAIMABLE", "", "Native effect is no longer eligible")
        }
        _ => refused(),
    }
}
fn digest<T: serde::Serialize>(value: &T) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
impl FlowHost030 {
    #[cfg(test)]
    pub(crate) fn install_system_stop_commit_hook(
        &self,
        request_id: &str,
    ) -> Arc<CommitTestHook030> {
        let hook = Arc::new(CommitTestHook030 {
            reached: tokio::sync::Semaphore::new(0),
            proceed: tokio::sync::Semaphore::new(0),
        });
        assert!(
            self.stop_commit_hooks
                .lock()
                .expect("test hook registry")
                .insert(request_id.into(), hook.clone())
                .is_none(),
            "duplicate test hook"
        );
        hook
    }
    #[cfg(test)]
    async fn pause_after_system_stop_commit(&self, request_id: &str) {
        let hook = self
            .stop_commit_hooks
            .lock()
            .expect("test hook registry")
            .remove(request_id);
        if let Some(hook) = hook {
            hook.reached.add_permits(1);
            hook.proceed
                .acquire()
                .await
                .expect("test hook closed")
                .forget();
        }
    }
    #[cfg(test)]
    pub(crate) fn install_work_commit_hook(
        &self,
        identity: &FlowIdentity030,
        event_id: &str,
    ) -> Arc<CommitTestHook030> {
        let hook = Arc::new(CommitTestHook030 {
            reached: tokio::sync::Semaphore::new(0),
            proceed: tokio::sync::Semaphore::new(0),
        });
        assert!(
            self.work_commit_hooks
                .lock()
                .expect("test hook registry")
                .insert(
                    (identity.system_start_id.clone(), event_id.into()),
                    hook.clone()
                )
                .is_none(),
            "duplicate test hook"
        );
        hook
    }
    /// The persistence owner calls this after successful COMMIT, before ack.
    #[cfg(test)]
    pub(crate) async fn pause_after_work_commit(&self, marker: &FlowWorkCommitMarker030) {
        let hook = self
            .work_commit_hooks
            .lock()
            .expect("test hook registry")
            .remove(&(
                marker.identity.system_start_id.clone(),
                marker.event_id.clone(),
            ));
        if let Some(hook) = hook {
            hook.reached.add_permits(1);
            hook.proceed
                .acquire()
                .await
                .expect("test hook closed")
                .forget();
        }
    }
    /// Pause after the durable handoff commit and before the synchronous
    /// release/revocation boundary. No hook exists in production builds.
    #[cfg(test)]
    pub(crate) fn install_handoff_commit_hook(
        &self,
        identity: &FlowIdentity030,
        effect_id: &str,
    ) -> Arc<CommitTestHook030> {
        let hook = Arc::new(CommitTestHook030 {
            reached: tokio::sync::Semaphore::new(0),
            proceed: tokio::sync::Semaphore::new(0),
        });
        assert!(
            self.handoff_commit_hooks
                .lock()
                .expect("test hook registry")
                .insert(
                    (identity.system_start_id.clone(), effect_id.into()),
                    hook.clone(),
                )
                .is_none(),
            "duplicate test hook"
        );
        hook
    }
    #[cfg(test)]
    async fn pause_after_handoff_commit(&self, effect: &FlowEffect030) {
        let hook = self
            .handoff_commit_hooks
            .lock()
            .expect("test hook registry")
            .remove(&(effect.identity.system_start_id.clone(), effect.id.clone()));
        if let Some(hook) = hook {
            hook.reached.add_permits(1);
            hook.proceed
                .acquire()
                .await
                .expect("test hook closed")
                .forget();
        }
    }
    pub(crate) fn available(&self, identity: &FlowIdentity030) -> Result<()> {
        self.available_except_route_source(identity, None)
    }
    /// A readback may inspect its own 037 marker, never another preparation or
    /// a Start, event or work commit. Mutation paths always use `available`.
    pub(crate) fn available_for_route_source_readback(
        &self,
        reference: &PrepareRef030,
    ) -> Result<()> {
        self.available_except_route_source(&reference.identity, Some(reference))
    }
    fn available_except_route_source(
        &self,
        identity: &FlowIdentity030,
        readback: Option<&PrepareRef030>,
    ) -> Result<()> {
        self.call_commits.require_clear(identity)?;
        let pending = self.committing.lock().map_err(|_| unavailable())?;
        if pending
            .values()
            .any(|id| id.system_start_id == identity.system_start_id)
        {
            return Err(uncertain());
        }
        if self
            .event_committing
            .lock()
            .map_err(|_| unavailable())?
            .values()
            .any(|event| event.identity.system_start_id == identity.system_start_id)
        {
            return Err(uncertain());
        }
        if self
            .work_committing
            .lock()
            .map_err(|_| unavailable())?
            .values()
            .any(|marker| marker.identity.system_start_id == identity.system_start_id)
        {
            return Err(uncertain());
        }
        if self
            .route_source_committing
            .lock()
            .map_err(|_| unavailable())?
            .values()
            .any(|marker| {
                marker.identity().system_start_id == identity.system_start_id
                    && Some(marker.reference()) != readback
            })
        {
            return Err(uncertain());
        }
        Ok(())
    }
    /// Install under the common admission gate before submitting the source
    /// transaction's COMMIT. Dropping its future never releases this barrier.
    pub(crate) fn begin_route_source_commit(
        &self,
        source: &AttestedRouteSource030,
    ) -> Result<RouteSourceCommitMarker030> {
        let marker = source.commit_marker()?;
        self.available(marker.identity())?;
        let key = (
            marker.identity().system_start_id.clone(),
            marker.reference().prepare_id.clone(),
        );
        let mut pending = self
            .route_source_committing
            .lock()
            .map_err(|_| unavailable())?;
        if pending.contains_key(&key) {
            return Err(uncertain());
        }
        pending.insert(key, marker.clone());
        Ok(marker)
    }
    /// Observation only. A missing marker does not authorize a source write.
    pub(crate) fn pending_route_source_commit(
        &self,
        reference: &PrepareRef030,
    ) -> Result<Option<RouteSourceCommitMarker030>> {
        let pending = self
            .route_source_committing
            .lock()
            .map_err(|_| unavailable())?;
        match pending.get(&(
            reference.identity.system_start_id.clone(),
            reference.prepare_id.clone(),
        )) {
            Some(marker) if marker.reference() != reference => Err(refused()),
            marker => Ok(marker.cloned()),
        }
    }
    /// The native lifecycle owner calls this only after successful COMMIT or
    /// an exact source readback. Absence leaves the marker in place.
    pub(crate) fn acknowledge_route_source_commit(
        &self,
        marker: &RouteSourceCommitMarker030,
    ) -> Result<()> {
        let mut pending = self
            .route_source_committing
            .lock()
            .map_err(|_| unavailable())?;
        let key = (
            marker.identity().system_start_id.clone(),
            marker.reference().prepare_id.clone(),
        );
        match pending.get(&key) {
            Some(stored) if stored != marker => Err(refused()),
            _ => {
                pending.remove(&key);
                Ok(())
            }
        }
    }
    /// Called under the common admission gate after native SQL validation and
    /// before submitting the decision/check transaction's COMMIT. Cancellation
    /// never drops this barrier; only an exact native readback may resolve it.
    pub(crate) fn begin_work_commit(
        &self,
        identity: &FlowIdentity030,
        event_id: &str,
        ticket_json: &str,
        decision_json: &str,
    ) -> Result<FlowWorkCommitMarker030> {
        self.available(identity)?;
        if event_id.is_empty()
            || [
                &identity.system_start_id,
                &identity.flow_invocation_id,
                &identity.snapshot_id,
                &identity.epoch,
            ]
            .iter()
            .any(|part| part.is_empty())
        {
            return Err(refused());
        }
        crate::db::exact_json::validate(ticket_json)?;
        crate::db::exact_json::validate(decision_json)?;
        let marker = FlowWorkCommitMarker030 {
            identity: identity.clone(),
            event_id: event_id.into(),
            ticket_sha256: format!("{:x}", Sha256::digest(ticket_json.as_bytes())),
            decision_sha256: format!("{:x}", Sha256::digest(decision_json.as_bytes())),
        };
        let mut pending = self.work_committing.lock().map_err(|_| unavailable())?;
        let key = (identity.system_start_id.clone(), event_id.into());
        if pending.contains_key(&key) {
            return Err(uncertain());
        }
        pending.insert(key, marker.clone());
        Ok(marker)
    }
    /// Retrieving a marker grants no authority and does not release the gate.
    pub(crate) fn pending_work_commit(
        &self,
        identity: &FlowIdentity030,
        event_id: &str,
    ) -> Result<Option<FlowWorkCommitMarker030>> {
        let pending = self.work_committing.lock().map_err(|_| unavailable())?;
        match pending.get(&(identity.system_start_id.clone(), event_id.into())) {
            Some(marker) if marker.identity != *identity => Err(refused()),
            value => Ok(value.cloned()),
        }
    }
    /// Native persistence first confirms the exact ticket, decision and check
    /// rows. This removes only that marker, without re-emitting any effect.
    pub(crate) fn acknowledge_work_commit(&self, marker: &FlowWorkCommitMarker030) -> Result<()> {
        let mut pending = self.work_committing.lock().map_err(|_| unavailable())?;
        let key = (
            marker.identity.system_start_id.clone(),
            marker.event_id.clone(),
        );
        match pending.get(&key) {
            Some(stored) if stored != marker => Err(refused()),
            _ => {
                pending.remove(&key);
                Ok(())
            }
        }
    }
    fn begin_event_commit(&self, event: &FlowEvent030) -> Result<()> {
        let mut pending = self.event_committing.lock().map_err(|_| unavailable())?;
        let key = (
            event.identity.system_start_id.clone(),
            event.event_id.clone(),
        );
        if pending.contains_key(&key) {
            return Err(uncertain());
        }
        pending.insert(key, event.clone());
        Ok(())
    }
    fn acknowledge_event_commit(&self, event: &FlowEvent030) {
        if let Ok(mut pending) = self.event_committing.lock() {
            let key = (
                event.identity.system_start_id.clone(),
                event.event_id.clone(),
            );
            if pending.get(&key) == Some(event) {
                pending.remove(&key);
            }
        }
    }
    fn begin(&self, request: &EngineStartRequest, identity: &FlowIdentity030) -> Result<()> {
        let mut pending = self.committing.lock().map_err(|_| unavailable())?;
        if pending.contains_key(&request.request_id) {
            return Err(uncertain());
        }
        pending.insert(request.request_id.clone(), identity.clone());
        Ok(())
    }
    fn acknowledge(&self, request: &EngineStartRequest, identity: &FlowIdentity030) {
        // Poison is fail-closed: retaining the barrier is safer than admitting work.
        if let Ok(mut pending) = self.committing.lock() {
            if pending.get(&request.request_id) == Some(identity) {
                pending.remove(&request.request_id);
            }
        }
    }
    pub(crate) fn retain_diagnostic_join(&self, joined: &JoinedOwnedAgent030) -> Result<()> {
        let attempt = joined.attempt();
        let key = (
            attempt.identity().system_start_id.clone(),
            attempt.identity().flow_invocation_id.clone(),
            attempt.work().activation_id.clone(),
        );
        let mut pending = self.joined_diagnostics.lock().map_err(|_| unavailable())?;
        if let Some(existing) = pending.get(&key) {
            if existing.request_id() != joined.request_id()
                || serde_json::to_value(existing.attempt())? != serde_json::to_value(attempt)?
            {
                return Err(refused());
            }
        } else {
            pending.insert(key, joined.clone());
        }
        Ok(())
    }
    fn forget_diagnostic_join(&self, joined: &JoinedOwnedAgent030) {
        let attempt = joined.attempt();
        let key = (
            attempt.identity().system_start_id.clone(),
            attempt.identity().flow_invocation_id.clone(),
            attempt.work().activation_id.clone(),
        );
        if let Ok(mut pending) = self.joined_diagnostics.lock() {
            if pending.get(&key).is_some_and(|existing| {
                existing.request_id() == joined.request_id()
                    && matches!((serde_json::to_value(existing.attempt()), serde_json::to_value(attempt)), (Ok(a), Ok(b)) if a == b)
            }) {
                pending.remove(&key);
            }
        }
    }
    pub(crate) fn diagnostic_join(
        &self,
        identity: &FlowIdentity030,
        activation: &str,
    ) -> Result<Option<JoinedOwnedAgent030>> {
        Ok(self
            .joined_diagnostics
            .lock()
            .map_err(|_| unavailable())?
            .get(&(
                identity.system_start_id.clone(),
                identity.flow_invocation_id.clone(),
                activation.into(),
            ))
            .cloned())
    }
    /// These capabilities were installed by native Start before COMMIT. A
    /// supplied system label cannot create retirement authority.
    pub(crate) fn retiring_controls(&self, generation: &str) -> Result<Vec<Arc<FlowControl030>>> {
        Ok(self
            .controls
            .lock()
            .map_err(|_| unavailable())?
            .values()
            .filter(|c| c.generation == generation)
            .cloned()
            .collect())
    }
}

async fn check_owner(
    db: &mut SqliteConnection,
    lease: &HostStartLease,
    identity: &FlowIdentity030,
    creating: Option<&StartCapture030>,
) -> std::result::Result<EngineOwner, StoreError030> {
    lease.ensure_live().map_err(|_| StoreError030::Authority)?;
    let row = sqlx::query("SELECT invocation_id,snapshot_id,capture_epoch,owner_epoch,generation,status,capture_sha256 FROM engine_flow030_owners WHERE system_id=?")
        .bind(&identity.system_start_id).fetch_optional(&mut *db).await?
        .ok_or(StoreError030::Missing)?;
    if row.get::<String, _>("invocation_id") != identity.flow_invocation_id
        || row.get::<String, _>("snapshot_id") != identity.snapshot_id
        || row.get::<String, _>("capture_epoch") != identity.epoch
        || row.get::<String, _>("generation") != lease.generation()
        || row.get::<String, _>("status") != "live"
    {
        return Err(StoreError030::Authority);
    }
    let owner = EngineOwner {
        system_start_id: identity.system_start_id.clone(),
        owner_epoch: row.get("owner_epoch"),
    };
    let retained: Option<String> = sqlx::query_scalar(
        "SELECT capture_json FROM engine_start030_requests WHERE system_id=? AND invocation_id=?",
    )
    .bind(&identity.system_start_id)
    .bind(&identity.flow_invocation_id)
    .fetch_optional(&mut *db)
    .await?;
    let capture: StartCapture030 = match retained {
        Some(raw) => {
            // The final Start check runs after INSERT but before begin_commit
            // retains its owner in memory. Only this exact native capture may
            // bridge that interval. Replays have no matching creating capture.
            let current_start = match creating {
                Some(expected) if expected.identity == *identity && owner.owner_epoch == "0" => {
                    serde_json::to_string(expected)? == raw
                }
                _ => false,
            };
            if !current_start {
                if lease
                    .owner(&identity.system_start_id)
                    .map_err(|_| StoreError030::Authority)?
                    != owner
                {
                    return Err(StoreError030::Authority);
                }
            } else if let Ok(existing) = lease.owner(&identity.system_start_id) {
                if existing != owner {
                    return Err(StoreError030::Authority);
                }
            }
            serde_json::from_str(&raw)?
        }
        None => creating
            .filter(|c| c.identity == *identity)
            .cloned()
            .ok_or(StoreError030::Authority)?,
    };
    if capture.identity != *identity
        || digest(&capture).map_err(|_| StoreError030::Authority)?
            != row.get::<String, _>("capture_sha256")
    {
        return Err(StoreError030::Authority);
    }
    lease.ensure_live().map_err(|_| StoreError030::Authority)?;
    Ok(owner)
}

pub(crate) struct Authority<'a> {
    pub(crate) runtime: &'a FlowHost030,
    pub(crate) lease: &'a HostStartLease,
    pub(crate) owner: EngineOwner,
}

/// Resolve the occurrence against the committed native Prepared event, including
/// its producer and batch position. Equal payloads at different indices stay distinct.
fn check_occurrence(
    state: &FlowState030,
    occurrence: &DeliveryOccurrence030,
    message: &Option<String>,
    item: &Option<String>,
    producer: &Option<Producer030>,
) -> std::result::Result<(), StoreError030> {
    let preparation_id = state
        .preparation_receipts
        .get(&occurrence.native_receipt_id)
        .ok_or(StoreError030::Authority)?;
    let preparation = state
        .preparations
        .iter()
        .find(|p| p.reference.prepare_id == *preparation_id && p.status == "consumed")
        .ok_or(StoreError030::Authority)?;
    if producer.as_ref() != Some(&preparation.producer) {
        return Err(StoreError030::Authority);
    }
    let mut matching = Vec::new();
    for record in state.events.values() {
        let event: Value = serde_json::from_str(&record.event_json)?;
        if let Some(prepared) = event.pointer("/kind/Prepared") {
            if prepared.get("native_receipt_id").and_then(Value::as_str)
                == Some(&occurrence.native_receipt_id)
                && prepared.get("reference") == Some(&serde_json::to_value(&preparation.reference)?)
            {
                matching.push(
                    prepared
                        .get("result")
                        .and_then(|r| r.pointer("/Ready/batches"))
                        .cloned()
                        .ok_or(StoreError030::Authority)?,
                );
            }
        }
    }
    if matching.len() != 1 {
        return Err(StoreError030::Authority);
    }
    let batches: Vec<PreparedBatch030> = serde_json::from_value(matching.remove(0))?;
    let batch = batches
        .get(occurrence.target_ordinal)
        .ok_or(StoreError030::Authority)?;
    let index: usize = occurrence
        .item_index
        .parse()
        .map_err(|_| StoreError030::Authority)?;
    let entry = batch.items.get(index).ok_or(StoreError030::Authority)?;
    if index.to_string() != occurrence.item_index
        || batch.target_ordinal != occurrence.target_ordinal
        || entry.occurrence != *occurrence
        || entry.message_json != *message
        || entry.item_json != *item
    {
        return Err(StoreError030::Authority);
    }
    Ok(())
}

impl Authority030 for Authority<'_> {
    fn owner<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        id: &'a FlowIdentity030,
    ) -> CheckFuture<'a> {
        Box::pin(async move {
            if check_owner(db, self.lease, id, None).await? != self.owner {
                return Err(StoreError030::Authority);
            }
            Ok(())
        })
    }
    fn effect<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        effect: &'a FlowEffect030,
    ) -> CheckFuture<'a> {
        Box::pin(async move {
            self.owner(db, &effect.identity).await?;
            self.runtime
                .available(&effect.identity)
                .map_err(|_| StoreError030::Blocked)?;
            let raw: String = sqlx::query_scalar(
                "SELECT state_json FROM engine_flow030_runs WHERE system_id=? AND invocation_id=?",
            )
            .bind(&effect.identity.system_start_id)
            .bind(&effect.identity.flow_invocation_id)
            .fetch_one(&mut *db)
            .await?;
            let state: FlowState030 = serde_json::from_str(&raw)?;
            match &effect.kind {
                FlowEffectKind030::Start {
                    work,
                    step,
                    agent,
                    input_json,
                    message_json,
                    item_json,
                    occurrence,
                    sender,
                } => {
                    let activation = state
                        .activations
                        .iter()
                        .find(|a| a.id == work.activation_id)
                        .ok_or(StoreError030::Authority)?;
                    if activation.start_effect_id.as_deref() != Some(&work.start_effect_id)
                        || work.start_effect_id != effect.id
                        || activation.instance_id != work.agent_instance_id
                        || activation.step != *step
                        || activation.agent != *agent
                        || activation.input_json != *input_json
                        || activation.message_json != *message_json
                        || activation.item_json != *item_json
                        || activation.occurrence != *occurrence
                        || activation.producer != *sender
                    {
                        return Err(StoreError030::Authority);
                    }
                    if let Some(occurrence) = occurrence {
                        check_occurrence(&state, occurrence, message_json, item_json, sender)?;
                        check_persisted_occurrence(
                            db,
                            &effect.identity,
                            occurrence,
                            sender,
                            &self.owner.owner_epoch,
                            self.lease.generation(),
                        )
                        .await?;
                    }
                }
                FlowEffectKind030::Steer {
                    work,
                    delivery_activation_id,
                    message_json,
                    occurrence,
                    sender,
                } => {
                    let active = state
                        .activations
                        .iter()
                        .find(|a| a.id == work.activation_id)
                        .ok_or(StoreError030::Authority)?;
                    let delivery = state
                        .activations
                        .iter()
                        .find(|a| a.id == *delivery_activation_id)
                        .ok_or(StoreError030::Authority)?;
                    if active.start_effect_id.as_deref() != Some(&work.start_effect_id)
                        || active.instance_id != work.agent_instance_id
                        || active.instance_id != delivery.instance_id
                        || active.agent != delivery.agent
                        || delivery.message_json.as_deref().unwrap_or("{}") != message_json
                        || delivery.occurrence != *occurrence
                        || delivery.producer != *sender
                    {
                        return Err(StoreError030::Authority);
                    }
                    if let Some(occurrence) = occurrence {
                        check_occurrence(
                            &state,
                            occurrence,
                            &delivery.message_json,
                            &delivery.item_json,
                            sender,
                        )?;
                        check_persisted_occurrence(
                            db,
                            &effect.identity,
                            occurrence,
                            sender,
                            &self.owner.owner_epoch,
                            self.lease.generation(),
                        )
                        .await?;
                    }
                }
                FlowEffectKind030::PrepareRoute {
                    reference,
                    producer,
                } => {
                    if !state.preparations.iter().any(|p| {
                        p.reference == *reference
                            && p.producer == *producer
                            && p.status == "pending"
                    }) {
                        return Err(StoreError030::Authority);
                    }
                }
                FlowEffectKind030::StopWork { work, .. } => {
                    if !state.activations.iter().any(|a| {
                        a.id == work.activation_id
                            && a.start_effect_id.as_deref() == Some(&work.start_effect_id)
                            && a.instance_id == work.agent_instance_id
                            && a.physical
                    }) {
                        return Err(StoreError030::Authority);
                    }
                }
                _ => {}
            }
            Ok(())
        })
    }
    fn settlement<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        effect: &'a FlowEffect030,
        receipt: &'a Value,
    ) -> CheckFuture<'a> {
        Box::pin(async move {
            self.owner(db, &effect.identity).await?;
            if let FlowEffectKind030::PrepareRoute { reference, .. } = &effect.kind {
                let row = sqlx::query("SELECT p.native_receipt_id,p.reference_json,s.preparation_effect_id FROM engine_flow030_preparations p JOIN engine_flow030_route_source_attestations s ON s.system_id=p.system_id AND s.invocation_id=p.invocation_id AND s.prepare_id=p.prepare_id WHERE p.system_id=? AND p.invocation_id=? AND p.prepare_id=? AND p.owner_epoch=? AND p.generation=? AND s.owner_epoch=p.owner_epoch AND s.generation=p.generation")
                    .bind(&effect.identity.system_start_id).bind(&effect.identity.flow_invocation_id)
                    .bind(&reference.prepare_id).bind(&self.owner.owner_epoch).bind(self.lease.generation())
                    .fetch_optional(&mut *db).await?.ok_or(StoreError030::Authority)?;
                let expected = json!({"kind":"nativeRoutePrepared030", "prepareId":reference.prepare_id,
                    "nativeReceiptId":row.get::<&str,_>("native_receipt_id")});
                if row.get::<&str, _>("preparation_effect_id") != effect.id
                    || row.get::<&str, _>("reference_json") != serde_json::to_string(reference)?
                    || receipt != &expected
                {
                    return Err(StoreError030::Authority);
                }
                return Ok(());
            }
            let raw: Option<String> = sqlx::query_scalar("SELECT receipt_json FROM engine_flow030_handoffs WHERE system_id=? AND invocation_id=? AND effect_id=? AND owner_epoch=? AND generation=?")
                .bind(&effect.identity.system_start_id).bind(&effect.identity.flow_invocation_id).bind(&effect.id)
                .bind(&self.owner.owner_epoch).bind(self.lease.generation()).fetch_optional(db).await?;
            if raw.as_deref() != Some(serde_json::to_string(receipt)?.as_str()) {
                return Err(StoreError030::Authority);
            }
            Ok(())
        })
    }
    fn owner_epoch(&self) -> &str {
        &self.owner.owner_epoch
    }
}

#[cfg(test)]
#[path = "agsdl_host_no_admission030_tests.rs"]
mod no_admission_tests;

struct StartGuard {
    _source: LockedExecutionSource,
    _policy: crate::config::ExecutionToolsLease,
    _admission: OwnedMutexGuard<()>,
}
struct Start<'a> {
    runtime: &'a FlowHost030,
    host: &'a HostState,
    lease: &'a HostStartLease,
    manager: &'a ConfigManager,
    pool: &'a SqlitePool,
    workspace: &'a Path,
    git: &'a crate::git::GitState,
    intent_scope: Option<&'a ExecutionIntentScope>,
    captured: Mutex<Option<(Arc<CompilationCapture>, StartCapture030)>>,
}
impl Start<'_> {
    async fn source(&self, request: &EngineStartRequest) -> Result<LockedExecutionSource> {
        let metadata = capture::metadata_root(self.workspace)?;
        match self.intent_scope {
            Some(scope) => {
                lock_execution_intent_scope(self.workspace, &metadata, scope, Some(&request.source))
                    .await
            }
            None => {
                lock_execution_source_owner(
                    self.workspace,
                    &metadata,
                    &request.source.owner,
                    Some(&request.source),
                )
                .await
            }
        }
    }
}
impl Authority030 for Start<'_> {
    fn owner<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        id: &'a FlowIdentity030,
    ) -> CheckFuture<'a> {
        Box::pin(async move {
            let creating = self
                .captured
                .lock()
                .map_err(|_| StoreError030::Authority)?
                .as_ref()
                .map(|(_, c)| c.clone());
            check_owner(db, self.lease, id, creating.as_ref()).await?;
            Ok(())
        })
    }
    fn effect<'a>(
        &'a self,
        _db: &'a mut SqliteConnection,
        _effect: &'a FlowEffect030,
    ) -> CheckFuture<'a> {
        Box::pin(async { Err(StoreError030::Authority) })
    }
    fn settlement<'a>(
        &'a self,
        _db: &'a mut SqliteConnection,
        _effect: &'a FlowEffect030,
        _receipt: &'a Value,
    ) -> CheckFuture<'a> {
        Box::pin(async { Err(StoreError030::Authority) })
    }
    fn owner_epoch(&self) -> &str {
        "0"
    }
}
impl StartAuthority030 for Start<'_> {
    type SourceGuard = StartGuard;
    fn require_clear(&self, request: &EngineStartRequest) -> Result<()> {
        self.lease.ensure_live()?;
        if self
            .runtime
            .committing
            .lock()
            .map_err(|_| unavailable())?
            .contains_key(&request.request_id)
        {
            return Err(uncertain());
        }
        Ok(())
    }
    fn begin_commit(&self, request: &EngineStartRequest, identity: &FlowIdentity030) -> Result<()> {
        self.runtime.begin(request, identity)?;
        // Retirement must know this owner even if the commit reply or caller is lost.
        let owner = EngineOwner {
            system_start_id: identity.system_start_id.clone(),
            owner_epoch: "0".into(),
        };
        self.lease.retain_committed_owner(owner.clone())?;
        self.runtime
            .controls
            .lock()
            .map_err(|_| unavailable())?
            .insert(
                identity.system_start_id.clone(),
                Arc::new(FlowControl030 {
                    owner,
                    identity: identity.clone(),
                    generation: self.lease.generation().into(),
                    admission: self.host.admission_lock(),
                }),
            );
        Ok(())
    }
    fn commit_acknowledged(&self, request: &EngineStartRequest, identity: &FlowIdentity030) {
        self.runtime.acknowledge(request, identity);
    }
    async fn capture(&self, request: &EngineStartRequest) -> Result<StartCapture030> {
        self.lease.ensure_live()?;
        let compiled = Arc::new(
            capture::compile_input(
                self.host,
                self.manager,
                self.pool,
                self.workspace,
                &capture::ExecutionPreflightRequest {
                    owner: request.source.owner.clone(),
                    expected: Some(request.source.clone()),
                },
                Some(request.entry.as_ref()),
                request
                    .associations
                    .task_id
                    .as_deref()
                    .map(|id| (id, self.git)),
            )
            .await?,
        );
        let source = self.source(request).await?;
        let material = compiled.start_material030(&source, request, self.lease.generation())?;
        let capture = StartCapture030 {
            identity: FlowIdentity030 { system_start_id: uuid::Uuid::new_v4().to_string(), flow_invocation_id: uuid::Uuid::new_v4().to_string(), snapshot_id: uuid::Uuid::new_v4().to_string(), epoch: uuid::Uuid::new_v4().to_string() },
            source: material.source, versions: material.versions, authored_source: material.authored_source,
            compiled_plan_json: material.compiled_plan_json, registry_json: material.registry_json,
            private_capture_json: json!({"format":"macro-native-flow-capture/030", "generation":material.generation,
                "nativeCatalogueJson":material.native_catalogue_json, "callPermissionsJson":material.call_permissions_json,
                "callScopeJson":material.call_scope_json, "displayCardsJson":material.display_cards_json,
                "associations":request.associations, "entryUnassessed":material.entry_unassessed}).to_string(),
        };
        self.lease.ensure_live()?;
        *self.captured.lock().map_err(|_| unavailable())? = Some((compiled, capture.clone()));
        Ok(capture)
    }
    async fn lock_source(&self, request: &EngineStartRequest) -> Result<StartGuard> {
        self.require_clear(request)?;
        let source = self.source(request).await?;
        let (compiled, _) = self
            .captured
            .lock()
            .map_err(|_| unavailable())?
            .clone()
            .ok_or_else(refused)?;
        compiled.start_material030(&source, request, self.lease.generation())?;
        let mut catalogue = crate::agsdl_host_catalogue::capture(self.manager, self.pool).await?;
        let policy = self
            .manager
            .lock_execution_tools(&source.revision.owner.project_id)
            .await
            .map_err(|_| unavailable())?;
        let (current, codex, claude) = capture::observation(
            self.manager,
            self.workspace,
            &source,
            &catalogue,
            &policy.tools,
            request
                .associations
                .task_id
                .as_deref()
                .map(|id| (id, self.git)),
        )
        .await?;
        catalogue.codex_account_digest = codex;
        catalogue.claude_account_digest = claude;
        if serde_json::to_string(&catalogue)? != serde_json::to_string(&compiled.native_catalogue)?
            || current.get("version")
                != compiled
                    .native_registry_json
                    .parse::<Value>()?
                    .get("version")
        {
            return Err(failure(
                "CAPTURE_CHANGED",
                "source",
                "Native capture changed before commit",
            ));
        }
        // Existing provider admissions also lock metadata before admission.
        // Never invert those locks, nor acquire a nested config read lease.
        let admission = self.host.admission_lock().lock_owned().await;
        self.require_clear(request)?;
        self.lease.ensure_live()?;
        Ok(StartGuard {
            _source: source,
            _policy: policy,
            _admission: admission,
        })
    }
    async fn bind_capture_tx(
        &self,
        db: &mut SqliteConnection,
        _request: &EngineStartRequest,
        capture: &StartCapture030,
    ) -> Result<()> {
        self.lease.ensure_live()?;
        let expected = self
            .captured
            .lock()
            .map_err(|_| unavailable())?
            .as_ref()
            .map(|(_, c)| serde_json::to_string(c))
            .transpose()?
            .ok_or_else(refused)?;
        if expected != serde_json::to_string(capture)? {
            return Err(refused());
        }
        sqlx::query("INSERT INTO engine_flow030_owners(system_id,invocation_id,snapshot_id,capture_epoch,owner_epoch,generation,status,capture_sha256) VALUES(?,?,?,?,'0',?,'live',?)")
            .bind(&capture.identity.system_start_id).bind(&capture.identity.flow_invocation_id).bind(&capture.identity.snapshot_id).bind(&capture.identity.epoch)
            .bind(self.lease.generation()).bind(digest(capture)?).execute(db).await?;
        Ok(())
    }
}

pub(crate) async fn start_linked(
    runtime: &FlowHost030,
    host: &HostState,
    manager: &ConfigManager,
    pool: &SqlitePool,
    workspace: &Path,
    git: &crate::git::GitState,
    request: &EngineStartRequest,
    link: Option<&IntentAdmissionLink>,
) -> Result<RetainedStart030> {
    let lease = host.start_lease().await?;
    let authority = Start {
        runtime,
        host,
        lease: &lease,
        manager,
        pool,
        workspace,
        git,
        intent_scope: link.map(|l| &l.key.scope),
        captured: Mutex::new(None),
    };
    let result = start030::start_linked(pool, request, &authority, link).await?;
    lease.ensure_live().map_err(|_| uncertain())?;
    Ok(result)
}

/// A committed result resolves a lost reply. Absence does not release a barrier.
pub(crate) async fn inspect_start_linked(
    runtime: &FlowHost030,
    host: &HostState,
    manager: &ConfigManager,
    pool: &SqlitePool,
    workspace: &Path,
    git: &crate::git::GitState,
    request: &EngineStartRequest,
    link: Option<&IntentAdmissionLink>,
) -> Result<StartInspection030> {
    let lease = host.start_lease().await?;
    let authority = Start {
        runtime,
        host,
        lease: &lease,
        manager,
        pool,
        workspace,
        git,
        intent_scope: link.map(|l| &l.key.scope),
        captured: Mutex::new(None),
    };
    let result = start030::inspect_linked(pool, request, &authority, link).await?;
    if let StartInspection030::Committed(ref retained) = result {
        runtime.acknowledge(request, &retained.receipt.identity);
    }
    lease.ensure_live()?;
    Ok(result)
}

pub(crate) async fn read(
    runtime: &FlowHost030,
    host: &HostState,
    pool: &SqlitePool,
    id: &FlowIdentity030,
) -> Result<FlowView030> {
    let lease = host.start_lease().await?;
    let authority = Authority {
        runtime,
        owner: lease.owner(&id.system_start_id)?,
        lease: &lease,
    };
    let mut db = pool.acquire().await?;
    let mut tx = db.begin().await?;
    let result = flow_store030::read_tx(&mut tx, &authority, id)
        .await
        .map_err(store_error)?;
    tx.commit().await?;
    lease.ensure_live()?;
    Ok(result)
}

/// Private input for 0.3 controllers and executors. The capture and state are
/// read in one SQLite snapshot and never adapted into a historical State020.
pub(crate) struct NativeFlowInspection030 {
    pub owner: EngineOwner,
    pub capture: StartCapture030,
    pub flow: FlowView030,
}

pub(crate) async fn inspect_run(
    runtime: &FlowHost030,
    host: &HostState,
    pool: &SqlitePool,
    owner: &EngineOwner,
) -> Result<NativeFlowInspection030> {
    let lease = host.start_lease().await?;
    if lease.owner(&owner.system_start_id)? != *owner {
        return Err(refused());
    }
    let authority = Authority {
        runtime,
        lease: &lease,
        owner: owner.clone(),
    };
    let mut db = pool.acquire().await?;
    let mut tx = db.begin().await?;
    let raw: String =
        sqlx::query_scalar("SELECT capture_json FROM engine_start030_requests WHERE system_id=?")
            .bind(&owner.system_start_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| {
                failure(
                    "NOT_FOUND",
                    "systemStartId",
                    "Native flow capture is absent",
                )
            })?;
    let capture: StartCapture030 = serde_json::from_str(&raw)?;
    authority
        .owner(&mut tx, &capture.identity)
        .await
        .map_err(store_error)?;
    let flow = flow_store030::read_tx(&mut tx, &authority, &capture.identity)
        .await
        .map_err(store_error)?;
    tx.commit().await?;
    lease.ensure_live()?;
    Ok(NativeFlowInspection030 {
        owner: owner.clone(),
        capture,
        flow,
    })
}

/// Only native controllers, receipt resolvers and supervisors construct events.
/// This is deliberately not a command accepting deserialized model events.
/// Called by native work persistence in its immediate transaction, before the
/// shared work COMMIT marker is installed. This never acknowledges a commit.
/// Physical termination derives only from the registry-owned join witness.
pub(crate) async fn apply_work_terminal_tx(
    runtime: &FlowHost030,
    db: &mut SqliteConnection,
    lease: &HostStartLease,
    terminal: &AcceptedWorkTerminal030,
    joined: &JoinedOwnedAgent030,
) -> Result<Apply030> {
    let identity = terminal.identity();
    let attempt = terminal.attempt();
    let work = terminal.work();
    runtime.available(identity)?;
    lease.ensure_live()?;
    let owner = lease.owner(&identity.system_start_id)?;
    if identity != attempt.identity()
        || owner != *attempt.owner()
        || lease.generation() != attempt.generation()
        || work.activation_id != attempt.work().activation_id
        || work.start_effect_id != attempt.start_effect_id()
        || work.agent_instance_id != attempt.work().agent_instance_id
        || serde_json::to_value(joined.attempt())? != serde_json::to_value(attempt)?
        || joined.request_id()
            != format!(
                "flow030:{}:{}",
                identity.system_start_id,
                attempt.start_effect_id()
            )
        || terminal.protocol_event_id() != format!("physical:{}", attempt.provider_attempt_id())
    {
        return Err(refused());
    }
    let authority = Authority {
        runtime,
        owner,
        lease,
    };
    let view = flow_store030::read_tx(db, &authority, identity)
        .await
        .map_err(store_error)?;
    let event_id = work_terminal_event_id030(identity, terminal.protocol_event_id())?;
    let recorded: Option<String> = sqlx::query_scalar(
        "SELECT event_json FROM engine_flow030_events WHERE system_id=? AND invocation_id=? AND event_id=?",
    )
    .bind(&identity.system_start_id)
    .bind(&identity.flow_invocation_id)
    .bind(&event_id)
    .fetch_optional(&mut *db)
    .await?;
    let expected_revision = match recorded {
        Some(raw) => serde_json::from_str::<Value>(&raw)?
            .get("expectedRevision")
            .and_then(Value::as_str)
            .ok_or_else(refused)?
            .to_owned(),
        None => view.state.revision,
    };
    let event = FlowEvent030 {
        identity: identity.clone(),
        event_id,
        expected_revision,
        kind: FlowEventKind030::WorkResult {
            work: work.clone(),
            result: terminal.result().clone(),
            // The sealed witness already proves the future and its cleanups
            // ended. Apply that fact before the reducer routes this result,
            // so closing a group does not cancel its completed last branch.
            physical: Some(PhysicalEvidence030 {
                native_receipt_id: terminal.protocol_event_id().to_owned(),
                descendants_joined: true,
            }),
        },
    };
    // A diagnostic is persisted for the caller's transaction to commit. Its
    // later Stop cleanup still requires the native control path.
    let applied = flow_store030::apply_tx(db, &authority, &event)
        .await
        .map_err(store_error)?;
    if matches!(applied, Apply030::Diagnostic(_)) {
        // Retention happens before the work COMMIT; it grants nothing unless
        // the diagnostic and the exact native handoff are durable in SQL.
        runtime.retain_diagnostic_join(joined)?;
    }
    lease.ensure_live()?;
    Ok(applied)
}

pub(crate) async fn apply_native_event(
    runtime: &FlowHost030,
    host: &HostState,
    pool: &SqlitePool,
    event: &FlowEvent030,
) -> Result<Apply030> {
    // Prepared has a dedicated atomic path with its occurrence witnesses.
    if matches!(&event.kind, FlowEventKind030::Prepared { .. }) {
        return Err(refused());
    }
    let lease = host.start_lease().await?;
    let _admission = host.admission_lock().lock_owned().await;
    // Cleanup under an unknown commit requires the retained opaque FlowControl.
    // A generic event cannot turn its variant into retirement authority.
    runtime.available(&event.identity)?;
    let authority = Authority {
        runtime,
        owner: lease.owner(&event.identity.system_start_id)?,
        lease: &lease,
    };
    let mut db = pool.acquire().await?;
    sqlx::query("PRAGMA synchronous=FULL")
        .execute(&mut *db)
        .await?;
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    let result = flow_store030::apply_tx(&mut tx, &authority, event)
        .await
        .map_err(store_error)?;
    lease.ensure_live()?;
    runtime.begin_event_commit(event)?;
    tx.commit().await.map_err(|_| uncertain())?;
    lease.ensure_live().map_err(|_| uncertain())?;
    runtime.acknowledge_event_commit(event);
    Ok(result)
}

/// Readback only: never reapply an absent event or infer rollback from absence.
/// A matching durable event can resolve a cancelled/unknown COMMIT barrier.
pub(crate) async fn inspect_native_event_commit(
    runtime: &FlowHost030,
    host: &HostState,
    pool: &SqlitePool,
    event: &FlowEvent030,
) -> Result<Option<Apply030>> {
    let lease = host.start_lease().await?;
    let _admission = host.admission_lock().lock_owned().await;
    let authority = Authority {
        runtime,
        lease: &lease,
        owner: lease.owner(&event.identity.system_start_id)?,
    };
    let mut db = pool.acquire().await?;
    let mut tx = db.begin().await?;
    authority
        .owner(&mut tx, &event.identity)
        .await
        .map_err(store_error)?;
    let row = sqlx::query("SELECT event_json,receipt_json,diagnostic_json FROM engine_flow030_events WHERE system_id=? AND invocation_id=? AND event_id=?")
        .bind(&event.identity.system_start_id).bind(&event.identity.flow_invocation_id).bind(&event.event_id).fetch_optional(&mut *tx).await?;
    let result = match row {
        None => None,
        Some(row) => {
            if row.get::<String, _>("event_json") != serde_json::to_string(event)? {
                return Err(refused());
            }
            Some(
                if let Some(raw) = row.get::<Option<String>, _>("receipt_json") {
                    Apply030::Replayed(serde_json::from_str::<FlowReceipt030>(&raw)?)
                } else {
                    Apply030::Diagnostic(serde_json::from_str(
                        row.get::<&str, _>("diagnostic_json"),
                    )?)
                },
            )
        }
    };
    tx.commit().await?;
    lease.ensure_live()?;
    if result.is_some() {
        runtime.acknowledge_event_commit(event);
    }
    Ok(result)
}

/// Supplied only by the native receipt resolver. JSON fields are data, never grants.
pub(crate) struct NativeRouteMaterial030 {
    pub source_json: String,
    pub content_receipts_json: String,
}

/// The receipt resolver must re-read immutable work/content receipts and effective
/// permissions on this transaction. No I/O or caller-provided permission flag.
pub(crate) trait RouteMaterialVerifier030: Sync {
    fn attest_tx<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        capture: &'a StartCapture030,
        reference: &'a PrepareRef030,
        producer: &'a Producer030,
        material: &'a NativeRouteMaterial030,
    ) -> CheckFuture<'a>;
}

/// Private native capability, not Clone/Deserialize/IPC. The broker may serialize
/// its input, but cannot create another capture by returning those bytes.
pub(crate) struct CapturedRoutePreparation030 {
    owner: EngineOwner,
    generation: String,
    capture: StartCapture030,
    reference: PrepareRef030,
    producer: Producer030,
    material: NativeRouteMaterial030,
    receipt_id: String,
}
impl CapturedRoutePreparation030 {
    pub(crate) fn receipt_id(&self) -> &str {
        &self.receipt_id
    }
    pub(crate) fn input_json(&self) -> Result<String> {
        Ok(serde_json::to_string(&json!({
            "planJson": self.capture.compiled_plan_json,
            "reference": self.reference,
            "producer": self.producer,
            "source": serde_json::from_str::<Value>(&self.material.source_json)?,
            "nativeReceiptId": self.receipt_id,
            "contentReceipts": serde_json::from_str::<Value>(&self.material.content_receipts_json)?,
        }))?)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OccurrenceProvenance030 {
    occurrence: DeliveryOccurrence030,
    prompt: Value,
    source: Value,
    producer: Producer030,
}

async fn check_persisted_occurrence(
    db: &mut SqliteConnection,
    id: &FlowIdentity030,
    occurrence: &DeliveryOccurrence030,
    sender: &Option<Producer030>,
    owner_epoch: &str,
    generation: &str,
) -> std::result::Result<String, StoreError030> {
    let ordinal = i64::try_from(occurrence.target_ordinal).map_err(|_| StoreError030::Authority)?;
    let row = sqlx::query("SELECT p.provenance_json,r.source_json,r.producer_json,r.owner_epoch,r.generation FROM engine_flow030_occurrence_provenance p JOIN engine_flow030_preparations r USING(system_id,invocation_id,native_receipt_id) WHERE p.system_id=? AND p.invocation_id=? AND p.native_receipt_id=? AND p.target_ordinal=? AND p.item_index=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&occurrence.native_receipt_id).bind(ordinal).bind(&occurrence.item_index).fetch_optional(&mut *db).await?.ok_or(StoreError030::Authority)?;
    let raw: String = row.get("provenance_json");
    let proof: OccurrenceProvenance030 = serde_json::from_str(&raw)?;
    let producer: Producer030 = serde_json::from_str(row.get::<&str, _>("producer_json"))?;
    let source: Value = serde_json::from_str(row.get::<&str, _>("source_json"))?;
    if row.get::<String, _>("owner_epoch") != owner_epoch
        || row.get::<String, _>("generation") != generation
        || proof.occurrence != *occurrence
        || proof.producer != producer
        || sender.as_ref() != Some(&producer)
        || proof.source != source
    {
        return Err(StoreError030::Authority);
    }
    Ok(raw)
}

/// Private host lookup for delivery construction, never an IPC grant. Admission
/// rechecks the same witness inside its immediate claim transaction.
pub(crate) async fn occurrence_provenance(
    runtime: &FlowHost030,
    host: &HostState,
    pool: &SqlitePool,
    owner: &EngineOwner,
    occurrence: &DeliveryOccurrence030,
    producer: &Producer030,
) -> Result<String> {
    let lease = host.start_lease().await?;
    if lease.owner(&owner.system_start_id)? != *owner {
        return Err(refused());
    }
    let authority = Authority {
        runtime,
        lease: &lease,
        owner: owner.clone(),
    };
    let mut db = pool.acquire().await?;
    let mut tx = db.begin().await?;
    let capture: String =
        sqlx::query_scalar("SELECT capture_json FROM engine_start030_requests WHERE system_id=?")
            .bind(&owner.system_start_id)
            .fetch_one(&mut *tx)
            .await?;
    let capture: StartCapture030 = serde_json::from_str(&capture)?;
    authority
        .owner(&mut tx, &capture.identity)
        .await
        .map_err(store_error)?;
    let raw = check_persisted_occurrence(
        &mut tx,
        &capture.identity,
        occurrence,
        &Some(producer.clone()),
        &owner.owner_epoch,
        lease.generation(),
    )
    .await
    .map_err(store_error)?;
    tx.commit().await?;
    lease.ensure_live()?;
    Ok(raw)
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum RoutePreparationOutput030 {
    Ready {
        batches: Vec<PreparedBatch030>,
        provenance: Vec<OccurrenceProvenance030>,
    },
    Failed {
        target_ordinal: usize,
        error: Failure030,
    },
}

fn route_material_source(
    material: &NativeRouteMaterial030,
    producer: &Producer030,
) -> Result<Value> {
    for raw in [&material.source_json, &material.content_receipts_json] {
        if raw.len() > 8_000_000 {
            return Err(failure(
                "INPUT_LIMIT",
                "route",
                "Route capture exceeds the transport limit",
            ));
        }
        repository::validate_json(raw)?;
    }
    let source: Value = serde_json::from_str(&material.source_json)?;
    if !source.is_object()
        || source.get("terminalId").and_then(Value::as_str) != Some(producer.activation_id.as_str())
        || source.get("producerStep") != Some(&serde_json::to_value(&producer.step)?)
        || source.get("outputJson").and_then(Value::as_str) != Some(producer.output_json.as_str())
    {
        return Err(refused());
    }
    let content: Value = serde_json::from_str(&material.content_receipts_json)?;
    let valid_content = match content.get("format").and_then(Value::as_str) {
        Some("macro-agsdl-route-content/1") => {
            content.get("occurrences").is_some_and(Value::is_array)
                && content.as_object().is_some_and(|fields| fields.len() == 2)
        }
        _ => false,
    };
    if !valid_content {
        return Err(refused());
    }
    Ok(source)
}

async fn route_capture_tx(
    db: &mut SqliteConnection,
    authority: &Authority<'_>,
    identity: &FlowIdentity030,
) -> Result<StartCapture030> {
    authority.owner(db, identity).await.map_err(store_error)?;
    let raw: String = sqlx::query_scalar(
        "SELECT capture_json FROM engine_start030_requests WHERE system_id=? AND invocation_id=?",
    )
    .bind(&identity.system_start_id)
    .bind(&identity.flow_invocation_id)
    .fetch_one(&mut *db)
    .await?;
    let capture: StartCapture030 = serde_json::from_str(&raw)?;
    if capture.identity != *identity {
        return Err(refused());
    }
    Ok(capture)
}

pub(crate) async fn capture_route_preparation<V: RouteMaterialVerifier030>(
    runtime: &FlowHost030,
    host: &HostState,
    pool: &SqlitePool,
    owner: &EngineOwner,
    reference: &PrepareRef030,
    material: NativeRouteMaterial030,
    verifier: &V,
) -> Result<CapturedRoutePreparation030> {
    let lease = host.start_lease().await?;
    let _admission = host.admission_lock().lock_owned().await;
    if lease.owner(&owner.system_start_id)? != *owner
        || reference.identity.system_start_id != owner.system_start_id
    {
        return Err(refused());
    }
    runtime.available(&reference.identity)?;
    let authority = Authority {
        runtime,
        lease: &lease,
        owner: owner.clone(),
    };
    let mut db = pool.acquire().await?;
    let mut tx = db.begin().await?;
    let capture = route_capture_tx(&mut tx, &authority, &reference.identity).await?;
    let view = flow_store030::read_tx(&mut tx, &authority, &reference.identity)
        .await
        .map_err(store_error)?;
    if view.state.stopping || view.state.verdict.is_some() {
        return Err(refused());
    }
    let preparation = view
        .state
        .preparations
        .iter()
        .find(|p| p.reference == *reference && p.status == "pending")
        .ok_or_else(refused)?;
    let producer = preparation.producer.clone();
    route_material_source(&material, &producer)?;
    verifier
        .attest_tx(&mut tx, &capture, reference, &producer, &material)
        .await
        .map_err(store_error)?;
    tx.commit().await?;
    lease.ensure_live()?;
    Ok(CapturedRoutePreparation030 {
        owner: owner.clone(),
        generation: lease.generation().into(),
        capture,
        reference: reference.clone(),
        producer,
        material,
        receipt_id: uuid::Uuid::new_v4().to_string(),
    })
}

/// Native end-to-end path through the resident pure helper. This evaluates no
/// model and performs no content I/O; material contains previously attested receipts.
pub(crate) async fn prepare_route<V: RouteMaterialVerifier030>(
    runtime: &FlowHost030,
    host: &HostState,
    pool: &SqlitePool,
    owner: &EngineOwner,
    reference: &PrepareRef030,
    material: NativeRouteMaterial030,
    verifier: &V,
    cancelled: &tokio_util::sync::CancellationToken,
) -> Result<Apply030> {
    let job = capture_route_preparation(runtime, host, pool, owner, reference, material, verifier)
        .await?;
    let lease = host.start_lease().await?;
    if lease.generation() != job.generation {
        return Err(refused());
    }
    let result = lease.prepare_route030(job.input_json()?, cancelled).await?;
    lease.ensure_live()?;
    // Do not recursively acquire a lifecycle read lease behind a queued writer.
    drop(lease);
    if cancelled.is_cancelled() {
        return Err(failure(
            "INTERRUPTED",
            "route",
            "Route preparation was cancelled",
        ));
    }
    apply_route_preparation(runtime, host, pool, &job, &result, verifier).await
}

fn route_prepared_result(
    job: &CapturedRoutePreparation030,
    result_json: &str,
) -> Result<(PreparedResult030, Vec<OccurrenceProvenance030>)> {
    if result_json.len() > 8_000_000 {
        return Err(failure(
            "INPUT_LIMIT",
            "route",
            "Route preparation exceeds the transport limit",
        ));
    }
    repository::validate_json(result_json)?;
    match serde_json::from_str::<RoutePreparationOutput030>(result_json)? {
        RoutePreparationOutput030::Failed {
            target_ordinal,
            error,
        } => Ok((
            PreparedResult030::Failed {
                target_ordinal,
                error,
            },
            vec![],
        )),
        RoutePreparationOutput030::Ready {
            batches,
            provenance,
        } => {
            let source = route_material_source(&job.material, &job.producer)?;
            let mut expected = BTreeMap::new();
            for (ordinal, batch) in batches.iter().enumerate() {
                if batch.target_ordinal != ordinal {
                    return Err(refused());
                }
                for (index, item) in batch.items.iter().enumerate() {
                    let occurrence = &item.occurrence;
                    if occurrence.native_receipt_id != job.receipt_id
                        || occurrence.target_ordinal != ordinal
                        || occurrence.item_index != index.to_string()
                    {
                        return Err(refused());
                    }
                    expected.insert((ordinal, index.to_string()), false);
                }
            }
            if provenance.len() != expected.len() {
                return Err(refused());
            }
            for proof in &provenance {
                let occurrence = &proof.occurrence;
                let seen = expected
                    .get_mut(&(occurrence.target_ordinal, occurrence.item_index.clone()))
                    .ok_or_else(refused)?;
                if *seen
                    || occurrence.native_receipt_id != job.receipt_id
                    || proof.producer != job.producer
                    || proof.source != source
                    || !proof.prompt.is_object()
                {
                    return Err(refused());
                }
                *seen = true;
            }
            Ok((PreparedResult030::Ready { batches }, provenance))
        }
    }
}

/// The pure broker result, its native source proof and every occurrence commit
/// atomically with the reducer transition. A stale preparation leaves no rows.
pub(crate) async fn apply_route_preparation<V: RouteMaterialVerifier030>(
    runtime: &FlowHost030,
    host: &HostState,
    pool: &SqlitePool,
    job: &CapturedRoutePreparation030,
    result_json: &str,
    verifier: &V,
) -> Result<Apply030> {
    let (prepared, provenance) = route_prepared_result(job, result_json)?;
    let lease = host.start_lease().await?;
    let _admission = host.admission_lock().lock_owned().await;
    if lease.generation() != job.generation || lease.owner(&job.owner.system_start_id)? != job.owner
    {
        return Err(refused());
    }
    runtime.available(&job.reference.identity)?;
    let authority = Authority {
        runtime,
        lease: &lease,
        owner: job.owner.clone(),
    };
    let mut db = pool.acquire().await?;
    sqlx::query("PRAGMA synchronous=FULL")
        .execute(&mut *db)
        .await?;
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    let capture = route_capture_tx(&mut tx, &authority, &job.reference.identity).await?;
    if digest(&capture)? != digest(&job.capture)? {
        return Err(refused());
    }
    let id = &job.reference.identity;
    let event_id = format!("prepared:{}", job.receipt_id);
    let preparation_effect_id: String = sqlx::query_scalar("SELECT preparation_effect_id FROM engine_flow030_route_source_attestations WHERE system_id=? AND invocation_id=? AND prepare_id=? AND owner_epoch=? AND generation=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&job.reference.prepare_id)
        .bind(&job.owner.owner_epoch).bind(&job.generation).fetch_one(&mut *tx).await?;
    let existing = sqlx::query("SELECT native_receipt_id,owner_epoch,generation,reference_json,producer_json,source_json,content_receipts_json,result_json FROM engine_flow030_preparations WHERE system_id=? AND invocation_id=? AND prepare_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&job.reference.prepare_id).fetch_optional(&mut *tx).await?;
    let expected_revision;
    if let Some(row) = existing.as_ref() {
        let expected = [
            job.receipt_id.clone(),
            job.owner.owner_epoch.clone(),
            job.generation.clone(),
            serde_json::to_string(&job.reference)?,
            serde_json::to_string(&job.producer)?,
            job.material.source_json.clone(),
            job.material.content_receipts_json.clone(),
            result_json.to_owned(),
        ];
        for (field, value) in [
            "native_receipt_id",
            "owner_epoch",
            "generation",
            "reference_json",
            "producer_json",
            "source_json",
            "content_receipts_json",
            "result_json",
        ]
        .iter()
        .zip(expected)
        {
            if row.get::<String, _>(*field) != value {
                return Err(refused());
            }
        }
        let encoded: String = sqlx::query_scalar("SELECT event_json FROM engine_flow030_events WHERE system_id=? AND invocation_id=? AND event_id=?")
            .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&event_id).fetch_one(&mut *tx).await?;
        expected_revision = serde_json::from_str::<Value>(&encoded)?
            .get("expectedRevision")
            .and_then(Value::as_str)
            .ok_or_else(refused)?
            .to_owned();
    } else {
        let view = flow_store030::read_tx(&mut tx, &authority, id)
            .await
            .map_err(store_error)?;
        if view.state.stopping
            || view.state.verdict.is_some()
            || !view.state.preparations.iter().any(|p| {
                p.reference == job.reference && p.producer == job.producer && p.status == "pending"
            })
        {
            return Err(refused());
        }
        verifier
            .attest_tx(
                &mut tx,
                &capture,
                &job.reference,
                &job.producer,
                &job.material,
            )
            .await
            .map_err(store_error)?;
        let claimed = flow_store030::claim_tx(&mut tx, &authority, id, &preparation_effect_id)
            .await
            .map_err(store_error)?;
        if !matches!(&claimed.kind, FlowEffectKind030::PrepareRoute { reference, producer }
            if reference == &job.reference && producer == &job.producer)
        {
            return Err(refused());
        }
        expected_revision = view.state.revision;
        sqlx::query("INSERT INTO engine_flow030_preparations(system_id,invocation_id,prepare_id,native_receipt_id,owner_epoch,generation,reference_json,producer_json,source_json,content_receipts_json,result_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
            .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&job.reference.prepare_id).bind(&job.receipt_id).bind(&job.owner.owner_epoch).bind(&job.generation)
            .bind(serde_json::to_string(&job.reference)?).bind(serde_json::to_string(&job.producer)?).bind(&job.material.source_json).bind(&job.material.content_receipts_json).bind(result_json).execute(&mut *tx).await?;
        for proof in &provenance {
            let ordinal = i64::try_from(proof.occurrence.target_ordinal).map_err(|_| refused())?;
            sqlx::query("INSERT INTO engine_flow030_occurrence_provenance(system_id,invocation_id,native_receipt_id,target_ordinal,item_index,provenance_json) VALUES(?,?,?,?,?,?)")
                .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&job.receipt_id).bind(ordinal).bind(&proof.occurrence.item_index).bind(serde_json::to_string(proof)?).execute(&mut *tx).await?;
        }
    }
    let event = FlowEvent030 {
        identity: id.clone(),
        event_id,
        expected_revision,
        kind: FlowEventKind030::Prepared {
            reference: job.reference.clone(),
            native_receipt_id: job.receipt_id.clone(),
            result: prepared,
        },
    };
    let result = flow_store030::apply_tx(&mut tx, &authority, &event)
        .await
        .map_err(store_error)?;
    let settlement = json!({"kind":"nativeRoutePrepared030", "prepareId":job.reference.prepare_id,
        "nativeReceiptId":job.receipt_id});
    flow_store030::settle_tx(&mut tx, &authority, id, &preparation_effect_id, &settlement)
        .await
        .map_err(store_error)?;
    lease.ensure_live()?;
    runtime.begin_event_commit(&event)?;
    tx.commit().await.map_err(|_| uncertain())?;
    lease.ensure_live().map_err(|_| uncertain())?;
    runtime.acknowledge_event_commit(&event);
    Ok(result)
}

/// Resolve this process's pending preparation COMMIT by its sealed native job.
/// Absence leaves the barrier untouched and never authorizes another effect.
pub(crate) async fn inspect_route_preparation_commit(
    runtime: &FlowHost030,
    host: &HostState,
    pool: &SqlitePool,
    job: &CapturedRoutePreparation030,
) -> Result<Option<Apply030>> {
    let key = (
        job.reference.identity.system_start_id.clone(),
        format!("prepared:{}", job.receipt_id),
    );
    let event = runtime
        .event_committing
        .lock()
        .map_err(|_| unavailable())?
        .get(&key)
        .cloned();
    match event {
        Some(event) if event.identity == job.reference.identity => {
            inspect_native_event_commit(runtime, host, pool, &event).await
        }
        Some(_) => Err(refused()),
        None => Ok(None),
    }
}

struct Unadmitted030 {
    owner: EngineOwner,
    generation: String,
    effect: FlowEffect030,
}

/// Lives from before claim COMMIT until the owned executor is released. Drop
/// records positive process-local knowledge, not an absence from a task list.
struct UnadmittedClaimGuard030<'a> {
    runtime: &'a FlowHost030,
    witness: Option<Unadmitted030>,
}
impl Drop for UnadmittedClaimGuard030<'_> {
    fn drop(&mut self) {
        if let Some(witness) = self.witness.take() {
            if matches!(&witness.effect.kind, FlowEffectKind030::Start { .. }) {
                if let Ok(mut pending) = self.runtime.unadmitted.lock() {
                    pending
                        .entry((
                            witness.effect.identity.system_start_id.clone(),
                            witness.effect.id.clone(),
                        ))
                        .or_insert(witness);
                }
            }
        }
    }
}

/// Not Clone/Deserialize. Dropping it after COMMIT leaves the claim uncertain;
/// it never becomes a fresh pending effect. The gate spans COMMIT to handoff.
pub(crate) struct DispatchLease030<'a> {
    // Drop this witness before releasing the admission exclusion or lifecycle lease.
    unadmitted: UnadmittedClaimGuard030<'a>,
    runtime: &'a FlowHost030,
    lease: HostStartLease,
    _admission: OwnedMutexGuard<()>,
    pool: SqlitePool,
    owner: EngineOwner,
    effect: FlowEffect030,
}

/// An exact StopWork claim. Dropping it never makes an uncertain claim pending.
pub(crate) struct ClaimedStopWork030 {
    control: Arc<FlowControl030>,
    effect: FlowEffect030,
    owner: EngineOwner,
    generation: String,
}
impl ClaimedStopWork030 {
    pub(crate) fn control(&self) -> &Arc<FlowControl030> {
        &self.control
    }
}

enum Handoff030 {
    Host,
    Agent {
        attempt: FlowWorkAttempt030,
        policy: AttestedWorkPolicy030,
    },
}
impl DispatchLease030<'_> {
    pub(crate) fn effect(&self) -> &FlowEffect030 {
        &self.effect
    }
    pub(crate) fn request_id(&self) -> String {
        format!(
            "flow030:{}:{}",
            self.effect.identity.system_start_id, self.effect.id
        )
    }
    /// Retain the exact claimed cancellation while releasing admission before
    /// waiting for the already-owned agent. SQL remains uncertain on drop.
    pub(crate) fn into_stop_work(self, attempt: &FlowWorkAttempt030) -> Result<ClaimedStopWork030> {
        self.runtime.available(&self.effect.identity)?;
        self.lease.ensure_live()?;
        let FlowEffectKind030::StopWork {
            work,
            include_descendants: true,
        } = &self.effect.kind
        else {
            return Err(refused());
        };
        if attempt.identity() != &self.effect.identity
            || attempt.owner() != &self.owner
            || attempt.generation() != self.lease.generation()
            || work.activation_id != attempt.work().activation_id
            || work.start_effect_id != attempt.start_effect_id()
            || work.agent_instance_id != attempt.work().agent_instance_id
        {
            return Err(refused());
        }
        let control = self
            .runtime
            .controls
            .lock()
            .map_err(|_| unavailable())?
            .get(&self.effect.identity.system_start_id)
            .cloned()
            .ok_or_else(refused)?;
        if control.identity != self.effect.identity
            || control.owner != self.owner
            || control.generation != self.lease.generation()
        {
            return Err(refused());
        }
        Ok(ClaimedStopWork030 {
            control,
            effect: self.effect.clone(),
            owner: self.owner.clone(),
            generation: self.lease.generation().into(),
        })
    }

    /// The future must perform no physical work until polled. A constructor
    /// which already spawned a process cannot use this admission boundary.
    pub(crate) async fn handoff_host<F>(
        self,
        tasks: &crate::ai::stream_tasks::StreamTasks,
        work: F,
    ) -> Result<()>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        if matches!(
            &self.effect.kind,
            FlowEffectKind030::Start { agent: Some(_), .. }
        ) {
            return Err(refused());
        }
        self.handoff_inner(tasks, work, Handoff030::Host).await
    }

    /// The factory must only build a future; no IO or spawn may occur until it
    /// is polled after the acknowledged handoff commit. The native host must
    /// separately authorize policy and each exact provider operation via 036.
    pub(crate) async fn handoff_agent<C, F>(
        self,
        tasks: &crate::ai::stream_tasks::StreamTasks,
        policy: AttestedWorkPolicy030,
        make_work: C,
    ) -> Result<()>
    where
        C: FnOnce(FlowWorkAttempt030) -> F,
        F: Future<Output = ()> + Send + 'static,
    {
        self.runtime.available(&self.effect.identity)?;
        self.lease.ensure_live()?;
        let FlowEffectKind030::Start {
            work,
            step,
            agent: Some(agent),
            ..
        } = &self.effect.kind
        else {
            return Err(refused());
        };
        if work.start_effect_id != self.effect.id
            || work.activation_id.is_empty()
            || work.agent_instance_id.as_ref().is_none_or(String::is_empty)
            || agent.is_empty()
            || self.owner.system_start_id != self.effect.identity.system_start_id
        {
            return Err(refused());
        }
        let attempt = FlowWorkAttempt030 {
            identity: self.effect.identity.clone(),
            owner: self.owner.clone(),
            generation: self.lease.generation().into(),
            work: repository::dto::EngineWork {
                system_start_id: self.effect.identity.system_start_id.clone(),
                flow_invocation_id: self.effect.identity.flow_invocation_id.clone(),
                activation_id: work.activation_id.clone(),
                step: step.clone(),
                agent_instance_id: work.agent_instance_id.clone(),
            },
            start_effect_id: self.effect.id.clone(),
            agent: agent.clone(),
            provider_attempt_id: uuid::Uuid::new_v4().to_string(),
        };
        let work = make_work(attempt.clone());
        self.handoff_inner(tasks, work, Handoff030::Agent { attempt, policy })
            .await
    }

    async fn handoff_inner<F>(
        mut self,
        tasks: &crate::ai::stream_tasks::StreamTasks,
        work: F,
        handoff: Handoff030,
    ) -> Result<()>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        self.runtime.available(&self.effect.identity)?;
        let attempt = match &handoff {
            Handoff030::Host => None,
            Handoff030::Agent { attempt, .. } => Some(attempt),
        };
        let request_id = self.request_id();
        let (release, ready) = tokio::sync::oneshot::channel();
        let owned = async move {
            // The registry owns the future before its first poll. Effect IO
            // waits for an acknowledged commit of the handoff receipt.
            if ready.await.is_ok() {
                work.await;
            }
        };
        if let Some(attempt) = attempt {
            self.lease
                .admit_owned_agent_stream030(attempt, tasks, request_id.clone(), owned)?;
        } else {
            self.lease
                .admit_owned_stream(&self.owner, tasks, request_id.clone(), owned)?;
        }
        let mut receipt = json!({"kind":"nativeOwnedHandoff030", "identity":self.effect.identity,
            "effectId":self.effect.id, "ownerEpoch":self.owner.owner_epoch,
            "generation":self.lease.generation(), "requestId":request_id});
        if let Some(attempt) = attempt {
            receipt["workAttempt"] = serde_json::to_value(attempt)?;
        }
        let authority = Authority {
            runtime: self.runtime,
            owner: self.owner.clone(),
            lease: &self.lease,
        };
        let mut db = self.pool.acquire().await.map_err(|_| uncertain())?;
        sqlx::query("PRAGMA synchronous=FULL")
            .execute(&mut *db)
            .await
            .map_err(|_| uncertain())?;
        let mut tx = db
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|_| uncertain())?;
        authority
            .owner(&mut tx, &self.effect.identity)
            .await
            .map_err(|_| uncertain())?;
        sqlx::query("INSERT INTO engine_flow030_handoffs(system_id,invocation_id,effect_id,owner_epoch,generation,receipt_json) VALUES(?,?,?,?,?,?)")
            .bind(&self.effect.identity.system_start_id).bind(&self.effect.identity.flow_invocation_id).bind(&self.effect.id)
            .bind(&self.owner.owner_epoch).bind(self.lease.generation()).bind(receipt.to_string()).execute(&mut *tx).await.map_err(|_| uncertain())?;
        if let Handoff030::Agent { attempt, policy } = &handoff {
            work_admission::admit_agent_work_tx(&mut tx, &self.lease, attempt, policy)
                .await
                .map_err(|_| uncertain())?;
        }
        flow_store030::settle_tx(
            &mut tx,
            &authority,
            &self.effect.identity,
            &self.effect.id,
            &receipt,
        )
        .await
        .map_err(|_| uncertain())?;
        tx.commit().await.map_err(|_| uncertain())?;
        #[cfg(test)]
        self.runtime.pause_after_handoff_commit(&self.effect).await;
        // Revocation and release share one synchronous boundary. The owner
        // removes its no-admission witness only after life/ownership validation
        // under that guard, before the future can perform any IO.
        self.lease
            .release_owned_stream030(&self.owner, release, || {
                self.unadmitted.witness = None;
            })
            .map_err(|_| uncertain())?;
        Ok(())
    }
}

pub(crate) async fn claim_next<'a>(
    runtime: &'a FlowHost030,
    host: &HostState,
    pool: &SqlitePool,
    id: &FlowIdentity030,
) -> Result<Option<DispatchLease030<'a>>> {
    claim_selected(runtime, host, pool, id, None, None).await
}

/// A prepared policy cannot choose a different effect when the queue changes.
/// Inspect the first eligible effect in the claim's own SQL snapshot before
/// any mutation. Route preparation always uses its dedicated atomic path.
pub(crate) async fn claim_expected<'a>(
    runtime: &'a FlowHost030,
    host: &HostState,
    pool: &SqlitePool,
    id: &FlowIdentity030,
    expected_effect_id: &str,
) -> Result<Option<DispatchLease030<'a>>> {
    if expected_effect_id.is_empty() {
        return Err(refused());
    }
    claim_selected(runtime, host, pool, id, Some(expected_effect_id), None).await
}

/// Validate the exact stopped work and incarnation in the claim transaction,
/// before changing the outbox status to uncertain.
pub(crate) async fn claim_expected_stop_work<'a>(
    runtime: &'a FlowHost030,
    host: &HostState,
    pool: &SqlitePool,
    effect: &FlowEffect030,
    attempt: &FlowWorkAttempt030,
) -> Result<Option<DispatchLease030<'a>>> {
    if effect.id.is_empty() {
        return Err(refused());
    }
    claim_selected(
        runtime,
        host,
        pool,
        &effect.identity,
        Some(&effect.id),
        Some((effect, attempt)),
    )
    .await
}

async fn claim_selected<'a>(
    runtime: &'a FlowHost030,
    host: &HostState,
    pool: &SqlitePool,
    id: &FlowIdentity030,
    expected_effect_id: Option<&str>,
    expected_stop: Option<(&FlowEffect030, &FlowWorkAttempt030)>,
) -> Result<Option<DispatchLease030<'a>>> {
    let lease = host.start_lease().await?;
    let admission = host.admission_lock().lock_owned().await;
    // Even an empty queue is not a successful claim while a commit is unknown.
    // Retirement uses its separate opaque FlowControl, never this dispatcher.
    runtime.available(id)?;
    let owner = lease.owner(&id.system_start_id)?;
    let authority = Authority {
        runtime,
        lease: &lease,
        owner: owner.clone(),
    };
    let mut db = pool.acquire().await?;
    sqlx::query("PRAGMA synchronous=FULL")
        .execute(&mut *db)
        .await?;
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    authority.owner(&mut tx, id).await.map_err(store_error)?;
    let mut effects: Vec<String> = sqlx::query_scalar("SELECT effect_id FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? AND status='pending' ORDER BY rowid")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).fetch_all(&mut *tx).await?;
    if let Some(expected) = expected_effect_id {
        let view = flow_store030::read_tx(&mut tx, &authority, id)
            .await
            .map_err(store_error)?;
        let mut first = None;
        for effect_id in &effects {
            let row = sqlx::query("SELECT effect_json,owner_epoch FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? AND effect_id=?")
                .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(effect_id)
                .fetch_one(&mut *tx).await?;
            if row.get::<&str, _>("owner_epoch") != owner.owner_epoch {
                continue;
            }
            let effect: FlowEffect030 = serde_json::from_str(row.get("effect_json"))?;
            if effect.id == *effect_id && flow_store030::eligible(&view.state, &effect) {
                first = Some(effect);
                break;
            }
        }
        let Some(effect) = first else {
            tx.rollback().await?;
            return Ok(None);
        };
        if effect.id != expected || matches!(&effect.kind, FlowEffectKind030::PrepareRoute { .. }) {
            tx.rollback().await?;
            return Ok(None);
        }
        if let Some((expected_effect, attempt)) = expected_stop {
            let matching_work = matches!(&effect.kind,
                FlowEffectKind030::StopWork { work, include_descendants: true }
                    if work.activation_id == attempt.work().activation_id
                        && work.start_effect_id == attempt.start_effect_id()
                        && work.agent_instance_id == attempt.work().agent_instance_id);
            let matching_control = runtime
                .controls
                .lock()
                .map_err(|_| unavailable())?
                .get(&id.system_start_id)
                .is_some_and(|control| {
                    control.identity == *id
                        && control.owner == owner
                        && control.generation == lease.generation()
                });
            if &effect != expected_effect
                || attempt.identity() != id
                || attempt.owner() != &owner
                || attempt.generation() != lease.generation()
                || !matching_work
                || !matching_control
            {
                tx.rollback().await?;
                return Err(refused());
            }
            let matching_activation = view
                .state
                .activations
                .iter()
                .filter(|activation| {
                    activation.id == attempt.work().activation_id
                        && activation.step == attempt.work().step
                        && activation.instance_id == attempt.work().agent_instance_id
                        && activation.start_effect_id.as_deref() == Some(attempt.start_effect_id())
                        && activation.agent.as_deref() == Some(attempt.agent())
                })
                .count()
                == 1;
            let raw: Option<String> = sqlx::query_scalar("SELECT receipt_json FROM engine_flow030_handoffs WHERE system_id=? AND invocation_id=? AND effect_id=? AND owner_epoch=? AND generation=?")
                .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(attempt.start_effect_id())
                .bind(&owner.owner_epoch).bind(lease.generation()).fetch_optional(&mut *tx).await?;
            let handoff: Option<Value> = raw.as_deref().map(serde_json::from_str).transpose()?;
            let request_id = format!(
                "flow030:{}:{}",
                id.system_start_id,
                attempt.start_effect_id()
            );
            let expected_identity = serde_json::to_value(id)?;
            let expected_attempt = serde_json::to_value(attempt)?;
            let matching_handoff = handoff.as_ref().is_some_and(|value| {
                value.get("kind").and_then(Value::as_str) == Some("nativeOwnedHandoff030")
                    && value.get("identity") == Some(&expected_identity)
                    && value.get("effectId").and_then(Value::as_str)
                        == Some(attempt.start_effect_id())
                    && value.get("ownerEpoch").and_then(Value::as_str)
                        == Some(owner.owner_epoch.as_str())
                    && value.get("generation").and_then(Value::as_str) == Some(lease.generation())
                    && value.get("requestId").and_then(Value::as_str) == Some(request_id.as_str())
                    && value.get("workAttempt") == Some(&expected_attempt)
            });
            if !matching_activation || !matching_handoff {
                tx.rollback().await?;
                return Err(refused());
            }
        }
        // Never fall back to another effect after inspecting the expected one.
        effects = vec![effect.id];
    }
    for effect_id in effects {
        match flow_store030::claim_tx(&mut tx, &authority, id, &effect_id).await {
            Ok(effect) => {
                let unadmitted = UnadmittedClaimGuard030 {
                    runtime,
                    witness: Some(Unadmitted030 {
                        owner: owner.clone(),
                        generation: lease.generation().into(),
                        effect: effect.clone(),
                    }),
                };
                lease.ensure_live()?;
                tx.commit().await.map_err(|_| uncertain())?;
                lease.ensure_live().map_err(|_| uncertain())?;
                return Ok(Some(DispatchLease030 {
                    unadmitted,
                    runtime,
                    lease,
                    _admission: admission,
                    pool: pool.clone(),
                    owner,
                    effect,
                }));
            }
            Err(StoreError030::NotClaimable) => continue,
            Err(error) => return Err(store_error(error)),
        }
    }
    if expected_effect_id.is_some() {
        tx.rollback().await?;
    } else {
        tx.commit().await?;
    }
    Ok(None)
}

/// Called by the native retirement supervisor, after synchronous revocation.
/// It fences ordinary operations without making uncertain effects pending again.
pub(crate) async fn revoke_generation(pool: &SqlitePool, generation: &str) -> Result<()> {
    let mut db = pool.acquire().await?;
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    sqlx::query(
        "UPDATE engine_flow030_owners SET status='revoked' WHERE generation=? AND status='live'",
    )
    .bind(generation)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeSystemStopReceipt030 {
    pub request_id: String,
    pub identity: FlowIdentity030,
    pub owner_epoch: String,
    pub generation: String,
    pub before_revision: String,
    pub revision: String,
    pub stopping: bool,
    pub verdict: Option<String>,
    pub flow_event_id: Option<String>,
}

/// Logical acknowledgement plus a genuine cleanup capability. This wrapper is
/// not serializable and its receipt alone is not a physical termination proof.
pub(crate) struct NativeSystemStop030 {
    receipt: NativeSystemStopReceipt030,
    control: Arc<FlowControl030>,
}
impl NativeSystemStop030 {
    pub(crate) fn receipt(&self) -> &NativeSystemStopReceipt030 {
        &self.receipt
    }
    pub(crate) fn control(&self) -> &Arc<FlowControl030> {
        &self.control
    }
}

fn stop_marker(receipt: &NativeSystemStopReceipt030) -> FlowEvent030 {
    FlowEvent030 {
        identity: receipt.identity.clone(),
        event_id: format!("system-stop:{}", receipt.request_id),
        expected_revision: receipt.before_revision.clone(),
        kind: FlowEventKind030::Stop,
    }
}

fn system_stop_control(
    runtime: &FlowHost030,
    request: &EngineStopRequest,
) -> Result<Arc<FlowControl030>> {
    // A legacy activation-specific request must never acquire a broader scope.
    if request.activation_id.is_some() {
        return Err(failure(
            "PARTIAL_STOP_UNAVAILABLE",
            "activationId",
            "Native 0.3 activation Stop requires a separate scoped operation",
        ));
    }
    if request.request_id.trim().is_empty()
        || request.request_id.len() > 512
        || request.request_id.chars().any(char::is_control)
    {
        return Err(refused());
    }
    runtime
        .controls
        .lock()
        .map_err(|_| unavailable())?
        .get(&request.system_start_id)
        .cloned()
        .ok_or_else(|| {
            failure(
                "RUNTIME_UNAVAILABLE",
                "systemStartId",
                "Native 0.3 cleanup capability is unavailable",
            )
        })
}

async fn stored_system_stop(
    db: &mut SqliteConnection,
    control: &FlowControl030,
    request: &EngineStopRequest,
) -> Result<Option<NativeSystemStopReceipt030>> {
    control
        .owner(db, &control.identity)
        .await
        .map_err(store_error)?;
    let row = sqlx::query("SELECT system_id,invocation_id,owner_epoch,generation,request_json,receipt_json,event_id FROM engine_flow030_system_stop_requests WHERE request_id=?")
        .bind(&request.request_id).fetch_optional(&mut *db).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let receipt: NativeSystemStopReceipt030 = serde_json::from_str(row.get("receipt_json"))?;
    if row.get::<&str, _>("system_id") != request.system_start_id
        || row.get::<&str, _>("invocation_id") != control.identity.flow_invocation_id
        || row.get::<&str, _>("owner_epoch") != control.owner.owner_epoch
        || row.get::<&str, _>("generation") != control.generation
        || row.get::<String, _>("request_json") != serde_json::to_string(request)?
        || receipt.request_id != request.request_id
        || receipt.identity != control.identity
        || receipt.owner_epoch != control.owner.owner_epoch
        || receipt.generation != control.generation
        || receipt.flow_event_id != row.get::<Option<String>, _>("event_id")
    {
        return Err(refused());
    }
    if let Some(event_id) = &receipt.flow_event_id {
        let marker = stop_marker(&receipt);
        let raw: String = sqlx::query_scalar("SELECT event_json FROM engine_flow030_events WHERE system_id=? AND invocation_id=? AND event_id=?")
            .bind(&control.identity.system_start_id).bind(&control.identity.flow_invocation_id).bind(event_id).fetch_one(&mut *db).await?;
        if *event_id != marker.event_id || raw != serde_json::to_string(&marker)? {
            return Err(refused());
        }
    }
    Ok(Some(receipt))
}

/// Product request identity is durable and idempotent. A second request on an
/// already-stopping/terminal run records an alias without reapplying Stop.
/// This method releases the exclusion before the caller cancels/joins tasks.
pub(crate) async fn request_system_stop030(
    runtime: &FlowHost030,
    pool: &SqlitePool,
    request: &EngineStopRequest,
) -> Result<NativeSystemStop030> {
    let control = system_stop_control(runtime, request)?;
    let _admission = control.admission.clone().lock_owned().await;
    let mut db = pool.acquire().await?;
    sqlx::query("PRAGMA synchronous=FULL")
        .execute(&mut *db)
        .await?;
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    if let Some(receipt) = stored_system_stop(&mut tx, &control, request).await? {
        tx.commit().await?;
        runtime.acknowledge_event_commit(&stop_marker(&receipt));
        return Ok(NativeSystemStop030 { receipt, control });
    }
    // An absent receipt never establishes rollback. Reconcile an existing
    // uncertain commit before attempting any new Stop or alias mutation.
    runtime.available(&control.identity)?;
    let view = flow_store030::read_tx(&mut tx, control.as_ref(), &control.identity)
        .await
        .map_err(store_error)?;
    let mut receipt = NativeSystemStopReceipt030 {
        request_id: request.request_id.clone(),
        identity: control.identity.clone(),
        owner_epoch: control.owner.owner_epoch.clone(),
        generation: control.generation.clone(),
        before_revision: view.state.revision.clone(),
        revision: view.state.revision,
        stopping: view.state.stopping,
        verdict: view.state.verdict,
        flow_event_id: None,
    };
    let marker = stop_marker(&receipt);
    if !receipt.stopping && receipt.verdict.is_none() {
        let outcome = flow_store030::apply_tx(&mut tx, control.as_ref(), &marker)
            .await
            .map_err(store_error)?;
        match outcome {
            Apply030::Applied(value) | Apply030::Replayed(value) => {
                receipt.revision = value.revision
            }
            Apply030::Diagnostic(_) => return Err(refused()),
        }
        let after = flow_store030::read_tx(&mut tx, control.as_ref(), &control.identity)
            .await
            .map_err(store_error)?
            .state;
        if after.revision != receipt.revision {
            return Err(refused());
        }
        receipt.stopping = after.stopping;
        receipt.verdict = after.verdict;
        receipt.flow_event_id = Some(marker.event_id.clone());
    }
    sqlx::query("INSERT INTO engine_flow030_system_stop_requests(request_id,system_id,invocation_id,owner_epoch,generation,request_json,receipt_json,event_id) VALUES(?,?,?,?,?,?,?,?)")
        .bind(&request.request_id).bind(&control.identity.system_start_id).bind(&control.identity.flow_invocation_id).bind(&control.owner.owner_epoch).bind(&control.generation)
        .bind(serde_json::to_string(request)?).bind(serde_json::to_string(&receipt)?).bind(&receipt.flow_event_id).execute(&mut *tx).await?;
    runtime.begin_event_commit(&marker)?;
    tx.commit().await.map_err(|_| uncertain())?;
    #[cfg(test)]
    runtime
        .pause_after_system_stop_commit(&request.request_id)
        .await;
    runtime.acknowledge_event_commit(&marker);
    Ok(NativeSystemStop030 { receipt, control })
}

/// Only a matching committed request resolves an unknown Stop COMMIT. None
/// leaves its barrier in place; this read never requests or retries a Stop.
pub(crate) async fn inspect_system_stop_request030(
    runtime: &FlowHost030,
    pool: &SqlitePool,
    request: &EngineStopRequest,
) -> Result<Option<NativeSystemStop030>> {
    let control = system_stop_control(runtime, request)?;
    let _admission = control.admission.clone().lock_owned().await;
    let mut db = pool.acquire().await?;
    let mut tx = db.begin().await?;
    let receipt = stored_system_stop(&mut tx, &control, request).await?;
    tx.commit().await?;
    Ok(receipt.map(|receipt| {
        runtime.acknowledge_event_commit(&stop_marker(&receipt));
        NativeSystemStop030 { receipt, control }
    }))
}

/// Native cleanup capability, retained before Start can commit. It has neither
/// Deserialize nor an external constructor and cannot claim a new effect.
pub(crate) struct FlowControl030 {
    owner: EngineOwner,
    identity: FlowIdentity030,
    generation: String,
    admission: Arc<tokio::sync::Mutex<()>>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NoAdmissionReceipt030 {
    identity: FlowIdentity030,
    work: WorkRef030,
    owner_epoch: String,
    generation: String,
    native_receipt_id: String,
    reason: String,
}

impl FlowControl030 {
    pub(crate) fn identity(&self) -> &FlowIdentity030 {
        &self.identity
    }

    /// Settle only an already-stopping work item whose joined owner previously
    /// produced a durable terminal diagnostic. No witness is reconstructed.
    pub(crate) async fn settle_joined_diagnostic(
        &self,
        runtime: &FlowHost030,
        pool: &SqlitePool,
        joined: &JoinedOwnedAgent030,
        claim: Option<&ClaimedStopWork030>,
    ) -> Result<Apply030> {
        let attempt = joined.attempt();
        if attempt.identity() != &self.identity
            || attempt.owner() != &self.owner
            || attempt.generation() != self.generation
            || joined.request_id()
                != format!(
                    "flow030:{}:{}",
                    self.identity.system_start_id,
                    attempt.start_effect_id()
                )
            || !runtime
                .controls
                .lock()
                .map_err(|_| unavailable())?
                .get(&self.identity.system_start_id)
                .is_some_and(|c| std::ptr::eq(c.as_ref(), self))
        {
            return Err(refused());
        }
        let _admission = self.admission.clone().lock_owned().await;
        let mut db = pool.acquire().await?;
        sqlx::query("PRAGMA synchronous=FULL")
            .execute(&mut *db)
            .await?;
        let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
        let view = flow_store030::read_tx(&mut tx, self, &self.identity)
            .await
            .map_err(store_error)?;
        // A revoked generation may record cleanup after the global Stop has
        // fenced routing. Before that Stop, a group claim must not release a
        // fresh continuation through the cleanup-only control authority.
        if claim.is_some() && !view.state.stopping {
            let live: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM engine_flow030_owners WHERE system_id=? AND invocation_id=? AND owner_epoch=? AND generation=? AND status='live')")
                .bind(&self.identity.system_start_id).bind(&self.identity.flow_invocation_id)
                .bind(&self.owner.owner_epoch).bind(&self.generation).fetch_one(&mut *tx).await?;
            if !live {
                return Err(refused());
            }
        }
        let activation = view
            .state
            .activations
            .iter()
            .find(|a| a.id == attempt.work().activation_id)
            .ok_or_else(refused)?;
        if activation.step != attempt.work().step
            || activation.instance_id != attempt.work().agent_instance_id
            || activation.start_effect_id.as_deref() != Some(attempt.start_effect_id())
        {
            return Err(refused());
        }
        let stop_effect_id = activation.stop_effect_id.as_ref().ok_or_else(refused)?;
        let work = WorkRef030 {
            activation_id: attempt.work().activation_id.clone(),
            start_effect_id: attempt.start_effect_id().to_owned(),
            agent_instance_id: attempt.work().agent_instance_id.clone(),
        };
        let handoff: String = sqlx::query_scalar("SELECT receipt_json FROM engine_flow030_handoffs WHERE system_id=? AND invocation_id=? AND effect_id=? AND owner_epoch=? AND generation=?")
            .bind(&self.identity.system_start_id).bind(&self.identity.flow_invocation_id).bind(attempt.start_effect_id()).bind(&self.owner.owner_epoch).bind(&self.generation)
            .fetch_optional(&mut *tx).await?.ok_or_else(refused)?;
        let handoff: Value = serde_json::from_str(&handoff)?;
        if handoff.get("kind").and_then(Value::as_str) != Some("nativeOwnedHandoff030")
            || handoff.get("identity") != Some(&serde_json::to_value(&self.identity)?)
            || handoff.get("effectId").and_then(Value::as_str) != Some(attempt.start_effect_id())
            || handoff.get("ownerEpoch").and_then(Value::as_str)
                != Some(self.owner.owner_epoch.as_str())
            || handoff.get("generation").and_then(Value::as_str) != Some(self.generation.as_str())
            || handoff.get("requestId").and_then(Value::as_str) != Some(joined.request_id())
            || handoff.get("workAttempt") != Some(&serde_json::to_value(attempt)?)
        {
            return Err(refused());
        }
        let protocol_id = format!("physical:{}", attempt.provider_attempt_id());
        if let Some(claim) = claim {
            if !std::ptr::eq(claim.control.as_ref(), self)
                || claim.owner != self.owner
                || claim.generation != self.generation
                || claim.effect.identity != self.identity
                || claim.effect.id != *stop_effect_id
                || !matches!(&claim.effect.kind, FlowEffectKind030::StopWork { work: w, include_descendants: true } if w == &work)
            {
                return Err(refused());
            }
        } else {
            if !view.state.stopping {
                return Err(refused());
            }
            let terminal_id = work_terminal_event_id030(&self.identity, &protocol_id)?;
            let terminal = sqlx::query("SELECT event_json,diagnostic_json FROM engine_flow030_events WHERE system_id=? AND invocation_id=? AND event_id=? AND receipt_json IS NULL AND diagnostic_json IS NOT NULL")
            .bind(&self.identity.system_start_id).bind(&self.identity.flow_invocation_id).bind(&terminal_id).fetch_optional(&mut *tx).await?.ok_or_else(refused)?;
            let terminal_event: Value = serde_json::from_str(terminal.get("event_json"))?;
            if terminal_event.get("identity") != Some(&serde_json::to_value(&self.identity)?)
                || terminal_event.get("eventId").and_then(Value::as_str)
                    != Some(terminal_id.as_str())
                || terminal_event.pointer("/kind/WorkResult/work")
                    != Some(&serde_json::to_value(&work)?)
                || terminal_event
                    .pointer("/kind/WorkResult/physical/native_receipt_id")
                    .and_then(Value::as_str)
                    != Some(protocol_id.as_str())
                || terminal_event
                    .pointer("/kind/WorkResult/physical/descendants_joined")
                    .and_then(Value::as_bool)
                    != Some(true)
            {
                return Err(refused());
            }
            let work_event = sqlx::query("SELECT ticket_json,decision_json FROM engine_flow030_work_events WHERE system_id=? AND invocation_id=? AND activation_id=? AND event_id=? AND decision_json IS NOT NULL")
            .bind(&self.identity.system_start_id).bind(&self.identity.flow_invocation_id).bind(&work.activation_id).bind(&protocol_id).fetch_optional(&mut *tx).await?.ok_or_else(refused)?;
            let ticket: Value = serde_json::from_str(work_event.get("ticket_json"))?;
            let decision: Value = serde_json::from_str(work_event.get::<&str, _>("decision_json"))?;
            let input: repository::work_protocol030::ProtocolEvent030 =
                serde_json::from_value(ticket.get("input").cloned().ok_or_else(refused)?)?;
            let authorization = sqlx::query("SELECT input_json,provider_attempt_id,native_call_id FROM engine_flow030_work_authorizations WHERE system_id=? AND invocation_id=? AND activation_id=? AND event_id=?")
            .bind(&self.identity.system_start_id).bind(&self.identity.flow_invocation_id).bind(&work.activation_id).bind(&protocol_id).fetch_optional(&mut *tx).await?.ok_or_else(refused)?;
            let authorized: repository::work_protocol030::ProtocolEvent030 =
                serde_json::from_str(authorization.get("input_json"))?;
            let physical_event: Value = serde_json::from_str(&input.event_json)?;
            if input != authorized
                || !input.control
                || input.native_call.is_some()
                || authorization
                    .get::<Option<&str>, _>("provider_attempt_id")
                    .is_some()
                || authorization
                    .get::<Option<&str>, _>("native_call_id")
                    .is_some()
                || physical_event.get("eventId").and_then(Value::as_str)
                    != Some(protocol_id.as_str())
                || physical_event
                    .pointer("/event/kind")
                    .and_then(Value::as_str)
                    != Some("physicalEnded")
                || physical_event
                    .pointer("/event/providerEnded")
                    .and_then(Value::as_bool)
                    != Some(true)
                || physical_event
                    .pointer("/event/effectsEnded")
                    .and_then(Value::as_bool)
                    != Some(true)
            {
                return Err(refused());
            }
            let context: repository::dto::EngineContext = serde_json::from_value(
                ticket
                    .pointer("/input/context")
                    .cloned()
                    .ok_or_else(refused)?,
            )?;
            let receipt_raw = decision
                .get("receiptJson")
                .and_then(Value::as_str)
                .ok_or_else(refused)?;
            let receipt: Value = serde_json::from_str(receipt_raw)?;
            if context.owner != self.owner
                || context.work != *attempt.work()
                || ticket.get("identity") != Some(&serde_json::to_value(&self.identity)?)
                || ticket.get("generation").and_then(Value::as_str)
                    != Some(self.generation.as_str())
                || ticket.pointer("/input/eventId").and_then(Value::as_str)
                    != Some(protocol_id.as_str())
                || physical_event.get("owner") != receipt.get("owner")
                || receipt.pointer("/decision/kind").and_then(Value::as_str) != Some("finished")
            {
                return Err(refused());
            }
            crate::agsdl_host_work::reserved_check030(&context, receipt_raw)?;
            let finished = receipt.get("decision").ok_or_else(refused)?;
            let expected_result = match finished.get("outcome").and_then(Value::as_str) {
                Some("success") => {
                    let output = finished.get("output").ok_or_else(refused)?;
                    let output_json =
                        crate::agsdl_host_route_verifier030::accepted_output_json(output)
                            .map_err(store_error)?;
                    let route_key = match output.get("choice") {
                        None | Some(Value::Null) => None,
                        Some(Value::String(choice)) => Some(choice.clone()),
                        _ => return Err(refused()),
                    };
                    repository::flow030::WorkResult030::Completed {
                        output_json,
                        route_key,
                    }
                }
                Some("failure") => {
                    let code = finished
                        .get("code")
                        .and_then(Value::as_str)
                        .filter(|code| {
                            matches!(
                                *code,
                                "OUTPUT_INVALID"
                                    | "CHECK_FAILED"
                                    | "PLAN_REJECTED"
                                    | "TIMEOUT"
                                    | "STOPPED"
                                    | "REVOKED"
                                    | "AGENT_FAILED"
                                    | "HARNESS_REFUSED"
                                    | "INTERRUPTED"
                            )
                        })
                        .ok_or_else(refused)?;
                    repository::flow030::WorkResult030::Failed {
                        error: Failure030::new(code),
                    }
                }
                _ => return Err(refused()),
            };
            if terminal_event.pointer("/kind/WorkResult/result")
                != Some(&serde_json::to_value(expected_result)?)
            {
                return Err(refused());
            }
        }
        let row = sqlx::query("SELECT effect_json,status,settlement_json,owner_epoch FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? AND effect_id=?")
            .bind(&self.identity.system_start_id).bind(&self.identity.flow_invocation_id).bind(stop_effect_id).fetch_optional(&mut *tx).await?.ok_or_else(refused)?;
        let effect: FlowEffect030 = serde_json::from_str(row.get("effect_json"))?;
        if effect.id != *stop_effect_id
            || effect.identity != self.identity
            || row.get::<&str, _>("owner_epoch") != self.owner.owner_epoch
            || !matches!(&effect.kind, FlowEffectKind030::StopWork {work: w, include_descendants: true} if w == &work)
        {
            return Err(refused());
        }
        let event_id = work_terminal_event_id030(
            &self.identity,
            &format!("joined-stop:{}", attempt.provider_attempt_id()),
        )?;
        let stored: Option<String> = sqlx::query_scalar("SELECT event_json FROM engine_flow030_events WHERE system_id=? AND invocation_id=? AND event_id=?")
            .bind(&self.identity.system_start_id).bind(&self.identity.flow_invocation_id).bind(&event_id).fetch_optional(&mut *tx).await?;
        let expected_revision = match &stored {
            Some(raw) => serde_json::from_str::<Value>(raw)?
                .get("expectedRevision")
                .and_then(Value::as_str)
                .ok_or_else(refused)?
                .to_owned(),
            None => view.state.revision.clone(),
        };
        let event = FlowEvent030 {
            identity: self.identity.clone(),
            event_id,
            expected_revision,
            kind: FlowEventKind030::PhysicalEnded {
                work,
                stop_effect_id: Some(stop_effect_id.clone()),
                evidence: PhysicalEvidence030 {
                    native_receipt_id: protocol_id,
                    descendants_joined: true,
                },
            },
        };
        if runtime
            .event_committing
            .lock()
            .map_err(|_| unavailable())?
            .get(&(
                self.identity.system_start_id.clone(),
                event.event_id.clone(),
            ))
            .is_some_and(|pending| pending != &event)
        {
            return Err(refused());
        }
        let settlement_kind = if claim.is_some() {
            "nativeJoinedGroupStop030"
        } else {
            "nativeJoinedDiagnosticStop030"
        };
        let settlement = serde_json::to_string(
            &json!({"kind":settlement_kind, "eventId":event.event_id, "startEffectId":attempt.start_effect_id(),"stopEffectId":stop_effect_id,"requestId":joined.request_id(),"ownerEpoch":self.owner.owner_epoch,"generation":self.generation,"workAttempt":attempt}),
        )?;
        if stored.is_some() {
            if row.get::<&str, _>("status") != "settled"
                || row.get::<Option<&str>, _>("settlement_json") != Some(settlement.as_str())
            {
                return Err(refused());
            }
            let result = flow_store030::apply_tx(&mut tx, self, &event)
                .await
                .map_err(store_error)?;
            if !matches!(result, Apply030::Replayed(_)) {
                return Err(refused());
            }
            tx.commit().await?;
            runtime.acknowledge_event_commit(&event);
            runtime.forget_diagnostic_join(joined);
            return Ok(result);
        }
        let expected_status = if claim.is_some() {
            "uncertain"
        } else {
            "pending"
        };
        if !activation.physical || row.get::<&str, _>("status") != expected_status {
            return Err(uncertain());
        }
        let result = flow_store030::apply_tx(&mut tx, self, &event)
            .await
            .map_err(store_error)?;
        if !matches!(result, Apply030::Applied(_)) {
            return Err(refused());
        }
        let changed = sqlx::query("UPDATE engine_flow030_outbox SET status='settled',settlement_json=? WHERE system_id=? AND invocation_id=? AND effect_id=? AND owner_epoch=? AND status=?")
            .bind(&settlement).bind(&self.identity.system_start_id).bind(&self.identity.flow_invocation_id).bind(stop_effect_id).bind(&self.owner.owner_epoch).bind(expected_status).execute(&mut *tx).await?.rows_affected();
        if changed != 1 {
            return Err(refused());
        }
        runtime.begin_event_commit(&event)?;
        tx.commit().await.map_err(|_| uncertain())?;
        runtime.acknowledge_event_commit(&event);
        runtime.forget_diagnostic_join(joined);
        Ok(result)
    }

    /// Prove that this exact Start never crossed the owned executor's release
    /// boundary. None means unproven: an ordinary supervisor proof is required.
    /// A persisted handoff always excludes this path, even if it was unreleased.
    pub(crate) async fn settle_unadmitted(
        &self,
        runtime: &FlowHost030,
        pool: &SqlitePool,
        work: &WorkRef030,
    ) -> Result<Option<Apply030>> {
        if !runtime
            .controls
            .lock()
            .map_err(|_| unavailable())?
            .get(&self.identity.system_start_id)
            .is_some_and(|control| std::ptr::eq(control.as_ref(), self))
        {
            return Err(refused());
        }
        let _admission = self.admission.clone().lock_owned().await;
        let mut db = pool.acquire().await?;
        sqlx::query("PRAGMA synchronous=FULL")
            .execute(&mut *db)
            .await?;
        let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
        let view = flow_store030::read_tx(&mut tx, self, &self.identity)
            .await
            .map_err(store_error)?;
        let activation = view
            .state
            .activations
            .iter()
            .find(|a| a.id == work.activation_id)
            .ok_or_else(refused)?;
        if activation.start_effect_id.as_deref() != Some(work.start_effect_id.as_str())
            || activation.instance_id != work.agent_instance_id
            || !view.state.stopping
        {
            return Err(refused());
        }
        let row = sqlx::query("SELECT effect_json,status,owner_epoch FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? AND effect_id=?")
            .bind(&self.identity.system_start_id).bind(&self.identity.flow_invocation_id).bind(&work.start_effect_id).fetch_one(&mut *tx).await?;
        let effect: FlowEffect030 = serde_json::from_str(row.get::<&str, _>("effect_json"))?;
        if effect.identity != self.identity
            || effect.id != work.start_effect_id
            || row.get::<String, _>("owner_epoch") != self.owner.owner_epoch
            || !matches!(&effect.kind, FlowEffectKind030::Start { work: started, .. } if started == work)
        {
            return Err(refused());
        }
        let handoff: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM engine_flow030_handoffs WHERE system_id=? AND invocation_id=? AND effect_id=?)")
            .bind(&self.identity.system_start_id).bind(&self.identity.flow_invocation_id).bind(&work.start_effect_id).fetch_one(&mut *tx).await?;
        if handoff != 0 {
            return Ok(None);
        }
        let stored = sqlx::query("SELECT owner_epoch,generation,proof_json FROM engine_flow030_no_admissions WHERE system_id=? AND invocation_id=? AND start_effect_id=?")
            .bind(&self.identity.system_start_id).bind(&self.identity.flow_invocation_id).bind(&work.start_effect_id).fetch_optional(&mut *tx).await?;
        let event_id = format!("no-admission:{}", work.start_effect_id);
        let proof;
        let expected_revision;
        if let Some(stored) = stored {
            proof = serde_json::from_str::<NoAdmissionReceipt030>(stored.get("proof_json"))?;
            if stored.get::<String, _>("owner_epoch") != self.owner.owner_epoch
                || stored.get::<String, _>("generation") != self.generation
                || proof.identity != self.identity
                || proof.work != *work
                || proof.owner_epoch != self.owner.owner_epoch
                || proof.generation != self.generation
                || proof.native_receipt_id.is_empty()
                || !matches!(proof.reason.as_str(), "unclaimed" | "unreleasedNativeClaim")
            {
                return Err(refused());
            }
            let original = view.state.events.get(&event_id).ok_or_else(refused)?;
            expected_revision = serde_json::from_str::<Value>(&original.event_json)?
                .get("expectedRevision")
                .and_then(Value::as_str)
                .ok_or_else(refused)?
                .to_owned();
        } else {
            if !activation.physical || activation.stop_effect_id.is_none() {
                return Ok(None);
            }
            let status: &str = row.get("status");
            let reason = match status {
                "pending" => "unclaimed",
                "uncertain" => {
                    let retained = runtime.unadmitted.lock().map_err(|_| unavailable())?;
                    if !retained
                        .get(&(
                            self.identity.system_start_id.clone(),
                            work.start_effect_id.clone(),
                        ))
                        .is_some_and(|p| {
                            p.owner == self.owner
                                && p.generation == self.generation
                                && p.effect == effect
                        })
                    {
                        return Ok(None);
                    }
                    "unreleasedNativeClaim"
                }
                _ => return Ok(None),
            };
            proof = NoAdmissionReceipt030 {
                identity: self.identity.clone(),
                work: work.clone(),
                owner_epoch: self.owner.owner_epoch.clone(),
                generation: self.generation.clone(),
                native_receipt_id: format!("no-admission:{}", uuid::Uuid::new_v4()),
                reason: reason.into(),
            };
            let raw = serde_json::to_string(&proof)?;
            sqlx::query("INSERT INTO engine_flow030_no_admissions(system_id,invocation_id,start_effect_id,owner_epoch,generation,proof_json) VALUES(?,?,?,?,?,?)")
                .bind(&self.identity.system_start_id).bind(&self.identity.flow_invocation_id).bind(&work.start_effect_id).bind(&self.owner.owner_epoch).bind(&self.generation).bind(&raw).execute(&mut *tx).await?;
            let changed = sqlx::query("UPDATE engine_flow030_outbox SET status='settled',settlement_json=? WHERE system_id=? AND invocation_id=? AND effect_id=? AND status=? AND owner_epoch=?")
                .bind(&raw).bind(&self.identity.system_start_id).bind(&self.identity.flow_invocation_id).bind(&work.start_effect_id).bind(status).bind(&self.owner.owner_epoch).execute(&mut *tx).await?.rows_affected();
            if changed != 1 {
                return Err(refused());
            }
            expected_revision = view.state.revision;
        }
        let event = FlowEvent030 {
            identity: self.identity.clone(),
            event_id,
            expected_revision,
            kind: FlowEventKind030::PhysicalEnded {
                work: work.clone(),
                stop_effect_id: activation.stop_effect_id.clone(),
                evidence: PhysicalEvidence030 {
                    native_receipt_id: proof.native_receipt_id,
                    descendants_joined: true,
                },
            },
        };
        let result = flow_store030::apply_tx(&mut tx, self, &event)
            .await
            .map_err(store_error)?;
        if matches!(result, Apply030::Diagnostic(_)) {
            return Err(refused());
        }
        tx.commit().await.map_err(|_| uncertain())?;
        // Keep the positive witness through cancellation or unknown COMMIT.
        if let Ok(mut retained) = runtime.unadmitted.lock() {
            retained.remove(&(
                self.identity.system_start_id.clone(),
                work.start_effect_id.clone(),
            ));
        }
        Ok(Some(result))
    }

    /// Cleanup is allowed after live=false; re-admission is not. The caller
    /// constructs physical evidence from the native supervisor, never model IPC.
    pub(crate) async fn apply(&self, pool: &SqlitePool, event: &FlowEvent030) -> Result<Apply030> {
        if event.identity != self.identity
            || !matches!(
                &event.kind,
                FlowEventKind030::Stop | FlowEventKind030::PhysicalEnded { .. }
            )
        {
            return Err(refused());
        }
        let _admission = self.admission.clone().lock_owned().await;
        let mut db = pool.acquire().await?;
        sqlx::query("PRAGMA synchronous=FULL")
            .execute(&mut *db)
            .await?;
        let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
        let result = flow_store030::apply_tx(&mut tx, self, event)
            .await
            .map_err(store_error)?;
        tx.commit().await.map_err(|_| uncertain())?;
        Ok(result)
    }

    pub(crate) async fn read(&self, pool: &SqlitePool) -> Result<FlowView030> {
        let mut db = pool.acquire().await?;
        let mut tx = db.begin().await?;
        let view = flow_store030::read_tx(&mut tx, self, &self.identity)
            .await
            .map_err(store_error)?;
        tx.commit().await?;
        Ok(view)
    }
}
impl Authority030 for FlowControl030 {
    fn owner<'a>(
        &'a self,
        db: &'a mut SqliteConnection,
        identity: &'a FlowIdentity030,
    ) -> CheckFuture<'a> {
        Box::pin(async move {
            if *identity != self.identity {
                return Err(StoreError030::Authority);
            }
            let row = sqlx::query("SELECT invocation_id,snapshot_id,capture_epoch,owner_epoch,generation,status FROM engine_flow030_owners WHERE system_id=?")
                .bind(&identity.system_start_id).fetch_optional(db).await?.ok_or(StoreError030::Missing)?;
            if row.get::<String, _>("invocation_id") != identity.flow_invocation_id
                || row.get::<String, _>("snapshot_id") != identity.snapshot_id
                || row.get::<String, _>("capture_epoch") != identity.epoch
                || row.get::<String, _>("owner_epoch") != self.owner.owner_epoch
                || row.get::<String, _>("generation") != self.generation
                || !matches!(row.get::<&str, _>("status"), "live" | "revoked")
            {
                return Err(StoreError030::Authority);
            }
            Ok(())
        })
    }
    fn effect<'a>(
        &'a self,
        _db: &'a mut SqliteConnection,
        _effect: &'a FlowEffect030,
    ) -> CheckFuture<'a> {
        Box::pin(async { Err(StoreError030::Authority) })
    }
    fn settlement<'a>(
        &'a self,
        _db: &'a mut SqliteConnection,
        _effect: &'a FlowEffect030,
        _receipt: &'a Value,
    ) -> CheckFuture<'a> {
        Box::pin(async { Err(StoreError030::Authority) })
    }
    fn owner_epoch(&self) -> &str {
        &self.owner.owner_epoch
    }
}
