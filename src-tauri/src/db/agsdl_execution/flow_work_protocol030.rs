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
    agent: String,
    start_effect_id: String,
}

/// Consume the controller's reservation once, under the native launch gate.
/// `uncertain` is retained if the host dies before the real result is committed.
pub(crate) async fn claim_check030(
    db: &mut SqliteConnection,
    lease: &HostStartLease,
    attempt: &crate::agsdl_host_flow030::FlowWorkAttempt030,
    check: &CheckRequest030,
    policies: &crate::agsdl_host_work_admission030::PolicyLeases030,
) -> Result<(EngineContext, crate::agsdl_permissions::EffectivePolicy)> {
    let id = attempt.identity();
    let bound = binding(db, lease, id, &attempt.work().activation_id, false).await?;
    require(
        attempt.owner() == &bound.context.owner
            && attempt.work() == &bound.context.work
            && attempt.generation() == lease.generation()
            && attempt.start_effect_id() == bound.start_effect_id
            && attempt.agent() == bound.agent,
        "Check work differs",
    )?;
    let row = sqlx::query("SELECT request_json,event_id FROM engine_flow030_work_checks WHERE system_id=? AND invocation_id=? AND activation_id=? AND check_id=? AND status='reserved'")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&attempt.work().activation_id)
        .bind(&check.check_id).fetch_optional(&mut *db).await?.ok_or_else(|| denied("Check is not reserved"))?;
    require(
        row.get::<&str, _>("request_json") == check.invocation_json,
        "Check request differs",
    )?;
    let decision: String = sqlx::query_scalar("SELECT decision_json FROM engine_flow030_work_events WHERE system_id=? AND invocation_id=? AND event_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(row.get::<&str,_>("event_id"))
        .fetch_one(&mut *db).await?;
    let decision: ProtocolDecision030 = serde_json::from_str(&decision)?;
    let current: String = sqlx::query_scalar("SELECT state_json FROM engine_flow030_work_state WHERE system_id=? AND invocation_id=? AND activation_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&attempt.work().activation_id).fetch_one(&mut *db).await?;
    require(
        decision.state_json == current && decision.check.as_ref() == Some(check),
        "Check revision differs",
    )?;
    let request: serde_json::Value = serde_json::from_str(&check.invocation_json)?;
    let contract: serde_json::Value = serde_json::from_str(&bound.contract_json)?;
    let options: serde_json::Value = serde_json::from_str(&bound.options_json)?;
    require(
        request["command"] == contract["completionCheck"]["command"]
            && request["timeoutMs"] == options["checkTimeoutMs"]
            && request["maxOutputBytes"] == options["maxCheckOutputBytes"],
        "Check command or limits differ",
    )?;
    let evidence: String = sqlx::query_scalar("SELECT policy_evidence_json FROM engine_flow030_work_admissions WHERE system_id=? AND invocation_id=? AND activation_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&attempt.work().activation_id).fetch_one(&mut *db).await?;
    let evidence: serde_json::Value = serde_json::from_str(&evidence)?;
    require(
        evidence["hostCeilingDigest"] == policies.ceiling_fingerprint(),
        "Check ceiling changed",
    )?;
    let policy = crate::agsdl_permissions::EffectivePolicy::restore_capture(
        &evidence["effectivePolicy"].to_string(),
        evidence["policyDigest"]
            .as_str()
            .ok_or_else(|| denied("Check policy missing"))?,
    )
    .map_err(|_| denied("Check policy differs"))?;
    let changed = sqlx::query("UPDATE engine_flow030_work_checks SET status='uncertain' WHERE system_id=? AND invocation_id=? AND check_id=? AND status='reserved'")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&check.check_id).execute(&mut *db).await?.rows_affected();
    require(changed == 1, "Check was already consumed")?;
    Ok((bound.context, policy))
}

/// A terminal work decision correlated to one native agent attempt. This
/// capability is internal to the host and cannot be reconstructed from IPC.
/// Its constructor is intentionally kept in this module, next to the 04
/// decision validation and durable work transaction.
pub(crate) struct AcceptedWorkTerminal030 {
    attempt: crate::agsdl_host_flow030::FlowWorkAttempt030,
    work: super::flow030::WorkRef030,
    protocol_event_id: String,
    result: super::flow030::WorkResult030,
}

impl AcceptedWorkTerminal030 {
    pub(crate) fn identity(&self) -> &FlowIdentity030 {
        self.attempt.identity()
    }

    pub(crate) fn work(&self) -> &super::flow030::WorkRef030 {
        &self.work
    }

    pub(crate) fn protocol_event_id(&self) -> &str {
        &self.protocol_event_id
    }

    pub(crate) fn result(&self) -> &super::flow030::WorkResult030 {
        &self.result
    }

    pub(crate) fn attempt(&self) -> &crate::agsdl_host_flow030::FlowWorkAttempt030 {
        &self.attempt
    }
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
        flow_revision: flow.revision.clone(),
        contract_json: contract,
        options_json: options,
        agent: agent.into(),
        start_effect_id: start_id.clone(),
    })
}

