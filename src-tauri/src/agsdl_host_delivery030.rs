//! Graphless message admission against the retained 0.3 capture.
use super::*;
use crate::agsdl_host_projection030::RuntimeProjectionScope030;
use crate::db::agsdl_execution::flow030::{FlowPlan030, Instance030};

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliveryRequest030 {
    pub scope: RuntimeProjectionScope030,
    pub delivery_id: String,
    pub agent_name: String,
    /// Absent selects the shared instance. A name selects an existing or new named instance.
    pub instance: Option<String>,
    pub delivery: String,
    pub message_json: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliveryReceipt030 {
    pub scope: RuntimeProjectionScope030,
    pub delivery_id: String,
    pub event_id: String,
    pub revision: String,
}

pub(crate) async fn deliver030(
    host: &HostState,
    pool: &SqlitePool,
    request: DeliveryRequest030,
) -> Result<DeliveryReceipt030> {
    if request.delivery_id.is_empty()
        || request.delivery_id.len() > 128
        || request.message_json.len() > 1_000_000
        || !["queue", "steer"].contains(&request.delivery.as_str())
        || request.instance.as_ref().is_some_and(|s| {
            s == "new"
                || s.is_empty()
                || s.len() > 64
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
    {
        return Err(failure(
            "INPUT_CONSTRAINT",
            "message",
            "Invalid message delivery",
        ));
    }
    crate::db::agsdl_execution::validate_json(&request.message_json)?;
    let lease = host.start_lease().await?;
    let owner = lease.owner(&request.scope.system_start_id)?;
    let inspection = inspect_run(host.flow030(), host, pool, &owner).await?;
    if inspection.capture.source != request.scope.source
        || inspection.capture.identity.snapshot_id != request.scope.snapshot_id
    {
        return Err(failure(
            "CORRELATION",
            "scope",
            "Message target differs from the retained run",
        ));
    }
    let plan: FlowPlan030 = serde_json::from_str(&inspection.capture.compiled_plan_json)?;
    if plan.entry.is_some()
        || !plan
            .graphless_submission_contracts
            .contains_key(&request.agent_name)
    {
        return Err(failure(
            "INPUT_CONSTRAINT",
            "agent",
            "External messages require an agent in a document without a flow",
        ));
    }
    let mut registry: Value = serde_json::from_str(&inspection.capture.registry_json)?;
    registry["deliveryInput"] =
        json!({"agentName":request.agent_name,"messageJson":request.message_json});
    let receipt = host
        .compile(
            inspection.capture.source.clone(),
            inspection.capture.authored_source.clone(),
            registry.to_string(),
        )
        .await?;
    let validation: Value = serde_json::from_str(&receipt.result_json)?;
    if receipt.generation != lease.generation()
        || validation
            .pointer("/deliveryValidation/valid")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Err(failure(
            "INPUT_CONSTRAINT",
            "message",
            "Message does not satisfy this agent's input contract",
        ));
    }
    let _admission = host.admission_lock().lock_owned().await;
    let authority = Authority {
        runtime: host.flow030(),
        lease: &lease,
        owner,
    };
    let mut db = pool.acquire().await?;
    sqlx::query("PRAGMA synchronous=FULL")
        .execute(&mut *db)
        .await?;
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    let view = flow_store030::read_tx(&mut tx, &authority, &inspection.capture.identity)
        .await
        .map_err(store_error)?;
    let event_id = format!(
        "deliver030:{:x}",
        Sha256::digest(request.delivery_id.as_bytes())
    );
    let kind = FlowEventKind030::Deliver {
        agent: request.agent_name,
        instance: request
            .instance
            .map(|name| Instance030::Named { name })
            .unwrap_or(Instance030::Shared),
        delivery: request.delivery,
        message_json: request.message_json,
        sender: "host".into(),
    };
    // Reuse the retained event's revision for exact idempotent readback. A changed
    // payload with the same id conflicts instead of creating a second message.
    let previous: Option<String> = sqlx::query_scalar("SELECT event_json FROM engine_flow030_events WHERE system_id=? AND invocation_id=? AND event_id=?")
        .bind(&inspection.capture.identity.system_start_id).bind(&inspection.capture.identity.flow_invocation_id).bind(&event_id).fetch_optional(&mut *tx).await?;
    let expected_revision = match previous {
        Some(raw) => serde_json::from_str::<Value>(&raw)?["expectedRevision"]
            .as_str()
            .ok_or_else(refused)?
            .to_owned(),
        None => view.state.revision,
    };
    let event = FlowEvent030 {
        identity: inspection.capture.identity,
        event_id: event_id.clone(),
        expected_revision,
        kind,
    };
    let applied = apply_native_event_transaction030(host.flow030(), &lease, tx, &event).await?;
    let revision = match applied {
        Apply030::Applied(r) | Apply030::Replayed(r) => r.revision,
        Apply030::Diagnostic(_) => {
            return Err(failure(
                "UNSPECIFIED_SHARED_CANCELLATION",
                "delivery",
                "Shared cancellation requires a specification decision; stop this run",
            ))
        }
    };
    Ok(DeliveryReceipt030 {
        scope: request.scope,
        delivery_id: request.delivery_id,
        event_id,
        revision,
    })
}
