use argentic_runtime::api::{
    OperatorAction, OperatorRequest, OperatorWorkState, RuntimeProjectionContinuation030,
    RuntimeProjectionPage030, RuntimeProjectionQuery030,
};
use argentic_runtime::persistence::{
    failure,
    flow030::{FlowReceipt030, OperatorEvent030},
    Result,
};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

pub(crate) async fn control_run(
    host: &crate::agsdl_host::HostState,
    pool: &SqlitePool,
    request: OperatorRequest,
) -> Result<FlowReceipt030> {
    let result = host.control_run(pool, request.clone()).await;
    if !matches!(&result, Err(error) if error.code == "OPERATOR_TRANSITION" || error.code == "RUNTIME_UNAVAILABLE")
    {
        return result;
    }

    // A completed or fenced run no longer has a supervisor to replay the
    // receipt. Read only the committed event for the exact capture and action.
    let event_id = format!(
        "operator:{:x}",
        Sha256::digest(request.request_id.as_bytes())
    );
    let stored: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT e.event_json, e.receipt_json
         FROM engine_flow030_events e
         JOIN engine_flow030_runs r USING (system_id, invocation_id)
         JOIN engine_flow030_owners o USING (system_id, invocation_id)
         WHERE r.system_id=? AND r.snapshot_id=? AND r.source_json=? AND e.event_id=?
             AND (r.state_json ->> '$.verdict' IS NOT NULL OR o.status='revoked')",
    )
    .bind(&request.scope.system_start_id)
    .bind(&request.scope.snapshot_id)
    .bind(serde_json::to_string(&request.scope.source)?)
    .bind(&event_id)
    .fetch_optional(pool)
    .await?;
    let Some((event, Some(receipt))) = stored else {
        return result;
    };
    let event: serde_json::Value = serde_json::from_str(&event)?;
    let recorded: OperatorEvent030 = serde_json::from_value(event["kind"]["Operator"].clone())?;
    let matches = match (request.action, recorded) {
        (
            OperatorAction::InterruptWork { activation_id },
            OperatorEvent030::Hold {
                activation_id: recorded,
            },
        )
        | (
            OperatorAction::ResumeWork { activation_id },
            OperatorEvent030::ResumeWork {
                activation_id: recorded,
            },
        ) => activation_id == recorded,
        (OperatorAction::PauseRun, OperatorEvent030::Pause { .. })
        | (OperatorAction::ResumeRun, OperatorEvent030::ResumeRun) => true,
        _ => false,
    };
    if !matches {
        return Err(failure(
            "CONFLICT",
            "requestId",
            "Operator request ID has another action",
        ));
    }
    Ok(serde_json::from_str(&receipt)?)
}

pub(crate) async fn read_runtime(
    host: &crate::agsdl_host::HostState,
    pool: &SqlitePool,
    scope: RuntimeProjectionQuery030,
    continuation: Option<RuntimeProjectionContinuation030>,
) -> crate::db::agsdl_execution::Result<RuntimeProjectionPage030> {
    let mut page = crate::agsdl_host_projection030::read(host, pool, scope, continuation).await?;
    if matches!(page.verdict.as_deref(), Some("cancelled" | "interrupted")) {
        let shutdown: Option<(bool, String)> = sqlx::query_as(
            "SELECT paused, holds_json FROM operate_shutdown_holds WHERE system_id=? AND invocation_id=?",
        )
        .bind(&page.scope.system_start_id)
        .bind(&page.flow_invocation_id)
        .fetch_optional(pool)
        .await?;
        if let Some((paused, holds_json)) = shutdown {
            let holds: std::collections::BTreeMap<String, serde_json::Value> =
                serde_json::from_str(&holds_json)?;
            page.verdict = Some("interrupted".into());
            page.interrupted_while_paused |= paused;
            page.operator_works.extend(holds.into_keys().map(|id| {
                (
                    id,
                    OperatorWorkState::Interrupted {
                        code: "INTERRUPTED".into(),
                    },
                )
            }));
        }
    }
    Ok(page)
}
