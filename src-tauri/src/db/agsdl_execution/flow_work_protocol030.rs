//! Work-controller persistence bound to the native 0.3 flow, never State020.
//!
//! Integration prerequisite: 09 must make `FlowHost030::available` and a
//! concrete `HostState::evaluate_flow_work030` crate-visible. The latter must
//! authenticate the exact resident mailbox and generation, and return only a
//! matching completion; it must not accept a caller-supplied verifier. No IPC
//! handler may call these entry points with model-selected authority.
//!
//! The proposed schema is delivered separately to the migration owner. The
//! native admission and event-authorization tables must be written exclusively
//! by 09 under the same lifecycle lease, admission gate and SQL transaction as
//! the corresponding native attestations. Missing rows fail closed.
use super::{
    decimal,
    dto::EngineContext,
    failure,
    flow030::{FlowEffect030, FlowEffectKind030, FlowIdentity030, FlowState030},
    opaque, validate_json,
    work_protocol030::{CheckRequest030, ProtocolDecision030, ProtocolEvent030},
    Result,
};
use crate::{
    agsdl_host::{HostStartLease, HostState},
    agsdl_host_work::{captured_work_contract030, CapturedWorkPlan030, HostWorkInput030},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row, SqliteConnection, SqlitePool};
use tokio_util::sync::CancellationToken;

const EMPTY_JOURNAL: &str = r#"{"format":"macro-agsdl-work-journal/1","events":[]}"#;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FlowWorkTicket030 {
    pub identity: FlowIdentity030,
    pub input: ProtocolEvent030,
    pub ticket_id: String,
    pub generation: String,
    pub flow_revision: String,
    pub state_json: String,
    pub contract_json: String,
    pub options_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Reservation030 {
    Pending(FlowWorkTicket030),
    Committed(ProtocolDecision030),
}

struct Binding030 {
    context: EngineContext,
    flow_revision: String,
    contract_json: String,
    options_json: String,
}
fn denied(message: &str) -> super::dto::EngineFailure {
    failure("CORRELATION", "flowWork030", message)
}
fn uncertain() -> super::dto::EngineFailure {
    failure(
        "UNCERTAIN",
        "flowWork030",
        "Commit or handoff is uncertain; do not replay effects",
    )
}
fn require(ok: bool, message: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(denied(message))
    }
}
fn json<T: Serialize>(value: &T) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}

fn live_activation<'a>(
    flow: &'a FlowState030,
    id: &FlowIdentity030,
    activation_id: &str,
    control: bool,
) -> Result<&'a super::flow030::Activation030> {
    decimal(&flow.revision)?;
    require(
        flow.identity == *id && (control || (!flow.stopping && flow.verdict.is_none())),
        "Flow is stopped or terminal",
    )?;
    let activation = flow
        .activations
        .iter()
        .find(|a| a.id == activation_id)
        .ok_or_else(|| denied("Activation missing"))?;
    require(
        activation.physical
            && if control {
                ["running", "stopping", "done"].contains(&activation.phase.as_str())
            } else {
                activation.phase == "running"
                    && activation.stop_effect_id.is_none()
                    && activation.result.is_none()
            },
        "Activation is stopped, finished or not physical",
    )?;
    Ok(activation)
}

