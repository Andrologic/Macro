//! Native-only Start 0.3. The caller provides authenticated capture and authority;
//! neither this module nor its inputs are an IPC contract.
use super::{
    decimal,
    dto::{EngineSourceRevision, EngineStartRequest, EngineVersions},
    failure,
    flow030::{FlowEvent030, FlowEventKind030, FlowIdentity030, FlowPlan030, FlowReceipt030},
    flow_store030::{self, Apply030, Authority030, StoreError030},
    json_lexemes030::document_tokens_equal,
    opaque, validate_json, Result,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row, SqliteConnection, SqlitePool};

/// Built exclusively by the native capture owner. The host must exclude secrets.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StartCapture030 {
    pub identity: FlowIdentity030,
    pub source: EngineSourceRevision,
    pub versions: EngineVersions,
    pub authored_source: String,
    pub compiled_plan_json: String,
    pub registry_json: String,
    pub private_capture_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StartReceipt030 {
    pub identity: FlowIdentity030,
    pub enter: Option<FlowReceipt030>,
}

#[derive(Debug, Clone)]
pub(super) struct RetainedStart030 {
    pub receipt: StartReceipt030,
    pub capture: StartCapture030,
}

pub(super) enum StartInspection030 {
    Committed(RetainedStart030),
    /// Absence alone cannot prove that the submitted commit has settled.
    AbsentUnresolved,
}

/// Implemented by 09. `lock_source` holds the metadata lock through commit.
/// `bind_capture_tx` authenticates the complete capture and entry, registers the
/// 030 owner under the current epoch, and uses only this SQLite transaction.
/// It must not perform provider, filesystem or other external IO.
pub(super) trait StartAuthority030: Authority030 {
    type SourceGuard;
    /// The native barrier is shared with capture, claims, dispatch and fencing.
    fn require_clear(&self, request: &EngineStartRequest) -> Result<()>;
    /// Install the exclusion before submitting COMMIT; cancellation retains it.
    fn begin_commit(&self, request: &EngineStartRequest, identity: &FlowIdentity030) -> Result<()>;
    /// Release only after an acknowledged successful commit.
    fn commit_acknowledged(&self, request: &EngineStartRequest, identity: &FlowIdentity030);
    async fn capture(&self, request: &EngineStartRequest) -> Result<StartCapture030>;
    async fn lock_source(&self, request: &EngineStartRequest) -> Result<Self::SourceGuard>;
    async fn bind_capture_tx(
        &self,
        db: &mut SqliteConnection,
        request: &EngineStartRequest,
        capture: &StartCapture030,
    ) -> Result<()>;
}

fn store_error(error: StoreError030) -> super::dto::EngineFailure {
    match error {
        StoreError030::Sql(_) => failure("STORAGE", "", "Flow 0.3 transaction failed"),
        StoreError030::Authority => failure("AUTHORITY", "", "Flow 0.3 owner is not current"),
        _ => failure(
            "CORRELATION",
            "",
            "Flow 0.3 capture or transition was refused",
        ),
    }
}

