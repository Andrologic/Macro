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
