//! Native ownership of the resident execution webview. A label is not an identity.
use crate::core::db_state::DbPool;
use crate::db::agsdl_execution::{self as repository, dto::EngineOwner, failure, Result};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};
use tauri::{Manager, ResourceId, Webview, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "agsdl-runtime-host";
const ENTRY: &str = "agsdl-runtime-host.html";
struct Incarnation {
    generation: String,
    compiler: crate::agsdl_host_compiler::CompileBroker,
    work_protocol: crate::agsdl_host_work::WorkBroker030,
    route030: crate::agsdl_host_route030::RouteBroker030,
    lifecycle: Arc<tokio::sync::RwLock<()>>,
    handoff: Mutex<()>,
    live: AtomicBool,
    ready: AtomicBool,
    retired: tokio_util::sync::CancellationToken,
    loads: AtomicUsize,
    owners: Mutex<BTreeMap<String, EngineOwner>>,
    qa_request: Mutex<Option<(String, String)>>,
}
impl Incarnation {
    // This gate covers only synchronous ownership transfer. Work admitted here
    // stays owned after revocation and must be cancelled and joined by retirement.
    fn admit_owned<F>(
        &self,
        owner: &EngineOwner,
        tasks: &crate::ai::stream_tasks::StreamTasks,
        request_id: String,
        work: F,
    ) -> Result<()>
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        let _handoff = self
            .handoff
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host admission is unavailable"))?;
        if !self.live.load(Ordering::SeqCst) || !self.ready.load(Ordering::SeqCst) {
            return Err(failure("RUNTIME_UNAVAILABLE", "", "Host was revoked"));
        }
        let owns = self
            .owners
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host ownership unavailable"))?
            .get(&owner.system_start_id)
            == Some(owner);
        if !owns {
            return Err(failure(
                "PERMISSION",
                "owner",
                "Execution is not owned by this host",
            ));
        }
        tasks
            .start_owned030(request_id, owner.clone(), self.generation.clone(), work)
            .map_err(|_| {
                failure(
                    "CORRELATION",
                    "request",
                    "Native attempt was already admitted or cancelled",
                )
            })
    }
}
struct HostResource(Arc<Incarnation>);
impl tauri::Resource for HostResource {}
struct OwnedHost {
    incarnation: Arc<Incarnation>,
    resource: ResourceId,
}
#[derive(Default)]
pub(crate) struct HostState(
    Mutex<Option<OwnedHost>>,
    Arc<tokio::sync::Mutex<()>>,
    crate::agsdl_host_tools::ToolExecutors,
    crate::agsdl_host_flow030::FlowHost030,
);

/// In-memory host fixture for native route-attestation tests. It creates no
/// database authority and is never compiled into the application.
#[cfg(test)]
pub(crate) fn route_attestation_test_host030(owner: EngineOwner, generation: &str) -> HostState {
    let mut owners = BTreeMap::new();
    owners.insert(owner.system_start_id.clone(), owner);
    let incarnation = Arc::new(Incarnation {
        generation: generation.into(),
        compiler: Default::default(),
        work_protocol: Default::default(),
        route030: Default::default(),
        lifecycle: Arc::new(tokio::sync::RwLock::new(())),
        handoff: Mutex::new(()),
        live: AtomicBool::new(true),
        ready: AtomicBool::new(true),
        retired: Default::default(),
        loads: AtomicUsize::new(0),
        owners: Mutex::new(owners),
        qa_request: Mutex::new(None),
    });
    HostState(
        Mutex::new(Some(OwnedHost {
            incarnation,
            resource: 0,
        })),
        Arc::new(tokio::sync::Mutex::new(())),
        Default::default(),
        Default::default(),
    )
}

/// Native Start holds this lease through the SQL commit and ownership attachment.
/// Retirement marks the host unavailable immediately, then waits for these attachments.
pub(crate) struct HostStartLease {
    host: Arc<Incarnation>,
    _guard: tokio::sync::OwnedRwLockReadGuard<()>,
}
impl HostStartLease {
    /// Clear a reconciled work barrier at the same synchronous boundary used
    /// by revocation. No IO or await occurs while this guard is held.
    pub(crate) fn acknowledge_work_commit(
        &self,
        runtime: &crate::agsdl_host_flow030::FlowHost030,
        marker: &crate::agsdl_host_flow030::FlowWorkCommitMarker030,
    ) -> Result<()> {
        let _handoff = self.host.handoff.lock().map_err(|_| {
            failure(
                "RUNTIME_UNAVAILABLE",
                "work",
                "Host admission is unavailable",
            )
        })?;
        self.ensure_live()?;
        runtime.acknowledge_work_commit(marker)
    }
    /// Pure route preparation is still untrusted data until the native owner
    /// verifies and commits its receipt against the current flow transaction.
    pub(crate) async fn prepare_route030(
        &self,
        input_json: String,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<String> {
        self.ensure_live()?;
        let result = self
            .host
            .route030
            .evaluate(&self.host.generation, input_json, cancel)
            .await?;
        self.ensure_live()?;
        Ok(result)
    }
    /// Transfer an exact native effect to its cancellable owner while this
    /// lease keeps the incarnation attached. The caller must also hold the
    /// shared admission exclusion through the acknowledged claim commit.
    pub(crate) fn admit_owned_stream<F>(
        &self,
        owner: &EngineOwner,
        tasks: &crate::ai::stream_tasks::StreamTasks,
        request_id: String,
        work: F,
    ) -> Result<()>
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        self.host.admit_owned(owner, tasks, request_id, work)
    }

