use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRunStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
    TimedOut,
}

impl AgentRunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
            Self::TimedOut => "timed_out",
        }
    }
}

impl fmt::Display for AgentRunStatus {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for AgentRunStatus {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "queued" => Ok(Self::Queued),
            "running" => Ok(Self::Running),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            "interrupted" => Ok(Self::Interrupted),
            "timed_out" => Ok(Self::TimedOut),
            _ => Err(format!("Unknown agent run status: {value}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRun {
    pub id: String,
    pub parent_conversation_id: String,
    pub child_conversation_id: Option<String>,
    pub agent_profile: String,
    pub depth: i32,
    pub status: AgentRunStatus,
    pub prompt: String,
    pub result_text: Option<String>,
    pub result_json: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub error_details_json: Option<String>,
    pub cancellation_reason: Option<String>,
    pub interruption_reason: Option<String>,
    pub timeout_reason: Option<String>,
    pub model_metadata_json: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cached_input_tokens: Option<i64>,
    pub reasoning_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    pub usage_json: Option<String>,
    pub attempt_count: i32,
    pub created_at: String,
    pub updated_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub last_interrupted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateAgentRunInput {
    pub id: Option<String>,
    pub parent_conversation_id: String,
    pub child_conversation_id: Option<String>,
    pub agent_profile: String,
    pub depth: i32,
    pub prompt: String,
    pub model_metadata_json: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentRunUsageInput {
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cached_input_tokens: Option<i64>,
    pub reasoning_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    pub usage_json: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CompleteAgentRunInput {
    pub result_text: Option<String>,
    pub result_json: Option<String>,
    pub usage: AgentRunUsageInput,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailAgentRunInput {
    pub error_code: Option<String>,
    pub error_message: String,
    pub error_details_json: Option<String>,
    pub usage: AgentRunUsageInput,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CancelAgentRunInput {
    pub reason: Option<String>,
    pub usage: AgentRunUsageInput,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TimeOutAgentRunInput {
    pub reason: Option<String>,
    pub usage: AgentRunUsageInput,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub scope_mode: String,
    pub task_id: Option<String>,
    pub group_id: Option<String>,
    pub project_id: Option<String>,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub reasoning_effort: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub last_message: Option<String>,
    pub message_count: i32,
    pub is_pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub turn_id: Option<String>,
    pub role: String,
    pub content: String,
    pub created_at: String,
    pub token_count: Option<i32>,
    pub tool_traces_json: Option<String>,
    pub hidden_context: Option<String>,
    pub provider_input_items_json: Option<String>,
    pub provider_turn_state_json: Option<String>,
    pub context_refs_json: Option<String>,
    pub completion_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationCompactionStateRecord {
    pub conversation_id: String,
    pub up_to_message_id: String,
    pub summary_text: String,
    pub tool_digest_json: String,
    pub used_source_passage_ids_json: String,
    pub interesting_source_passage_ids_json: String,
    pub estimated_tokens_before: i32,
    pub estimated_tokens_after: i32,
    pub fingerprint: String,
    pub version: i32,
    pub pruned_tool_context_message_ids_json: Option<String>,
    pub reserved_tokens: Option<i32>,
    pub footprint_before_json: Option<String>,
    pub footprint_after_json: Option<String>,
    pub degraded_reason: Option<String>,
    pub compaction_kind: Option<String>,
    pub compaction_pass: Option<String>,
    pub summary_format_version: Option<i32>,
    pub summary_source: Option<String>,
    pub policy_version: Option<i32>,
    pub fingerprint_inputs_json: Option<String>,
    pub source_hashes_json: Option<String>,
    pub model_context_window_tokens: Option<i32>,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub checkpoint_health: Option<String>,
    pub last_trigger: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSnapshot {
    pub conversations: Vec<Conversation>,
    pub messages: Vec<Message>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatBootstrapSnapshot {
    pub conversations: Vec<Conversation>,
    pub messages_by_conversation_id: HashMap<String, Vec<Message>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationCitation {
    pub id: String,
    pub conversation_id: String,
    pub message_id: String,
    pub r#type: String,
    pub scope: String,
    pub source: String,
    pub title: String,
    pub snippet: Option<String>,
    pub content: Option<String>,
    pub url: Option<String>,
    pub favicon: Option<String>,
    pub path: Option<String>,
    pub language: Option<String>,
    pub size_bytes: Option<i32>,
    pub kind: Option<String>,
    pub reason: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationToolboxStateRecord {
    pub conversation_id: String,
    pub composer_context_refs_json: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchitectPlanConversationSyncRecord {
    pub conversation_id: String,
    pub plan_id: String,
    pub target_branch: String,
    pub transcript_revision: Option<String>,
    pub message_count: i32,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub provider_type: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub has_stored_api_key: bool,
    pub is_enabled: bool,
    pub is_local: bool,
    pub auth_status: Option<String>,
    pub auth_source: Option<String>,
    pub plan_type: Option<String>,
    pub account_label: Option<String>,
    pub token_expires_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderAuthMetadata {
    pub auth_status: Option<String>,
    pub auth_source: Option<String>,
    pub plan_type: Option<String>,
    pub account_label: Option<String>,
    pub token_expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiModel {
    pub id: String,
    pub provider_id: String,
    pub model_id: String,
    pub name: String,
    pub description: Option<String>,
    pub owned_by: Option<String>,
    pub pricing_prompt: Option<String>,
    pub pricing_completion: Option<String>,
    pub pricing_request: Option<String>,
    pub reasoning_efforts: Option<Vec<String>>,
    pub default_reasoning_effort: Option<String>,
    pub context_window_tokens: Option<i32>,
    pub input_limit_tokens: Option<i32>,
    pub output_limit_tokens: Option<i32>,
    pub context_window_source: Option<String>,
    pub context_limits_updated_at: Option<String>,
    pub is_enabled: bool,
    pub is_manual: bool,
    pub first_seen_at: String,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderSettings {
    pub provider_id: String,
    pub filter_free_models: bool,
    pub copilot_send_timeout_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechProviderConfig {
    pub id: String,
    pub name: String,
    pub provider_type: String,
    pub base_url: String,
    pub model: String,
    pub has_stored_api_key: bool,
    pub is_enabled: bool,
    pub is_local: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettingRecord {
    pub key: String,
    pub value_json: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompareAndSwapAppSettingResult {
    pub applied: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalTabRecord {
    pub id: String,
    pub kind: String,
    pub task_id: Option<String>,
    pub project_id: String,
    pub project_name: String,
    pub mount_name: String,
    pub workspace_path: String,
    pub cwd: String,
    pub title: String,
    pub prompt_context_json: Option<String>,
    pub status: String,
    pub snapshot: String,
    pub last_command: Option<String>,
    pub last_exit_code: Option<i32>,
    pub generation: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectContextStateRecord {
    pub project_id: String,
    pub group_id: Option<String>,
    pub focus_project_id: Option<String>,
    pub last_plan_id: Option<String>,
    pub last_task_id: Option<String>,
    pub architect_conversation_id: Option<String>,
    pub implement_conversation_id: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionContextStateRecord {
    pub selected_group_id: Option<String>,
    pub selected_project_id: Option<String>,
    pub mode: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateConversationInput {
    pub title: Option<String>,
    pub scope_mode: String,
    pub task_id: Option<String>,
    pub group_id: Option<String>,
    pub project_id: Option<String>,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateMessageInput {
    pub id: Option<String>,
    pub conversation_id: String,
    pub turn_id: Option<String>,
    pub role: String,
    pub content: String,
    pub token_count: Option<i32>,
    pub tool_traces_json: Option<String>,
    pub hidden_context: Option<String>,
    pub provider_input_items_json: Option<String>,
    pub provider_turn_state_json: Option<String>,
    pub context_refs_json: Option<String>,
    pub completion_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportMessageInput {
    pub id: String,
    pub turn_id: Option<String>,
    pub role: String,
    pub content: String,
    pub created_at: String,
    pub completion_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpsertConversationCitationInput {
    pub id: String,
    pub conversation_id: String,
    pub message_id: String,
    pub r#type: String,
    pub scope: String,
    pub source: String,
    pub title: String,
    pub snippet: Option<String>,
    pub content: Option<String>,
    pub url: Option<String>,
    pub favicon: Option<String>,
    pub path: Option<String>,
    pub language: Option<String>,
    pub size_bytes: Option<i32>,
    pub kind: Option<String>,
    pub reason: Option<String>,
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpsertConversationToolboxStateInput {
    pub conversation_id: String,
    pub composer_context_refs_json: String,
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpsertArchitectPlanConversationSyncInput {
    pub conversation_id: String,
    pub plan_id: String,
    pub target_branch: String,
    pub transcript_revision: Option<String>,
    pub message_count: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateProviderConfigInput {
    pub id: String,
    pub name: Option<String>,
    pub provider_type: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub is_local: Option<bool>,
    pub is_enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitRepositoryRecord {
    pub id: String,
    pub project_id: String,
    pub path: String,
    pub default_branch: Option<String>,
    pub last_commit: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitWorktreeRecord {
    pub id: String,
    pub repo_id: String,
    pub project_id: String,
    pub task_id: String,
    pub worktree_name: String,
    pub path: String,
    pub branch: String,
    pub head_commit: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub last_used_at: Option<String>,
    pub is_active: bool,
    pub is_prunable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateGitRepositoryInput {
    pub project_id: String,
    pub path: String,
    pub default_branch: Option<String>,
    pub last_commit: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateGitWorktreeInput {
    pub repo_id: String,
    pub project_id: String,
    pub task_id: String,
    pub worktree_name: String,
    pub path: String,
    pub branch: String,
    pub head_commit: Option<String>,
    pub is_active: bool,
    pub is_prunable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderModelInput {
    pub model_id: String,
    pub name: String,
    pub description: Option<String>,
    pub owned_by: Option<String>,
    pub pricing_prompt: Option<String>,
    pub pricing_completion: Option<String>,
    pub pricing_request: Option<String>,
    pub reasoning_efforts: Option<Vec<String>>,
    pub default_reasoning_effort: Option<String>,
    pub context_window_tokens: Option<i32>,
    pub input_limit_tokens: Option<i32>,
    pub output_limit_tokens: Option<i32>,
    pub context_window_source: Option<String>,
    pub context_limits_updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpsertConversationCompactionStateInput {
    pub conversation_id: String,
    pub up_to_message_id: String,
    pub summary_text: String,
    pub tool_digest_json: String,
    pub used_source_passage_ids_json: String,
    pub interesting_source_passage_ids_json: String,
    pub estimated_tokens_before: i32,
    pub estimated_tokens_after: i32,
    pub fingerprint: String,
    pub version: i32,
    pub pruned_tool_context_message_ids_json: Option<String>,
    pub reserved_tokens: Option<i32>,
    pub footprint_before_json: Option<String>,
    pub footprint_after_json: Option<String>,
    pub degraded_reason: Option<String>,
    pub compaction_kind: Option<String>,
    pub compaction_pass: Option<String>,
    pub summary_format_version: Option<i32>,
    pub summary_source: Option<String>,
    pub policy_version: Option<i32>,
    pub fingerprint_inputs_json: Option<String>,
    pub source_hashes_json: Option<String>,
    pub model_context_window_tokens: Option<i32>,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub checkpoint_health: Option<String>,
    pub last_trigger: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsertConversationCompactionEventInput {
    pub conversation_id: String,
    pub trigger: String,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub model_context_window_tokens: Option<i32>,
    pub tokens_before: Option<i32>,
    pub tokens_after: Option<i32>,
    pub status: String,
    pub error_code: Option<String>,
    pub reason: Option<String>,
    pub metadata_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpsertProjectContextStateInput {
    pub project_id: String,
    pub group_id: Option<String>,
    pub focus_project_id: Option<String>,
    pub last_plan_id: Option<String>,
    pub last_task_id: Option<String>,
    pub architect_conversation_id: Option<String>,
    pub implement_conversation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpsertSessionContextStateInput {
    pub selected_group_id: Option<String>,
    pub selected_project_id: Option<String>,
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReconcileProjectRegistryInput {
    pub valid_group_ids: Vec<String>,
    pub valid_project_ids: Vec<String>,
    pub selected_group_id: Option<String>,
    pub selected_project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRegistryDbRepairReport {
    pub conversations_updated: usize,
    pub project_contexts_deleted: usize,
    pub project_contexts_updated: usize,
    pub session_context_updated: bool,
}
