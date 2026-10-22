//! Native transactional repository. No runtime mutator is exposed through IPC.
//! The future native supervisor owns CaptureAuthority, RouteAuthority and epochs.
pub(crate) mod approvals;
pub(crate) mod capture;
pub(crate) mod card_associations;
pub(crate) mod diagnostics;
pub(crate) mod discovery;
pub mod dto;
pub(crate) mod inspection;
pub(crate) mod intents;
pub(crate) mod prepared;
pub(crate) mod process_recovery;
pub(crate) mod public;
pub(crate) mod responses;
use super::exact_json::{equal_optional, record_equal};
use dto::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row, Sqlite, SqliteConnection, SqlitePool, Transaction};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) type Result<T> = std::result::Result<T, EngineFailure>;
impl From<sqlx::Error> for EngineFailure {
    fn from(_: sqlx::Error) -> Self {
        failure("STORAGE", "", "Execution storage operation failed")
    }
}
impl From<serde_json::Error> for EngineFailure {
    fn from(_: serde_json::Error) -> Self {
        failure("CORRELATION", "", "Invalid execution data")
    }
}
pub(crate) fn failure(code: &str, pointer: &str, message: &str) -> EngineFailure {
    EngineFailure {
        code: code.into(),
        pointer: pointer.into(),
        message: message.into(),
        work: None,
    }
}
fn require(ok: bool, message: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(failure("CORRELATION", "", message))
    }
}
fn opaque(value: &str) -> Result<()> {
    require(
        !value.trim().is_empty() && value.len() <= 512 && !value.chars().any(char::is_control),
        "Invalid execution identity",
    )
}
fn decimal(value: &str) -> Result<()> {
    require(
        !value.is_empty()
            && value.bytes().all(|b| b.is_ascii_digit())
            && (value == "0" || !value.starts_with('0')),
        "Invalid decimal sequence",
    )
}
fn order(a: &str, b: &str) -> std::cmp::Ordering {
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}
fn next(value: &str) -> String {
    let mut bytes = value.as_bytes().to_vec();
    for b in bytes.iter_mut().rev() {
        if *b < b'9' {
            *b += 1;
            return String::from_utf8(bytes).expect("decimal");
        }
        *b = b'0';
    }
    bytes.insert(0, b'1');
    String::from_utf8(bytes).expect("decimal")
}
fn encode<T: Serialize>(value: &T) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}
pub(crate) fn validate_json(value: &str) -> Result<()> {
    super::exact_json::validate(value)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct StepPolicy {
    pub step: Vec<String>,
    pub agent_name: Option<String>,
    pub max_visits: Option<String>,
}
/// Constructed by the native trusted compiler, never deserialized from product IPC.
/// The authority exports only approved catalog/settings fields, excluding provider
/// credentials before constructing this value. Authored JSON and bindings stay exact;
/// property names cannot determine whether a value came from secure Macro settings.
pub(crate) struct TrustedCapture {
    pub snapshot: EngineSnapshot,
    pub private: capture::PrivateCapture,
    pub policies: Vec<StepPolicy>,
    pub entry_step: Option<Vec<String>>,
}
pub(crate) trait CaptureAuthority {
    type CommitGuard;
    /// Read canonical source, compile it and capture approved public configuration.
    /// Never serialize ProviderConfig wholesale or load provider secrets into this
    /// snapshot. Credential exclusion is a typed catalog boundary, not a scan of
    /// arbitrary authored property names. A host without that boundary cannot start.
    async fn capture(
        &self,
        request: &EngineStartRequest,
        system_id: &str,
    ) -> Result<TrustedCapture>;
    /// Compare the canonical metadata owner/revision/source again after compilation.
    async fn recheck(&self, request: &EngineStartRequest) -> Result<Self::CommitGuard>;
}
/// Reuse the exact compiler/completion rules, never let outgoing DTOs grant routes.
pub(crate) trait RouteAuthority {
    fn outgoing(
        &self,
        snapshot: &EngineSnapshot,
        work: &EngineWork,
        outcome: &EngineOutcome,
    ) -> Result<Vec<EngineDelivery>>;
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct AgentState {
    id: String,
    memory: Option<EngineMemory>,
    next_queue: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct State {
    epoch: String,
    invocation_id: String,
    cursor: String,
    stop: EngineStopState,
    agents: BTreeMap<String, AgentState>,
    activations: BTreeMap<String, EngineActivation>,
    visits: BTreeMap<String, String>,
    terminals: BTreeMap<String, EngineTerminalCommit>,
    closed_responses: BTreeMap<String, String>,
    #[serde(default)]
    rejected: BTreeMap<String, String>,
}
struct Stored {
    capture: Option<capture::PrivateCapture>,
    snapshot: EngineSnapshot,
    policies: Vec<StepPolicy>,
    state: State,
}
async fn load(db: &mut SqliteConnection, id: &str) -> Result<Stored> {
    opaque(id)?;
    let row = sqlx::query(
        "SELECT snapshot_json, policies_json, state_json FROM engine_systems WHERE system_id = ?",
    )
    .bind(id)
    .fetch_optional(&mut *db)
    .await?
    .ok_or_else(|| failure("NOT_FOUND", "systemStartId", "Execution system not found"))?;
    let private: Option<String> =
        sqlx::query_scalar("SELECT registry_json FROM engine_host_captures WHERE system_id = ?")
            .bind(id)
            .fetch_optional(&mut *db)
            .await?;
    Ok(Stored {
        capture: private.map(|raw| serde_json::from_str(&raw)).transpose()?,
        snapshot: serde_json::from_str(row.get("snapshot_json"))?,
        policies: serde_json::from_str(row.get("policies_json"))?,
        state: serde_json::from_str(row.get("state_json"))?,
    })
}
async fn save(db: &mut SqliteConnection, id: &str, state: &State) -> Result<()> {
    sqlx::query("UPDATE engine_systems SET state_json = ? WHERE system_id = ?")
        .bind(encode(state)?)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}
async fn durable(db: &mut SqliteConnection) -> Result<Transaction<'_, Sqlite>> {
    // Leave FULL on this pooled connection even on early errors. Resetting it
    // after a failed transaction could silently weaken the next acknowledgement.
    sqlx::query("PRAGMA synchronous = FULL")
        .execute(&mut *db)
        .await?;
    Ok(db.begin_with("BEGIN IMMEDIATE").await?)
}
fn owner(state: &State, supplied: &EngineOwner, id: &str) -> Result<()> {
    require(
        supplied.system_start_id == id && supplied.owner_epoch == state.epoch,
        "Runtime epoch does not match",
    )
}
fn activation<'a>(state: &'a State, work: &EngineWork) -> Result<&'a EngineActivation> {
    let activation = state
        .activations
        .get(&work.activation_id)
        .ok_or_else(|| failure("CORRELATION", "work", "Unknown activation"))?;
    require(
        activation.delivery.delivery.work == *work,
        "Activation identity does not match",
    )?;
    Ok(activation)
}
fn live(state: &State, supplied: &EngineOwner, work: &EngineWork) -> Result<()> {
    owner(state, supplied, &work.system_start_id)?;
    let a = activation(state, work)?;
    require(
        (a.work_state == "active" || a.work_state == "uncertain")
            && a.admitted_epoch.as_deref() == Some(&state.epoch),
        "Work was not admitted by this epoch",
    )
}
async fn event(
    db: &mut SqliteConnection,
    state: &mut State,
    id: &str,
    work: Option<EngineWork>,
    kind: &str,
    payload: String,
) -> Result<()> {
    state.cursor = next(&state.cursor);
    let event = EngineEvent {
        system_start_id: id.into(),
        sequence: state.cursor.clone(),
        work,
        kind: kind.into(),
        payload_json: payload,
    };
    sqlx::query("INSERT INTO engine_events VALUES (?, ?, ?)")
        .bind(id)
        .bind(&state.cursor)
        .bind(encode(&event)?)
        .execute(db)
        .await?;
    Ok(())
}
fn policy<'a>(stored: &'a Stored, work: &EngineWork) -> Result<Option<&'a StepPolicy>> {
    match &work.step {
        Some(step) => Ok(Some(
            stored
                .policies
                .iter()
                .find(|p| p.step == *step)
                .ok_or_else(|| failure("CORRELATION", "work.step", "Step absent from snapshot"))?,
        )),
        None => Ok(None),
    }
}
fn validate_work(stored: &Stored, work: &EngineWork) -> Result<()> {
    for id in [
        &work.system_start_id,
        &work.flow_invocation_id,
        &work.activation_id,
    ] {
        opaque(id)?;
    }
    require(
        work.system_start_id == stored.snapshot.system_start_id,
        "Delivery belongs to another system",
    )?;
    if let Some(step) = &work.step {
        require(!step.is_empty(), "Step address is empty")?;
        for part in step {
            opaque(part)?;
        }
    }
    let expected = match policy(stored, work)? {
        Some(p) => p
            .agent_name
            .as_ref()
            .and_then(|name| stored.state.agents.get(name))
            .map(|a| a.id.as_str()),
        None => work
            .agent_instance_id
            .as_deref()
            .filter(|id| stored.state.agents.values().any(|a| a.id == *id)),
    };
    require(
        expected == work.agent_instance_id.as_deref()
            && (work.step.is_some() || expected.is_some()),
        "Agent instance does not match snapshot",
    )
}
async fn accept(
    db: &mut SqliteConnection,
    stored: &mut Stored,
    delivery: EngineDelivery,
    link: Option<&intents::IntentAdmissionLink>,
) -> Result<EngineAcceptedDelivery> {
    intents::reserve_delivery(db, &delivery, stored, link).await?;
    opaque(&delivery.delivery_id)?;
    validate_work(stored, &delivery.work)?;
    validate_json(&delivery.input.value_json)?;
    require(
        ["entry", "prepare", "agent", "call", "error"].contains(&delivery.input.origin.as_str()),
        "Unsupported delivery origin",
    )?;
    if let Some(raw) = sqlx::query_scalar::<_, String>(
        "SELECT receipt_json FROM engine_deliveries WHERE delivery_id = ?",
    )
    .bind(&delivery.delivery_id)
    .fetch_optional(&mut *db)
    .await?
    {
        let retained: EngineAcceptedDelivery = serde_json::from_str(&raw)?;
        require(
            record_equal(&retained.delivery, &delivery)?,
            "Conflicting delivery retransmission",
        )?;
        return Ok(retained);
    }
    // Stop closes new admission, but never hides a receipt already committed.
    // Public/runtime callers authenticate the epoch before reaching this lookup.
    require(
        matches!(stored.state.stop, EngineStopState::None),
        "System admission is closed",
    )?;
    require(
        !stored
            .state
            .activations
            .contains_key(&delivery.work.activation_id),
        "Activation already exists",
    )?;
    let queue_sequence = if let Some(id) = &delivery.work.agent_instance_id {
        let agent = stored
            .state
            .agents
            .values_mut()
            .find(|a| &a.id == id)
            .expect("validated agent");
        agent.next_queue = next(&agent.next_queue);
        agent.next_queue.clone()
    } else {
        next(&stored.state.cursor)
    };
    let accepted = EngineAcceptedDelivery {
        delivery,
        queue_sequence,
    };
    sqlx::query("INSERT INTO engine_deliveries VALUES (?, ?, ?, ?)")
        .bind(&accepted.delivery.delivery_id)
        .bind(&accepted.delivery.work.activation_id)
        .bind(&stored.snapshot.system_start_id)
        .bind(encode(&accepted)?)
        .execute(&mut *db)
        .await?;
    stored.state.activations.insert(
        accepted.delivery.work.activation_id.clone(),
        EngineActivation {
            delivery: accepted.clone(),
            work_state: "queued".into(),
            stop_state: EngineStopState::None,
            admitted_epoch: None,
            terminal: None,
        },
    );
    event(
        db,
        &mut stored.state,
        &stored.snapshot.system_start_id,
        Some(accepted.delivery.work.clone()),
        "accepted",
        encode(&accepted)?,
    )
    .await?;
    Ok(accepted)
}

