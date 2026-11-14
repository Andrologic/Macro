//! Read-only replay of flow transitions and durable human/clock arbitration.
//! This does not authenticate live host inputs or re-run the compiler, providers,
//! preparation/content policies, work protocol, calls or protocol schema validators.
use crate::persistence::flow030::*;
#[path = "replay_human030.rs"]
mod human;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

/// Host evidence still requires its own verifier, even when replay succeeds.
pub const OUTSIDE_REPLAY: &[&str] = &[
    "031-032: Start delivery registry and UI intents",
    "033/035: native owner fencing, generation lifecycle, handoff and no-admission authentication (only settlement correlation is checked)",
    "034: engine_flow030_preparations, engine_flow030_occurrence_provenance",
    "036: engine_flow030_work_admissions, engine_flow030_work_authorizations, engine_flow030_work_state, engine_flow030_work_events, engine_flow030_work_checks (only Start settlement and provider-attempt correlation are checked)",
    "037: engine_flow030_route_source_attestations, engine_flow030_route_content_contexts, engine_flow030_route_content_receipts",
    "038: engine_flow030_system_stop_requests",
    "039: engine_flow030_calls, engine_flow030_call_causes, engine_flow030_call_diagnostics",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Divergence030 {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
    pub field: String,
    pub expected: Value,
    pub stored: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayVerdict030 {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub human_projection: Option<human::HumanProjection030>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub divergence: Option<Divergence030>,
    pub outside_replay: &'static [&'static str],
}

impl ReplayVerdict030 {
    pub fn panic() -> Self {
        Self {
            ok: false,
            human_projection: None,
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
    SteerConsumed {
        effect_id: String,
        work: WorkRef030,
        delivery_activation_id: String,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NoAdmissionRead {
    identity: FlowIdentity030,
    work: WorkRef030,
    owner_epoch: String,
    generation: String,
    native_receipt_id: String,
    reason: String,
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

fn private_snapshot(path: &Path) -> std::io::Result<tempfile::TempDir> {
    let mut builder = tempfile::Builder::new();
    builder.prefix("macro-agsdl-replay-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Passed to mkdir itself, before any journal bytes are copied.
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    let directory = builder.tempdir()?;
    let copy = directory.path().join("journal.sqlite");
    for suffix in ["", "-wal", "-shm"] {
        let source = match std::fs::File::open(companion(path, suffix)) {
            Ok(file) => Some(file),
            Err(error) if suffix == "-shm" && error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut destination = options.open(companion(&copy, suffix))?;
        if let Some(mut source) = source {
            // fs::copy would preserve permissive source modes. Stream into an
            // exclusively created 0600 file instead. Precreate even a missing
            // SHM so SQLite never chooses a more permissive creation mode.
            std::io::copy(&mut source, &mut destination)?;
        }
    }
    Ok(directory)
}

/// Open with SQLITE_OPEN_READONLY (mode=ro). Without a WAL, immutable mode
/// prevents companion writes. With a nonempty WAL, SQLite may write the SHM
/// even in read-only mode, so only a private temporary copy is opened by SQLite.
/// The caller must quiesce a live writer before copying its database files.
pub async fn verify_path030(path: &Path, system_id: &str, invocation_id: &str) -> ReplayVerdict030 {
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
            Some(private_snapshot(path).map_err(snapshot_error)?)
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
        let result = async {
            verify(&mut tx, system_id, invocation_id).await?;
            let row=sqlx::query("SELECT state_json,plan_json FROM engine_flow030_runs WHERE system_id=? AND invocation_id=?").bind(system_id).bind(invocation_id).fetch_one(&mut *tx).await.map_err(storage)?;
            let state:FlowState030=parse("human.state",row.get("state_json"))?;
            let plan:FlowPlan030=parse("human.plan",row.get("plan_json"))?;
            human::verify(&mut tx,&state,&plan).await.map_err(|e|mismatch("human.readback","valid native clock and human proofs",e.to_string()))
        }.await;
        tx.rollback().await.map_err(storage)?;
        db.close().await.map_err(storage)?;
        result
    }
    .await;
    ReplayVerdict030 {
        ok: result.is_ok(),
        human_projection: result.as_ref().ok().cloned(),
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
    let mut steer_checkpoints: BTreeMap<String, Vec<(FlowEffect030, Value)>> = BTreeMap::new();
    for row in &outbox {
        let raw: Option<String> = row.try_get("settlement_json").map_err(storage)?;
        let Some(raw) = raw else {
            continue;
        };
        let receipt: Value = parse("outbox.settlement", &raw)?;
        if receipt["kind"] == "nativeSteerConsumed030" {
            if let Some(head) = receipt["consumedAfterEventId"].as_str() {
                let effect = parse(
                    "outbox.effect",
                    row.try_get("effect_json").map_err(storage)?,
                )?;
                steer_checkpoints
                    .entry(head.to_owned())
                    .or_default()
                    .push((effect, receipt));
            }
        }
    }
    let mut state = FlowState030::new(identity);
    let mut produced = Vec::new();
    let mut work_results = BTreeSet::new();
    let mut physical_ends = Vec::new();
    let mut blocked = false;
    for (index, row) in events.iter().enumerate() {
        let event_id: String = row.try_get("event_id").map_err(storage)?;
        let result = (|| {
            let diagnostic: Option<String> = row.try_get("diagnostic_json").map_err(storage)?;
            let receipt: Option<String> = row.try_get("receipt_json").map_err(storage)?;
            let event = parse::<ReadEvent>("event", row.try_get("event_json").map_err(storage)?)?.0;
            equal("event.id", &event_id, &event.event_id)?;
            if blocked
                && !matches!(&event.kind, FlowEventKind030::Stop)
                && !(state.stopping
                    && matches!(&event.kind, FlowEventKind030::PhysicalEnded { .. }))
            {
                return Err(mismatch(
                    "event.blocked",
                    "Stop or physical proof after Stop",
                    json!(event.kind),
                ));
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
                }
            }
            // Corrupt plans can violate internal reducer assumptions. A forensic
            // executable must return a negative verdict even for such captures.
            let reduced = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                reduce(&plan, &state, &event)
            }))
            .map_err(|_| mismatch("event.reduce", "accepted transition", "reducer panic"))?;
            let transition = match reduced {
                Ok(transition) => transition,
                Err(FlowInputError030::UnspecifiedSharedCancellation {
                    closing_join,
                    affected_joins,
                }) => {
                    equal("event.receipt", &None::<String>, &receipt)?;
                    let expected = json!({"code":"UNSPECIFIED_SHARED_CANCELLATION","closingJoin":closing_join,"affectedJoins":affected_joins,"retryable":false});
                    let raw = diagnostic
                        .as_deref()
                        .ok_or_else(|| mismatch("event.diagnostic", &expected, Value::Null))?;
                    equal(
                        "event.diagnostic",
                        &expected,
                        &parse::<Value>("event.diagnostic", raw)?,
                    )?;
                    equal(
                        "diagnostic.retainedEvent",
                        &false,
                        &stored.events.contains_key(&event_id),
                    )?;
                    for effect in &outbox {
                        let producer: String = effect.try_get("event_id").map_err(storage)?;
                        if producer == event_id {
                            return Err(mismatch(
                                "diagnostic.outbox",
                                "no effect from a rejected event",
                                effect.try_get::<String, _>("effect_id").map_err(storage)?,
                            ));
                        }
                    }
                    blocked = true;
                    return Ok(());
                }
                Err(error) => {
                    return Err(mismatch(
                        "event.reduce",
                        "accepted transition or exact durable diagnostic",
                        error.to_string(),
                    ))
                }
            };
            equal("event.diagnostic", &None::<String>, &diagnostic)?;
            let receipt: FlowReceipt030 = parse(
                "event.receipt",
                receipt
                    .as_deref()
                    .ok_or_else(|| mismatch("event.receipt", "accepted event", Value::Null))?,
            )?;
            if index == 0 && request.entry.is_some() {
                equal(
                    "start.receipt.enter",
                    &Some(receipt.clone()),
                    &start_receipt.enter,
                )?;
            }
            match &event.kind {
                FlowEventKind030::WorkResult { work, .. } => {
                    work_results.insert(work.start_effect_id.clone());
                }
                FlowEventKind030::PhysicalEnded { .. } => {
                    physical_ends.push((event.clone(), state.stopping))
                }
                _ => {}
            }
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
            // Validate consumption at the actual reduce() prefix, rather than
            // inferring liveness from the final state or another scheduler.
            if let Some(deliveries) = steer_checkpoints.get(&event_id) {
                for (effect, receipt) in deliveries {
                    let FlowEffectKind030::Steer {
                        delivery_activation_id,
                        ..
                    } = &effect.kind
                    else {
                        return Err(mismatch("steer.effect", "Steer effect", &effect.kind));
                    };
                    if !steer_effect_eligible030(&state, effect)
                        || !state
                            .activations
                            .iter()
                            .any(|a| a.id == *delivery_activation_id)
                    {
                        return Err(mismatch(
                            "steer.checkpoint",
                            "delivery to a physically active work that still counts",
                            receipt,
                        ));
                    }
                }
            }
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
    for (event, stopping) in &physical_ends {
        verify_physical_end(db, event, *stopping)
            .await
            .map_err(|mut error| {
                error.event_id = Some(event.event_id.clone());
                error
            })?;
    }
    Ok(())
}

async fn verify_physical_end(
    db: &mut SqliteConnection,
    event: &FlowEvent030,
    stopping: bool,
) -> Result<()> {
    let FlowEventKind030::PhysicalEnded {
        work,
        stop_effect_id,
        evidence,
    } = &event.kind
    else {
        unreachable!("physical end list")
    };
    let id = &event.identity;
    let start = sqlx::query("SELECT status,settlement_json FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? AND effect_id=?")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&work.start_effect_id).fetch_one(&mut *db).await.map_err(storage)?;
    let status: String = start.try_get("status").map_err(storage)?;
    equal("physicalEnded.start.status", &"settled", &status.as_str())?;
    let handoff: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM engine_flow030_handoffs WHERE system_id=? AND invocation_id=? AND effect_id=?)")
        .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&work.start_effect_id).fetch_one(&mut *db).await.map_err(storage)?;
    if handoff == 0 {
        equal("physicalEnded.noAdmission.stopping", &true, &stopping)?;
        equal(
            "physicalEnded.noAdmission.eventId",
            &format!("no-admission:{}", work.start_effect_id),
            &event.event_id,
        )?;
        if stop_effect_id.is_none() {
            return Err(mismatch(
                "physicalEnded.noAdmission.stopEffectId",
                "StopWork from the native Stop",
                Value::Null,
            ));
        }
        let row = sqlx::query("SELECT owner_epoch,generation,proof_json FROM engine_flow030_no_admissions WHERE system_id=? AND invocation_id=? AND start_effect_id=?")
            .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(&work.start_effect_id).fetch_optional(&mut *db).await.map_err(storage)?
            .ok_or_else(|| mismatch("physicalEnded.start.proof", "Start handoff or native no-admission proof", Value::Null))?;
        let proof: NoAdmissionRead = parse(
            "physicalEnded.noAdmission",
            row.try_get("proof_json").map_err(storage)?,
        )?;
        equal("physicalEnded.noAdmission.identity", id, &proof.identity)?;
        equal("physicalEnded.noAdmission.work", work, &proof.work)?;
        equal(
            "physicalEnded.noAdmission.nativeReceiptId",
            &evidence.native_receipt_id,
            &proof.native_receipt_id,
        )?;
        equal(
            "physicalEnded.noAdmission.ownerEpoch",
            &row.try_get::<String, _>("owner_epoch").map_err(storage)?,
            &proof.owner_epoch,
        )?;
        equal(
            "physicalEnded.noAdmission.generation",
            &row.try_get::<String, _>("generation").map_err(storage)?,
            &proof.generation,
        )?;
        if !matches!(proof.reason.as_str(), "unclaimed" | "unreleasedNativeClaim") {
            return Err(mismatch(
                "physicalEnded.noAdmission.reason",
                "native non-admission reason",
                &proof.reason,
            ));
        }
    }
    if let Some(stop) = stop_effect_id {
        let row = sqlx::query("SELECT status,effect_json,settlement_json FROM engine_flow030_outbox WHERE system_id=? AND invocation_id=? AND effect_id=?")
            .bind(&id.system_start_id).bind(&id.flow_invocation_id).bind(stop).fetch_one(&mut *db).await.map_err(storage)?;
        let status: String = row.try_get("status").map_err(storage)?;
        let effect: FlowEffect030 = parse(
            "physicalEnded.stop.effect",
            row.try_get("effect_json").map_err(storage)?,
        )?;
        equal(
            "physicalEnded.stop.work",
            &json!(FlowEffectKind030::StopWork {
                work: work.clone(),
                include_descendants: true
            }),
            &json!(effect.kind),
        )?;
        let raw: Option<String> = row.try_get("settlement_json").map_err(storage)?;
        if handoff == 0 && matches!(status.as_str(), "pending" | "uncertain") {
            // settle_unadmitted atomically settles only Start and records this
            // PhysicalEnded. It does not claim, hand off or settle StopWork.
            // Its unchanged dispatch status is not missing physical evidence.
            equal("physicalEnded.stop.settlement", &None::<String>, &raw)?;
            // verify_settlement already rejects any handoff or settlement for
            // pending/uncertain effects. The validated native proof above is
            // mandatory; admitted work never enters this exception.
            return Ok(());
        }
        equal("physicalEnded.stop.status", &"settled", &status.as_str())?;
        let receipt: Value = parse(
            "physicalEnded.stop.settlement",
            raw.as_deref().ok_or_else(|| {
                mismatch(
                    "physicalEnded.stop.settlement",
                    "recorded stop settlement",
                    Value::Null,
                )
            })?,
        )?;
        if matches!(
            receipt["kind"].as_str(),
            Some("nativeJoinedGroupStop030" | "nativeJoinedDiagnosticStop030")
        ) {
            equal(
                "physicalEnded.stop.eventId",
                &json!(event.event_id),
                &receipt["eventId"],
            )?;
        }
        // Other stop settlements are already correlated to this exact effect
        // and handoff by verify_settlement, before physical proofs are checked.
    }
    Ok(())
}

// Receipt correlation complements the liveness check at the replayed prefix.
fn verify_steer_settlement(
    state: &FlowState030,
    effect: &FlowEffect030,
    receipt: &Value,
) -> Result<()> {
    if let FlowEffectKind030::Steer {
        work,
        delivery_activation_id,
        message_json,
        ..
    } = &effect.kind
    {
        equal("steer.work", &json!(work), &receipt["work"])?;
        equal(
            "steer.deliveryActivationId",
            &json!(delivery_activation_id),
            &receipt["deliveryActivationId"],
        )?;
        equal(
            "steer.messageJson",
            &json!(message_json),
            &receipt["messageJson"],
        )?;
        let consumed_id = receipt["consumedEventId"].as_str().ok_or_else(|| {
            mismatch(
                "steer.consumedEventId",
                "accepted consumption event",
                Value::Null,
            )
        })?;
        let consumed = state.events.get(consumed_id).ok_or_else(|| {
            mismatch(
                "steer.consumedEventId",
                "accepted consumption event",
                consumed_id,
            )
        })?;
        let event = parse::<ReadEvent>("steer.consumedEvent", &consumed.event_json)?.0;
        equal(
            "steer.consumedEvent",
            &json!(FlowEventKind030::SteerConsumed {
                effect_id: effect.id.clone(),
                work: work.clone(),
                delivery_activation_id: delivery_activation_id.clone()
            }),
            &json!(event.kind),
        )?;
        let delivery = state
            .steer_deliveries
            .iter()
            .find(|d| d.effect_id == effect.id)
            .ok_or_else(|| mismatch("steer.record", "replayed delivery", Value::Null))?;
        equal(
            "steer.consumedStatus",
            &"consumed",
            &delivery.status.as_str(),
        )?;
        equal(
            "steer.consumedRecord",
            &Some(consumed_id.to_owned()),
            &delivery.resolved_event_id,
        )?;
        let checkpoint = receipt["consumedAfterEventId"]
            .as_str()
            .and_then(|id| state.events.get(id));
        if checkpoint.is_none() {
            return Err(mismatch(
                "steer.consumedAfterEventId",
                "accepted journal checkpoint",
                &receipt["consumedAfterEventId"],
            ));
        }
        equal(
            "steer.checkpointRevision",
            &event.expected_revision,
            &checkpoint.unwrap().receipt.revision,
        )?;
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
    if let FlowEffectKind030::Steer { .. } = &effect.kind {
        if state.steer_deliveries.iter().any(|d| {
            d.effect_id == effect.id
                && d.status != "pending"
                && !(d.status == "withdrawn" && status == "uncertain")
        }) && status != "settled"
        {
            return Err(mismatch(
                "steer.resolution",
                "settled delivery resolution",
                status,
            ));
        }
    }
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
    if let FlowEffectKind030::Steer {
        work,
        delivery_activation_id,
        ..
    } = &effect.kind
    {
        let delivery = state
            .steer_deliveries
            .iter()
            .find(|d| d.effect_id == effect.id)
            .ok_or_else(|| mismatch("steer.record", "replayed delivery", Value::Null))?;
        if matches!(delivery.status.as_str(), "fallback" | "withdrawn") {
            let expected = json!({"kind":"nativeSteerSuperseded030", "effectId":effect.id,
                "deliveryActivationId":delivery_activation_id, "work":work, "eventId":delivery.resolved_event_id,
                "resolution":delivery.status, "reason":delivery.reason});
            equal("steer.superseded", &expected, &receipt)?;
            equal("steer.superseded.handoff", &false, &handoff.is_some())?;
            equal(
                "steer.superseded.noAdmission",
                &false,
                &no_admission.is_some(),
            )?;
            return Ok(());
        }
    }
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
            &json!(if matches!(&effect.kind, FlowEffectKind030::Steer { .. }) {
                "nativeSteerConsumed030"
            } else {
                "nativeOwnedHandoff030"
            }),
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
            &if matches!(&effect.kind, FlowEffectKind030::Steer { .. }) {
                Value::Null
            } else {
                json!(format!("flow030:{}:{}", id.system_start_id, effect.id))
            },
            &receipt["requestId"],
        )?;
        verify_steer_settlement(state, effect, &receipt)?;
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
