use crate::db::agsdl_execution::{
    dto::ipc::{self as ipc_dto, EngineSourceRevision},
    runtime_projection030::ipc::*,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProjectionScope030 {
    pub system_start_id: String,
    #[ts(as = "ipc_dto::EngineSourceRevision")]
    pub source: EngineSourceRevision,
    pub snapshot_id: String,
}

/// The first page obtains the snapshot identity from the authenticated capture.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProjectionQuery030 {
    pub system_start_id: String,
    #[ts(as = "ipc_dto::EngineSourceRevision")]
    pub source: EngineSourceRevision,
    pub snapshot_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProjectionContinuation030 {
    pub scope: RuntimeProjectionScope030,
    pub revision: String,
    pub offset: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum RuntimeProjectionItem030 {
    Instance { value: RuntimeInstance030 },
    Activation { value: RuntimeActivation030 },
    Group { value: RuntimeGroup030 },
    Path { value: RuntimePath030 },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProjectionPage030 {
    pub scope: RuntimeProjectionScope030,
    pub flow_invocation_id: String,
    pub revision: String,
    pub stopping: bool,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused: Option<bool>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interrupted_while_paused: Option<bool>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(
        type = "Record<string, { kind: 'holding' } | { kind: 'held' } | { kind: 'interrupted'; code: string }>"
    )]
    pub operator_works: Option<serde_json::Value>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(type = "Record<string, { name: string; effort?: string }>")]
    pub model_overrides: Option<serde_json::Value>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub termination_uncertain: Option<bool>,
    pub verdict: Option<String>,
    pub total: String,
    pub items: Vec<RuntimeProjectionItem030>,
    pub next_page: Option<RuntimeProjectionContinuation030>,
}
