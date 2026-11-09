//! Read-only consistency proof for the durable 030 reducer journal.
//! This does not authenticate host inputs or re-run the compiler, providers,
//! preparation/content policies, work protocol, calls, human decisions or clock.
use super::flow030::*;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

/// Host evidence still requires its own verifier, even when replay succeeds.
pub(crate) const OUTSIDE_REPLAY: &[&str] = &[
    "031-032: Start delivery registry and UI intents",
    "033/035: native owner fencing, generation lifecycle, handoff and no-admission authentication (only settlement correlation is checked)",
    "034: engine_flow030_preparations, engine_flow030_occurrence_provenance",
    "036: engine_flow030_work_admissions, engine_flow030_work_authorizations, engine_flow030_work_state, engine_flow030_work_events, engine_flow030_work_checks (only Start settlement and provider-attempt correlation are checked)",
    "037: engine_flow030_route_source_attestations, engine_flow030_route_content_contexts, engine_flow030_route_content_receipts",
    "038: engine_flow030_system_stop_requests",
    "039: engine_flow030_calls, engine_flow030_call_causes, engine_flow030_call_diagnostics",
    "040: engine_flow030_clock*, engine_flow030_human*, engine_flow030_handoff_clock",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Divergence030 {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
    pub field: String,
    pub expected: Value,
    pub stored: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReplayVerdict030 {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub divergence: Option<Divergence030>,
    pub outside_replay: &'static [&'static str],
}

impl ReplayVerdict030 {
    pub(crate) fn panic() -> Self {
        Self {
            ok: false,
            divergence: Some(mismatch(
                "verifier.panic",
                "completed verification",
                "unexpected verifier panic",
            )),
            outside_replay: OUTSIDE_REPLAY,
        }
    }
}

type Result<T> = std::result::Result<T, Divergence030>;

fn mismatch(field: &str, expected: impl Serialize, stored: impl Serialize) -> Divergence030 {
    Divergence030 {
        event_id: None,
        field: field.into(),
        expected: serde_json::to_value(expected).expect("serializable expected value"),
        stored: serde_json::to_value(stored).expect("serializable stored value"),
    }
}

fn storage(error: sqlx::Error) -> Divergence030 {
    mismatch("database", "readable 030 journal", error.to_string())
}

fn parse<T: DeserializeOwned>(field: &str, raw: &str) -> Result<T> {
    serde_json::from_str(raw).map_err(|error| {
        mismatch(
            field,
            std::any::type_name::<T>(),
            json!({"error":error.to_string(),"value":raw}),
        )
    })
}

// Equality is typed. JSON is used only to locate and describe the first difference.
fn equal<T: PartialEq + Serialize>(field: &str, expected: &T, stored: &T) -> Result<()> {
    if expected == stored {
        return Ok(());
    }
    fn difference(field: String, a: &Value, b: &Value) -> Divergence030 {
        match (a, b) {
            (Value::Object(a), Value::Object(b)) => {
                for key in a.keys().chain(b.keys()) {
                    if a.get(key) != b.get(key) {
                        return difference(
                            format!("{field}.{key}"),
                            &a.get(key).cloned().unwrap_or(Value::Null),
                            &b.get(key).cloned().unwrap_or(Value::Null),
                        );
                    }
                }
            }
            (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
                for (index, (a, b)) in a.iter().zip(b).enumerate() {
                    if a != b {
                        return difference(format!("{field}[{index}]"), a, b);
                    }
                }
            }
            _ => {}
        }
        mismatch(&field, a, b)
    }
    Err(difference(field.into(), &json!(expected), &json!(stored)))
}

// Remote derives belong only to this forensic reader. In particular, the native
// event/capability types remain non-Deserialize and cannot become IPC inputs.
#[derive(Deserialize)]
#[serde(remote = "PhysicalEvidence030", deny_unknown_fields)]
struct EvidenceRead {
    native_receipt_id: String,
    descendants_joined: bool,
}
mod optional_evidence {
    use super::*;
    #[derive(Deserialize)]
    struct Read(#[serde(with = "EvidenceRead")] PhysicalEvidence030);
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        d: D,
    ) -> std::result::Result<Option<PhysicalEvidence030>, D::Error> {
        Ok(Option::<Read>::deserialize(d)?.map(|r| r.0))
    }
}
#[derive(Deserialize)]
#[serde(remote = "WorkResult030", deny_unknown_fields)]
enum ResultRead {
    Completed {
        output_json: String,
        route_key: Option<String>,
    },
    Failed {
        error: Failure030,
    },
}
#[derive(Deserialize)]
#[serde(remote = "PreparedResult030", deny_unknown_fields)]
enum PreparedRead {
    Ready {
        batches: Vec<PreparedBatch030>,
    },
    Failed {
        target_ordinal: usize,
        error: Failure030,
    },
}
#[derive(Deserialize)]
#[serde(remote = "FlowEventKind030", deny_unknown_fields)]
enum KindRead {
    Enter {
        message_json: String,
    },
    Deliver {
        agent: String,
        instance: Instance030,
        delivery: String,
        message_json: String,
        sender: String,
    },
    WorkResult {
        work: WorkRef030,
        #[serde(with = "ResultRead")]
        result: WorkResult030,
        #[serde(default, with = "optional_evidence")]
        physical: Option<PhysicalEvidence030>,
    },
    Prepared {
        reference: PrepareRef030,
        native_receipt_id: String,
        #[serde(with = "PreparedRead")]
        result: PreparedResult030,
    },
    PhysicalEnded {
        work: WorkRef030,
        stop_effect_id: Option<String>,
        #[serde(with = "EvidenceRead")]
        evidence: PhysicalEvidence030,
    },
    Stop,
}
#[derive(Deserialize)]
#[serde(remote = "FlowEvent030", rename_all = "camelCase", deny_unknown_fields)]
struct EventRead {
    identity: FlowIdentity030,
    event_id: String,
    expected_revision: String,
    #[serde(with = "KindRead")]
    kind: FlowEventKind030,
}
#[derive(Deserialize)]
struct ReadEvent(#[serde(with = "EventRead")] FlowEvent030);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureRead {
    identity: FlowIdentity030,
    source: Value,
    compiled_plan_json: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartRead {
    source: Value,
    entry: Option<EntryRead>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntryRead {
    message_json: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartReceiptRead {
    identity: FlowIdentity030,
    enter: Option<FlowReceipt030>,
}

fn companion(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

fn snapshot_error(error: std::io::Error) -> Divergence030 {
    mismatch(
        "database.snapshot",
        "readable private snapshot",
        error.to_string(),
    )
}

/// Open with SQLITE_OPEN_READONLY (mode=ro). Without a WAL, immutable mode
/// prevents companion writes. With a nonempty WAL, SQLite may write the SHM
/// even in read-only mode, so only a private temporary copy is opened by SQLite.
/// The caller must quiesce a live writer before copying its database files.
pub(crate) async fn verify_path030(
    path: &Path,
    system_id: &str,
    invocation_id: &str,
) -> ReplayVerdict030 {
    let result = async {
        let wal = companion(path, "-wal");
        let immutable = match std::fs::metadata(&wal) {
            Ok(meta) => meta.len() == 0,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
            Err(error) => {
                return Err(mismatch(
                    "database.wal",
                    "readable WAL metadata",
                    error.to_string(),
                ))
            }
        };
        let snapshot = if immutable {
            None
        } else {
            let directory = tempfile::Builder::new()
                .prefix("macro-agsdl-replay-")
                .tempdir()
                .map_err(snapshot_error)?;
            let copy = directory.path().join("journal.sqlite");
            std::fs::copy(path, &copy).map_err(snapshot_error)?;
            std::fs::copy(&wal, companion(&copy, "-wal")).map_err(snapshot_error)?;
            match std::fs::copy(companion(path, "-shm"), companion(&copy, "-shm")) {
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(snapshot_error(error)),
            }
            Some(directory)
        };
        let read_path = snapshot
            .as_ref()
            .map(|directory| directory.path().join("journal.sqlite"));
        let options = SqliteConnectOptions::new()
            .filename(read_path.as_deref().unwrap_or(path))
            .read_only(true)
            .immutable(immutable)
            .pragma("query_only", "ON");
        let mut db = SqliteConnection::connect_with(&options)
            .await
            .map_err(storage)?;
        let mut tx = db.begin().await.map_err(storage)?;
        let result = verify(&mut tx, system_id, invocation_id).await;
        tx.rollback().await.map_err(storage)?;
        db.close().await.map_err(storage)?;
        result
    }
    .await;
    ReplayVerdict030 {
        ok: result.is_ok(),
        divergence: result.err(),
        outside_replay: OUTSIDE_REPLAY,
    }
}

async fn verify(db: &mut SqliteConnection, system: &str, invocation: &str) -> Result<()> {
    let run = sqlx::query("SELECT snapshot_id,epoch,source_json,plan_json,state_json FROM engine_flow030_runs WHERE system_id=? AND invocation_id=?")
        .bind(system).bind(invocation).fetch_optional(&mut *db).await.map_err(storage)?
        .ok_or_else(|| mismatch("run", "existing run", Value::Null))?;
    let identity = FlowIdentity030 {
        system_start_id: system.into(),
        flow_invocation_id: invocation.into(),
        snapshot_id: run.try_get("snapshot_id").map_err(storage)?,
        epoch: run.try_get("epoch").map_err(storage)?,
    };
    let plan: FlowPlan030 = parse("run.plan", run.try_get("plan_json").map_err(storage)?)?;
    let source: Value = parse("run.source", run.try_get("source_json").map_err(storage)?)?;
    equal("run.source", &plan.source, &source)?;
    let stored: FlowState030 = parse("run.state", run.try_get("state_json").map_err(storage)?)?;
    equal("run.identity", &identity, &stored.identity)?;
    let start = sqlx::query("SELECT snapshot_id,capture_epoch,capture_json,request_json,receipt_json FROM engine_start030_requests WHERE system_id=? AND invocation_id=?")
        .bind(system).bind(invocation).fetch_optional(&mut *db).await.map_err(storage)?
        .ok_or_else(|| mismatch("start.capture", "stored capture", Value::Null))?;
    let capture: CaptureRead = parse(
        "start.capture",
        start.try_get("capture_json").map_err(storage)?,
    )?;
    let request: StartRead = parse(
        "start.request",
        start.try_get("request_json").map_err(storage)?,
    )?;
    let start_receipt: StartReceiptRead = parse(
        "start.receipt",
        start.try_get("receipt_json").map_err(storage)?,
    )?;
    equal(
        "start.snapshotId",
        &identity.snapshot_id,
        &start.try_get::<String, _>("snapshot_id").map_err(storage)?,
    )?;
    equal(
        "start.epoch",
        &identity.epoch,
        &start
            .try_get::<String, _>("capture_epoch")
            .map_err(storage)?,
    )?;
    equal("start.identity", &identity, &capture.identity)?;
    equal("start.receipt.identity", &identity, &start_receipt.identity)?;
    equal("start.source", &source, &capture.source)?;
    equal("start.request.source", &source, &request.source)?;
    equal(
        "start.plan",
        &plan,
        &parse("start.plan", &capture.compiled_plan_json)?,
    )?;
    equal(
        "start.entry",
        &plan.entry.is_some(),
        &request.entry.is_some(),
    )?;
    equal(
        "start.receipt.enter",
        &request.entry.is_some(),
        &start_receipt.enter.is_some(),
    )?;

    let events = sqlx::query("SELECT event_id,event_json,receipt_json,diagnostic_json FROM engine_flow030_events WHERE system_id=? AND invocation_id=? ORDER BY rowid")
        .bind(system).bind(invocation).fetch_all(&mut *db).await.map_err(storage)?;
    let outbox = sqlx::query("SELECT effect_id,event_id,effect_json,owner_epoch,status,settlement_json FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? ORDER BY rowid")
        .bind(system).bind(invocation).fetch_all(&mut *db).await.map_err(storage)?;
    let mut state = FlowState030::new(identity);
    let mut produced = Vec::new();
    let mut work_results = BTreeSet::new();
    for (index, row) in events.iter().enumerate() {
        let event_id: String = row.try_get("event_id").map_err(storage)?;
        let result = (|| {
            let diagnostic: Option<String> = row.try_get("diagnostic_json").map_err(storage)?;
            equal("event.diagnostic", &None::<String>, &diagnostic)?;
            let receipt: Option<String> = row.try_get("receipt_json").map_err(storage)?;
            let receipt: FlowReceipt030 = parse(
                "event.receipt",
                receipt
                    .as_deref()
                    .ok_or_else(|| mismatch("event.receipt", "accepted event", Value::Null))?,
            )?;
            let event = parse::<ReadEvent>("event", row.try_get("event_json").map_err(storage)?)?.0;
            equal("event.id", &event_id, &event.event_id)?;
            if let FlowEventKind030::WorkResult { work, .. } = &event.kind {
                work_results.insert(work.start_effect_id.clone());
            }
            if index == 0 {
                if let Some(entry) = &request.entry {
                    equal(
                        "start.enter.eventId",
                        &"start:enter",
                        &event.event_id.as_str(),
                    )?;
                    equal(
                        "start.enter",
                        &json!(FlowEventKind030::Enter {
                            message_json: entry.message_json.clone()
                        }),
                        &json!(event.kind),
                    )?;
                    equal(
                        "start.receipt.enter",
                        &Some(receipt.clone()),
                        &start_receipt.enter,
                    )?;
                }
            }
            // Corrupt plans can violate internal reducer assumptions. A forensic
            // executable must return a negative verdict even for such captures.
            let transition = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                reduce(&plan, &state, &event)
            }))
            .map_err(|_| mismatch("event.reduce", "accepted transition", "reducer panic"))?
            .map_err(|error| mismatch("event.reduce", "accepted transition", error.to_string()))?;
            equal("event.receipt", &transition.receipt, &receipt)?;
            let retained = stored
                .events
                .get(&event_id)
                .ok_or_else(|| mismatch("state.events", "retained event", Value::Null))?;
            equal(
                "state.events.receipt",
                &transition.receipt,
                &retained.receipt,
            )?;
            equal(
                "state.events.event",
                &json!(event),
                &json!(parse::<ReadEvent>("state.events.event", &retained.event_json)?.0),
            )?;
            for effect in &transition.effects {
                let row = outbox
                    .get(produced.len())
                    .ok_or_else(|| mismatch("outbox.effect", effect, Value::Null))?;
                equal(
                    "outbox.eventId",
                    &event_id,
                    &row.try_get::<String, _>("event_id").map_err(storage)?,
                )?;
                equal(
                    "outbox.effectId",
                    &effect.id,
                    &row.try_get::<String, _>("effect_id").map_err(storage)?,
                )?;
                equal(
                    "outbox.effect",
                    effect,
                    &parse::<FlowEffect030>(
                        "outbox.effect",
                        row.try_get("effect_json").map_err(storage)?,
                    )?,
                )?;
                produced.push(effect.clone());
            }
            state = transition.state;
            Ok(())
        })();
        result.map_err(|mut error: Divergence030| {
            error.event_id = Some(event_id);
            error
        })?;
    }
    if events.is_empty() && request.entry.is_some() {
        return Err(mismatch("start.enter", "accepted Enter event", Value::Null));
    }
    equal("outbox.count", &produced.len(), &outbox.len())?;
    equal("run.state", &state, &stored)?;
    for (effect, row) in produced.iter().zip(&outbox) {
        let event_id: String = row.try_get("event_id").map_err(storage)?;
        verify_settlement(db, &state, &work_results, effect, row)
            .await
            .map_err(|mut error| {
                error.event_id = Some(event_id);
                error
            })?;
    }
    Ok(())
}

async fn verify_settlement(
    db: &mut SqliteConnection,
    state: &FlowState030,
    work_results: &BTreeSet<String>,
    effect: &FlowEffect030,
    row: &sqlx::sqlite::SqliteRow,
) -> Result<()> {
    let id = &effect.identity;
    let status: &str = row.try_get("status").map_err(storage)?;
    let settlement: Option<String> = row.try_get("settlement_json").map_err(storage)?;
    let owner: Option<String> = sqlx::query_scalar(
        "SELECT owner_epoch FROM engine_flow030_owners WHERE system_id=? AND invocation_id=?",
    )
    .bind(&id.system_start_id)
    .bind(&id.flow_invocation_id)
    .fetch_optional(&mut *db)
    .await
    .map_err(storage)?;
    equal(
        "outbox.ownerEpoch",
        &owner,
        &Some(row.try_get::<String, _>("owner_epoch").map_err(storage)?),
    )?;
    let handoff = sqlx::query("SELECT owner_epoch,generation,receipt_json FROM engine_flow030_handoffs WHERE system_id=? AND invocation_id=? AND effect_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&effect.id).fetch_optional(&mut *db).await.map_err(storage)?;
    let no_admission: Option<String> = sqlx::query_scalar("SELECT proof_json FROM engine_flow030_no_admissions WHERE system_id=? AND invocation_id=? AND start_effect_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&effect.id).fetch_optional(&mut *db).await.map_err(storage)?;
    if let FlowEffectKind030::Start { work, .. } = &effect.kind {
        // These rows are committed with/after handoff. Their existence cannot
        // be reconciled with a pending/uncertain Start or erased handoff.
        let evidence: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM engine_flow030_work_admissions WHERE system_id=?1 AND invocation_id=?2 AND (activation_id=?3 OR start_effect_id=?4)) OR EXISTS(SELECT 1 FROM engine_flow030_work_authorizations WHERE system_id=?1 AND invocation_id=?2 AND activation_id=?3) OR EXISTS(SELECT 1 FROM engine_flow030_work_state WHERE system_id=?1 AND invocation_id=?2 AND activation_id=?3) OR EXISTS(SELECT 1 FROM engine_flow030_work_events WHERE system_id=?1 AND invocation_id=?2 AND activation_id=?3) OR EXISTS(SELECT 1 FROM engine_flow030_work_checks WHERE system_id=?1 AND invocation_id=?2 AND activation_id=?3)")
            .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&work.activation_id).bind(&effect.id)
            .fetch_one(&mut *db).await.map_err(storage)?;
        if (evidence != 0 || work_results.contains(&effect.id))
            && (status != "settled" || handoff.is_none())
        {
            return Err(mismatch(
                "start.workEvidence",
                "settled Start with recorded handoff",
                json!({"status":status,"handoff":handoff.is_some()}),
            ));
        }
    }
    let prepared = match &effect.kind {
        FlowEffectKind030::PrepareRoute { reference, .. } => state.preparation_receipts.iter().find_map(|(receipt, prepare)| (prepare == &reference.prepare_id).then(|| json!({"kind":"nativeRoutePrepared030","prepareId":prepare,"nativeReceiptId":receipt}))),
        _ => None,
    };
    if status != "settled" {
        if !matches!(status, "pending" | "uncertain")
            || settlement.is_some()
            || handoff.is_some()
            || no_admission.is_some()
            || prepared.is_some()
        {
            return Err(mismatch(
                "outbox.status",
                "pending/uncertain without recorded settlement, or settled with proof",
                json!({"status":status,"settlement":settlement}),
            ));
        }
        return Ok(());
    }
    let receipt: Value = parse(
        "outbox.settlement",
        settlement
            .as_deref()
            .ok_or_else(|| mismatch("outbox.settlement", "recorded settlement", Value::Null))?,
    )?;
    if let Some(expected) = prepared {
        equal("outbox.settlement", &expected, &receipt)?;
        equal("outbox.handoff", &false, &handoff.is_some())?;
        equal("outbox.noAdmission", &false, &no_admission.is_some())?;
    } else if let Some(handoff) = handoff {
        equal("outbox.noAdmission", &false, &no_admission.is_some())?;
        equal(
            "outbox.settlement",
            &parse::<Value>(
                "handoff.receipt",
                handoff.try_get("receipt_json").map_err(storage)?,
            )?,
            &receipt,
        )?;
        equal(
            "handoff.kind",
            &json!("nativeOwnedHandoff030"),
            &receipt["kind"],
        )?;
        equal("handoff.identity", &json!(id), &receipt["identity"])?;
        equal("handoff.effectId", &json!(effect.id), &receipt["effectId"])?;
        equal(
            "handoff.ownerEpoch",
            &json!(row.try_get::<String, _>("owner_epoch").map_err(storage)?),
            &receipt["ownerEpoch"],
        )?;
        equal(
            "handoff.row.ownerEpoch",
            &json!(handoff
                .try_get::<String, _>("owner_epoch")
                .map_err(storage)?),
            &receipt["ownerEpoch"],
        )?;
        equal(
            "handoff.generation",
            &json!(handoff
                .try_get::<String, _>("generation")
                .map_err(storage)?),
            &receipt["generation"],
        )?;
        equal(
            "handoff.requestId",
            &json!(format!("flow030:{}:{}", id.system_start_id, effect.id)),
            &receipt["requestId"],
        )?;
        let agent_start = matches!(
            &effect.kind,
            FlowEffectKind030::Start { agent: Some(_), .. }
        );
        if agent_start && !receipt.get("workAttempt").is_some_and(Value::is_object) {
            return Err(mismatch(
                "handoff.workAttempt",
                "required agent Start attempt",
                &receipt["workAttempt"],
            ));
        }
        if let Some(attempt) = receipt.get("workAttempt") {
            if !agent_start {
                return Err(mismatch(
                    "handoff.workAttempt",
                    "agent Start effect",
                    &effect.kind,
                ));
            }
            let FlowEffectKind030::Start {
                work, step, agent, ..
            } = &effect.kind
            else {
                return Err(mismatch(
                    "handoff.workAttempt",
                    "Start effect",
                    &effect.kind,
                ));
            };
            equal(
                "handoff.workAttempt.identity",
                &json!(id),
                &attempt["identity"],
            )?;
            equal(
                "handoff.workAttempt.startEffectId",
                &json!(effect.id),
                &attempt["startEffectId"],
            )?;
            equal(
                "handoff.workAttempt.agent",
                &json!(agent),
                &attempt["agent"],
            )?;
            equal(
                "handoff.workAttempt.generation",
                &receipt["generation"],
                &attempt["generation"],
            )?;
            equal(
                "handoff.workAttempt.owner",
                &json!({"systemStartId":id.system_start_id,"ownerEpoch":receipt["ownerEpoch"]}),
                &attempt["owner"],
            )?;
            equal(
                "handoff.workAttempt.work",
                &json!({"systemStartId":id.system_start_id,"flowInvocationId":id.flow_invocation_id,"activationId":work.activation_id,"agentInstanceId":work.agent_instance_id,"step":step}),
                &attempt["work"],
            )?;
            if !attempt["providerAttemptId"]
                .as_str()
                .is_some_and(|id| !id.is_empty())
            {
                return Err(mismatch(
                    "handoff.workAttempt.providerAttemptId",
                    "nonempty provider attempt identity",
                    &attempt["providerAttemptId"],
                ));
            }
            // This is only a settlement cross-reference, not verification of 036.
            let attempts: Vec<String> = sqlx::query_scalar("SELECT DISTINCT provider_attempt_id FROM engine_flow030_work_authorizations WHERE system_id=? AND invocation_id=? AND activation_id=? AND provider_attempt_id IS NOT NULL")
                .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&work.activation_id).fetch_all(&mut *db).await.map_err(storage)?;
            if !attempts.is_empty() {
                equal(
                    "handoff.workAttempt.providerAttemptId",
                    &json!(attempts[0]),
                    &attempt["providerAttemptId"],
                )?;
                equal(
                    "handoff.workAttempt.providerAttempts",
                    &1usize,
                    &attempts.len(),
                )?;
            }
        }
    } else if matches!(
        receipt["kind"].as_str(),
        Some("nativeJoinedGroupStop030" | "nativeJoinedDiagnosticStop030")
    ) {
        // Retained R6 group stops settled directly with the joined event and
        // the original Start handoff, without creating a second handoff row.
        let FlowEffectKind030::StopWork { work, .. } = &effect.kind else {
            return Err(mismatch("joinedStop.effect", "StopWork", &effect.kind));
        };
        equal("joinedStop.noAdmission", &false, &no_admission.is_some())?;
        equal(
            "joinedStop.stopEffectId",
            &json!(effect.id),
            &receipt["stopEffectId"],
        )?;
        equal(
            "joinedStop.startEffectId",
            &json!(work.start_effect_id),
            &receipt["startEffectId"],
        )?;
        let event_id = receipt["eventId"].as_str().ok_or_else(|| {
            mismatch(
                "joinedStop.eventId",
                "accepted physical end",
                &receipt["eventId"],
            )
        })?;
        let event = state
            .events
            .get(event_id)
            .ok_or_else(|| mismatch("joinedStop.eventId", "accepted physical end", event_id))?;
        let event = parse::<ReadEvent>("joinedStop.event", &event.event_json)?.0;
        let FlowEventKind030::PhysicalEnded {
            work: ended_work,
            stop_effect_id,
            ..
        } = event.kind
        else {
            return Err(mismatch("joinedStop.event", "PhysicalEnded", json!(event)));
        };
        equal("joinedStop.work", work, &ended_work)?;
        equal(
            "joinedStop.event.stopEffectId",
            &Some(effect.id.clone()),
            &stop_effect_id,
        )?;
        let original: Option<String> = sqlx::query_scalar("SELECT receipt_json FROM engine_flow030_handoffs WHERE system_id=? AND invocation_id=? AND effect_id=?")
            .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&work.start_effect_id).fetch_optional(&mut *db).await.map_err(storage)?;
        let original: Value = parse(
            "joinedStop.startHandoff",
            original.as_deref().ok_or_else(|| {
                mismatch(
                    "joinedStop.startHandoff",
                    "recorded Start handoff",
                    Value::Null,
                )
            })?,
        )?;
        for key in ["workAttempt", "requestId", "ownerEpoch", "generation"] {
            equal(&format!("joinedStop.{key}"), &original[key], &receipt[key])?;
        }
    } else if let Some(proof) = no_admission {
        equal(
            "outbox.settlement",
            &parse::<Value>("noAdmission.proof", &proof)?,
            &receipt,
        )?;
        let FlowEffectKind030::Start { work, .. } = &effect.kind else {
            return Err(mismatch("noAdmission.effect", "Start", &effect.kind));
        };
        equal("noAdmission.identity", &json!(id), &receipt["identity"])?;
        equal("noAdmission.work", &json!(work), &receipt["work"])?;
        equal(
            "noAdmission.ownerEpoch",
            &json!(row.try_get::<String, _>("owner_epoch").map_err(storage)?),
            &receipt["ownerEpoch"],
        )?;
    } else {
        return Err(mismatch(
            "outbox.settlement",
            "recorded preparation, handoff or no-admission proof",
            receipt,
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "replay_verify030_tests.rs"]
mod tests;
