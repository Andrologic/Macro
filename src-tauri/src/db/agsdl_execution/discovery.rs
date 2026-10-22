//! Public discovery uses only canonical snapshot owners and committed Start receipts.
use super::public::{PublicSnapshot, PublicStartReceipt, PublicStopState};
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunListRequest {
    pub owner: EngineSourceOwner,
    pub after: Option<String>,
    pub limit: Option<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct PublicRunCounts {
    pub queued: String,
    pub active: String,
    pub uncertain: String,
    pub completed: String,
    pub failed: String,
    pub stopped: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct PublicRunSummary {
    pub system_start_id: String,
    pub flow_invocation_id: String,
    pub source: EngineSourceRevision,
    pub versions: EngineVersions,
    pub cursor: String,
    pub system_stop: PublicStopState,
    pub counts: PublicRunCounts,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct RunPage {
    pub runs: Vec<PublicRunSummary>,
    pub next_cursor: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    owner: EngineSourceOwner,
    upper: i64,
    before: i64,
}
fn validate_owner(owner: &EngineSourceOwner) -> Result<()> {
    opaque(&owner.project_id)?;
    opaque(&owner.plan_id)?;
    opaque(&owner.branch)
}
fn summary(snapshot: EngineSnapshot, state: State) -> PublicRunSummary {
    let mut counts = [0usize; 6];
    for activation in state.activations.values() {
        let index = match (activation.work_state.as_str(), &activation.terminal) {
            ("queued", _) => 0,
            ("active", _) => 1,
            ("uncertain", _) => 2,
            ("terminal", Some(EngineOutcome::Completed { .. })) => 3,
            ("terminal", Some(EngineOutcome::Failed { .. })) => 4,
            ("terminal", Some(EngineOutcome::Stopped { .. })) => 5,
            _ => 2,
        };
        counts[index] += 1;
    }
    PublicRunSummary {
        system_start_id: snapshot.system_start_id,
        flow_invocation_id: state.invocation_id,
        source: snapshot.source,
        versions: snapshot.versions,
        cursor: state.cursor,
        system_stop: state.stop.into(),
        counts: PublicRunCounts {
            queued: counts[0].to_string(),
            active: counts[1].to_string(),
            uncertain: counts[2].to_string(),
            completed: counts[3].to_string(),
            failed: counts[4].to_string(),
            stopped: counts[5].to_string(),
        },
    }
}
pub(crate) async fn list_runs(pool: &SqlitePool, request: RunListRequest) -> Result<RunPage> {
    validate_owner(&request.owner)?;
    let limit = request.limit.unwrap_or(20);
    require(
        (1..=100).contains(&limit),
        "Run page limit must be between 1 and 100",
    )?;
    let mut connection = pool.acquire().await?;
    let mut tx = connection.begin().await?;
    let upper: i64 = sqlx::query_scalar("SELECT coalesce(max(rowid),0) FROM engine_systems")
        .fetch_one(&mut *tx)
        .await?;
    let cursor = if let Some(after) = &request.after {
        require(after.len() <= 4096, "Run cursor is too large")?;
        let raw = URL_SAFE_NO_PAD
            .decode(after)
            .map_err(|_| failure("CORRELATION", "after", "Invalid run cursor"))?;
        require(
            URL_SAFE_NO_PAD.encode(&raw) == *after,
            "Noncanonical run cursor",
        )?;
        let cursor: Cursor = serde_json::from_slice(&raw)?;
        require(
            cursor.owner == request.owner
                && cursor.upper >= 0
                && cursor.upper <= upper
                && cursor.before > 0
                && cursor.before <= cursor.upper,
            "Run cursor does not belong to this owner or page",
        )?;
        cursor
    } else {
        Cursor {
            owner: request.owner,
            upper,
            before: 0,
        }
    };
    let rows = sqlx::query("SELECT rowid,snapshot_json,state_json FROM engine_systems WHERE rowid <= ? AND (? = 0 OR rowid < ?) AND json_extract(snapshot_json,'$.source.owner.projectId') = ? AND json_extract(snapshot_json,'$.source.owner.planId') = ? AND json_extract(snapshot_json,'$.source.owner.branch') = ? ORDER BY rowid DESC LIMIT ?")
        .bind(cursor.upper).bind(cursor.before).bind(cursor.before).bind(&cursor.owner.project_id).bind(&cursor.owner.plan_id).bind(&cursor.owner.branch).bind(i64::from(limit)+1).fetch_all(&mut *tx).await?;
    let has_more = rows.len() > limit as usize;
    let mut runs = Vec::new();
    let mut before = 0;
    for row in rows.into_iter().take(limit as usize) {
        before = row.get("rowid");
        let snapshot: EngineSnapshot = serde_json::from_str(row.get("snapshot_json"))?;
        require(
            snapshot.source.owner == cursor.owner,
            "Run owner does not match canonical snapshot",
        )?;
        runs.push(summary(
            snapshot,
            serde_json::from_str(row.get("state_json"))?,
        ));
    }
    let next_cursor = if has_more {
        Some(URL_SAFE_NO_PAD.encode(encode(&Cursor { before, ..cursor })?))
    } else {
        None
    };
    tx.commit().await?;
    Ok(RunPage { runs, next_cursor })
}
pub(crate) async fn find_start(
    pool: &SqlitePool,
    source_owner: &EngineSourceOwner,
    request_id: &str,
) -> Result<Option<PublicStartReceipt>> {
    validate_owner(source_owner)?;
    opaque(request_id)?;
    let Some(row) =
        sqlx::query("SELECT snapshot_json,state_json FROM engine_systems WHERE request_id = ?")
            .bind(request_id)
            .fetch_optional(pool)
            .await?
    else {
        return Ok(None);
    };
    let snapshot: EngineSnapshot = serde_json::from_str(row.get("snapshot_json"))?;
    require(
        &snapshot.source.owner == source_owner,
        "Start receipt belongs to another source owner",
    )?;
    let state: State = serde_json::from_str(row.get("state_json"))?;
    Ok(Some(PublicStartReceipt {
        system_start_id: snapshot.system_start_id.clone(),
        flow_invocation_id: state.invocation_id,
        snapshot: PublicSnapshot::from(snapshot),
    }))
}
