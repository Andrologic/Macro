//! Opaque persistence for the pure TS work controller. Only the authenticated
//! native broker may supply decisions; these functions are not product IPC.
//! Every effect is reserved durably before IO. Reads never authorize replay.
use super::*;

macro_rules! record {
    ($name:ident { $($field:ident: $ty:ty),* $(,)? }) => {
        #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name { $(pub $field: $ty),* }
    };
}
record!(ProtocolState030 {
    context: EngineContext,
    contract_json: String,
    state_json: String,
    revision: String,
});
record!(WorkAdmission030 {
    options_json: String,
    evidence_json: String,
});
record!(NativeCall030 {
    provider_attempt_id: String,
    native_call_id: String
});
record!(ProtocolEvent030 {
    context: EngineContext, event_id: String, expected_revision: String,
    event_json: String, native_call: Option<NativeCall030>, control: bool,
});
record!(TransitionTicket030 {
    ticket_id: String,
    input_digest: String,
    input: ProtocolEvent030,
    contract_json: String,
    state_json: String,
    stop_stamp: String,
});
record!(ProtocolEventRecord030 {
    ticket: TransitionTicket030,
    decision: Option<ProtocolDecision030>,
    committed_state: Option<ProtocolState030>,
});
record!(CheckRequest030 {
    check_id: String,
    invocation_json: String
});
record!(ProtocolDecision030 {
    state_json: String, receipt_json: String, check: Option<CheckRequest030>,
});
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum EventReservation030 {
    Pending { ticket: TransitionTicket030 },
    Committed { decision: ProtocolDecision030 },
}
record!(CheckRecord030 {
    check_id: String, event_id: String, effect: EngineEffect, claimed: bool,
    status: String, evidence_json: Option<String>, result_json: Option<String>,
});
record!(HumanRequest030 {
    owner: EngineOwner,
    request_id: String, contexts: Vec<EngineContext>, kind: String,
    payload_json: String, deadline_ms: Option<String>,
});
record!(HumanLink030 {
    operation_id: String,
    context: EngineContext,
    attached: bool,
});
record!(HumanRecord030 {
    request: HumanRequest030, revision: String, answer_json: Option<String>,
});

/// Captured permissions are also compared byte-for-byte against the initialized
/// context below; the existing engine guard checks the captured authority.
fn guard(stored: &Stored, supplied: &EngineContext, control: bool) -> Result<String> {
    context(stored, supplied)?;
    require(
        stored.snapshot.versions.contract == "agsdl-0.3.0",
        "Work protocol requires a 0.3 capture",
    )?;
    let a = activation(&stored.state, &supplied.work)?;
    require(
        a.work_state == "active",
        "Uncertain or terminal work cannot advance",
    )?;
    require(
        control
            || (matches!(a.stop_state, EngineStopState::None)
                && matches!(stored.state.stop, EngineStopState::None)),
        "Stopped work cannot advance",
    )?;
    encode(&(&a.stop_state, &stored.state.stop, &a.work_state))
}
async fn read_on(db: &mut SqliteConnection, work: &EngineWork) -> Result<ProtocolState030> {
    let row = sqlx::query("SELECT context_json,contract_json,state_json,revision FROM engine_work_protocol030 WHERE system_id=? AND activation_id=?")
        .bind(&work.system_start_id).bind(&work.activation_id).fetch_optional(&mut *db).await?
        .ok_or_else(|| failure("NOT_FOUND", "work", "Work protocol is not initialized"))?;
    let context: EngineContext = serde_json::from_str(row.get("context_json"))?;
    require(context.work == *work, "Work protocol identity differs")?;
    Ok(ProtocolState030 {
        context,
        contract_json: row.get("contract_json"),
        state_json: row.get("state_json"),
        revision: row.get("revision"),
    })
}
pub(crate) async fn read(pool: &SqlitePool, work: &EngineWork) -> Result<ProtocolState030> {
    let mut db = pool.acquire().await?;
    read_on(&mut db, work).await
}
async fn initialize_on(
    db: &mut SqliteConnection,
    supplied: &EngineContext,
    contract_json: &str,
    state_json: &str,
) -> Result<ProtocolState030> {
    let previous: Option<String> = sqlx::query_scalar("SELECT initial_state_json FROM engine_work_protocol030 WHERE system_id=? AND activation_id=?")
        .bind(&supplied.work.system_start_id).bind(&supplied.work.activation_id).fetch_optional(&mut *db).await?;
    if let Some(previous) = previous {
        let state = read_on(db, &supplied.work).await?;
        require(
            state.context == *supplied
                && state.contract_json == contract_json
                && previous == state_json,
            "Conflicting work initialization",
        )?;
    } else {
        sqlx::query("INSERT INTO engine_work_protocol030 VALUES (?,?,?,?,?,?,'0')")
            .bind(&supplied.work.system_start_id)
            .bind(&supplied.work.activation_id)
            .bind(encode(supplied)?)
            .bind(contract_json)
            .bind(state_json)
            .bind(state_json)
            .execute(&mut *db)
            .await?;
    }
    read_on(db, &supplied.work).await
}
pub(crate) async fn initialize(
    pool: &SqlitePool,
    supplied: &EngineContext,
    contract_json: &str,
    state_json: &str,
) -> Result<ProtocolState030> {
    validate_json(contract_json)?;
    validate_json(state_json)?;
    let mut db = pool.acquire().await?;
    let mut tx = durable(&mut db).await?;
    let stored = load(&mut tx, &supplied.work.system_start_id).await?;
    guard(&stored, supplied, false)?;
    let state = initialize_on(&mut tx, supplied, contract_json, state_json).await?;
    tx.commit().await?;
    Ok(state)
}

