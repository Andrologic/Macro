//! Public task presentation data. No legacy approval execution remains.
use super::*;
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicApproval {
    pub approval_id: String,
    #[ts(as = "super::dto::ipc::EngineWork")]
    pub work: EngineWork,
    pub tool_name: String,
    pub summary: String,
    pub status: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalScope {
    pub system_start_id: String,
    #[ts(as = "super::dto::ipc::EngineSourceRevision")]
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
