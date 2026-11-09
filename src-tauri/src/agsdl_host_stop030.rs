//! Native stop supervision. A joined task is not, by itself, proof that its
//! physical descendants ended; the reducer keeps such work pending until the
//! owning executor supplies its physical receipt.
use crate::agsdl_host_flow030::{FlowControl030, FlowHost030};
use crate::ai::stream_tasks::StreamTasks;
use crate::db::agsdl_execution::{
    dto::EngineStopRequest,
    failure,
    flow030::{FlowEffect030, WorkRef030},
    public::PublicStopState,
    Result,
};
use sqlx::SqlitePool;

/// Persist the exact system Stop before attempting any cancellation. A logical
/// receipt is not physical completion; completion remains pending until the
/// native executor and its descendants have supplied their actual receipts.
pub(crate) async fn request(
    runtime: &FlowHost030,
    pool: &SqlitePool,
    tasks: &StreamTasks,
    request: &EngineStopRequest,
) -> Result<PublicStopState> {
    let admitted =
        crate::agsdl_host_flow030::request_system_stop030(runtime, pool, request).await?;
    let _physical_pending = reconcile(runtime, pool, tasks, admitted.control()).await?;
    Ok(PublicStopState::Requested {
        request_id: admitted.receipt().request_id.clone(),
    })
}

/// Resume observation of a durable Stop without creating a new request or
/// treating an absent row as evidence that an uncertain commit rolled back.
pub(crate) async fn ensure(
    runtime: &FlowHost030,
    pool: &SqlitePool,
    tasks: &StreamTasks,
    system_start_id: &str,
) -> Result<PublicStopState> {
    let raw: Option<String> = sqlx::query_scalar(
        "SELECT request_json FROM engine_flow030_system_stop_requests WHERE system_id=? ORDER BY rowid DESC LIMIT 1",
    )
    .bind(system_start_id)
    .fetch_optional(pool)
    .await?;
    let Some(raw) = raw else {
        return Err(failure(
            "UNCERTAIN",
            "stop",
            "No durable Stop receipt can establish the outcome",
        ));
    };
    let request: EngineStopRequest = serde_json::from_str(&raw)?;
    if request.system_start_id != system_start_id || request.activation_id.is_some() {
        return Err(failure("CORRELATION", "stop", "Stored Stop scope differs"));
    }
    let admitted =
        crate::agsdl_host_flow030::inspect_system_stop_request030(runtime, pool, &request)
            .await?
            .ok_or_else(|| failure("UNCERTAIN", "stop", "Stop receipt is unavailable"))?;
    let _physical_pending = reconcile(runtime, pool, tasks, admitted.control()).await?;
    Ok(PublicStopState::Requested {
        request_id: admitted.receipt().request_id.clone(),
    })
}

/// Reconcile one already-stopping flow under its opaque native control.
/// Admission is never held while awaiting a task join. `true` means physical
/// termination remains unproven, not that an absent task was safely stopped.
pub(crate) async fn reconcile(
    runtime: &FlowHost030,
    pool: &SqlitePool,
    tasks: &StreamTasks,
    control: &FlowControl030,
) -> Result<bool> {
    let identity = control.identity();
    let view = control.read(pool).await?;
    if !view.state.stopping && view.state.verdict.is_none() {
        return Err(failure("CORRELATION", "stop", "Flow is not stopping"));
    }
    if view.state.stopping {
        for activation in view.state.activations.iter().filter(|work| work.physical) {
            if let Some(start_effect_id) = &activation.start_effect_id {
                let work = WorkRef030 {
                    activation_id: activation.id.clone(),
                    start_effect_id: start_effect_id.clone(),
                    agent_instance_id: activation.instance_id.clone(),
                };
                if control
                    .settle_unadmitted(runtime, pool, &work)
                    .await?
                    .is_none()
                {
                    if let Some(joined) = runtime.diagnostic_join(identity, &work.activation_id)? {
                        control
                            .settle_joined_diagnostic(runtime, pool, &joined, None)
                            .await?;
                    }
                }
            }
        }
    }
    let view = control.read(pool).await?;
    for row in view.effects {
        if !matches!(
            row.get("status").and_then(serde_json::Value::as_str),
            Some("uncertain" | "settled")
        ) {
            continue;
        }
        let effect: FlowEffect030 = serde_json::from_value(row["effect"].clone())?;
        let request_id = format!("flow030:{}:{}", identity.system_start_id, effect.id);
        tasks
            .cancel_owned(&request_id)
            .await
            .map_err(|_| failure("STOP_PENDING", "", "Native flow task did not join"))?;
    }
    let view = control.read(pool).await?;
    Ok(view.state.activations.iter().any(|work| work.physical))
}