/// Called by native admission only, after authenticating the captured contract,
/// options and plan-lock evidence. SQL never derives a grant from this record.
pub(crate) async fn initialize_admitted(
    pool: &SqlitePool,
    supplied: &EngineContext,
    contract_json: &str,
    state_json: &str,
    admission: &WorkAdmission030,
) -> Result<ProtocolState030> {
    for raw in [
        contract_json,
        state_json,
        &admission.options_json,
        &admission.evidence_json,
    ] {
        validate_json(raw)?;
    }
    let mut db = pool.acquire().await?;
    let mut tx = durable(&mut db).await?;
    let stored = load(&mut tx, &supplied.work.system_start_id).await?;
    guard(&stored, supplied, false)?;
    let state = initialize_on(&mut tx, supplied, contract_json, state_json).await?;
    let prior = sqlx::query("SELECT options_json,evidence_json FROM engine_work_admission030 WHERE system_id=? AND activation_id=?")
        .bind(&supplied.work.system_start_id).bind(&supplied.work.activation_id)
        .fetch_optional(&mut *tx).await?;
    if let Some(row) = prior {
        require(
            row.get::<&str, _>("options_json") == admission.options_json
                && row.get::<&str, _>("evidence_json") == admission.evidence_json,
            "Conflicting work admission",
        )?;
    } else {
        require(
            state.revision == "0",
            "Cannot add admission to a work with prior transitions",
        )?;
        let reserved: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM engine_work_events030 WHERE system_id=? AND activation_id=?",
        )
        .bind(&supplied.work.system_start_id)
        .bind(&supplied.work.activation_id)
        .fetch_one(&mut *tx)
        .await?;
        require(
            reserved == 0,
            "Cannot add admission after an event reservation",
        )?;
        sqlx::query("INSERT INTO engine_work_admission030 VALUES (?,?,?,?)")
            .bind(&supplied.work.system_start_id)
            .bind(&supplied.work.activation_id)
            .bind(&admission.options_json)
            .bind(&admission.evidence_json)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(state)
}