pub(crate) async fn start(
    pool: &SqlitePool,
    request: EngineStartRequest,
    authority: &impl CaptureAuthority,
) -> Result<EngineStartReceipt> {
    start_linked(pool, request, authority, None).await
}
pub(crate) async fn start_linked(
    pool: &SqlitePool,
    request: EngineStartRequest,
    authority: &impl CaptureAuthority,
    link: Option<&intents::IntentAdmissionLink>,
) -> Result<EngineStartReceipt> {
    opaque(&request.request_id)?;
    decimal(&request.source.revision)?;
    let request_json = encode(&request)?;
    let mut connection = pool.acquire().await?;
    let mut lookup = durable(&mut connection).await?;
    intents::reserve_start(&mut lookup, &request, link).await?;
    // Retry a committed start without recompiling or consulting edited metadata.
    if let Some(row) = sqlx::query(
        "SELECT request_json, snapshot_json, state_json FROM engine_systems WHERE request_id = ?",
    )
    .bind(&request.request_id)
    .fetch_optional(&mut *lookup)
    .await?
    {
        require(
            record_equal(
                &serde_json::from_str::<EngineStartRequest>(row.get("request_json"))?,
                &request,
            )?,
            "Conflicting start retransmission",
        )?;
        let snapshot: EngineSnapshot = serde_json::from_str(row.get("snapshot_json"))?;
        let state: State = serde_json::from_str(row.get("state_json"))?;
        if let Some(link) = link {
            intents::attach(&mut lookup, link, &snapshot.system_start_id).await?;
        }
        lookup.commit().await?;
        return Ok(EngineStartReceipt {
            system_start_id: snapshot.system_start_id.clone(),
            flow_invocation_id: state.invocation_id,
            snapshot,
        });
    }
    lookup.commit().await?;
    drop(connection);
    let id = uuid::Uuid::new_v4().to_string();
    let capture = authority.capture(&request, &id).await?;
    let snapshot = capture.snapshot;
    require(
        snapshot.system_start_id == id
            && snapshot.source == request.source
            && snapshot.associations == request.associations
            && snapshot.versions.profile == request.profile,
        "Capture correlation mismatch",
    )?;
    require(
        snapshot.versions.snapshot == "1"
            && snapshot.versions.contract == "agsdl-0.2.0"
            && snapshot.versions.profile == "macro-serial-inline-v1",
        "Unsupported execution version",
    )?;
    require(
        format!("{:x}", Sha256::digest(snapshot.authored_source.as_bytes()))
            == snapshot.source.source_sha256,
        "Source SHA mismatch",
    )?;
    for version in [
        &snapshot.versions.compiler,
        &snapshot.versions.runtime,
        &snapshot.versions.registry,
    ] {
        opaque(version)?;
    }
    for identity in [
        &snapshot.source.owner.project_id,
        &snapshot.source.owner.plan_id,
        &snapshot.source.owner.branch,
    ] {
        opaque(identity)?;
    }
    validate_json(&snapshot.authored_source)?;
    validate_json(&snapshot.compiled_plan_json)?;
    let invocation_id = uuid::Uuid::new_v4().to_string();
    let mut state = State {
        epoch: "0".into(),
        invocation_id: invocation_id.clone(),
        cursor: "0".into(),
        stop: EngineStopState::None,
        agents: BTreeMap::new(),
        activations: BTreeMap::new(),
        visits: BTreeMap::new(),
        terminals: BTreeMap::new(),
        closed_responses: BTreeMap::new(),
        rejected: BTreeMap::new(),
    };
    for config in &snapshot.agents {
        opaque(&config.agent_name)?;
        opaque(&config.configuration_name)?;
        opaque(&config.provider_id)?;
        opaque(&config.model_id)?;
        for json in [
            &config.configuration_json,
            &config.settings_json,
            &config.permissions_json,
            &config.scope_json,
        ] {
            validate_json(json)?;
        }
        require(
            !state.agents.contains_key(&config.agent_name),
            "Repeated agent name",
        )?;
        state.agents.insert(
            config.agent_name.clone(),
            AgentState {
                id: uuid::Uuid::new_v4().to_string(),
                memory: None,
                next_queue: "0".into(),
            },
        );
    }
    let mut steps = BTreeSet::new();
    for p in &capture.policies {
        require(
            !p.step.is_empty() && steps.insert(p.step.clone()),
            "Repeated or empty compiled step",
        )?;
        for part in &p.step {
            opaque(part)?;
        }
        if let Some(max) = &p.max_visits {
            decimal(max)?;
            require(max != "0", "Visit limit must be positive")?;
        }
        if let Some(name) = &p.agent_name {
            require(
                state.agents.contains_key(name),
                "Step references unknown agent",
            )?;
        }
    }
    capture::validate(&capture.private, &snapshot, &capture.policies)?;
    let mut stored = Stored {
        capture: Some(capture.private),
        snapshot,
        policies: capture.policies,
        state,
    };
    // Acquire metadata locks before SQLite, matching the editor's lock order.
    // The guard keeps the final canonical revision stable through the SQL commit.
    let _capture_guard = authority.recheck(&request).await?;
    let mut connection = pool.acquire().await?;
    let mut tx = durable(&mut connection).await?;
    intents::reserve_start(&mut tx, &request, link).await?;
    if let Some(row) = sqlx::query(
        "SELECT request_json, snapshot_json, state_json FROM engine_systems WHERE request_id = ?",
    )
    .bind(&request.request_id)
    .fetch_optional(&mut *tx)
    .await?
    {
        require(
            record_equal(
                &serde_json::from_str::<EngineStartRequest>(row.get("request_json"))?,
                &request,
            )?,
            "Conflicting start retransmission",
        )?;
        let snapshot: EngineSnapshot = serde_json::from_str(row.get("snapshot_json"))?;
        let state: State = serde_json::from_str(row.get("state_json"))?;
        if let Some(link) = link {
            intents::attach(&mut tx, link, &snapshot.system_start_id).await?;
        }
        tx.commit().await?;
        return Ok(EngineStartReceipt {
            system_start_id: snapshot.system_start_id.clone(),
            flow_invocation_id: state.invocation_id,
            snapshot,
        });
    }
    sqlx::query("INSERT INTO engine_systems VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&request.request_id)
        .bind(&request_json)
        .bind(encode(&stored.snapshot)?)
        .bind(encode(&stored.policies)?)
        .bind(encode(&stored.state)?)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO engine_host_captures VALUES (?, ?)")
        .bind(&id)
        .bind(encode(stored.capture.as_ref().expect("validated capture"))?)
        .execute(&mut *tx)
        .await?;
    if let Some(entry) = request.entry {
        validate_json(&entry.message_json)?;
        let step = capture
            .entry_step
            .ok_or_else(|| failure("CORRELATION", "entry", "Entry step is absent"))?;
        let p = stored
            .policies
            .iter()
            .find(|p| p.step == step)
            .ok_or_else(|| failure("CORRELATION", "entry", "Entry step is unknown"))?;
        let agent_instance_id = p
            .agent_name
            .as_ref()
            .map(|name| stored.state.agents[name].id.clone());
        accept(
            &mut tx,
            &mut stored,
            EngineDelivery {
                delivery_id: entry.delivery_id,
                work: EngineWork {
                    system_start_id: id.clone(),
                    flow_invocation_id: invocation_id.clone(),
                    activation_id: uuid::Uuid::new_v4().to_string(),
                    step: Some(step),
                    agent_instance_id,
                },
                input: EngineValue {
                    origin: "entry".into(),
                    value_json: entry.message_json,
                },
            },
            link,
        )
        .await?;
    }
    save(&mut tx, &id, &stored.state).await?;
    if let Some(link) = link {
        intents::attach(&mut tx, link, &id).await?;
    }
    tx.commit().await?;
    Ok(EngineStartReceipt {
        system_start_id: id,
        flow_invocation_id: invocation_id,
        snapshot: stored.snapshot,
    })
}

pub(crate) async fn accept_delivery(
    pool: &SqlitePool,
    runtime: &EngineOwner,
    delivery: EngineDelivery,
) -> Result<EngineAcceptedDelivery> {
    let mut c = pool.acquire().await?;
    let mut tx = durable(&mut c).await?;
    let mut stored = load(&mut tx, &delivery.work.system_start_id).await?;
    owner(&stored.state, runtime, &stored.snapshot.system_start_id)?;
    let result = accept(&mut tx, &mut stored, delivery, None).await?;
    save(&mut tx, &stored.snapshot.system_start_id, &stored.state).await?;
    tx.commit().await?;
    Ok(result)
}
/// Called only after the resident compiler validates this exact Message against
/// the immutable document. UI callers supply neither origin nor execution IDs.
pub(crate) async fn accept_external_delivery(
    pool: &SqlitePool,
    runtime: &EngineOwner,
    delivery_id: &str,
    agent_name: &str,
    message_json: &str,
) -> Result<EngineAcceptedDelivery> {
    accept_external_delivery_linked(pool, runtime, delivery_id, agent_name, message_json, None)
        .await
}
pub(crate) async fn accept_external_delivery_linked(
    pool: &SqlitePool,
    runtime: &EngineOwner,
    delivery_id: &str,
    agent_name: &str,
    message_json: &str,
    link: Option<&intents::IntentAdmissionLink>,
) -> Result<EngineAcceptedDelivery> {
    opaque(delivery_id)?;
    opaque(agent_name)?;
    validate_json(message_json)?;
    let mut connection = pool.acquire().await?;
    let mut tx = durable(&mut connection).await?;
    let mut stored = load(&mut tx, &runtime.system_start_id).await?;
    owner(&stored.state, runtime, &stored.snapshot.system_start_id)?;
    require(
        stored.policies.is_empty(),
        "External delivery requires a graphless system",
    )?;
    let agent_id = stored
        .state
        .agents
        .get(agent_name)
        .ok_or_else(|| failure("CORRELATION", "agentName", "Agent is absent from snapshot"))?
        .id
        .clone();
    let input = EngineValue {
        origin: "entry".into(),
        value_json: message_json.into(),
    };
    let delivery = EngineDelivery {
        delivery_id: delivery_id.into(),
        work: EngineWork {
            system_start_id: runtime.system_start_id.clone(),
            flow_invocation_id: stored.state.invocation_id.clone(),
            activation_id: uuid::Uuid::new_v4().to_string(),
            step: None,
            agent_instance_id: Some(agent_id.clone()),
        },
        input,
    };
    intents::reserve_delivery(&mut tx, &delivery, &stored, link).await?;
    if let Some(raw) = sqlx::query_scalar::<_, String>(
        "SELECT receipt_json FROM engine_deliveries WHERE delivery_id=?",
    )
    .bind(delivery_id)
    .fetch_optional(&mut *tx)
    .await?
    {
        let retained: EngineAcceptedDelivery = serde_json::from_str(&raw)?;
        require(
            retained.delivery.work.system_start_id == runtime.system_start_id
                && retained.delivery.work.step.is_none()
                && retained.delivery.work.agent_instance_id.as_deref() == Some(agent_id.as_str())
                && record_equal(&retained.delivery.input, &delivery.input)?,
            "Conflicting external delivery retransmission",
        )?;
        if let Some(link) = link {
            intents::attach(&mut tx, link, &runtime.system_start_id).await?;
        }
        tx.commit().await?;
        return Ok(retained);
    }
    let receipt = accept(&mut tx, &mut stored, delivery, link).await?;
    save(&mut tx, &runtime.system_start_id, &stored.state).await?;
    if let Some(link) = link {
        intents::attach(&mut tx, link, &runtime.system_start_id).await?;
    }
    tx.commit().await?;
    Ok(receipt)
}

pub(crate) async fn begin(
    pool: &SqlitePool,
    runtime: &EngineOwner,
    delivery_id: &str,
) -> Result<Admission> {
    let mut c = pool.acquire().await?;
    let mut tx = durable(&mut c).await?;
    let mut stored = load(&mut tx, &runtime.system_start_id).await?;
    owner(&stored.state, runtime, &stored.snapshot.system_start_id)?;
    let Some(candidate) = stored
        .state
        .activations
        .values()
        .find(|a| a.delivery.delivery.delivery_id == delivery_id)
        .cloned()
    else {
        return Ok(Admission::Rejected("CORRELATION"));
    };
    let work = &candidate.delivery.delivery.work;
    if stored.state.rejected.contains_key(&work.activation_id) && candidate.work_state != "terminal"
    {
        return Ok(Admission::Rejected("VISIT_LIMIT"));
    }
    if candidate.work_state != "queued" {
        return Ok(Admission::Waiting(if candidate.work_state == "uncertain" {
            "uncertain"
        } else {
            "active"
        }));
    }
    if !matches!(stored.state.stop, EngineStopState::None)
        || !matches!(candidate.stop_state, EngineStopState::None)
    {
        return Ok(Admission::Rejected("STOP_PENDING"));
    }
    let same_agent = |a: &&EngineActivation| {
        a.delivery.delivery.work.agent_instance_id == work.agent_instance_id
            && work.agent_instance_id.is_some()
    };
    if stored
        .state
        .activations
        .values()
        .filter(same_agent)
        .any(|a| a.work_state == "uncertain")
    {
        return Ok(Admission::Waiting("uncertain"));
    }
    if stored
        .state
        .activations
        .values()
        .filter(same_agent)
        .any(|a| a.work_state == "active")
    {
        return Ok(Admission::Waiting("active"));
    }
    if stored
        .state
        .activations
        .values()
        .filter(same_agent)
        .any(|a| {
            a.work_state == "queued"
                && order(
                    &a.delivery.queue_sequence,
                    &candidate.delivery.queue_sequence,
                )
                .is_lt()
        })
    {
        return Ok(Admission::Waiting("fifo"));
    }
    let p = policy(&stored, work)?.cloned();
    let visit_key = encode(&(&work.flow_invocation_id, &work.step))?;
    let visits = stored
        .state
        .visits
        .get(&visit_key)
        .cloned()
        .unwrap_or_else(|| "0".into());
    if let Some(max) = p.and_then(|p| p.max_visits) {
        if order(&visits, &max).is_ge() {
            let a = stored
                .state
                .activations
                .get_mut(&work.activation_id)
                .expect("candidate");
            // Reserve a no-effect resolution. It uses the same terminal/route
            // transaction as admitted work, without consuming a visit or memory.
            a.work_state = "active".into();
            a.admitted_epoch = Some(runtime.owner_epoch.clone());
            stored
                .state
                .rejected
                .insert(work.activation_id.clone(), "VISIT_LIMIT".into());
            event(
                &mut tx,
                &mut stored.state,
                &runtime.system_start_id,
                Some(work.clone()),
                "diagnostic",
                "{\"code\":\"VISIT_LIMIT\"}".into(),
            )
            .await?;
            save(&mut tx, &runtime.system_start_id, &stored.state).await?;
            tx.commit().await?;
            return Ok(Admission::Rejected("VISIT_LIMIT"));
        }
    }
    if work.step.is_some() {
        stored.state.visits.insert(visit_key, next(&visits));
    }
    let memory = work
        .agent_instance_id
        .as_ref()
        .and_then(|id| stored.state.agents.values().find(|a| &a.id == id))
        .and_then(|a| a.memory.clone());
    let a = stored
        .state
        .activations
        .get_mut(&work.activation_id)
        .expect("candidate");
    a.work_state = "active".into();
    a.admitted_epoch = Some(runtime.owner_epoch.clone());
    let admitted = a.clone();
    event(
        &mut tx,
        &mut stored.state,
        &runtime.system_start_id,
        Some(work.clone()),
        "admitted",
        encode(&admitted)?,
    )
    .await?;
    save(&mut tx, &runtime.system_start_id, &stored.state).await?;
    tx.commit().await?;
    Ok(Admission::Admitted(admitted, memory))
}

fn context(stored: &Stored, context: &EngineContext) -> Result<()> {
    live(&stored.state, &context.owner, &context.work)?;
    require(
        context.registry_version == stored.snapshot.versions.registry,
        "Registry version changed",
    )?;
    if let Some(id) = &context.work.agent_instance_id {
        let name = stored
            .state
            .agents
            .iter()
            .find(|(_, a)| &a.id == id)
            .map(|(name, _)| name)
            .expect("validated agent");
        let config = stored
            .snapshot
            .agents
            .iter()
            .find(|a| &a.agent_name == name)
            .expect("frozen config");
        require(
            super::exact_json::equal(&config.permissions_json, &context.permissions_json)?
                && super::exact_json::equal(&config.scope_json, &context.scope_json)?,
            "Effect context exceeds frozen configuration",
        )?;
    }
    if context.work.agent_instance_id.is_none() {
        let scope = stored
            .capture
            .as_ref()
            .and_then(|capture| {
                capture
                    .call_scopes
                    .iter()
                    .find(|scope| context.work.step.as_ref() == Some(&scope.step))
            })
            .ok_or_else(|| {
                failure(
                    "PERMISSION",
                    "scope",
                    "No captured Call scope for this work",
                )
            })?;
        require(
            super::exact_json::equal(&scope.permissions_json, &context.permissions_json)?
                && super::exact_json::equal(&scope.scope_json, &context.scope_json)?,
            "Call context exceeds captured scope",
        )?;
    }
    validate_json(&context.permissions_json)?;
    validate_json(&context.scope_json)?;
    Ok(())
}
fn effect_key(effect: &EngineEffectIdentity) -> Result<String> {
    match effect {
        EngineEffectIdentity::Provider {
            provider_attempt_id,
        } => {
            opaque(provider_attempt_id)?;
            Ok(format!("provider:{provider_attempt_id}"))
        }
        EngineEffectIdentity::Tool {
            tool_invocation_id,
            provider_attempt_id,
        } => {
            opaque(tool_invocation_id)?;
            if let Some(id) = provider_attempt_id {
                opaque(id)?;
            }
            Ok(format!("tool:{tool_invocation_id}"))
        }
    }
}
pub(crate) async fn register_effect(pool: &SqlitePool, effect: EngineEffect) -> Result<bool> {
    let mut c = pool.acquire().await?;
    let mut tx = durable(&mut c).await?;
    let mut stored = load(&mut tx, &effect.context.work.system_start_id).await?;
    let registered = register_effect_on(&mut tx, &mut stored, effect).await?;
    tx.commit().await?;
    Ok(registered)
}
async fn register_effect_on(
    db: &mut SqliteConnection,
    stored: &mut Stored,
    effect: EngineEffect,
) -> Result<bool> {
    validate_json(&effect.invocation_json)?;
    let key = effect_key(&effect.effect)?;
    owner(
        &stored.state,
        &effect.context.owner,
        &effect.context.work.system_start_id,
    )?;
    activation(&stored.state, &effect.context.work)?;
    let raw = encode(&effect)?;
    if let Some(previous) = sqlx::query_scalar::<_, String>(
        "SELECT record_json FROM engine_effects WHERE system_id = ? AND effect_key = ?",
    )
    .bind(&stored.snapshot.system_start_id)
    .bind(&key)
    .fetch_optional(&mut *db)
    .await?
    {
        require(
            record_equal(&serde_json::from_str::<EngineEffect>(&previous)?, &effect)?,
            "Conflicting effect registration",
        )?;
        return Ok(false);
    }
    context(&stored, &effect.context)?;
    let a = activation(&stored.state, &effect.context.work)?;
    require(
        !stored
            .state
            .rejected
            .contains_key(&effect.context.work.activation_id),
        "Rejected work cannot dispatch",
    )?;
    require(
        a.work_state == "active"
            && matches!(a.stop_state, EngineStopState::None)
            && matches!(stored.state.stop, EngineStopState::None),
        "Stopped or uncertain work cannot dispatch",
    )?;
    if let EngineEffectIdentity::Tool {
        provider_attempt_id: Some(id),
        ..
    } = &effect.effect
    {
        let exists:i64=sqlx::query_scalar("SELECT count(*) FROM engine_effects WHERE system_id = ? AND activation_id = ? AND effect_key = ?").bind(&stored.snapshot.system_start_id).bind(&effect.context.work.activation_id).bind(format!("provider:{id}")).fetch_one(&mut *db).await?;
        require(exists == 1, "Tool provider attempt is not registered")?;
    }
    sqlx::query("INSERT INTO engine_effects VALUES (?, ?, ?, ?, 'pending', NULL, NULL)")
        .bind(&stored.snapshot.system_start_id)
        .bind(&effect.context.work.activation_id)
        .bind(key)
        .bind(raw.clone())
        .execute(&mut *db)
        .await?;
    sqlx::query("INSERT INTO engine_effect_processes VALUES (?, ?, ?)")
        .bind(&stored.snapshot.system_start_id)
        .bind(effect_key(&effect.effect)?)
        .bind(i64::from(std::process::id()))
        .execute(&mut *db)
        .await?;
    event(
        &mut *db,
        &mut stored.state,
        &stored.snapshot.system_start_id,
        Some(effect.context.work.clone()),
        "effect",
        raw,
    )
    .await?;
    save(&mut *db, &stored.snapshot.system_start_id, &stored.state).await?;
    Ok(true)
}
pub(crate) async fn settle_effect(
    pool: &SqlitePool,
    settlement: EngineSettlement,
    result: Option<String>,
) -> Result<()> {
    settle_effect_on(pool, settlement, result, false).await
}
async fn settle_effect_on(
    pool: &SqlitePool,
    settlement: EngineSettlement,
    result: Option<String>,
    physical_end: bool,
) -> Result<()> {
    require(
        ["ended", "uncertain"].contains(&settlement.status.as_str()),
        "Invalid settlement status",
    )?;
    validate_json(&settlement.evidence_json)?;
    if let Some(result) = &result {
        validate_json(result)?;
        require(
            settlement.status == "ended",
            "Uncertain effect cannot have a result",
        )?;
    }
    if settlement.status == "ended"
        && matches!(settlement.effect, EngineEffectIdentity::Tool { .. })
    {
        require(result.is_some(), "Ended tool requires a durable result")?;
    }
    if settlement.status == "ended"
        && matches!(settlement.effect, EngineEffectIdentity::Provider { .. })
    {
        require(
            result.is_none(),
            "Provider settlement cannot contain a tool result",
        )?;
    }
    let key = effect_key(&settlement.effect)?;
    let mut c = pool.acquire().await?;
    let mut tx = durable(&mut c).await?;
    let mut stored = load(&mut tx, &settlement.context.work.system_start_id).await?;
    let retired = stored.state.epoch != settlement.context.owner.owner_epoch;
    let a = activation(&stored.state, &settlement.context.work)?;
    if retired && physical_end {
        require(
            settlement.status == "ended"
                && a.admitted_epoch.as_deref()
                    == Some(settlement.context.owner.owner_epoch.as_str()),
            "Recovery requires an original physical end receipt",
        )?;
    } else {
        owner(
            &stored.state,
            &settlement.context.owner,
            &settlement.context.work.system_start_id,
        )?;
    }
    let row=sqlx::query("SELECT record_json, status, settlement_json, result_json FROM engine_effects WHERE system_id = ? AND effect_key = ?").bind(&stored.snapshot.system_start_id).bind(&key).fetch_optional(&mut *tx).await?.ok_or_else(||failure("CORRELATION","effect","Unregistered effect"))?;
    let registered: EngineEffect = serde_json::from_str(row.get("record_json"))?;
    require(
        record_equal(&registered.context, &settlement.context)?
            && registered.effect == settlement.effect,
        "Settlement attribution mismatch",
    )?;
    let raw = encode(&settlement)?;
    if row.get::<&str, _>("status") == "ended" {
        require(
            record_equal(
                &serde_json::from_str::<EngineSettlement>(row.get::<&str, _>("settlement_json"))?,
                &settlement,
            )? && equal_optional(row.get("result_json"), result.as_deref())?,
            "Conflicting completed effect",
        )?;
        tx.commit().await?;
        return Ok(());
    }
    if !retired {
        context(&stored, &settlement.context)?;
    }
    sqlx::query("UPDATE engine_effects SET status = ?, settlement_json = ?, result_json = ? WHERE system_id = ? AND effect_key = ?").bind(&settlement.status).bind(&raw).bind(result).bind(&stored.snapshot.system_start_id).bind(&key).execute(&mut *tx).await?;
    if settlement.status == "uncertain" {
        stored
            .state
            .activations
            .get_mut(&settlement.context.work.activation_id)
            .expect("validated work")
            .work_state = "uncertain".into();
    }
    event(
        &mut tx,
        &mut stored.state,
        &stored.snapshot.system_start_id,
        Some(settlement.context.work.clone()),
        "effect",
        raw,
    )
    .await?;
    save(&mut tx, &stored.snapshot.system_start_id, &stored.state).await?;
    tx.commit().await?;
    Ok(())
}
/// Only physical native executors call this after joining their work. A retired
/// host cannot write through the IPC settlement port, but its native executor
/// must not lose an actual completion receipt when ownership was rotated.
pub(crate) async fn settle_owned_effect(
    pool: &SqlitePool,
    settlement: EngineSettlement,
    result: Option<String>,
) -> Result<()> {
    let system_id = settlement.context.work.system_start_id.clone();
    settle_effect_on(pool, settlement, result, true).await?;
    confirm_stopped_retired_work(pool, &system_id).await
}

/// Stop can discard a retired continuation only when every physical effect has
/// a native end receipt. Outputs and provisional memory are never published.
pub(crate) async fn confirm_stopped_retired_work(pool: &SqlitePool, system_id: &str) -> Result<()> {
    let mut c = pool.acquire().await?;
    let mut tx = durable(&mut c).await?;
    let mut stored = load(&mut tx, system_id).await?;
    let mut closed = Vec::new();
    for a in stored.state.activations.values_mut() {
        if a.work_state != "uncertain"
            || a.admitted_epoch
                .as_deref()
                .is_none_or(|e| e == stored.state.epoch)
        {
            continue;
        }
        let request_id = match &a.stop_state {
            EngineStopState::Requested { request_id }
            | EngineStopState::Uncertain { request_id, .. } => request_id.clone(),
            _ => continue,
        };
        let work = &a.delivery.delivery.work;
        let effects: (i64, i64) = sqlx::query_as("SELECT count(*),coalesce(sum(status<>'ended'),0) FROM engine_effects WHERE system_id=? AND activation_id=?")
            .bind(system_id).bind(&work.activation_id).fetch_one(&mut *tx).await?;
        if effects.1 != 0 {
            continue;
        }
        if effects.0 == 0 {
            // Every physical effect requires registration before dispatch. The
            // retired epoch cannot reserve one later. Partial publications without
            // an effect receipt remain inconsistent, so never infer their closure.
            let responses: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM engine_responses WHERE system_id=? AND activation_id=?",
            )
            .bind(system_id)
            .bind(&work.activation_id)
            .fetch_one(&mut *tx)
            .await?;
            if responses != 0 {
                continue;
            }
        }
        let evidence = "{\"kind\":\"native-retired-work-effects-ended\"}".to_string();
        a.work_state = "terminal".into();
        a.terminal = Some(EngineOutcome::Stopped {
            evidence_json: evidence.clone(),
        });
        a.stop_state = EngineStopState::Confirmed {
            request_id,
            evidence_json: evidence,
        };
        closed.push(work.clone());
    }
    for work in &closed {
        event(
            &mut tx,
            &mut stored.state,
            system_id,
            Some(work.clone()),
            "terminal",
            "{\"outcome\":{\"kind\":\"stopped\"},\"nativeRetiredEffectsEnded\":true}".into(),
        )
        .await?;
    }
    if !closed.is_empty() {
        confirm_system_stop(&mut tx, &mut stored).await?;
        save(&mut tx, system_id, &stored.state).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Records a native provider stream join for Stop. When the effect's owner was
/// revoked after registering it, that owner can no longer settle the effect:
/// nothing is written, the effect keeps its uncertainty and the caller gets the
/// contract's STOP_PENDING. Unregistered or mismatched effects stay CORRELATION.
pub(crate) async fn settle_provider_join(
    pool: &SqlitePool,
    context: EngineContext,
    provider_attempt_id: &str,
    ended: bool,
) -> Result<()> {
    let effect = EngineEffectIdentity::Provider {
        provider_attempt_id: provider_attempt_id.into(),
    };
    let revoked = {
        let mut c = pool.acquire().await?;
        let stored = load(&mut c, &context.work.system_start_id).await?;
        let raw: Option<String> = sqlx::query_scalar(
            "SELECT record_json FROM engine_effects WHERE system_id = ? AND effect_key = ?",
        )
        .bind(&context.work.system_start_id)
        .bind(effect_key(&effect)?)
        .fetch_optional(&mut *c)
        .await?;
        let registered: Option<EngineEffect> =
            raw.map(|raw| serde_json::from_str(&raw)).transpose()?;
        // Registration required this owner to be current, so a different epoch now
        // proves revocation rather than a foreign caller.
        registered
            .is_some_and(|registered| registered.effect == effect && registered.context == context)
            && stored.snapshot.system_start_id == context.owner.system_start_id
            && stored.state.epoch != context.owner.owner_epoch
    };
    if revoked {
        return Err(failure(
            "STOP_PENDING",
            "request",
            "Revoked ownership cannot record the native stream termination",
        ));
    }
    let status = if ended { "ended" } else { "uncertain" };
    settle_effect(
        pool,
        EngineSettlement {
            context,
            effect,
            status: status.into(),
            evidence_json: serde_json::to_string(&serde_json::json!({
                "kind": "macro-native-stream-join/1",
                "requestId": provider_attempt_id,
                "status": status,
            }))?,
        },
        None,
    )
    .await?;
    require_ended(ended)
}
fn require_ended(ended: bool) -> Result<()> {
    if ended {
        Ok(())
    } else {
        Err(failure(
            "STOP_PENDING",
            "request",
            "Native stream termination remains unconfirmed",
        ))
    }
}

/// Called by the native response collector after attribution, gaps and closure checks.
pub(crate) async fn seal_responses(
    pool: &SqlitePool,
    runtime: &EngineOwner,
    work: &EngineWork,
    cursor: &str,
) -> Result<()> {
    decimal(cursor)?;
    let mut c = pool.acquire().await?;
    let mut tx = durable(&mut c).await?;
    let mut stored = load(&mut tx, &work.system_start_id).await?;
    live(&stored.state, runtime, work)?;
    if let Some(previous) = stored.state.closed_responses.get(&work.activation_id) {
        require(previous == cursor, "Response collection is already closed")?;
    } else {
        stored
            .state
            .closed_responses
            .insert(work.activation_id.clone(), cursor.into());
    }
    save(&mut tx, &work.system_start_id, &stored.state).await?;
    tx.commit().await?;
    Ok(())
}
fn validate_outcome(outcome: &EngineOutcome) -> Result<()> {
    match outcome {
        EngineOutcome::Completed { output } => {
            require(
                ["entry", "prepare", "agent", "call", "error"].contains(&output.origin.as_str()),
                "Unsupported output origin",
            )?;
            validate_json(&output.value_json)
        }
        EngineOutcome::Failed { code, error_json } => {
            opaque(code)?;
            validate_json(error_json)
        }
        EngineOutcome::Stopped { evidence_json } => validate_json(evidence_json),
    }
}
pub(crate) async fn commit_terminal(
    pool: &SqlitePool,
    commit: EngineTerminalCommit,
    routes: &impl RouteAuthority,
) -> Result<bool> {
    let mut c = pool.acquire().await?;
    let mut tx = durable(&mut c).await?;
    let mut stored = load(&mut tx, &commit.work.system_start_id).await?;
    owner(&stored.state, &commit.owner, &commit.work.system_start_id)?;
    let result = commit_terminal_on(&mut tx, &mut stored, commit, routes, false).await?;
    tx.commit().await?;
    Ok(result)
}
async fn commit_terminal_on(
    db: &mut SqliteConnection,
    stored: &mut Stored,
    commit: EngineTerminalCommit,
    routes: &impl RouteAuthority,
    recovered: bool,
) -> Result<bool> {
    decimal(&commit.response_cursor)?;
    validate_json(&commit.termination_evidence_json)?;
    validate_outcome(&commit.outcome)?;
    activation(&stored.state, &commit.work)?;
    if let Some(previous) = stored.state.terminals.get(&commit.work.activation_id) {
        require(
            record_equal(previous, &commit)?,
            "Conflicting terminal transaction",
        )?;
        return Ok(false);
    }
    if !recovered {
        live(&stored.state, &commit.owner, &commit.work)?;
    }
    let unresolved:i64=sqlx::query_scalar("SELECT count(*) FROM engine_effects WHERE system_id = ? AND activation_id = ? AND status <> 'ended'").bind(&commit.work.system_start_id).bind(&commit.work.activation_id).fetch_one(&mut *db).await?;
    require(
        unresolved == 0,
        "Unresolved effects retain the activation lock",
    )?;
    require(
        stored
            .state
            .closed_responses
            .get(&commit.work.activation_id)
            == Some(&commit.response_cursor),
        "Response cursor has not been closed",
    )?;
    let expected = if matches!(commit.outcome, EngineOutcome::Stopped { .. })
        || !matches!(stored.state.stop, EngineStopState::None)
        || !matches!(
            activation(&stored.state, &commit.work)?.stop_state,
            EngineStopState::None
        ) {
        Vec::new()
    } else {
        routes.outgoing(&stored.snapshot, &commit.work, &commit.outcome)?
    };
    require(
        record_equal(&expected, &commit.outgoing)? && commit.outgoing.len() <= 1,
        "Outgoing delivery does not match the frozen route",
    )?;
    let rejected = stored.state.rejected.get(&commit.work.activation_id);
    if let Some(code) = rejected {
        require(
            matches!(&commit.outcome, EngineOutcome::Failed {code: outcome, ..} if outcome == code)
                || matches!(&commit.outcome, EngineOutcome::Stopped { .. }),
            "Rejected activation requires its reserved failure or correlated stop",
        )?;
        let previous_memory = commit
            .work
            .agent_instance_id
            .as_ref()
            .and_then(|id| stored.state.agents.values().find(|a| &a.id == id))
            .and_then(|a| a.memory.clone());
        require(
            record_equal(&previous_memory, &commit.memory)?,
            "Rejected activation cannot change memory",
        )?;
    } else if let Some(id) = &commit.work.agent_instance_id {
        let agent = stored
            .state
            .agents
            .values_mut()
            .find(|a| &a.id == id)
            .expect("validated agent");
        let memory = commit.memory.as_ref().ok_or_else(|| {
            failure(
                "CORRELATION",
                "memory",
                "Agent terminal requires checkpoint",
            )
        })?;
        decimal(&memory.revision)?;
        validate_json(&memory.state_json)?;
        opaque(&memory.format_version)?;
        require(
            memory.agent_instance_id == *id
                && agent
                    .memory
                    .as_ref()
                    .is_none_or(|old| order(&old.revision, &memory.revision).is_lt()),
            "Checkpoint belongs to another agent or is stale",
        )?;
        agent.memory = Some(memory.clone());
    } else {
        require(
            commit.memory.is_none(),
            "Non-agent cannot checkpoint agent memory",
        )?;
    }
    let a = stored
        .state
        .activations
        .get_mut(&commit.work.activation_id)
        .expect("validated activation");
    a.work_state = "terminal".into();
    a.terminal = Some(commit.outcome.clone());
    if let EngineOutcome::Stopped { evidence_json } = &commit.outcome {
        let request_id = match &a.stop_state {
            EngineStopState::Requested { request_id }
            | EngineStopState::Uncertain { request_id, .. } => request_id.clone(),
            _ => {
                return Err(failure(
                    "CORRELATION",
                    "stop",
                    "No stop request matches confirmation",
                ))
            }
        };
        a.stop_state = EngineStopState::Confirmed {
            request_id,
            evidence_json: evidence_json.clone(),
        };
    }
    if !matches!(commit.outcome, EngineOutcome::Stopped { .. }) {
        if let EngineStopState::Requested { request_id }
        | EngineStopState::Uncertain { request_id, .. } = &a.stop_state
        {
            // Natural completion may win the outcome while a concurrent Stop still
            // suppresses continuation. The same closed-effect proof settles the request.
            a.stop_state = EngineStopState::Confirmed {
                request_id: request_id.clone(),
                evidence_json: commit.termination_evidence_json.clone(),
            };
        }
    }
    for delivery in &commit.outgoing {
        require(
            delivery.work.flow_invocation_id == commit.work.flow_invocation_id,
            "Successor changed flow invocation",
        )?;
        accept(&mut *db, stored, delivery.clone(), None).await?;
    }
    event(
        &mut *db,
        &mut stored.state,
        &commit.work.system_start_id,
        Some(commit.work.clone()),
        "terminal",
        encode(&commit)?,
    )
    .await?;
    stored
        .state
        .terminals
        .insert(commit.work.activation_id.clone(), commit.clone());
    confirm_system_stop(&mut *db, stored).await?;
    save(&mut *db, &commit.work.system_start_id, &stored.state).await?;
    Ok(true)
}
async fn confirm_system_stop(db: &mut SqliteConnection, stored: &mut Stored) -> Result<()> {
    if !stored
        .state
        .activations
        .values()
        .all(|a| a.work_state == "terminal")
    {
        return Ok(());
    }
    if let EngineStopState::Requested { request_id }
    | EngineStopState::Uncertain { request_id, .. } = &stored.state.stop
    {
        stored.state.stop = EngineStopState::Confirmed {
            request_id: request_id.clone(),
            evidence_json: "{\"allActivationsTerminal\":true}".into(),
        };
        let payload = encode(&stored.state.stop)?;
        event(
            db,
            &mut stored.state,
            &stored.snapshot.system_start_id,
            None,
            "stop",
            payload,
        )
        .await?;
    }
    Ok(())
}
pub(crate) async fn stop(pool: &SqlitePool, request: EngineStopRequest) -> Result<EngineStopState> {
    opaque(&request.request_id)?;
    let mut c = pool.acquire().await?;
    let mut tx = durable(&mut c).await?;
    let stored = load(&mut tx, &request.system_start_id).await?;
    let result = stop_on(&mut tx, stored, request).await?;
    tx.commit().await?;
    Ok(result)
}

async fn stop_on(
    tx: &mut Transaction<'_, Sqlite>,
    mut stored: Stored,
    request: EngineStopRequest,
) -> Result<EngineStopState> {
    if let Some(id) = &request.activation_id {
        require(
            stored.state.activations.contains_key(id),
            "Unknown stop activation",
        )?;
    }
    let previous = if let Some(id) = &request.activation_id {
        &stored.state.activations[id].stop_state
    } else {
        &stored.state.stop
    };
    match previous {
        EngineStopState::None => (),
        EngineStopState::Requested { request_id }
        | EngineStopState::Uncertain { request_id, .. }
        | EngineStopState::Confirmed { request_id, .. } => {
            require(
                request_id == &request.request_id,
                "Conflicting stop request",
            )?;
            return Ok(previous.clone());
        }
    }
    sqlx::query("UPDATE engine_approvals SET status = 'cancelled' WHERE system_id = ? AND (? IS NULL OR activation_id = ?) AND status IN ('pending', 'approved')")
        .bind(&request.system_start_id).bind(&request.activation_id).bind(&request.activation_id)
        .execute(&mut **tx).await?;
    let requested = EngineStopState::Requested {
        request_id: request.request_id.clone(),
    };
    if request.activation_id.is_none() {
        stored.state.stop = requested.clone();
    }
    for a in stored.state.activations.values_mut().filter(|a| {
        request
            .activation_id
            .as_ref()
            .is_none_or(|id| id == &a.delivery.delivery.work.activation_id)
    }) {
        // System escalation preserves every existing targeted key and witness.
        if request.activation_id.is_none() && !matches!(a.stop_state, EngineStopState::None) {
            continue;
        }
        if a.work_state == "terminal" {
            a.stop_state = EngineStopState::Confirmed {
                request_id: request.request_id.clone(),
                evidence_json: "{\"alreadyTerminal\":true}".into(),
            };
        } else if a.work_state == "queued" {
            a.work_state = "terminal".into();
            a.terminal = Some(EngineOutcome::Stopped {
                evidence_json: "{\"neverAdmitted\":true}".into(),
            });
            a.stop_state = EngineStopState::Confirmed {
                request_id: request.request_id.clone(),
                evidence_json: "{\"neverAdmitted\":true}".into(),
            };
        } else {
            a.stop_state = requested.clone();
        }
    }
    event(
        &mut *tx,
        &mut stored.state,
        &request.system_start_id,
        None,
        "stop",
        encode(&request)?,
    )
    .await?;
    confirm_system_stop(&mut *tx, &mut stored).await?;
    let result = if let Some(id) = &request.activation_id {
        stored.state.activations[id].stop_state.clone()
    } else {
        stored.state.stop.clone()
    };
    save(&mut *tx, &request.system_start_id, &stored.state).await?;
    Ok(result)
}
/// Native Stop recovery only: an old non-Agent Call waiting for approval never
/// dispatched when its approval is cancelled and both effect/response journals
/// are empty. A revoked epoch cannot later consume that approval or register an
/// effect. Unknown dispatched effects and Agent memory are deliberately excluded.
pub(crate) async fn confirm_stopped_undispatched_calls(
    pool: &SqlitePool,
    system_id: &str,
    activation_id: Option<&str>,
) -> Result<()> {
    let mut connection = pool.acquire().await?;
    let mut tx = durable(&mut connection).await?;
    let mut stored = load(&mut tx, system_id).await?;
    let mut closed = Vec::new();
    for a in stored.state.activations.values_mut() {
        let work = &a.delivery.delivery.work;
        if activation_id.is_some_and(|id| id != work.activation_id)
            || a.work_state != "uncertain"
            || work.agent_instance_id.is_some()
            || a.admitted_epoch
                .as_deref()
                .is_none_or(|epoch| epoch == stored.state.epoch)
        {
            continue;
        }
        let request_id = match &a.stop_state {
            EngineStopState::Requested { request_id }
            | EngineStopState::Uncertain { request_id, .. } => request_id.clone(),
            _ => continue,
        };
        let rows: Vec<String> = sqlx::query_scalar(
            "SELECT request_json FROM engine_approvals WHERE system_id=? AND activation_id=? AND status='cancelled'",
        ).bind(system_id).bind(&work.activation_id).fetch_all(&mut *tx).await?;
        if rows.is_empty() {
            continue;
        }
        let mut attributed = true;
        for raw in rows {
            let approval: approvals::Request = serde_json::from_str(&raw)?;
            attributed &= record_equal(&approval.effect.context.work, work)?
                && Some(approval.effect.context.owner.owner_epoch.as_str())
                    == a.admitted_epoch.as_deref()
                && approval.effect.context.owner.system_start_id == system_id
                && matches!(
                    approval.effect.effect,
                    EngineEffectIdentity::Tool {
                        provider_attempt_id: None,
                        ..
                    }
                );
        }
        let effects: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM engine_effects WHERE system_id=? AND activation_id=?",
        )
        .bind(system_id)
        .bind(&work.activation_id)
        .fetch_one(&mut *tx)
        .await?;
        let responses: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM engine_responses WHERE system_id=? AND activation_id=?",
        )
        .bind(system_id)
        .bind(&work.activation_id)
        .fetch_one(&mut *tx)
        .await?;
        if !attributed || effects != 0 || responses != 0 {
            continue;
        }
        let evidence = "{\"kind\":\"native-cancelled-approval-no-dispatch\"}".to_string();
        a.work_state = "terminal".into();
        a.terminal = Some(EngineOutcome::Stopped {
            evidence_json: evidence.clone(),
        });
        a.stop_state = EngineStopState::Confirmed {
            request_id,
            evidence_json: evidence,
        };
        closed.push(work.clone());
    }
    for work in &closed {
        event(
            &mut tx,
            &mut stored.state,
            system_id,
            Some(work.clone()),
            "terminal",
            "{\"outcome\":{\"kind\":\"stopped\"},\"nativeCancelledApprovalNoDispatch\":true}"
                .into(),
        )
        .await?;
    }
    if !closed.is_empty() {
        confirm_system_stop(&mut tx, &mut stored).await?;
        save(&mut tx, system_id, &stored.state).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Resolve and retain the native key atomically, including a lost acknowledgement.
pub(crate) async fn ensure_stop(
    pool: &SqlitePool,
    system_start_id: &str,
    activation_id: Option<&str>,
) -> Result<EngineStopState> {
    opaque(system_start_id)?;
    if let Some(id) = activation_id {
        opaque(id)?;
    }
    let mut connection = pool.acquire().await?;
    let mut tx = durable(&mut connection).await?;
    let stored = load(&mut tx, system_start_id).await?;
    let previous = stop_target(&stored, activation_id)?;
    let request_id = match previous {
        EngineStopState::None => uuid::Uuid::new_v4().to_string(),
        EngineStopState::Requested { request_id }
        | EngineStopState::Uncertain { request_id, .. }
        | EngineStopState::Confirmed { request_id, .. } => request_id.clone(),
    };
    let result = stop_on(
        &mut tx,
        stored,
        EngineStopRequest {
            system_start_id: system_start_id.into(),
            activation_id: activation_id.map(str::to_owned),
            request_id,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(result)
}

fn stop_target<'a>(stored: &'a Stored, activation_id: Option<&str>) -> Result<&'a EngineStopState> {
    match activation_id {
        None => Ok(&stored.state.stop),
        Some(id) => stored
            .state
            .activations
            .get(id)
            .map(|a| &a.stop_state)
            .ok_or_else(|| failure("CORRELATION", "activationId", "Unknown stop activation")),
    }
}

/// Uses the complete native state; public projection pagination is irrelevant.
pub(crate) async fn read_stop_target(
    pool: &SqlitePool,
    system_start_id: &str,
    activation_id: Option<&str>,
) -> Result<EngineStopState> {
    let mut connection = pool.acquire().await?;
    let stored = load(&mut connection, system_start_id).await?;
    stop_target(&stored, activation_id).cloned()
}

pub(crate) async fn mark_uncertain(
    pool: &SqlitePool,
    runtime: &EngineOwner,
    work: &EngineWork,
    reason: &str,
) -> Result<()> {
    opaque(reason)?;
    let mut c = pool.acquire().await?;
    let mut tx = durable(&mut c).await?;
    let mut stored = load(&mut tx, &work.system_start_id).await?;
    live(&stored.state, runtime, work)?;
    let a = stored
        .state
        .activations
        .get_mut(&work.activation_id)
        .expect("validated activation");
    a.work_state = "uncertain".into();
    if let EngineStopState::Requested { request_id } = &a.stop_state {
        a.stop_state = EngineStopState::Uncertain {
            request_id: request_id.clone(),
            reason: reason.into(),
        };
    }
    event(
        &mut tx,
        &mut stored.state,
        &work.system_start_id,
        Some(work.clone()),
        "uncertain",
        encode(&reason)?,
    )
    .await?;
    save(&mut tx, &work.system_start_id, &stored.state).await?;
    tx.commit().await?;
    Ok(())
}
/// A native supervisor verifies external termination and closed collection proofs.
/// Implementations are trusted Rust capabilities, never a product DTO/IPC intake.
pub(crate) trait RecoveryAuthority {
    fn verify(&self, snapshot: &EngineSnapshot, proof: &RecoveryProof) -> Result<()>;
}
#[derive(Clone)]
pub(crate) struct RecoveryProof {
    pub terminal: EngineTerminalCommit,
    pub effects: Vec<(EngineSettlement, Option<String>)>,
}
/// Resolve an old incarnation atomically, without admitting or dispatching work.
pub(crate) async fn resolve_recovered(
    pool: &SqlitePool,
    current: &EngineOwner,
    available: &EngineVersions,
    proof: RecoveryProof,
    authority: &impl RecoveryAuthority,
    routes: &impl RouteAuthority,
) -> Result<bool> {
    let mut c = pool.acquire().await?;
    let mut tx = durable(&mut c).await?;
    let commit = &proof.terminal;
    let mut stored = load(&mut tx, &commit.work.system_start_id).await?;
    owner(&stored.state, current, &commit.work.system_start_id)?;
    require(
        &stored.snapshot.versions == available,
        "Recovery versions do not match snapshot",
    )?;
    let activation = activation(&stored.state, &commit.work)?;
    require(
        commit.owner.system_start_id == commit.work.system_start_id
            && commit.owner.owner_epoch != current.owner_epoch
            && activation.admitted_epoch.as_deref() == Some(commit.owner.owner_epoch.as_str())
            && (activation.work_state == "uncertain"
                || stored
                    .state
                    .terminals
                    .contains_key(&commit.work.activation_id)),
        "Recovery requires the original uncertain incarnation",
    )?;
    authority.verify(&stored.snapshot, &proof)?;
    let mut keys = BTreeSet::new();
    for (settlement, result) in &proof.effects {
        require(
            settlement.status == "ended"
                && settlement.context.work == commit.work
                && settlement.context.owner == commit.owner,
            "Recovery settlement attribution mismatch",
        )?;
        validate_json(&settlement.evidence_json)?;
        if let Some(result) = result {
            validate_json(result)?;
        }
        if matches!(settlement.effect, EngineEffectIdentity::Tool { .. }) {
            require(result.is_some(), "Ended tool requires a durable result")?;
        }
        let key = effect_key(&settlement.effect)?;
        require(keys.insert(key.clone()), "Repeated recovery effect")?;
        let row = sqlx::query("SELECT record_json, status, settlement_json, result_json FROM engine_effects WHERE system_id=? AND effect_key=?")
            .bind(&commit.work.system_start_id).bind(&key).fetch_optional(&mut *tx).await?
            .ok_or_else(|| failure("CORRELATION", "effect", "Recovery effect is not registered"))?;
        let registered: EngineEffect = serde_json::from_str(row.get("record_json"))?;
        require(
            record_equal(&registered.context, &settlement.context)?
                && registered.effect == settlement.effect,
            "Recovery cannot change initial effect attribution",
        )?;
        if row.get::<&str, _>("status") == "ended" {
            require(
                record_equal(
                    &serde_json::from_str::<EngineSettlement>(row.get("settlement_json"))?,
                    settlement,
                )? && equal_optional(row.get("result_json"), result.as_deref())?,
                "Recovery conflicts with ended effect",
            )?;
        } else {
            sqlx::query("UPDATE engine_effects SET status='ended', settlement_json=?, result_json=? WHERE system_id=? AND effect_key=?")
                .bind(encode(settlement)?).bind(result).bind(&commit.work.system_start_id).bind(&key).execute(&mut *tx).await?;
        }
    }
    // The verified proof includes final response collection closure. It never
    // reopens an earlier closure or changes the activation's admitted epoch.
    if let Some(previous) = stored
        .state
        .closed_responses
        .get(&commit.work.activation_id)
    {
        require(
            previous == &commit.response_cursor,
            "Recovery changed closed response cursor",
        )?;
    } else {
        decimal(&commit.response_cursor)?;
        stored.state.closed_responses.insert(
            commit.work.activation_id.clone(),
            commit.response_cursor.clone(),
        );
    }
    let result = commit_terminal_on(&mut tx, &mut stored, proof.terminal, routes, true).await?;
    if result {
        event(
            &mut tx,
            &mut stored.state,
            &current.system_start_id,
            None,
            "diagnostic",
            encode(&serde_json::json!({"nativeRecoveryEpoch":current.owner_epoch}))?,
        )
        .await?;
        save(&mut tx, &current.system_start_id, &stored.state).await?;
    }
    tx.commit().await?;
    Ok(result)
}

/// Native supervisor only. Epoch rotation never grants a replay of old effects.
pub(crate) async fn resume(
    pool: &SqlitePool,
    id: &str,
    available: &EngineVersions,
) -> Result<EngineOwner> {
    let mut c = pool.acquire().await?;
    let mut tx = durable(&mut c).await?;
    let mut stored = load(&mut tx, id).await?;
    if &stored.snapshot.versions != available {
        return Err(failure(
            "VERSION_UNAVAILABLE",
            "versions",
            "Captured engine versions are unavailable",
        ));
    }
    stored.state.epoch = next(&stored.state.epoch);
    invalidate_active(&mut tx, &mut stored).await?;
    save(&mut tx, id, &stored.state).await?;
    let owner = EngineOwner {
        system_start_id: id.into(),
        owner_epoch: stored.state.epoch,
    };
    tx.commit().await?;
    Ok(owner)
}
async fn invalidate_active(db: &mut SqliteConnection, stored: &mut Stored) -> Result<()> {
    let mut works = Vec::new();
    for a in stored.state.activations.values_mut() {
        if a.work_state == "active" || a.work_state == "uncertain" {
            a.work_state = "uncertain".into();
            works.push(a.delivery.delivery.work.clone());
            if let EngineStopState::Requested { request_id } = &a.stop_state {
                a.stop_state = EngineStopState::Uncertain {
                    request_id: request_id.clone(),
                    reason: "Native runtime disconnected".into(),
                };
            }
        }
    }
    sqlx::query(
        "UPDATE engine_effects SET status = 'uncertain' WHERE system_id = ? AND status = 'pending'",
    )
    .bind(&stored.snapshot.system_start_id)
    .execute(&mut *db)
    .await?;
    for work in works {
        event(
            db,
            &mut stored.state,
            &stored.snapshot.system_start_id,
            Some(work),
            "uncertain",
            "{\"runtimeDisconnected\":true}".into(),
        )
        .await?;
    }
    Ok(())
}
/// Revoke only the systems assigned to a lost physical host. Retries cannot
/// rotate a replacement owner's epoch or turn an unknown effect into a replay.
pub(crate) async fn revoke_host_owners(pool: &SqlitePool, owners: &[EngineOwner]) -> Result<()> {
    let mut connection = pool.acquire().await?;
    let mut tx = durable(&mut connection).await?;
    for retired in owners {
        let mut stored = load(&mut tx, &retired.system_start_id).await?;
        if stored.state.epoch != retired.owner_epoch {
            continue;
        }
        stored.state.epoch = next(&stored.state.epoch);
        invalidate_active(&mut tx, &mut stored).await?;
        save(&mut tx, &retired.system_start_id, &stored.state).await?;
    }
    tx.commit().await?;
    Ok(())
}
pub(crate) async fn reconcile_after_restart(pool: &SqlitePool) -> super::DbResult<()> {
    async fn reconcile(pool: &SqlitePool) -> Result<()> {
        let mut c = pool.acquire().await?;
        let mut tx = durable(&mut c).await?;
        let ids: Vec<String> = sqlx::query_scalar("SELECT system_id FROM engine_systems")
            .fetch_all(&mut *tx)
            .await?;
        for id in ids {
            let mut stored = load(&mut tx, &id).await?;
            stored.state.epoch = next(&stored.state.epoch);
            invalidate_active(&mut tx, &mut stored).await?;
            save(&mut tx, &id, &stored.state).await?;
        }
        tx.commit().await?;
        Ok(())
    }
    reconcile(pool)
        .await
        .map_err(|_| super::DbError::Validation("Execution recovery failed".into()))
}
pub(crate) async fn read_snapshot(pool: &SqlitePool, id: &str) -> Result<EngineSnapshot> {
    let mut c = pool.acquire().await?;
    Ok(load(&mut c, id).await?.snapshot)
}
pub(crate) async fn read_projection(pool: &SqlitePool, id: &str) -> Result<EngineProjection> {
    let mut c = pool.acquire().await?;
    let stored = load(&mut c, id).await?;
    Ok(EngineProjection {
        system_start_id: id.into(),
        cursor: stored.state.cursor,
        activations: stored.state.activations.into_values().collect(),
        system_stop: stored.state.stop,
    })
}
pub(crate) async fn read_events(
    pool: &SqlitePool,
    id: &str,
    after: Option<&str>,
    limit: u32,
) -> Result<EngineEventPage> {
    opaque(id)?;
    let after = after.unwrap_or("0");
    decimal(after)?;
    require(
        (1..=500).contains(&limit),
        "Event page limit is out of bounds",
    )?;
    // State and events must come from the same SQLite read snapshot.
    let mut c = pool.begin().await?;
    let stored = load(&mut c, id).await?;
    require(
        order(after, &stored.state.cursor).is_le(),
        "Event cursor is beyond retained events",
    )?;
    let rows:Vec<String>=sqlx::query_scalar("SELECT event_json FROM engine_events WHERE system_id = ? AND (length(sequence) > length(?) OR (length(sequence) = length(?) AND sequence > ?)) AND (length(sequence) < length(?) OR (length(sequence) = length(?) AND sequence <= ?)) ORDER BY length(sequence), sequence LIMIT ?").bind(id).bind(after).bind(after).bind(after).bind(&stored.state.cursor).bind(&stored.state.cursor).bind(&stored.state.cursor).bind(limit+1).fetch_all(&mut *c).await?;
    let has_more = rows.len() > limit as usize;
    let events = rows
        .into_iter()
        .take(limit as usize)
        .map(|raw| serde_json::from_str::<EngineEvent>(&raw).map_err(Into::into))
        .collect::<Result<Vec<_>>>()?;
    Ok(EngineEventPage {
        next_cursor: events
            .last()
            .map(|event| event.sequence.clone())
            .unwrap_or_else(|| after.into()),
        events,
        has_more,
    })
}

pub(crate) async fn read_agent(
    pool: &SqlitePool,
    system_id: &str,
    agent_instance_id: &str,
) -> Result<(EngineAgentConfiguration, Option<EngineMemory>)> {
    let mut c = pool.acquire().await?;
    let stored = load(&mut c, system_id).await?;
    let (name, state) = stored
        .state
        .agents
        .iter()
        .find(|(_, a)| a.id == agent_instance_id)
        .ok_or_else(|| failure("NOT_FOUND", "agentInstanceId", "Agent instance not found"))?;
    let configuration = stored
        .snapshot
        .agents
        .iter()
        .find(|a| &a.agent_name == name)
        .expect("frozen configuration")
        .clone();
    Ok((configuration, state.memory.clone()))
}
pub(crate) async fn read_visits(
    pool: &SqlitePool,
    system_id: &str,
    flow_invocation_id: &str,
) -> Result<Vec<(Vec<String>, String, Option<String>)>> {
    opaque(flow_invocation_id)?;
    let mut c = pool.acquire().await?;
    let stored = load(&mut c, system_id).await?;
    let mut visits = Vec::new();
    for p in stored.policies {
        let key = encode(&(flow_invocation_id, Some(&p.step)))?;
        visits.push((
            p.step,
            stored
                .state
                .visits
                .get(&key)
                .cloned()
                .unwrap_or_else(|| "0".into()),
            p.max_visits,
        ));
    }
    Ok(visits)
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PersistedEffect {
    pub registered: EngineEffect,
    pub status: String,
    pub settlement: Option<EngineSettlement>,
    pub result_json: Option<String>,
}
pub(crate) async fn read_effects(
    pool: &SqlitePool,
    work: &EngineWork,
) -> Result<Vec<PersistedEffect>> {
    let mut c = pool.acquire().await?;
    let stored = load(&mut c, &work.system_start_id).await?;
    activation(&stored.state, work)?;
    let rows=sqlx::query("SELECT record_json, status, settlement_json, result_json FROM engine_effects WHERE system_id = ? AND activation_id = ? ORDER BY effect_key").bind(&work.system_start_id).bind(&work.activation_id).fetch_all(&mut *c).await?;
    rows.into_iter()
        .map(|row| {
            Ok(PersistedEffect {
                registered: serde_json::from_str(row.get("record_json"))?,
                status: row.get("status"),
                settlement: row
                    .get::<Option<&str>, _>("settlement_json")
                    .map(serde_json::from_str)
                    .transpose()?,
                result_json: row.get("result_json"),
            })
        })
        .collect()
}
#[cfg(test)]
mod tests;

/// Called under the native host admission gate immediately before physical start.
/// A registered receipt alone is never authorization to redispatch.
pub(crate) async fn authorize_reserved_effect(
    pool: &SqlitePool,
    effect: &EngineEffect,
) -> Result<()> {
    let mut connection = pool.acquire().await?;
    let mut tx = connection.begin().await?;
    let stored = load(&mut tx, &effect.context.work.system_start_id).await?;
    context(&stored, &effect.context)?;
    let activation = activation(&stored.state, &effect.context.work)?;
    require(
        activation.work_state == "active"
            && matches!(activation.stop_state, EngineStopState::None)
            && matches!(stored.state.stop, EngineStopState::None),
        "Stopped work cannot physically dispatch",
    )?;
    let row = sqlx::query(
        "SELECT record_json,status FROM engine_effects WHERE system_id=? AND effect_key=?",
    )
    .bind(&effect.context.work.system_start_id)
    .bind(effect_key(&effect.effect)?)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| failure("CORRELATION", "effect", "Effect was not registered"))?;
    require(
        row.get::<&str, _>("status") == "pending"
            && record_equal(
                &serde_json::from_str::<EngineEffect>(row.get("record_json"))?,
                effect,
            )?,
        "Effect reservation changed or already ended",
    )?;
    tx.commit().await?;
    Ok(())
}

/// Native supervisor enumeration. Neither caller-supplied versions nor current UI settings enter recovery.
pub(crate) async fn retained_for_resume(
    pool: &SqlitePool,
    after: &str,
) -> Result<Vec<(EngineSnapshot, capture::PrivateCapture)>> {
    let mut connection = pool.acquire().await?;
    let mut tx = connection.begin().await?;
    let ids: Vec<String> = sqlx::query_scalar("SELECT s.system_id FROM engine_systems s JOIN engine_host_captures c ON c.system_id=s.system_id WHERE s.system_id > ? ORDER BY s.system_id LIMIT 100")
        .bind(after).fetch_all(&mut *tx).await?;
    let mut result = Vec::new();
    for id in ids {
        let stored = load(&mut tx, &id).await?;
        if let Some(capture) = stored.capture {
            result.push((stored.snapshot, capture));
        }
    }
    tx.commit().await?;
    Ok(result)
}
