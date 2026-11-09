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
    error_route030(host, pool, owner, reference, None, cancelled).await
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
    error_route030(host, pool, owner, reference, Some(joined), cancelled).await
}

async fn error_route030(
    host: &HostState,
    pool: &SqlitePool,
    owner: &EngineOwner,
    reference: &PrepareRef030,
    joined: Option<&JoinedOwnedAgent030>,
    cancelled: &CancellationToken,
) -> Result<Apply030> {
    let attestor = RouteAttestor030::capture(host, owner).await?;
    let verifier = SqlRouteMaterialVerifier030::capture(host, owner).await?;
    let lease = host.start_lease().await?;
    let gate = host.admission_lock().lock_owned().await;
    let mut pending = host.flow030().pending_route_source_commit(reference)?;
    if let Some(joined) = joined {
        let attempt = joined.attempt();
        if attempt.identity() != &reference.identity
            || attempt.owner() != owner
            || attempt.generation() != lease.generation()
            || attempt.work().activation_id != reference.activation_id
        {
            return Err(failure(
                "CORRELATION",
                "route",
                "Joined error source differs",
            ));
        }
    }
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
        .inspect_error_source_tx(&mut tx, &lease, host.flow030(), &capture, reference)
        .await?;
    let mut created = false;
    let source = match source {
        Some(source) => source,
        None if pending.is_some() || joined.is_none() => {
            return Err(failure(
                "UNCERTAIN",
                "route",
                "Error source commit is unresolved",
            ));
        }
        None => {
            let source = attestor
                .attest_error_source_tx(&mut tx, &lease, host.flow030(), &capture, reference)
                .await?;
            pending = Some(host.flow030().begin_route_source_commit(&source)?);
            created = true;
            source
        }
    };
    let material = source.source_only_material();
    lease.ensure_live()?;
    #[cfg(all(feature = "agsdl-engine-qa", debug_assertions))]
    if created {
        crate::agsdl_host_example030::pause_before_source_commit(reference).await;
    }
    tx.commit()
        .await
        .map_err(|_| failure("UNCERTAIN", "route", "Source readback did not complete"))?;
    #[cfg(all(feature = "agsdl-engine-qa", debug_assertions))]
    if created {
        crate::agsdl_host_example030::pause_after_source_commit(reference).await;
    }
    #[cfg(not(all(feature = "agsdl-engine-qa", debug_assertions)))]
    let _ = created;
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