pub(crate) async fn read_admission(
    pool: &SqlitePool,
    supplied: &EngineContext,
    control: bool,
) -> Result<WorkAdmission030> {
    let mut db = pool.acquire().await?;
    let mut tx = durable(&mut db).await?;
    let stored = load(&mut tx, &supplied.work.system_start_id).await?;
    guard(&stored, supplied, control)?;
    let state = read_on(&mut tx, &supplied.work).await?;
    require(state.context == *supplied, "Protocol context differs")?;
    let row = sqlx::query("SELECT options_json,evidence_json FROM engine_work_admission030 WHERE system_id=? AND activation_id=?")
        .bind(&supplied.work.system_start_id).bind(&supplied.work.activation_id)
        .fetch_optional(&mut *tx).await?
        .ok_or_else(|| failure("NOT_FOUND", "admission", "Work admission is not initialized"))?;
    let admission = WorkAdmission030 {
        options_json: row.get("options_json"),
        evidence_json: row.get("evidence_json"),
    };
    tx.commit().await?;
    Ok(admission)
}
async fn event_row(
    db: &mut SqliteConnection,
    input: &ProtocolEvent030,
) -> Result<Option<sqlx::sqlite::SqliteRow>> {
    Ok(sqlx::query("SELECT ticket_json,decision_json,committed_state_json FROM engine_work_events030 WHERE system_id=? AND event_id=?")
        .bind(&input.context.work.system_start_id).bind(&input.event_id).fetch_optional(db).await?)
}
pub(crate) async fn reserve_event(
    pool: &SqlitePool,
    input: &ProtocolEvent030,
) -> Result<EventReservation030> {
    opaque(&input.event_id)?;
    decimal(&input.expected_revision)?;
    validate_json(&input.event_json)?;
    let mut db = pool.acquire().await?;
    let mut tx = durable(&mut db).await?;
    let stored = load(&mut tx, &input.context.work.system_start_id).await?;
    let stamp = guard(&stored, &input.context, input.control)?;
    let state = read_on(&mut tx, &input.context.work).await?;
    require(state.context == input.context, "Protocol context differs")?;
    if let Some(row) = event_row(&mut tx, input).await? {
        let ticket: TransitionTicket030 = serde_json::from_str(row.get("ticket_json"))?;
        require(
            ticket.input == *input,
            "Event identity reused with different bytes",
        )?;
        let result = match row.get::<Option<&str>, _>("decision_json") {
            Some(raw) => EventReservation030::Committed {
                decision: serde_json::from_str(raw)?,
            },
            None => {
                require(
                    ticket.stop_stamp == stamp && input.expected_revision == state.revision,
                    "Pending transition was superseded",
                )?;
                EventReservation030::Pending { ticket }
            }
        };
        tx.commit().await?;
        return Ok(result);
    }
    require(
        input.expected_revision == state.revision,
        "Protocol revision changed",
    )?;
    if let Some(call) = &input.native_call {
        opaque(&call.provider_attempt_id)?;
        opaque(&call.native_call_id)?;
        let key = effect_key(&EngineEffectIdentity::Provider {
            provider_attempt_id: call.provider_attempt_id.clone(),
        })?;
        let raw: Option<String> = sqlx::query_scalar("SELECT record_json FROM engine_effects WHERE system_id=? AND activation_id=? AND effect_key=?")
            .bind(&input.context.work.system_start_id).bind(&input.context.work.activation_id).bind(key).fetch_optional(&mut *tx).await?;
        let effect: EngineEffect = serde_json::from_str(&raw.ok_or_else(|| {
            failure(
                "CORRELATION",
                "nativeCall",
                "Provider attempt is not registered",
            )
        })?)?;
        require(
            effect.context == input.context,
            "Native call belongs to another context",
        )?;
        let exists: i64 = sqlx::query_scalar("SELECT count(*) FROM engine_work_events030 WHERE system_id=? AND provider_attempt_id=? AND native_call_id=?")
            .bind(&input.context.work.system_start_id).bind(&call.provider_attempt_id).bind(&call.native_call_id).fetch_one(&mut *tx).await?;
        require(exists == 0, "Native call already belongs to another event")?;
    }
    let ticket = TransitionTicket030 {
        ticket_id: uuid::Uuid::new_v4().to_string(),
        input_digest: format!("{:x}", Sha256::digest(encode(input)?.as_bytes())),
        input: input.clone(),
        contract_json: state.contract_json,
        state_json: state.state_json,
        stop_stamp: stamp,
    };
    sqlx::query("INSERT INTO engine_work_events030 VALUES (?,?,?,?,?,?,NULL,NULL)")
        .bind(&input.context.work.system_start_id)
        .bind(&input.context.work.activation_id)
        .bind(&input.event_id)
        .bind(input.native_call.as_ref().map(|c| &c.provider_attempt_id))
        .bind(input.native_call.as_ref().map(|c| &c.native_call_id))
        .bind(encode(&ticket)?)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(EventReservation030::Pending { ticket })
}