    /// Install a native agent parent before its first poll. The surrounding
    /// handoff keeps IO gated until its durable receipt has committed.
    pub(crate) fn admit_owned_agent_stream030<F>(
        &self,
        attempt: &crate::agsdl_host_flow030::FlowWorkAttempt030,
        tasks: &crate::ai::stream_tasks::StreamTasks,
        request_id: String,
        work: F,
    ) -> Result<()>
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        let _handoff = self
            .host
            .handoff
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host admission is unavailable"))?;
        self.ensure_live()?;
        if !self.host.ready.load(Ordering::SeqCst)
            || attempt.generation() != self.host.generation
            || attempt.owner().system_start_id != attempt.identity().system_start_id
            || attempt.work().system_start_id != attempt.identity().system_start_id
            || attempt.work().flow_invocation_id != attempt.identity().flow_invocation_id
        {
            return Err(failure(
                "CORRELATION",
                "attempt",
                "Native work attribution differs",
            ));
        }
        let owns = self
            .host
            .owners
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host ownership unavailable"))?
            .get(&attempt.owner().system_start_id)
            == Some(attempt.owner());
        if !owns {
            return Err(failure(
                "PERMISSION",
                "owner",
                "Execution is not owned by this host",
            ));
        }
        tasks
            .start_agent030(request_id, attempt, work)
            .map_err(|_| {
                failure(
                    "CORRELATION",
                    "request",
                    "Native attempt was already admitted or cancelled",
                )
            })
    }

    /// Attach an already claimed exact operation to the currently executing
    /// owned parent. The caller must hold the admission gate and confirm the
    /// durable claim before calling; this attachment does not grant authority.
    pub(crate) fn attach_owned_operation030(
        &self,
        tasks: &crate::ai::stream_tasks::StreamTasks,
        parent_request_id: &str,
        operation: crate::ai::stream_tasks::OwnedOperation030,
    ) -> Result<crate::ai::stream_tasks::OwnedOperationPermit030> {
        let _handoff = self
            .host
            .handoff
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host admission is unavailable"))?;
        self.ensure_live()?;
        let owner = &operation.context.owner;
        let owns = self
            .host
            .owners
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host ownership unavailable"))?
            .get(&owner.system_start_id)
            == Some(owner);
        if !owns
            || operation.generation != self.host.generation
            || operation.context.work.system_start_id != owner.system_start_id
            || operation.identity.system_start_id != owner.system_start_id
            || operation.identity.flow_invocation_id != operation.context.work.flow_invocation_id
        {
            return Err(failure(
                "CORRELATION",
                "owner",
                "Native operation ownership differs",
            ));
        }
        tasks
            .attach_operation030(parent_request_id, operation)
            .map_err(|_| {
                failure(
                    "CORRELATION",
                    "operation",
                    "Native operation is not owned or was already attached",
                )
            })
    }

    /// Release an already owned effect at the same boundary as revocation.
    /// The callback must only update in-memory bookkeeping and must not block.
    pub(crate) fn release_owned_stream030(
        &self,
        owner: &EngineOwner,
        release: tokio::sync::oneshot::Sender<()>,
        before_release: impl FnOnce(),
    ) -> Result<()> {
        let _handoff = self
            .host
            .handoff
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host admission is unavailable"))?;
        self.ensure_live()?;
        let owns = self
            .host
            .owners
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host ownership unavailable"))?
            .get(&owner.system_start_id)
            == Some(owner);
        if !owns {
            return Err(failure(
                "PERMISSION",
                "owner",
                "Execution is not owned by this host",
            ));
        }
        before_release();
        release.send(()).map_err(|_| {
            failure(
                "UNCERTAIN",
                "",
                "Owned effect release could not be confirmed",
            )
        })
    }

    pub(crate) fn generation(&self) -> &str {
        &self.host.generation
    }
    pub(crate) fn ensure_live(&self) -> Result<()> {
        if !self.host.live.load(Ordering::SeqCst) {
            return Err(failure(
                "RUNTIME_UNAVAILABLE",
                "",
                "Execution host was revoked",
            ));
        }
        Ok(())
    }
    pub(crate) fn owner(&self, system_id: &str) -> Result<EngineOwner> {
        self.ensure_live()?;
        self.host
            .owners
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host ownership unavailable"))?
            .get(system_id)
            .cloned()
            .ok_or_else(|| {
                failure(
                    "RUNTIME_UNAVAILABLE",
                    "owner",
                    "System has no resident owner",
                )
            })
    }
    pub(crate) fn retain_committed_owner(&self, owner: EngineOwner) -> Result<()> {
        // Deliberately record even if retirement began during SQL commit. The
        // retirement writer cannot inspect this map until this lease is dropped.
        let mut owners = self
            .host
            .owners
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host ownership unavailable"))?;
        if owners
            .get(&owner.system_start_id)
            .is_some_and(|previous| previous != &owner)
        {
            return Err(failure(
                "CORRELATION",
                "",
                "Host cannot replace an owned epoch",
            ));
        }
        owners.insert(owner.system_start_id.clone(), owner);
        Ok(())
    }
}

