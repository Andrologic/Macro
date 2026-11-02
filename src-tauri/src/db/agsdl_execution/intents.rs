//! Durable product intent protocol. Admission authority remains native.
use super::*;
use crate::agsdl_host_capture::ExecutionExternalDelivery;
use public::PublicStartReceipt;

macro_rules! object {
    ($name:ident {$($field:ident: $ty:ty),* $(,)?}) => {
        #[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name { $(pub $field: $ty),* }
    };
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionIntentScope {
    pub owner: EngineSourceOwner,
    pub conversation_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionIntentKey {
    pub scope: ExecutionIntentScope,
    pub intent_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
pub enum ExecutionIntentFormatVersion {
    #[serde(rename = "1")]
    V1,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ExecutionIntentPayload {
    Start {
        request: EngineStartRequest,
    },
    Deliver {
        source: EngineSourceRevision,
        request: ExecutionExternalDelivery,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ExecutionIntentAdmission {
    Start { receipt: PublicStartReceipt },
    Deliver { receipt: EngineAcceptedDelivery },
}
macro_rules! codes {
    ($name:ident {$($variant:ident),*}) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
        #[serde(rename_all = "SCREAMING_SNAKE_CASE")]
        pub enum $name { $($variant),* }
    };
}
codes!(ExecutionIntentRefusalCode {
    ScopeInvalid,
    SourceChanged,
    TargetInvalid,
    TargetClosed,
    InputConstraint
});
codes!(ExecutionIntentRetryableCode {
    RuntimeUnavailable,
    CaptureChanged,
    PolicyUnavailable,
    ScopeUnavailable,
    ExecutionUnavailable
});
codes!(ExecutionIntentErrorCode {
    InvalidRequest,
    InputLimit,
    ScopeInvalid,
    ScopeUnavailable,
    IdentityConflict,
    SlotOccupied,
    RevisionConflict,
    SubmissionInProgress,
    NotFound,
    CloseConflict,
    StorageUncertain,
    RuntimeUnavailable
});
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub enum ExecutionIntentDisposition {
    Acknowledged,
    Discarded,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ExecutionIntentState {
    Prepared,
    SubmissionPending {
        retryable_failure: Option<ExecutionIntentRetryableCode>,
    },
    Admitted {
        admission: ExecutionIntentAdmission,
    },
    Refused {
        code: ExecutionIntentRefusalCode,
    },
    Closed {
        disposition: ExecutionIntentDisposition,
        admission: Option<ExecutionIntentAdmission>,
    },
}
object!(PublicExecutionIntent {
    format_version: ExecutionIntentFormatVersion,
    key: ExecutionIntentKey,
    revision: String,
    payload: ExecutionIntentPayload,
    state: ExecutionIntentState
});
object!(ExecutionStageIntentRequest {
    scope: ExecutionIntentScope,
    intent_id: String,
    payload: ExecutionIntentPayload
});
object!(ExecutionReadIntentsRequest {
    scope: ExecutionIntentScope
});
object!(ExecutionCloseIntentRequest {
    key: ExecutionIntentKey,
    expected_revision: String,
    disposition: ExecutionIntentDisposition
});
object!(ExecutionEnsureStopRequest {system_start_id: String, activation_id: Option<String>});
object!(ExecutionIntentError {code: ExecutionIntentErrorCode, current_intent_key: Option<ExecutionIntentKey>});
pub(crate) type IntentResult<T> = std::result::Result<T, ExecutionIntentError>;
pub(crate) fn error(code: ExecutionIntentErrorCode) -> ExecutionIntentError {
    ExecutionIntentError {
        code,
        current_intent_key: None,
    }
}
impl From<sqlx::Error> for ExecutionIntentError {
    fn from(_: sqlx::Error) -> Self {
        error(ExecutionIntentErrorCode::StorageUncertain)
    }
}
impl From<serde_json::Error> for ExecutionIntentError {
    fn from(_: serde_json::Error) -> Self {
        error(ExecutionIntentErrorCode::StorageUncertain)
    }
}

pub(crate) fn validate_key(key: &ExecutionIntentKey) -> IntentResult<()> {
    use ExecutionIntentErrorCode::*;
    for value in [
        &key.intent_id,
        &key.scope.owner.project_id,
        &key.scope.owner.plan_id,
        &key.scope.owner.branch,
        &key.scope.conversation_id,
    ] {
        if value.len() > 512 {
            return Err(error(InputLimit));
        }
        opaque(value).map_err(|_| error(InvalidRequest))?;
    }
    let owner = &key.scope.owner;
    if owner.branch.trim() != owner.branch
        || owner.branch.contains('\\')
        || owner
            .branch
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || owner.plan_id.trim() != owner.plan_id
        || owner.plan_id.contains(['/', '\\'])
        || [".", ".."].contains(&owner.plan_id.as_str())
    {
        return Err(error(InvalidRequest));
    }
    Ok(())
}
fn revision(value: &str) -> IntentResult<()> {
    if value.len() > 4096 {
        return Err(error(ExecutionIntentErrorCode::InputLimit));
    }
    decimal(value).map_err(|_| error(ExecutionIntentErrorCode::InvalidRequest))
}
fn advance(value: &str) -> IntentResult<String> {
    let next = next(value);
    revision(&next)?;
    Ok(next)
}
fn source(payload: &ExecutionIntentPayload) -> &EngineSourceRevision {
    match payload {
        ExecutionIntentPayload::Start { request } => &request.source,
        ExecutionIntentPayload::Deliver { source, .. } => source,
    }
}
fn keys(payload: &ExecutionIntentPayload) -> (Option<&str>, Option<&str>) {
    match payload {
        ExecutionIntentPayload::Start { request } => (
            Some(&request.request_id),
            request
                .entry
                .as_ref()
                .map(|entry| entry.delivery_id.as_str()),
        ),
        ExecutionIntentPayload::Deliver { request, .. } => (None, Some(&request.delivery_id)),
    }
}
fn validate_payload(
    key: &ExecutionIntentKey,
    payload: &ExecutionIntentPayload,
) -> IntentResult<String> {
    use ExecutionIntentErrorCode::*;
    validate_key(key)?;
    let source = source(payload);
    if source.owner != key.scope.owner {
        return Err(error(InvalidRequest));
    }
    revision(&source.revision)?;
    if source.source_sha256.len() != 64
        || !source
            .source_sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(error(InvalidRequest));
    }
    let (request_id, delivery_id) = keys(payload);
    for value in [request_id, delivery_id].into_iter().flatten() {
        if value.len() > 512 {
            return Err(error(InputLimit));
        }
        opaque(value).map_err(|_| error(InvalidRequest))?;
    }
    let message = match payload {
        ExecutionIntentPayload::Start { request } => {
            if request.profile != "macro-serial-inline-v1"
                || request.associations.workspace_id.is_some()
                || request.associations.conversation_id.is_some()
            {
                return Err(error(InvalidRequest));
            }
            if let Some(task_id) = &request.associations.task_id {
                if task_id.len() > 512 {
                    return Err(error(InputLimit));
                }
                opaque(task_id).map_err(|_| error(InvalidRequest))?;
            }
            request.entry.as_ref().map(|entry| &entry.message_json)
        }
        ExecutionIntentPayload::Deliver { request, .. } => {
            for value in [&request.agent_name, &request.system_start_id] {
                if value.len() > 512 {
                    return Err(error(InputLimit));
                }
                opaque(value).map_err(|_| error(InvalidRequest))?;
            }
            Some(&request.message_json)
        }
    };
    if let Some(message) = message {
        if message.len() > 1_000_000 {
            return Err(error(InputLimit));
        }
        validate_json(message).map_err(|_| error(InvalidRequest))?;
    }
    let encoded = serde_json::to_string(payload)?;
    if encoded.len() > 4_000_000 {
        return Err(error(InputLimit));
    }
    Ok(encoded)
}

struct Retained {
    key: ExecutionIntentKey,
    payload: ExecutionIntentPayload,
    revision: String,
    status: String,
    retryable: Option<ExecutionIntentRetryableCode>,
    refusal: Option<ExecutionIntentRefusalCode>,
    disposition: Option<ExecutionIntentDisposition>,
    admitted: Option<String>,
}
fn parse_code<T: serde::de::DeserializeOwned>(value: Option<String>) -> IntentResult<Option<T>> {
    value
        .map(|value| serde_json::from_value(serde_json::Value::String(value)))
        .transpose()
        .map_err(Into::into)
}
fn retained(row: sqlx::sqlite::SqliteRow) -> IntentResult<Retained> {
    Ok(Retained {
        key: ExecutionIntentKey {
            intent_id: row.get("intent_id"),
            scope: ExecutionIntentScope {
                owner: EngineSourceOwner {
                    project_id: row.get("project_id"),
                    plan_id: row.get("plan_id"),
                    branch: row.get("branch"),
                },
                conversation_id: row.get("conversation_id"),
            },
        },
        payload: serde_json::from_str(row.get("payload_json"))?,
        revision: row.get("revision"),
        status: row.get("status"),
        retryable: parse_code(row.get("retryable_code"))?,
        refusal: parse_code(row.get("refusal_code"))?,
        disposition: parse_code(row.get("disposition"))?,
        admitted: row.get("admission_system_id"),
    })
}
async fn find(
    db: &mut SqliteConnection,
    key: &ExecutionIntentKey,
) -> IntentResult<Option<Retained>> {
    let row = sqlx::query("SELECT * FROM engine_ui_intents WHERE intent_id = ? AND project_id = ? AND plan_id = ? AND branch = ? AND conversation_id = ?")
        .bind(&key.intent_id).bind(&key.scope.owner.project_id).bind(&key.scope.owner.plan_id).bind(&key.scope.owner.branch).bind(&key.scope.conversation_id)
        .fetch_optional(db).await?;
    row.map(retained).transpose()
}
pub(crate) async fn conversation(
    db: &mut SqliteConnection,
    scope: &ExecutionIntentScope,
) -> IntentResult<()> {
    let project: Option<String> =
        sqlx::query_scalar("SELECT project_id FROM conversations WHERE id = ?")
            .bind(&scope.conversation_id)
            .fetch_optional(db)
            .await?;
    if project.as_deref() != Some(&scope.owner.project_id) {
        return Err(error(ExecutionIntentErrorCode::ScopeInvalid));
    }
    Ok(())
}
fn storage(_: EngineFailure) -> ExecutionIntentError {
    error(ExecutionIntentErrorCode::StorageUncertain)
}
async fn public(db: &mut SqliteConnection, row: Retained) -> IntentResult<PublicExecutionIntent> {
    let admission = if let Some(system) = &row.admitted {
        let stored = load(db, system).await.map_err(storage)?;
        if stored.snapshot.source != *source(&row.payload) {
            return Err(error(ExecutionIntentErrorCode::StorageUncertain));
        }
        Some(match &row.payload {
            ExecutionIntentPayload::Start { request } => {
                let actual: String = sqlx::query_scalar("SELECT request_json FROM engine_systems WHERE system_id = ? AND request_id = ?")
                    .bind(system).bind(&request.request_id).fetch_one(&mut *db).await?;
                if actual != serde_json::to_string(request)? {
                    return Err(error(ExecutionIntentErrorCode::StorageUncertain));
                }
                ExecutionIntentAdmission::Start {
                    receipt: EngineStartReceipt {
                        system_start_id: system.clone(),
                        flow_invocation_id: stored.state.invocation_id,
                        snapshot: stored.snapshot,
                    }
                    .into(),
                }
            }
            ExecutionIntentPayload::Deliver { request, .. } => {
                let actual: String = sqlx::query_scalar("SELECT receipt_json FROM engine_deliveries WHERE delivery_id = ? AND system_id = ?")
                    .bind(&request.delivery_id).bind(system).fetch_one(&mut *db).await?;
                let receipt: EngineAcceptedDelivery = serde_json::from_str(&actual)?;
                let agent = stored
                    .state
                    .agents
                    .get(&request.agent_name)
                    .ok_or_else(|| error(ExecutionIntentErrorCode::StorageUncertain))?;
                if request.system_start_id != *system
                    || receipt.delivery.input.value_json != request.message_json
                    || receipt.delivery.work.agent_instance_id.as_deref() != Some(&agent.id)
                {
                    return Err(error(ExecutionIntentErrorCode::StorageUncertain));
                }
                ExecutionIntentAdmission::Deliver { receipt }
            }
        })
    } else {
        None
    };
    let state = match row.status.as_str() {
        "prepared" => ExecutionIntentState::Prepared,
        "submissionPending" => ExecutionIntentState::SubmissionPending {
            retryable_failure: row.retryable,
        },
        "admitted" => ExecutionIntentState::Admitted {
            admission: admission
                .ok_or_else(|| error(ExecutionIntentErrorCode::StorageUncertain))?,
        },
        "refused" => ExecutionIntentState::Refused {
            code: row
                .refusal
                .ok_or_else(|| error(ExecutionIntentErrorCode::StorageUncertain))?,
        },
        "closed" => ExecutionIntentState::Closed {
            disposition: row
                .disposition
                .ok_or_else(|| error(ExecutionIntentErrorCode::StorageUncertain))?,
            admission,
        },
        _ => return Err(error(ExecutionIntentErrorCode::StorageUncertain)),
    };
    Ok(PublicExecutionIntent {
        format_version: ExecutionIntentFormatVersion::V1,
        key: row.key,
        revision: row.revision,
        payload: row.payload,
        state,
    })
}
async fn absence(db: &mut SqliteConnection, payload: &ExecutionIntentPayload) -> IntentResult<()> {
    let (request_id, delivery_id) = keys(payload);
    let admitted: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM engine_systems WHERE request_id = ?) OR EXISTS(SELECT 1 FROM engine_deliveries WHERE delivery_id = ?)")
        .bind(request_id).bind(delivery_id).fetch_one(db).await?;
    if admitted != 0 {
        return Err(error(ExecutionIntentErrorCode::IdentityConflict));
    }
    Ok(())
}
async fn target(
    db: &mut SqliteConnection,
    payload: &ExecutionIntentPayload,
) -> IntentResult<Option<ExecutionIntentRefusalCode>> {
    if let ExecutionIntentPayload::Deliver { source, request } = payload {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM engine_systems WHERE system_id = ?)")
                .bind(&request.system_start_id)
                .fetch_one(&mut *db)
                .await?;
        if !exists {
            return Ok(Some(ExecutionIntentRefusalCode::TargetInvalid));
        }
        let stored = load(db, &request.system_start_id).await.map_err(storage)?;
        if stored.snapshot.source != *source
            || !stored.policies.is_empty()
            || !stored.state.agents.contains_key(&request.agent_name)
        {
            return Ok(Some(ExecutionIntentRefusalCode::TargetInvalid));
        }
        if !matches!(stored.state.stop, EngineStopState::None) {
            return Ok(Some(ExecutionIntentRefusalCode::TargetClosed));
        }
    }
    Ok(None)
}
#[cfg(test)]
pub(crate) async fn stage(
    pool: &SqlitePool,
    request: ExecutionStageIntentRequest,
    current: &EngineSourceRevision,
) -> IntentResult<PublicExecutionIntent> {
    stage_current(pool, request, current, true).await
}
pub(crate) async fn stage_current(
    pool: &SqlitePool,
    request: ExecutionStageIntentRequest,
    current: &EngineSourceRevision,
    consistent: bool,
) -> IntentResult<PublicExecutionIntent> {
    let key = ExecutionIntentKey {
        scope: request.scope,
        intent_id: request.intent_id,
    };
    let payload_json = validate_payload(&key, &request.payload)?;
    let mut connection = pool.acquire().await?;
    let mut tx = durable(&mut connection).await.map_err(storage)?;
    conversation(&mut tx, &key.scope).await?;
    if let Some(row) = find(&mut tx, &key).await? {
        if serde_json::to_string(&row.payload)? != payload_json {
            return Err(error(ExecutionIntentErrorCode::IdentityConflict));
        }
        let result = public(&mut tx, row).await?;
        tx.commit().await?;
        return Ok(result);
    }
    let identity: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM engine_ui_intents WHERE intent_id = ?)")
            .bind(&key.intent_id)
            .fetch_one(&mut *tx)
            .await?;
    if identity {
        return Err(error(ExecutionIntentErrorCode::IdentityConflict));
    }
    if let Some(row) = sqlx::query("SELECT * FROM engine_ui_intents WHERE project_id = ? AND plan_id = ? AND branch = ? AND conversation_id = ? AND status <> 'closed'")
        .bind(&key.scope.owner.project_id).bind(&key.scope.owner.plan_id).bind(&key.scope.owner.branch).bind(&key.scope.conversation_id).fetch_optional(&mut *tx).await? {
        return Err(ExecutionIntentError {code: ExecutionIntentErrorCode::SlotOccupied, current_intent_key: Some(retained(row)?.key)});
    }
    let (request_id, delivery_id) = keys(&request.payload);
    let reserved: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM engine_ui_intents WHERE request_id = ? OR delivery_id = ?)",
    )
    .bind(request_id)
    .bind(delivery_id)
    .fetch_one(&mut *tx)
    .await?;
    if reserved {
        return Err(error(ExecutionIntentErrorCode::IdentityConflict));
    }
    absence(&mut tx, &request.payload).await?;
    if matches!(&request.payload, ExecutionIntentPayload::Start { .. }) && !consistent {
        return Err(error(ExecutionIntentErrorCode::ScopeUnavailable));
    }
    if matches!(&request.payload, ExecutionIntentPayload::Start { .. })
        && source(&request.payload) != current
    {
        return Err(error(ExecutionIntentErrorCode::InvalidRequest));
    }
    if target(&mut tx, &request.payload).await?.is_some() {
        return Err(error(ExecutionIntentErrorCode::InvalidRequest));
    }
    let kind = match request.payload {
        ExecutionIntentPayload::Start { .. } => "start",
        ExecutionIntentPayload::Deliver { .. } => "deliver",
    };
    sqlx::query("INSERT INTO engine_ui_intents(intent_id,format_version,project_id,plan_id,branch,conversation_id,kind,request_id,delivery_id,payload_json,status,revision) VALUES(?,'1',?,?,?,?,?,?,?,?,'prepared','1')")
        .bind(&key.intent_id).bind(&key.scope.owner.project_id).bind(&key.scope.owner.plan_id).bind(&key.scope.owner.branch).bind(&key.scope.conversation_id).bind(kind).bind(request_id).bind(delivery_id).bind(payload_json)
        .execute(&mut *tx).await?;
    let row = find(&mut tx, &key)
        .await?
        .ok_or_else(|| error(ExecutionIntentErrorCode::StorageUncertain))?;
    let result = public(&mut tx, row).await?;
    tx.commit().await?;
    Ok(result)
}
pub(crate) async fn read(
    pool: &SqlitePool,
    key: &ExecutionIntentKey,
) -> IntentResult<Option<PublicExecutionIntent>> {
    validate_key(key)?;
    let mut connection = pool.acquire().await?;
    let mut tx = durable(&mut connection).await.map_err(storage)?;
    conversation(&mut tx, &key.scope).await?;
    let result = match find(&mut tx, key).await? {
        Some(row) => Some(public(&mut tx, row).await?),
        None => None,
    };
    tx.commit().await?;
    Ok(result)
}
pub(crate) async fn read_open(
    pool: &SqlitePool,
    scope: &ExecutionIntentScope,
) -> IntentResult<Vec<PublicExecutionIntent>> {
    validate_key(&ExecutionIntentKey {
        scope: scope.clone(),
        intent_id: "scope-read".into(),
    })?;
    let mut connection = pool.acquire().await?;
    let mut tx = durable(&mut connection).await.map_err(storage)?;
    conversation(&mut tx, scope).await?;
    let rows = sqlx::query("SELECT * FROM engine_ui_intents WHERE project_id = ? AND plan_id = ? AND branch = ? AND conversation_id = ? AND status <> 'closed' LIMIT 2")
        .bind(&scope.owner.project_id).bind(&scope.owner.plan_id).bind(&scope.owner.branch).bind(&scope.conversation_id).fetch_all(&mut *tx).await?;
    if rows.len() > 1 {
        return Err(error(ExecutionIntentErrorCode::StorageUncertain));
    }
    let mut result = Vec::new();
    for row in rows {
        result.push(public(&mut tx, retained(row)?).await?);
    }
    tx.commit().await?;
    Ok(result)
}
fn code<T: Serialize>(value: T) -> IntentResult<String> {
    serde_json::from_value(serde_json::to_value(value)?).map_err(Into::into)
}
async fn update(
    db: &mut SqliteConnection,
    row: &Retained,
    status: &str,
    retryable: Option<ExecutionIntentRetryableCode>,
    refusal: Option<ExecutionIntentRefusalCode>,
    disposition: Option<ExecutionIntentDisposition>,
    admitted: Option<&str>,
) -> IntentResult<()> {
    let revision = advance(&row.revision)?;
    sqlx::query("UPDATE engine_ui_intents SET status = ?, revision = ?, retryable_code = ?, refusal_code = ?, disposition = ?, admission_system_id = ? WHERE intent_id = ? AND revision = ? AND status <> 'closed'")
        .bind(status).bind(revision).bind(retryable.map(code).transpose()?).bind(refusal.map(code).transpose()?).bind(disposition.map(code).transpose()?).bind(admitted).bind(&row.key.intent_id).bind(&row.revision)
        .execute(db).await?;
    Ok(())
}
/// Not deserializable and never exposed over IPC.
pub(crate) struct IntentAdmissionLink {
    pub(crate) key: ExecutionIntentKey,
    pub(crate) payload: ExecutionIntentPayload,
}
pub(crate) enum Submission {
    Retained(PublicExecutionIntent),
    Dispatch(IntentAdmissionLink),
}
#[cfg(test)]
pub(crate) async fn begin_submission(
    pool: &SqlitePool,
    key: &ExecutionIntentKey,
    current: &EngineSourceRevision,
) -> IntentResult<Submission> {
    begin_submission_current(pool, key, current, true).await
}
pub(crate) async fn begin_submission_current(
    pool: &SqlitePool,
    key: &ExecutionIntentKey,
    current: &EngineSourceRevision,
    consistent: bool,
) -> IntentResult<Submission> {
    let mut connection = pool.acquire().await?;
    let mut tx = durable(&mut connection).await.map_err(storage)?;
    conversation(&mut tx, &key.scope).await?;
    let row = find(&mut tx, key)
        .await?
        .ok_or_else(|| error(ExecutionIntentErrorCode::NotFound))?;
    if !["prepared", "submissionPending"].contains(&row.status.as_str()) {
        let result = public(&mut tx, row).await?;
        tx.commit().await?;
        return Ok(Submission::Retained(result));
    }
    if matches!(&row.payload, ExecutionIntentPayload::Start { .. }) && !consistent {
        return Err(error(ExecutionIntentErrorCode::ScopeUnavailable));
    }
    // A pending row can only have an admission through the atomic link below.
    absence(&mut tx, &row.payload).await?;
    let refusal = if matches!(row.payload, ExecutionIntentPayload::Start { .. })
        && source(&row.payload) != current
    {
        Some(ExecutionIntentRefusalCode::SourceChanged)
    } else {
        target(&mut tx, &row.payload).await?
    };
    if let Some(refusal) = refusal {
        update(&mut tx, &row, "refused", None, Some(refusal), None, None).await?;
        let row = find(&mut tx, key)
            .await?
            .ok_or_else(|| error(ExecutionIntentErrorCode::StorageUncertain))?;
        let result = public(&mut tx, row).await?;
        tx.commit().await?;
        return Ok(Submission::Retained(result));
    }
    if row.status != "submissionPending" || row.retryable.is_some() {
        update(&mut tx, &row, "submissionPending", None, None, None, None).await?;
    }
    let link = IntentAdmissionLink {
        key: row.key,
        payload: row.payload,
    };
    tx.commit().await?;
    Ok(Submission::Dispatch(link))
}
#[cfg(test)]
pub(crate) async fn finish_failure(
    pool: &SqlitePool,
    key: &ExecutionIntentKey,
    failure: &EngineFailure,
) -> IntentResult<PublicExecutionIntent> {
    finish_failure_current(pool, key, failure, None).await
}
pub(crate) async fn finish_failure_current(
    pool: &SqlitePool,
    key: &ExecutionIntentKey,
    failure: &EngineFailure,
    current: Option<&EngineSourceRevision>,
) -> IntentResult<PublicExecutionIntent> {
    let mut connection = pool.acquire().await?;
    let mut tx = durable(&mut connection).await.map_err(storage)?;
    conversation(&mut tx, &key.scope).await?;
    let row = find(&mut tx, key)
        .await?
        .ok_or_else(|| error(ExecutionIntentErrorCode::NotFound))?;
    if row.status != "admitted" {
        if failure.code == "STORAGE" {
            return Err(error(ExecutionIntentErrorCode::StorageUncertain));
        }
        absence(&mut tx, &row.payload).await?;
        let proven_refusal = if matches!(&row.payload, ExecutionIntentPayload::Start { .. })
            && current.is_some_and(|current| current != source(&row.payload))
        {
            Some(ExecutionIntentRefusalCode::SourceChanged)
        } else {
            target(&mut tx, &row.payload).await?
        };
        let (retryable, refusal) = if proven_refusal.is_some() {
            (None, proven_refusal)
        } else {
            match failure.code.as_str() {
                "INPUT_CONSTRAINT" => (None, Some(ExecutionIntentRefusalCode::InputConstraint)),
                "INTENT_SOURCE_CHANGED" => (None, Some(ExecutionIntentRefusalCode::SourceChanged)),
                "CAPTURE_CHANGED" => (Some(ExecutionIntentRetryableCode::CaptureChanged), None),
                "POLICY_UNAVAILABLE" | "PERMISSION" => {
                    (Some(ExecutionIntentRetryableCode::PolicyUnavailable), None)
                }
                "SOURCE_UNAVAILABLE" | "INTENT_SCOPE_UNAVAILABLE" => {
                    (Some(ExecutionIntentRetryableCode::ScopeUnavailable), None)
                }
                "RUNTIME_UNAVAILABLE" => {
                    (Some(ExecutionIntentRetryableCode::RuntimeUnavailable), None)
                }
                _ => (
                    Some(ExecutionIntentRetryableCode::ExecutionUnavailable),
                    None,
                ),
            }
        };
        if row.retryable != retryable || row.refusal != refusal {
            update(
                &mut tx,
                &row,
                if refusal.is_some() {
                    "refused"
                } else {
                    "submissionPending"
                },
                retryable,
                refusal,
                None,
                None,
            )
            .await?;
        }
    }
    let row = find(&mut tx, key)
        .await?
        .ok_or_else(|| error(ExecutionIntentErrorCode::StorageUncertain))?;
    let result = public(&mut tx, row).await?;
    tx.commit().await?;
    Ok(result)
}
pub(crate) async fn close(
    pool: &SqlitePool,
    request: &ExecutionCloseIntentRequest,
) -> IntentResult<PublicExecutionIntent> {
    validate_key(&request.key)?;
    revision(&request.expected_revision)?;
    let mut connection = pool.acquire().await?;
    let mut tx = durable(&mut connection).await.map_err(storage)?;
    conversation(&mut tx, &request.key.scope).await?;
    let row = find(&mut tx, &request.key)
        .await?
        .ok_or_else(|| error(ExecutionIntentErrorCode::NotFound))?;
    if row.status == "closed" {
        if row.disposition != Some(request.disposition) {
            return Err(error(ExecutionIntentErrorCode::CloseConflict));
        }
        let result = public(&mut tx, row).await?;
        tx.commit().await?;
        return Ok(result);
    }
    if row.revision != request.expected_revision {
        return Err(error(ExecutionIntentErrorCode::RevisionConflict));
    }
    match request.disposition {
        ExecutionIntentDisposition::Acknowledged if row.status != "admitted" => {
            return Err(error(ExecutionIntentErrorCode::CloseConflict))
        }
        ExecutionIntentDisposition::Discarded => {
            if row.admitted.is_some() {
                return Err(error(ExecutionIntentErrorCode::CloseConflict));
            }
            absence(&mut tx, &row.payload).await?;
        }
        _ => (),
    }
    update(
        &mut tx,
        &row,
        "closed",
        None,
        None,
        Some(request.disposition),
        row.admitted.as_deref(),
    )
    .await?;
    let row = find(&mut tx, &request.key)
        .await?
        .ok_or_else(|| error(ExecutionIntentErrorCode::StorageUncertain))?;
    let result = public(&mut tx, row).await?;
    tx.commit().await?;
    Ok(result)
}

