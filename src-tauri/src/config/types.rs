use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use ts_rs::TS;

pub const CURRENT_SCHEMA_VERSION: u32 = 1;

fn current_schema_version() -> u32 {
    CURRENT_SCHEMA_VERSION
}

#[derive(
    Clone, Copy, Debug, Deserialize, Eq, Hash, JsonSchema, Ord, PartialEq, PartialOrd, Serialize, TS,
)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/config/")]
pub enum ConfigDocumentKind {
    Runtime,
    Settings,
    Agents,
    Providers,
    Tools,
    Skills,
    Git,
}

impl ConfigDocumentKind {
    pub const ALL: [Self; 7] = [
        Self::Runtime,
        Self::Settings,
        Self::Agents,
        Self::Providers,
        Self::Tools,
        Self::Skills,
        Self::Git,
    ];

    pub fn file_name(self) -> &'static str {
        match self {
            Self::Runtime => "runtime.json",
            Self::Settings => "settings.json",
            Self::Agents => "agents.json",
            Self::Providers => "providers.json",
            Self::Tools => "tools.json",
            Self::Skills => "skills.json",
            Self::Git => "git.json",
        }
    }

    pub fn schema_file_name(self) -> &'static str {
        match self {
            Self::Runtime => "runtime.schema.json",
            Self::Settings => "settings.schema.json",
            Self::Agents => "agents.schema.json",
            Self::Providers => "providers.schema.json",
            Self::Tools => "tools.schema.json",
            Self::Skills => "skills.schema.json",
            Self::Git => "git.schema.json",
        }
    }

    pub fn supports_project_scope(self) -> bool {
        matches!(self, Self::Agents | Self::Tools | Self::Skills | Self::Git)
    }
}

#[derive(
    Clone, Debug, Deserialize, Eq, Hash, JsonSchema, Ord, PartialEq, PartialOrd, Serialize, TS,
)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/config/")]
pub enum ConfigScope {
    User,
    Project {
        #[serde(rename = "projectId")]
        #[ts(rename = "projectId")]
        project_id: String,
    },
}