/// Revalidate a native capability against the immutable SQL handoff and the
/// captured work admission in the caller's transaction. Decoded receipt JSON
/// never creates a capability and this check does not grant tool permissions.
pub(crate) async fn verify_agent_attempt_tx(
    db: &mut SqliteConnection,
    lease: &HostStartLease,
    id: &FlowIdentity030,
    attempt: &crate::agsdl_host_flow030::FlowWorkAttempt030,
    input: &ProtocolEvent030,
) -> Result<()> {
    let bound = binding(
        db,
        lease,
        id,
        &input.context.work.activation_id,
        input.control,
    )
    .await?;
    require(
        attempt.identity() == id
            && attempt.owner() == &bound.context.owner
            && attempt.generation() == lease.generation()
            && attempt.work() == &bound.context.work
            && attempt.start_effect_id() == bound.start_effect_id
            && attempt.agent() == bound.agent
            && input.context == bound.context
            && if input.control {
                input.native_call.is_none()
            } else {
                input
                    .native_call
                    .as_ref()
                    .is_some_and(|call| call.provider_attempt_id == attempt.provider_attempt_id())
            },
        "Native agent attempt differs from the admitted work",
    )?;
    let raw: String = sqlx::query_scalar("SELECT receipt_json FROM engine_flow030_handoffs WHERE system_id=? AND invocation_id=? AND effect_id=? AND owner_epoch=? AND generation=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(attempt.start_effect_id())
        .bind(&bound.context.owner.owner_epoch).bind(lease.generation())
        .fetch_optional(&mut *db).await?.ok_or_else(|| denied("Native handoff receipt missing"))?;
    validate_json(&raw)?;
    let receipt: serde_json::Value = serde_json::from_str(&raw)?;
    require(
        receipt.get("kind").and_then(serde_json::Value::as_str) == Some("nativeOwnedHandoff030")
            && receipt.get("identity") == Some(&serde_json::to_value(id)?)
            && receipt.get("effectId").and_then(serde_json::Value::as_str)
                == Some(attempt.start_effect_id())
            && receipt
                .get("ownerEpoch")
                .and_then(serde_json::Value::as_str)
                == Some(bound.context.owner.owner_epoch.as_str())
            && receipt
                .get("generation")
                .and_then(serde_json::Value::as_str)
                == Some(lease.generation())
            && receipt
                .get("requestId")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| !value.is_empty())
            && receipt.get("workAttempt") == Some(&serde_json::to_value(attempt)?),
        "Native agent handoff receipt differs",
    )?;
    lease.ensure_live()?;
    Ok(())
}