impl HostState {
    pub(crate) fn flow030(&self) -> &crate::agsdl_host_flow030::FlowHost030 {
        &self.3
    }
    pub(crate) fn admission_lock(&self) -> Arc<tokio::sync::Mutex<()>> {
        self.1.clone()
    }
    pub(crate) fn tools(&self) -> &crate::agsdl_host_tools::ToolExecutors {
        &self.2
    }
    pub(crate) async fn admission_gate(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.1.lock().await
    }
    pub(crate) async fn start_lease(&self) -> Result<HostStartLease> {
        let host = self
            .0
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host state unavailable"))?
            .as_ref()
            .map(|host| host.incarnation.clone())
            .ok_or_else(|| failure("RUNTIME_UNAVAILABLE", "", "Host not installed"))?;
        let guard = host.lifecycle.clone().read_owned().await;
        if !host.ready.load(Ordering::SeqCst) {
            return Err(failure("RUNTIME_UNAVAILABLE", "", "Host not ready"));
        }
        let lease = HostStartLease {
            host,
            _guard: guard,
        };
        lease.ensure_live()?;
        Ok(lease)
    }
    /// Caller holds the async admission gate through the durable claim and
    /// this synchronous handoff. The work is owned before it can be polled.
    pub(crate) fn admit_owned_stream<F>(
        &self,
        caller: &Webview,
        owner: &EngineOwner,
        tasks: &crate::ai::stream_tasks::StreamTasks,
        request_id: String,
        work: F,
    ) -> Result<()>
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        self.authenticate(caller)?
            .admit_owned(owner, tasks, request_id, work)
    }
    pub(crate) async fn compile(
        &self,
        source: repository::dto::EngineSourceRevision,
        authored_source: String,
        registry_json: String,
    ) -> Result<crate::agsdl_host_compiler::CompileReceipt> {
        let host = self
            .0
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host state unavailable"))?
            .as_ref()
            .map(|host| host.incarnation.clone())
            .ok_or_else(|| failure("RUNTIME_UNAVAILABLE", "", "Host not installed"))?;
        if !host.live.load(Ordering::SeqCst) || !host.ready.load(Ordering::SeqCst) {
            return Err(failure(
                "RUNTIME_UNAVAILABLE",
                "",
                "Compiler host is not ready",
            ));
        }
        let receipt = host
            .compiler
            .compile(&host.generation, source, authored_source, registry_json)
            .await?;
        if !host.live.load(Ordering::SeqCst) || receipt.generation != host.generation {
            return Err(failure(
                "RUNTIME_UNAVAILABLE",
                "",
                "Compiler host was revoked",
            ));
        }
        Ok(receipt)
    }
    /// The caller first reserves the durable work event. The result still needs
    /// the repository CAS and native proof checks before it can cause an effect.
    async fn evaluate_work030(
        &self,
        input: crate::agsdl_host_work::HostWorkInput030,
        cancelled: &tokio_util::sync::CancellationToken,
    ) -> Result<(crate::agsdl_host_work::HostWorkOutput030, Arc<Incarnation>)> {
        let host = self
            .0
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "work", "Host state unavailable"))?
            .as_ref()
            .map(|host| host.incarnation.clone())
            .ok_or_else(|| failure("RUNTIME_UNAVAILABLE", "work", "Host not installed"))?;
        let owns_work = host
            .owners
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "work", "Host ownership unavailable"))?
            .get(&input.context.owner.system_start_id)
            == Some(&input.context.owner);
        if !host.live.load(Ordering::SeqCst) || !host.ready.load(Ordering::SeqCst) || !owns_work {
            return Err(failure(
                "PERMISSION",
                "work",
                "Work is not owned by this host incarnation",
            ));
        }
        let output = host
            .work_protocol
            .evaluate(&host.generation, input, cancelled)
            .await?;
        if !host.live.load(Ordering::SeqCst) {
            return Err(failure(
                "RUNTIME_UNAVAILABLE",
                "work",
                "Work protocol host was revoked",
            ));
        }
        Ok((output, host))
    }

    /// Evaluates a previously reserved Flow030 event without keeping a SQL or
    /// admission guard across the mailbox wait. The caller must revalidate
    /// the flow and commit its decision in a fresh guarded transaction.
    pub(crate) async fn evaluate_flow_work030(
        &self,
        input: crate::agsdl_host_work::HostWorkInput030,
        generation: &str,
        cancelled: &tokio_util::sync::CancellationToken,
    ) -> Result<crate::agsdl_host_work::HostWorkOutput030> {
        let owner = input.context.owner.clone();
        let expected = self
            .0
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "work", "Host state unavailable"))?
            .as_ref()
            .map(|host| host.incarnation.clone())
            .ok_or_else(|| failure("RUNTIME_UNAVAILABLE", "work", "Host not installed"))?;
        if expected.generation != generation {
            return Err(failure(
                "CORRELATION",
                "work",
                "Work host generation differs",
            ));
        }
        let (output, evaluated) = self.evaluate_work030(input, cancelled).await?;
        let current = self
            .0
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "work", "Host state unavailable"))?
            .as_ref()
            .map(|host| host.incarnation.clone())
            .ok_or_else(|| failure("RUNTIME_UNAVAILABLE", "work", "Host not installed"))?;
        if !Arc::ptr_eq(&expected, &evaluated)
            || !Arc::ptr_eq(&expected, &current)
            || !expected.live.load(Ordering::SeqCst)
            || expected
                .owners
                .lock()
                .map_err(|_| failure("RUNTIME_UNAVAILABLE", "work", "Host ownership unavailable"))?
                .get(&owner.system_start_id)
                != Some(&owner)
        {
            return Err(failure(
                "RUNTIME_UNAVAILABLE",
                "work",
                "Work host ownership changed",
            ));
        }
        Ok(output)
    }
    /// Reserve before asking the pure controller, then commit through DB017's
    /// epoch/stop/revision guard. A committed replay never invokes the mailbox.
    /// This reserves checks only; physical execution requires a separate
    /// native admission and one durable claim under the Stop gate.
    pub(crate) async fn transition_work030(
        &self,
        pool: &sqlx::SqlitePool,
        input: &repository::work_protocol030::ProtocolEvent030,
        cancelled: &tokio_util::sync::CancellationToken,
    ) -> Result<repository::work_protocol030::ProtocolDecision030> {
        self.transition_work030_inner(pool, input, None, cancelled)
            .await
    }

    pub(crate) async fn transition_visible_work030(
        &self,
        pool: &sqlx::SqlitePool,
        input: &repository::work_protocol030::ProtocolEvent030,
        emission: &repository::responses::Emission,
        cancelled: &tokio_util::sync::CancellationToken,
    ) -> Result<repository::work_protocol030::ProtocolDecision030> {
        self.transition_work030_inner(pool, input, Some(emission), cancelled)
            .await
    }

    async fn transition_work030_inner(
        &self,
        pool: &sqlx::SqlitePool,
        input: &repository::work_protocol030::ProtocolEvent030,
        emission: Option<&repository::responses::Emission>,
        cancelled: &tokio_util::sync::CancellationToken,
    ) -> Result<repository::work_protocol030::ProtocolDecision030> {
        use repository::work_protocol030::{
            self as protocol, EventReservation030, ProtocolDecision030,
        };

        if emission.is_none() {
            protocol::reject_visible_without_response(input)?;
        }
        let admission = protocol::read_admission(pool, &input.context, input.control).await?;
        let reservation = {
            let lease = self.start_lease().await?;
            if lease.owner(&input.context.owner.system_start_id)? != input.context.owner {
                return Err(failure(
                    "PERMISSION",
                    "work",
                    "Work belongs to another host epoch",
                ));
            }
            let reservation = protocol::reserve_event(pool, input).await?;
            lease.ensure_live()?;
            reservation
        };
        let ticket = match reservation {
            EventReservation030::Committed { decision } => {
                if let Some(emission) = emission {
                    protocol::verify_visible_commit(pool, input, &decision, emission).await?;
                } else {
                    protocol::reject_visible_without_response(input)?;
                }
                return Ok(decision);
            }
            EventReservation030::Pending { ticket } => ticket,
        };
        let (output, host) = self
            .evaluate_work030(
                crate::agsdl_host_work::HostWorkInput030 {
                    context: input.context.clone(),
                    event_id: input.event_id.clone(),
                    expected_revision: input.expected_revision.clone(),
                    contract_json: ticket.contract_json.clone(),
                    state_json: ticket.state_json.clone(),
                    event_json: input.event_json.clone(),
                    options_json: admission.options_json,
                },
                cancelled,
            )
            .await?;
        if cancelled.is_cancelled() {
            return Err(failure(
                "INTERRUPTED",
                "work",
                "Work transition was cancelled",
            ));
        }
        let check =
            crate::agsdl_host_work::reserved_check030(&input.context, &output.receipt_json)?;
        let decision = ProtocolDecision030 {
            state_json: output.state_json,
            receipt_json: output.receipt_json,
            check,
        };
        if let Err(error) = self
            .commit_work030_inner(pool, &host, &ticket, &decision, emission, cancelled)
            .await
        {
            if error.code == "UNCERTAIN" {
                // Read only: a durable result does not renew a revoked lease and
                // cannot authorize a second physical dispatch.
                let observation = tokio::time::timeout(
                    std::time::Duration::from_secs(1),
                    crate::agsdl_host_work::observe_commit030(pool, &ticket, &decision),
                )
                .await;
                let message = match observation {
                    Ok(Ok(crate::agsdl_host_work::DurableCommitObservation030::Committed)) => {
                        "Work decision is durable; no effect may be replayed"
                    }
                    Ok(Ok(crate::agsdl_host_work::DurableCommitObservation030::Unresolved)) => {
                        "Work decision remains uncertain; no effect may be replayed"
                    }
                    _ => "Work decision could not be inspected; no effect may be replayed",
                };
                return Err(failure("UNCERTAIN", "work", message));
            }
            return Err(error);
        }
        Ok(decision)
    }
    /// Only the short SQL commit holds the lifecycle lease. Cancellation or
    /// retirement can leave the commit outcome unknown; it never authorizes IO.
    #[cfg(test)]
    async fn commit_work030(
        &self,
        pool: &sqlx::SqlitePool,
        host: &Arc<Incarnation>,
        ticket: &repository::work_protocol030::TransitionTicket030,
        decision: &repository::work_protocol030::ProtocolDecision030,
        cancelled: &tokio_util::sync::CancellationToken,
    ) -> Result<()> {
        self.commit_work030_inner(pool, host, ticket, decision, None, cancelled)
            .await
    }

    async fn commit_work030_inner(
        &self,
        pool: &sqlx::SqlitePool,
        host: &Arc<Incarnation>,
        ticket: &repository::work_protocol030::TransitionTicket030,
        decision: &repository::work_protocol030::ProtocolDecision030,
        emission: Option<&repository::responses::Emission>,
        cancelled: &tokio_util::sync::CancellationToken,
    ) -> Result<()> {
        let _lease = host.lifecycle.clone().read_owned().await;
        if !host.live.load(Ordering::SeqCst)
            || !host.ready.load(Ordering::SeqCst)
            || cancelled.is_cancelled()
        {
            return Err(failure(
                "INTERRUPTED",
                "work",
                "Work host was revoked before commit",
            ));
        }
        tokio::select! {
            biased;
            _ = host.retired.cancelled() => return Err(failure("UNCERTAIN", "work", "Host retired during commit; inspect durable state")),
            _ = cancelled.cancelled() => return Err(failure("UNCERTAIN", "work", "Work cancelled during commit; inspect durable state")),
            result = async {
                match emission {
                    Some(value) => repository::work_protocol030::commit_visible_event(pool, ticket, decision, value).await,
                    None => repository::work_protocol030::commit_event(pool, ticket, decision).await,
                }
            } => { result?; }
        }
        if !host.live.load(Ordering::SeqCst) || cancelled.is_cancelled() {
            return Err(failure(
                "UNCERTAIN",
                "work",
                "Work host retired after commit; inspect durable state",
            ));
        }
        Ok(())
    }
    /// Called only by native capture after the durable start receipt. There is no
    /// IPC that lets a caller claim an arbitrary system or choose its epoch.
    pub(crate) fn attach_owner(&self, caller: &Webview, owner: EngineOwner) -> Result<()> {
        let incarnation = self.authenticate(caller)?;
        let mut owners = incarnation
            .owners
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host ownership unavailable"))?;
        if !incarnation.live.load(Ordering::SeqCst) {
            return Err(failure("PERMISSION", "", "Host was revoked during capture"));
        }
        if let Some(previous) = owners.get(&owner.system_start_id) {
            if previous != &owner {
                return Err(failure(
                    "CORRELATION",
                    "",
                    "Host cannot replace an owned epoch",
                ));
            }
        }
        owners.insert(owner.system_start_id.clone(), owner);
        Ok(())
    }
    pub(crate) fn authenticate_owner(
        &self,
        caller: &Webview,
        owner: &EngineOwner,
    ) -> Result<String> {
        let host = self.authenticate(caller)?;
        let owners = host
            .owners
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host ownership unavailable"))?;
        if owners.get(&owner.system_start_id) != Some(owner) {
            return Err(failure(
                "PERMISSION",
                "owner",
                "Execution is not owned by this host incarnation",
            ));
        }
        Ok(host.generation.clone())
    }
    fn authenticate(&self, caller: &Webview) -> Result<Arc<Incarnation>> {
        let host = self
            .0
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host state unavailable"))?;
        let host = host
            .as_ref()
            .ok_or_else(|| failure("RUNTIME_UNAVAILABLE", "", "Host not installed"))?;
        // ResourceTable belongs to the physical caller, even if another window reuses a label.
        let resource = caller
            .resources_table()
            .get::<HostResource>(host.resource)
            .map_err(|_| {
                failure(
                    "PERMISSION",
                    "",
                    "Execution commands require the resident host",
                )
            })?;
        if caller.label() != LABEL
            || !Arc::ptr_eq(&resource.0, &host.incarnation)
            || !host.incarnation.live.load(Ordering::SeqCst)
        {
            return Err(failure(
                "PERMISSION",
                "",
                "Execution host incarnation is not current",
            ));
        }
        Ok(host.incarnation.clone())
    }
}

