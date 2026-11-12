//! Ownership boundaries shared by the native 0.3 dispatcher and supervisor.
use crate::{
    agsdl_host::HostState,
    agsdl_host_flow030::{self, FlowWorkAttempt030},
    agsdl_host_route_attestations030::RouteAttestor030,
    agsdl_host_route_verifier030::SqlRouteMaterialVerifier030,
    ai::stream_tasks::StreamTasks,
    db::agsdl_execution::{
        dto::EngineOwner, failure, flow030::PrepareRef030, flow_store030::Apply030,
        start030::StartCapture030, Result,
    },
};
use sqlx::{Connection, SqlitePool};
use tokio_util::sync::CancellationToken;

pub(crate) use crate::ai::stream_tasks::JoinedOwnedAgent030;

/// Recover an already committed 037 error source and send it to the actual
/// route mailbox. Absence is unresolved: this path never emits a new receipt.
pub(crate) async fn resume_error_route030(
    host: &HostState,
    pool: &SqlitePool,
    owner: &EngineOwner,
    reference: &PrepareRef030,
    cancelled: &CancellationToken,
) -> Result<Apply030> {
    resume_source_route030(host, pool, owner, reference, cancelled).await
}

/// A joined agent is process-local evidence for a newly committed failure.
/// It cannot be reconstructed from an absent SQL row after a restart.
pub(crate) async fn dispatch_joined_error_route030(
    host: &HostState,
    pool: &SqlitePool,
    owner: &EngineOwner,
    reference: &PrepareRef030,
    joined: &JoinedOwnedAgent030,
    cancelled: &CancellationToken,
) -> Result<Apply030> {
    dispatch_source_route030(
        host,
        pool,
        owner,
        reference,
        SourceOwnership030::Agent(joined),
        cancelled,
    )
    .await
}

/// Read back only; an absent source remains unresolved even for joins.
pub(crate) async fn resume_source_route030(
    host: &HostState,
    pool: &SqlitePool,
    owner: &EngineOwner,
    reference: &PrepareRef030,
    cancelled: &CancellationToken,
) -> Result<Apply030> {
    source_route030(
        host,
        pool,
        owner,
        reference,
        SourceRouteMode030::InspectOnly,
        cancelled,
    )
    .await
}

/// Creation remains authenticated by the 037 writer. A join requires no
/// fabricated agent witness; every other new source requires an exact join.
pub(crate) async fn dispatch_source_route030(
    host: &HostState,
    pool: &SqlitePool,
    owner: &EngineOwner,
    reference: &PrepareRef030,
    ownership: SourceOwnership030<'_>,
    cancelled: &CancellationToken,
) -> Result<Apply030> {
    source_route030(
        host,
        pool,
        owner,
        reference,
        SourceRouteMode030::Dispatch(ownership),
        cancelled,
    )
    .await
}

