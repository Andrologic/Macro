use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub task_id: Option<String>,
    pub project_id: Option<String>,
    pub last_message: String,
    pub message_count: i32,
    pub updated_at: DateTime<Utc>,
    pub is_unread: bool,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct ChatMessage {
    pub id: String,
    pub task_id: String,
    pub conversation_id: String,
    #[serde(rename = "role")]
    pub role: String, // "user" | "assistant"
    pub content: String,
    pub timestamp: DateTime<Utc>,
    pub code_diff: Option<String>, // JSON string for CodeDiff
    pub choices: Option<String>,   // JSON string for AIChoice[]
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Setting {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct WorkspaceCache {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct IndexJob {
    pub id: String,
    pub status: String, // "pending" | "running" | "completed" | "failed"
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub error_message: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct GitRepositoryRecord {
    pub id: String,
    pub project_id: String,
    pub path: String,
    pub default_branch: Option<String>,
    pub last_commit: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct GitWorktreeRecord {
    pub id: String,
    pub repo_id: String,
    pub project_id: String,
    pub task_id: String,
    pub worktree_name: String,
    pub path: String,
    pub branch: String,
    pub head_commit: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub is_active: bool,
    pub is_prunable: bool,
}