fn revoke_now(host: &Arc<Incarnation>) -> bool {
    // A poisoned handoff must still revoke; no later admission may succeed.
    let _handoff = host
        .handoff
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !host.live.swap(false, Ordering::SeqCst) {
        return false;
    }
    drop(_handoff);
    host.ready.store(false, Ordering::SeqCst);
    host.retired.cancel();
    host.compiler.close();
    host.work_protocol.close();
    host.route030.close();
    true
}

pub(crate) async fn fence_generation(
    pool: &sqlx::SqlitePool,
    owners: &[EngineOwner],
    generation: &str,
) -> Result<()> {
    repository::revoke_host_owners(pool, owners).await?;
    crate::agsdl_host_flow030::revoke_generation(pool, generation).await
}

/// Stop through the pre-commit native controls, after releasing admission.
/// Joining a stream alone is not proof that independently owned provider or
/// call descendants ended; those still require their physical receipts.
async fn stop_retired_flows(
    runtime: &crate::agsdl_host_flow030::FlowHost030,
    pool: &sqlx::SqlitePool,
    tasks: &crate::ai::stream_tasks::StreamTasks,
    generation: &str,
) -> Result<()> {
    use repository::flow030::{FlowEvent030, FlowEventKind030};
    let mut pending = false;
    for control in runtime.retiring_controls(generation)? {
        let identity = control.identity();
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM engine_flow030_owners WHERE system_id=? AND invocation_id=?)",
        )
        .bind(&identity.system_start_id)
        .bind(&identity.flow_invocation_id)
        .fetch_one(pool)
        .await?;
        // Start may have retained its in-memory owner before rolling back.
        if !exists {
            continue;
        }
        let view = control.read(pool).await?;
        if !view.state.stopping && view.state.verdict.is_none() {
            control
                .apply(
                    pool,
                    &FlowEvent030 {
                        identity: identity.clone(),
                        event_id: format!("retire:{}", uuid::Uuid::new_v4()),
                        expected_revision: view.state.revision,
                        kind: FlowEventKind030::Stop,
                    },
                )
                .await?;
        }
        pending |= crate::agsdl_host_stop030::reconcile(runtime, pool, tasks, &control).await?;
    }
    if pending {
        return Err(failure(
            "STOP_PENDING",
            "",
            "Native flow is awaiting physical termination evidence",
        ));
    }
    Ok(())
}