#[derive(Clone, Copy)]
pub(crate) enum SourceOwnership030<'a> {
    Host,
    Agent(&'a JoinedOwnedAgent030),
    Call(&'a crate::agsdl_host_calls030::JoinedCall030),
    Join,
}
enum SourceRouteMode030<'a> {
    InspectOnly,
    Dispatch(SourceOwnership030<'a>),
}

async fn source_route030(
    host: &HostState,
    pool: &SqlitePool,
    owner: &EngineOwner,
    reference: &PrepareRef030,
    mode: SourceRouteMode030<'_>,
    cancelled: &CancellationToken,
) -> Result<Apply030> {
    let joined = match &mode {
        SourceRouteMode030::InspectOnly => None,
        SourceRouteMode030::Dispatch(SourceOwnership030::Agent(joined)) => Some(*joined),
        _ => None,
    };
    let attestor = RouteAttestor030::capture(host, owner).await?;
    let verifier = SqlRouteMaterialVerifier030::capture(host, owner).await?;
    let lease = host.start_lease().await?;
    let gate = host.admission_lock().lock_owned().await;
    let mut pending = host.flow030().pending_route_source_commit(reference)?;
    let mut db = pool.acquire().await?;
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    let raw: String = sqlx::query_scalar(
        "SELECT capture_json FROM engine_start030_requests WHERE system_id=? AND invocation_id=?",
    )
    .bind(&reference.identity.system_start_id)
    .bind(&reference.identity.flow_invocation_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| failure("CORRELATION", "route", "Captured flow is absent"))?;
    let capture: StartCapture030 = serde_json::from_str(&raw)?;
    let source = attestor
        .inspect_source_tx(&mut tx, &lease, host.flow030(), &capture, reference)
        .await?;
    let mut created = false;
    let source = match source {
        Some(source) => source,
        None if pending.is_some() || matches!(mode, SourceRouteMode030::InspectOnly) => {
            return Err(failure(
                "UNCERTAIN",
                "route",
                "Error source commit is unresolved",
            ));
        }
        None => {
            let source = attestor
                .attest_source_tx(&mut tx, &lease, host.flow030(), &capture, reference)
                .await?;
            created = true;
            source
        }
    };
    if let Some(joined) = joined {
        let attempt = joined.attempt();
        let producer = source.producer();
        if attempt.identity() != &reference.identity
            || attempt.owner() != owner
            || attempt.generation() != lease.generation()
            || attempt.work().activation_id != producer.activation_id
            || attempt.work().step != producer.step
        {
            return Err(failure(
                "CORRELATION",
                "route",
                "Joined producer differs from the captured route source",
            ));
        }
    }
    if matches!(mode, SourceRouteMode030::Dispatch(_)) {
        use crate::agsdl_host_route_attestations030::SourceOwnershipKind030;
        match (&mode, source.ownership_kind()) {
            (
                SourceRouteMode030::Dispatch(SourceOwnership030::Host),
                SourceOwnershipKind030::Host,
            ) => {}
            (
                SourceRouteMode030::Dispatch(SourceOwnership030::Agent(_)),
                SourceOwnershipKind030::Agent,
            ) => {}
            (
                SourceRouteMode030::Dispatch(SourceOwnership030::Join),
                SourceOwnershipKind030::Join,
            ) => {}
            (
                SourceRouteMode030::Dispatch(SourceOwnership030::Host),
                SourceOwnershipKind030::Call,
            ) => {
                let receipt = crate::agsdl_host_route_verifier030::verify_call_source_tx(
                    &mut tx,
                    &capture,
                    source.producer(),
                    owner,
                    lease.generation(),
                )
                .await
                .map_err(|_| failure("AUTHORITY", "route", "Call preparation receipt differs"))?;
                if !receipt.not_started() {
                    return Err(failure(
                        "CORRELATION",
                        "route",
                        "Launched calls require their joined owner",
                    ));
                }
            }
            (
                SourceRouteMode030::Dispatch(SourceOwnership030::Call(joined)),
                SourceOwnershipKind030::Call,
            ) => {
                let receipt = crate::agsdl_host_route_verifier030::verify_call_source_tx(
                    &mut tx,
                    &capture,
                    source.producer(),
                    owner,
                    lease.generation(),
                )
                .await
                .map_err(|_| failure("AUTHORITY", "route", "Call source receipt differs"))?;
                if !receipt.matches_joined(joined)? {
                    return Err(failure(
                        "CORRELATION",
                        "route",
                        "Call source requires its exact joined owner",
                    ));
                }
            }
            _ => {
                return Err(failure(
                    "CORRELATION",
                    "route",
                    "Route source ownership kind differs",
                ))
            }
        }
    }
    if created {
        pending = Some(host.flow030().begin_route_source_commit(&source)?);
    }
    let material = source.source_only_material();
    lease.ensure_live()?;
    tx.commit()
        .await
        .map_err(|_| failure("UNCERTAIN", "route", "Source readback did not complete"))?;
    if let Some(marker) = pending {
        lease
            .acknowledge_route_source_commit(host.flow030(), &marker)
            .map_err(|_| failure("UNCERTAIN", "route", "Source readback was not acknowledged"))?;
    }
    drop(db);
    drop(gate);
    drop(lease);
    agsdl_host_flow030::prepare_route(
        host.flow030(),
        host,
        pool,
        owner,
        reference,
        material,
        &verifier,
        cancelled,
    )
    .await
}

/// Request cancellation, then wait until the existing native owner has joined
/// the future and attached cleanups. Call outside lifecycle/admission guards.
/// A missing owner or uncertain cleanup never yields a join witness.
pub(crate) async fn cancel_and_join_owned_agent030(
    tasks: &StreamTasks,
    attempt: &FlowWorkAttempt030,
) -> Result<JoinedOwnedAgent030> {
    tasks.join_agent030(attempt, true).await.map_err(|_| {
        failure(
            "STOP_PENDING",
            "work",
            "The owned work and its attached cleanups have not joined",
        )
    })
}

/// Observe normal completion without aborting the parent. The registry's
/// completion includes the parent's registered cleanups.
pub(crate) async fn join_owned_agent030(
    tasks: &StreamTasks,
    attempt: &FlowWorkAttempt030,
) -> Result<JoinedOwnedAgent030> {
    tasks
        .join_agent030(attempt, false)
        .await
        .map_err(|_| failure("STOP_PENDING", "work", "Owned work did not finish cleanly"))
}

/// Claim one exact StopWork before signalling the already-owned parent. The
/// claim remains uncertain if joining or its physical commit cannot complete.
pub(crate) async fn dispatch_stop_work030(
    host: &HostState,
    pool: &SqlitePool,
    tasks: &StreamTasks,
    owner: &EngineOwner,
    effect: &crate::db::agsdl_execution::flow030::FlowEffect030,
    attempt: &FlowWorkAttempt030,
) -> Result<Apply030> {
    if attempt.owner() != owner || attempt.identity() != &effect.identity {
        return Err(failure("CORRELATION", "stop", "Stop owner differs"));
    }
    let claim =
        agsdl_host_flow030::claim_expected_stop_work(host.flow030(), host, pool, effect, attempt)
            .await?
            .ok_or_else(|| failure("STALE_REFERENCE", "stop", "Stop effect changed"))?;
    if claim.effect() != effect {
        return Err(failure("CORRELATION", "stop", "Stop effect differs"));
    }
    let claim = claim.into_stop_work(attempt)?;
    // No admission lock or SQLite transaction is held while joining.
    let joined = cancel_and_join_owned_agent030(tasks, attempt).await?;
    claim
        .control()
        .settle_joined_diagnostic(host.flow030(), pool, &joined, Some(&claim))
        .await
}