fn validate_capture(
    request: &EngineStartRequest,
    capture: &StartCapture030,
) -> Result<FlowPlan030> {
    opaque(&request.request_id)?;
    decimal(&request.source.revision)?;
    for part in [
        &request.source.owner.project_id,
        &request.source.owner.plan_id,
        &request.source.owner.branch,
        &capture.identity.system_start_id,
        &capture.identity.flow_invocation_id,
        &capture.identity.snapshot_id,
        &capture.identity.epoch,
        &capture.versions.compiler,
        &capture.versions.runtime,
        &capture.versions.registry,
    ] {
        opaque(part)?;
    }
    if request.source != capture.source
        || request.profile != "macro-agsdl-030-v1"
        || capture.versions.snapshot != "2"
        || capture.versions.contract != "agsdl-0.3.0"
        || capture.versions.profile != request.profile
        || format!("{:x}", Sha256::digest(capture.authored_source.as_bytes()))
            != capture.source.source_sha256
    {
        return Err(failure(
            "CORRELATION",
            "source",
            "Source or version does not match the native capture",
        ));
    }
    for raw in [
        &capture.authored_source,
        &capture.compiled_plan_json,
        &capture.registry_json,
        &capture.private_capture_json,
    ] {
        validate_json(raw)?;
    }
    if let Some(entry) = &request.entry {
        opaque(&entry.delivery_id)?;
        validate_json(&entry.message_json)?;
    }
    let plan: FlowPlan030 = serde_json::from_str(&capture.compiled_plan_json)?;
    let source_json = serde_json::to_string(&capture.source)?;
    let registry = crate::db::exact_json::value(&capture.registry_json)?;
    let authored = crate::db::exact_json::value(&capture.authored_source)?;
    if plan.format != "macro-agsdl-compiled-plan/2"
        || serde_json::to_value(&plan.versions)? != serde_json::to_value(&capture.versions)?
        || !crate::db::exact_json::equal(&serde_json::to_string(&plan.source)?, &source_json)?
        || !document_tokens_equal(&plan.document_json, &capture.authored_source)?
        || authored.get("contract").and_then(|v| v.as_str()) != Some("agsdl-0.3.0")
        || registry.get("format").and_then(|v| v.as_str()) != Some("macro-agsdl-registry/030")
        || registry.get("version").and_then(|v| v.as_str())
            != Some(capture.versions.registry.as_str())
        || plan.entry.is_some() != request.entry.is_some()
    {
        return Err(failure(
            "CORRELATION",
            "compiler",
            "Compiled plan does not match the authenticated capture",
        ));
    }
    Ok(plan)
}

async fn lookup_tx<A: StartAuthority030>(
    db: &mut SqliteConnection,
    request: &EngineStartRequest,
    authority: &A,
) -> Result<Option<RetainedStart030>> {
    super::intents::reserve_start(db, request, None).await?;
    let historical: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM engine_systems WHERE request_id=?)")
            .bind(&request.request_id)
            .fetch_one(&mut *db)
            .await?;
    if historical {
        return Err(failure(
            "CORRELATION",
            "requestId",
            "Start request is already used by another execution version",
        ));
    }
    let Some(row) = sqlx::query("SELECT request_json,capture_json,receipt_json FROM engine_start030_requests WHERE request_id=?")
        .bind(&request.request_id).fetch_optional(&mut *db).await? else { return Ok(None); };
    let prior: EngineStartRequest = serde_json::from_str(row.get("request_json"))?;
    if prior != *request {
        return Err(failure(
            "CORRELATION",
            "requestId",
            "Conflicting Start request",
        ));
    }
    let capture: StartCapture030 = serde_json::from_str(row.get("capture_json"))?;
    let receipt: StartReceipt030 = serde_json::from_str(row.get("receipt_json"))?;
    if capture.identity != receipt.identity {
        return Err(failure(
            "CORRELATION",
            "capture",
            "Stored capture and receipt differ",
        ));
    }
    authority
        .owner(db, &receipt.identity)
        .await
        .map_err(store_error)?;
    Ok(Some(RetainedStart030 { receipt, capture }))
}

/// Read-only reconciliation. Absence is deliberately not called a rollback:
/// 09 must independently establish that the submitted commit has finished and
/// that its native exclusion still blocks effects before releasing the barrier.
pub(super) async fn inspect<A: StartAuthority030>(
    pool: &SqlitePool,
    request: &EngineStartRequest,
    authority: &A,
) -> Result<StartInspection030> {
    opaque(&request.request_id)?;
    let mut connection = pool.acquire().await?;
    let mut tx = connection.begin().await?;
    let result = match lookup_tx(&mut tx, request, authority).await? {
        Some(retained) => StartInspection030::Committed(retained),
        None => StartInspection030::AbsentUnresolved,
    };
    tx.commit().await?;
    Ok(result)
}

