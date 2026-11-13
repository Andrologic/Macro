//! Public 0.3 human operations. Unattested records are never projected or resolved.
use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HumanScope030 {
    pub system_start_id: String,
    #[ts(as = "super::dto::ipc::EngineSourceRevision")]
    pub source: EngineSourceRevision,
}

/// A continuation must be bound to both the scope and a native snapshot token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HumanContinuation030 {
    pub scope: HumanScope030,
    pub cursor: String,
    pub offset: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HumanPage030 {
    pub scope: HumanScope030,
    pub cursor: String,
    pub total: String,
    pub requests: Vec<PublicHumanRequest030>,
    pub next_page: Option<HumanContinuation030>,
}

/// Only these explicitly public fields may be exposed after native attestation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicHumanRequest030 {
    pub id: String,
    pub revision: String,
    pub status: String,
    pub work_ids: Vec<String>,
    pub content: HumanContent030,
    /// True-flow facts. Absent on the historical projection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub flow_json: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HumanContent030 {
    Approval {
        message: String,
        title: String,
        description: String,
        choices: Vec<String>,
    },
    Plan {
        plan: String,
    },
    Question {
        question: String,
        expected_response: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HumanAnswer030 {
    Approval {
        choice: String,
        comment: Option<String>,
    },
    Plan {
        accept: bool,
        comment: Option<String>,
    },
    Question {
        answer_json: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HumanDecision030 {
    pub scope: HumanScope030,
    pub request_id: String,
    pub expected_revision: String,
    pub answer: HumanAnswer030,
}