/// Authorize only the physical-end event produced by the native join
/// supervisor. Provider events require their own owned-operation evidence.
async fn authorize_joined_event_tx(
    db: &mut SqliteConnection,
    lease: &HostStartLease,
    attempt: &crate::agsdl_host_flow030::FlowWorkAttempt030,
    joined: &crate::agsdl_host_dispatch030::JoinedOwnedAgent030,
    input: &ProtocolEvent030,
) -> Result<()> {
    require(
        serde_json::to_value(joined.attempt())? == serde_json::to_value(attempt)?,
        "Physical join belongs to another attempt",
    )?;
    verify_agent_attempt_tx(db, lease, attempt.identity(), attempt, input).await?;
    require(
        input.control && input.native_call.is_none(),
        "Physical event has a provider call",
    )?;
    let raw = json(input)?;
    let existing = sqlx::query("SELECT activation_id,input_json,provider_attempt_id,native_call_id FROM engine_flow030_work_authorizations WHERE system_id=? AND invocation_id=? AND event_id=?")
        .bind(&attempt.identity().system_start_id).bind(&attempt.identity().flow_invocation_id)
        .bind(&input.event_id).fetch_optional(&mut *db).await?;
    if let Some(row) = existing {
        require(
            row.get::<&str, _>("activation_id") == attempt.work().activation_id
                && row.get::<&str, _>("input_json") == raw
                && row.get::<Option<&str>, _>("provider_attempt_id").is_none()
                && row.get::<Option<&str>, _>("native_call_id").is_none(),
            "Physical event authorization differs",
        )?;
        return Ok(());
    }
    opaque(&input.event_id)?;
    lease.ensure_live()?;
    sqlx::query("INSERT INTO engine_flow030_work_authorizations(system_id,invocation_id,event_id,activation_id,input_json,provider_attempt_id,native_call_id) VALUES(?,?,?,?,?,NULL,NULL)")
        .bind(&attempt.identity().system_start_id).bind(&attempt.identity().flow_invocation_id)
        .bind(&input.event_id).bind(&attempt.work().activation_id).bind(raw)
        .execute(&mut *db).await?;
    Ok(())
}

