use crate::db::schema::{ChatMessage, Conversation};
use crate::db::DbPool;
use chrono::Utc;
use serde_json::Value;
use uuid::Uuid;

/// List all conversations
#[tauri::command]
pub async fn db_list_conversations(
    pool: tauri::State<'_, DbPool>,
) -> crate::core::Result<Vec<Conversation>> {
    let conversations = sqlx::query_as::<_, Conversation>(
        r#"
        SELECT id, title, task_id, project_id, last_message, message_count, updated_at, is_unread
        FROM conversations
        ORDER BY updated_at DESC
        "#,
    )
    .fetch_all(pool.inner())
    .await?;

    Ok(conversations)
}

/// List all messages for a conversation
#[tauri::command]
pub async fn db_list_messages(
    pool: tauri::State<'_, DbPool>,
    conversation_id: String,
) -> crate::core::Result<Vec<ChatMessage>> {
    let messages = sqlx::query_as::<_, ChatMessage>(
        r#"
        SELECT id, task_id, conversation_id, role, content, timestamp, code_diff, choices
        FROM messages
        WHERE conversation_id = ?
        ORDER BY timestamp ASC
        "#,
    )
    .bind(&conversation_id)
    .fetch_all(pool.inner())
    .await?;

    Ok(messages)
}

/// Save a message to a conversation
#[tauri::command]
pub async fn db_save_message(
    pool: tauri::State<'_, DbPool>,
    task_id: String,
    conversation_id: String,
    role: String,
    content: String,
    code_diff: Option<Value>,
    choices: Option<Value>,
) -> crate::core::Result<ChatMessage> {
    let message_id = Uuid::new_v4().to_string();
    let timestamp = Utc::now();

    let code_diff_json = code_diff.map(|v| v.to_string());
    let choices_json = choices.map(|v| v.to_string());

    sqlx::query(
        r#"
        INSERT INTO messages (id, task_id, conversation_id, role, content, timestamp, code_diff, choices)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&message_id)
    .bind(&task_id)
    .bind(&conversation_id)
    .bind(&role)
    .bind(&content)
    .bind(&timestamp)
    .bind(&code_diff_json)
    .bind(&choices_json)
    .execute(pool.inner())
    .await?;

    // Update conversation metadata
    sqlx::query(
        r#"
        UPDATE conversations
        SET last_message = ?,
            message_count = message_count + 1,
            updated_at = ?,
            is_unread = 1
        WHERE id = ?
        "#,
    )
    .bind(&content)
    .bind(&timestamp)
    .bind(&conversation_id)
    .execute(pool.inner())
    .await?;

    // Fetch and return the inserted message
    let message = sqlx::query_as::<_, ChatMessage>(
        r#"
        SELECT id, task_id, conversation_id, role, content, timestamp, code_diff, choices
        FROM messages
        WHERE id = ?
        "#,
    )
    .bind(&message_id)
    .fetch_one(pool.inner())
    .await?;

    Ok(message)
}

/// Create a new conversation
#[tauri::command]
pub async fn db_create_conversation(
    pool: tauri::State<'_, DbPool>,
    title: String,
    task_id: Option<String>,
    project_id: Option<String>,
) -> crate::core::Result<Conversation> {
    let conversation_id = Uuid::new_v4().to_string();
    let now = Utc::now();

    sqlx::query(
        r#"
        INSERT INTO conversations (id, title, task_id, project_id, last_message, message_count, updated_at, is_unread)
        VALUES (?, ?, ?, ?, '', 0, ?, 0)
        "#,
    )
    .bind(&conversation_id)
    .bind(&title)
    .bind(&task_id)
    .bind(&project_id)
    .bind(&now)
    .execute(pool.inner())
    .await?;

    let conversation = sqlx::query_as::<_, Conversation>(
        r#"
        SELECT id, title, task_id, project_id, last_message, message_count, updated_at, is_unread
        FROM conversations
        WHERE id = ?
        "#,
    )
    .bind(&conversation_id)
    .fetch_one(pool.inner())
    .await?;

    Ok(conversation)
}

/// Mark a conversation as read
#[tauri::command]
pub async fn db_mark_conversation_read(
    pool: tauri::State<'_, DbPool>,
    conversation_id: String,
) -> crate::core::Result<()> {
    sqlx::query(
        r#"
        UPDATE conversations
        SET is_unread = 0
        WHERE id = ?
        "#,
    )
    .bind(&conversation_id)
    .execute(pool.inner())
    .await?;

    Ok(())
}

/// Get/set settings
#[tauri::command]
pub async fn db_get_setting(
    pool: tauri::State<'_, DbPool>,
    key: String,
) -> crate::core::Result<Option<String>> {
    let result = sqlx::query_as::<_, (String,)>(
        r#"
        SELECT value FROM settings WHERE key = ?
        "#,
    )
    .bind(&key)
    .fetch_optional(pool.inner())
    .await?;

    Ok(result.map(|r| r.0))
}

#[tauri::command]
pub async fn db_set_setting(
    pool: tauri::State<'_, DbPool>,
    key: String,
    value: String,
) -> crate::core::Result<()> {
    sqlx::query(
        r#"
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        "#,
    )
    .bind(&key)
    .bind(&value)
    .execute(pool.inner())
    .await?;

    Ok(())
}