/// Rechecks ownership, immutable native capture, actual running activation,
/// owned physical Start handoff, and an already-attested native work admission.
/// It reads every fact on the caller's immediate transaction. The host gate
/// must be held until COMMIT; no callback can assert authorization.
async fn binding(
    db: &mut SqliteConnection,
    lease: &HostStartLease,
    id: &FlowIdentity030,
    activation_id: &str,
    control: bool,
) -> Result<Binding030> {
    lease.ensure_live()?;
    let owner = lease.owner(&id.system_start_id)?;
    let row = sqlx::query("SELECT invocation_id,snapshot_id,capture_epoch,owner_epoch,generation,status,capture_sha256 FROM engine_flow030_owners WHERE system_id=?")
        .bind(&id.system_start_id).fetch_optional(&mut *db).await?.ok_or_else(|| denied("Flow owner missing"))?;
    let capture_hash: String = row.get("capture_sha256");
    require(
        row.get::<&str, _>("invocation_id") == id.flow_invocation_id
            && row.get::<&str, _>("snapshot_id") == id.snapshot_id
            && row.get::<&str, _>("capture_epoch") == id.epoch
            && row.get::<&str, _>("owner_epoch") == owner.owner_epoch
            && row.get::<&str, _>("generation") == lease.generation()
            && row.get::<&str, _>("status") == "live",
        "Flow owner differs or was revoked",
    )?;
    let raw: String = sqlx::query_scalar(
        "SELECT capture_json FROM engine_start030_requests WHERE system_id=? AND invocation_id=?",
    )
    .bind(&id.system_start_id)
    .bind(&id.flow_invocation_id)
    .fetch_optional(&mut *db)
    .await?
    .ok_or_else(|| denied("Start capture missing"))?;
    let capture: super::start030::StartCapture030 = serde_json::from_str(&raw)?;
    require(
        capture.identity == *id
            && format!("{:x}", Sha256::digest(serde_json::to_vec(&capture)?)) == capture_hash,
        "Captured identity or digest differs",
    )?;
    let run = sqlx::query("SELECT snapshot_id,epoch,plan_json,state_json FROM engine_flow030_runs WHERE system_id=? AND invocation_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).fetch_optional(&mut *db).await?
        .ok_or_else(|| denied("Flow run missing"))?;
    require(
        run.get::<&str, _>("snapshot_id") == id.snapshot_id
            && run.get::<&str, _>("epoch") == id.epoch
            && run.get::<&str, _>("plan_json") == capture.compiled_plan_json,
        "Flow capture differs",
    )?;
    let flow: FlowState030 = serde_json::from_str(run.get("state_json"))?;
    let activation = live_activation(&flow, id, activation_id, control)?;
    let start_id = activation
        .start_effect_id
        .as_ref()
        .ok_or_else(|| denied("Start effect missing"))?;
    let row = sqlx::query("SELECT effect_json,status,owner_epoch FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? AND effect_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(start_id).fetch_optional(&mut *db).await?
        .ok_or_else(|| denied("Start effect missing"))?;
    let effect: FlowEffect030 = serde_json::from_str(row.get("effect_json"))?;
    require(
        row.get::<&str, _>("status") == "settled"
            && row.get::<&str, _>("owner_epoch") == owner.owner_epoch
            && effect.id == *start_id
            && effect.identity == *id,
        "Start is not owned and handed off",
    )?;
    let work = match effect.kind {
        FlowEffectKind030::Start {
            work, step, agent, ..
        } if work.activation_id == activation.id
            && work.start_effect_id == *start_id
            && work.agent_instance_id == activation.instance_id
            && step == activation.step
            && agent == activation.agent =>
        {
            work
        }
        _ => return Err(denied("Start attribution differs")),
    };
    let handoff: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_flow030_handoffs WHERE system_id=? AND invocation_id=? AND effect_id=? AND owner_epoch=? AND generation=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(start_id).bind(&owner.owner_epoch).bind(lease.generation())
        .fetch_one(&mut *db).await?;
    require(handoff == 1, "Native owned handoff missing")?;
    let grant = sqlx::query("SELECT start_effect_id,owner_epoch,generation,capture_sha256,context_json,contract_json,options_json,policy_evidence_json FROM engine_flow030_work_admissions WHERE system_id=? AND invocation_id=? AND activation_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(activation_id).fetch_optional(&mut *db).await?
        .ok_or_else(|| failure("PERMISSION", "admission", "Native work policy is not attested"))?;
    let context: EngineContext = serde_json::from_str(grant.get("context_json"))?;
    require(
        grant.get::<&str, _>("start_effect_id") == start_id
            && grant.get::<&str, _>("owner_epoch") == owner.owner_epoch
            && grant.get::<&str, _>("generation") == lease.generation()
            && grant.get::<&str, _>("capture_sha256") == capture_hash
            && context.owner == owner
            && context.work.system_start_id == id.system_start_id
            && context.work.flow_invocation_id == id.flow_invocation_id
            && context.work.activation_id == work.activation_id
            && context.work.step == activation.step
            && context.work.agent_instance_id == work.agent_instance_id
            && context.registry_version == capture.versions.registry,
        "Work admission attribution differs",
    )?;
    let agent = activation
        .agent
        .as_deref()
        .ok_or_else(|| denied("Agent missing"))?;
    let expected = captured_work_contract030(
        &CapturedWorkPlan030 {
            system_start_id: &id.system_start_id,
            source: &capture.source,
            versions: &capture.versions,
            compiled_plan_json: &capture.compiled_plan_json,
        },
        &context.work,
        agent,
    )?;
    let contract: String = grant.get("contract_json");
    let options: String = grant.get("options_json");
    let evidence: String = grant.get("policy_evidence_json");
    for raw in [
        &contract,
        &options,
        &evidence,
        &context.permissions_json,
        &context.scope_json,
    ] {
        validate_json(raw)?;
    }
    require(
        contract == expected,
        "Admitted contract differs from captured 02 contract",
    )?;
    lease.ensure_live()?;
    Ok(Binding030 {
        context,
        flow_revision: flow.revision,
        contract_json: contract,
        options_json: options,
    })
}

async fn reserve_tx(
    db: &mut SqliteConnection,
    lease: &HostStartLease,
    id: &FlowIdentity030,
    input: &ProtocolEvent030,
) -> Result<Reservation030> {
    opaque(&input.event_id)?;
    decimal(&input.expected_revision)?;
    validate_json(&input.event_json)?;
    // The immutable authorization row is written by the native supervisor;
    // the control flag alone never authorizes an event.
    let bound = binding(
        db,
        lease,
        id,
        &input.context.work.activation_id,
        input.control,
    )
    .await?;
    require(
        bound.context == input.context,
        "Event context differs from attested admission",
    )?;
    let raw = json(input)?;
    let authorized = sqlx::query("SELECT input_json,provider_attempt_id,native_call_id FROM engine_flow030_work_authorizations WHERE system_id=? AND invocation_id=? AND event_id=? AND activation_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&input.event_id).bind(&input.context.work.activation_id)
        .fetch_optional(&mut *db).await?.ok_or_else(|| denied("Native event provenance is not authorized"))?;
    let attempt = input
        .native_call
        .as_ref()
        .map(|call| call.provider_attempt_id.as_str());
    let native_call = input
        .native_call
        .as_ref()
        .map(|call| call.native_call_id.as_str());
    if let Some(id) = attempt {
        opaque(id)?;
    }
    if let Some(id) = native_call {
        opaque(id)?;
    }
    require(
        authorized.get::<&str, _>("input_json") == raw
            && authorized.get::<Option<&str>, _>("provider_attempt_id") == attempt
            && authorized.get::<Option<&str>, _>("native_call_id") == native_call,
        "Native event provenance differs",
    )?;
    let existing = sqlx::query("SELECT ticket_json,decision_json FROM engine_flow030_work_events WHERE system_id=? AND invocation_id=? AND event_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&input.event_id).fetch_optional(&mut *db).await?;
    if let Some(row) = existing {
        let raw_ticket: &str = row.get("ticket_json");
        let mut ticket: FlowWorkTicket030 = serde_json::from_str(raw_ticket)?;
        require(
            ticket.identity == *id
                && ticket.input == *input
                && ticket.generation == lease.generation()
                && ticket.contract_json == bound.contract_json
                && ticket.options_json == bound.options_json,
            "Conflicting event identity",
        )?;
        if let Some(raw) = row.get::<Option<&str>, _>("decision_json") {
            return Ok(Reservation030::Committed(serde_json::from_str(raw)?));
        }
        let current = sqlx::query("SELECT revision,state_json FROM engine_flow030_work_state WHERE system_id=? AND invocation_id=? AND activation_id=?")
            .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&input.context.work.activation_id)
            .fetch_optional(&mut *db).await?.ok_or_else(|| denied("Pending work state missing"))?;
        require(
            current.get::<&str, _>("revision") == input.expected_revision
                && current.get::<&str, _>("state_json") == ticket.state_json,
            "Pending work revision changed",
        )?;
        if ticket.flow_revision != bound.flow_revision {
            // Only pure evaluation is retried. The new ticket fences any old
            // mailbox reply; no check or provider effect may be replayed.
            ticket.flow_revision = bound.flow_revision;
            ticket.ticket_id = uuid::Uuid::new_v4().to_string();
            let changed = sqlx::query("UPDATE engine_flow030_work_events SET ticket_json=? WHERE system_id=? AND invocation_id=? AND event_id=? AND decision_json IS NULL AND ticket_json=?")
                .bind(json(&ticket)?).bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&input.event_id).bind(raw_ticket)
                .execute(&mut *db).await?.rows_affected();
            require(changed == 1, "Pending ticket changed")?;
        }
        return Ok(Reservation030::Pending(ticket));
    }
    let state = sqlx::query("SELECT revision,state_json FROM engine_flow030_work_state WHERE system_id=? AND invocation_id=? AND activation_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&input.context.work.activation_id).fetch_optional(&mut *db).await?;
    let (revision, state_json): (String, String) = match state {
        Some(row) => (row.get("revision"), row.get("state_json")),
        None => {
            sqlx::query("INSERT INTO engine_flow030_work_state VALUES (?,?,?,'0',?)")
                .bind(&id.system_start_id)
                .bind(&id.flow_invocation_id)
                .bind(&input.context.work.activation_id)
                .bind(EMPTY_JOURNAL)
                .execute(&mut *db)
                .await?;
            ("0".into(), EMPTY_JOURNAL.into())
        }
    };
    require(revision == input.expected_revision, "Work revision changed")?;
    let ticket = FlowWorkTicket030 {
        identity: id.clone(),
        input: input.clone(),
        ticket_id: uuid::Uuid::new_v4().to_string(),
        generation: lease.generation().into(),
        flow_revision: bound.flow_revision,
        state_json,
        contract_json: bound.contract_json,
        options_json: bound.options_json,
    };
    sqlx::query("INSERT INTO engine_flow030_work_events VALUES (?,?,?,?,?,NULL)")
        .bind(&id.system_start_id)
        .bind(&id.flow_invocation_id)
        .bind(&input.event_id)
        .bind(&input.context.work.activation_id)
        .bind(json(&ticket)?)
        .execute(&mut *db)
        .await?;
    Ok(Reservation030::Pending(ticket))
}

async fn commit_tx(
    db: &mut SqliteConnection,
    lease: &HostStartLease,
    ticket: &FlowWorkTicket030,
    decision: &ProtocolDecision030,
) -> Result<()> {
    validate_json(&decision.state_json)?;
    validate_json(&decision.receipt_json)?;
    let id = &ticket.identity;
    let bound = binding(
        db,
        lease,
        id,
        &ticket.input.context.work.activation_id,
        ticket.input.control,
    )
    .await?;
    require(
        bound.context == ticket.input.context
            && bound.flow_revision == ticket.flow_revision
            && bound.contract_json == ticket.contract_json
            && bound.options_json == ticket.options_json
            && ticket.generation == lease.generation(),
        "Flow admission or revision changed",
    )?;
    let row = sqlx::query("SELECT ticket_json,decision_json FROM engine_flow030_work_events WHERE system_id=? AND invocation_id=? AND event_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&ticket.input.event_id).fetch_optional(&mut *db).await?
        .ok_or_else(|| denied("Work ticket missing"))?;
    require(
        serde_json::from_str::<FlowWorkTicket030>(row.get("ticket_json"))? == *ticket,
        "Work ticket differs",
    )?;
    if let Some(raw) = row.get::<Option<&str>, _>("decision_json") {
        require(
            serde_json::from_str::<ProtocolDecision030>(raw)? == *decision,
            "Work decision differs",
        )?;
        return Ok(());
    }
    // Only native parsing of the authenticated mailbox receipt may reserve a check.
    let check: Option<CheckRequest030> =
        crate::agsdl_host_work::reserved_check030(&ticket.input.context, &decision.receipt_json)?;
    require(
        check == decision.check,
        "Check reservation differs from receipt",
    )?;
    if let Some(check) = check {
        require(
            !ticket.input.control,
            "Control event cannot reserve a check",
        )?;
        opaque(&check.check_id)?;
        validate_json(&check.invocation_json)?;
        sqlx::query("INSERT INTO engine_flow030_work_checks VALUES (?,?,?,?,?,?,'reserved')")
            .bind(&id.system_start_id)
            .bind(&id.flow_invocation_id)
            .bind(&check.check_id)
            .bind(&ticket.input.context.work.activation_id)
            .bind(&ticket.input.event_id)
            .bind(&check.invocation_json)
            .execute(&mut *db)
            .await?;
    }
    let changed = sqlx::query("UPDATE engine_flow030_work_state SET revision=?,state_json=? WHERE system_id=? AND invocation_id=? AND activation_id=? AND revision=? AND state_json=?")
        .bind(super::next(&ticket.input.expected_revision)).bind(&decision.state_json)
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&ticket.input.context.work.activation_id)
        .bind(&ticket.input.expected_revision).bind(&ticket.state_json).execute(&mut *db).await?.rows_affected();
    require(changed == 1, "Work CAS failed")?;
    sqlx::query("UPDATE engine_flow030_work_events SET decision_json=? WHERE system_id=? AND invocation_id=? AND event_id=? AND decision_json IS NULL")
        .bind(json(decision)?).bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&ticket.input.event_id).execute(&mut *db).await?;
    Ok(())
}

/// The only entry point returning a decision. It owns the lifecycle/gate at
/// both durable boundaries and invokes the concrete authenticated mailbox in
/// between, with no SQL transaction held while awaiting it. 09 must implement
/// `evaluate_flow_work030` as described above; no public commit function exists.
pub(crate) async fn transition(
    host: &HostState,
    pool: &SqlitePool,
    id: &FlowIdentity030,
    input: &ProtocolEvent030,
    cancelled: &CancellationToken,
) -> Result<ProtocolDecision030> {
    let lease = host.start_lease().await?;
    let gate = host.admission_lock().lock_owned().await;
    host.flow030().available(id)?;
    let mut db = pool.acquire().await?;
    sqlx::query("PRAGMA synchronous=FULL")
        .execute(&mut *db)
        .await?;
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    let reservation = reserve_tx(&mut tx, &lease, id, input).await?;
    lease.ensure_live()?;
    tx.commit().await.map_err(|_| uncertain())?;
    lease.ensure_live().map_err(|_| uncertain())?;
    let ticket = match reservation {
        Reservation030::Committed(value) => return Ok(value),
        Reservation030::Pending(ticket) => ticket,
    };
    drop(db);
    drop(gate);
    drop(lease);
    let output = host
        .evaluate_flow_work030(
            HostWorkInput030 {
                context: ticket.input.context.clone(),
                event_id: ticket.input.event_id.clone(),
                expected_revision: ticket.input.expected_revision.clone(),
                contract_json: ticket.contract_json.clone(),
                state_json: ticket.state_json.clone(),
                event_json: ticket.input.event_json.clone(),
                options_json: ticket.options_json.clone(),
            },
            &ticket.generation,
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
        crate::agsdl_host_work::reserved_check030(&ticket.input.context, &output.receipt_json)?;
    let decision = ProtocolDecision030 {
        state_json: output.state_json,
        receipt_json: output.receipt_json,
        check,
    };
    let lease = host.start_lease().await?;
    let _gate = host.admission_lock().lock_owned().await;
    host.flow030().available(id)?;
    if cancelled.is_cancelled() {
        return Err(failure(
            "INTERRUPTED",
            "work",
            "Work transition was cancelled",
        ));
    }
    let mut db = pool.acquire().await?;
    sqlx::query("PRAGMA synchronous=FULL")
        .execute(&mut *db)
        .await?;
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    commit_tx(&mut tx, &lease, &ticket, &decision).await?;
    lease.ensure_live()?;
    tx.commit().await.map_err(|_| uncertain())?;
    lease.ensure_live().map_err(|_| uncertain())?;
    Ok(decision)
}

#[cfg(test)]
#[path = "flow_work_protocol030_tests.rs"]
mod tests;