/// The permit can only be consumed inside the already-owned native parent.
/// The bytes authorized here are exactly those attached to that parent.
async fn authorize_owned_event_tx(
    db: &mut SqliteConnection,
    lease: &HostStartLease,
    attempt: &crate::agsdl_host_flow030::FlowWorkAttempt030,
    input: &ProtocolEvent030,
    operation: &crate::ai::stream_tasks::OwnedOperation030,
    policies: &crate::agsdl_host_work_admission030::PolicyLeases030,
) -> Result<()> {
    verify_agent_attempt_tx(db, lease, attempt.identity(), attempt, input).await?;
    let call = input
        .native_call
        .as_ref()
        .ok_or_else(|| denied("Native operation attribution is absent"))?;
    require(
        !input.control
            && operation.identity == *attempt.identity()
            && operation.context == input.context
            && operation.generation == attempt.generation()
            && operation.agent == attempt.agent()
            && operation.provider_attempt_id == attempt.provider_attempt_id()
            && operation.operation_id == call.native_call_id
            && operation.request_json == input.event_json,
        "Owned operation differs from the work event",
    )?;
    let row = sqlx::query(
        "SELECT capture_json FROM engine_start030_requests WHERE system_id=? AND invocation_id=?",
    )
    .bind(&attempt.identity().system_start_id)
    .bind(&attempt.identity().flow_invocation_id)
    .fetch_optional(&mut *db)
    .await?
    .ok_or_else(|| denied("Work capture is absent"))?;
    let capture: super::start030::StartCapture030 = serde_json::from_str(row.get("capture_json"))?;
    require(
        capture.source.owner.project_id == policies.project_id(),
        "Policy project differs",
    )?;
    let evidence: String = sqlx::query_scalar("SELECT policy_evidence_json FROM engine_flow030_work_admissions WHERE system_id=? AND invocation_id=? AND activation_id=?")
        .bind(&attempt.identity().system_start_id).bind(&attempt.identity().flow_invocation_id)
        .bind(&attempt.work().activation_id).fetch_one(&mut *db).await?;
    let evidence: serde_json::Value = serde_json::from_str(&evidence)?;
    require(
        evidence
            .get("hostCeilingDigest")
            .and_then(serde_json::Value::as_str)
            == Some(policies.ceiling_fingerprint()),
        "Approved host policy changed",
    )?;
    let raw = json(input)?;
    let existing = sqlx::query("SELECT activation_id,input_json,provider_attempt_id,native_call_id FROM engine_flow030_work_authorizations WHERE system_id=? AND invocation_id=? AND event_id=?")
        .bind(&attempt.identity().system_start_id).bind(&attempt.identity().flow_invocation_id).bind(&input.event_id)
        .fetch_optional(&mut *db).await?;
    if let Some(row) = existing {
        require(
            row.get::<&str, _>("activation_id") == attempt.work().activation_id
                && row.get::<&str, _>("input_json") == raw
                && row.get::<Option<&str>, _>("provider_attempt_id")
                    == Some(call.provider_attempt_id.as_str())
                && row.get::<Option<&str>, _>("native_call_id")
                    == Some(call.native_call_id.as_str()),
            "Owned event authorization differs",
        )?;
        return Ok(());
    }
    opaque(&input.event_id)?;
    opaque(&call.native_call_id)?;
    lease.ensure_live()?;
    sqlx::query("INSERT INTO engine_flow030_work_authorizations(system_id,invocation_id,event_id,activation_id,input_json,provider_attempt_id,native_call_id) VALUES(?,?,?,?,?,?,?)")
        .bind(&attempt.identity().system_start_id).bind(&attempt.identity().flow_invocation_id)
        .bind(&input.event_id).bind(&attempt.work().activation_id).bind(raw)
        .bind(&call.provider_attempt_id).bind(&call.native_call_id).execute(&mut *db).await?;
    Ok(())
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
    let event: serde_json::Value = serde_json::from_str(&ticket.input.event_json)?;
    if event["event"]["kind"] == "checkEnded" && event["event"]["physicalState"] == "ended" {
        let changed = sqlx::query("UPDATE engine_flow030_work_checks SET status='ended' WHERE system_id=? AND invocation_id=? AND activation_id=? AND check_id=? AND status='uncertain'")
            .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&ticket.input.context.work.activation_id)
            .bind(event["event"]["checkId"].as_str().ok_or_else(|| denied("Missing check id"))?)
            .execute(&mut *db).await?.rows_affected();
        require(changed == 1, "Check has no owned execution")?;
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
    if input.native_call.is_some() {
        return Err(denied("Native provider event requires its owned attempt"));
    }
    transition_inner(host, pool, id, None, None, None, input, cancelled).await
}

/// Provider events must carry the opaque capability minted at native Start.
/// The capability and its immutable handoff are rechecked in both transactions.
#[cfg(test)]
pub(crate) async fn transition_agent(
    host: &HostState,
    pool: &SqlitePool,
    attempt: &crate::agsdl_host_flow030::FlowWorkAttempt030,
    input: &ProtocolEvent030,
    cancelled: &CancellationToken,
) -> Result<ProtocolDecision030> {
    transition_inner(
        host,
        pool,
        attempt.identity(),
        Some(attempt),
        None,
        None,
        input,
        cancelled,
    )
    .await
}

/// Consume an exact operation attached to this native parent before reserving
/// the corresponding controller event. Policy leases are released before the
/// controller mailbox is awaited.
pub(crate) async fn transition_owned_agent030(
    host: &HostState,
    pool: &SqlitePool,
    attempt: &crate::agsdl_host_flow030::FlowWorkAttempt030,
    input: &ProtocolEvent030,
    permit: crate::ai::stream_tasks::OwnedOperationPermit030,
    policies: crate::agsdl_host_work_admission030::PolicyLeases030,
    cancelled: &CancellationToken,
) -> Result<ProtocolDecision030> {
    let operation = permit
        .into_operation()
        .map_err(|_| denied("Owned operation is unavailable"))?;
    transition_inner(
        host,
        pool,
        attempt.identity(),
        Some(attempt),
        None,
        Some((operation, policies)),
        input,
        cancelled,
    )
    .await
}

