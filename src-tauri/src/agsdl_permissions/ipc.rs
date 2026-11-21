//! Wire mirrors for generated TypeScript; engine types carry no generator dependency.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Serialize,
    Deserialize,
    ts_rs::TS,
    JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    Read,
    Write,
    Shell,
    Network,
    Mcp,
    Delegate,
}

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Serialize,
    Deserialize,
    ts_rs::TS,
    JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum Effect {
    Allow,
    Ask,
    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Preset {
    ReadOnly,
    Workspace,
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum DirectoryAccess {
    Read,
    Write,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Outside {
    Read,
    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Reviewer {
    Model,
    Person,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PermissionRule {
    pub action: Action,
    #[serde(rename = "match", default)]
    pub pattern: Option<String>,
    pub effect: Effect,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, ts_rs::TS, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PermissionObject {
    pub preset: Option<Preset>,
    #[serde(default)]
    pub directories: BTreeMap<String, DirectoryAccess>,
    pub outside: Option<Outside>,
    #[serde(default)]
    pub rules: Vec<PermissionRule>,
    pub reviewer: Option<Reviewer>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS, JsonSchema)]
#[serde(untagged)]
pub enum RequestedPermissions {
    Preset(Preset),
    Object(PermissionObject),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum ActionRequest {
    Read {
        path: String,
    },
    Write {
        path: String,
    },
    Shell {
        command: String,
    },
    Network {
        host: String,
    },
    Mcp {
        server: String,
        tool: Option<String>,
    },
    Delegate {},
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub enum ExecutionPurpose {
    Agent,
    PlanLocked,
    CompletionCheck,
    /// Content for host-owned flow steps uses captured policy, without an agent.
    HostFlowContent,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecision {
    pub policy_digest: String,
    pub request: ActionRequest,
    pub purpose: ExecutionPurpose,
    pub effect: Effect,
    pub reviewer: Option<Reviewer>,
    /// Snapshot for correlation only. It is not a handle or a TOCTOU defense.
    pub resolved_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct PermissionError {
    pub code: String,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub enum EnforcementMechanism {
    Sandbox,
    Harness,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub enum ShellMatching {
    CommandText,
    Prefix,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservedGuarantee {
    pub action: Action,
    pub effect: Effect,
    pub mechanism: EnforcementMechanism,
    /// Probe must cover the entire action, all corresponding native tools and
    /// aliases. For sandbox ask, shell has no bypass while mediated tools ask.
    pub evidence: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnforcementObservation {
    pub policy_digest: String,
    pub qualification_id: String,
    pub platform: String,
    pub harness_version: String,
    pub guarantees: Vec<ObservedGuarantee>,
    pub shell_matching: ShellMatching,
    /// Empty when shell exists. Otherwise an observed absence of every shell
    /// entry point, not merely a missing tool in a catalogue.
    pub shell_absent_evidence: Option<String>,
    /// Native observation that no MCP server, tool or resource is exposed.
    #[serde(default)]
    pub mcp_absent_evidence: Option<String>,
    pub outside_read_evidence: Option<String>,
    pub path_race_evidence: Option<String>,
    pub descendant_ceiling_evidence: Option<String>,
    pub plan_lock_evidence: Option<String>,
    pub completion_check_evidence: Option<String>,
    pub person_reviewer_evidence: Option<String>,
    pub model_reviewer_evidence: Option<String>,
    /// Model may fall back to a person, never the reverse.
    pub model_fallback_to_person: bool,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct EnforcementRequirement {
    pub action: Action,
    pub effect: Effect,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct EnforcementPlan {
    pub policy_digest: String,
    pub qualification_id: String,
    pub requirements: Vec<EnforcementRequirement>,
    pub evidence: Vec<String>,
    pub reviewer: Reviewer,
    pub purpose: ExecutionPurpose,
}
