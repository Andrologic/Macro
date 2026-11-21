use serde::{Deserialize, Serialize};

macro_rules! dto {
    ($name:ident { $($field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name { $(pub $field: $ty),* }
    };
}
dto!(EngineSourceOwner {
    project_id: String,
    plan_id: String,
    branch: String
});
dto!(EngineSourceRevision {
    owner: EngineSourceOwner,
    revision: String,
    source_sha256: String
});
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngineAssociations {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub conversation_id: Option<String>,
}
dto!(EngineVersions {
    snapshot: String,
    contract: String,
    compiler: String,
    runtime: String,
    registry: String,
    profile: String
});
dto!(EngineAgentConfiguration {
    agent_name: String,
    configuration_name: String,
    provider_id: String,
    model_id: String,
    configuration_json: String,
    settings_json: String,
    permissions_json: String,
    scope_json: String
});
dto!(EngineSnapshot { system_start_id: String, source: EngineSourceRevision, authored_source: String, versions: EngineVersions, agents: Vec<EngineAgentConfiguration>, compiled_plan_json: String, associations: EngineAssociations });
dto!(EngineEntry {
    delivery_id: String,
    message_json: String
});
dto!(EngineStartRequest { source: EngineSourceRevision, profile: String, associations: EngineAssociations, request_id: String, entry: Option<EngineEntry> });
dto!(EngineStartReceipt {
    system_start_id: String,
    flow_invocation_id: String,
    snapshot: EngineSnapshot
});
dto!(EngineWork { system_start_id: String, flow_invocation_id: String, activation_id: String, step: Option<Vec<String>>, agent_instance_id: Option<String> });
dto!(EngineValue {
    origin: String,
    value_json: String
});
dto!(EngineDelivery {
    delivery_id: String,
    work: EngineWork,
    input: EngineValue
});
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngineAcceptedDelivery {
    #[serde(flatten)]
    #[ts(flatten)]
    pub delivery: EngineDelivery,
    pub queue_sequence: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum EngineStopState {
    None,
    Requested {
        request_id: String,
    },
    Uncertain {
        request_id: String,
        reason: String,
    },
    Confirmed {
        request_id: String,
        evidence_json: String,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum EngineOutcome {
    Completed { output: EngineValue },
    Failed { code: String, error_json: String },
    Stopped { evidence_json: String },
}
dto!(EngineMemory {
    agent_instance_id: String,
    revision: String,
    format_version: String,
    state_json: String
});
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngineActivation {
    pub delivery: EngineAcceptedDelivery,
    pub work_state: String,
    pub stop_state: EngineStopState,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub admitted_epoch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub terminal: Option<EngineOutcome>,
}
dto!(EngineOwner {
    system_start_id: String,
    owner_epoch: String
});
dto!(EngineTerminalCommit {owner: EngineOwner, work: EngineWork, outcome: EngineOutcome, termination_evidence_json: String, response_cursor: String, memory: Option<EngineMemory>, outgoing: Vec<EngineDelivery>});
dto!(EngineStopRequest { system_start_id: String, request_id: String, activation_id: Option<String> });
dto!(EngineEvent {system_start_id: String, sequence: String, work: Option<EngineWork>, kind: String, payload_json: String});
dto!(EngineEventPage {events: Vec<EngineEvent>, next_cursor: String, has_more: bool});
dto!(EngineProjection {system_start_id: String, cursor: String, activations: Vec<EngineActivation>, system_stop: EngineStopState});
dto!(EngineContext {
    owner: EngineOwner,
    work: EngineWork,
    permissions_json: String,
    scope_json: String,
    registry_version: String
});
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum EngineEffectIdentity {
    Provider {
        provider_attempt_id: String,
    },
    Tool {
        tool_invocation_id: String,
        provider_attempt_id: Option<String>,
    },
}
dto!(EngineEffect {
    context: EngineContext,
    effect: EngineEffectIdentity,
    invocation_json: String
});
dto!(EngineSettlement {
    context: EngineContext,
    effect: EngineEffectIdentity,
    status: String,
    evidence_json: String
});
dto!(EngineFailure {code: String, pointer: String, message: String, work: Option<EngineWork>});

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Admission {
    Admitted(EngineActivation, Option<EngineMemory>),
    Waiting(&'static str),
    Rejected(&'static str),
}