/// Called only after the broker authenticated the TS response and matched its
/// job. Native check metadata is supplied by that broker, never by the model.
pub(crate) async fn commit_event(
    pool: &SqlitePool,
    ticket: &TransitionTicket030,
    decision: &ProtocolDecision030,
) -> Result<ProtocolState030> {
    validate_json(&decision.state_json)?;
    validate_json(&decision.receipt_json)?;
    let input = &ticket.input;
    let work = &input.context.work;
    let mut db = pool.acquire().await?;
    let mut tx = durable(&mut db).await?;
    let mut stored = load(&mut tx, &work.system_start_id).await?;
    let stamp = guard(&stored, &input.context, input.control)?;
    let row = event_row(&mut tx, input)
        .await?
        .ok_or_else(|| failure("CORRELATION", "ticket", "Transition was not reserved"))?;
    require(
        serde_json::from_str::<TransitionTicket030>(row.get("ticket_json"))? == *ticket,
        "Transition ticket differs",
    )?;
    if let Some(raw) = row.get::<Option<&str>, _>("decision_json") {
        require(
            serde_json::from_str::<ProtocolDecision030>(raw)? == *decision,
            "Committed decision has different bytes",
        )?;
        let state = serde_json::from_str(row.get("committed_state_json"))?;
        tx.commit().await?;
        return Ok(state);
    }
    let mut state = read_on(&mut tx, work).await?;
    require(
        state.context == input.context
            && state.revision == input.expected_revision
            && state.state_json == ticket.state_json
            && state.contract_json == ticket.contract_json
            && stamp == ticket.stop_stamp,
        "Transition lost its revision or admission",
    )?;
    if let Some(check) = &decision.check {
        require(!input.control, "Control events cannot launch checks")?;
        opaque(&check.check_id)?;
        validate_json(&check.invocation_json)?;
        let effect = EngineEffect {
            context: input.context.clone(),
            effect: EngineEffectIdentity::Tool {
                tool_invocation_id: format!("check030:{}", uuid::Uuid::new_v4()),
                provider_attempt_id: None,
            },
            invocation_json: check.invocation_json.clone(),
        };
        let existing: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM engine_work_checks030 WHERE system_id=? AND check_id=?",
        )
        .bind(&work.system_start_id)
        .bind(&check.check_id)
        .fetch_one(&mut *tx)
        .await?;
        require(existing == 0, "Check identity already reserved")?;
        require(
            register_effect_on(&mut tx, &mut stored, effect.clone()).await?,
            "Check effect already exists",
        )?;
        sqlx::query("INSERT INTO engine_work_checks030 VALUES (?,?,?,?,?,0,NULL,NULL)")
            .bind(&work.system_start_id)
            .bind(&check.check_id)
            .bind(&work.activation_id)
            .bind(&input.event_id)
            .bind(effect_key(&effect.effect)?)
            .execute(&mut *tx)
            .await?;
    }
    state.revision = next(&state.revision);
    state.state_json = decision.state_json.clone();
    let updated = sqlx::query("UPDATE engine_work_protocol030 SET state_json=?,revision=? WHERE system_id=? AND activation_id=? AND revision=?")
        .bind(&state.state_json).bind(&state.revision).bind(&work.system_start_id).bind(&work.activation_id).bind(&input.expected_revision)
        .execute(&mut *tx).await?.rows_affected();
    require(updated == 1, "Protocol CAS failed")?;
    sqlx::query("UPDATE engine_work_events030 SET decision_json=?,committed_state_json=? WHERE system_id=? AND event_id=?")
        .bind(encode(decision)?).bind(encode(&state)?).bind(&work.system_start_id).bind(&input.event_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(state)
}