impl Default for ConfigScope {
    fn default() -> Self {
        Self::User
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/config/")]
pub enum ConfigMergeStrategy {
    Replace,
    Deep,
    Keyed,
    Restrictive,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/config/")]
pub enum ConfigSensitivity {
    Normal,
    ApprovalRequired,
    SecretReferenceOnly,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/config/")]
pub enum ConfigApplyMode {
    Live,
    Reconnect,
    Restart,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/config/")]
pub enum ConfigLifecycle {
    Normal,
    Deprecated,
    Removed,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/config/")]
pub struct ConfigDescriptor {
    pub document: ConfigDocumentKind,
    pub json_pointer: String,
    pub scopes: Vec<String>,
    pub merge_strategy: ConfigMergeStrategy,
    pub sensitivity: ConfigSensitivity,
    pub apply_mode: ConfigApplyMode,
    pub lifecycle: ConfigLifecycle,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/config/")]
pub enum ConfigOrigin {
    Default,
    User,
    Project,
    Session,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/config/")]
pub struct ConfigProvenance {
    pub json_pointer: String,
    pub origin: ConfigOrigin,
    pub project_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/config/")]
pub struct ConfigDiagnostic {
    pub document: ConfigDocumentKind,
    pub scope: ConfigScope,
    pub path: Option<String>,
    pub code: String,
    pub message: String,
    pub severity: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/config/")]
pub struct ConfigDocument {
    pub kind: ConfigDocumentKind,
    pub scope: ConfigScope,
    #[ts(type = "unknown")]
    pub value: Value,
    pub etag: String,
    pub read_only: bool,
    pub invalid: bool,
    pub file_path: String,
    pub diagnostics: Vec<ConfigDiagnostic>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/config/")]
pub struct ConfigSnapshot {
    pub schema_version: u32,
    #[ts(type = "Record<string, unknown>")]
    pub effective: BTreeMap<String, Value>,
    #[ts(type = "Record<string, Record<string, unknown>>")]
    pub project_effective: BTreeMap<String, BTreeMap<String, Value>>,
    pub documents: Vec<ConfigDocument>,
    pub provenance: Vec<ConfigProvenance>,
    pub diagnostics: Vec<ConfigDiagnostic>,
    pub pending_restart_paths: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/config/")]
pub struct JsonPatchOperation {
    pub op: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "unknown")]
    pub value: Option<Value>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/config/")]
pub enum ConfigChangeSource {
    UserInterface,
    Agent,
    ExternalEditor,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/config/")]
pub struct PendingSensitiveConfigChange {
    pub id: String,
    pub document: ConfigDocumentKind,
    pub scope: ConfigScope,
    pub source: ConfigChangeSource,
    pub changed_paths: Vec<String>,
    pub reasons: Vec<String>,
    #[ts(type = "unknown")]
    pub proposed_document: Value,
    pub proposed_etag: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/config/")]
pub struct ConfigPatchRequest {
    pub kind: ConfigDocumentKind,
    #[serde(default)]
    pub scope: ConfigScope,
    pub expected_etag: String,
    pub patch: Vec<JsonPatchOperation>,
    pub source: ConfigChangeSource,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/config/")]
pub struct ConfigPatchResult {
    pub status: String,
    pub document: ConfigDocument,
    pub pending_change: Option<PendingSensitiveConfigChange>,
    pub restart_required: bool,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/config/")]
pub struct ConfigValidationResult {
    pub valid: bool,
    pub read_only: bool,
    pub diagnostics: Vec<ConfigDiagnostic>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuntimeDocument {
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(default = "current_schema_version")]
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_workspace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headless: Option<HeadlessSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_roots: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "Record<string, unknown> | null")]
    pub extensions: Option<BTreeMap<String, Value>>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HeadlessSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bind_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_start: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SettingsDocument {
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(default = "current_schema_version")]
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance: Option<AppearanceSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<CodeDisplaySettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortcuts: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_history_navigation_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notifications: Option<NotificationSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applications: Option<ApplicationSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "Record<string, unknown> | null")]
    pub extensions: Option<BTreeMap<String, Value>>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AppearanceSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zoom_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zoom_level: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_macos_titlebar_background: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_macos_titlebar_theme: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CodeDisplaySettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overflow_mode: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NotificationSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_app_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_modes: Option<BTreeMap<String, String>>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ApplicationSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editor_app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files_app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editor_command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files_command: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AgentsDocument {
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(default = "current_schema_version")]
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompts: Option<AgentPromptSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction: Option<CompactionSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_presentation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<BTreeMap<String, ModelSelection>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smart_commit_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "Record<string, unknown> | null")]
    pub extensions: Option<BTreeMap<String, Value>>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "snake_case")]
pub struct AgentPromptSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub architect: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub implement: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_explorer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_reviewer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_auditor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CompactionSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub automatic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prune: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reserved_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manual_visible: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ModelSelection {
    pub provider_id: String,
    pub model_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProvidersDocument {
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(default = "current_schema_version")]
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub providers: Option<BTreeMap<String, ProviderDefinition>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manual_models: Option<BTreeMap<String, ManualModelDefinition>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_overrides: Option<BTreeMap<String, ModelOverride>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speech_providers: Option<BTreeMap<String, SpeechProviderDefinition>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speech: Option<SpeechSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "Record<string, unknown> | null")]
    pub extensions: Option<BTreeMap<String, Value>>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProviderDefinition {
    pub provider_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_local: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "Record<string, unknown> | null")]
    pub options: Option<BTreeMap<String, Value>>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SpeechProviderDefinition {
    pub provider_type: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_local: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_ref: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ManualModelDefinition {
    pub provider_id: String,
    pub model_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ModelOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SpeechSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_duration_seconds: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enhancement_enabled: Option<bool>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ToolRiskLevel {
    Strict,
    Balanced,
    Yolo,
}

impl ToolRiskLevel {
    pub fn rank(self) -> u8 {
        match self {
            Self::Strict => 0,
            Self::Balanced => 1,
            Self::Yolo => 2,
        }
    }
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ToolsDocument {
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(default = "current_schema_version")]
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk_level: Option<ToolRiskLevel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub built_in: Option<BTreeMap<String, bool>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modes: Option<BTreeMap<String, BTreeMap<String, bool>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_search: Option<WebSearchSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_servers: Option<BTreeMap<String, McpServerDefinition>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_mcp_approvals: Option<BTreeMap<String, ContentApproval>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_commands: Option<BTreeMap<String, ExternalCommandDefinition>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_switch_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "Record<string, unknown> | null")]
    pub extensions: Option<BTreeMap<String, Value>>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WebSearchSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetch_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_results: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct McpServerDefinition {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub website: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<McpProtocolSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorization: Option<McpAuthorization>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1000, max = 300000))]
    pub startup_timeout_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1000, max = 600000))]
    pub operation_timeout_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1, max = 16))]
    pub max_concurrent_operations: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled_tools: Option<Vec<String>>,
    pub transport: McpTransport,
}

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum McpProtocolMode {
    Auto,
    Legacy,
    Modern,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct McpProtocolSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<McpProtocolMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 500, max = 15000))]
    pub probe_timeout_ms: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum McpAuthorization {
    #[serde(rename = "oauth")]
    OAuth {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_secret_ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_metadata_url: Option<String>,
        #[serde(default)]
        scopes: Vec<String>,
    },
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum McpTransport {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
    },
    Sse {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
    StreamableHttp {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ExternalCommandDefinition {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_setup_command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_terminal_on_run: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ContentApproval {
    pub content_hash: String,
    pub granted_at: String,
    pub granted_by: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SkillsDocument {
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(default = "current_schema_version")]
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conventional_roots: Option<ConventionalSkillRoots>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roots: Option<BTreeMap<String, SkillRootDefinition>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_destinations: Option<BTreeMap<String, SkillInstallDestination>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_global_destination: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_project_destination: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<BTreeMap<String, SkillPermission>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "Record<string, unknown> | null")]
    pub extensions: Option<BTreeMap<String, Value>>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConventionalSkillRoots {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opencode: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude: Option<bool>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SkillSourceType {
    Local,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SkillRootDefinition {
    #[serde(default = "default_skill_source")]
    pub source_type: SkillSourceType,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<i32>,
}

fn default_skill_source() -> SkillSourceType {
    SkillSourceType::Local
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SkillInstallDestination {
    pub scope: String,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SkillPermission {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scripts_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust: Option<ContentApproval>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GitDocument {
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(default = "current_schema_version")]
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_merge_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_templates: Option<BranchTemplateSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_target_before_finish: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata_auto_push: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata_missing_upstream_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "Record<string, unknown> | null")]
    pub extensions: Option<BTreeMap<String, Value>>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BranchTemplateSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feature: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub standalone_feature: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hotfix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bugfix: Option<String>,
}

pub fn schema_version_of(value: &Value) -> Option<u32> {
    value
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .and_then(|version| u32::try_from(version).ok())
}
