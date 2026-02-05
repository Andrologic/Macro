use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub provider_type: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub is_enabled: bool,
    pub is_local: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateConversationInput {
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateMessageInput {
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub token_count: Option<i32>,
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