fn retire(host: &Arc<Incarnation>, database: &DbPool, app: &tauri::AppHandle) {
    let app = app.clone();
    if !revoke_now(host) {
        return;
    }
    let database = database.clone();
    let host = host.clone();
    tauri::async_runtime::spawn(async move {
        let _retirement_guard = host.lifecycle.clone().write_owned().await;
        let owners = host
            .owners
            .lock()
            .expect("host ownership")
            .values()
            .cloned()
            .collect::<Vec<_>>();

        // Authority is already revoked in memory. Retain the retirement until the
        // native journal acknowledges it; shutdown recovery handles process loss.
        loop {
            if let Ok(pool) = database.wait_until_ready().await {
                let _gate = app.state::<HostState>().admission_lock().lock_owned().await;
                if fence_generation(&pool, &owners, &host.generation)
                    .await
                    .is_ok()
                {
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        drop(_retirement_guard);
        // Native engines may own descendants outside Macro's process. Revoking
        // their epoch also requests physical stop; reload never leaves them running.
        if let Ok(pool) = database.wait_until_ready().await {
            if let Err(error) = stop_retired_flows(
                app.state::<HostState>().flow030(),
                &pool,
                &app.state::<crate::ai::AiState>().stream_tasks,
                &host.generation,
            )
            .await
            {
                tracing::warn!(code = %error.code, "Native flow retirement remains pending");
            }
            for owner in &owners {
                if let Ok(projection) =
                    repository::read_projection(&pool, &owner.system_start_id).await
                {
                    for activation in projection.activations {
                        if let Ok(effects) =
                            repository::read_effects(&pool, &activation.delivery.delivery.work)
                                .await
                        {
                            for effect in effects {
                                if effect.registered.context.owner != *owner
                                    || effect.status == "ended"
                                {
                                    continue;
                                }
                                // A controlled native runner may be waiting for a Macro
                                // Tool. Revoke that owned executor as well as its provider.
                                crate::agsdl_host_tools::cancel(&effect.registered);
                                let native = serde_json::from_str::<serde_json::Value>(
                                    &effect.registered.invocation_json,
                                )
                                .ok()
                                .is_some_and(|value| {
                                    value["kind"] == "codex-app-server-v1"
                                        || value["kind"] == "claude-sdk-v1"
                                });
                                if !native || effect.status == "ended" {
                                    continue;
                                }
                                if let repository::dto::EngineEffectIdentity::Provider {
                                    provider_attempt_id,
                                } = effect.registered.effect
                                {
                                    let _ = crate::agsdl_host_provider::finish(
                                        &app,
                                        effect.registered.context,
                                        provider_attempt_id,
                                    )
                                    .await;
                                }
                            }
                        }
                    }
                }
            }
        }
        // A native replacement follows durable fencing, never a Flow polling tick.
        for _ in 0..10 {
            let current = app
                .state::<HostState>()
                .0
                .lock()
                .ok()
                .and_then(|owned| {
                    owned
                        .as_ref()
                        .map(|owned| Arc::ptr_eq(&owned.incarnation, &host))
                })
                .unwrap_or(false);
            if !current {
                return;
            }
            let app_for_main = app.clone();
            let retired = host.clone();
            let (sender, receiver) = tokio::sync::oneshot::channel();
            if app
                .run_on_main_thread(move || {
                    let matches = app_for_main
                        .state::<HostState>()
                        .0
                        .lock()
                        .ok()
                        .and_then(|owned| {
                            owned
                                .as_ref()
                                .map(|owned| Arc::ptr_eq(&owned.incarnation, &retired))
                        })
                        .unwrap_or(false);
                    if !matches {
                        let _ = sender.send(true);
                        return;
                    }
                    if let Some(window) = app_for_main.get_webview_window(LABEL) {
                        let _ = window.destroy();
                    }
                    let _ = sender.send(install(&app_for_main).is_ok());
                })
                .is_err()
            {
                return;
            }
            if receiver.await.unwrap_or(false) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        tracing::warn!("Resident execution host replacement failed after bounded retries");
    });
}

pub(crate) fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    let incarnation = Arc::new(Incarnation {
        generation: uuid::Uuid::new_v4().to_string(),
        compiler: Default::default(),
        work_protocol: Default::default(),
        route030: Default::default(),
        lifecycle: Arc::new(tokio::sync::RwLock::new(())),
        handoff: Mutex::new(()),
        live: AtomicBool::new(true),
        ready: AtomicBool::new(false),
        retired: Default::default(),
        loads: AtomicUsize::new(0),
        owners: Mutex::new(BTreeMap::new()),
        qa_request: Mutex::new(None),
    });
    let navigation_database = app.state::<DbPool>().inner().clone();
    let load_database = navigation_database.clone();
    let destroy_database = navigation_database.clone();
    let navigation_app = app.clone();
    let load_app = app.clone();
    let destroy_app = app.clone();
    let navigation = incarnation.clone();
    let load = incarnation.clone();
    let expected = if cfg!(dev) {
        app.config()
            .build
            .dev_url
            .as_ref()
            .and_then(|url| url.join(ENTRY).ok())
    } else {
        None
    };
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(ENTRY.into()))
        .visible(false)
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .on_navigation(move |url| {
            let allowed = expected.as_ref().map_or_else(
                || {
                    matches!(url.scheme(), "tauri" | "http" | "https")
                        && matches!(url.host_str(), Some("localhost" | "tauri.localhost"))
                        && url.path() == format!("/{ENTRY}")
                        && url.query().is_none()
                        && url.fragment().is_none()
                },
                |expected| url == expected,
            );
            if !allowed {
                retire(&navigation, &navigation_database, &navigation_app);
            }
            allowed && navigation.live.load(Ordering::SeqCst)
        })
        .on_page_load(move |_, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
                && load.loads.fetch_add(1, Ordering::SeqCst) > 0
            {
                retire(&load, &load_database, &load_app);
            }
        })
        .build()?;
    let resource = window
        .as_ref()
        .resources_table()
        .add(HostResource(incarnation.clone()));
    *app.state::<HostState>()
        .0
        .lock()
        .expect("host installation") = Some(OwnedHost {
        incarnation: incarnation.clone(),
        resource,
    });
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            retire(&incarnation, &destroy_database, &destroy_app);
        }
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn execution_host_ready(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, HostState>,
) -> Result<String> {
    let host = state.authenticate(&webview)?;
    if !host.ready.swap(true, Ordering::SeqCst) {
        // Do not await the compiler here: the JS mailbox starts after this handshake.
        let database = app.state::<DbPool>().inner().clone();
        let gate = state.admission_lock();
        let recovering = host.clone();
        // This synchronous command runs on the main thread, outside a Tokio context.
        tauri::async_runtime::spawn(reattach_retained(
            database,
            recovering,
            gate,
            std::time::Duration::from_secs(2),
        ));
    }
    Ok(host.generation.clone())
}

#[cfg(test)]
#[path = "agsdl_host_recovery_tests.rs"]
mod recovery_tests;

#[cfg(test)]
#[path = "agsdl_host_flow030_tests.rs"]
mod flow030_tests;

#[cfg(test)]
#[path = "agsdl_host_flow_work030_tests.rs"]
mod flow_work030_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn test_operation030() -> crate::ai::stream_tasks::OwnedOperation030 {
        crate::ai::stream_tasks::OwnedOperation030 {
            identity: crate::db::agsdl_execution::flow030::FlowIdentity030 {
                system_start_id: "system".into(),
                flow_invocation_id: "flow".into(),
                snapshot_id: "snapshot".into(),
                epoch: "capture".into(),
            },
            context: serde_json::from_value(serde_json::json!({
                "owner":{"systemStartId":"system","ownerEpoch":"0"},
                "work":{"systemStartId":"system","flowInvocationId":"flow",
                    "activationId":"activation","agentInstanceId":"agent","step":["work"]},
                "permissionsJson":"{}","scopeJson":"{}","registryVersion":"registry"
            }))
            .unwrap(),
            generation: "generation".into(),
            agent: "worker".into(),
            provider_attempt_id: "attempt".into(),
            operation_id: "operation".into(),
            method: "turn/start".into(),
            request_json: r#"{"value":1e0}"#.into(),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn operation_attachment_and_revocation_are_ordered_for_the_owned_parent() {
        for revoke_first in [true, false] {
            let owner = EngineOwner {
                system_start_id: "system".into(),
                owner_epoch: "0".into(),
            };
            let host_state = route_attestation_test_host030(owner, "generation");
            let host = host_state
                .0
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .incarnation
                .clone();
            let lease = HostStartLease {
                host: host.clone(),
                _guard: host.lifecycle.clone().read_owned().await,
            };
            let tasks = crate::ai::stream_tasks::StreamTasks::default();
            let inner = tasks.clone();
            let (go, proceed) = tokio::sync::oneshot::channel();
            let (done, observed) = tokio::sync::oneshot::channel();
            tasks
                .start_work_fixture030(
                    "parent".into(),
                    test_operation030().identity,
                    test_operation030().context,
                    "generation".into(),
                    "worker".into(),
                    "attempt".into(),
                    async move {
                        let _ = proceed.await;
                        if !revoke_first {
                            let mut foreign = test_operation030();
                            foreign.context.owner.owner_epoch = "other".into();
                            assert!(lease
                                .attach_owned_operation030(&inner, "parent", foreign)
                                .is_err());
                            let mut wrong_generation = test_operation030();
                            wrong_generation.generation = "other".into();
                            assert!(lease
                                .attach_owned_operation030(&inner, "parent", wrong_generation)
                                .is_err());
                        }
                        let result =
                            lease.attach_owned_operation030(&inner, "parent", test_operation030());
                        let _ = done.send(result);
                        std::future::pending::<()>().await;
                    },
                )
                .unwrap();
            if revoke_first {
                assert!(revoke_now(&host));
            }
            go.send(()).unwrap();
            let result = observed.await.unwrap();
            if revoke_first {
                assert!(result.is_err());
            } else {
                assert_eq!(result.unwrap().digest().len(), 64);
                assert!(revoke_now(&host));
            }
            assert!(tasks.cancel_owned("parent").await.unwrap());
        }
    }
    #[tokio::test]
    async fn retirement_waits_for_owner_committed_during_start() {
        let host = Arc::new(Incarnation {
            generation: "native-generation".into(),
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
        let lease = HostStartLease {
            host: host.clone(),
            _guard: host.lifecycle.clone().read_owned().await,
        };
        host.live.store(false, Ordering::SeqCst);
        assert!(lease.ensure_live().is_err());
        assert!(host.lifecycle.try_write().is_err());
        let owner = EngineOwner {
            system_start_id: "committed-system".into(),
            owner_epoch: "0".into(),
        };
        lease.retain_committed_owner(owner.clone()).unwrap();
        drop(lease);
        let _retirement = host.lifecycle.write().await;
        assert_eq!(
            host.owners.lock().unwrap().get("committed-system"),
            Some(&owner)
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn owned_stream_handoff_is_ordered_with_revocation_before_first_poll() {
        let host = Arc::new(Incarnation {
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
        let owner = EngineOwner {
            system_start_id: "system".into(),
            owner_epoch: "0".into(),
        };
        host.owners
            .lock()
            .unwrap()
            .insert(owner.system_start_id.clone(), owner.clone());
        let lease = HostStartLease {
            host: host.clone(),
            _guard: host.lifecycle.clone().read_owned().await,
        };
        let tasks = crate::ai::stream_tasks::StreamTasks::default();
        let polled = Arc::new(AtomicBool::new(false));
        let observed = polled.clone();
        lease
            .admit_owned_stream(&owner, &tasks, "first".into(), async move {
                observed.store(true, Ordering::SeqCst);
                std::future::pending::<()>().await;
            })
            .unwrap();
        let (started, observed_start) = tokio::sync::oneshot::channel();
        lease
            .admit_owned_stream(&owner, &tasks, "second".into(), async move {
                let _ = started.send(());
                std::future::pending::<()>().await;
            })
            .unwrap();
        let foreign = EngineOwner {
            system_start_id: owner.system_start_id.clone(),
            owner_epoch: "1".into(),
        };
        assert!(lease
            .admit_owned_stream(&foreign, &tasks, "foreign".into(), async {})
            .is_err());
        // No yield has occurred: revocation precedes both futures' first poll.
        assert!(revoke_now(&host));
        assert!(lease
            .admit_owned_stream(&owner, &tasks, "late".into(), async {})
            .is_err());
        assert!(tasks.cancel_owned("first").await.unwrap());
        assert!(!polled.load(Ordering::SeqCst));
        // The other already-owned operation may start after revocation. It is
        // still known to the supervisor and is joined before reporting end.
        observed_start.await.unwrap();
        assert!(tasks.cancel_owned("second").await.unwrap());
        assert!(!tasks.cancel_owned("late").await.unwrap());
    }

    #[tokio::test]
    async fn owned_release_refuses_foreign_owner_closed_receiver_and_poisoned_gate() {
        let host = Arc::new(Incarnation {
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
        let owner = EngineOwner {
            system_start_id: "system".into(),
            owner_epoch: "0".into(),
        };
        host.owners
            .lock()
            .unwrap()
            .insert(owner.system_start_id.clone(), owner.clone());
        let lease = HostStartLease {
            host: host.clone(),
            _guard: host.lifecycle.clone().read_owned().await,
        };
        let touched = AtomicBool::new(false);
        let foreign = EngineOwner {
            system_start_id: owner.system_start_id.clone(),
            owner_epoch: "1".into(),
        };
        let (tx, _rx) = tokio::sync::oneshot::channel();
        assert!(lease
            .release_owned_stream030(&foreign, tx, || touched.store(true, Ordering::SeqCst))
            .is_err());
        assert!(!touched.load(Ordering::SeqCst));
        let (tx, rx) = tokio::sync::oneshot::channel();
        drop(rx);
        assert_eq!(
            lease
                .release_owned_stream030(&owner, tx, || {})
                .unwrap_err()
                .code,
            "UNCERTAIN"
        );
        let poisoning = host.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poisoning.handoff.lock().unwrap();
            panic!("poison test gate");
        })
        .join();
        let (tx, _rx) = tokio::sync::oneshot::channel();
        assert!(lease
            .release_owned_stream030(&owner, tx, || touched.store(true, Ordering::SeqCst))
            .is_err());
        assert!(!touched.load(Ordering::SeqCst));
    }

    #[test]
    fn physical_resource_cannot_be_replaced_by_a_matching_generation_string() {
        let first = Arc::new(Incarnation {
            generation: "same".into(),
            compiler: Default::default(),
            work_protocol: Default::default(),
            route030: Default::default(),
            lifecycle: Arc::new(tokio::sync::RwLock::new(())),
            handoff: Mutex::new(()),
            live: AtomicBool::new(true),
            ready: AtomicBool::new(false),
            retired: Default::default(),
            loads: AtomicUsize::new(0),
            owners: Mutex::new(BTreeMap::new()),
            qa_request: Mutex::new(None),
        });
        let forged = Arc::new(Incarnation {
            generation: "same".into(),
            compiler: Default::default(),
            work_protocol: Default::default(),
            route030: Default::default(),
            lifecycle: Arc::new(tokio::sync::RwLock::new(())),
            handoff: Mutex::new(()),
            live: AtomicBool::new(true),
            ready: AtomicBool::new(false),
            retired: Default::default(),
            loads: AtomicUsize::new(0),
            owners: Mutex::new(BTreeMap::new()),
            qa_request: Mutex::new(None),
        });
        assert!(!Arc::ptr_eq(&first, &forged));
        let mut table = tauri::ResourceTable::default();
        let id = table.add(HostResource(first.clone()));
        assert!(Arc::ptr_eq(
            &table.get::<HostResource>(id).unwrap().0,
            &first
        ));
        assert!(tauri::ResourceTable::default()
            .get::<HostResource>(id)
            .is_err());
    }
}

#[tauri::command]
pub(crate) async fn execution_host_next_compile(
    webview: Webview,
    state: tauri::State<'_, HostState>,
) -> Result<crate::agsdl_host_compiler::HostCompileJob> {
    let host = state.authenticate(&webview)?;
    let job = host.compiler.next().await?;
    state.authenticate(&webview)?;
    Ok(job)
}
#[tauri::command]
pub(crate) fn execution_host_complete_compile(
    webview: Webview,
    state: tauri::State<'_, HostState>,
    ticket: String,
    result_json: String,
) -> Result<()> {
    let host = state.authenticate(&webview)?;
    host.compiler
        .complete(&host.generation, &ticket, result_json)
}

#[tauri::command]
pub(crate) async fn execution_host_next_work030(
    webview: Webview,
    state: tauri::State<'_, HostState>,
) -> Result<crate::agsdl_host_work::HostWorkJob030> {
    let host = state.authenticate(&webview)?;
    let job = host.work_protocol.next().await?;
    state.authenticate(&webview)?;
    Ok(job)
}

#[tauri::command]
pub(crate) fn execution_host_complete_work030(
    webview: Webview,
    state: tauri::State<'_, HostState>,
    completion: crate::agsdl_host_work::HostWorkCompletion030,
) -> Result<()> {
    let host = state.authenticate(&webview)?;
    host.work_protocol.complete(&host.generation, completion)
}

#[tauri::command]
pub(crate) async fn execution_host_next_route030(
    webview: Webview,
    state: tauri::State<'_, HostState>,
) -> Result<crate::agsdl_host_route030::HostRouteJob030> {
    let host = state.authenticate(&webview)?;
    let job = host.route030.next().await?;
    state.authenticate(&webview)?;
    Ok(job)
}

#[tauri::command]
pub(crate) fn execution_host_complete_route030(
    webview: Webview,
    state: tauri::State<'_, HostState>,
    completion: crate::agsdl_host_route030::HostRouteCompletion030,
) -> Result<()> {
    let host = state.authenticate(&webview)?;
    host.route030.complete(&host.generation, completion)
}

#[tauri::command]
pub(crate) fn execution_host_failed(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, HostState>,
    database: tauri::State<'_, DbPool>,
) -> Result<()> {
    let host = state.authenticate(&webview)?;
    retire(&host, database.inner(), &app);
    Ok(())
}

#[tauri::command]
pub(crate) fn execution_host_owners(
    webview: Webview,
    state: tauri::State<'_, HostState>,
) -> Result<Vec<EngineOwner>> {
    let host = state.authenticate(&webview)?;
    let owners = host
        .owners
        .lock()
        .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host ownership unavailable"))?;
    Ok(owners.values().cloned().collect())
}
#[tauri::command]
pub(crate) async fn execution_host_inspect(
    webview: Webview,
    state: tauri::State<'_, HostState>,
    database: tauri::State<'_, DbPool>,
    owner: EngineOwner,
) -> Result<repository::inspection::HostInspection> {
    state.authenticate_owner(&webview, &owner)?;
    let pool = database
        .wait_until_ready()
        .await
        .map_err(|_| failure("STORAGE", "", "Execution database unavailable"))?;
    let result = repository::inspection::read(&pool, &owner).await?;
    state.authenticate_owner(&webview, &owner)?;
    Ok(result)
}
#[tauri::command]
pub(crate) async fn execution_host_begin(
    webview: Webview,
    state: tauri::State<'_, HostState>,
    database: tauri::State<'_, DbPool>,
    owner: EngineOwner,
    delivery_id: String,
) -> Result<repository::inspection::HostAdmission> {
    state.authenticate_owner(&webview, &owner)?;
    let pool = database
        .wait_until_ready()
        .await
        .map_err(|_| failure("STORAGE", "", "Execution database unavailable"))?;
    let result = repository::begin(&pool, &owner, &delivery_id).await?;
    state.authenticate_owner(&webview, &owner)?;
    Ok(result.into())
}

#[tauri::command]
pub(crate) async fn execution_host_prepare_terminal(
    webview: Webview,
    state: tauri::State<'_, HostState>,
    database: tauri::State<'_, DbPool>,
    request: repository::prepared::Prepare,
) -> Result<String> {
    let generation = state.authenticate_owner(&webview, &request.owner)?;
    let pool = database
        .wait_until_ready()
        .await
        .map_err(|_| failure("STORAGE", "", "Execution database unavailable"))?;
    repository::prepared::prepare(&pool, &generation, request).await
}
#[tauri::command]
pub(crate) async fn execution_host_commit_terminal(
    webview: Webview,
    state: tauri::State<'_, HostState>,
    database: tauri::State<'_, DbPool>,
    owner: EngineOwner,
    witness_id: String,
) -> Result<repository::dto::EngineTerminalCommit> {
    let generation = state.authenticate_owner(&webview, &owner)?;
    let pool = database
        .wait_until_ready()
        .await
        .map_err(|_| failure("STORAGE", "", "Execution database unavailable"))?;
    repository::prepared::commit(&pool, &generation, &owner, &witness_id).await
}
#[tauri::command]
pub(crate) async fn execution_host_append_response(
    webview: Webview,
    state: tauri::State<'_, HostState>,
    database: tauri::State<'_, DbPool>,
    emission: repository::responses::Emission,
) -> Result<bool> {
    state.authenticate_owner(&webview, &emission.context.owner)?;
    let pool = database
        .wait_until_ready()
        .await
        .map_err(|_| failure("STORAGE", "", "Execution database unavailable"))?;
    repository::responses::append(&pool, emission).await
}
#[tauri::command]
pub(crate) async fn execution_host_read_responses(
    webview: Webview,
    state: tauri::State<'_, HostState>,
    database: tauri::State<'_, DbPool>,
    owner: EngineOwner,
    work: repository::dto::EngineWork,
) -> Result<(Vec<repository::responses::Emission>, String)> {
    state.authenticate_owner(&webview, &owner)?;
    let pool = database
        .wait_until_ready()
        .await
        .map_err(|_| failure("STORAGE", "", "Execution database unavailable"))?;
    let result = repository::responses::read(&pool, &owner, &work).await?;
    state.authenticate_owner(&webview, &owner)?;
    Ok(result)
}
#[tauri::command]
pub(crate) async fn execution_host_close_responses(
    webview: Webview,
    state: tauri::State<'_, HostState>,
    database: tauri::State<'_, DbPool>,
    closure: repository::responses::Closure,
) -> Result<repository::responses::Closure> {
    state.authenticate_owner(&webview, &closure.owner)?;
    let pool = database
        .wait_until_ready()
        .await
        .map_err(|_| failure("STORAGE", "", "Execution database unavailable"))?;
    repository::responses::close(&pool, closure).await
}

#[tauri::command]
pub(crate) async fn execution_host_mark_uncertain(
    webview: Webview,
    state: tauri::State<'_, HostState>,
    database: tauri::State<'_, DbPool>,
    owner: EngineOwner,
    work: repository::dto::EngineWork,
    reason: String,
) -> Result<()> {
    state.authenticate_owner(&webview, &owner)?;
    if reason.len() > 2048 {
        return Err(failure(
            "CORRELATION",
            "reason",
            "Uncertainty reason exceeds its bound",
        ));
    }
    let pool = database
        .wait_until_ready()
        .await
        .map_err(|_| failure("STORAGE", "", "Execution database unavailable"))?;
    repository::mark_uncertain(&pool, &owner, &work, &reason).await?;
    state.authenticate_owner(&webview, &owner)?;
    Ok(())
}

// One supervisor belongs to the physical incarnation. Transient failures are
// retried at a bounded rate until retirement; an old Start receipt never dispatches work.
async fn reattach_retained(
    database: DbPool,
    host: Arc<Incarnation>,
    gate: Arc<tokio::sync::Mutex<()>>,
    retry_delay: std::time::Duration,
) {
    let mut incompatible = BTreeSet::new();
    while host.live.load(Ordering::SeqCst) {
        let pool = tokio::select! {
            _ = host.retired.cancelled() => return,
            pool = database.wait_until_ready() => pool,
        };
        let result = match pool {
            Ok(pool) => reattach_pass(&pool, &host, &gate, &mut incompatible).await,
            Err(_) => Err(failure("STORAGE", "", "Execution database unavailable")),
        };
        match result {
            Ok(false) => return, // Every retained candidate is attached or incompatible.
            Ok(true) => {}
            Err(error) => tracing::warn!(code = %error.code, "Execution host recovery will retry"),
        }
        tokio::select! {
            _ = host.retired.cancelled() => return,
            _ = tokio::time::sleep(retry_delay) => {},
        }
    }
}

async fn reattach_pass(
    pool: &sqlx::SqlitePool,
    host: &Arc<Incarnation>,
    gate: &tokio::sync::Mutex<()>,
    incompatible: &mut BTreeSet<String>,
) -> Result<bool> {
    // Never hold the lifecycle lease while sleeping between scans. Retirement
    // still waits for a committed owner to be recorded before revoking it.
    let lease = HostStartLease {
        host: host.clone(),
        _guard: host.lifecycle.clone().read_owned().await,
    };
    lease.ensure_live()?;
    let mut after = String::new();
    let mut retry_needed = false;
    loop {
        let candidates = repository::retained_for_resume(pool, &after).await?;
        if candidates.is_empty() {
            return Ok(retry_needed);
        }
        for (snapshot, capture) in candidates {
            after = snapshot.system_start_id.clone();
            lease.ensure_live()?;
            if lease.owner(&snapshot.system_start_id).is_ok()
                || incompatible.contains(&snapshot.system_start_id)
            {
                continue;
            }
            match reattach_candidate(pool, &lease, gate, &snapshot, capture).await {
                Ok(true) => {}
                Ok(false) => {
                    incompatible.insert(snapshot.system_start_id);
                }
                Err(error) => {
                    retry_needed = true;
                    // A busy compiler or failed SQL operation for A cannot hide B.
                    tracing::warn!(code = %error.code, "Retained execution recovery will retry");
                }
            }
        }
    }
}

async fn reattach_candidate(
    pool: &sqlx::SqlitePool,
    lease: &HostStartLease,
    gate: &tokio::sync::Mutex<()>,
    snapshot: &repository::dto::EngineSnapshot,
    capture: repository::capture::PrivateCapture,
) -> Result<bool> {
    if capture.implementation_digest != "macro-native-host/1" {
        return Ok(false);
    }
    let verified = lease
        .host
        .compiler
        .compile(
            lease.generation(),
            snapshot.source.clone(),
            snapshot.authored_source.clone(),
            capture.registry_json,
        )
        .await?;
    let result: serde_json::Value = serde_json::from_str(&verified.result_json)?;
    let Some(compiled) = result
        .get("compiledPlanJson")
        .and_then(serde_json::Value::as_str)
    else {
        return Ok(false);
    };
    // Exact equality includes every captured implementation version. Incompatible
    // captures stay closed without replaying effects or rotating their epoch.
    if verified.generation != lease.generation()
        || !crate::db::exact_json::equal(compiled, &snapshot.compiled_plan_json)?
    {
        return Ok(false);
    }
    let _gate = gate.lock().await;
    lease.ensure_live()?;
    if lease.owner(&snapshot.system_start_id).is_ok() {
        return Ok(true);
    }
    let owner = repository::resume(pool, &snapshot.system_start_id, &snapshot.versions).await?;
    lease.retain_committed_owner(owner)?;
    Ok(true)
}

// Manual qualification only. The native slot authorizes one existing delivery;
// an event from another webview cannot manufacture an admission or owner.
#[tauri::command]
pub(crate) fn execution_qa_available(app: tauri::AppHandle) -> bool {
    cfg!(all(debug_assertions, feature = "browser-runtime-debug"))
        && app.config().identifier.starts_with("com.macro.desktop.qa.")
}
#[tauri::command]
pub(crate) async fn execution_qa_run(
    app: tauri::AppHandle,
    state: tauri::State<'_, HostState>,
    database: tauri::State<'_, DbPool>,
    system_start_id: String,
    delivery_id: String,
) -> Result<()> {
    use tauri::Emitter;
    if !execution_qa_available(app.clone()) {
        return Err(failure(
            "RUNTIME_UNAVAILABLE",
            "",
            "Manual qualification is disabled",
        ));
    }
    let lease = state.start_lease().await?;
    let owner = lease.owner(&system_start_id)?;
    let pool = database
        .wait_until_ready()
        .await
        .map_err(|_| failure("STORAGE", "", "Database unavailable"))?;
    let inspection = repository::inspection::read(&pool, &owner).await?;
    let plan: serde_json::Value = serde_json::from_str(&inspection.snapshot.compiled_plan_json)?;
    let delivery = inspection
        .projection
        .activations
        .iter()
        .find(|activation| activation.delivery.delivery.delivery_id == delivery_id);
    if plan.get("entry") != Some(&serde_json::Value::Null)
        || !delivery.is_some_and(|activation| {
            activation.work_state == "queued"
                && activation
                    .delivery
                    .delivery
                    .work
                    .agent_instance_id
                    .is_some()
        })
    {
        return Err(failure(
            "CORRELATION",
            "delivery",
            "Manual qualification requires a queued graphless Agent delivery",
        ));
    }
    lease.ensure_live()?;
    let mut slot = lease
        .host
        .qa_request
        .lock()
        .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "QA request unavailable"))?;
    if slot.is_some() {
        return Err(failure(
            "RUNTIME_UNAVAILABLE",
            "",
            "A manual qualification request is pending",
        ));
    }
    *slot = Some((system_start_id, delivery_id));
    if app.emit_to(LABEL, "agsdl-qa-wake", ()).is_err() {
        *slot = None;
        return Err(failure("RUNTIME_UNAVAILABLE", "", "Host wake failed"));
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn execution_host_qa_take(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, HostState>,
) -> Result<Option<(EngineOwner, String)>> {
    if !execution_qa_available(app) {
        return Ok(None);
    }
    let host = state.authenticate(&webview)?;
    let request = host
        .qa_request
        .lock()
        .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "QA request unavailable"))?
        .take();
    request
        .map(|(system, delivery)| {
            let owner = host
                .owners
                .lock()
                .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Owner unavailable"))?
                .get(&system)
                .cloned()
                .ok_or_else(|| failure("CORRELATION", "", "QA owner is absent"))?;
            Ok((owner, delivery))
        })
        .transpose()
}
#[tauri::command]
pub(crate) async fn execution_qa_replace_host(
    app: tauri::AppHandle,
    state: tauri::State<'_, HostState>,
    database: tauri::State<'_, DbPool>,
) -> Result<()> {
    if !execution_qa_available(app.clone()) {
        return Err(failure(
            "RUNTIME_UNAVAILABLE",
            "",
            "Manual qualification is disabled",
        ));
    }
    let lease = state.start_lease().await?;
    retire(&lease.host, database.inner(), &app);
    Ok(())
}
