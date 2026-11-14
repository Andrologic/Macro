//! Process-owned execution engine, independent of webview lifetimes.
use crate::persistence::{self as repository, dto::EngineOwner, failure, Result};
use crate::tasks as stream_tasks;
use sqlx::{query, query_scalar, Row, SqlitePool};
use std::collections::BTreeMap;
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

struct Incarnation {
    generation: String,
    compiler: crate::agsdl_host_compiler::CompileBroker,
    work_protocol: crate::agsdl_host_work::WorkBroker030,
    route030: Arc<crate::agsdl_host_route030::RouteBroker030>,
    lifecycle: Arc<tokio::sync::RwLock<()>>,
    handoff: Mutex<()>,
    live: AtomicBool,
    ready: AtomicBool,
    retired: tokio_util::sync::CancellationToken,
    owners: Mutex<BTreeMap<String, EngineOwner>>,
}
impl Incarnation {
    // This gate covers only synchronous ownership transfer. Work admitted here
    // stays owned after revocation and must be cancelled and joined by retirement.
    fn admit_owned<F>(
        &self,
        owner: &EngineOwner,
        tasks: &stream_tasks::StreamTasks,
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
struct OwnedHost {
    incarnation: Arc<Incarnation>,
}
#[derive(Clone)]
pub struct HostState {
    inner: Arc<EngineInner>,
}
struct EngineInner {
    incarnation: Mutex<Option<OwnedHost>>,
    admission: Arc<tokio::sync::Mutex<()>>,
    flow: Arc<crate::agsdl_host_flow030::FlowHost030>,
}
impl HostState {
    pub fn new() -> Self {
        Self::from_parts(
            Mutex::new(Some(OwnedHost {
                incarnation: new_incarnation(uuid::Uuid::new_v4().to_string(), true),
            })),
            Default::default(),
            Default::default(),
        )
    }
    fn from_parts(
        incarnation: Mutex<Option<OwnedHost>>,
        admission: Arc<tokio::sync::Mutex<()>>,
        flow: Arc<crate::agsdl_host_flow030::FlowHost030>,
    ) -> Self {
        Self {
            inner: Arc::new(EngineInner {
                incarnation,
                admission,
                flow,
            }),
        }
    }
}
impl Default for HostState {
    fn default() -> Self {
        Self::new()
    }
}

fn new_incarnation(generation: String, ready: bool) -> Arc<Incarnation> {
    Arc::new(Incarnation {
        generation,
        compiler: Default::default(),
        work_protocol: Default::default(),
        route030: Default::default(),
        lifecycle: Default::default(),
        handoff: Mutex::new(()),
        live: AtomicBool::new(true),
        ready: AtomicBool::new(ready),
        retired: Default::default(),
        owners: Mutex::new(BTreeMap::new()),
    })
}

/// In-memory host fixture for native route-attestation tests. It creates no
/// database authority and is never compiled into the application.
#[cfg(any(test, feature = "dev-support"))]
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
        owners: Mutex::new(owners),
    });
    HostState::from_parts(
        Mutex::new(Some(OwnedHost { incarnation })),
        Arc::new(tokio::sync::Mutex::new(())),
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

    pub(crate) fn acknowledge_route_source_commit(
        &self,
        runtime: &crate::agsdl_host_flow030::FlowHost030,
        marker: &crate::agsdl_host_route_attestations030::RouteSourceCommitMarker030,
    ) -> Result<()> {
        let _handoff = self.host.handoff.lock().map_err(|_| {
            failure(
                "RUNTIME_UNAVAILABLE",
                "route",
                "Host admission is unavailable",
            )
        })?;
        self.ensure_live()?;
        if marker.generation() != self.host.generation
            || marker.identity().system_start_id != marker.owner().system_start_id
            || self
                .host
                .owners
                .lock()
                .map_err(|_| failure("RUNTIME_UNAVAILABLE", "route", "Host ownership unavailable"))?
                .get(&marker.owner().system_start_id)
                != Some(marker.owner())
        {
            return Err(failure("AUTHORITY", "route", "Native route owner changed"));
        }
        runtime.acknowledge_route_source_commit(marker)
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
            .evaluate_native(
                &self.host.generation,
                &self.host.generation,
                input_json,
                cancel,
            )
            .await?;
        self.ensure_live()?;
        Ok(result)
    }
    pub(crate) fn clock_jobs030(&self) -> Arc<crate::agsdl_host_clock030::ClockBroker030> {
        Arc::new(crate::agsdl_host_clock030::ClockBroker030::from_route(
            self.host.route030.clone(),
            self.host.generation.clone(),
        ))
    }
    pub(crate) fn call_data030(&self) -> Result<crate::agsdl_host_calls030::CallDataBroker030> {
        self.ensure_live()?;
        Ok(
            crate::agsdl_host_calls030::CallDataBroker030::from_native_route(
                self.host.route030.clone(),
                self.host.generation.clone(),
            ),
        )
    }
    /// Transfer an exact native effect to its cancellable owner while this
    /// lease keeps the incarnation attached. The caller must also hold the
    /// shared admission exclusion through the acknowledged claim commit.
    pub(crate) fn admit_owned_stream<F>(
        &self,
        owner: &EngineOwner,
        tasks: &stream_tasks::StreamTasks,
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
        tasks: &stream_tasks::StreamTasks,
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
        tasks: &stream_tasks::StreamTasks,
        parent_request_id: &str,
        operation: stream_tasks::OwnedOperation030,
    ) -> Result<stream_tasks::OwnedOperationPermit030> {
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
            .ok_or_else(|| failure("RUNTIME_UNAVAILABLE", "owner", "System has no native owner"))
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
    fn native_incarnation(&self) -> Result<Arc<Incarnation>> {
        self.inner
            .incarnation
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host state unavailable"))?
            .as_ref()
            .map(|host| host.incarnation.clone())
            .ok_or_else(|| failure("RUNTIME_UNAVAILABLE", "", "Host not installed"))
    }

    /// All process-owned runs, including call-only flows and unselected plans.
    /// Database/decoding failures are errors, never an empty activity snapshot.
    pub async fn shutdown_active_runs(&self, pool: &SqlitePool) -> Result<Vec<String>> {
        let host = self.native_incarnation()?;
        let _admission = self.admission_lock().lock_owned().await;
        self.shutdown_active_runs_for(pool, &host).await
    }

    async fn shutdown_active_runs_for(
        &self,
        pool: &SqlitePool,
        host: &Incarnation,
    ) -> Result<Vec<String>> {
        let rows = query("SELECT o.system_id,o.invocation_id,o.snapshot_id,o.capture_epoch,o.owner_epoch,r.state_json FROM engine_flow030_owners o JOIN engine_flow030_runs r ON r.system_id=o.system_id AND r.invocation_id=o.invocation_id WHERE o.generation=? ORDER BY o.system_id")
            .bind(&host.generation).fetch_all(pool).await?;
        let owners = host
            .owners
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host ownership unavailable"))?;
        let mut active = Vec::new();
        for row in rows {
            let system: String = row.try_get("system_id")?;
            let state: repository::flow030::FlowState030 =
                serde_json::from_str(row.try_get("state_json")?)?;
            if state.identity.system_start_id != system
                || state.identity.flow_invocation_id != row.get::<String, _>("invocation_id")
                || state.identity.snapshot_id != row.get::<String, _>("snapshot_id")
                || state.identity.epoch != row.get::<String, _>("capture_epoch")
                || !owners
                    .get(&system)
                    .is_some_and(|owner| owner.owner_epoch == row.get::<String, _>("owner_epoch"))
            {
                return Err(failure("CORRELATION", "", "Native shutdown owner differs"));
            }
            if state.verdict.is_none() || state.activations.iter().any(|work| work.physical) {
                active.push(system);
            }
        }
        Ok(active)
    }

    /// Consent ids only restrict the operation. The native incarnation and its
    /// retained controls select the owners; the caller cannot supply authority.
    pub async fn prepare_shutdown(
        &self,
        pool: &SqlitePool,
        tasks: &stream_tasks::StreamTasks,
        approved: &[String],
    ) -> Result<()> {
        let host = self.native_incarnation()?;
        {
            // Wait only for system Starts, not execution leases held by live
            // calls. Those calls need their supervisor to commit Stop and join.
            let _starts = self.flow030().start_admission.write().await;
            let _admission = self.admission_lock().lock_owned().await;
            if self
                .shutdown_active_runs_for(pool, &host)
                .await?
                .iter()
                .any(|id| !approved.contains(id))
            {
                return Err(failure(
                    "SHUTDOWN_ACTIVITY_CHANGED",
                    "",
                    "New native work requires consent",
                ));
            }
            self.flow030()
                .shutdown_started
                .store(true, Ordering::SeqCst);
        }
        // Revoking live leases first would prevent supervisors from persisting
        // their joined call receipts. Stop under existing controls, drain, then
        // revoke the incarnation. A cancelled waiter leaves those owners intact.
        if let Err(error) = stop_retired_flows(self.flow030(), pool, tasks, &host.generation).await
        {
            if error.code != "STOP_PENDING" {
                return Err(error);
            }
        }
        for control in self.flow030().retiring_controls(&host.generation)? {
            let system = &control.identity().system_start_id;
            if self.flow030().supervisors.is_registered(system)? {
                self.flow030().supervisors.wake(system);
                self.flow030().supervisors.wait(system).await?;
            }
        }
        stop_retired_flows(self.flow030(), pool, tasks, &host.generation).await?;
        self.revoke_native(pool, tasks).await
    }

    /// Explicit retirement belongs to the native process incarnation.
    /// Retrying reconciles the same revoked incarnation; it never recreates it.
    pub(crate) async fn revoke_native(
        &self,
        pool: &SqlitePool,
        tasks: &stream_tasks::StreamTasks,
    ) -> Result<()> {
        let host = self
            .inner
            .incarnation
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host state unavailable"))?
            .as_ref()
            .map(|host| host.incarnation.clone())
            .ok_or_else(|| failure("RUNTIME_UNAVAILABLE", "", "Host not installed"))?;
        revoke_now(&host);
        let lifecycle = host.lifecycle.clone().write_owned().await;
        let owners = host
            .owners
            .lock()
            .map_err(|_| failure("RUNTIME_UNAVAILABLE", "", "Host ownership unavailable"))?
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let admission = self.admission_lock().lock_owned().await;
        fence_generation(pool, &owners, &host.generation).await?;
        drop(admission);
        drop(lifecycle);
        stop_retired_flows(self.flow030(), pool, tasks, &host.generation).await
    }

    pub(crate) fn flow030(&self) -> &crate::agsdl_host_flow030::FlowHost030 {
        &self.inner.flow
    }
    pub(crate) fn admission_lock(&self) -> Arc<tokio::sync::Mutex<()>> {
        self.inner.admission.clone()
    }

    pub(crate) async fn admission_gate(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.inner.admission.lock().await
    }
    pub(crate) async fn start_lease(&self) -> Result<HostStartLease> {
        let host = self
            .inner
            .incarnation
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
    pub(crate) async fn compile(
        &self,
        source: repository::dto::EngineSourceRevision,
        authored_source: String,
        registry_json: String,
    ) -> Result<crate::agsdl_host_compiler::CompileReceipt> {
        let host = self
            .inner
            .incarnation
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
            .compile_native(
                &host.generation,
                source,
                authored_source,
                registry_json,
                &host.retired,
            )
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
            .inner
            .incarnation
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
            .evaluate_native(&host.generation, input, cancelled)
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
    /// admission guard across the native calculation. The caller must revalidate
    /// the flow and commit its decision in a fresh guarded transaction.
    pub(crate) async fn evaluate_flow_work030(
        &self,
        input: crate::agsdl_host_work::HostWorkInput030,
        generation: &str,
        cancelled: &tokio_util::sync::CancellationToken,
    ) -> Result<crate::agsdl_host_work::HostWorkOutput030> {
        let owner = input.context.owner.clone();
        let expected = self
            .inner
            .incarnation
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
            .inner
            .incarnation
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
    pool: &SqlitePool,
    owners: &[EngineOwner],
    generation: &str,
) -> Result<()> {
    let _ = owners;
    crate::agsdl_host_flow030::revoke_generation(pool, generation).await
}

/// Stop through the pre-commit native controls, after releasing admission.
/// Joining a stream alone is not proof that independently owned provider or
/// call descendants ended; those still require their physical receipts.
async fn stop_retired_flows(
    runtime: &crate::agsdl_host_flow030::FlowHost030,
    pool: &SqlitePool,
    tasks: &stream_tasks::StreamTasks,
    generation: &str,
) -> Result<()> {
    use repository::flow030::{FlowEvent030, FlowEventKind030};
    let mut pending = false;
    for control in runtime.retiring_controls(generation)? {
        let identity = control.identity();
        let exists: bool = query_scalar(
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
                .apply_shutdown_stop(
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

#[cfg(test)]
#[path = "agsdl_host_flow030_tests.rs"]
mod flow030_tests;

#[cfg(test)]
#[path = "agsdl_host_runtime030_tests.rs"]
mod runtime030_tests;

#[cfg(test)]
#[path = "agsdl_host_flow_work030_tests.rs"]
mod flow_work030_tests;

#[cfg(test)]
#[path = "agsdl_host_conformance030_tests.rs"]
mod conformance030_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn independent_engines_never_share_native_owner_or_incarnation() {
        let first = HostState::new();
        let cloned = first.clone();
        let second = HostState::new();
        let owner = EngineOwner {
            system_start_id: "instance-owned-run".into(),
            owner_epoch: "0".into(),
        };
        let lease = first.start_lease().await.unwrap();
        lease.retain_committed_owner(owner.clone()).unwrap();
        let cloned_lease = cloned.start_lease().await.unwrap();
        assert_eq!(lease.generation(), cloned_lease.generation());
        assert_eq!(cloned_lease.owner(&owner.system_start_id).unwrap(), owner);
        let separate = second.start_lease().await.unwrap();
        assert_ne!(lease.generation(), separate.generation());
        assert!(separate.owner(&owner.system_start_id).is_err());
        assert!(std::ptr::eq(first.flow030(), cloned.flow030()));
        assert!(!std::ptr::eq(first.flow030(), second.flow030()));
    }

    #[tokio::test]
    async fn engine_clones_share_the_same_ready_incarnation() {
        let first = HostState::default();
        let lease = first.start_lease().await.unwrap();
        let owner = EngineOwner {
            system_start_id: "process-incarnation-test".into(),
            owner_epoch: "0".into(),
        };
        lease.retain_committed_owner(owner.clone()).unwrap();
        let second = first.clone();
        let retained = second.start_lease().await.unwrap();
        assert!(Arc::ptr_eq(&lease.host, &retained.host));
        assert!(Arc::ptr_eq(&first.inner.admission, &second.inner.admission));
        assert!(Arc::ptr_eq(&first.inner.flow, &second.inner.flow));
        assert_eq!(retained.owner(&owner.system_start_id).unwrap(), owner);
        assert_eq!(lease.generation(), retained.generation());
        assert!(retained.host.live.load(Ordering::SeqCst));
        assert!(second.evaluate_flow_work030(crate::agsdl_host_work::HostWorkInput030 {
            context: serde_json::from_value(serde_json::json!({"owner":owner,"work":{"systemStartId":"process-incarnation-test","flowInvocationId":"flow","activationId":"work","agentInstanceId":"agent"},"permissionsJson":"{}","scopeJson":"{}","registryVersion":"registry"})).unwrap(),
            event_id:"event".into(), expected_revision:"0".into(), contract_json:"{}".into(), state_json:"{}".into(), event_json:"{}".into(), options_json:"{}".into()
        }, "foreign-generation", &tokio_util::sync::CancellationToken::new()).await.is_err());
        let calls = retained.call_data030().unwrap();
        let clocks = retained.clock_jobs030();
        let input = crate::agsdl_host_clock030::HostClockInput030 {
            identity: repository::flow030::FlowIdentity030 {
                system_start_id: owner.system_start_id.clone(), flow_invocation_id: "flow".into(), snapshot_id: "snapshot".into(), epoch: "capture".into(),
            },
            owner: owner.clone(), event_id: "tick".into(), expected_revision: "0".into(), state_json: String::new(),
            event_json: serde_json::json!({"owner":owner,"eventId":"tick","nowMs":"0","event":{"kind":"tick"}}).to_string(),
            options_json: "{\"maxSliceMs\":2147483647}".into(),
        };
        let foreign = clocks
            .evaluate(
                "foreign-generation",
                input.clone(),
                &tokio_util::sync::CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(foreign.code, "CORRELATION");
        let output = clocks
            .evaluate(
                retained.generation(),
                input,
                &tokio_util::sync::CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&output.state_json).unwrap()["owner"],
            serde_json::to_value(owner).unwrap()
        );
        drop(calls);
    }

    fn test_operation030() -> stream_tasks::OwnedOperation030 {
        stream_tasks::OwnedOperation030 {
            identity: crate::persistence::flow030::FlowIdentity030 {
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
                .inner
                .incarnation
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
            let tasks = stream_tasks::StreamTasks::default();
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
            owners: Mutex::new(BTreeMap::new()),
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
            owners: Mutex::new(BTreeMap::new()),
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
        let tasks = stream_tasks::StreamTasks::default();
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
            owners: Mutex::new(BTreeMap::new()),
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
}