async fn check_on(
    db: &mut SqliteConnection,
    supplied: &EngineContext,
    check_id: &str,
) -> Result<CheckRecord030> {
    let row = sqlx::query("SELECT c.check_id,c.event_id,c.claimed,c.evidence_json,c.result_json,e.record_json,e.status FROM engine_work_checks030 c JOIN engine_effects e ON e.system_id=c.system_id AND e.effect_key=c.effect_key WHERE c.system_id=? AND c.check_id=?")
        .bind(&supplied.work.system_start_id).bind(check_id).fetch_optional(db).await?
        .ok_or_else(|| failure("NOT_FOUND", "check", "Check is not reserved"))?;
    let effect: EngineEffect = serde_json::from_str(row.get("record_json"))?;
    require(effect.context == *supplied, "Check attribution differs")?;
    Ok(CheckRecord030 {
        check_id: row.get("check_id"),
        event_id: row.get("event_id"),
        effect,
        claimed: row.get("claimed"),
        status: row.get("status"),
        evidence_json: row.get("evidence_json"),
        result_json: row.get("result_json"),
    })
}
/// The native admission gate must span this claim and the physical dispatch.
/// A lost return consumes the claim: uncertainty is safer than repeating IO.
pub(crate) async fn claim_check(
    pool: &SqlitePool,
    supplied: &EngineContext,
    check_id: &str,
) -> Result<EngineEffect> {
    let mut db = pool.acquire().await?;
    let mut tx = durable(&mut db).await?;
    let stored = load(&mut tx, &supplied.work.system_start_id).await?;
    guard(&stored, supplied, false)?;
    let check = check_on(&mut tx, supplied, check_id).await?;
    require(
        !check.claimed && check.status == "pending",
        "Check may have run; replay is forbidden",
    )?;
    sqlx::query("UPDATE engine_work_checks030 SET claimed=1 WHERE system_id=? AND check_id=?")
        .bind(&supplied.work.system_start_id)
        .bind(check_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(check.effect)
}
/// Native physical end evidence only. Stops permit recording completion, while
/// retired epochs use the existing engine recovery authority instead.
pub(crate) async fn finish_check(
    pool: &SqlitePool,
    supplied: &EngineContext,
    check_id: &str,
    evidence_json: &str,
    result_json: &str,
) -> Result<()> {
    validate_json(evidence_json)?;
    validate_json(result_json)?;
    let mut db = pool.acquire().await?;
    let mut tx = durable(&mut db).await?;
    let mut stored = load(&mut tx, &supplied.work.system_start_id).await?;
    context(&stored, supplied)?;
    let check = check_on(&mut tx, supplied, check_id).await?;
    require(check.claimed, "Unclaimed check cannot finish")?;
    if let Some(previous) = check.evidence_json {
        require(
            previous == evidence_json && check.result_json.as_deref() == Some(result_json),
            "Conflicting check receipt",
        )?;
    } else {
        require(
            check.status == "pending",
            "Uncertain check requires native recovery",
        )?;
        let settlement = EngineSettlement {
            context: supplied.clone(),
            effect: check.effect.effect.clone(),
            status: "ended".into(),
            evidence_json: evidence_json.into(),
        };
        sqlx::query("UPDATE engine_effects SET status='ended',settlement_json=?,result_json=? WHERE system_id=? AND effect_key=?")
            .bind(encode(&settlement)?).bind(result_json).bind(&supplied.work.system_start_id).bind(effect_key(&check.effect.effect)?)
            .execute(&mut *tx).await?;
        sqlx::query("UPDATE engine_work_checks030 SET evidence_json=?,result_json=? WHERE system_id=? AND check_id=?")
            .bind(evidence_json).bind(result_json).bind(&supplied.work.system_start_id).bind(check_id).execute(&mut *tx).await?;
        event(
            &mut tx,
            &mut stored.state,
            &supplied.work.system_start_id,
            Some(supplied.work.clone()),
            "effect",
            encode(&settlement)?,
        )
        .await?;
        save(&mut tx, &supplied.work.system_start_id, &stored.state).await?;
    }
    tx.commit().await?;
    Ok(())
}
pub(crate) async fn read_checks(
    pool: &SqlitePool,
    work: &EngineWork,
) -> Result<Vec<CheckRecord030>> {
    let mut tx = pool.begin().await?;
    let state = read_on(&mut tx, work).await?;
    let ids: Vec<String> = sqlx::query_scalar("SELECT check_id FROM engine_work_checks030 WHERE system_id=? AND activation_id=? ORDER BY rowid")
        .bind(&work.system_start_id).bind(&work.activation_id).fetch_all(&mut *tx).await?;
    let mut checks = Vec::new();
    for id in ids {
        checks.push(check_on(&mut tx, &state.context, &id).await?);
    }
    tx.commit().await?;
    Ok(checks)
}

fn human_system(request: &HumanRequest030) -> Result<&str> {
    opaque(&request.request_id)?;
    opaque(&request.kind)?;
    validate_json(&request.payload_json)?;
    if let Some(deadline) = &request.deadline_ms {
        decimal(deadline)?;
    }
    opaque(&request.owner.system_start_id)?;
    decimal(&request.owner.owner_epoch)?;
    let mut works = BTreeSet::new();
    for supplied in &request.contexts {
        require(
            supplied.owner == request.owner
                && supplied.work.system_start_id == request.owner.system_start_id
                && works.insert(&supplied.work.activation_id),
            "Human request has foreign or repeated works",
        )?;
    }
    Ok(&request.owner.system_start_id)
}
async fn human_guard(db: &mut SqliteConnection, request: &HumanRequest030) -> Result<()> {
    let stored = load(db, human_system(request)?).await?;
    owner(
        &stored.state,
        &request.owner,
        &request.owner.system_start_id,
    )?;
    require(
        stored.snapshot.versions.contract == "agsdl-0.3.0",
        "Human request requires a 0.3 capture",
    )?;
    for supplied in &request.contexts {
        guard(&stored, supplied, false)?;
        require(
            read_on(db, &supplied.work).await?.context == *supplied,
            "Human request attribution differs",
        )?;
    }
    Ok(())
}
async fn human_row(
    db: &mut SqliteConnection,
    system: &str,
    id: &str,
) -> Result<Option<HumanRecord030>> {
    let row = sqlx::query("SELECT request_json,revision,answer_json FROM engine_human_requests030 WHERE system_id=? AND request_id=?")
        .bind(system).bind(id).fetch_optional(db).await?;
    row.map(|row| {
        Ok(HumanRecord030 {
            request: serde_json::from_str(row.get("request_json"))?,
            revision: row.get("revision"),
            answer_json: row.get("answer_json"),
        })
    })
    .transpose()
}
pub(crate) async fn open_human(
    pool: &SqlitePool,
    request: &HumanRequest030,
) -> Result<HumanRecord030> {
    let system = human_system(request)?;
    let mut db = pool.acquire().await?;
    let mut tx = durable(&mut db).await?;
    let stored = load(&mut tx, system).await?;
    owner(&stored.state, &request.owner, system)?;
    if let Some(previous) = human_row(&mut tx, system, &request.request_id).await? {
        require(
            previous.request == *request,
            "Human request identity reused",
        )?;
        tx.commit().await?;
        return Ok(previous);
    }
    human_guard(&mut tx, request).await?;
    sqlx::query("INSERT INTO engine_human_requests030 VALUES (?,?,?,'0',NULL)")
        .bind(system)
        .bind(&request.request_id)
        .bind(encode(request)?)
        .execute(&mut *tx)
        .await?;
    for supplied in &request.contexts {
        sqlx::query("INSERT INTO engine_human_works030 VALUES (?,?,?)")
            .bind(system)
            .bind(&request.request_id)
            .bind(&supplied.work.activation_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(HumanRecord030 {
        request: request.clone(),
        revision: "0".into(),
        answer_json: None,
    })
}
pub(crate) async fn resolve_human(
    pool: &SqlitePool,
    request: &HumanRequest030,
    expected_revision: &str,
    answer_json: &str,
) -> Result<HumanRecord030> {
    let system = human_system(request)?;
    decimal(expected_revision)?;
    validate_json(answer_json)?;
    let mut db = pool.acquire().await?;
    let mut tx = durable(&mut db).await?;
    let stored = load(&mut tx, system).await?;
    owner(&stored.state, &request.owner, system)?;
    let mut previous = human_row(&mut tx, system, &request.request_id)
        .await?
        .ok_or_else(|| failure("NOT_FOUND", "request", "Human request is not open"))?;
    require(
        previous.request == *request && expected_revision == "0",
        "Human request attribution or revision differs",
    )?;
    if let Some(answer) = &previous.answer_json {
        require(
            answer == answer_json,
            "Human request already resolved differently",
        )?;
    } else {
        let updated = sqlx::query("UPDATE engine_human_requests030 SET revision='1',answer_json=? WHERE system_id=? AND request_id=? AND revision=?")
            .bind(answer_json).bind(system).bind(&request.request_id).bind(expected_revision).execute(&mut *tx).await?.rows_affected();
        require(updated == 1, "Human request CAS failed")?;
        previous.revision = "1".into();
        previous.answer_json = Some(answer_json.into());
    }
    tx.commit().await?;
    Ok(previous)
}
/// Update which works are currently waiting. Operation IDs are durable and
/// single-use, including after a detach followed by a later reattachment.
pub(crate) async fn set_human_link(
    pool: &SqlitePool,
    request: &HumanRequest030,
    update: &HumanLink030,
) -> Result<()> {
    let system = human_system(request)?;
    opaque(&update.operation_id)?;
    require(
        update.context.owner == request.owner && update.context.work.system_start_id == system,
        "Human link belongs to another owner",
    )?;
    let mut db = pool.acquire().await?;
    let mut tx = durable(&mut db).await?;
    let stored = load(&mut tx, system).await?;
    owner(&stored.state, &request.owner, system)?;
    let previous = human_row(&mut tx, system, &request.request_id)
        .await?
        .ok_or_else(|| failure("NOT_FOUND", "request", "Human request is not open"))?;
    require(
        previous.request == *request,
        "Human request identity differs",
    )?;
    let existing: Option<(String, String)> = sqlx::query_as("SELECT request_id,operation_json FROM engine_human_link_events030 WHERE system_id=? AND operation_id=?")
        .bind(system).bind(&update.operation_id).fetch_optional(&mut *tx).await?;
    let raw = encode(update)?;
    if let Some((request_id, operation)) = existing {
        require(
            request_id == request.request_id && operation == raw,
            "Human link operation identity reused",
        )?;
        tx.commit().await?;
        return Ok(());
    }
    require(
        previous.answer_json.is_none(),
        "Resolved human request cannot change its works",
    )?;
    require(
        read_on(&mut tx, &update.context.work).await?.context == update.context,
        "Human link attribution differs",
    )?;
    // Attaching requires active work. Detaching an ended or stopped work is a
    // factual observation, not authority to restart that work.
    if update.attached {
        guard(&stored, &update.context, false)?;
    }
    if update.attached {
        sqlx::query("INSERT OR IGNORE INTO engine_human_works030 VALUES (?,?,?)")
            .bind(system)
            .bind(&request.request_id)
            .bind(&update.context.work.activation_id)
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query("DELETE FROM engine_human_works030 WHERE system_id=? AND request_id=? AND activation_id=?")
            .bind(system).bind(&request.request_id).bind(&update.context.work.activation_id).execute(&mut *tx).await?;
    }
    sqlx::query("INSERT INTO engine_human_link_events030 VALUES (?,?,?,?)")
        .bind(system)
        .bind(&update.operation_id)
        .bind(&request.request_id)
        .bind(raw)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Private broker recovery also includes requests with no currently linked work.
pub(crate) async fn pending_humans(pool: &SqlitePool, system: &str) -> Result<Vec<HumanRecord030>> {
    opaque(system)?;
    let mut tx = pool.begin().await?;
    load(&mut tx, system).await?;
    let ids: Vec<String> = sqlx::query_scalar("SELECT request_id FROM engine_human_requests030 WHERE system_id=? AND revision='0' ORDER BY rowid")
        .bind(system).fetch_all(&mut *tx).await?;
    let mut requests = Vec::new();
    for id in ids {
        requests.push(
            human_row(&mut tx, system, &id)
                .await?
                .ok_or_else(|| failure("STORAGE", "request", "Human request disappeared"))?,
        );
    }
    tx.commit().await?;
    Ok(requests)
}

/// The broker uses these current links to determine whose clock is paused.
pub(crate) async fn read_human_links(
    pool: &SqlitePool,
    system: &str,
    request_id: &str,
) -> Result<Vec<EngineContext>> {
    opaque(system)?;
    opaque(request_id)?;
    let mut tx = pool.begin().await?;
    require(
        human_row(&mut tx, system, request_id).await?.is_some(),
        "Human request does not exist",
    )?;
    let rows: Vec<String> = sqlx::query_scalar("SELECT p.context_json FROM engine_human_works030 w JOIN engine_work_protocol030 p ON p.system_id=w.system_id AND p.activation_id=w.activation_id WHERE w.system_id=? AND w.request_id=? ORDER BY w.rowid")
        .bind(system).bind(request_id).fetch_all(&mut *tx).await?;
    let contexts = rows
        .into_iter()
        .map(|row| serde_json::from_str(&row).map_err(Into::into))
        .collect::<Result<Vec<_>>>()?;
    tx.commit().await?;
    Ok(contexts)
}

pub(crate) async fn read_humans(
    pool: &SqlitePool,
    work: &EngineWork,
) -> Result<Vec<HumanRecord030>> {
    let mut tx = pool.begin().await?;
    read_on(&mut tx, work).await?;
    let ids: Vec<String> = sqlx::query_scalar("SELECT request_id FROM engine_human_works030 WHERE system_id=? AND activation_id=? ORDER BY rowid")
        .bind(&work.system_start_id).bind(&work.activation_id).fetch_all(&mut *tx).await?;
    let mut requests = Vec::new();
    for id in ids {
        requests.push(
            human_row(&mut tx, &work.system_start_id, &id)
                .await?
                .ok_or_else(|| failure("STORAGE", "request", "Human request link is broken"))?,
        );
    }
    tx.commit().await?;
    Ok(requests)
}

/// Private history only. Includes unfinished reservations after an epoch loss;
/// neither an old ticket nor a committed receipt authorizes physical replay.
pub(crate) async fn read_protocol_events(
    pool: &SqlitePool,
    work: &EngineWork,
) -> Result<Vec<ProtocolEventRecord030>> {
    let mut tx = pool.begin().await?;
    read_on(&mut tx, work).await?;
    let rows = sqlx::query("SELECT ticket_json,decision_json,committed_state_json FROM engine_work_events030 WHERE system_id=? AND activation_id=? ORDER BY rowid")
        .bind(&work.system_start_id).bind(&work.activation_id).fetch_all(&mut *tx).await?;
    let records = rows
        .into_iter()
        .map(|row| {
            Ok(ProtocolEventRecord030 {
                ticket: serde_json::from_str(row.get("ticket_json"))?,
                decision: row
                    .get::<Option<&str>, _>("decision_json")
                    .map(serde_json::from_str)
                    .transpose()?,
                committed_state: row
                    .get::<Option<&str>, _>("committed_state_json")
                    .map(serde_json::from_str)
                    .transpose()?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    tx.commit().await?;
    Ok(records)
}
