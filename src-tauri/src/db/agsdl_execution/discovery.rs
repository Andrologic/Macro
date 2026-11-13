//! Public discovery uses only canonical snapshot owners and committed Start receipts.
use super::public::PublicStopState;
use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunListRequest {
    #[ts(as = "super::dto::ipc::EngineSourceOwner")]
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
    #[ts(as = "super::dto::ipc::EngineSourceRevision")]
    pub source: EngineSourceRevision,
    #[ts(as = "super::dto::ipc::EngineVersions")]
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
