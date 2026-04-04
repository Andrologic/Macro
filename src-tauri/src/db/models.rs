use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub scope_mode: String,
    pub task_id: Option<String>,
    pub group_id: Option<String>,
    pub project_id: Option<String>,
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
    pub role: String,
    pub content: String,
    pub created_at: String,
    pub token_count: Option<i32>,
    pub tool_traces_json: Option<String>,
    pub hidden_context: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSnapshot {
    pub conversations: Vec<Conversation>,
    pub messages: Vec<Message>,
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
    pub is_enabled: bool,
    pub is_manual: bool,
    pub first_seen_at: String,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderSettings {
    pub provider_id: String,
    pub filter_free_models: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettingRecord {
    pub key: String,
    pub value_json: String,
    pub updated_at: String,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateMessageInput {
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub token_count: Option<i32>,
    pub tool_traces_json: Option<String>,
    pub hidden_context: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportMessageInput {
    pub id: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateProviderConfigInput {
    pub id: String,
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
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
