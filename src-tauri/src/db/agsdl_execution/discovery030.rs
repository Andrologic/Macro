//! Read-only discovery of committed 0.3 captures. Scope authorization is the
//! native caller's responsibility; a page or cursor never grants authority.
use super::{
    decimal,
    dto::{EngineSourceOwner, EngineSourceRevision, EngineStartRequest, EngineVersions},
    failure,
    flow030::{FlowEvent030, FlowEventKind030, FlowPlan030, FlowState030},
    json_lexemes030::document_tokens_equal,
    opaque, require,
    start030::{StartCapture030, StartReceipt030},
    Result,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row, SqlitePool};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunListRequest030 {
    #[ts(as = "super::dto::ipc::EngineSourceOwner")]
    pub owner: EngineSourceOwner,
    pub after: Option<String>,
    pub limit: Option<u32>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhaseCount030 {
    pub phase: String,
    pub count: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicRunSummary030 {
    pub system_start_id: String,
    pub flow_invocation_id: String,
    pub snapshot_id: String,
    #[ts(as = "super::dto::ipc::EngineSourceRevision")]
    pub source: EngineSourceRevision,
    #[ts(as = "super::dto::ipc::EngineVersions")]
    pub versions: EngineVersions,
    pub revision: String,
    pub stopping: bool,
    pub verdict: Option<String>,
    pub owner_status: String,
    pub interrupted_at: Option<String>,
    pub phase_counts: Vec<PhaseCount030>,
    pub physical_pending: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunPage030 {
    pub runs: Vec<PublicRunSummary030>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor030 {
    version: String,
    owner: EngineSourceOwner,
    upper: i64,
    before: i64,
}

fn correlation() -> super::dto::EngineFailure {
    failure("CORRELATION", "", "Flow discovery capture is inconsistent")
}
fn validate_owner(owner: &EngineSourceOwner) -> Result<()> {
    opaque(&owner.project_id)?;
    opaque(&owner.plan_id)?;
    opaque(&owner.branch)
}
fn validated_summary(
    row: &sqlx::sqlite::SqliteRow,
    owner: &EngineSourceOwner,
) -> Result<PublicRunSummary030> {
    // Nullable joined columns are read fallibly: a missing companion row is an
    // integrity failure, not a silently skipped historical run.
    let optional = |name: &str| -> Result<String> {
        row.try_get::<Option<String>, _>(name)?
            .ok_or_else(correlation)
    };
    let capture: StartCapture030 = serde_json::from_str(row.try_get("capture_json")?)?;
    let receipt: StartReceipt030 = serde_json::from_str(row.try_get("receipt_json")?)?;
    let request: EngineStartRequest = serde_json::from_str(row.try_get("request_json")?)?;
    let source: EngineSourceRevision = serde_json::from_str(&optional("run_source")?)?;
    let raw_plan = optional("run_plan")?;
    let plan: FlowPlan030 = serde_json::from_str(&raw_plan)?;
    let state: FlowState030 = serde_json::from_str(&optional("run_state")?)?;
    let id = &capture.identity;
    let capture_hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&capture)?));
    let authored_hash = format!("{:x}", Sha256::digest(capture.authored_source.as_bytes()));
    let canonical_plan = serde_json::to_string(&plan)?;
    let expected_enter = request
        .entry
        .as_ref()
        .map(|entry| {
            serde_json::to_string(&FlowEvent030 {
                identity: capture.identity.clone(),
                event_id: "start:enter".into(),
                expected_revision: "0".into(),
                kind: FlowEventKind030::Enter {
                    message_json: entry.message_json.clone(),
                },
            })
        })
        .transpose()?;
    let status = optional("owner_status")?;
    let same = capture.source.owner == *owner
        && request.source == capture.source
        && request.request_id == row.try_get::<String, _>("request_id")?
        && request.profile == capture.versions.profile
        && source == capture.source
        && receipt.identity == *id
        && state.identity == *id
        && row.try_get::<String, _>("system_id")? == id.system_start_id
        && row.try_get::<String, _>("invocation_id")? == id.flow_invocation_id
        && row.try_get::<String, _>("snapshot_id")? == id.snapshot_id
        && row.try_get::<String, _>("capture_epoch")? == id.epoch
        && optional("run_system")? == id.system_start_id
        && optional("run_invocation")? == id.flow_invocation_id
        && optional("run_snapshot")? == id.snapshot_id
        && optional("run_epoch")? == id.epoch
        && optional("owner_system")? == id.system_start_id
        && optional("owner_invocation")? == id.flow_invocation_id
        && optional("owner_snapshot")? == id.snapshot_id
        && optional("owner_capture_epoch")? == id.epoch
        && optional("owner_capture_hash")? == capture_hash
        && matches!(status.as_str(), "live" | "revoked")
        && authored_hash == capture.source.source_sha256
        && raw_plan == capture.compiled_plan_json
        && plan.source == serde_json::to_value(&capture.source)?
        && serde_json::to_value(&plan.versions)? == serde_json::to_value(&capture.versions)?
        && plan.format == "macro-agsdl-compiled-plan/2"
        && capture.versions.snapshot == "2"
        && argentic_core::supports_contract(&capture.versions.contract)
        && capture.versions.profile == "macro-agsdl-030-v1"
        && plan.entry.is_some() == request.entry.is_some()
        && plan.entry.is_some() == receipt.enter.is_some()
        && receipt.enter.as_ref().is_none_or(|entry| {
            entry.event_id == "start:enter"
                && state.entered
                && state.events.get(&entry.event_id).is_some_and(|event| {
                    event.receipt == *entry
                        && expected_enter.as_deref() == Some(event.event_json.as_str())
                })
        })
        && match state.plan_json.as_ref() {
            Some(plan) => plan == &canonical_plan,
            None => state.events.is_empty() && !state.entered,
        }
        && document_tokens_equal(&plan.document_json, &capture.authored_source)?;
    require(same, "Flow discovery capture is inconsistent")?;
    decimal(&state.revision)?;
    require(
        state
            .verdict
            .as_deref()
            .is_none_or(|v| matches!(v, "succeeded" | "failed" | "cancelled" | "interrupted")),
        "Flow discovery verdict is inconsistent",
    )?;
    let mut counts = BTreeMap::<String, usize>::new();
    let mut physical_pending = 0usize;
    for activation in &state.activations {
        require(
            matches!(
                activation.phase.as_str(),
                "ready"
                    | "queued"
                    | "running"
                    | "body"
                    | "group"
                    | "done"
                    | "preparing"
                    | "barrier"
                    | "stopping"
            ),
            "Flow discovery activation phase is inconsistent",
        )?;
        *counts.entry(activation.phase.clone()).or_default() += 1;
        if activation.physical {
            physical_pending += 1;
        }
    }
    Ok(PublicRunSummary030 {
        system_start_id: id.system_start_id.clone(),
        flow_invocation_id: id.flow_invocation_id.clone(),
        snapshot_id: id.snapshot_id.clone(),
        source: capture.source,
        versions: capture.versions,
        revision: state.revision,
        stopping: state.stopping,
        verdict: state.verdict,
        owner_status: status,
        interrupted_at: row.try_get("interrupted_at")?,
        phase_counts: counts
            .into_iter()
            .map(|(phase, count)| PhaseCount030 {
                phase,
                count: count.to_string(),
            })
            .collect(),
        physical_pending: physical_pending.to_string(),
    })
}

pub(crate) async fn list_runs030(
    pool: &SqlitePool,
    request: RunListRequest030,
) -> Result<RunPage030> {
    validate_owner(&request.owner)?;
    let limit = request.limit.unwrap_or(20);
    require(
        (1..=100).contains(&limit),
        "Run page limit must be between 1 and 100",
    )?;
    let mut connection = pool.acquire().await?;
    let mut tx = connection.begin().await?;
    let maximum: i64 =
        sqlx::query_scalar("SELECT coalesce(max(rowid),0) FROM engine_start030_requests")
            .fetch_one(&mut *tx)
            .await?;
    let cursor = if let Some(after) = &request.after {
        require(after.len() <= 4096, "Run 0.3 cursor is too large")?;
        let raw = URL_SAFE_NO_PAD
            .decode(after)
            .map_err(|_| failure("CORRELATION", "after", "Invalid run 0.3 cursor"))?;
        let cursor: Cursor030 = serde_json::from_slice(&raw)
            .map_err(|_| failure("CORRELATION", "after", "Invalid run 0.3 cursor"))?;
        require(
            URL_SAFE_NO_PAD.encode(&raw) == *after
                && serde_json::to_vec(&cursor)? == raw
                && cursor.version == "030/1"
                && cursor.owner == request.owner
                && cursor.upper > 0
                && cursor.upper <= maximum
                && cursor.before > 0
                && cursor.before <= cursor.upper,
            "Run 0.3 cursor does not match this scope",
        )?;
        cursor
    } else {
        Cursor030 {
            version: "030/1".into(),
            owner: request.owner,
            upper: maximum,
            before: 0,
        }
    };
    let rows = sqlx::query("SELECT s.rowid AS seq,s.request_id,s.request_json,s.capture_json,s.receipt_json,s.system_id,s.invocation_id,s.snapshot_id,s.capture_epoch, r.system_id AS run_system,r.invocation_id AS run_invocation,r.snapshot_id AS run_snapshot,r.epoch AS run_epoch,r.source_json AS run_source,r.plan_json AS run_plan,r.state_json AS run_state, o.system_id AS owner_system,o.invocation_id AS owner_invocation,o.snapshot_id AS owner_snapshot,o.capture_epoch AS owner_capture_epoch,o.status AS owner_status,o.capture_sha256 AS owner_capture_hash, i.interrupted_at AS interrupted_at FROM engine_start030_requests s LEFT JOIN engine_flow030_runs r ON r.system_id=s.system_id AND r.invocation_id=s.invocation_id LEFT JOIN engine_flow030_owners o ON o.system_id=s.system_id LEFT JOIN engine_flow030_interruptions i ON i.system_id=s.system_id WHERE s.rowid<=? AND (?=0 OR s.rowid<?) AND json_extract(s.capture_json,'$.source.owner.projectId')=? AND json_extract(s.capture_json,'$.source.owner.planId')=? AND json_extract(s.capture_json,'$.source.owner.branch')=? ORDER BY s.rowid DESC LIMIT ?")
        .bind(cursor.upper).bind(cursor.before).bind(cursor.before)
        .bind(&cursor.owner.project_id).bind(&cursor.owner.plan_id).bind(&cursor.owner.branch)
        .bind(i64::from(limit)+1).fetch_all(&mut *tx).await?;
    let more = rows.len() > limit as usize;
    let mut runs = Vec::new();
    let mut before = 0;
    for row in rows.iter().take(limit as usize) {
        before = row.try_get("seq")?;
        runs.push(validated_summary(row, &cursor.owner)?);
    }
    let next_cursor = if more {
        Some(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&Cursor030 { before, ..cursor })?))
    } else {
        None
    };
    tx.commit().await?;
    Ok(RunPage030 { runs, next_cursor })
}

#[cfg(test)]
#[path = "discovery030_tests.rs"]
mod tests;
