//! Durable per-invocation decisions. A UI decision never supplies an effect or epoch.
use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    pub effect: EngineEffect,
    pub tool_name: String,
    pub summary: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicApproval {
    pub approval_id: String,
    pub work: EngineWork,
    pub tool_name: String,
    pub summary: String,
    pub status: String,
}
fn dispatchable(stored: &Stored, effect: &EngineEffect) -> Result<()> {
    context(stored, &effect.context)?;
    let activation = activation(&stored.state, &effect.context.work)?;
    require(
        activation.work_state == "active"
            && matches!(activation.stop_state, EngineStopState::None)
            && matches!(stored.state.stop, EngineStopState::None)
            && !stored
                .state
                .rejected
                .contains_key(&effect.context.work.activation_id),
        "Stopped, rejected or uncertain work cannot approve an effect",
    )
}
fn projection(id: String, request: Request, status: String) -> PublicApproval {
    PublicApproval {
        approval_id: id,
        work: request.effect.context.work,
        tool_name: request.tool_name.chars().take(128).collect(),
        summary: request.summary.chars().take(512).collect(),
        status,
    }
}
/// Only the authenticated host constructs this request after the actual Macro policy.
/// Terminal callers use this path even when the captured risk policy is YOLO.
pub(crate) async fn request(pool: &SqlitePool, request: Request) -> Result<PublicApproval> {
    require(
        matches!(request.effect.effect, EngineEffectIdentity::Tool { .. }),
        "Only tools request approval",
    )?;
    opaque(&request.tool_name)?;
    require(
        !request.summary.trim().is_empty() && request.summary.len() <= 16_384,
        "Invalid approval summary",
    )?;
    validate_json(&request.effect.invocation_json)?;
    let key = effect_key(&request.effect.effect)?;
    let mut connection = pool.acquire().await?;
    let mut tx = durable(&mut connection).await?;
    let stored = load(&mut tx, &request.effect.context.work.system_start_id).await?;
    owner(
        &stored.state,
        &request.effect.context.owner,
        &stored.snapshot.system_start_id,
    )?;
    if let Some(row) = sqlx::query("SELECT approval_id,request_json,status FROM engine_approvals WHERE system_id = ? AND effect_key = ?")
        .bind(&stored.snapshot.system_start_id).bind(&key).fetch_optional(&mut *tx).await? {
        let previous: Request = serde_json::from_str(row.get("request_json"))?;
        require(record_equal(&previous, &request)?, "Conflicting approval retransmission")?;
        return Ok(projection(row.get("approval_id"), previous, row.get("status")));
    }
    dispatchable(&stored, &request.effect)?;
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO engine_approvals VALUES (?, ?, ?, ?, ?, 'pending')")
        .bind(&id)
        .bind(&stored.snapshot.system_start_id)
        .bind(&request.effect.context.work.activation_id)
        .bind(key)
        .bind(encode(&request)?)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(projection(id, request, "pending".into()))
}
/// A policy change cannot bypass a decision already requested for this effect.
pub(crate) async fn existing(
    pool: &SqlitePool,
    effect: &EngineEffect,
) -> Result<Option<PublicApproval>> {
    let key = effect_key(&effect.effect)?;
    let row = sqlx::query("SELECT approval_id,request_json,status FROM engine_approvals WHERE system_id = ? AND effect_key = ?")
        .bind(&effect.context.work.system_start_id).bind(key).fetch_optional(pool).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let request: Request = serde_json::from_str(row.get("request_json"))?;
    require(
        record_equal(&request.effect, effect)?,
        "Approval belongs to another invocation",
    )?;
    Ok(Some(projection(
        row.get("approval_id"),
        request,
        row.get("status"),
    )))
}
/// A remounted UI retrieves pending decisions; retained grants are never inferred.
pub(crate) async fn pending(pool: &SqlitePool, system_id: &str) -> Result<Vec<PublicApproval>> {
    let mut connection = pool.acquire().await?;
    let mut tx = connection.begin().await?;
    let stored = load(&mut tx, system_id).await?;
    let rows = sqlx::query("SELECT approval_id,request_json,status FROM engine_approvals WHERE system_id = ? AND status = 'pending' ORDER BY rowid")
        .bind(system_id).fetch_all(&mut *tx).await?;
    let mut result = Vec::new();
    for row in rows {
        let request: Request = serde_json::from_str(row.get("request_json"))?;
        // Revoked generations stay in the journal, but cannot ask the UI to grant them.
        if dispatchable(&stored, &request.effect).is_ok() {
            result.push(projection(
                row.get("approval_id"),
                request,
                row.get("status"),
            ));
        }
    }
    tx.commit().await?;
    Ok(result)
}
pub(crate) async fn decide(pool: &SqlitePool, id: &str, approve: bool) -> Result<PublicApproval> {
    decide_inner(pool, id, approve, None).await
}
async fn decide_inner(
    pool: &SqlitePool,
    id: &str,
    approve: bool,
    scope: Option<&ApprovalScope>,
) -> Result<PublicApproval> {
    let mut connection = pool.acquire().await?;
    let mut tx = durable(&mut connection).await?;
    let row = sqlx::query("SELECT request_json,status FROM engine_approvals WHERE approval_id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| failure("NOT_FOUND", "approvalId", "Unknown approval"))?;
    let request: Request = serde_json::from_str(row.get("request_json"))?;
    let stored = load(&mut tx, &request.effect.context.work.system_start_id).await?;
    if let Some(scope) = scope {
        require(
            stored.snapshot.system_start_id == scope.system_start_id
                && stored.snapshot.source == scope.source,
            "Approval does not belong to this retained run/source",
        )?;
    }
    dispatchable(&stored, &request.effect)?;
    let status: String = row.get("status");
    let desired = if approve { "approved" } else { "denied" };
    require(
        status == "pending" || status == desired || approve && status == "consumed",
        "Approval decision is already final",
    )?;
    if status == "pending" {
        sqlx::query("UPDATE engine_approvals SET status = ? WHERE approval_id = ?")
            .bind(desired)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(projection(
        id.into(),
        request,
        if status == "pending" {
            desired.into()
        } else {
            status
        },
    ))
}
/// The native dispatcher revalidates current rights/descriptors before calling this,
/// then fences physical admission against Stop. This receipt alone is not a dispatch.
pub(crate) async fn consume_and_register(
    pool: &SqlitePool,
    id: &str,
    effect: EngineEffect,
) -> Result<bool> {
    let mut connection = pool.acquire().await?;
    let mut tx = durable(&mut connection).await?;
    let mut stored = load(&mut tx, &effect.context.work.system_start_id).await?;
    let row = sqlx::query("SELECT request_json,status FROM engine_approvals WHERE approval_id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| failure("NOT_FOUND", "approvalId", "Unknown approval"))?;
    let request: Request = serde_json::from_str(row.get("request_json"))?;
    require(
        record_equal(&request.effect, &effect)?,
        "Approval belongs to another invocation or arguments",
    )?;
    owner(
        &stored.state,
        &effect.context.owner,
        &effect.context.work.system_start_id,
    )?;
    let status: String = row.get("status");
    require(
        status == "approved" || status == "consumed",
        "Approval is not granted",
    )?;
    if status == "approved" {
        dispatchable(&stored, &effect)?;
    }
    let registered = register_effect_on(&mut tx, &mut stored, effect).await?;
    require(
        registered == (status == "approved"),
        "Approval and effect receipt disagree",
    )?;
    if registered {
        sqlx::query("UPDATE engine_approvals SET status = 'consumed' WHERE approval_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(registered)
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalScope {
    pub system_start_id: String,
    pub source: EngineSourceRevision,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalDecision {
    pub scope: ApprovalScope,
    pub approval_id: String,
    pub approve: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalPage {
    pub approvals: Vec<PublicApproval>,
    pub incomplete: bool,
}
pub(crate) async fn pending_public(
    pool: &SqlitePool,
    scope: ApprovalScope,
) -> Result<ApprovalPage> {
    let snapshot = read_snapshot(pool, &scope.system_start_id).await?;
    require(
        snapshot.source == scope.source,
        "Approval source differs from the retained snapshot",
    )?;
    let mut approvals = pending(pool, &scope.system_start_id).await?;
    let incomplete = approvals.len() > 64;
    approvals.truncate(64);
    Ok(ApprovalPage {
        approvals,
        incomplete,
    })
}
pub(crate) async fn decide_public(
    pool: &SqlitePool,
    request: ApprovalDecision,
) -> Result<PublicApproval> {
    decide_inner(
        pool,
        &request.approval_id,
        request.approve,
        Some(&request.scope),
    )
    .await
}