async fn reserved(
    db: &mut SqliteConnection,
    column: &str,
    value: &str,
    link: Option<&IntentAdmissionLink>,
) -> Result<()> {
    let query = match column {
        "request_id" => "SELECT * FROM engine_ui_intents WHERE request_id = ?",
        _ => "SELECT * FROM engine_ui_intents WHERE delivery_id = ?",
    };
    let row = sqlx::query(query)
        .bind(value)
        .fetch_optional(&mut *db)
        .await?;
    if let Some(row) = row {
        let row = retained(row).map_err(|_| failure("STORAGE", "", "Invalid retained intent"))?;
        let link = link.ok_or_else(|| {
            failure(
                "INTENT_IDENTITY_CONFLICT",
                "",
                "Execution identity is reserved",
            )
        })?;
        require(
            row.key == link.key
                && serde_json::to_string(&row.payload)? == serde_json::to_string(&link.payload)?,
            "Intent admission link does not match reservation",
        )?;
        require(
            row.status == "submissionPending"
                || row.status == "admitted"
                || (row.status == "closed"
                    && row.disposition == Some(ExecutionIntentDisposition::Acknowledged)),
            "Intent does not allow admission",
        )?;
        conversation(db, &row.key.scope).await.map_err(|_| {
            failure(
                "INTENT_SCOPE_INVALID",
                "",
                "Intent conversation is no longer valid",
            )
        })?;
    } else if link.is_some() {
        return Err(failure(
            "INTENT_IDENTITY_CONFLICT",
            "",
            "Intent admission reservation is absent",
        ));
    }
    Ok(())
}
pub(crate) async fn reserve_start(
    db: &mut SqliteConnection,
    request: &EngineStartRequest,
    link: Option<&IntentAdmissionLink>,
) -> Result<()> {
    if let Some(link) = link {
        require(
            matches!(&link.payload,ExecutionIntentPayload::Start{request: retained} if retained == request),
            "Wrong Start admission link",
        )?;
    }
    reserved(db, "request_id", &request.request_id, link).await?;
    if let Some(entry) = &request.entry {
        reserved(db, "delivery_id", &entry.delivery_id, link).await?;
    }
    Ok(())
}
pub(super) async fn reserve_delivery(
    db: &mut SqliteConnection,
    delivery: &EngineDelivery,
    stored: &Stored,
    link: Option<&IntentAdmissionLink>,
) -> Result<()> {
    if let Some(link) = link {
        require(
            source(&link.payload) == &stored.snapshot.source,
            "Delivery admission source differs",
        )?;
        let matches = match &link.payload {
            ExecutionIntentPayload::Start { request } => {
                request.entry.as_ref().is_some_and(|entry| {
                    entry.delivery_id == delivery.delivery_id
                        && entry.message_json == delivery.input.value_json
                })
            }
            ExecutionIntentPayload::Deliver { request, .. } => {
                request.system_start_id == delivery.work.system_start_id
                    && request.delivery_id == delivery.delivery_id
                    && request.message_json == delivery.input.value_json
                    && stored
                        .state
                        .agents
                        .get(&request.agent_name)
                        .is_some_and(|agent| {
                            delivery.work.agent_instance_id.as_deref() == Some(&agent.id)
                        })
                    && delivery.work.step.is_none()
            }
        };
        require(matches, "Wrong delivery admission link")?;
    }
    reserved(db, "delivery_id", &delivery.delivery_id, link).await
}
pub(crate) async fn attach(
    db: &mut SqliteConnection,
    link: &IntentAdmissionLink,
    system: &str,
) -> Result<()> {
    let row = find(db, &link.key)
        .await
        .map_err(|_| failure("STORAGE", "", "Cannot read intent admission"))?
        .ok_or_else(|| failure("INTENT_IDENTITY_CONFLICT", "", "Missing intent"))?;
    conversation(db, &row.key.scope).await.map_err(|_| {
        failure(
            "INTENT_SCOPE_INVALID",
            "",
            "Intent conversation is no longer valid",
        )
    })?;
    if let Some(admitted) = &row.admitted {
        require(admitted == system, "Conflicting intent admission")?;
        return Ok(());
    }
    require(
        row.status == "submissionPending",
        "First intent admission must be pending",
    )?;
    update(db, &row, "admitted", None, None, None, Some(system))
        .await
        .map_err(|_| failure("STORAGE", "", "Cannot attach intent admission"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn staged() -> ExecutionStageIntentRequest {
        let owner = EngineSourceOwner {
            project_id: "project".into(),
            plan_id: "plan".into(),
            branch: "feature/synthetic".into(),
        };
        ExecutionStageIntentRequest {
            scope: ExecutionIntentScope {
                owner: owner.clone(),
                conversation_id: "conversation".into(),
            },
            intent_id: "intent".into(),
            payload: ExecutionIntentPayload::Start {
                request: EngineStartRequest {
                    source: EngineSourceRevision {
                        owner,
                        revision: "9007199254740993".into(),
                        source_sha256: "a".repeat(64),
                    },
                    profile: "macro-serial-inline-v1".into(),
                    associations: EngineAssociations::default(),
                    request_id: "start".into(),
                    entry: Some(EngineEntry {
                        delivery_id: "delivery".into(),
                        message_json: "{\"n\":1.0}".into(),
                    }),
                },
            },
        }
    }
    #[test]
    fn intent_validation_bounds_exact_json_and_canonical_path_identities() {
        let initial = staged();
        let key = ExecutionIntentKey {
            scope: initial.scope,
            intent_id: initial.intent_id,
        };
        assert!(validate_payload(&key, &initial.payload).is_ok());
        for branch in [
            " feature/x",
            "feature/x ",
            "feature//x",
            "/feature/x",
            "feature/x/",
            "feature/../x",
            "feature/./x",
            "feature\\x",
        ] {
            let mut key = key.clone();
            key.scope.owner.branch = branch.into();
            assert_eq!(
                validate_key(&key).unwrap_err().code,
                ExecutionIntentErrorCode::InvalidRequest
            );
        }
        let mut excessive = key.clone();
        excessive.intent_id = "é".repeat(257);
        assert_eq!(
            validate_key(&excessive).unwrap_err().code,
            ExecutionIntentErrorCode::InputLimit
        );
        assert_eq!(
            advance(&"9".repeat(4096)).unwrap_err().code,
            ExecutionIntentErrorCode::InputLimit
        );
        assert_eq!(advance("9007199254740993").unwrap(), "9007199254740994");
        let mut payload = initial.payload;
        let ExecutionIntentPayload::Start { request } = &mut payload else {
            unreachable!()
        };
        request.entry.as_mut().unwrap().message_json = "{\"n\":1,\"n\":2}".into();
        assert_eq!(
            validate_payload(&key, &payload).unwrap_err().code,
            ExecutionIntentErrorCode::InvalidRequest
        );
        let ExecutionIntentPayload::Start { request } = &mut payload else {
            unreachable!()
        };
        request.entry.as_mut().unwrap().message_json =
            serde_json::to_string(&"é".repeat(500000)).unwrap();
        assert_eq!(
            validate_payload(&key, &payload).unwrap_err().code,
            ExecutionIntentErrorCode::InputLimit
        );
        let mut unknown = serde_json::to_value(staged()).unwrap();
        unknown["workspacePath"] = "untrusted".into();
        assert!(serde_json::from_value::<ExecutionStageIntentRequest>(unknown).is_err());
    }
}
