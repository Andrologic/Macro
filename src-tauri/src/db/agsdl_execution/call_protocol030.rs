//! Durable call protocol. All *_tx operations require the native admission
//! exclusion and an existing BEGIN IMMEDIATE transaction. No physical IO here.
use super::{
    dto::EngineFailure,
    failure,
    flow030::{
        FlowEffect030, FlowEffectKind030, FlowEvent030, FlowEventKind030, FlowIdentity030,
        FlowPlan030, FlowState030, PhysicalEvidence030, WorkRef030, WorkResult030,
    },
    flow_store030::{self, Apply030, StoreError030},
    start030::StartCapture030,
    validate_json, Result,
};
use crate::agsdl_host_calls030::{CallAuthority030, CallEvent030, JoinedCall030, PreparedCall030};
use serde::{Deserialize, Serialize};
use serde_json::{value::RawValue, Value};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};
use std::collections::BTreeMap;

type Object = BTreeMap<String, Box<RawValue>>;
pub(crate) fn denied(detail: &str) -> EngineFailure {
    failure("CORRELATION", "call", detail)
}
pub(crate) fn uncertain() -> EngineFailure {
    failure(
        "COMMIT_UNCERTAIN",
        "call",
        "Inspect the exact native call receipt; never replay its launch",
    )
}
pub(crate) fn require(ok: bool, detail: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(denied(detail))
    }
}
fn store_error(error: StoreError030) -> EngineFailure {
    match error {
        StoreError030::Sql(_) => failure("STORAGE", "call", "Call transaction failed"),
        StoreError030::Authority => failure(
            "AUTHORITY",
            "call",
            "Call owner is not current or qualified",
        ),
        _ => denied("Call flow transition refused"),
    }
}
fn sha(raw: &[u8]) -> String {
    format!("{:x}", Sha256::digest(raw))
}