/// Only the supervisor holding the actual join witness may submit the final
/// physical event. This is not an IPC entry point and cannot mint a witness.
pub(crate) async fn finish_joined_agent030(
    host: &HostState,
    pool: &SqlitePool,
    joined: &crate::agsdl_host_dispatch030::JoinedOwnedAgent030,
    cancelled: &CancellationToken,
) -> Result<ProtocolDecision030> {
    let attempt = joined.attempt();
    let lease = host.start_lease().await?;
    let gate = host.admission_lock().lock_owned().await;
    host.flow030().available(attempt.identity())?;
    let mut db = pool.acquire().await?;
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    let bound = binding(
        &mut tx,
        &lease,
        attempt.identity(),
        &attempt.work().activation_id,
        true,
    )
    .await?;
    let revision: String = sqlx::query_scalar("SELECT revision FROM engine_flow030_work_state WHERE system_id=? AND invocation_id=? AND activation_id=?")
        .bind(&attempt.identity().system_start_id).bind(&attempt.identity().flow_invocation_id)
        .bind(&attempt.work().activation_id).fetch_one(&mut *tx).await?;
    let event_id = format!("physical:{}", attempt.provider_attempt_id());
    let event_json = serde_json::json!({"eventId":event_id,"owner":{
        "systemStartId":attempt.work().system_start_id,"activationId":attempt.work().activation_id,
        "agentInstanceId":attempt.work().agent_instance_id,"ownerEpoch":attempt.owner().owner_epoch},
        "event":{"kind":"physicalEnded","providerEnded":true,"effectsEnded":true}}).to_string();
    let input = ProtocolEvent030 {
        context: bound.context,
        event_id,
        expected_revision: revision,
        event_json,
        native_call: None,
        control: true,
    };
    tx.commit().await?;
    drop(db);
    drop(gate);
    drop(lease);
    transition_inner(
        host,
        pool,
        attempt.identity(),
        Some(attempt),
        Some(joined),
        None,
        &input,
        cancelled,
    )
    .await
}

fn accepted_terminal030(
    attempt: &crate::agsdl_host_flow030::FlowWorkAttempt030,
    joined: &crate::agsdl_host_dispatch030::JoinedOwnedAgent030,
    ticket: &FlowWorkTicket030,
    decision: &ProtocolDecision030,
) -> Result<Option<AcceptedWorkTerminal030>> {
    require(
        serde_json::to_value(joined.attempt())? == serde_json::to_value(attempt)?
            && ticket.identity == *attempt.identity()
            && ticket.input.context.work == *attempt.work(),
        "Joined work attribution differs",
    )?;
    crate::agsdl_host_work::reserved_check030(&ticket.input.context, &decision.receipt_json)?;
    let receipt: serde_json::Value = serde_json::from_str(&decision.receipt_json)?;
    let verdict = receipt
        .get("decision")
        .ok_or_else(|| denied("Work decision is absent"))?;
    if verdict.get("kind").and_then(serde_json::Value::as_str) != Some("finished") {
        return Ok(None);
    }
    let result = match verdict.get("outcome").and_then(serde_json::Value::as_str) {
        Some("success") => {
            let output = verdict
                .get("output")
                .ok_or_else(|| denied("Work output is absent"))?;
            let output_json = crate::agsdl_host_route_verifier030::accepted_output_json(output)
                .map_err(|_| denied("Work output is invalid"))?;
            let route_key = match output.get("choice") {
                None | Some(serde_json::Value::Null) => None,
                Some(serde_json::Value::String(choice)) => Some(choice.clone()),
                _ => return Err(denied("Work choice is invalid")),
            };
            super::flow030::WorkResult030::Completed {
                output_json,
                route_key,
            }
        }
        Some("failure") => {
            let code = verdict
                .get("code")
                .and_then(serde_json::Value::as_str)
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
                .ok_or_else(|| denied("Work failure code is invalid"))?;
            super::flow030::WorkResult030::Failed {
                error: super::flow030::Failure030::new(code),
            }
        }
        _ => return Err(denied("Work outcome is not supported")),
    };
    Ok(Some(AcceptedWorkTerminal030 {
        attempt: attempt.clone(),
        work: super::flow030::WorkRef030 {
            activation_id: attempt.work().activation_id.clone(),
            start_effect_id: attempt.start_effect_id().to_owned(),
            agent_instance_id: attempt.work().agent_instance_id.clone(),
        },
        protocol_event_id: ticket.input.event_id.clone(),
        result,
    }))
}