/// Caller must discard any receipt after an uncertain commit and read durable state.
pub(super) async fn start<A: StartAuthority030>(
    pool: &SqlitePool,
    request: &EngineStartRequest,
    authority: &A,
) -> Result<RetainedStart030> {
    opaque(&request.request_id)?;
    authority.require_clear(request)?;
    // This lookup is before compilation or metadata locking. Every decision,
    // including intent reservations and owner epoch, uses one immediate transaction.
    let mut connection = pool.acquire().await?;
    sqlx::query("PRAGMA synchronous = FULL")
        .execute(&mut *connection)
        .await?;
    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
    authority.require_clear(request)?;
    if let Some(retained) = lookup_tx(&mut tx, request, authority).await? {
        tx.commit().await?;
        return Ok(retained);
    }
    tx.commit().await?;
    drop(connection);
    let capture = authority.capture(request).await?;
    let plan = validate_capture(request, &capture)?;
    let _guard = authority.lock_source(request).await?;
    let mut connection = pool.acquire().await?;
    sqlx::query("PRAGMA synchronous = FULL")
        .execute(&mut *connection)
        .await?;
    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
    authority.require_clear(request)?;
    let request_json = serde_json::to_string(request)?;
    if let Some(retained) = lookup_tx(&mut tx, request, authority).await? {
        tx.commit().await?;
        return Ok(retained);
    }
    authority
        .bind_capture_tx(&mut tx, request, &capture)
        .await?;
    authority
        .owner(&mut tx, &capture.identity)
        .await
        .map_err(store_error)?;
    let source_json = serde_json::to_string(&capture.source)?;
    flow_store030::initialize_tx(
        &mut tx,
        authority,
        &capture.identity,
        &source_json,
        &capture.compiled_plan_json,
    )
    .await
    .map_err(store_error)?;
    let enter = if plan.entry.is_some() {
        let message = &request
            .entry
            .as_ref()
            .expect("validated entry")
            .message_json;
        let event = FlowEvent030 {
            identity: capture.identity.clone(),
            event_id: "start:enter".into(),
            expected_revision: "0".into(),
            kind: FlowEventKind030::Enter {
                message_json: message.clone(),
            },
        };
        match flow_store030::apply_tx(&mut tx, authority, &event)
            .await
            .map_err(store_error)?
        {
            Apply030::Applied(receipt) => Some(receipt),
            _ => {
                return Err(failure(
                    "CORRELATION",
                    "entry",
                    "Initial flow transition was not applied",
                ))
            }
        }
    } else {
        None
    };
    let receipt = StartReceipt030 {
        identity: capture.identity.clone(),
        enter,
    };
    sqlx::query("INSERT INTO engine_start030_requests(request_id,request_json,system_id,invocation_id,snapshot_id,capture_epoch,capture_json,receipt_json) VALUES(?,?,?,?,?,?,?,?)")
        .bind(&request.request_id).bind(request_json).bind(&capture.identity.system_start_id)
        .bind(&capture.identity.flow_invocation_id).bind(&capture.identity.snapshot_id).bind(&capture.identity.epoch)
        .bind(serde_json::to_string(&capture)?).bind(serde_json::to_string(&receipt)?)
        .execute(&mut *tx).await?;
    authority
        .owner(&mut tx, &capture.identity)
        .await
        .map_err(store_error)?;
    // Set the shared native exclusion before the commit future can be polled.
    // If cancellation or an error follows, 09 retains it until reconciliation.
    authority.begin_commit(request, &capture.identity)?;
    if tx.commit().await.is_err() {
        return Err(failure(
            "UNCERTAIN",
            "requestId",
            "Start commit outcome is unknown; inspect durable state",
        ));
    }
    authority.commit_acknowledged(request, &capture.identity);
    Ok(RetainedStart030 { receipt, capture })
}

#[cfg(test)]
#[path = "start030_tests.rs"]
mod tests;