/// Constructed only from native admission or verified SQL readback. The exact
/// Start includes activation/visit, delivery occurrence, producer and input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CallAttempt030 {
    identity: FlowIdentity030,
    owner_epoch: String,
    generation: String,
    call_id: String,
    capture_sha256: String,
    effect: FlowEffect030,
    declaration_json: String,
}
// Remote deserialization stays private to the SQL reader. Neither capability
// implements Deserialize, so other modules cannot accept one from a callback.
#[derive(Deserialize)]
#[serde(
    remote = "CallAttempt030",
    rename_all = "camelCase",
    deny_unknown_fields
)]
struct StoredAttempt030 {
    identity: FlowIdentity030,
    owner_epoch: String,
    generation: String,
    call_id: String,
    capture_sha256: String,
    effect: FlowEffect030,
    declaration_json: String,
}
#[derive(Deserialize)]
#[serde(transparent)]
struct AttemptRecord030(#[serde(with = "StoredAttempt030")] CallAttempt030);
fn decode_attempt(raw: &str) -> Result<CallAttempt030> {
    let attempt = serde_json::from_str::<AttemptRecord030>(raw)?.0;
    require(
        attempt.identity == attempt.effect.identity
            && !attempt.call_id.is_empty()
            && matches!(&attempt.effect.kind, FlowEffectKind030::Start { work,step:Some(_),agent:None,.. }
            if work.agent_instance_id.is_none() && work.start_effect_id == attempt.effect.id),
        "Stored call attempt has an invalid native identity",
    )?;
    Ok(attempt)
}

impl CallAttempt030 {
    pub(crate) fn identity(&self) -> &FlowIdentity030 {
        &self.identity
    }
    pub(crate) fn owner_epoch(&self) -> &str {
        &self.owner_epoch
    }
    pub(crate) fn generation(&self) -> &str {
        &self.generation
    }
    pub(crate) fn call_id(&self) -> &str {
        &self.call_id
    }
    pub(crate) fn effect(&self) -> &FlowEffect030 {
        &self.effect
    }
    pub(crate) fn work(&self) -> &WorkRef030 {
        match &self.effect.kind {
            FlowEffectKind030::Start { work, .. } => work,
            _ => unreachable!(),
        }
    }
    pub(crate) fn address(&self) -> &[String] {
        match &self.effect.kind {
            FlowEffectKind030::Start {
                step: Some(step), ..
            } => step,
            _ => unreachable!(),
        }
    }
    pub(crate) fn declaration_json(&self) -> &str {
        &self.declaration_json
    }
    pub(crate) fn input_json(&self) -> &str {
        match &self.effect.kind {
            FlowEffectKind030::Start { input_json, .. } => input_json,
            _ => unreachable!(),
        }
    }
    pub(crate) fn answer_timeout_ms_json(&self) -> Result<Option<String>> {
        let step: Object = serde_json::from_str(&self.declaration_json)?;
        Ok(step.get("answerTimeoutMs").map(|v| v.get().to_owned()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum CallEnd030 {
    Returned { event: CallEvent030 },
    Stopped,
    TimedOut,
    PreparationFailed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum CallPhysical030 {
    NotStarted {
        receipt_id: String,
    },
    /// Debug-only executor with no external IO or descendants. This is NOT an
    /// attestation about local process trees or remote server cancellation.
    #[cfg(all(feature = "agsdl-engine-qa", debug_assertions))]
    SyntheticJoined {
        receipt_id: String,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReceivedCall030 {
    end: CallEnd030,
    physical: CallPhysical030,
}
#[derive(Deserialize)]
#[serde(
    remote = "ReceivedCall030",
    rename_all = "camelCase",
    deny_unknown_fields
)]
struct StoredReceived030 {
    end: CallEnd030,
    physical: CallPhysical030,
}
#[derive(Deserialize)]
#[serde(transparent)]
struct ReceivedRecord030(#[serde(with = "StoredReceived030")] ReceivedCall030);
fn decode_received(raw: &str) -> Result<ReceivedCall030> {
    Ok(serde_json::from_str::<ReceivedRecord030>(raw)?.0)
}
// Data read from SQL never becomes a join capability. Only the opaque witness
// from OwnedSyntheticCall030::join can authorize receive/finish for launched IO.
fn received_from_join(joined: &JoinedCall030) -> Result<ReceivedCall030> {
    #[cfg(all(feature = "agsdl-engine-qa", debug_assertions))]
    {
        require(
            !joined.receipt_id().is_empty(),
            "Joined call receipt id missing",
        )?;
        Ok(ReceivedCall030 {
            end: joined.end().clone(),
            physical: CallPhysical030::SyntheticJoined {
                receipt_id: joined.receipt_id().into(),
            },
        })
    }
    #[cfg(not(all(feature = "agsdl-engine-qa", debug_assertions)))]
    {
        let _ = joined;
        Err(denied("No qualified joined call transport"))
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum CallResult030 {
    Completed { output_json: String },
    Failed { code: String },
    Stopped,
}
impl CallResult030 {
    pub(crate) fn failure(code: &str) -> Self {
        Self::Failed { code: code.into() }
    }
    fn work_result(&self) -> Result<Option<WorkResult030>> {
        Ok(match self {
            Self::Completed { output_json } => {
                let output: Value = serde_json::from_str(output_json)?;
                let outcome = output["outcome"]
                    .as_str()
                    .ok_or_else(|| denied("Call outcome missing"))?;
                require(
                    matches!(outcome, "passed" | "failed"),
                    "Call outcome invalid",
                )?;
                Some(WorkResult030::Completed {
                    output_json: output_json.clone(),
                    route_key: Some(outcome.into()),
                })
            }
            Self::Failed { code } => {
                require(
                    matches!(
                        code.as_str(),
                        "OUTPUT_INVALID" | "CALL_FAILED" | "TIMEOUT" | "OPERAND"
                    ),
                    "Call failure invalid",
                )?;
                Some(WorkResult030::Failed {
                    error: super::flow030::Failure030::new(code),
                })
            }
            Self::Stopped => None,
        })
    }
}

/// A sealed read authority for route attestations/verifier. Read it through
/// read_receipt_tx, never by deserializing receipt_json in a route writer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CallReceipt030 {
    attempt: CallAttempt030,
    received: ReceivedCall030,
    result: CallResult030,
    event_id: String,
}
#[derive(Deserialize)]
#[serde(
    remote = "CallReceipt030",
    rename_all = "camelCase",
    deny_unknown_fields
)]
struct StoredReceipt030 {
    #[serde(with = "StoredAttempt030")]
    attempt: CallAttempt030,
    #[serde(with = "StoredReceived030")]
    received: ReceivedCall030,
    result: CallResult030,
    event_id: String,
}
#[derive(Deserialize)]
#[serde(transparent)]
struct ReceiptRecord030(#[serde(with = "StoredReceipt030")] CallReceipt030);
fn decode_receipt(raw: &str) -> Result<CallReceipt030> {
    Ok(serde_json::from_str::<ReceiptRecord030>(raw)?.0)
}

impl CallReceipt030 {
    pub(crate) fn attempt(&self) -> &CallAttempt030 {
        &self.attempt
    }
    pub(crate) fn matches_joined(&self, joined: &JoinedCall030) -> Result<bool> {
        Ok(self.attempt == *joined.attempt() && self.received == received_from_join(joined)?)
    }
    pub(crate) fn event_id(&self) -> &str {
        &self.event_id
    }
    pub(crate) fn work_result(&self) -> Result<Option<WorkResult030>> {
        self.result.work_result()
    }
    /// Physical proof can only be exposed from a receipt whose SQL/event link
    /// has been checked, or from an acknowledged native terminal commit.
    pub(crate) fn physical(&self) -> PhysicalEvidence030 {
        let receipt_id = match &self.received.physical {
            CallPhysical030::NotStarted { receipt_id } => receipt_id,
            #[cfg(all(feature = "agsdl-engine-qa", debug_assertions))]
            CallPhysical030::SyntheticJoined { receipt_id } => receipt_id,
        };
        PhysicalEvidence030 {
            native_receipt_id: receipt_id.clone(),
            descendants_joined: true,
        }
    }
    pub(crate) fn status(&self) -> &str {
        match &self.result {
            CallResult030::Stopped => "stopped",
            CallResult030::Failed { .. } => "failed",
            CallResult030::Completed { output_json } => {
                // Already validated by the native normalizer boundary.
                if serde_json::from_str::<Value>(output_json)
                    .ok()
                    .is_some_and(|v| v["outcome"] == "passed")
                {
                    "succeeded"
                } else {
                    "failed"
                }
            }
        }
    }
}

/// Returned only after its native transaction commits. A diagnostic never
/// masquerades as a completed work/physical transition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum CallSettlement030 {
    Terminal { receipt: CallReceipt030 },
    Diagnostic { diagnostic: CallDiagnostic030 },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CallDiagnostic030 {
    candidate: CallReceipt030,
    diagnostic: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredDiagnostic030 {
    #[serde(with = "StoredReceipt030")]
    candidate: CallReceipt030,
    diagnostic: Value,
}
impl CallDiagnostic030 {
    pub(crate) fn attempt(&self) -> &CallAttempt030 {
        self.candidate.attempt()
    }
    pub(crate) fn event_id(&self) -> &str {
        self.candidate.event_id()
    }
    pub(crate) fn value(&self) -> &Value {
        &self.diagnostic
    }
    pub(crate) fn matches_joined(&self, joined: &JoinedCall030) -> Result<bool> {
        self.candidate.matches_joined(joined)
    }
}
/// Timeout attestation is distinct from call admission. Its fields and
/// constructor are private; even native callers cannot choose a Timeout enum.
/// Only a re-read of the authoritative 040 clock decision constructs this proof.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CallStopCause030 {
    clock_receipt_id: String,
    observed_ms: String,
    timeout_json: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CallCauseReceipt030 {
    attempt: CallAttempt030,
    cause_id: String,
    cause: CallStopCause030,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredClockProof030 {
    clock_receipt_id: String,
    observed_ms: String,
    timeout_json: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredCause030 {
    #[serde(with = "StoredAttempt030")]
    attempt: CallAttempt030,
    cause_id: String,
    cause: StoredClockProof030,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClockWorkBinding030 {
    identity: FlowIdentity030,
    owner: super::dto::EngineOwner,
    generation: String,
    reference: WorkRef030,
    kind: String,
    provider_attempt_id: Option<String>,
}
impl CallStopCause030 {
    /// This reads the 040 rows on the writer's transaction, not a supplied
    /// timeout reason, timer token, or an old proof transported by a caller.
    async fn from_clock_tx(db: &mut SqliteConnection, attempt: &CallAttempt030) -> Result<Self> {
        let row=sqlx::query("SELECT c.receipt_id,c.reason,c.observed_ms,w.start_effect_id,w.owner_epoch,w.generation,w.kind,w.work_json,w.admitted_ms,w.timeout_json FROM engine_flow030_clock_controls c JOIN engine_flow030_clock_works w USING(system_id,invocation_id,activation_id) WHERE c.system_id=? AND c.invocation_id=? AND c.activation_id=?")
            .bind(&attempt.identity.system_start_id).bind(&attempt.identity.flow_invocation_id)
            .bind(&attempt.work().activation_id).fetch_optional(&mut *db).await?
            .ok_or_else(|| denied("TIMEOUT has no durable clock decision for this activation"))?;
        require(
            row.get::<&str, _>("reason") == "TIMEOUT"
                && row.get::<&str, _>("start_effect_id") == attempt.work().start_effect_id
                && row.get::<&str, _>("owner_epoch") == attempt.owner_epoch()
                && row.get::<&str, _>("generation") == attempt.generation()
                && row.get::<&str, _>("kind") == "call",
            "Clock decision belongs to another work, visit or generation",
        )?;
        let binding: ClockWorkBinding030 = serde_json::from_str(row.get("work_json"))?;
        require(
            binding.identity == *attempt.identity()
                && binding.owner.system_start_id == attempt.identity.system_start_id
                && binding.owner.owner_epoch == attempt.owner_epoch()
                && binding.generation == attempt.generation()
                && binding.reference == *attempt.work()
                && binding.kind == "call"
                && binding.provider_attempt_id.is_none(),
            "Clock work does not attest this native call",
        )?;
        let timeout = row
            .get::<Option<&str>, _>("timeout_json")
            .ok_or_else(|| denied("Clock work has no machine timeout budget"))?;
        require(
            crate::db::exact_json::positive_integer(timeout).is_some(),
            "Clock timeout budget is not a positive exact integer",
        )?;
        let declaration: Object = serde_json::from_str(attempt.declaration_json())?;
        let declared = declaration
            .get("timeoutMs")
            .ok_or_else(|| denied("Call has no authored timeoutMs"))?;
        require(
            crate::db::exact_json::equal(declared.get(), timeout)?,
            "Clock timeout differs from captured call budget",
        )?;
        let capture: String=sqlx::query_scalar("SELECT capture_json FROM engine_start030_requests WHERE system_id=? AND invocation_id=?")
            .bind(&attempt.identity.system_start_id).bind(&attempt.identity.flow_invocation_id).fetch_one(&mut *db).await?;
        let capture: StartCapture030 = serde_json::from_str(&capture)?;
        let plan: FlowPlan030 = serde_json::from_str(&capture.compiled_plan_json)?;
        let budget = plan
            .steps
            .iter()
            .find(|s| s.address == attempt.address())
            .and_then(|s| s.timeout_ms_json.as_deref())
            .ok_or_else(|| denied("Captured call has no machine timeout budget"))?;
        require(
            crate::db::exact_json::equal(budget, timeout)?,
            "Clock budget differs from native compiled admission",
        )?;
        let receipt_id: &str = row.get("receipt_id");
        let observed: &str = row.get("observed_ms");
        let admitted: &str = row.get("admitted_ms");
        super::decimal(observed)?;
        super::decimal(admitted)?;
        require(
            !receipt_id.is_empty()
                && observed
                    .parse::<u64>()
                    .ok()
                    .zip(admitted.parse::<u64>().ok())
                    .is_some_and(|(o, a)| o >= a),
            "Clock decision receipt or observation is invalid",
        )?;
        Ok(Self {
            clock_receipt_id: receipt_id.into(),
            observed_ms: observed.into(),
            timeout_json: timeout.into(),
        })
    }
}
impl CallCauseReceipt030 {
    pub(crate) fn cause_id(&self) -> &str {
        &self.cause_id
    }
    pub(crate) fn attempt(&self) -> &CallAttempt030 {
        &self.attempt
    }
    pub(crate) fn clock_receipt_id(&self) -> &str {
        &self.cause.clock_receipt_id
    }
}
async fn read_cause_tx(
    db: &mut SqliteConnection,
    attempt: &CallAttempt030,
) -> Result<Option<CallCauseReceipt030>> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT cause_json FROM engine_flow030_call_causes WHERE call_id=?")
            .bind(attempt.call_id())
            .fetch_optional(&mut *db)
            .await?;
    let Some(raw) = raw else { return Ok(None) };
    let stored: StoredCause030 = serde_json::from_str(&raw)?;
    let proof = CallStopCause030::from_clock_tx(db, attempt).await?;
    require(
        stored.attempt == *attempt
            && !stored.cause_id.is_empty()
            && stored.cause.clock_receipt_id == proof.clock_receipt_id
            && stored.cause.observed_ms == proof.observed_ms
            && stored.cause.timeout_json == proof.timeout_json,
        "Call cause no longer matches the attested clock decision",
    )?;
    Ok(Some(CallCauseReceipt030 {
        attempt: stored.attempt,
        cause_id: stored.cause_id,
        cause: proof,
    }))
}
async fn require_admission_tx(db: &mut SqliteConnection, id: &FlowIdentity030) -> Result<()> {
    let blocked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM engine_flow030_events WHERE system_id=? AND invocation_id=? AND diagnostic_json IS NOT NULL)")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).fetch_one(db).await?;
    require(!blocked, "Durable flow diagnostic blocks call admission")
}
/// Existing BEGIN IMMEDIATE + shared native admission exclusion required.
/// The future clock broker may include this write in its own clock decision
/// transaction. No wall-clock/client timestamp or transport boolean is accepted.
pub(crate) async fn record_cause_tx<A: CallAuthority030>(
    db: &mut SqliteConnection,
    authority: &A,
    attempt: &CallAttempt030,
) -> Result<CallCauseReceipt030> {
    verify_attempt_tx(db, authority, attempt, true).await?;
    let row = row_tx(db, attempt).await?;
    require(
        matches!(row.get::<&str, _>("status"), "launched" | "received"),
        "Call cause requires a live launched call",
    )?;
    if let Some(receipt) = read_cause_tx(db, attempt).await? {
        return Ok(receipt);
    }
    let cause = CallStopCause030::from_clock_tx(db, attempt).await?;
    let receipt = CallCauseReceipt030 {
        attempt: attempt.clone(),
        cause_id: uuid::Uuid::new_v4().to_string(),
        cause,
    };
    sqlx::query("INSERT INTO engine_flow030_call_causes(call_id,cause_json) VALUES(?,?)")
        .bind(attempt.call_id())
        .bind(serde_json::to_string(&receipt)?)
        .execute(db)
        .await?;
    Ok(receipt)
}

/// Settlement also checks the source decision itself: a return may win the
/// admission lock between the clock's COMMIT and the supervisor's notification.
/// Never attach a newly arrived cause to an already published terminal.
async fn settlement_cause_tx<A: CallAuthority030>(
    db: &mut SqliteConnection,
    authority: &A,
    attempt: &CallAttempt030,
) -> Result<Option<CallCauseReceipt030>> {
    if let Some(cause) = read_cause_tx(db, attempt).await? {
        return Ok(Some(cause));
    }
    if row_tx(db, attempt).await?.get::<&str, _>("status") == "terminal" {
        return Ok(None);
    }
    let decided: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM engine_flow030_clock_controls WHERE system_id=? AND invocation_id=? AND activation_id=? AND reason='TIMEOUT')")
        .bind(&attempt.identity.system_start_id).bind(&attempt.identity.flow_invocation_id)
        .bind(&attempt.work().activation_id).fetch_one(&mut *db).await?;
    if !decided {
        return Ok(None);
    }
    Ok(Some(record_cause_tx(db, authority, attempt).await?))
}

/// Retained before submitting COMMIT. Its constructor hashes exact SQL bytes
/// after all writes, including the linked reducer event for a terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CallCommitMarker030 {
    attempt: CallAttempt030,
    row_sha256: String,
}
impl CallCommitMarker030 {
    pub(crate) fn identity(&self) -> &FlowIdentity030 {
        self.attempt.identity()
    }
}
pub(crate) async fn commit_marker_tx(
    db: &mut SqliteConnection,
    attempt: &CallAttempt030,
) -> Result<CallCommitMarker030> {
    let row = row_tx(db, attempt).await?;
    let event: Option<(String, Option<String>, Option<String>)> = {
        sqlx::query_as("SELECT event_json,receipt_json,diagnostic_json FROM engine_flow030_events WHERE system_id=? AND invocation_id=? AND event_id=?")
            .bind(&attempt.identity.system_start_id).bind(&attempt.identity.flow_invocation_id).bind(format!("call:{}:terminal",attempt.call_id))
            .fetch_optional(&mut *db).await?
    };
    let cause: Option<String> =
        sqlx::query_scalar("SELECT cause_json FROM engine_flow030_call_causes WHERE call_id=?")
            .bind(attempt.call_id())
            .fetch_optional(&mut *db)
            .await?;
    let diagnostic: Option<String> = sqlx::query_scalar(
        "SELECT record_json FROM engine_flow030_call_diagnostics WHERE call_id=?",
    )
    .bind(attempt.call_id())
    .fetch_optional(&mut *db)
    .await?;
    let exact = serde_json::json!({"attempt":row.get::<&str,_>("attempt_json"),"status":row.get::<&str,_>("status"),
        "prepared":row.get::<Option<&str>,_>("prepared_json"),"received":row.get::<Option<&str>,_>("received_json"),
        "receipt":row.get::<Option<&str>,_>("receipt_json"),"event":event,"cause":cause,"diagnostic":diagnostic}).to_string();
    Ok(CallCommitMarker030 {
        attempt: attempt.clone(),
        row_sha256: sha(exact.as_bytes()),
    })
}
pub(crate) async fn verify_commit_marker_tx<A: CallAuthority030>(
    db: &mut SqliteConnection,
    authority: &A,
    marker: &CallCommitMarker030,
) -> Result<()> {
    verify_attempt_tx(db, authority, &marker.attempt, false).await?;
    require(
        commit_marker_tx(db, &marker.attempt).await? == *marker,
        "Unknown call commit does not match exact readback",
    )
}

async fn capture_tx<A: CallAuthority030>(
    db: &mut SqliteConnection,
    authority: &A,
    identity: &FlowIdentity030,
) -> Result<StartCapture030> {
    authority.owner(db, identity).await.map_err(store_error)?;
    let row = sqlx::query("SELECT capture_epoch,snapshot_id,owner_epoch,generation,status,capture_sha256 FROM engine_flow030_owners WHERE system_id=? AND invocation_id=?")
        .bind(&identity.system_start_id).bind(&identity.flow_invocation_id).fetch_optional(&mut *db).await?
        .ok_or_else(|| denied("Call native owner missing"))?;
    require(
        row.get::<&str, _>("capture_epoch") == identity.epoch
            && row.get::<&str, _>("snapshot_id") == identity.snapshot_id
            && row.get::<&str, _>("owner_epoch") == authority.owner_epoch()
            && row.get::<&str, _>("generation") == authority.generation()
            && row.get::<&str, _>("status") == "live",
        "Call owner was revoked or replaced",
    )?;
    let raw: String = sqlx::query_scalar(
        "SELECT capture_json FROM engine_start030_requests WHERE system_id=? AND invocation_id=?",
    )
    .bind(&identity.system_start_id)
    .bind(&identity.flow_invocation_id)
    .fetch_one(&mut *db)
    .await?;
    let capture: StartCapture030 = serde_json::from_str(&raw)?;
    require(
        capture.identity == *identity
            && sha(&serde_json::to_vec(&capture)?) == row.get::<&str, _>("capture_sha256"),
        "Call capture differs",
    )?;
    Ok(capture)
}
async fn state_tx(db: &mut SqliteConnection, id: &FlowIdentity030) -> Result<FlowState030> {
    let row = sqlx::query("SELECT snapshot_id,epoch,state_json FROM engine_flow030_runs WHERE system_id=? AND invocation_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).fetch_one(&mut *db).await?;
    let state: FlowState030 = serde_json::from_str(row.get("state_json"))?;
    require(
        state.identity == *id
            && row.get::<&str, _>("snapshot_id") == id.snapshot_id
            && row.get::<&str, _>("epoch") == id.epoch,
        "Call flow identity differs",
    )?;
    Ok(state)
}
fn declaration<'a>(
    capture: &'a StartCapture030,
    effect: &FlowEffect030,
    state: &FlowState030,
) -> Result<String> {
    let FlowEffectKind030::Start {
        work,
        step: Some(address),
        agent: None,
        input_json,
        message_json,
        item_json,
        occurrence,
        sender,
    } = &effect.kind
    else {
        return Err(denied("A call requires its own Start without an agent"));
    };
    require(
        work.start_effect_id == effect.id && work.agent_instance_id.is_none(),
        "Calls cannot borrow agent identities",
    )?;
    let mut activations = state
        .activations
        .iter()
        .filter(|a| a.id == work.activation_id);
    let a = activations
        .next()
        .ok_or_else(|| denied("Call activation missing"))?;
    require(
        activations.next().is_none()
            && a.step.as_ref() == Some(address)
            && a.agent.is_none()
            && a.instance_id.is_none()
            && a.start_effect_id.as_ref() == Some(&effect.id)
            && a.input_json == *input_json
            && a.message_json == *message_json
            && a.item_json == *item_json
            && a.occurrence == *occurrence
            && a.producer == *sender,
        "Call visit or occurrence differs from its Start",
    )?;
    let plan: FlowPlan030 = serde_json::from_str(&capture.compiled_plan_json)?;
    let mut steps = plan.steps.iter().filter(|s| s.address == *address);
    let step = steps
        .next()
        .ok_or_else(|| denied("Call declaration missing"))?;
    require(
        steps.next().is_none()
            && step.r#type == "call"
            && step.agent.is_none()
            && step.instance.is_none(),
        "Call step is not independent",
    )?;
    validate_json(&step.declaration_json)?;
    let value: Value = serde_json::from_str(&step.declaration_json)?;
    require(
        value["type"] == "call" && value.get("command").is_some() != value.get("mcp").is_some(),
        "Call declaration shape differs",
    )?;
    Ok(step.declaration_json.clone())
}
async fn verify_attempt_tx<A: CallAuthority030>(
    db: &mut SqliteConnection,
    authority: &A,
    attempt: &CallAttempt030,
    active: bool,
) -> Result<FlowState030> {
    require(
        attempt.identity == attempt.effect.identity
            && !attempt.call_id.is_empty()
            && attempt.owner_epoch == authority.owner_epoch()
            && attempt.generation == authority.generation(),
        "Call attribution differs",
    )?;
    let capture = capture_tx(db, authority, &attempt.identity).await?;
    require(
        sha(&serde_json::to_vec(&capture)?) == attempt.capture_sha256,
        "Call captured bytes differ",
    )?;
    let state = state_tx(db, &attempt.identity).await?;
    require(
        declaration(&capture, &attempt.effect, &state)? == attempt.declaration_json,
        "Call declaration changed",
    )?;
    let row = sqlx::query("SELECT effect_json,owner_epoch FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? AND effect_id=?")
        .bind(&attempt.identity.system_start_id).bind(&attempt.identity.flow_invocation_id).bind(&attempt.effect.id).fetch_one(&mut *db).await?;
    require(
        serde_json::from_str::<FlowEffect030>(row.get("effect_json"))? == attempt.effect
            && row.get::<&str, _>("owner_epoch") == attempt.owner_epoch,
        "Call Start differs",
    )?;
    if active {
        require_admission_tx(db, &attempt.identity).await?;
        require(
            flow_store030::eligible(&state, &attempt.effect),
            "Call is no longer eligible",
        )?;
        authority
            .effect(db, &attempt.effect)
            .await
            .map_err(store_error)?;
        authority
            .qualify_tx(db, &capture, &attempt.effect, &attempt.declaration_json)
            .await
            .map_err(store_error)?;
    }
    Ok(state)
}

pub(crate) async fn reserve_tx<A: CallAuthority030>(
    db: &mut SqliteConnection,
    authority: &A,
    effect: &FlowEffect030,
) -> Result<CallAttempt030> {
    let capture = capture_tx(db, authority, &effect.identity).await?;
    let state = state_tx(db, &effect.identity).await?;
    require_admission_tx(db, &effect.identity).await?;
    let declaration_json = declaration(&capture, effect, &state)?;
    require(
        flow_store030::eligible(&state, effect),
        "Cannot reserve a stopped call",
    )?;
    authority.effect(db, effect).await.map_err(store_error)?;
    authority
        .qualify_tx(db, &capture, effect, &declaration_json)
        .await
        .map_err(store_error)?;
    let row = sqlx::query("SELECT status,effect_json,owner_epoch FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? AND effect_id=?")
        .bind(&effect.identity.system_start_id).bind(&effect.identity.flow_invocation_id).bind(&effect.id).fetch_one(&mut *db).await?;
    require(
        row.get::<&str, _>("status") == "pending"
            && row.get::<&str, _>("owner_epoch") == authority.owner_epoch()
            && serde_json::from_str::<FlowEffect030>(row.get("effect_json"))? == *effect,
        "Call Start already claimed or changed",
    )?;
    let attempt = CallAttempt030 {
        identity: effect.identity.clone(),
        owner_epoch: authority.owner_epoch().into(),
        generation: authority.generation().into(),
        call_id: uuid::Uuid::new_v4().to_string(),
        capture_sha256: sha(&serde_json::to_vec(&capture)?),
        effect: effect.clone(),
        declaration_json,
    };
    sqlx::query("INSERT INTO engine_flow030_calls(system_id,invocation_id,activation_id,start_effect_id,call_id,attempt_json,status) VALUES(?,?,?,?,?,?,'reserved')")
        .bind(&attempt.identity.system_start_id).bind(&attempt.identity.flow_invocation_id).bind(&attempt.work().activation_id)
        .bind(&attempt.effect.id).bind(&attempt.call_id).bind(serde_json::to_string(&attempt)?)
        .execute(&mut *db).await.map_err(|_| denied("Call already reserved; inspect without replay"))?;
    Ok(attempt)
}
async fn row_tx(
    db: &mut SqliteConnection,
    attempt: &CallAttempt030,
) -> Result<sqlx::sqlite::SqliteRow> {
    let row = sqlx::query("SELECT * FROM engine_flow030_calls WHERE system_id=? AND invocation_id=? AND activation_id=?")
        .bind(&attempt.identity.system_start_id).bind(&attempt.identity.flow_invocation_id).bind(&attempt.work().activation_id)
        .fetch_one(&mut *db).await?;
    require(
        row.get::<&str, _>("call_id") == attempt.call_id
            && row.get::<&str, _>("start_effect_id") == attempt.effect.id
            && decode_attempt(row.get("attempt_json"))? == *attempt,
        "Receipt belongs to a different call/visit",
    )?;
    Ok(row)
}

/// Native readback of an allocation after a lost reservation acknowledgement.
/// A returned attempt is an attribution handle, NOT a permission to launch.
pub(crate) async fn read_attempt_tx<A: CallAuthority030>(
    db: &mut SqliteConnection,
    authority: &A,
    id: &FlowIdentity030,
    work: &WorkRef030,
) -> Result<Option<CallAttempt030>> {
    capture_tx(db, authority, id).await?;
    let raw: Option<String> = sqlx::query_scalar("SELECT attempt_json FROM engine_flow030_calls WHERE system_id=? AND invocation_id=? AND activation_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&work.activation_id).fetch_optional(&mut *db).await?;
    let Some(raw) = raw else { return Ok(None) };
    let attempt = decode_attempt(&raw)?;
    require(
        attempt.identity == *id && attempt.work() == work,
        "Call readback targets a different visit",
    )?;
    verify_attempt_tx(db, authority, &attempt, false).await?;
    row_tx(db, &attempt).await?;
    Ok(Some(attempt))
}

pub(crate) fn validate_prepared(
    attempt: &CallAttempt030,
    prepared: &PreparedCall030,
) -> Result<()> {
    let step: Value = serde_json::from_str(attempt.declaration_json())?;
    match prepared {
        PreparedCall030::Command { command, parse } => require(
            step.get("command").and_then(Value::as_str) == Some(command)
                && step.get("parse").and_then(Value::as_str) == parse.as_deref()
                && parse
                    .as_deref()
                    .is_none_or(|p| matches!(p, "json" | "lines")),
            "Prepared command differs from the captured declaration",
        ),
        PreparedCall030::Mcp {
            server,
            tool,
            arguments_json,
        } => {
            require(
                step["mcp"]["server"].as_str() == Some(server)
                    && step["mcp"]["tool"].as_str() == Some(tool),
                "Prepared MCP target differs",
            )?;
            validate_json(arguments_json)?;
            // Resolve exact operand selections for verification only. Execution
            // still uses prepareCall030's ticketed, lossless preparation.
            let step: Object = serde_json::from_str(attempt.declaration_json())?;
            let args: Object = match step.get("arguments") {
                Some(raw) => serde_json::from_str(raw.get())?,
                None => BTreeMap::new(),
            };
            let actual: Object = serde_json::from_str(arguments_json)?;
            require(args.len() == actual.len(), "MCP argument names differ")?;
            for (name, raw) in args {
                let operand: Object = serde_json::from_str(raw.get())?;
                require(operand.len() == 1, "MCP operand shape differs")?;
                let expected = if let Some(raw) = operand.get("value") {
                    raw.clone()
                } else if let Some(path) = operand.get("path") {
                    select_raw(attempt.input_json(), path.get())?
                } else {
                    return Err(denied("MCP operand missing"));
                };
                let actual = actual
                    .get(&name)
                    .ok_or_else(|| denied("MCP argument missing"))?;
                require(
                    crate::db::exact_json::equal(expected.get(), actual.get())?,
                    "MCP argument differs from its native source",
                )?;
            }
            Ok(())
        }
    }
}
fn select_raw(input: &str, path: &str) -> Result<Box<RawValue>> {
    validate_json(input)?;
    let path: Vec<Box<RawValue>> = serde_json::from_str(path)?;
    let mut value: Box<RawValue> = serde_json::from_str(input)?;
    for part in path {
        value = if part.get().starts_with('"') && value.get().starts_with('{') {
            let name: String = serde_json::from_str(part.get())?;
            let mut object: Object = serde_json::from_str(value.get())?;
            object
                .remove(&name)
                .ok_or_else(|| denied("MCP selection property absent"))?
        } else if value.get().starts_with('[') {
            let array: Vec<Box<RawValue>> = serde_json::from_str(value.get())?;
            let index = if crate::db::exact_json::equal(part.get(), "0")? {
                0
            } else {
                crate::db::exact_json::positive_integer(part.get())
                    .and_then(|v| v.parse::<usize>().ok())
                    .ok_or_else(|| denied("MCP selection index invalid"))?
            };
            array
                .into_iter()
                .nth(index)
                .ok_or_else(|| denied("MCP selection index absent"))?
        } else {
            return Err(denied("MCP selection container differs"));
        };
    }
    Ok(value)
}

/// Independently verify a ticketed OPERAND against the captured MCP operands.
/// A worker failure string alone cannot manufacture a failure or physical proof.
pub(crate) fn require_operand_failure(attempt: &CallAttempt030) -> Result<()> {
    let step: Object = serde_json::from_str(attempt.declaration_json())?;
    require(
        step.contains_key("mcp") && !step.contains_key("command"),
        "Only MCP operands can fail preparation",
    )?;
    let args: Object = match step.get("arguments") {
        Some(raw) => serde_json::from_str(raw.get())?,
        None => BTreeMap::new(),
    };
    for raw in args.values() {
        let operand: Object = serde_json::from_str(raw.get())?;
        if operand.len() != 1 {
            return Ok(());
        }
        if let Some(path) = operand.get("path") {
            if select_raw(attempt.input_json(), path.get()).is_err() {
                return Ok(());
            }
        } else if !operand.contains_key("value") {
            return Ok(());
        }
    }
    Err(denied("OPERAND does not match the captured call input"))
}
async fn require_no_handoff_tx(db: &mut SqliteConnection, attempt: &CallAttempt030) -> Result<()> {
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM engine_flow030_handoffs WHERE system_id=? AND invocation_id=? AND effect_id=?)")
        .bind(&attempt.identity.system_start_id).bind(&attempt.identity.flow_invocation_id).bind(&attempt.effect.id).fetch_one(db).await?;
    require(
        !exists,
        "Preparation failure cannot borrow a physical handoff",
    )
}
pub(crate) async fn fail_preparation_tx<A: CallAuthority030>(
    db: &mut SqliteConnection,
    authority: &A,
    attempt: &CallAttempt030,
) -> Result<CallSettlement030> {
    if let Some(diagnostic) =
        read_diagnostic_tx(db, authority, attempt.identity(), attempt.work()).await?
    {
        return Ok(CallSettlement030::Diagnostic { diagnostic });
    }
    let state = verify_attempt_tx(db, authority, attempt, false).await?;
    let row = row_tx(db, attempt).await?;
    require(
        row.get::<&str, _>("status") == "reserved",
        "Preparation failure arrived after admission",
    )?;
    require_operand_failure(attempt)?;
    require_no_handoff_tx(db, attempt).await?;
    let received = ReceivedCall030 {
        end: CallEnd030::PreparationFailed,
        physical: CallPhysical030::NotStarted {
            receipt_id: uuid::Uuid::new_v4().to_string(),
        },
    };
    let stopped = call_stopped(&state, attempt)?;
    let receipt = CallReceipt030 {
        attempt: attempt.clone(),
        received,
        result: if stopped {
            CallResult030::Stopped
        } else {
            CallResult030::failure("OPERAND")
        },
        event_id: format!("call:{}:terminal", attempt.call_id),
    };
    if let Some(diagnostic) = apply_terminal_tx(db, authority, &state, &receipt).await? {
        return Ok(CallSettlement030::Diagnostic { diagnostic });
    }
    sqlx::query("UPDATE engine_flow030_calls SET status='terminal',received_json=?,receipt_json=? WHERE call_id=? AND status='reserved'")
        .bind(serde_json::to_string(&receipt.received)?).bind(serde_json::to_string(&receipt)?).bind(&attempt.call_id).execute(db).await?;
    Ok(CallSettlement030::Terminal { receipt })
}

pub(crate) async fn prepare_tx<A: CallAuthority030>(
    db: &mut SqliteConnection,
    authority: &A,
    attempt: &CallAttempt030,
    prepared: &PreparedCall030,
) -> Result<()> {
    verify_attempt_tx(db, authority, attempt, true).await?;
    let row = row_tx(db, attempt).await?;
    validate_prepared(attempt, prepared)?;
    require(
        row.get::<&str, _>("status") == "reserved",
        "Call preparation already consumed",
    )?;
    sqlx::query("UPDATE engine_flow030_calls SET status='prepared',prepared_json=? WHERE call_id=? AND status='reserved'")
        .bind(serde_json::to_string(prepared)?).bind(&attempt.call_id).execute(db).await?;
    Ok(())
}

/// This claim is consumed BEFORE physical IO. COMMIT acknowledgement is needed
/// before a caller may create/poll any transport. Readback never yields a permit.
pub(crate) async fn launch_tx<A: CallAuthority030>(
    db: &mut SqliteConnection,
    authority: &A,
    attempt: &CallAttempt030,
    control: &crate::agsdl_host_calls::Control,
) -> Result<()> {
    verify_attempt_tx(db, authority, attempt, true).await?;
    control
        .check()
        .map_err(|e| failure(&e.code, "call", &e.detail))?;
    let row = row_tx(db, attempt).await?;
    require(
        row.get::<&str, _>("status") == "prepared",
        "Call launch consumed or not prepared",
    )?;
    let handoff = sqlx::query("SELECT h.receipt_json,h.owner_epoch,h.generation,o.status,o.settlement_json FROM engine_flow030_handoffs h JOIN engine_flow030_outbox o USING(system_id,invocation_id,effect_id) WHERE h.system_id=? AND h.invocation_id=? AND h.effect_id=?")
        .bind(&attempt.identity.system_start_id).bind(&attempt.identity.flow_invocation_id).bind(&attempt.effect.id)
        .fetch_optional(&mut *db).await?.ok_or_else(|| denied("Call has no native owned handoff"))?;
    let raw: &str = handoff.get("receipt_json");
    let receipt: Value = serde_json::from_str(raw)?;
    require(
        handoff.get::<&str, _>("owner_epoch") == attempt.owner_epoch
            && handoff.get::<&str, _>("generation") == attempt.generation
            && handoff.get::<&str, _>("status") == "settled"
            && handoff.get::<Option<&str>, _>("settlement_json") == Some(raw)
            && receipt["kind"] == "nativeOwnedHandoff030"
            && receipt["identity"] == serde_json::to_value(&attempt.identity)?
            && receipt["effectId"] == attempt.effect.id
            && receipt["ownerEpoch"] == attempt.owner_epoch
            && receipt["generation"] == attempt.generation
            && receipt.get("workAttempt").is_none()
            && receipt["requestId"]
                == format!(
                    "flow030:{}:{}",
                    attempt.identity.system_start_id, attempt.effect.id
                ),
        "Call handoff attribution differs",
    )?;
    sqlx::query(
        "UPDATE engine_flow030_calls SET status='launched' WHERE call_id=? AND status='prepared'",
    )
    .bind(&attempt.call_id)
    .execute(db)
    .await?;
    Ok(())
}

pub(crate) fn validate_event(prepared: &PreparedCall030, event: &CallEvent030) -> Result<()> {
    match (prepared, event) {
        (_, CallEvent030::StartFailed)
        | (PreparedCall030::Command { .. }, CallEvent030::CommandReceipt { .. }) => Ok(()),
        (
            PreparedCall030::Mcp { .. },
            CallEvent030::ToolReturned {
                structured_content_json,
                ..
            },
        ) => {
            if let Some(raw) = structured_content_json {
                validate_json(raw)?;
            }
            Ok(())
        }
        _ => Err(denied(
            "Transport receipt kind differs from its captured call",
        )),
    }
}
/// Check that a ticketed pure output cannot replace the raw receipt, outcome,
/// stdout parser, or MCP structured result with model-authored strings.
pub(crate) fn validate_output(
    prepared: &PreparedCall030,
    event: &CallEvent030,
    output_json: &str,
) -> Result<()> {
    validate_json(output_json)?;
    let output: Object = serde_json::from_str(output_json)?;
    require(output.len() == 2, "Call output shape differs")?;
    let outcome: String = serde_json::from_str(
        output
            .get("outcome")
            .ok_or_else(|| denied("Call outcome absent"))?
            .get(),
    )?;
    let data = output
        .get("data")
        .ok_or_else(|| denied("Call data absent"))?;
    match (prepared, event) {
        (
            PreparedCall030::Command { parse, .. },
            CallEvent030::CommandReceipt {
                stdout,
                stderr,
                exit_code,
            },
        ) => {
            require(
                outcome == if *exit_code == 0 { "passed" } else { "failed" },
                "Command outcome differs from its exit status",
            )?;
            let data: Object = serde_json::from_str(data.get())?;
            require(
                data.len() == if parse.is_some() { 3 } else { 2 },
                "Command output fields differ",
            )?;
            require(
                data.get("exitCode")
                    .is_some_and(|v| v.get() == exit_code.to_string()),
                "Command exit status differs",
            )?;
            let output: String = serde_json::from_str(
                data.get("output")
                    .ok_or_else(|| denied("Command streams absent"))?
                    .get(),
            )?;
            require(
                output == format!("{stdout}{stderr}"),
                "Command stream bytes differ",
            )?;
            if let Some(parse) = parse {
                let value = data
                    .get("value")
                    .ok_or_else(|| denied("Parsed command value absent"))?;
                if parse == "json" {
                    require(
                        crate::db::exact_json::equal(stdout, value.get())?,
                        "Command JSON differs from original stdout",
                    )?;
                } else {
                    let lines: Vec<String> = serde_json::from_str(value.get())?;
                    let parts: Vec<&str> = stdout.split('\n').collect();
                    let expected: Vec<&str> = parts
                        .iter()
                        .enumerate()
                        .map(|(i, line)| {
                            if i + 1 < parts.len() {
                                line.strip_suffix('\r').unwrap_or(line)
                            } else {
                                line
                            }
                        })
                        .filter(|line| !line.is_empty())
                        .collect();
                    require(
                        lines == expected,
                        "Command lines differ from original stdout",
                    )?;
                }
            }
        }
        (
            PreparedCall030::Mcp { .. },
            CallEvent030::ToolReturned {
                is_error,
                text,
                structured_content_json,
            },
        ) => {
            require(
                outcome == if *is_error { "failed" } else { "passed" },
                "MCP outcome differs from isError",
            )?;
            let expected = structured_content_json
                .clone()
                .unwrap_or(serde_json::to_string(text)?);
            require(
                crate::db::exact_json::equal(data.get(), &expected)?,
                "MCP content differs from its receipt",
            )?;
        }
        _ => return Err(denied("Call output does not belong to this transport")),
    }
    Ok(())
}

async fn validate_result_tx(
    db: &mut SqliteConnection,
    attempt: &CallAttempt030,
    prepared: &PreparedCall030,
    received: &ReceivedCall030,
    result: &CallResult030,
) -> Result<()> {
    if matches!(result,CallResult030::Failed { code } if code == "TIMEOUT") {
        require(
            read_cause_tx(db, attempt).await?.is_some(),
            "TIMEOUT has no durable native cause",
        )?;
        return Ok(());
    }
    match (result, &received.end) {
        (CallResult030::Completed { output_json }, CallEnd030::Returned { event }) => {
            validate_output(&prepared, event, output_json)?
        }
        (
            CallResult030::Failed { code },
            CallEnd030::Returned {
                event: CallEvent030::StartFailed,
            },
        ) => require(code == "CALL_FAILED", "Startup failure differs")?,
        (
            CallResult030::Failed { code },
            CallEnd030::Returned {
                event: CallEvent030::CommandReceipt { stdout, .. },
            },
        ) => {
            require(
                code == "OUTPUT_INVALID"
                    && matches!(prepared, PreparedCall030::Command { parse: Some(p), .. } if p == "json")
                    && validate_json(stdout).is_err(),
                "Call parse failure differs",
            )?;
        }
        _ => return Err(denied("Call terminal contradicts raw receipt")),
    }
    Ok(())
}

pub(crate) async fn receive_tx<A: CallAuthority030>(
    db: &mut SqliteConnection,
    authority: &A,
    joined: &JoinedCall030,
) -> Result<PreparedCall030> {
    let attempt = joined.attempt();
    let received = received_from_join(joined)?;
    // A late native receipt can be retained after Stop, but cannot route success.
    let state = verify_attempt_tx(db, authority, attempt, false).await?;
    let row = row_tx(db, attempt).await?;
    let prepared: PreparedCall030 = serde_json::from_str(
        row.get::<Option<&str>, _>("prepared_json")
            .ok_or_else(|| denied("Call was not prepared"))?,
    )?;
    if !call_stopped(&state, attempt)?
        && settlement_cause_tx(db, authority, attempt).await?.is_none()
    {
        if let CallEnd030::Returned { event } = &received.end {
            validate_event(&prepared, event)?;
        }
    }
    let raw = serde_json::to_string(&received)?;
    match row.get::<&str, _>("status") {
        "launched" => {
            sqlx::query("UPDATE engine_flow030_calls SET status='received',received_json=? WHERE call_id=? AND status='launched'")
                .bind(raw).bind(&attempt.call_id).execute(db).await?;
        }
        "received" => require(
            row.get::<Option<&str>, _>("received_json") == Some(raw.as_str()),
            "Contradictory call receipt",
        )?,
        _ => {
            return Err(denied(
                "Call receipt arrived before launch or after terminal",
            ))
        }
    }
    Ok(prepared)
}

async fn apply_terminal_tx<A: CallAuthority030>(
    db: &mut SqliteConnection,
    authority: &A,
    state: &FlowState030,
    receipt: &CallReceipt030,
) -> Result<Option<CallDiagnostic030>> {
    let work = receipt.attempt.work();
    let activation = state
        .activations
        .iter()
        .find(|a| a.id == work.activation_id)
        .ok_or_else(|| denied("Call activation absent"))?;
    let stopped = state.stopping || activation.stop_effect_id.is_some();
    let kind = if stopped || matches!(receipt.result, CallResult030::Stopped) {
        // Never publish a late success or take onError after branch cancellation.
        require(stopped, "Call stopped without native Stop attribution")?;
        FlowEventKind030::PhysicalEnded {
            work: work.clone(),
            stop_effect_id: activation.stop_effect_id.clone(),
            evidence: receipt.physical(),
        }
    } else {
        FlowEventKind030::WorkResult {
            work: work.clone(),
            result: receipt
                .work_result()?
                .ok_or_else(|| denied("Call result absent"))?,
            physical: Some(receipt.physical()),
        }
    };
    let event = FlowEvent030 {
        identity: receipt.attempt.identity.clone(),
        event_id: receipt.event_id.clone(),
        expected_revision: state.revision.clone(),
        kind,
    };
    match flow_store030::apply_tx(db, authority, &event)
        .await
        .map_err(store_error)?
    {
        Apply030::Applied(_) | Apply030::Replayed(_) => Ok(None),
        Apply030::Diagnostic(value) => {
            let diagnostic = CallDiagnostic030 {
                candidate: receipt.clone(),
                diagnostic: value,
            };
            sqlx::query("INSERT INTO engine_flow030_call_diagnostics(call_id,system_id,invocation_id,event_id,record_json) VALUES(?,?,?,?,?)")
                .bind(receipt.attempt.call_id()).bind(&receipt.attempt.identity.system_start_id)
                .bind(&receipt.attempt.identity.flow_invocation_id).bind(&receipt.event_id)
                .bind(serde_json::to_string(&diagnostic)?).execute(db).await?;
            Ok(Some(diagnostic))
        }
    }
}

fn call_stopped(state: &FlowState030, attempt: &CallAttempt030) -> Result<bool> {
    let activation = state
        .activations
        .iter()
        .find(|a| a.id == attempt.work().activation_id)
        .ok_or_else(|| denied("Call visit absent"))?;
    Ok(state.stopping || activation.stop_effect_id.is_some())
}
/// Stop cleanup depends on an actual join and native state, never on JS.
pub(crate) async fn finish_controlled_tx<A: CallAuthority030>(
    db: &mut SqliteConnection,
    authority: &A,
    joined: &JoinedCall030,
) -> Result<Option<CallSettlement030>> {
    if let Some(diagnostic) = read_diagnostic_tx(
        db,
        authority,
        joined.attempt().identity(),
        joined.attempt().work(),
    )
    .await?
    {
        require(
            diagnostic.matches_joined(joined)?,
            "Diagnostic belongs to another joined call",
        )?;
        return Ok(Some(CallSettlement030::Diagnostic { diagnostic }));
    }
    let state = verify_attempt_tx(db, authority, joined.attempt(), false).await?;
    let result = if call_stopped(&state, joined.attempt())? {
        CallResult030::Stopped
    } else if settlement_cause_tx(db, authority, joined.attempt())
        .await?
        .is_some()
    {
        CallResult030::failure("TIMEOUT")
    } else {
        return Ok(None);
    };
    Ok(Some(finish_tx(db, authority, joined, result).await?))
}

pub(crate) async fn finish_tx<A: CallAuthority030>(
    db: &mut SqliteConnection,
    authority: &A,
    joined: &JoinedCall030,
    mut result: CallResult030,
) -> Result<CallSettlement030> {
    if let Some(diagnostic) = read_diagnostic_tx(
        db,
        authority,
        joined.attempt().identity(),
        joined.attempt().work(),
    )
    .await?
    {
        require(
            diagnostic.matches_joined(joined)?,
            "Diagnostic belongs to another joined call",
        )?;
        return Ok(CallSettlement030::Diagnostic { diagnostic });
    }
    let attempt = joined.attempt();
    let received = received_from_join(joined)?;
    let state = verify_attempt_tx(db, authority, attempt, false).await?;
    let row = row_tx(db, attempt).await?;
    if call_stopped(&state, attempt)? {
        result = CallResult030::Stopped;
    } else if settlement_cause_tx(db, authority, attempt).await?.is_some() {
        result = CallResult030::failure("TIMEOUT");
    }

    if row.get::<&str, _>("status") == "terminal" {
        let receipt = read_receipt_tx(db, authority, attempt.identity(), attempt.work())
            .await?
            .ok_or_else(|| denied("Call terminal receipt missing"))?;
        require(
            receipt.received == received && receipt.result == result,
            "Conflicting call terminal",
        )?;
        return Ok(CallSettlement030::Terminal { receipt });
    }
    require(
        row.get::<&str, _>("status") == "received"
            && row.get::<Option<&str>, _>("received_json")
                == Some(serde_json::to_string(&received)?.as_str()),
        "Call terminal raw receipt differs",
    )?;
    let activation = state
        .activations
        .iter()
        .find(|a| a.id == attempt.work().activation_id)
        .ok_or_else(|| denied("Call visit absent"))?;
    if state.stopping || activation.stop_effect_id.is_some() {
        result = CallResult030::Stopped;
    } else {
        require(
            !matches!(result, CallResult030::Stopped),
            "Call Stop has no native flow decision",
        )?;
        let prepared: PreparedCall030 = serde_json::from_str(
            row.get::<Option<&str>, _>("prepared_json")
                .ok_or_else(|| denied("Call request missing"))?,
        )?;
        validate_prepared(attempt, &prepared)?;
        validate_result_tx(db, attempt, &prepared, &received, &result).await?;
    }
    let receipt = CallReceipt030 {
        attempt: attempt.clone(),
        received: received.clone(),
        result,
        event_id: format!("call:{}:terminal", attempt.call_id),
    };
    if let Some(diagnostic) = apply_terminal_tx(db, authority, &state, &receipt).await? {
        return Ok(CallSettlement030::Diagnostic { diagnostic });
    }
    sqlx::query("UPDATE engine_flow030_calls SET status='terminal',receipt_json=? WHERE call_id=? AND status='received'")
        .bind(serde_json::to_string(&receipt)?).bind(&attempt.call_id).execute(db).await?;
    Ok(CallSettlement030::Terminal { receipt })
}

pub(crate) async fn stop_before_launch_tx<A: CallAuthority030>(
    db: &mut SqliteConnection,
    authority: &A,
    attempt: &CallAttempt030,
) -> Result<CallSettlement030> {
    if let Some(diagnostic) =
        read_diagnostic_tx(db, authority, attempt.identity(), attempt.work()).await?
    {
        return Ok(CallSettlement030::Diagnostic { diagnostic });
    }
    let state = verify_attempt_tx(db, authority, attempt, false).await?;
    let row = row_tx(db, attempt).await?;
    if row.get::<&str, _>("status") == "terminal" {
        let receipt = read_receipt_tx(db, authority, attempt.identity(), attempt.work())
            .await?
            .ok_or_else(|| denied("Call receipt absent"))?;
        require(
            matches!(
                receipt.received.physical,
                CallPhysical030::NotStarted { .. }
            ),
            "Call had already launched",
        )?;
        return Ok(CallSettlement030::Terminal { receipt });
    }
    require(
        matches!(row.get::<&str, _>("status"), "reserved" | "prepared"),
        "Launched call needs its owned join",
    )?;
    let received = ReceivedCall030 {
        end: CallEnd030::Stopped,
        physical: CallPhysical030::NotStarted {
            receipt_id: uuid::Uuid::new_v4().to_string(),
        },
    };
    let receipt = CallReceipt030 {
        attempt: attempt.clone(),
        received: received.clone(),
        result: CallResult030::Stopped,
        event_id: format!("call:{}:terminal", attempt.call_id),
    };
    if let Some(diagnostic) = apply_terminal_tx(db, authority, &state, &receipt).await? {
        return Ok(CallSettlement030::Diagnostic { diagnostic });
    }
    sqlx::query("UPDATE engine_flow030_calls SET status='terminal',received_json=?,receipt_json=? WHERE call_id=? AND status IN ('reserved','prepared')")
        .bind(serde_json::to_string(&received)?).bind(serde_json::to_string(&receipt)?).bind(&attempt.call_id).execute(db).await?;
    Ok(CallSettlement030::Terminal { receipt })
}

/// Read-only diagnostic inspection. It returns no work terminal/source of route
/// and never reruns the normalizer or reducer, even if the resident is gone.
pub(crate) async fn read_diagnostic_tx<A: CallAuthority030>(
    db: &mut SqliteConnection,
    authority: &A,
    id: &FlowIdentity030,
    work: &WorkRef030,
) -> Result<Option<CallDiagnostic030>> {
    authority.call_commits().require_clear(id)?;
    let Some(attempt) = read_attempt_tx(db, authority, id, work).await? else {
        return Ok(None);
    };
    let row = sqlx::query("SELECT event_id,record_json FROM engine_flow030_call_diagnostics WHERE call_id=? AND system_id=? AND invocation_id=?")
        .bind(attempt.call_id()).bind(&id.system_start_id).bind(&id.flow_invocation_id).fetch_optional(&mut *db).await?;
    let Some(row) = row else { return Ok(None) };
    let stored: StoredDiagnostic030 = serde_json::from_str(row.get("record_json"))?;
    let candidate = stored.candidate;
    require(
        candidate.attempt == attempt
            && candidate.event_id == row.get::<&str, _>("event_id")
            && candidate.event_id == format!("call:{}:terminal", attempt.call_id()),
        "Call diagnostic attribution differs",
    )?;
    let call = row_tx(db, &attempt).await?;
    match call.get::<Option<&str>, _>("received_json") {
        Some(raw) => {
            require(
                decode_received(raw)? == candidate.received,
                "Diagnostic raw receipt differs",
            )?;
            if !matches!(candidate.result, CallResult030::Stopped) {
                let prepared: PreparedCall030 = serde_json::from_str(
                    call.get::<Option<&str>, _>("prepared_json")
                        .ok_or_else(|| denied("Diagnostic preparation absent"))?,
                )?;
                validate_prepared(&attempt, &prepared)?;
                validate_result_tx(
                    db,
                    &attempt,
                    &prepared,
                    &candidate.received,
                    &candidate.result,
                )
                .await?;
            }
        }
        None => {
            require(
                matches!(
                    candidate.received.physical,
                    CallPhysical030::NotStarted { .. }
                ) && matches!(candidate.received.end, CallEnd030::PreparationFailed),
                "Unjoined diagnostic lacks prelaunch proof",
            )?;
            require_operand_failure(&attempt)?;
            require_no_handoff_tx(db, &attempt).await?;
        }
    }
    let event = sqlx::query("SELECT event_json,receipt_json,diagnostic_json FROM engine_flow030_events WHERE system_id=? AND invocation_id=? AND event_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&candidate.event_id).fetch_one(&mut *db).await?;
    require(
        event.get::<Option<&str>, _>("receipt_json").is_none()
            && event
                .get::<Option<&str>, _>("diagnostic_json")
                .is_some_and(|raw| {
                    serde_json::from_str::<Value>(raw).ok().as_ref() == Some(&stored.diagnostic)
                }),
        "Call diagnostic is not committed by the reducer",
    )?;
    let actual: Value = serde_json::from_str(event.get("event_json"))?;
    let kind = match candidate.work_result()? {
        Some(result) => FlowEventKind030::WorkResult {
            work: work.clone(),
            result,
            physical: Some(candidate.physical()),
        },
        None => {
            let state = state_tx(db, id).await?;
            let activation = state
                .activations
                .iter()
                .find(|a| a.id == work.activation_id)
                .ok_or_else(|| denied("Stopped diagnostic call absent"))?;
            FlowEventKind030::PhysicalEnded {
                work: work.clone(),
                stop_effect_id: activation.stop_effect_id.clone(),
                evidence: candidate.physical(),
            }
        }
    };
    let expected = FlowEvent030 {
        identity: id.clone(),
        event_id: candidate.event_id.clone(),
        expected_revision: actual["expectedRevision"]
            .as_str()
            .ok_or_else(|| denied("Diagnostic revision absent"))?
            .into(),
        kind,
    };
    require(
        actual == serde_json::to_value(expected)?,
        "Diagnostic proposed event differs",
    )?;
    Ok(Some(CallDiagnostic030 {
        candidate,
        diagnostic: stored.diagnostic,
    }))
}

/// Read-only source authority for both normal and error call routes. Authenticates
/// complete capture/epoch/owner/Start/visit AND the committed reducer event.
/// No physical capability, outbox claim or worker job is minted by a read.
pub(crate) async fn read_receipt_tx<A: CallAuthority030>(
    db: &mut SqliteConnection,
    authority: &A,
    id: &FlowIdentity030,
    work: &WorkRef030,
) -> Result<Option<CallReceipt030>> {
    authority.call_commits().require_clear(id)?;
    let Some(attempt) = read_attempt_tx(db, authority, id, work).await? else {
        return Ok(None);
    };
    let row = row_tx(db, &attempt).await?;
    if row.get::<&str, _>("status") != "terminal" {
        return Ok(None);
    }
    let receipt = decode_receipt(
        row.get::<Option<&str>, _>("receipt_json")
            .ok_or_else(|| denied("Call terminal has no receipt"))?,
    )?;
    let received = decode_received(
        row.get::<Option<&str>, _>("received_json")
            .ok_or_else(|| denied("Call terminal has no physical receipt"))?,
    )?;
    require(
        receipt.attempt == attempt
            && receipt.received == received
            && receipt.event_id == format!("call:{}:terminal", attempt.call_id),
        "Call receipt attribution differs",
    )?;
    let event = sqlx::query("SELECT event_json,receipt_json,diagnostic_json FROM engine_flow030_events WHERE system_id=? AND invocation_id=? AND event_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&receipt.event_id).fetch_optional(&mut *db).await?
        .ok_or_else(|| denied("Call receipt has no committed reducer event"))?;
    require(
        event.get::<Option<&str>, _>("receipt_json").is_some()
            && event.get::<Option<&str>, _>("diagnostic_json").is_none(),
        "Call terminal reducer event unresolved",
    )?;
    let actual: Value = serde_json::from_str(event.get("event_json"))?;
    let kind = match &receipt.result {
        CallResult030::Stopped => {
            let state = state_tx(db, id).await?;
            let activation = state
                .activations
                .iter()
                .find(|a| a.id == work.activation_id)
                .ok_or_else(|| denied("Stopped call activation missing"))?;
            FlowEventKind030::PhysicalEnded {
                work: work.clone(),
                stop_effect_id: activation.stop_effect_id.clone(),
                evidence: receipt.physical(),
            }
        }
        _ => FlowEventKind030::WorkResult {
            work: work.clone(),
            result: receipt
                .work_result()?
                .ok_or_else(|| denied("Call route result absent"))?,
            physical: Some(receipt.physical()),
        },
    };
    let expected = FlowEvent030 {
        identity: id.clone(),
        event_id: receipt.event_id.clone(),
        expected_revision: actual["expectedRevision"]
            .as_str()
            .ok_or_else(|| denied("Call event revision missing"))?
            .into(),
        kind,
    };
    require(
        actual == serde_json::to_value(expected)?,
        "Call reducer result or physical proof differs",
    )?;
    if matches!(received.end, CallEnd030::PreparationFailed)
        && !matches!(receipt.result, CallResult030::Stopped)
    {
        require(
            matches!(receipt.result, CallResult030::Failed { ref code } if code == "OPERAND")
                && matches!(received.physical, CallPhysical030::NotStarted { ref receipt_id } if !receipt_id.is_empty())
                && row.get::<Option<&str>, _>("prepared_json").is_none(),
            "Preparation failure proof differs",
        )?;
        require_operand_failure(&attempt)?;
        require_no_handoff_tx(db, &attempt).await?;
    } else if !matches!(receipt.result, CallResult030::Stopped) {
        let prepared: PreparedCall030 = serde_json::from_str(
            row.get::<Option<&str>, _>("prepared_json")
                .ok_or_else(|| denied("Call prepared request absent"))?,
        )?;
        validate_prepared(&attempt, &prepared)?;
        validate_result_tx(db, &attempt, &prepared, &received, &receipt.result).await?;
    }
    Ok(Some(receipt))
}

/// N-HUMAN must use this in its own admission transaction before opening or
/// changing an MCP association. This does not implement a human broker.
pub(crate) async fn require_live_mcp_tx<A: CallAuthority030>(
    db: &mut SqliteConnection,
    authority: &A,
    attempt: &CallAttempt030,
    server: &str,
) -> Result<()> {
    verify_attempt_tx(db, authority, attempt, true).await?;
    let row = row_tx(db, attempt).await?;
    require(
        row.get::<&str, _>("status") == "launched",
        "Human question requires an active launched call",
    )?;
    let prepared: PreparedCall030 = serde_json::from_str(
        row.get::<Option<&str>, _>("prepared_json")
            .ok_or_else(|| denied("MCP request absent"))?,
    )?;
    require(
        matches!(prepared, PreparedCall030::Mcp { server: ref s, .. } if s == server),
        "Question server differs from its call",
    )
}

#[cfg(all(test, feature = "agsdl-engine-qa", debug_assertions))]
#[path = "call_protocol030_tests.rs"]
mod tests;