async fn transition_inner(
    host: &HostState,
    pool: &SqlitePool,
    id: &FlowIdentity030,
    attempt: Option<&crate::agsdl_host_flow030::FlowWorkAttempt030>,
    joined: Option<&crate::agsdl_host_dispatch030::JoinedOwnedAgent030>,
    owned: Option<(
        crate::ai::stream_tasks::OwnedOperation030,
        crate::agsdl_host_work_admission030::PolicyLeases030,
    )>,
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
    if let Some(attempt) = attempt {
        verify_agent_attempt_tx(&mut tx, &lease, id, attempt, input).await?;
        if let Some(joined) = joined {
            authorize_joined_event_tx(&mut tx, &lease, attempt, joined, input).await?;
        }
        if let Some((operation, policies)) = &owned {
            authorize_owned_event_tx(&mut tx, &lease, attempt, input, operation, policies).await?;
        }
    }
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
    drop(owned);
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
    if let Some(attempt) = attempt {
        verify_agent_attempt_tx(&mut tx, &lease, id, attempt, input).await?;
    }
    commit_tx(&mut tx, &lease, &ticket, &decision).await?;
    let receipt: serde_json::Value = serde_json::from_str(&decision.receipt_json)?;
    if receipt
        .pointer("/decision/kind")
        .and_then(serde_json::Value::as_str)
        == Some("finished")
    {
        let terminal = accepted_terminal030(
            attempt.ok_or_else(|| denied("Terminal decision has no native attempt"))?,
            joined.ok_or_else(|| denied("Terminal decision has no physical join"))?,
            &ticket,
            &decision,
        )?
        .ok_or_else(|| denied("Terminal decision differs"))?;
        crate::agsdl_host_flow030::apply_work_terminal_tx(
            host.flow030(),
            &mut tx,
            &lease,
            &terminal,
            joined.ok_or_else(|| denied("Terminal decision has no physical join"))?,
        )
        .await?;
    }
    lease.ensure_live()?;
    // Hash the exact bytes actually stored, not a reconstructed ticket or
    // decision. The shared admission gate prevents other run mutations until
    // the commit is acknowledged or an exact readback reconciles it.
    let row = sqlx::query("SELECT ticket_json,decision_json FROM engine_flow030_work_events WHERE system_id=? AND invocation_id=? AND event_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&ticket.input.event_id)
        .fetch_one(&mut *tx).await?;
    let ticket_raw: &str = row.get("ticket_json");
    let decision_raw: &str = row
        .get::<Option<&str>, _>("decision_json")
        .ok_or_else(|| denied("Committed work decision missing"))?;
    let marker =
        host.flow030()
            .begin_work_commit(id, &ticket.input.event_id, ticket_raw, decision_raw)?;
    tx.commit().await.map_err(|_| uncertain())?;
    #[cfg(test)]
    host.flow030().pause_after_work_commit(&marker).await;
    lease
        .acknowledge_work_commit(host.flow030(), &marker)
        .map_err(|_| uncertain())?;
    Ok(decision)
}

/// Reconcile an unknown decision commit from a single SQL snapshot. This does
/// not replay the controller, claim a check, or grant authority to dispatch.
pub(crate) async fn inspect_work_commit(
    host: &HostState,
    pool: &SqlitePool,
    id: &FlowIdentity030,
    event_id: &str,
) -> Result<Option<()>> {
    let lease = host.start_lease().await?;
    let _gate = host.admission_lock().lock_owned().await;
    let Some(marker) = host.flow030().pending_work_commit(id, event_id)? else {
        return Ok(None);
    };
    let mut tx = pool.begin().await?;
    let owner = lease.owner(&id.system_start_id)?;
    let owner_row = sqlx::query("SELECT snapshot_id,capture_epoch,owner_epoch,generation,status,capture_sha256 FROM engine_flow030_owners WHERE system_id=? AND invocation_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).fetch_optional(&mut *tx).await?
        .ok_or_else(|| denied("Work owner missing"))?;
    let capture_raw: String = sqlx::query_scalar(
        "SELECT capture_json FROM engine_start030_requests WHERE system_id=? AND invocation_id=?",
    )
    .bind(&id.system_start_id)
    .bind(&id.flow_invocation_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| denied("Work capture missing"))?;
    let capture: super::start030::StartCapture030 = serde_json::from_str(&capture_raw)?;
    require(
        capture.identity == *id
            && owner_row.get::<&str, _>("snapshot_id") == id.snapshot_id
            && owner_row.get::<&str, _>("capture_epoch") == id.epoch
            && owner_row.get::<&str, _>("owner_epoch") == owner.owner_epoch
            && owner_row.get::<&str, _>("generation") == lease.generation()
            && owner_row.get::<&str, _>("status") == "live"
            && owner_row.get::<&str, _>("capture_sha256")
                == format!("{:x}", Sha256::digest(serde_json::to_vec(&capture)?)),
        "Work owner or capture differs",
    )?;
    let row = sqlx::query("SELECT ticket_json,decision_json FROM engine_flow030_work_events WHERE system_id=? AND invocation_id=? AND event_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(event_id)
        .fetch_optional(&mut *tx).await?;
    let Some(row) = row else { return Ok(None) };
    let ticket_raw: &str = row.get("ticket_json");
    let Some(decision_raw) = row.get::<Option<&str>, _>("decision_json") else {
        return Ok(None);
    };
    require(
        format!("{:x}", Sha256::digest(ticket_raw.as_bytes())) == marker.ticket_sha256()
            && format!("{:x}", Sha256::digest(decision_raw.as_bytes())) == marker.decision_sha256(),
        "Work marker differs",
    )?;
    let ticket: FlowWorkTicket030 = serde_json::from_str(ticket_raw)?;
    let decision: ProtocolDecision030 = serde_json::from_str(decision_raw)?;
    require(
        ticket.identity == *marker.identity()
            && ticket.input.event_id == marker.event_id()
            && ticket.generation == lease.generation()
            && owner == ticket.input.context.owner,
        "Work attribution differs",
    )?;
    let expected =
        crate::agsdl_host_work::reserved_check030(&ticket.input.context, &decision.receipt_json)?;
    require(
        expected == decision.check,
        "Work check differs from receipt",
    )?;
    let rows = sqlx::query("SELECT check_id,activation_id,request_json,status FROM engine_flow030_work_checks WHERE system_id=? AND invocation_id=? AND event_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(event_id).fetch_all(&mut *tx).await?;
    match expected {
        None => require(rows.is_empty(), "Unexpected work check")?,
        Some(check) => require(
            rows.len() == 1
                && rows[0].get::<&str, _>("check_id") == check.check_id
                && rows[0].get::<&str, _>("activation_id")
                    == ticket.input.context.work.activation_id
                && rows[0].get::<&str, _>("request_json") == check.invocation_json
                && rows[0].get::<&str, _>("status") == "reserved",
            "Work check differs",
        )?,
    }
    tx.commit().await?;
    lease.acknowledge_work_commit(host.flow030(), &marker)?;
    Ok(Some(()))
}

/// Exercise the production 04 validator from a synthetic native test fixture.
#[cfg(test)]
pub(crate) fn test_accepted_terminal030(
    attempt: &crate::agsdl_host_flow030::FlowWorkAttempt030,
    joined: &crate::agsdl_host_dispatch030::JoinedOwnedAgent030,
    ticket: &FlowWorkTicket030,
    decision: &ProtocolDecision030,
) -> Result<Option<AcceptedWorkTerminal030>> {
    accepted_terminal030(attempt, joined, ticket, decision)
}

#[cfg(test)]
#[path = "flow_work_protocol030_tests.rs"]
mod tests;
