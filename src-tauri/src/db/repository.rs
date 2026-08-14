use super::models::*;
use super::DbError;
use super::DbResult;
use serde_json::Value;
use sqlx::sqlite::{SqliteConnection, SqlitePool};
use sqlx::Row;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct ReplayRecoverySnapshot {
    replay_id: String,
    conversation_id: String,
    message_id: String,
    session_id: String,
    turn_id: String,
    /// Canonical transcript revision before the replay trim. This lets recovery
    /// distinguish its own empty placeholder from a later transcript write.
    transcript_revision: String,
    prepared_message_content: String,
    phase: String,
    original_message: Message,
    tail_messages: Vec<Message>,
    citations: Vec<ConversationCitation>,
    checkpoints_json: Option<String>,
    compaction_state: Option<ConversationCompactionStateRecord>,
    compaction_events: Vec<ReplayCompactionEvent>,
}

fn replay_transcript_revision(message: &Message, tail_messages: &[Message]) -> String {
    let tail = tail_messages
        .iter()
        .map(|message| format!("{}:{}", message.id, message.created_at))
        .collect::<Vec<_>>()
        .join(",");
    format!("{}:{}:{}", message.id, message.created_at, tail)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct ReplayCompactionEvent {
    id: String,
    conversation_id: String,
    trigger: String,
    provider_id: Option<String>,
    model_id: Option<String>,
    model_context_window_tokens: Option<i32>,
    tokens_before: Option<i32>,
    tokens_after: Option<i32>,
    status: String,
    error_code: Option<String>,
    reason: Option<String>,
    metadata_json: Option<String>,
    created_at: String,
}

pub struct PrepareConversationReplayInput<'a> {
    pub conversation_id: &'a str,
    pub message_id: &'a str,
    pub session_id: &'a str,
    pub turn_id: &'a str,
    pub replay_id: &'a str,
    pub content: &'a str,
    pub hidden_context: Option<String>,
    pub provider_input_items_json: Option<String>,
    pub code_checkpoints_json: Option<String>,
    pub delete_context_compaction_state: bool,
}

fn replay_recovery_key(conversation_id: &str) -> String {
    format!("conversationReplayRecovery:{conversation_id}")
}

fn parse_reasoning_efforts(raw: Option<String>) -> Option<Vec<String>> {
    let raw = raw?;

    serde_json::from_str::<Vec<Value>>(&raw)
        .ok()
        .and_then(|values| {
            let efforts = values
                .into_iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect::<Vec<_>>();

            if efforts.is_empty() {
                None
            } else {
                Some(efforts)
            }
        })
}

#[cfg(test)]
mod terminal_tab_tests {
    use super::*;

    fn terminal_tab(generation: i64, snapshot: &str) -> TerminalTabRecord {
        TerminalTabRecord {
            id: "terminal-tab-generation".to_string(),
            kind: "manual".to_string(),
            task_id: None,
            project_id: "project-1".to_string(),
            project_name: "Project".to_string(),
            mount_name: "project".to_string(),
            workspace_path: "/workspace/project".to_string(),
            cwd: "/workspace/project".to_string(),
            title: "Terminal".to_string(),
            prompt_context_json: None,
            status: "idle".to_string(),
            snapshot: snapshot.to_string(),
            last_command: None,
            last_exit_code: None,
            generation,
            created_at: "2026-08-11T10:00:00Z".to_string(),
            updated_at: format!("2026-08-11T10:00:0{generation}Z"),
        }
    }

    #[tokio::test]
    async fn terminal_tab_upsert_rejects_an_older_generation() {
        let pool = SqlitePool::connect("sqlite::memory:")
            .await
            .expect("open in-memory database");
        sqlx::query(
            r#"
            CREATE TABLE terminal_tabs (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, task_id TEXT, project_id TEXT NOT NULL,
                project_name TEXT NOT NULL, mount_name TEXT NOT NULL, workspace_path TEXT NOT NULL,
                cwd TEXT NOT NULL, title TEXT NOT NULL, prompt_context_json TEXT, status TEXT NOT NULL,
                snapshot TEXT NOT NULL, last_command TEXT, last_exit_code INTEGER,
                generation INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            )
            "#,
        )
        .execute(&pool)
        .await
        .expect("create terminal tab table");

        upsert_terminal_tab(&pool, &terminal_tab(2, "new snapshot"))
            .await
            .expect("persist new generation");
        upsert_terminal_tab(&pool, &terminal_tab(1, "old snapshot"))
            .await
            .expect("attempt old generation");

        let persisted = get_terminal_tab(&pool, "terminal-tab-generation")
            .await
            .expect("read terminal tab")
            .expect("terminal tab exists");
        assert_eq!(persisted.generation, 2);
        assert_eq!(persisted.snapshot, "new snapshot");
    }
}

fn serialize_reasoning_efforts(efforts: Option<&Vec<String>>) -> Option<String> {
    let efforts = efforts.filter(|items| !items.is_empty())?;

    serde_json::to_string(efforts).ok()
}

// ============ CONVERSATIONS ============

pub async fn list_conversations(pool: &SqlitePool) -> DbResult<Vec<Conversation>> {
    let rows = sqlx::query(
        r#"
        SELECT id, title, description, scope_mode, task_id, group_id, project_id,
               provider_id, model_id, reasoning_effort,
               created_at, updated_at, last_message, message_count, is_pinned
        FROM conversations
        ORDER BY is_pinned DESC, updated_at DESC, id ASC
        "#,
    )
    .fetch_all(pool)
    .await?;

    let conversations = rows
        .into_iter()
        .map(|row| Conversation {
            id: row.get("id"),
            title: row.get("title"),
            description: row.get("description"),
            scope_mode: row.get("scope_mode"),
            task_id: row.get("task_id"),
            group_id: row.get("group_id"),
            project_id: row.get("project_id"),
            provider_id: row.get("provider_id"),
            model_id: row.get("model_id"),
            reasoning_effort: row.get("reasoning_effort"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
            last_message: row.get("last_message"),
            message_count: row.get("message_count"),
            is_pinned: row.get::<i32, _>("is_pinned") != 0,
        })
        .collect();

    Ok(conversations)
}

pub async fn get_conversation(pool: &SqlitePool, id: &str) -> DbResult<Option<Conversation>> {
    let row = sqlx::query(
        r#"
        SELECT id, title, description, scope_mode, task_id, group_id, project_id,
               provider_id, model_id, reasoning_effort,
               created_at, updated_at, last_message, message_count, is_pinned
        FROM conversations
        WHERE id = ?
        "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|row| Conversation {
        id: row.get("id"),
        title: row.get("title"),
        description: row.get("description"),
        scope_mode: row.get("scope_mode"),
        task_id: row.get("task_id"),
        group_id: row.get("group_id"),
        project_id: row.get("project_id"),
        provider_id: row.get("provider_id"),
        model_id: row.get("model_id"),
        reasoning_effort: row.get("reasoning_effort"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        last_message: row.get("last_message"),
        message_count: row.get("message_count"),
        is_pinned: row.get::<i32, _>("is_pinned") != 0,
    }))
}

pub async fn create_conversation(
    pool: &SqlitePool,
    input: CreateConversationInput,
) -> DbResult<Conversation> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let title = input
        .title
        .unwrap_or_else(|| "New Conversation".to_string());

    sqlx::query(
        r#"
        INSERT INTO conversations (
            id, title, description, scope_mode, task_id, group_id, project_id,
            provider_id, model_id, reasoning_effort,
            created_at, updated_at, message_count, is_pinned
        )
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
        "#,
    )
    .bind(&id)
    .bind(&title)
    .bind(&input.scope_mode)
    .bind(&input.task_id)
    .bind(&input.group_id)
    .bind(&input.project_id)
    .bind(&input.provider_id)
    .bind(&input.model_id)
    .bind(&input.reasoning_effort)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(Conversation {
        id,
        title,
        description: None,
        scope_mode: input.scope_mode,
        task_id: input.task_id,
        group_id: input.group_id,
        project_id: input.project_id,
        provider_id: input.provider_id,
        model_id: input.model_id,
        reasoning_effort: input.reasoning_effort,
        created_at: now.clone(),
        updated_at: now,
        last_message: None,
        message_count: 0,
        is_pinned: false,
    })
}

fn truncate_last_message(content: &str) -> String {
    let mut truncated = content.chars().take(100).collect::<String>();
    if content.chars().count() > 100 {
        truncated.push_str("...");
    }
    truncated
}

async fn refresh_conversation_metadata_with_connection(
    connection: &mut SqliteConnection,
    conversation_id: String,
    updated_at_override: Option<String>,
) -> DbResult<()> {
    let count: i32 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE conversation_id = ?")
        .bind(&conversation_id)
        .fetch_one(&mut *connection)
        .await?;

    let latest_row = sqlx::query(
        r#"
        SELECT content, created_at
        FROM messages
        WHERE conversation_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        "#,
    )
    .bind(&conversation_id)
    .fetch_optional(&mut *connection)
    .await?;

    let last_message = latest_row
        .as_ref()
        .map(|row| truncate_last_message(&row.get::<String, _>("content")));
    let fallback_updated_at = chrono::Utc::now().to_rfc3339();
    let updated_at = updated_at_override
        .clone()
        .or_else(|| {
            latest_row
                .as_ref()
                .map(|row| row.get::<String, _>("created_at"))
        })
        .unwrap_or(fallback_updated_at);

    sqlx::query(
        r#"
        UPDATE conversations
        SET last_message = ?, message_count = ?, updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(last_message.as_deref())
    .bind(count)
    .bind(&updated_at)
    .bind(&conversation_id)
    .execute(&mut *connection)
    .await?;

    Ok(())
}

pub async fn rename_conversation(pool: &SqlitePool, id: &str, title: &str) -> DbResult<()> {
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        r#"
        UPDATE conversations
        SET title = ?, updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(title)
    .bind(&now)
    .bind(id)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn update_conversation_details(
    pool: &SqlitePool,
    id: &str,
    title: Option<&str>,
    description: Option<&str>,
) -> DbResult<()> {
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        r#"
        UPDATE conversations
        SET title = COALESCE(?, title), description = COALESCE(?, description), updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(title)
    .bind(description)
    .bind(&now)
    .bind(id)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn update_conversation_scope(
    pool: &SqlitePool,
    id: &str,
    scope_mode: &str,
    task_id: Option<&str>,
    group_id: Option<&str>,
    project_id: Option<&str>,
) -> DbResult<()> {
    sqlx::query(
        r#"
        UPDATE conversations
        SET scope_mode = ?, task_id = ?, group_id = ?, project_id = ?
        WHERE id = ?
        "#,
    )
    .bind(scope_mode)
    .bind(task_id)
    .bind(group_id)
    .bind(project_id)
    .bind(id)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn update_conversation_ai_selection(
    pool: &SqlitePool,
    id: &str,
    provider_id: Option<&str>,
    model_id: Option<&str>,
    reasoning_effort: Option<&str>,
) -> DbResult<()> {
    sqlx::query(
        r#"
        UPDATE conversations
        SET provider_id = ?, model_id = ?, reasoning_effort = ?
        WHERE id = ?
        "#,
    )
    .bind(provider_id)
    .bind(model_id)
    .bind(reasoning_effort)
    .bind(id)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn delete_conversation(pool: &SqlitePool, id: &str) -> DbResult<()> {
    delete_conversations(pool, &[id.to_string()]).await
}

pub async fn delete_conversations(pool: &SqlitePool, ids: &[String]) -> DbResult<()> {
    if ids.is_empty() {
        return Ok(());
    }

    let placeholders = vec!["?"; ids.len()].join(", ");
    let query = format!("DELETE FROM conversations WHERE id IN ({})", placeholders);

    let mut tx = pool.begin().await?;
    // Checkpoints are intentionally stored as app settings so older databases
    // can replay them. They have no foreign key, therefore delete them in the
    // same transaction as their owning conversations.
    for id in ids {
        sqlx::query("DELETE FROM app_settings WHERE key = ?")
            .bind(format!("agentCodeCheckpoints:{}", id))
            .execute(&mut *tx)
            .await?;
    }
    let mut statement = sqlx::query(&query);
    for id in ids {
        statement = statement.bind(id);
    }
    statement.execute(&mut *tx).await?;
    tx.commit().await?;

    Ok(())
}

pub async fn toggle_pin_conversation(pool: &SqlitePool, id: &str) -> DbResult<bool> {
    let row = sqlx::query("SELECT is_pinned FROM conversations WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await?;

    let is_pinned: i32 = row.get("is_pinned");
    let new_pinned = if is_pinned == 0 { 1 } else { 0 };

    sqlx::query("UPDATE conversations SET is_pinned = ? WHERE id = ?")
        .bind(new_pinned)
        .bind(id)
        .execute(pool)
        .await?;

    Ok(new_pinned != 0)
}

// ============ GIT REPOSITORIES ============

pub async fn upsert_git_repository(
    pool: &SqlitePool,
    input: CreateGitRepositoryInput,
) -> DbResult<GitRepositoryRecord> {
    let now = chrono::Utc::now().to_rfc3339();
    let new_id = uuid::Uuid::new_v4().to_string();

    sqlx::query(
        r#"
        INSERT INTO git_repositories (id, project_id, path, default_branch, last_commit, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
            project_id = excluded.project_id,
            default_branch = excluded.default_branch,
            last_commit = excluded.last_commit,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(&new_id)
    .bind(&input.project_id)
    .bind(&input.path)
    .bind(&input.default_branch)
    .bind(&input.last_commit)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;

    let row = sqlx::query(
        r#"
        SELECT id, project_id, path, default_branch, last_commit, created_at, updated_at
        FROM git_repositories
        WHERE path = ?
        "#,
    )
    .bind(&input.path)
    .fetch_one(pool)
    .await?;

    Ok(GitRepositoryRecord {
        id: row.get("id"),
        project_id: row.get("project_id"),
        path: row.get("path"),
        default_branch: row.get("default_branch"),
        last_commit: row.get("last_commit"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

pub async fn upsert_git_worktree(
    pool: &SqlitePool,
    input: CreateGitWorktreeInput,
) -> DbResult<GitWorktreeRecord> {
    let now = chrono::Utc::now().to_rfc3339();
    let new_id = uuid::Uuid::new_v4().to_string();

    sqlx::query(
        r#"
        INSERT INTO git_worktrees (
            id, repo_id, project_id, task_id, worktree_name, path, branch, head_commit,
            created_at, updated_at, last_used_at, is_active, is_prunable
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
            repo_id = excluded.repo_id,
            project_id = excluded.project_id,
            task_id = excluded.task_id,
            worktree_name = excluded.worktree_name,
            branch = excluded.branch,
            head_commit = excluded.head_commit,
            updated_at = excluded.updated_at,
            last_used_at = excluded.last_used_at,
            is_active = excluded.is_active,
            is_prunable = excluded.is_prunable
        "#,
    )
    .bind(&new_id)
    .bind(&input.repo_id)
    .bind(&input.project_id)
    .bind(&input.task_id)
    .bind(&input.worktree_name)
    .bind(&input.path)
    .bind(&input.branch)
    .bind(&input.head_commit)
    .bind(&now)
    .bind(&now)
    .bind(&now)
    .bind(if input.is_active { 1 } else { 0 })
    .bind(if input.is_prunable { 1 } else { 0 })
    .execute(pool)
    .await?;

    let row = sqlx::query(
        r#"
        SELECT id, repo_id, project_id, task_id, worktree_name, path, branch, head_commit,
               created_at, updated_at, last_used_at, is_active, is_prunable
        FROM git_worktrees
        WHERE path = ?
        "#,
    )
    .bind(&input.path)
    .fetch_one(pool)
    .await?;

    Ok(GitWorktreeRecord {
        id: row.get("id"),
        repo_id: row.get("repo_id"),
        project_id: row.get("project_id"),
        task_id: row.get("task_id"),
        worktree_name: row.get("worktree_name"),
        path: row.get("path"),
        branch: row.get("branch"),
        head_commit: row.get("head_commit"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        last_used_at: row.get("last_used_at"),
        is_active: row.get::<i32, _>("is_active") != 0,
        is_prunable: row.get::<i32, _>("is_prunable") != 0,
    })
}

pub async fn list_git_worktrees_by_project(
    pool: &SqlitePool,
    project_id: &str,
) -> DbResult<Vec<GitWorktreeRecord>> {
    let rows = sqlx::query(
        r#"
        SELECT id, repo_id, project_id, task_id, worktree_name, path, branch, head_commit,
               created_at, updated_at, last_used_at, is_active, is_prunable
        FROM git_worktrees
        WHERE project_id = ?
        ORDER BY updated_at DESC
        "#,
    )
    .bind(project_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| GitWorktreeRecord {
            id: row.get("id"),
            repo_id: row.get("repo_id"),
            project_id: row.get("project_id"),
            task_id: row.get("task_id"),
            worktree_name: row.get("worktree_name"),
            path: row.get("path"),
            branch: row.get("branch"),
            head_commit: row.get("head_commit"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
            last_used_at: row.get("last_used_at"),
            is_active: row.get::<i32, _>("is_active") != 0,
            is_prunable: row.get::<i32, _>("is_prunable") != 0,
        })
        .collect())
}

pub async fn update_git_worktree_project_access(
    pool: &SqlitePool,
    project_id: &str,
    is_active: bool,
    is_prunable: bool,
) -> DbResult<()> {
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        r#"
        UPDATE git_worktrees
        SET is_active = ?, is_prunable = ?, updated_at = ?
        WHERE project_id = ?
        "#,
    )
    .bind(if is_active { 1 } else { 0 })
    .bind(if is_prunable { 1 } else { 0 })
    .bind(now)
    .bind(project_id)
    .execute(pool)
    .await?;

    Ok(())
}

// ============ MESSAGES ============

pub async fn list_messages(pool: &SqlitePool, conversation_id: &str) -> DbResult<Vec<Message>> {
    let rows = sqlx::query(
        r#"
        SELECT id, conversation_id, turn_id, role, content, created_at, token_count, tool_traces_json, hidden_context, provider_input_items_json, provider_turn_state_json, context_refs_json, completion_reason
        FROM messages
        WHERE conversation_id = ?
        ORDER BY created_at ASC, id ASC
        "#,
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await?;

    let messages = rows
        .into_iter()
        .map(|row| Message {
            id: row.get("id"),
            conversation_id: row.get("conversation_id"),
            turn_id: row.get("turn_id"),
            role: row.get("role"),
            content: row.get("content"),
            created_at: row.get("created_at"),
            token_count: row.get("token_count"),
            tool_traces_json: row.get("tool_traces_json"),
            hidden_context: row.get("hidden_context"),
            provider_input_items_json: row.get("provider_input_items_json"),
            provider_turn_state_json: row.get("provider_turn_state_json"),
            context_refs_json: row.get("context_refs_json"),
            completion_reason: row.get("completion_reason"),
        })
        .collect();

    Ok(messages)
}

pub async fn list_all_messages(pool: &SqlitePool) -> DbResult<Vec<Message>> {
    let rows = sqlx::query(
        r#"
        SELECT id, conversation_id, turn_id, role, content, created_at, token_count, tool_traces_json, hidden_context, provider_input_items_json, provider_turn_state_json, context_refs_json, completion_reason
        FROM messages
        ORDER BY created_at ASC, id ASC
        "#,
    )
    .fetch_all(pool)
    .await?;

    let messages = rows
        .into_iter()
        .map(|row| Message {
            id: row.get("id"),
            conversation_id: row.get("conversation_id"),
            turn_id: row.get("turn_id"),
            role: row.get("role"),
            content: row.get("content"),
            created_at: row.get("created_at"),
            token_count: row.get("token_count"),
            tool_traces_json: row.get("tool_traces_json"),
            hidden_context: row.get("hidden_context"),
            provider_input_items_json: row.get("provider_input_items_json"),
            provider_turn_state_json: row.get("provider_turn_state_json"),
            context_refs_json: row.get("context_refs_json"),
            completion_reason: row.get("completion_reason"),
        })
        .collect();

    Ok(messages)
}

pub async fn get_chat_snapshot(pool: &SqlitePool) -> DbResult<ChatSnapshot> {
    let conversations = list_conversations(pool).await?;
    let messages = list_all_messages(pool).await?;

    Ok(ChatSnapshot {
        conversations,
        messages,
    })
}

pub async fn get_chat_bootstrap_snapshot(
    pool: &SqlitePool,
    preload_conversation_ids: &[String],
) -> DbResult<ChatBootstrapSnapshot> {
    let mut transaction = pool.begin().await?;
    let conversation_rows = sqlx::query(
        r#"
        SELECT id, title, description, scope_mode, task_id, group_id, project_id,
               provider_id, model_id, reasoning_effort,
               created_at, updated_at, last_message, message_count, is_pinned
        FROM conversations
        ORDER BY is_pinned DESC, updated_at DESC, id ASC
        "#,
    )
    .fetch_all(&mut *transaction)
    .await?;

    let conversations = conversation_rows
        .into_iter()
        .map(|row| Conversation {
            id: row.get("id"),
            title: row.get("title"),
            description: row.get("description"),
            scope_mode: row.get("scope_mode"),
            task_id: row.get("task_id"),
            group_id: row.get("group_id"),
            project_id: row.get("project_id"),
            provider_id: row.get("provider_id"),
            model_id: row.get("model_id"),
            reasoning_effort: row.get("reasoning_effort"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
            last_message: row.get("last_message"),
            message_count: row.get("message_count"),
            is_pinned: row.get::<i32, _>("is_pinned") != 0,
        })
        .collect::<Vec<_>>();

    let mut unique_preload_ids = Vec::new();
    let mut seen_preload_ids = HashSet::new();
    for conversation_id in preload_conversation_ids {
        let trimmed = conversation_id.trim();
        if !trimmed.is_empty() && seen_preload_ids.insert(trimmed.to_string()) {
            unique_preload_ids.push(trimmed.to_string());
        }
    }

    let mut messages_by_conversation_id: HashMap<String, Vec<Message>> = HashMap::new();
    if !unique_preload_ids.is_empty() {
        let placeholders = vec!["?"; unique_preload_ids.len()].join(", ");
        let query = format!(
            r#"
            SELECT id, conversation_id, turn_id, role, content, created_at, token_count, tool_traces_json, hidden_context, provider_input_items_json, provider_turn_state_json, context_refs_json, completion_reason
            FROM messages
            WHERE conversation_id IN ({})
            ORDER BY conversation_id ASC, created_at ASC, id ASC
            "#,
            placeholders
        );
        let mut statement = sqlx::query(&query);
        for conversation_id in &unique_preload_ids {
            statement = statement.bind(conversation_id);
        }
        let rows = statement.fetch_all(&mut *transaction).await?;
        for row in rows {
            let message = Message {
                id: row.get("id"),
                conversation_id: row.get("conversation_id"),
                turn_id: row.get("turn_id"),
                role: row.get("role"),
                content: row.get("content"),
                created_at: row.get("created_at"),
                token_count: row.get("token_count"),
                tool_traces_json: row.get("tool_traces_json"),
                hidden_context: row.get("hidden_context"),
                provider_input_items_json: row.get("provider_input_items_json"),
                provider_turn_state_json: row.get("provider_turn_state_json"),
                context_refs_json: row.get("context_refs_json"),
                completion_reason: row.get("completion_reason"),
            };
            messages_by_conversation_id
                .entry(message.conversation_id.clone())
                .or_default()
                .push(message);
        }
    }

    transaction.commit().await?;

    Ok(ChatBootstrapSnapshot {
        conversations,
        messages_by_conversation_id,
    })
}

pub async fn create_message(pool: &SqlitePool, input: CreateMessageInput) -> DbResult<Message> {
    let id = input
        .id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = chrono::Utc::now().to_rfc3339();

    let mut transaction = pool.begin().await?;
    sqlx::query(
        r#"
        INSERT INTO messages (
            id,
            conversation_id,
            turn_id,
            role,
            content,
            created_at,
            token_count,
            tool_traces_json,
            hidden_context,
            provider_input_items_json,
            provider_turn_state_json,
            context_refs_json,
            completion_reason
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&id)
    .bind(&input.conversation_id)
    .bind(&input.turn_id)
    .bind(&input.role)
    .bind(&input.content)
    .bind(&now)
    .bind(input.token_count)
    .bind(&input.tool_traces_json)
    .bind(&input.hidden_context)
    .bind(&input.provider_input_items_json)
    .bind(&input.provider_turn_state_json)
    .bind(&input.context_refs_json)
    .bind(&input.completion_reason)
    .execute(&mut *transaction)
    .await?;

    refresh_conversation_metadata_with_connection(
        &mut *transaction,
        input.conversation_id.clone(),
        Some(now.clone()),
    )
    .await?;
    transaction.commit().await?;

    Ok(Message {
        id,
        conversation_id: input.conversation_id,
        turn_id: input.turn_id,
        role: input.role,
        content: input.content,
        created_at: now,
        token_count: input.token_count,
        tool_traces_json: input.tool_traces_json,
        hidden_context: input.hidden_context,
        provider_input_items_json: input.provider_input_items_json,
        provider_turn_state_json: input.provider_turn_state_json,
        context_refs_json: input.context_refs_json,
        completion_reason: input.completion_reason,
    })
}

pub async fn import_messages(
    pool: &SqlitePool,
    conversation_id: &str,
    messages: Vec<ImportMessageInput>,
) -> DbResult<Vec<Message>> {
    let mut transaction = pool.begin().await?;
    let mut inserted = Vec::new();
    let mut last_created_at: Option<String> = None;

    for message in messages {
        let result = sqlx::query(
            r#"
            INSERT INTO messages (
                id,
                conversation_id,
                turn_id,
                role,
                content,
                created_at,
                token_count,
                tool_traces_json,
                hidden_context,
                provider_input_items_json,
                provider_turn_state_json,
                context_refs_json,
                completion_reason
            )
            VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)
            ON CONFLICT(id) DO NOTHING
            "#,
        )
        .bind(&message.id)
        .bind(conversation_id)
        .bind(&message.turn_id)
        .bind(&message.role)
        .bind(&message.content)
        .bind(&message.created_at)
        .bind(&message.completion_reason)
        .execute(&mut *transaction)
        .await?;

        if result.rows_affected() == 0 {
            continue;
        }

        last_created_at = Some(message.created_at.clone());
        inserted.push(Message {
            id: message.id,
            conversation_id: conversation_id.to_string(),
            turn_id: message.turn_id,
            role: message.role,
            content: message.content,
            created_at: message.created_at,
            token_count: None,
            tool_traces_json: None,
            hidden_context: None,
            provider_input_items_json: None,
            provider_turn_state_json: None,
            context_refs_json: None,
            completion_reason: message.completion_reason,
        });
    }

    if last_created_at.is_some() {
        refresh_conversation_metadata_with_connection(
            &mut *transaction,
            conversation_id.to_string(),
            None,
        )
        .await?;
    }
    transaction.commit().await?;

    Ok(inserted)
}

pub struct UpdateMessageContentInput<'a> {
    pub id: &'a str,
    pub turn_id: Option<String>,
    pub content: &'a str,
    pub token_count: Option<i32>,
    pub tool_traces_json: Option<String>,
    pub hidden_context: Option<String>,
    pub provider_input_items_json: Option<String>,
    pub provider_turn_state_json: Option<String>,
    pub context_refs_json: Option<String>,
    pub completion_reason: Option<String>,
}

pub async fn update_message_content(
    pool: &SqlitePool,
    input: UpdateMessageContentInput<'_>,
) -> DbResult<()> {
    let UpdateMessageContentInput {
        id,
        turn_id,
        content,
        token_count,
        tool_traces_json,
        hidden_context,
        provider_input_items_json,
        provider_turn_state_json,
        context_refs_json,
        completion_reason,
    } = input;

    let mut transaction = pool.begin().await?;
    let conversation_id: Option<String> =
        sqlx::query_scalar("SELECT conversation_id FROM messages WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *transaction)
            .await?;

    sqlx::query(
        r#"
        UPDATE messages
        SET content = ?, turn_id = COALESCE(?, turn_id), token_count = ?, tool_traces_json = ?, hidden_context = ?, provider_input_items_json = ?, provider_turn_state_json = ?, context_refs_json = ?, completion_reason = COALESCE(?, completion_reason)
        WHERE id = ?
        "#,
    )
    .bind(content)
    .bind(turn_id)
    .bind(token_count)
    .bind(tool_traces_json)
    .bind(hidden_context)
    .bind(provider_input_items_json)
    .bind(provider_turn_state_json)
    .bind(context_refs_json)
    .bind(completion_reason)
    .bind(id)
    .execute(&mut *transaction)
    .await?;

    if let Some(conversation_id) = conversation_id {
        refresh_conversation_metadata_with_connection(&mut *transaction, conversation_id, None)
            .await?;
    }

    transaction.commit().await?;

    Ok(())
}

pub async fn delete_messages_after(
    pool: &SqlitePool,
    conversation_id: &str,
    after_message_id: &str,
) -> DbResult<()> {
    let mut transaction = pool.begin().await?;
    let row = sqlx::query("SELECT created_at FROM messages WHERE id = ?")
        .bind(after_message_id)
        .fetch_one(&mut *transaction)
        .await?;

    let created_at: String = row.get("created_at");

    sqlx::query(
        r#"
        DELETE FROM messages
        WHERE conversation_id = ?
          AND (created_at > ? OR (created_at = ? AND id > ?))
        "#,
    )
    .bind(conversation_id)
    .bind(&created_at)
    .bind(&created_at)
    .bind(after_message_id)
    .execute(&mut *transaction)
    .await?;
    refresh_conversation_metadata_with_connection(
        &mut *transaction,
        conversation_id.to_string(),
        None,
    )
    .await?;
    transaction.commit().await?;

    Ok(())
}

pub async fn trim_conversation_replay(
    pool: &SqlitePool,
    conversation_id: &str,
    after_message_id: &str,
    code_checkpoints_json: Option<&str>,
    delete_context_compaction_state: bool,
) -> DbResult<()> {
    let mut transaction = pool.begin().await?;
    let row = sqlx::query("SELECT created_at FROM messages WHERE id = ? AND conversation_id = ?")
        .bind(after_message_id)
        .bind(conversation_id)
        .fetch_one(&mut *transaction)
        .await?;
    let created_at: String = row.get("created_at");

    sqlx::query(
        r#"
        DELETE FROM conversation_citations
        WHERE conversation_id = ?
          AND message_id IN (
              SELECT id FROM messages
              WHERE conversation_id = ?
                AND (created_at > ? OR (created_at = ? AND id > ?))
          )
        "#,
    )
    .bind(conversation_id)
    .bind(conversation_id)
    .bind(&created_at)
    .bind(&created_at)
    .bind(after_message_id)
    .execute(&mut *transaction)
    .await?;

    sqlx::query(
        r#"
        DELETE FROM messages
        WHERE conversation_id = ?
          AND (created_at > ? OR (created_at = ? AND id > ?))
        "#,
    )
    .bind(conversation_id)
    .bind(&created_at)
    .bind(&created_at)
    .bind(after_message_id)
    .execute(&mut *transaction)
    .await?;

    if let Some(code_checkpoints_json) = code_checkpoints_json {
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO app_settings (key, value_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value_json = excluded.value_json,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(format!("agentCodeCheckpoints:{conversation_id}"))
        .bind(code_checkpoints_json)
        .bind(now)
        .execute(&mut *transaction)
        .await?;
    }

    if delete_context_compaction_state {
        sqlx::query("DELETE FROM conversation_compactions WHERE conversation_id = ?")
            .bind(conversation_id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query("DELETE FROM conversation_compaction_events WHERE conversation_id = ?")
            .bind(conversation_id)
            .execute(&mut *transaction)
            .await?;
    }

    refresh_conversation_metadata_with_connection(
        &mut *transaction,
        conversation_id.to_string(),
        None,
    )
    .await?;
    transaction.commit().await?;
    Ok(())
}

fn map_message_row(row: &sqlx::sqlite::SqliteRow) -> Message {
    Message {
        id: row.get("id"),
        conversation_id: row.get("conversation_id"),
        turn_id: row.get("turn_id"),
        role: row.get("role"),
        content: row.get("content"),
        created_at: row.get("created_at"),
        token_count: row.get("token_count"),
        tool_traces_json: row.get("tool_traces_json"),
        hidden_context: row.get("hidden_context"),
        provider_input_items_json: row.get("provider_input_items_json"),
        provider_turn_state_json: row.get("provider_turn_state_json"),
        context_refs_json: row.get("context_refs_json"),
        completion_reason: row.get("completion_reason"),
    }
}

fn map_compaction_state_row(row: &sqlx::sqlite::SqliteRow) -> ConversationCompactionStateRecord {
    ConversationCompactionStateRecord {
        conversation_id: row.get("conversation_id"),
        up_to_message_id: row.get("up_to_message_id"),
        summary_text: row.get("summary_text"),
        tool_digest_json: row.get("tool_digest_json"),
        used_source_passage_ids_json: row.get("used_source_passage_ids_json"),
        interesting_source_passage_ids_json: row.get("interesting_source_passage_ids_json"),
        estimated_tokens_before: row.get("estimated_tokens_before"),
        estimated_tokens_after: row.get("estimated_tokens_after"),
        fingerprint: row.get("fingerprint"),
        version: row.get("version"),
        pruned_tool_context_message_ids_json: row.get("pruned_tool_context_message_ids_json"),
        reserved_tokens: row.get("reserved_tokens"),
        footprint_before_json: row.get("footprint_before_json"),
        footprint_after_json: row.get("footprint_after_json"),
        degraded_reason: row.get("degraded_reason"),
        compaction_kind: row.get("compaction_kind"),
        compaction_pass: row.get("compaction_pass"),
        summary_format_version: row.get("summary_format_version"),
        summary_source: row.get("summary_source"),
        policy_version: row.get("policy_version"),
        fingerprint_inputs_json: row.get("fingerprint_inputs_json"),
        source_hashes_json: row.get("source_hashes_json"),
        model_context_window_tokens: row.get("model_context_window_tokens"),
        provider_id: row.get("provider_id"),
        model_id: row.get("model_id"),
        checkpoint_health: row.get("checkpoint_health"),
        last_trigger: row.get("last_trigger"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

async fn restore_compaction_state_with_connection(
    connection: &mut sqlx::SqliteConnection,
    state: &ConversationCompactionStateRecord,
) -> DbResult<()> {
    sqlx::query(r#"INSERT INTO conversation_compactions (conversation_id, up_to_message_id, summary_text, tool_digest_json, used_source_passage_ids_json, interesting_source_passage_ids_json, estimated_tokens_before, estimated_tokens_after, fingerprint, version, pruned_tool_context_message_ids_json, reserved_tokens, footprint_before_json, footprint_after_json, degraded_reason, compaction_kind, compaction_pass, summary_format_version, summary_source, policy_version, fingerprint_inputs_json, source_hashes_json, model_context_window_tokens, provider_id, model_id, checkpoint_health, last_trigger, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET up_to_message_id=excluded.up_to_message_id, summary_text=excluded.summary_text, tool_digest_json=excluded.tool_digest_json, used_source_passage_ids_json=excluded.used_source_passage_ids_json, interesting_source_passage_ids_json=excluded.interesting_source_passage_ids_json, estimated_tokens_before=excluded.estimated_tokens_before, estimated_tokens_after=excluded.estimated_tokens_after, fingerprint=excluded.fingerprint, version=excluded.version, pruned_tool_context_message_ids_json=excluded.pruned_tool_context_message_ids_json, reserved_tokens=excluded.reserved_tokens, footprint_before_json=excluded.footprint_before_json, footprint_after_json=excluded.footprint_after_json, degraded_reason=excluded.degraded_reason, compaction_kind=excluded.compaction_kind, compaction_pass=excluded.compaction_pass, summary_format_version=excluded.summary_format_version, summary_source=excluded.summary_source, policy_version=excluded.policy_version, fingerprint_inputs_json=excluded.fingerprint_inputs_json, source_hashes_json=excluded.source_hashes_json, model_context_window_tokens=excluded.model_context_window_tokens, provider_id=excluded.provider_id, model_id=excluded.model_id, checkpoint_health=excluded.checkpoint_health, last_trigger=excluded.last_trigger, created_at=excluded.created_at, updated_at=excluded.updated_at"#)
    .bind(&state.conversation_id).bind(&state.up_to_message_id).bind(&state.summary_text).bind(&state.tool_digest_json).bind(&state.used_source_passage_ids_json).bind(&state.interesting_source_passage_ids_json).bind(state.estimated_tokens_before).bind(state.estimated_tokens_after).bind(&state.fingerprint).bind(state.version).bind(&state.pruned_tool_context_message_ids_json).bind(state.reserved_tokens).bind(&state.footprint_before_json).bind(&state.footprint_after_json).bind(&state.degraded_reason).bind(&state.compaction_kind).bind(&state.compaction_pass).bind(state.summary_format_version).bind(&state.summary_source).bind(state.policy_version).bind(&state.fingerprint_inputs_json).bind(&state.source_hashes_json).bind(state.model_context_window_tokens).bind(&state.provider_id).bind(&state.model_id).bind(&state.checkpoint_health).bind(&state.last_trigger).bind(&state.created_at).bind(&state.updated_at).execute(connection).await?;
    Ok(())
}

async fn restore_message_with_connection(
    connection: &mut sqlx::SqliteConnection,
    message: &Message,
) -> DbResult<()> {
    sqlx::query(
        r#"INSERT INTO messages (id, conversation_id, turn_id, role, content, created_at, token_count, tool_traces_json, hidden_context, provider_input_items_json, provider_turn_state_json, context_refs_json, completion_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             conversation_id = excluded.conversation_id, turn_id = excluded.turn_id,
             role = excluded.role, content = excluded.content, created_at = excluded.created_at,
             token_count = excluded.token_count, tool_traces_json = excluded.tool_traces_json,
             hidden_context = excluded.hidden_context, provider_input_items_json = excluded.provider_input_items_json,
             provider_turn_state_json = excluded.provider_turn_state_json, context_refs_json = excluded.context_refs_json,
             completion_reason = excluded.completion_reason"#,
    )
    .bind(&message.id).bind(&message.conversation_id).bind(&message.turn_id).bind(&message.role)
    .bind(&message.content).bind(&message.created_at).bind(message.token_count)
    .bind(&message.tool_traces_json).bind(&message.hidden_context).bind(&message.provider_input_items_json)
    .bind(&message.provider_turn_state_json).bind(&message.context_refs_json).bind(&message.completion_reason)
    .execute(connection).await?;
    Ok(())
}

async fn restore_citation_with_connection(
    connection: &mut sqlx::SqliteConnection,
    citation: &ConversationCitation,
) -> DbResult<()> {
    sqlx::query(
        r#"INSERT INTO conversation_citations (id, conversation_id, message_id, type, scope, source, title, snippet, content, url, favicon, path, language, size_bytes, kind, reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             conversation_id=excluded.conversation_id, message_id=excluded.message_id, type=excluded.type,
             scope=excluded.scope, source=excluded.source, title=excluded.title, snippet=excluded.snippet,
             content=excluded.content, url=excluded.url, favicon=excluded.favicon, path=excluded.path,
             language=excluded.language, size_bytes=excluded.size_bytes, kind=excluded.kind, reason=excluded.reason,
             created_at=excluded.created_at, updated_at=excluded.updated_at"#,
    )
    .bind(&citation.id).bind(&citation.conversation_id).bind(&citation.message_id).bind(&citation.r#type)
    .bind(&citation.scope).bind(&citation.source).bind(&citation.title).bind(&citation.snippet)
    .bind(&citation.content).bind(&citation.url).bind(&citation.favicon).bind(&citation.path)
    .bind(&citation.language).bind(citation.size_bytes).bind(&citation.kind).bind(&citation.reason)
    .bind(&citation.created_at).bind(&citation.updated_at).execute(connection).await?;
    Ok(())
}

pub async fn prepare_conversation_replay(
    pool: &SqlitePool,
    input: PrepareConversationReplayInput<'_>,
) -> DbResult<()> {
    let mut transaction = pool.begin().await?;
    let row = sqlx::query(
        "SELECT id, conversation_id, turn_id, role, content, created_at, token_count, tool_traces_json, hidden_context, provider_input_items_json, provider_turn_state_json, context_refs_json, completion_reason FROM messages WHERE id = ? AND conversation_id = ?",
    ).bind(input.message_id).bind(input.conversation_id).fetch_one(&mut *transaction).await?;
    let original_message = map_message_row(&row);
    let tail_rows = sqlx::query(
        "SELECT id, conversation_id, turn_id, role, content, created_at, token_count, tool_traces_json, hidden_context, provider_input_items_json, provider_turn_state_json, context_refs_json, completion_reason FROM messages WHERE conversation_id = ? AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at ASC, id ASC",
    ).bind(input.conversation_id).bind(&original_message.created_at).bind(&original_message.created_at).bind(input.message_id).fetch_all(&mut *transaction).await?;
    let citations = sqlx::query(
        "SELECT id, conversation_id, message_id, type, scope, source, title, snippet, content, url, favicon, path, language, size_bytes, kind, reason, created_at, updated_at FROM conversation_citations WHERE conversation_id = ?",
    ).bind(input.conversation_id).fetch_all(&mut *transaction).await?
      .into_iter().map(map_conversation_citation_row).collect();
    let checkpoints_json: Option<String> =
        sqlx::query_scalar("SELECT value_json FROM app_settings WHERE key = ?")
            .bind(format!("agentCodeCheckpoints:{}", input.conversation_id))
            .fetch_optional(&mut *transaction)
            .await?;
    let compaction_events = sqlx::query(
        "SELECT id, conversation_id, trigger, provider_id, model_id, model_context_window_tokens, tokens_before, tokens_after, status, error_code, reason, metadata_json, created_at FROM conversation_compaction_events WHERE conversation_id = ?",
    ).bind(input.conversation_id).fetch_all(&mut *transaction).await?.into_iter().map(|row| ReplayCompactionEvent {
        id: row.get("id"), conversation_id: row.get("conversation_id"), trigger: row.get("trigger"), provider_id: row.get("provider_id"), model_id: row.get("model_id"), model_context_window_tokens: row.get("model_context_window_tokens"), tokens_before: row.get("tokens_before"), tokens_after: row.get("tokens_after"), status: row.get("status"), error_code: row.get("error_code"), reason: row.get("reason"), metadata_json: row.get("metadata_json"), created_at: row.get("created_at"),
    }).collect();
    let compaction_state = sqlx::query("SELECT conversation_id, up_to_message_id, summary_text, tool_digest_json, used_source_passage_ids_json, interesting_source_passage_ids_json, estimated_tokens_before, estimated_tokens_after, fingerprint, version, pruned_tool_context_message_ids_json, reserved_tokens, footprint_before_json, footprint_after_json, degraded_reason, compaction_kind, compaction_pass, summary_format_version, summary_source, policy_version, fingerprint_inputs_json, source_hashes_json, model_context_window_tokens, provider_id, model_id, checkpoint_health, last_trigger, created_at, updated_at FROM conversation_compactions WHERE conversation_id = ?").bind(input.conversation_id).fetch_optional(&mut *transaction).await?.as_ref().map(map_compaction_state_row);
    let tail_messages = tail_rows.iter().map(map_message_row).collect::<Vec<_>>();
    let snapshot = ReplayRecoverySnapshot {
        replay_id: input.replay_id.to_string(),
        conversation_id: input.conversation_id.to_string(),
        message_id: input.message_id.to_string(),
        session_id: input.session_id.to_string(),
        turn_id: input.turn_id.to_string(),
        transcript_revision: replay_transcript_revision(&original_message, &tail_messages),
        prepared_message_content: input.content.to_string(),
        phase: "prepared".to_string(),
        original_message,
        tail_messages,
        citations,
        checkpoints_json,
        compaction_state,
        compaction_events,
    };
    let snapshot_json =
        serde_json::to_string(&snapshot).map_err(|error| DbError::Validation(error.to_string()))?;
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at")
      .bind(replay_recovery_key(input.conversation_id)).bind(snapshot_json).bind(&now).execute(&mut *transaction).await?;
    sqlx::query("UPDATE messages SET content = ?, turn_id = ?, hidden_context = ?, provider_input_items_json = ? WHERE id = ? AND conversation_id = ?")
      .bind(input.content).bind(input.turn_id).bind(&input.hidden_context).bind(&input.provider_input_items_json).bind(input.message_id).bind(input.conversation_id).execute(&mut *transaction).await?;
    sqlx::query("DELETE FROM conversation_citations WHERE conversation_id = ? AND message_id IN (SELECT id FROM messages WHERE conversation_id = ? AND (created_at > ? OR (created_at = ? AND id > ?)))")
      .bind(input.conversation_id).bind(input.conversation_id).bind(&snapshot.original_message.created_at).bind(&snapshot.original_message.created_at).bind(input.message_id).execute(&mut *transaction).await?;
    sqlx::query("DELETE FROM messages WHERE conversation_id = ? AND (created_at > ? OR (created_at = ? AND id > ?))")
      .bind(input.conversation_id).bind(&snapshot.original_message.created_at).bind(&snapshot.original_message.created_at).bind(input.message_id).execute(&mut *transaction).await?;
    if let Some(checkpoints_json) = input.code_checkpoints_json {
        sqlx::query("INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at")
        .bind(format!("agentCodeCheckpoints:{}", input.conversation_id)).bind(checkpoints_json).bind(&now).execute(&mut *transaction).await?;
    }
    if input.delete_context_compaction_state {
        sqlx::query("DELETE FROM conversation_compactions WHERE conversation_id = ?")
            .bind(input.conversation_id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query("DELETE FROM conversation_compaction_events WHERE conversation_id = ?")
            .bind(input.conversation_id)
            .execute(&mut *transaction)
            .await?;
    }
    refresh_conversation_metadata_with_connection(
        &mut *transaction,
        input.conversation_id.to_string(),
        None,
    )
    .await?;
    transaction.commit().await?;
    Ok(())
}

pub async fn restore_conversation_replay(
    pool: &SqlitePool,
    conversation_id: &str,
    replay_id: &str,
    session_id: Option<&str>,
    turn_id: Option<&str>,
) -> DbResult<bool> {
    let mut transaction = pool.begin().await?;
    let key = replay_recovery_key(conversation_id);
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value_json FROM app_settings WHERE key = ?")
            .bind(&key)
            .fetch_optional(&mut *transaction)
            .await?;
    let Some(raw) = raw else {
        transaction.commit().await?;
        return Ok(false);
    };
    let snapshot: ReplayRecoverySnapshot =
        serde_json::from_str(&raw).map_err(|error| DbError::Validation(error.to_string()))?;
    if snapshot.replay_id != replay_id
        || snapshot.conversation_id != conversation_id
        || session_id.is_some_and(|session_id| snapshot.session_id != session_id)
        || turn_id.is_some_and(|turn_id| snapshot.turn_id != turn_id)
    {
        transaction.commit().await?;
        return Ok(false);
    }
    if snapshot.transcript_revision
        != replay_transcript_revision(&snapshot.original_message, &snapshot.tail_messages)
    {
        return Err(DbError::Validation(
            "Replay recovery transcript revision is invalid".to_string(),
        ));
    }

    // A recovery can only undo its own trim. A later turn, an edited anchor,
    // or streamed content on the launched turn is a definitive fence: preserve
    // the marker and let the winning transcript remain authoritative.
    let current_anchor =
        sqlx::query("SELECT turn_id, content FROM messages WHERE id = ? AND conversation_id = ?")
            .bind(&snapshot.message_id)
            .bind(conversation_id)
            .fetch_optional(&mut *transaction)
            .await?;
    let Some(current_anchor) = current_anchor else {
        transaction.commit().await?;
        return Ok(false);
    };
    let anchor_turn_id: String = current_anchor.get("turn_id");
    let anchor_content: String = current_anchor.get("content");
    if anchor_turn_id != snapshot.turn_id || anchor_content != snapshot.prepared_message_content {
        transaction.commit().await?;
        return Ok(false);
    }
    let later_rows = sqlx::query("SELECT turn_id, content, tool_traces_json FROM messages WHERE conversation_id = ? AND (created_at > ? OR (created_at = ? AND id > ?))")
        .bind(conversation_id)
        .bind(&snapshot.original_message.created_at)
        .bind(&snapshot.original_message.created_at)
        .bind(&snapshot.message_id)
        .fetch_all(&mut *transaction)
        .await?;
    let has_competing_turn = later_rows.iter().any(|row| {
        let row_turn_id: String = row.get("turn_id");
        row_turn_id != snapshot.turn_id
    });
    let launched_has_progress = snapshot.phase == "launched"
        && later_rows.iter().any(|row| {
            let content: String = row.get("content");
            let tool_traces_json: Option<String> = row.get("tool_traces_json");
            !content.is_empty()
                || tool_traces_json.is_some_and(|traces| traces != "[]" && !traces.is_empty())
        });
    if has_competing_turn || launched_has_progress {
        transaction.commit().await?;
        return Ok(false);
    }
    sqlx::query("DELETE FROM conversation_citations WHERE conversation_id = ?")
        .bind(conversation_id)
        .execute(&mut *transaction)
        .await?;
    sqlx::query("DELETE FROM messages WHERE conversation_id = ? AND (created_at > ? OR (created_at = ? AND id > ?))").bind(conversation_id).bind(&snapshot.original_message.created_at).bind(&snapshot.original_message.created_at).bind(&snapshot.message_id).execute(&mut *transaction).await?;
    restore_message_with_connection(&mut *transaction, &snapshot.original_message).await?;
    for message in &snapshot.tail_messages {
        restore_message_with_connection(&mut *transaction, message).await?;
    }
    for citation in &snapshot.citations {
        restore_citation_with_connection(&mut *transaction, citation).await?;
    }
    let checkpoint_key = format!("agentCodeCheckpoints:{conversation_id}");
    match snapshot.checkpoints_json {
        Some(value) => {
            sqlx::query("INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at").bind(&checkpoint_key).bind(value).bind(chrono::Utc::now().to_rfc3339()).execute(&mut *transaction).await?;
        }
        None => {
            sqlx::query("DELETE FROM app_settings WHERE key = ?")
                .bind(&checkpoint_key)
                .execute(&mut *transaction)
                .await?;
        }
    }
    sqlx::query("DELETE FROM conversation_compactions WHERE conversation_id = ?")
        .bind(conversation_id)
        .execute(&mut *transaction)
        .await?;
    sqlx::query("DELETE FROM conversation_compaction_events WHERE conversation_id = ?")
        .bind(conversation_id)
        .execute(&mut *transaction)
        .await?;
    if let Some(state) = &snapshot.compaction_state {
        restore_compaction_state_with_connection(&mut *transaction, state).await?;
    }
    for event in &snapshot.compaction_events {
        sqlx::query("INSERT INTO conversation_compaction_events (id, conversation_id, trigger, provider_id, model_id, model_context_window_tokens, tokens_before, tokens_after, status, error_code, reason, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(&event.id).bind(&event.conversation_id).bind(&event.trigger).bind(&event.provider_id).bind(&event.model_id).bind(event.model_context_window_tokens).bind(event.tokens_before).bind(event.tokens_after).bind(&event.status).bind(&event.error_code).bind(&event.reason).bind(&event.metadata_json).bind(&event.created_at).execute(&mut *transaction).await?;
    }
    refresh_conversation_metadata_with_connection(
        &mut *transaction,
        conversation_id.to_string(),
        None,
    )
    .await?;
    sqlx::query("DELETE FROM app_settings WHERE key = ?")
        .bind(&key)
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await?;
    Ok(true)
}

pub async fn complete_conversation_replay(
    pool: &SqlitePool,
    conversation_id: &str,
    replay_id: &str,
) -> DbResult<()> {
    let key = replay_recovery_key(conversation_id);
    let Some(setting) = get_app_setting(pool, &key).await? else {
        return Ok(());
    };
    let mut snapshot: ReplayRecoverySnapshot = serde_json::from_str(&setting.value_json)
        .map_err(|error| DbError::Validation(error.to_string()))?;
    if snapshot.replay_id == replay_id && snapshot.phase == "prepared" {
        snapshot.phase = "launch_ready".to_string();
        set_app_setting(
            pool,
            &key,
            &serde_json::to_string(&snapshot)
                .map_err(|error| DbError::Validation(error.to_string()))?,
        )
        .await?;
    }
    Ok(())
}

pub async fn mark_conversation_replay_launched(
    pool: &SqlitePool,
    conversation_id: &str,
    replay_id: &str,
) -> DbResult<()> {
    let key = replay_recovery_key(conversation_id);
    let Some(setting) = get_app_setting(pool, &key).await? else {
        return Err(DbError::Validation(
            "Replay recovery marker is missing".to_string(),
        ));
    };
    let mut snapshot: ReplayRecoverySnapshot = serde_json::from_str(&setting.value_json)
        .map_err(|error| DbError::Validation(error.to_string()))?;
    if snapshot.replay_id != replay_id || snapshot.phase != "launch_ready" {
        return Err(DbError::Validation(
            "Replay recovery marker is no longer launch-ready".to_string(),
        ));
    }
    snapshot.phase = "launched".to_string();
    set_app_setting(
        pool,
        &key,
        &serde_json::to_string(&snapshot)
            .map_err(|error| DbError::Validation(error.to_string()))?,
    )
    .await?;
    Ok(())
}

pub async fn finalize_conversation_replay(
    pool: &SqlitePool,
    conversation_id: &str,
    replay_id: &str,
) -> DbResult<()> {
    let key = replay_recovery_key(conversation_id);
    let Some(setting) = get_app_setting(pool, &key).await? else {
        return Ok(());
    };
    let snapshot: ReplayRecoverySnapshot = serde_json::from_str(&setting.value_json)
        .map_err(|error| DbError::Validation(error.to_string()))?;
    if snapshot.replay_id == replay_id && snapshot.phase == "launched" {
        sqlx::query("DELETE FROM app_settings WHERE key = ?")
            .bind(key)
            .execute(pool)
            .await?;
    }
    Ok(())
}

// ============ CONVERSATION CITATIONS ============

fn map_conversation_citation_row(row: sqlx::sqlite::SqliteRow) -> ConversationCitation {
    ConversationCitation {
        id: row.get("id"),
        conversation_id: row.get("conversation_id"),
        message_id: row.get("message_id"),
        r#type: row.get("type"),
        scope: row.get("scope"),
        source: row.get("source"),
        title: row.get("title"),
        snippet: row.get("snippet"),
        content: row.get("content"),
        url: row.get("url"),
        favicon: row.get("favicon"),
        path: row.get("path"),
        language: row.get("language"),
        size_bytes: row.get("size_bytes"),
        kind: row.get("kind"),
        reason: row.get("reason"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn require_non_empty(value: &str, field: &str) -> DbResult<()> {
    if value.trim().is_empty() {
        return Err(DbError::Validation(format!("{} is required", field)));
    }
    Ok(())
}

pub async fn list_conversation_citations(
    pool: &SqlitePool,
    conversation_id: &str,
) -> DbResult<Vec<ConversationCitation>> {
    let rows = sqlx::query(
        r#"
        SELECT id, conversation_id, message_id, type, scope, source, title,
               snippet, NULL AS content, url, favicon, path, language, size_bytes,
               kind, reason, created_at, updated_at
        FROM conversation_citations
        WHERE conversation_id = ?
        ORDER BY updated_at DESC, id ASC
        "#,
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(map_conversation_citation_row)
        .collect())
}

pub async fn get_conversation_citation_content(
    pool: &SqlitePool,
    id: &str,
) -> DbResult<Option<String>> {
    let row = sqlx::query(
        r#"
        SELECT content
        FROM conversation_citations
        WHERE id = ?
        "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;

    Ok(row.and_then(|row| row.get("content")))
}

pub async fn upsert_conversation_citation(
    pool: &SqlitePool,
    input: UpsertConversationCitationInput,
) -> DbResult<ConversationCitation> {
    require_non_empty(&input.id, "id")?;
    require_non_empty(&input.conversation_id, "conversation_id")?;
    require_non_empty(&input.message_id, "message_id")?;
    require_non_empty(&input.r#type, "type")?;
    require_non_empty(&input.scope, "scope")?;
    require_non_empty(&input.source, "source")?;
    require_non_empty(&input.title, "title")?;

    let now = input
        .timestamp
        .clone()
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

    sqlx::query(
        r#"
        INSERT INTO conversation_citations (
            id, conversation_id, message_id, type, scope, source, title,
            snippet, content, url, favicon, path, language, size_bytes,
            kind, reason, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            conversation_id = excluded.conversation_id,
            message_id = excluded.message_id,
            type = excluded.type,
            scope = excluded.scope,
            source = excluded.source,
            title = excluded.title,
            snippet = excluded.snippet,
            content = COALESCE(excluded.content, conversation_citations.content),
            url = excluded.url,
            favicon = excluded.favicon,
            path = excluded.path,
            language = excluded.language,
            size_bytes = excluded.size_bytes,
            kind = excluded.kind,
            reason = excluded.reason,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(&input.id)
    .bind(&input.conversation_id)
    .bind(&input.message_id)
    .bind(&input.r#type)
    .bind(&input.scope)
    .bind(&input.source)
    .bind(&input.title)
    .bind(&input.snippet)
    .bind(&input.content)
    .bind(&input.url)
    .bind(&input.favicon)
    .bind(&input.path)
    .bind(&input.language)
    .bind(input.size_bytes)
    .bind(&input.kind)
    .bind(&input.reason)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;

    let row = sqlx::query(
        r#"
        SELECT id, conversation_id, message_id, type, scope, source, title,
               snippet, content, url, favicon, path, language, size_bytes,
               kind, reason, created_at, updated_at
        FROM conversation_citations
        WHERE id = ?
        "#,
    )
    .bind(&input.id)
    .fetch_one(pool)
    .await?;

    Ok(map_conversation_citation_row(row))
}

pub async fn delete_conversation_citation(pool: &SqlitePool, id: &str) -> DbResult<()> {
    sqlx::query("DELETE FROM conversation_citations WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;

    Ok(())
}

pub async fn delete_conversation_citations(
    pool: &SqlitePool,
    conversation_id: &str,
) -> DbResult<()> {
    sqlx::query("DELETE FROM conversation_citations WHERE conversation_id = ?")
        .bind(conversation_id)
        .execute(pool)
        .await?;

    Ok(())
}

// ============ CONVERSATION TOOLBOX STATE ============

fn map_conversation_toolbox_state_row(
    row: sqlx::sqlite::SqliteRow,
) -> ConversationToolboxStateRecord {
    ConversationToolboxStateRecord {
        conversation_id: row.get("conversation_id"),
        composer_context_refs_json: row.get("composer_context_refs_json"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

pub async fn get_conversation_toolbox_state(
    pool: &SqlitePool,
    conversation_id: &str,
) -> DbResult<Option<ConversationToolboxStateRecord>> {
    let row = sqlx::query(
        r#"
        SELECT conversation_id, composer_context_refs_json, created_at, updated_at
        FROM conversation_toolbox_state
        WHERE conversation_id = ?
        "#,
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(map_conversation_toolbox_state_row))
}

pub async fn upsert_conversation_toolbox_state(
    pool: &SqlitePool,
    input: UpsertConversationToolboxStateInput,
) -> DbResult<ConversationToolboxStateRecord> {
    require_non_empty(&input.conversation_id, "conversation_id")?;
    require_non_empty(
        &input.composer_context_refs_json,
        "composer_context_refs_json",
    )?;

    let now = input
        .timestamp
        .clone()
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

    sqlx::query(
        r#"
        INSERT INTO conversation_toolbox_state (
            conversation_id, composer_context_refs_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
            composer_context_refs_json = excluded.composer_context_refs_json,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(&input.conversation_id)
    .bind(&input.composer_context_refs_json)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;

    let row = sqlx::query(
        r#"
        SELECT conversation_id, composer_context_refs_json, created_at, updated_at
        FROM conversation_toolbox_state
        WHERE conversation_id = ?
        "#,
    )
    .bind(&input.conversation_id)
    .fetch_one(pool)
    .await?;

    Ok(map_conversation_toolbox_state_row(row))
}

pub async fn delete_conversation_toolbox_state(
    pool: &SqlitePool,
    conversation_id: &str,
) -> DbResult<()> {
    sqlx::query("DELETE FROM conversation_toolbox_state WHERE conversation_id = ?")
        .bind(conversation_id)
        .execute(pool)
        .await?;

    Ok(())
}

// ============ ARCHITECT PLAN CONVERSATION SYNC ============

pub async fn get_architect_plan_conversation_sync(
    pool: &SqlitePool,
    conversation_id: &str,
) -> DbResult<Option<ArchitectPlanConversationSyncRecord>> {
    let row = sqlx::query(
        r#"
        SELECT conversation_id, plan_id, target_branch, transcript_revision, message_count, updated_at
        FROM architect_plan_conversation_sync
        WHERE conversation_id = ?
        "#,
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|row| ArchitectPlanConversationSyncRecord {
        conversation_id: row.get("conversation_id"),
        plan_id: row.get("plan_id"),
        target_branch: row.get("target_branch"),
        transcript_revision: row.get("transcript_revision"),
        message_count: row.get("message_count"),
        updated_at: row.get("updated_at"),
    }))
}

pub async fn get_architect_plan_conversation_sync_for_plan(
    pool: &SqlitePool,
    plan_id: &str,
    target_branch: &str,
) -> DbResult<Option<ArchitectPlanConversationSyncRecord>> {
    let row = sqlx::query(
        r#"
        SELECT conversation_id, plan_id, target_branch, transcript_revision, message_count, updated_at
        FROM architect_plan_conversation_sync
        WHERE plan_id = ? AND target_branch = ?
        ORDER BY updated_at DESC, conversation_id ASC
        LIMIT 1
        "#,
    )
    .bind(plan_id)
    .bind(target_branch)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|row| ArchitectPlanConversationSyncRecord {
        conversation_id: row.get("conversation_id"),
        plan_id: row.get("plan_id"),
        target_branch: row.get("target_branch"),
        transcript_revision: row.get("transcript_revision"),
        message_count: row.get("message_count"),
        updated_at: row.get("updated_at"),
    }))
}

pub async fn upsert_architect_plan_conversation_sync(
    pool: &SqlitePool,
    input: UpsertArchitectPlanConversationSyncInput,
) -> DbResult<ArchitectPlanConversationSyncRecord> {
    let updated_at = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        r#"
        INSERT INTO architect_plan_conversation_sync (
            conversation_id, plan_id, target_branch, transcript_revision, message_count, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
            plan_id = excluded.plan_id,
            target_branch = excluded.target_branch,
            transcript_revision = excluded.transcript_revision,
            message_count = excluded.message_count,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(&input.conversation_id)
    .bind(&input.plan_id)
    .bind(&input.target_branch)
    .bind(&input.transcript_revision)
    .bind(input.message_count)
    .bind(&updated_at)
    .execute(pool)
    .await?;

    Ok(ArchitectPlanConversationSyncRecord {
        conversation_id: input.conversation_id,
        plan_id: input.plan_id,
        target_branch: input.target_branch,
        transcript_revision: input.transcript_revision,
        message_count: input.message_count,
        updated_at,
    })
}

pub async fn delete_architect_plan_conversation_sync(
    pool: &SqlitePool,
    conversation_id: &str,
) -> DbResult<()> {
    sqlx::query("DELETE FROM architect_plan_conversation_sync WHERE conversation_id = ?")
        .bind(conversation_id)
        .execute(pool)
        .await?;

    Ok(())
}

// ============ PROVIDER CONFIGS ============

pub async fn list_provider_configs(pool: &SqlitePool) -> DbResult<Vec<ProviderConfig>> {
    let rows = sqlx::query(
        r#"
        SELECT id, name, provider_type, base_url, has_stored_api_key, is_enabled, is_local,
               auth_status, auth_source, plan_type, account_label, token_expires_at,
               created_at, updated_at
        FROM provider_configs
        ORDER BY is_local ASC, name ASC
        "#,
    )
    .fetch_all(pool)
    .await?;

    let configs = rows
        .into_iter()
        .map(|row| ProviderConfig {
            id: row.get("id"),
            name: row.get("name"),
            provider_type: row.get("provider_type"),
            base_url: row.get("base_url"),
            api_key: None,
            has_stored_api_key: row.get::<i32, _>("has_stored_api_key") != 0,
            is_enabled: row.get::<i32, _>("is_enabled") != 0,
            is_local: row.get::<i32, _>("is_local") != 0,
            auth_status: row.get("auth_status"),
            auth_source: row.get("auth_source"),
            plan_type: row.get("plan_type"),
            account_label: row.get("account_label"),
            token_expires_at: row.get("token_expires_at"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
        })
        .collect();

    Ok(configs)
}

pub async fn get_provider_config(pool: &SqlitePool, id: &str) -> DbResult<Option<ProviderConfig>> {
    let row = sqlx::query(
        r#"
        SELECT id, name, provider_type, base_url, has_stored_api_key, is_enabled, is_local,
               auth_status, auth_source, plan_type, account_label, token_expires_at,
               created_at, updated_at
        FROM provider_configs
        WHERE id = ?
        "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|row| ProviderConfig {
        id: row.get("id"),
        name: row.get("name"),
        provider_type: row.get("provider_type"),
        base_url: row.get("base_url"),
        api_key: None,
        has_stored_api_key: row.get::<i32, _>("has_stored_api_key") != 0,
        is_enabled: row.get::<i32, _>("is_enabled") != 0,
        is_local: row.get::<i32, _>("is_local") != 0,
        auth_status: row.get("auth_status"),
        auth_source: row.get("auth_source"),
        plan_type: row.get("plan_type"),
        account_label: row.get("account_label"),
        token_expires_at: row.get("token_expires_at"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }))
}

pub async fn update_provider_config(
    pool: &SqlitePool,
    input: UpdateProviderConfigInput,
) -> DbResult<()> {
    let now = chrono::Utc::now().to_rfc3339();

    // Build dynamic update query
    let mut updates = vec!["updated_at = ?".to_string()];
    let mut has_name = false;
    let mut has_provider_type = false;
    let mut has_base_url = false;
    let mut has_is_local = false;
    let mut has_enabled = false;

    if input.name.is_some() {
        updates.push("name = ?".to_string());
        has_name = true;
    }
    if input.provider_type.is_some() {
        updates.push("provider_type = ?".to_string());
        has_provider_type = true;
    }
    if input.base_url.is_some() {
        updates.push("base_url = ?".to_string());
        has_base_url = true;
    }
    if input.is_local.is_some() {
        updates.push("is_local = ?".to_string());
        has_is_local = true;
    }
    if input.is_enabled.is_some() {
        updates.push("is_enabled = ?".to_string());
        has_enabled = true;
    }

    let query = format!(
        "UPDATE provider_configs SET {} WHERE id = ?",
        updates.join(", ")
    );

    let mut q = sqlx::query(&query).bind(&now);

    if has_name {
        q = q.bind(input.name.unwrap());
    }
    if has_provider_type {
        q = q.bind(input.provider_type.unwrap());
    }
    if has_base_url {
        q = q.bind(input.base_url.unwrap());
    }
    if has_is_local {
        q = q.bind(input.is_local.unwrap() as i32);
    }
    if has_enabled {
        q = q.bind(input.is_enabled.unwrap() as i32);
    }

    q.bind(&input.id).execute(pool).await?;

    Ok(())
}

pub async fn create_provider_config(
    pool: &SqlitePool,
    name: &str,
    provider_type: &str,
    base_url: &str,
    api_key: Option<&str>,
    is_local: bool,
    is_enabled: bool,
) -> DbResult<ProviderConfig> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let has_stored_api_key = api_key.is_some_and(|value| !value.trim().is_empty());

    sqlx::query(
        r#"
        INSERT INTO provider_configs (id, name, provider_type, base_url, api_key, has_stored_api_key, is_enabled, is_local, created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&id)
    .bind(name)
    .bind(provider_type)
    .bind(base_url)
    .bind(has_stored_api_key as i32)
    .bind(is_enabled as i32)
    .bind(is_local as i32)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(ProviderConfig {
        id,
        name: name.to_string(),
        provider_type: provider_type.to_string(),
        base_url: base_url.to_string(),
        api_key: None,
        has_stored_api_key,
        is_enabled,
        is_local,
        auth_status: None,
        auth_source: None,
        plan_type: None,
        account_label: None,
        token_expires_at: None,
        created_at: now.clone(),
        updated_at: now,
    })
}

pub async fn upsert_provider_config_by_id(
    pool: &SqlitePool,
    id: &str,
    name: &str,
    provider_type: &str,
    base_url: &str,
    is_local: bool,
) -> DbResult<()> {
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        r#"
        INSERT INTO provider_configs (
            id, name, provider_type, base_url, api_key, has_stored_api_key, is_enabled, is_local, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, NULL, 0, 1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            provider_type = excluded.provider_type,
            base_url = excluded.base_url,
            is_local = excluded.is_local,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(id)
    .bind(name)
    .bind(provider_type)
    .bind(base_url)
    .bind(is_local as i32)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn set_provider_has_stored_api_key(
    pool: &SqlitePool,
    provider_id: &str,
    has_stored_api_key: bool,
) -> DbResult<()> {
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        r#"
        UPDATE provider_configs
        SET has_stored_api_key = ?, updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(has_stored_api_key as i32)
    .bind(&now)
    .bind(provider_id)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn update_provider_auth_metadata(
    pool: &SqlitePool,
    provider_id: &str,
    metadata: &ProviderAuthMetadata,
) -> DbResult<()> {
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        r#"
        UPDATE provider_configs
        SET auth_status = ?,
            auth_source = ?,
            plan_type = ?,
            account_label = ?,
            token_expires_at = ?,
            updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(&metadata.auth_status)
    .bind(&metadata.auth_source)
    .bind(&metadata.plan_type)
    .bind(&metadata.account_label)
    .bind(&metadata.token_expires_at)
    .bind(&now)
    .bind(provider_id)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn delete_provider_config(pool: &SqlitePool, id: &str) -> DbResult<()> {
    let mut transaction = pool.begin().await?;
    sqlx::query("DELETE FROM ai_models WHERE provider_id = ?")
        .bind(id)
        .execute(&mut *transaction)
        .await?;

    sqlx::query("DELETE FROM provider_settings WHERE provider_id = ?")
        .bind(id)
        .execute(&mut *transaction)
        .await?;

    sqlx::query("DELETE FROM provider_configs WHERE id = ?")
        .bind(id)
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await?;
    Ok(())
}

// ============ AI MODELS ============

pub async fn list_models_by_provider(
    pool: &SqlitePool,
    provider_id: &str,
) -> DbResult<Vec<AiModel>> {
    let rows = sqlx::query(
        r#"
        SELECT id, provider_id, model_id, name, description, owned_by,
               pricing_prompt, pricing_completion, pricing_request,
               reasoning_efforts_json, default_reasoning_effort, context_window_tokens,
               input_limit_tokens, output_limit_tokens, context_window_source,
               context_limits_updated_at, is_enabled, is_manual, first_seen_at, last_seen_at
        FROM ai_models
        WHERE provider_id = ?
        ORDER BY name ASC
        "#,
    )
    .bind(provider_id)
    .fetch_all(pool)
    .await?;

    let models = rows
        .into_iter()
        .map(|row| AiModel {
            id: row.get("id"),
            provider_id: row.get("provider_id"),
            model_id: row.get("model_id"),
            name: row.get("name"),
            description: row.get("description"),
            owned_by: row.get("owned_by"),
            pricing_prompt: row.get("pricing_prompt"),
            pricing_completion: row.get("pricing_completion"),
            pricing_request: row.get("pricing_request"),
            reasoning_efforts: parse_reasoning_efforts(row.get("reasoning_efforts_json")),
            default_reasoning_effort: row.get("default_reasoning_effort"),
            context_window_tokens: row.get("context_window_tokens"),
            input_limit_tokens: row
                .try_get::<Option<i32>, _>("input_limit_tokens")
                .ok()
                .flatten(),
            output_limit_tokens: row
                .try_get::<Option<i32>, _>("output_limit_tokens")
                .ok()
                .flatten(),
            context_window_source: row
                .try_get::<Option<String>, _>("context_window_source")
                .ok()
                .flatten(),
            context_limits_updated_at: row
                .try_get::<Option<String>, _>("context_limits_updated_at")
                .ok()
                .flatten(),
            is_enabled: row.get::<i32, _>("is_enabled") != 0,
            is_manual: row.get::<i32, _>("is_manual") != 0,
            first_seen_at: row.get("first_seen_at"),
            last_seen_at: row.get("last_seen_at"),
        })
        .collect();

    Ok(models)
}

pub async fn upsert_provider_models(
    pool: &SqlitePool,
    provider_id: &str,
    models: &[ProviderModelInput],
) -> DbResult<()> {
    let now = chrono::Utc::now().to_rfc3339();

    let mut tx = pool.begin().await?;

    for model in models {
        let id = format!("{}::{}", provider_id, model.model_id);
        sqlx::query(
            r#"
            INSERT INTO ai_models (
                id, provider_id, model_id, name, description, owned_by,
                pricing_prompt, pricing_completion, pricing_request,
                reasoning_efforts_json, default_reasoning_effort, context_window_tokens,
                input_limit_tokens, output_limit_tokens, context_window_source,
                context_limits_updated_at, is_enabled, is_manual, first_seen_at, last_seen_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                description = excluded.description,
                owned_by = excluded.owned_by,
                pricing_prompt = excluded.pricing_prompt,
                pricing_completion = excluded.pricing_completion,
                pricing_request = excluded.pricing_request,
                reasoning_efforts_json = excluded.reasoning_efforts_json,
                default_reasoning_effort = excluded.default_reasoning_effort,
                context_window_tokens = excluded.context_window_tokens,
                input_limit_tokens = excluded.input_limit_tokens,
                output_limit_tokens = excluded.output_limit_tokens,
                context_window_source = excluded.context_window_source,
                context_limits_updated_at = excluded.context_limits_updated_at,
                last_seen_at = excluded.last_seen_at
            "#,
        )
        .bind(&id)
        .bind(provider_id)
        .bind(&model.model_id)
        .bind(&model.name)
        .bind(&model.description)
        .bind(&model.owned_by)
        .bind(&model.pricing_prompt)
        .bind(&model.pricing_completion)
        .bind(&model.pricing_request)
        .bind(serialize_reasoning_efforts(
            model.reasoning_efforts.as_ref(),
        ))
        .bind(&model.default_reasoning_effort)
        .bind(model.context_window_tokens)
        .bind(model.input_limit_tokens)
        .bind(model.output_limit_tokens)
        .bind(&model.context_window_source)
        .bind(&model.context_limits_updated_at)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    Ok(())
}

pub async fn prune_provider_models(
    pool: &SqlitePool,
    provider_id: &str,
    keep_model_ids: &[String],
) -> DbResult<()> {
    if keep_model_ids.is_empty() {
        return Ok(());
    }

    let placeholders = vec!["?"; keep_model_ids.len()].join(", ");
    let query = format!(
        "DELETE FROM ai_models WHERE provider_id = ? AND is_manual = 0 AND model_id NOT IN ({})",
        placeholders
    );

    let mut statement = sqlx::query(&query).bind(provider_id);
    for model_id in keep_model_ids {
        statement = statement.bind(model_id);
    }

    statement.execute(pool).await?;
    Ok(())
}

pub async fn register_manual_model(
    pool: &SqlitePool,
    provider_id: &str,
    model_id: &str,
    name: &str,
) -> DbResult<()> {
    let now = chrono::Utc::now().to_rfc3339();
    let id = format!("{}::{}", provider_id, model_id);

    sqlx::query(
        r#"
        INSERT INTO ai_models (
            id, provider_id, model_id, name, description, owned_by,
            pricing_prompt, pricing_completion, pricing_request,
            reasoning_efforts_json, default_reasoning_effort, context_window_tokens,
            is_enabled, is_manual, first_seen_at, last_seen_at
        )
        VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            is_manual = 1,
            last_seen_at = excluded.last_seen_at
        "#,
    )
    .bind(&id)
    .bind(provider_id)
    .bind(model_id)
    .bind(name)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn get_conversation_compaction_state(
    pool: &SqlitePool,
    conversation_id: &str,
) -> DbResult<Option<ConversationCompactionStateRecord>> {
    let row = sqlx::query(
        r#"
        SELECT conversation_id, up_to_message_id, summary_text, tool_digest_json,
               used_source_passage_ids_json, interesting_source_passage_ids_json,
               estimated_tokens_before, estimated_tokens_after, fingerprint,
               version, pruned_tool_context_message_ids_json, reserved_tokens,
               footprint_before_json, footprint_after_json, degraded_reason,
               compaction_kind, compaction_pass, summary_format_version,
               summary_source, policy_version, fingerprint_inputs_json,
               source_hashes_json, model_context_window_tokens, provider_id,
               model_id, checkpoint_health, last_trigger, created_at, updated_at
        FROM conversation_compactions
        WHERE conversation_id = ?
        "#,
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|row| ConversationCompactionStateRecord {
        conversation_id: row.get("conversation_id"),
        up_to_message_id: row.get("up_to_message_id"),
        summary_text: row.get("summary_text"),
        tool_digest_json: row.get("tool_digest_json"),
        used_source_passage_ids_json: row.get("used_source_passage_ids_json"),
        interesting_source_passage_ids_json: row.get("interesting_source_passage_ids_json"),
        estimated_tokens_before: row.get("estimated_tokens_before"),
        estimated_tokens_after: row.get("estimated_tokens_after"),
        fingerprint: row.get("fingerprint"),
        version: row.get("version"),
        pruned_tool_context_message_ids_json: row
            .try_get::<Option<String>, _>("pruned_tool_context_message_ids_json")
            .ok()
            .flatten(),
        reserved_tokens: row
            .try_get::<Option<i32>, _>("reserved_tokens")
            .ok()
            .flatten(),
        footprint_before_json: row
            .try_get::<Option<String>, _>("footprint_before_json")
            .ok()
            .flatten(),
        footprint_after_json: row
            .try_get::<Option<String>, _>("footprint_after_json")
            .ok()
            .flatten(),
        degraded_reason: row
            .try_get::<Option<String>, _>("degraded_reason")
            .ok()
            .flatten(),
        compaction_kind: row
            .try_get::<Option<String>, _>("compaction_kind")
            .ok()
            .flatten(),
        compaction_pass: row
            .try_get::<Option<String>, _>("compaction_pass")
            .ok()
            .flatten(),
        summary_format_version: row
            .try_get::<Option<i32>, _>("summary_format_version")
            .ok()
            .flatten(),
        summary_source: row
            .try_get::<Option<String>, _>("summary_source")
            .ok()
            .flatten(),
        policy_version: row
            .try_get::<Option<i32>, _>("policy_version")
            .ok()
            .flatten(),
        fingerprint_inputs_json: row
            .try_get::<Option<String>, _>("fingerprint_inputs_json")
            .ok()
            .flatten(),
        source_hashes_json: row
            .try_get::<Option<String>, _>("source_hashes_json")
            .ok()
            .flatten(),
        model_context_window_tokens: row
            .try_get::<Option<i32>, _>("model_context_window_tokens")
            .ok()
            .flatten(),
        provider_id: row
            .try_get::<Option<String>, _>("provider_id")
            .ok()
            .flatten(),
        model_id: row.try_get::<Option<String>, _>("model_id").ok().flatten(),
        checkpoint_health: row
            .try_get::<Option<String>, _>("checkpoint_health")
            .ok()
            .flatten(),
        last_trigger: row
            .try_get::<Option<String>, _>("last_trigger")
            .ok()
            .flatten(),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }))
}

pub async fn upsert_conversation_compaction_state(
    pool: &SqlitePool,
    input: UpsertConversationCompactionStateInput,
) -> DbResult<ConversationCompactionStateRecord> {
    let now = chrono::Utc::now().to_rfc3339();
    let conversation_id = input.conversation_id.clone();

    sqlx::query(
        r#"
        INSERT INTO conversation_compactions (
            conversation_id, up_to_message_id, summary_text, tool_digest_json,
            used_source_passage_ids_json, interesting_source_passage_ids_json,
            estimated_tokens_before, estimated_tokens_after, fingerprint,
            version, pruned_tool_context_message_ids_json, reserved_tokens,
            footprint_before_json, footprint_after_json, degraded_reason,
            compaction_kind, compaction_pass, summary_format_version,
            summary_source, policy_version, fingerprint_inputs_json,
            source_hashes_json, model_context_window_tokens, provider_id,
            model_id, checkpoint_health, last_trigger, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
            up_to_message_id = excluded.up_to_message_id,
            summary_text = excluded.summary_text,
            tool_digest_json = excluded.tool_digest_json,
            used_source_passage_ids_json = excluded.used_source_passage_ids_json,
            interesting_source_passage_ids_json = excluded.interesting_source_passage_ids_json,
            estimated_tokens_before = excluded.estimated_tokens_before,
            estimated_tokens_after = excluded.estimated_tokens_after,
            fingerprint = excluded.fingerprint,
            version = excluded.version,
            pruned_tool_context_message_ids_json = excluded.pruned_tool_context_message_ids_json,
            reserved_tokens = excluded.reserved_tokens,
            footprint_before_json = excluded.footprint_before_json,
            footprint_after_json = excluded.footprint_after_json,
            degraded_reason = excluded.degraded_reason,
            compaction_kind = excluded.compaction_kind,
            compaction_pass = excluded.compaction_pass,
            summary_format_version = excluded.summary_format_version,
            summary_source = excluded.summary_source,
            policy_version = excluded.policy_version,
            fingerprint_inputs_json = excluded.fingerprint_inputs_json,
            source_hashes_json = excluded.source_hashes_json,
            model_context_window_tokens = excluded.model_context_window_tokens,
            provider_id = excluded.provider_id,
            model_id = excluded.model_id,
            checkpoint_health = excluded.checkpoint_health,
            last_trigger = excluded.last_trigger,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(&input.conversation_id)
    .bind(&input.up_to_message_id)
    .bind(&input.summary_text)
    .bind(&input.tool_digest_json)
    .bind(&input.used_source_passage_ids_json)
    .bind(&input.interesting_source_passage_ids_json)
    .bind(input.estimated_tokens_before)
    .bind(input.estimated_tokens_after)
    .bind(&input.fingerprint)
    .bind(input.version)
    .bind(
        input
            .pruned_tool_context_message_ids_json
            .as_deref()
            .unwrap_or("[]"),
    )
    .bind(input.reserved_tokens)
    .bind(&input.footprint_before_json)
    .bind(&input.footprint_after_json)
    .bind(&input.degraded_reason)
    .bind(&input.compaction_kind)
    .bind(&input.compaction_pass)
    .bind(input.summary_format_version)
    .bind(&input.summary_source)
    .bind(input.policy_version)
    .bind(&input.fingerprint_inputs_json)
    .bind(&input.source_hashes_json)
    .bind(input.model_context_window_tokens)
    .bind(&input.provider_id)
    .bind(&input.model_id)
    .bind(&input.checkpoint_health)
    .bind(&input.last_trigger)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;

    get_conversation_compaction_state(pool, &conversation_id)
        .await?
        .ok_or_else(|| sqlx::Error::RowNotFound.into())
}

pub async fn insert_conversation_compaction_event(
    pool: &SqlitePool,
    input: InsertConversationCompactionEventInput,
) -> DbResult<()> {
    let now = chrono::Utc::now();
    let id = format!(
        "compaction-event-{}-{}",
        input.conversation_id,
        now.timestamp_nanos_opt().unwrap_or_default()
    );
    let created_at = now.to_rfc3339();

    sqlx::query(
        r#"
        INSERT INTO conversation_compaction_events (
            id, conversation_id, trigger, provider_id, model_id,
            model_context_window_tokens, tokens_before, tokens_after,
            status, error_code, reason, metadata_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&id)
    .bind(&input.conversation_id)
    .bind(&input.trigger)
    .bind(&input.provider_id)
    .bind(&input.model_id)
    .bind(input.model_context_window_tokens)
    .bind(input.tokens_before)
    .bind(input.tokens_after)
    .bind(&input.status)
    .bind(&input.error_code)
    .bind(&input.reason)
    .bind(&input.metadata_json)
    .bind(&created_at)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn delete_conversation_compaction_state(
    pool: &SqlitePool,
    conversation_id: &str,
) -> DbResult<()> {
    sqlx::query(
        r#"
        DELETE FROM conversation_compactions
        WHERE conversation_id = ?
        "#,
    )
    .bind(conversation_id)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn update_manual_model(
    pool: &SqlitePool,
    provider_id: &str,
    current_model_id: &str,
    next_model_id: &str,
    name: &str,
) -> DbResult<()> {
    let current_id = format!("{}::{}", provider_id, current_model_id);
    let next_id = format!("{}::{}", provider_id, next_model_id);
    let now = chrono::Utc::now().to_rfc3339();

    let mut tx = pool.begin().await?;

    let existing = sqlx::query(
        r#"
        SELECT is_enabled, first_seen_at
        FROM ai_models
        WHERE id = ? AND provider_id = ? AND is_manual = 1
        "#,
    )
    .bind(&current_id)
    .bind(provider_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(existing) = existing else {
        return Err(DbError::Validation(format!(
            "Manual model {current_model_id} not found for provider {provider_id}."
        )));
    };

    if current_model_id != next_model_id {
        let conflict = sqlx::query(
            r#"
            SELECT id
            FROM ai_models
            WHERE id = ? AND provider_id = ?
            "#,
        )
        .bind(&next_id)
        .bind(provider_id)
        .fetch_optional(&mut *tx)
        .await?;

        if conflict.is_some() {
            return Err(DbError::Validation(format!(
                "Model {next_model_id} already exists for provider {provider_id}."
            )));
        }

        sqlx::query("DELETE FROM ai_models WHERE id = ? AND provider_id = ? AND is_manual = 1")
            .bind(&current_id)
            .bind(provider_id)
            .execute(&mut *tx)
            .await?;

        sqlx::query(
            r#"
            INSERT INTO ai_models (
                id, provider_id, model_id, name, description, owned_by,
                pricing_prompt, pricing_completion, pricing_request,
                reasoning_efforts_json, default_reasoning_effort,
                is_enabled, is_manual, first_seen_at, last_seen_at
            )
            VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, 1, ?, ?)
            "#,
        )
        .bind(&next_id)
        .bind(provider_id)
        .bind(next_model_id)
        .bind(name)
        .bind(existing.get::<i32, _>("is_enabled"))
        .bind(existing.get::<String, _>("first_seen_at"))
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query(
            r#"
            UPDATE ai_models
            SET name = ?, last_seen_at = ?
            WHERE id = ? AND provider_id = ? AND is_manual = 1
            "#,
        )
        .bind(name)
        .bind(&now)
        .bind(&current_id)
        .bind(provider_id)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

pub async fn delete_manual_model(
    pool: &SqlitePool,
    provider_id: &str,
    model_id: &str,
) -> DbResult<()> {
    let id = format!("{}::{}", provider_id, model_id);
    let result = sqlx::query(
        r#"
        DELETE FROM ai_models
        WHERE id = ? AND provider_id = ? AND is_manual = 1
        "#,
    )
    .bind(&id)
    .bind(provider_id)
    .execute(pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(DbError::Validation(format!(
            "Manual model {model_id} not found for provider {provider_id}."
        )));
    }

    Ok(())
}

pub async fn set_model_enabled(
    pool: &SqlitePool,
    provider_id: &str,
    model_id: &str,
    enabled: bool,
) -> DbResult<()> {
    let id = format!("{}::{}", provider_id, model_id);
    sqlx::query(
        r#"
        UPDATE ai_models
        SET is_enabled = ?
        WHERE id = ?
        "#,
    )
    .bind(enabled as i32)
    .bind(&id)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn set_all_models_enabled(
    pool: &SqlitePool,
    provider_id: &str,
    enabled: bool,
) -> DbResult<()> {
    sqlx::query(
        r#"
        UPDATE ai_models
        SET is_enabled = ?
        WHERE provider_id = ?
        "#,
    )
    .bind(enabled as i32)
    .bind(provider_id)
    .execute(pool)
    .await?;

    Ok(())
}

// ============ PROVIDER SETTINGS ============

pub async fn ensure_provider_settings(pool: &SqlitePool, provider_id: &str) -> DbResult<()> {
    sqlx::query(
        r#"
        INSERT OR IGNORE INTO provider_settings (provider_id, filter_free_models)
        VALUES (?, 0)
        "#,
    )
    .bind(provider_id)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn get_provider_settings(
    pool: &SqlitePool,
    provider_id: &str,
) -> DbResult<ProviderSettings> {
    ensure_provider_settings(pool, provider_id).await?;

    let row = sqlx::query(
        r#"
        SELECT provider_id, filter_free_models, copilot_send_timeout_ms
        FROM provider_settings
        WHERE provider_id = ?
        "#,
    )
    .bind(provider_id)
    .fetch_one(pool)
    .await?;

    Ok(ProviderSettings {
        provider_id: row.get("provider_id"),
        filter_free_models: row.get::<i32, _>("filter_free_models") != 0,
        copilot_send_timeout_ms: row.get("copilot_send_timeout_ms"),
    })
}

pub async fn update_provider_settings(
    pool: &SqlitePool,
    provider_id: &str,
    filter_free_models: Option<bool>,
    copilot_send_timeout_ms: Option<Option<i64>>,
) -> DbResult<()> {
    ensure_provider_settings(pool, provider_id).await?;

    if let Some(filter_free_models) = filter_free_models {
        sqlx::query(
            r#"
            UPDATE provider_settings
            SET filter_free_models = ?
            WHERE provider_id = ?
            "#,
        )
        .bind(filter_free_models as i32)
        .bind(provider_id)
        .execute(pool)
        .await?;
    }

    if let Some(copilot_send_timeout_ms) = copilot_send_timeout_ms {
        sqlx::query(
            r#"
            UPDATE provider_settings
            SET copilot_send_timeout_ms = ?
            WHERE provider_id = ?
            "#,
        )
        .bind(copilot_send_timeout_ms)
        .bind(provider_id)
        .execute(pool)
        .await?;
    }

    Ok(())
}

// ============ APP SETTINGS ============

pub async fn get_app_setting(pool: &SqlitePool, key: &str) -> DbResult<Option<AppSettingRecord>> {
    let row = sqlx::query(
        r#"
        SELECT key, value_json, updated_at
        FROM app_settings
        WHERE key = ?
        "#,
    )
    .bind(key)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|row| AppSettingRecord {
        key: row.get("key"),
        value_json: row.get("value_json"),
        updated_at: row.get("updated_at"),
    }))
}

pub async fn set_app_setting(
    pool: &SqlitePool,
    key: &str,
    value_json: &str,
) -> DbResult<AppSettingRecord> {
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        r#"
        INSERT INTO app_settings (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(key)
    .bind(value_json)
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(AppSettingRecord {
        key: key.to_string(),
        value_json: value_json.to_string(),
        updated_at: now,
    })
}

pub async fn compare_and_swap_app_setting(
    pool: &SqlitePool,
    key: &str,
    expected_value_json: Option<&str>,
    value_json: &str,
) -> DbResult<CompareAndSwapAppSettingResult> {
    let now = chrono::Utc::now().to_rfc3339();
    let result = sqlx::query(
        r#"
        INSERT INTO app_settings (key, value_json, updated_at)
        SELECT ?, ?, ?
        WHERE (? IS NULL AND NOT EXISTS (SELECT 1 FROM app_settings WHERE key = ?))
           OR (? IS NOT NULL AND EXISTS (
               SELECT 1 FROM app_settings WHERE key = ? AND value_json = ?
           ))
        ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(key)
    .bind(value_json)
    .bind(now)
    .bind(expected_value_json)
    .bind(key)
    .bind(expected_value_json)
    .bind(key)
    .bind(expected_value_json)
    .execute(pool)
    .await?;

    Ok(CompareAndSwapAppSettingResult {
        applied: result.rows_affected() == 1,
    })
}

// ============ TERMINAL TABS ============

pub async fn list_terminal_tabs(pool: &SqlitePool) -> DbResult<Vec<TerminalTabRecord>> {
    let rows = sqlx::query(
        r#"
        SELECT
            id,
            kind,
            task_id,
            project_id,
            project_name,
            mount_name,
            workspace_path,
            cwd,
            title,
            prompt_context_json,
            status,
            snapshot,
            last_command,
            last_exit_code,
            generation,
            created_at,
            updated_at
        FROM terminal_tabs
        ORDER BY updated_at DESC, created_at DESC
        "#,
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| TerminalTabRecord {
            id: row.get("id"),
            kind: row.get("kind"),
            task_id: row.get("task_id"),
            project_id: row.get("project_id"),
            project_name: row.get("project_name"),
            mount_name: row.get("mount_name"),
            workspace_path: row.get("workspace_path"),
            cwd: row.get("cwd"),
            title: row.get("title"),
            prompt_context_json: row.get("prompt_context_json"),
            status: row.get("status"),
            snapshot: row.get("snapshot"),
            last_command: row.get("last_command"),
            last_exit_code: row.get("last_exit_code"),
            generation: row.get("generation"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
        })
        .collect())
}

pub async fn get_terminal_tab(pool: &SqlitePool, id: &str) -> DbResult<Option<TerminalTabRecord>> {
    let row = sqlx::query(
        r#"
        SELECT
            id,
            kind,
            task_id,
            project_id,
            project_name,
            mount_name,
            workspace_path,
            cwd,
            title,
            prompt_context_json,
            status,
            snapshot,
            last_command,
            last_exit_code,
            generation,
            created_at,
            updated_at
        FROM terminal_tabs
        WHERE id = ?
        "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|row| TerminalTabRecord {
        id: row.get("id"),
        kind: row.get("kind"),
        task_id: row.get("task_id"),
        project_id: row.get("project_id"),
        project_name: row.get("project_name"),
        mount_name: row.get("mount_name"),
        workspace_path: row.get("workspace_path"),
        cwd: row.get("cwd"),
        title: row.get("title"),
        prompt_context_json: row.get("prompt_context_json"),
        status: row.get("status"),
        snapshot: row.get("snapshot"),
        last_command: row.get("last_command"),
        last_exit_code: row.get("last_exit_code"),
        generation: row.get("generation"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }))
}

pub async fn upsert_terminal_tab(
    pool: &SqlitePool,
    tab: &TerminalTabRecord,
) -> DbResult<TerminalTabRecord> {
    sqlx::query(
        r#"
        INSERT INTO terminal_tabs (
            id,
            kind,
            task_id,
            project_id,
            project_name,
            mount_name,
            workspace_path,
            cwd,
            title,
            prompt_context_json,
            status,
            snapshot,
            last_command,
            last_exit_code,
            generation,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            kind = excluded.kind,
            task_id = excluded.task_id,
            project_id = excluded.project_id,
            project_name = excluded.project_name,
            mount_name = excluded.mount_name,
            workspace_path = excluded.workspace_path,
            cwd = excluded.cwd,
            title = excluded.title,
            prompt_context_json = excluded.prompt_context_json,
            status = excluded.status,
            snapshot = excluded.snapshot,
            last_command = excluded.last_command,
            last_exit_code = excluded.last_exit_code,
            generation = excluded.generation,
            updated_at = excluded.updated_at
        WHERE excluded.generation > terminal_tabs.generation
        "#,
    )
    .bind(&tab.id)
    .bind(&tab.kind)
    .bind(&tab.task_id)
    .bind(&tab.project_id)
    .bind(&tab.project_name)
    .bind(&tab.mount_name)
    .bind(&tab.workspace_path)
    .bind(&tab.cwd)
    .bind(&tab.title)
    .bind(&tab.prompt_context_json)
    .bind(&tab.status)
    .bind(&tab.snapshot)
    .bind(&tab.last_command)
    .bind(tab.last_exit_code)
    .bind(tab.generation)
    .bind(&tab.created_at)
    .bind(&tab.updated_at)
    .execute(pool)
    .await?;

    Ok(tab.clone())
}

pub async fn delete_terminal_tab(pool: &SqlitePool, id: &str) -> DbResult<()> {
    sqlx::query("DELETE FROM terminal_tabs WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;

    Ok(())
}

// ============ PROJECT CONTEXT STATE ============

pub async fn get_project_context_state(
    pool: &SqlitePool,
    project_id: &str,
) -> DbResult<Option<ProjectContextStateRecord>> {
    let row = sqlx::query(
        r#"
        SELECT project_id, group_id, focus_project_id, last_plan_id, last_task_id, architect_conversation_id, implement_conversation_id, updated_at
        FROM project_context_states
        WHERE project_id = ?
        "#,
    )
    .bind(project_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|row| ProjectContextStateRecord {
        project_id: row.get("project_id"),
        group_id: row.get("group_id"),
        focus_project_id: row.get("focus_project_id"),
        last_plan_id: row.get("last_plan_id"),
        last_task_id: row.get("last_task_id"),
        architect_conversation_id: row.get("architect_conversation_id"),
        implement_conversation_id: row.get("implement_conversation_id"),
        updated_at: row.get("updated_at"),
    }))
}

pub async fn upsert_project_context_state(
    pool: &SqlitePool,
    input: UpsertProjectContextStateInput,
) -> DbResult<ProjectContextStateRecord> {
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        r#"
        INSERT INTO project_context_states (
            project_id,
            group_id,
            focus_project_id,
            last_plan_id,
            last_task_id,
            architect_conversation_id,
            implement_conversation_id,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
            group_id = excluded.group_id,
            focus_project_id = excluded.focus_project_id,
            last_plan_id = excluded.last_plan_id,
            last_task_id = excluded.last_task_id,
            architect_conversation_id = excluded.architect_conversation_id,
            implement_conversation_id = excluded.implement_conversation_id,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(&input.project_id)
    .bind(&input.group_id)
    .bind(&input.focus_project_id)
    .bind(&input.last_plan_id)
    .bind(&input.last_task_id)
    .bind(&input.architect_conversation_id)
    .bind(&input.implement_conversation_id)
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(ProjectContextStateRecord {
        project_id: input.project_id,
        group_id: input.group_id,
        focus_project_id: input.focus_project_id,
        last_plan_id: input.last_plan_id,
        last_task_id: input.last_task_id,
        architect_conversation_id: input.architect_conversation_id,
        implement_conversation_id: input.implement_conversation_id,
        updated_at: now,
    })
}

pub async fn delete_project_context_state(pool: &SqlitePool, project_id: &str) -> DbResult<()> {
    sqlx::query("DELETE FROM project_context_states WHERE project_id = ?")
        .bind(project_id)
        .execute(pool)
        .await?;

    Ok(())
}

// ============ SESSION CONTEXT STATE ============

pub async fn get_session_context_state(
    pool: &SqlitePool,
) -> DbResult<Option<SessionContextStateRecord>> {
    let row = sqlx::query(
        r#"
        SELECT selected_group_id, selected_project_id, mode, updated_at
        FROM session_context_state
        WHERE id = 1
        "#,
    )
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|row| SessionContextStateRecord {
        selected_group_id: row.get("selected_group_id"),
        selected_project_id: row.get("selected_project_id"),
        mode: row.get("mode"),
        updated_at: row.get("updated_at"),
    }))
}

pub async fn upsert_session_context_state(
    pool: &SqlitePool,
    input: UpsertSessionContextStateInput,
) -> DbResult<SessionContextStateRecord> {
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        r#"
        INSERT INTO session_context_state (
            id,
            selected_group_id,
            selected_project_id,
            mode,
            updated_at
        )
        VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            selected_group_id = excluded.selected_group_id,
            selected_project_id = excluded.selected_project_id,
            mode = excluded.mode,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(&input.selected_group_id)
    .bind(&input.selected_project_id)
    .bind(&input.mode)
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(SessionContextStateRecord {
        selected_group_id: input.selected_group_id,
        selected_project_id: input.selected_project_id,
        mode: input.mode,
        updated_at: now,
    })
}

pub async fn reconcile_project_registry(
    pool: &SqlitePool,
    input: ReconcileProjectRegistryInput,
) -> DbResult<ProjectRegistryDbRepairReport> {
    let valid_group_ids: HashSet<String> = input
        .valid_group_ids
        .into_iter()
        .filter(|value| !value.trim().is_empty())
        .collect();
    let valid_project_ids: HashSet<String> = input
        .valid_project_ids
        .into_iter()
        .filter(|value| !value.trim().is_empty())
        .collect();

    let mut report = ProjectRegistryDbRepairReport {
        conversations_updated: 0,
        project_contexts_deleted: 0,
        project_contexts_updated: 0,
        session_context_updated: false,
    };

    let conversation_rows = sqlx::query(
        r#"
        SELECT id, group_id, project_id
        FROM conversations
        "#,
    )
    .fetch_all(pool)
    .await?;

    for row in conversation_rows {
        let id: String = row.get("id");
        let current_group_id: Option<String> = row.get("group_id");
        let current_project_id: Option<String> = row.get("project_id");
        let next_group_id = current_group_id
            .clone()
            .filter(|group_id| valid_group_ids.contains(group_id));
        let next_project_id = current_project_id
            .clone()
            .filter(|project_id| valid_project_ids.contains(project_id));

        if current_group_id != next_group_id || current_project_id != next_project_id {
            sqlx::query(
                r#"
                UPDATE conversations
                SET group_id = ?, project_id = ?
                WHERE id = ?
                "#,
            )
            .bind(&next_group_id)
            .bind(&next_project_id)
            .bind(&id)
            .execute(pool)
            .await?;
            report.conversations_updated += 1;
        }
    }

    let project_context_rows = sqlx::query(
        r#"
        SELECT project_id, group_id, focus_project_id, last_plan_id, last_task_id,
               architect_conversation_id, implement_conversation_id, updated_at
        FROM project_context_states
        "#,
    )
    .fetch_all(pool)
    .await?;

    for row in project_context_rows {
        let project_id: String = row.get("project_id");
        if !valid_project_ids.contains(&project_id) {
            sqlx::query("DELETE FROM project_context_states WHERE project_id = ?")
                .bind(&project_id)
                .execute(pool)
                .await?;
            report.project_contexts_deleted += 1;
            continue;
        }

        let current_group_id: Option<String> = row.get("group_id");
        let current_focus_project_id: Option<String> = row.get("focus_project_id");
        let next_group_id = current_group_id
            .clone()
            .filter(|group_id| valid_group_ids.contains(group_id));
        let next_focus_project_id = current_focus_project_id
            .clone()
            .filter(|project_id| valid_project_ids.contains(project_id));

        if current_group_id != next_group_id || current_focus_project_id != next_focus_project_id {
            sqlx::query(
                r#"
                UPDATE project_context_states
                SET group_id = ?, focus_project_id = ?
                WHERE project_id = ?
                "#,
            )
            .bind(&next_group_id)
            .bind(&next_focus_project_id)
            .bind(&project_id)
            .execute(pool)
            .await?;
            report.project_contexts_updated += 1;
        }
    }

    let session_context = get_session_context_state(pool).await?;
    let next_selected_group_id = input
        .selected_group_id
        .filter(|group_id| valid_group_ids.contains(group_id));
    let next_selected_project_id = input
        .selected_project_id
        .filter(|project_id| valid_project_ids.contains(project_id));
    let current_selected_group_id = session_context
        .as_ref()
        .and_then(|record| record.selected_group_id.clone());
    let current_selected_project_id = session_context
        .as_ref()
        .and_then(|record| record.selected_project_id.clone());

    if current_selected_group_id != next_selected_group_id
        || current_selected_project_id != next_selected_project_id
    {
        let mode = session_context.and_then(|record| record.mode);
        upsert_session_context_state(
            pool,
            UpsertSessionContextStateInput {
                selected_group_id: next_selected_group_id,
                selected_project_id: next_selected_project_id,
                mode,
            },
        )
        .await?;
        report.session_context_updated = true;
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::super::create_pool;
    use super::*;
    use tempfile::TempDir;

    async fn test_pool() -> (TempDir, SqlitePool) {
        let temp_dir = TempDir::new().expect("temp dir");
        let db_path = temp_dir.path().join("macro.db");
        let pool = create_pool(&db_path).await.expect("db pool");
        (temp_dir, pool)
    }

    #[tokio::test]
    async fn app_setting_compare_and_swap_distinguishes_absence_and_exact_values() {
        let (_temp_dir, pool) = test_pool().await;

        assert!(
            compare_and_swap_app_setting(&pool, "cas", None, r#"{"version":1}"#)
                .await
                .expect("insert absent")
                .applied
        );
        assert!(
            !compare_and_swap_app_setting(&pool, "cas", None, "unexpected")
                .await
                .expect("reject second insert")
                .applied
        );
        assert!(
            !compare_and_swap_app_setting(&pool, "cas", Some("wrong"), "unexpected")
                .await
                .expect("reject stale update")
                .applied
        );
        assert!(
            compare_and_swap_app_setting(
                &pool,
                "cas",
                Some(r#"{"version":1}"#),
                r#"{"version":1}"#
            )
            .await
            .expect("accept identical replacement")
            .applied
        );
        assert!(
            compare_and_swap_app_setting(
                &pool,
                "cas",
                Some(r#"{"version":1}"#),
                r#"{"version":2}"#
            )
            .await
            .expect("accept exact update")
            .applied
        );
    }

    #[tokio::test]
    async fn concurrent_app_setting_compare_and_swap_has_one_winner() {
        let (_temp_dir, pool) = test_pool().await;
        set_app_setting(&pool, "contended", "base")
            .await
            .expect("seed setting");
        let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(3));
        let mut tasks = Vec::new();
        for value in ["first", "second"] {
            let pool = pool.clone();
            let barrier = barrier.clone();
            tasks.push(tokio::spawn(async move {
                barrier.wait().await;
                compare_and_swap_app_setting(&pool, "contended", Some("base"), value)
                    .await
                    .expect("concurrent CAS")
                    .applied
            }));
        }
        barrier.wait().await;
        let mut winners = 0;
        for task in tasks {
            if task.await.expect("task") {
                winners += 1;
            }
        }
        assert_eq!(winners, 1);
    }

    async fn create_test_conversation(pool: &SqlitePool, title: &str) -> Conversation {
        create_conversation(
            pool,
            CreateConversationInput {
                title: Some(title.to_string()),
                scope_mode: "Chat".to_string(),
                task_id: None,
                group_id: None,
                project_id: None,
                provider_id: None,
                model_id: None,
                reasoning_effort: None,
            },
        )
        .await
        .expect("create conversation")
    }

    #[test]
    fn truncate_last_message_is_unicode_safe() {
        let content = "é".repeat(101);

        let truncated = truncate_last_message(&content);

        assert_eq!(truncated, format!("{}...", "é".repeat(100)));
    }

    #[tokio::test]
    async fn provider_settings_preserve_fields_on_partial_updates() {
        let (_temp_dir, pool) = test_pool().await;

        let initial = get_provider_settings(&pool, "copilot")
            .await
            .expect("initial settings");
        assert!(!initial.filter_free_models);
        assert_eq!(initial.copilot_send_timeout_ms, None);

        update_provider_settings(&pool, "copilot", None, Some(Some(1_800_000)))
            .await
            .expect("update timeout");
        let after_timeout = get_provider_settings(&pool, "copilot")
            .await
            .expect("settings after timeout");
        assert!(!after_timeout.filter_free_models);
        assert_eq!(after_timeout.copilot_send_timeout_ms, Some(1_800_000));

        update_provider_settings(&pool, "copilot", Some(true), None)
            .await
            .expect("update filter");
        let after_filter = get_provider_settings(&pool, "copilot")
            .await
            .expect("settings after filter");
        assert!(after_filter.filter_free_models);
        assert_eq!(after_filter.copilot_send_timeout_ms, Some(1_800_000));
    }

    #[tokio::test]
    async fn chat_bootstrap_preloads_requested_messages_in_deterministic_order() {
        let (_temp_dir, pool) = test_pool().await;
        let first = create_test_conversation(&pool, "First").await;
        let second = create_test_conversation(&pool, "Second").await;

        import_messages(
            &pool,
            &first.id,
            vec![
                ImportMessageInput {
                    id: "msg-b".to_string(),
                    turn_id: None,
                    role: "assistant".to_string(),
                    content: "Second by id".to_string(),
                    created_at: "2026-03-19T00:00:00.000Z".to_string(),
                    completion_reason: None,
                },
                ImportMessageInput {
                    id: "msg-a".to_string(),
                    turn_id: None,
                    role: "user".to_string(),
                    content: "First by id".to_string(),
                    created_at: "2026-03-19T00:00:00.000Z".to_string(),
                    completion_reason: None,
                },
            ],
        )
        .await
        .expect("import first messages");
        import_messages(
            &pool,
            &second.id,
            vec![ImportMessageInput {
                id: "other-msg".to_string(),
                turn_id: None,
                role: "user".to_string(),
                content: "Do not preload".to_string(),
                created_at: "2026-03-19T00:01:00.000Z".to_string(),
                completion_reason: None,
            }],
        )
        .await
        .expect("import second messages");

        let snapshot = get_chat_bootstrap_snapshot(&pool, std::slice::from_ref(&first.id))
            .await
            .expect("bootstrap snapshot");

        assert_eq!(snapshot.conversations.len(), 2);
        assert!(!snapshot
            .messages_by_conversation_id
            .contains_key(&second.id));
        let preloaded_ids = snapshot.messages_by_conversation_id[&first.id]
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(preloaded_ids, vec!["msg-a", "msg-b"]);
    }

    #[tokio::test]
    async fn delete_messages_after_uses_id_tiebreaker_and_refreshes_metadata() {
        let (_temp_dir, pool) = test_pool().await;
        let conversation = create_test_conversation(&pool, "Thread").await;
        let created_at = "2026-03-19T00:00:00.000Z".to_string();

        import_messages(
            &pool,
            &conversation.id,
            vec![
                ImportMessageInput {
                    id: "msg-1".to_string(),
                    turn_id: None,
                    role: "user".to_string(),
                    content: "Keep me".to_string(),
                    created_at: created_at.clone(),
                    completion_reason: None,
                },
                ImportMessageInput {
                    id: "msg-2".to_string(),
                    turn_id: None,
                    role: "assistant".to_string(),
                    content: "Delete me".to_string(),
                    created_at: created_at.clone(),
                    completion_reason: None,
                },
                ImportMessageInput {
                    id: "msg-3".to_string(),
                    turn_id: None,
                    role: "assistant".to_string(),
                    content: "Delete me too".to_string(),
                    created_at,
                    completion_reason: None,
                },
            ],
        )
        .await
        .expect("import messages");

        delete_messages_after(&pool, &conversation.id, "msg-1")
            .await
            .expect("delete after");

        let remaining_ids = list_messages(&pool, &conversation.id)
            .await
            .expect("list messages")
            .into_iter()
            .map(|message| message.id)
            .collect::<Vec<_>>();
        assert_eq!(remaining_ids, vec!["msg-1".to_string()]);

        let refreshed = get_conversation(&pool, &conversation.id)
            .await
            .expect("get conversation")
            .expect("conversation");
        assert_eq!(refreshed.message_count, 1);
        assert_eq!(refreshed.last_message.as_deref(), Some("Keep me"));
    }

    #[tokio::test]
    async fn trim_conversation_replay_rolls_back_tail_when_checkpoint_write_fails() {
        let (_temp_dir, pool) = test_pool().await;
        let conversation = create_test_conversation(&pool, "Thread").await;
        import_messages(
            &pool,
            &conversation.id,
            vec![
                ImportMessageInput {
                    id: "replay-keep".to_string(),
                    turn_id: None,
                    role: "user".to_string(),
                    content: "Keep me".to_string(),
                    created_at: "2026-03-19T00:00:00.000Z".to_string(),
                    completion_reason: None,
                },
                ImportMessageInput {
                    id: "replay-tail".to_string(),
                    turn_id: None,
                    role: "assistant".to_string(),
                    content: "Do not lose me".to_string(),
                    created_at: "2026-03-19T00:00:01.000Z".to_string(),
                    completion_reason: None,
                },
            ],
        )
        .await
        .expect("import messages");

        let checkpoint_key = format!("agentCodeCheckpoints:{}", conversation.id);
        set_app_setting(&pool, &checkpoint_key, "[\"old\"]")
            .await
            .expect("save checkpoints");
        sqlx::query(&format!(
            "CREATE TRIGGER fail_replay_checkpoint BEFORE INSERT ON app_settings WHEN NEW.key = 'agentCodeCheckpoints:{}' BEGIN SELECT RAISE(ABORT, 'injected checkpoint failure'); END",
            conversation.id
        ))
        .execute(&pool)
        .await
        .expect("install failure trigger");

        let result = trim_conversation_replay(
            &pool,
            &conversation.id,
            "replay-keep",
            Some("[\"new\"]"),
            true,
        )
        .await;
        assert!(result.is_err());

        let remaining_ids = list_messages(&pool, &conversation.id)
            .await
            .expect("list messages")
            .into_iter()
            .map(|message| message.id)
            .collect::<Vec<_>>();
        assert_eq!(remaining_ids, vec!["replay-keep", "replay-tail"]);
        assert_eq!(
            get_app_setting(&pool, &checkpoint_key)
                .await
                .expect("load checkpoints")
                .expect("checkpoint setting")
                .value_json,
            "[\"old\"]",
        );
    }

    #[tokio::test]
    async fn replay_recovery_restores_the_committed_trim_idempotently() {
        let (_temp_dir, pool) = test_pool().await;
        let conversation = create_test_conversation(&pool, "Replay recovery").await;
        import_messages(
            &pool,
            &conversation.id,
            vec![
                ImportMessageInput {
                    id: "replay-user".to_string(),
                    turn_id: Some("turn-1".to_string()),
                    role: "user".to_string(),
                    content: "Original".to_string(),
                    created_at: "2026-03-19T00:00:00.000Z".to_string(),
                    completion_reason: None,
                },
                ImportMessageInput {
                    id: "replay-tail".to_string(),
                    turn_id: Some("turn-1".to_string()),
                    role: "assistant".to_string(),
                    content: "Tail".to_string(),
                    created_at: "2026-03-19T00:00:01.000Z".to_string(),
                    completion_reason: None,
                },
            ],
        )
        .await
        .expect("seed messages");
        let checkpoint_key = format!("agentCodeCheckpoints:{}", conversation.id);
        set_app_setting(&pool, &checkpoint_key, "[\"before\"]")
            .await
            .expect("seed checkpoints");
        upsert_conversation_compaction_state(
            &pool,
            UpsertConversationCompactionStateInput {
                conversation_id: conversation.id.clone(),
                up_to_message_id: "replay-tail".to_string(),
                summary_text: "summary".to_string(),
                tool_digest_json: "[]".to_string(),
                used_source_passage_ids_json: "[]".to_string(),
                interesting_source_passage_ids_json: "[]".to_string(),
                estimated_tokens_before: 10,
                estimated_tokens_after: 2,
                fingerprint: "fingerprint".to_string(),
                version: 1,
                pruned_tool_context_message_ids_json: None,
                reserved_tokens: None,
                footprint_before_json: None,
                footprint_after_json: None,
                degraded_reason: None,
                compaction_kind: None,
                compaction_pass: None,
                summary_format_version: None,
                summary_source: None,
                policy_version: None,
                fingerprint_inputs_json: None,
                source_hashes_json: None,
                model_context_window_tokens: None,
                provider_id: None,
                model_id: None,
                checkpoint_health: None,
                last_trigger: None,
            },
        )
        .await
        .expect("seed compaction");

        prepare_conversation_replay(
            &pool,
            PrepareConversationReplayInput {
                conversation_id: &conversation.id,
                message_id: "replay-user",
                session_id: "session-1",
                turn_id: "turn-1",
                replay_id: "replay-1",
                content: "Edited",
                hidden_context: Some("hidden".to_string()),
                provider_input_items_json: Some("[]".to_string()),
                code_checkpoints_json: Some("[\"after\"]".to_string()),
                delete_context_compaction_state: true,
            },
        )
        .await
        .expect("prepare replay");
        assert_eq!(
            list_messages(&pool, &conversation.id)
                .await
                .expect("trimmed")
                .len(),
            1
        );

        assert!(
            restore_conversation_replay(&pool, &conversation.id, "replay-1", None, None)
                .await
                .expect("restore")
        );
        assert!(
            !restore_conversation_replay(&pool, &conversation.id, "replay-1", None, None)
                .await
                .expect("idempotent retry")
        );
        let messages = list_messages(&pool, &conversation.id)
            .await
            .expect("restored messages");
        assert_eq!(
            messages
                .iter()
                .map(|message| message.content.as_str())
                .collect::<Vec<_>>(),
            vec!["Original", "Tail"]
        );
        assert_eq!(
            get_app_setting(&pool, &checkpoint_key)
                .await
                .expect("checkpoints")
                .expect("checkpoint value")
                .value_json,
            "[\"before\"]"
        );
        assert!(get_conversation_compaction_state(&pool, &conversation.id)
            .await
            .expect("compaction")
            .is_some());
    }

    #[tokio::test]
    async fn replay_recovery_handles_crash_phases_without_overwriting_a_newer_turn() {
        let (_temp_dir, pool) = test_pool().await;
        let conversation = create_test_conversation(&pool, "Replay fences").await;
        import_messages(
            &pool,
            &conversation.id,
            vec![
                ImportMessageInput {
                    id: "anchor".to_string(),
                    turn_id: Some("turn-1".to_string()),
                    role: "user".to_string(),
                    content: "Original".to_string(),
                    created_at: "2026-03-19T00:00:00.000Z".to_string(),
                    completion_reason: None,
                },
                ImportMessageInput {
                    id: "tail".to_string(),
                    turn_id: Some("turn-1".to_string()),
                    role: "assistant".to_string(),
                    content: "Tail".to_string(),
                    created_at: "2026-03-19T00:00:01.000Z".to_string(),
                    completion_reason: None,
                },
            ],
        )
        .await
        .expect("seed messages");

        let prepare = |replay_id: &'static str| PrepareConversationReplayInput {
            conversation_id: &conversation.id,
            message_id: "anchor",
            session_id: "session-1",
            turn_id: "turn-1",
            replay_id,
            content: "Edited",
            hidden_context: None,
            provider_input_items_json: None,
            code_checkpoints_json: None,
            delete_context_compaction_state: false,
        };

        // Crash after trim (prepared) and after dbComplete (launch_ready) both restore.
        prepare_conversation_replay(&pool, prepare("prepared"))
            .await
            .expect("prepare");
        assert!(restore_conversation_replay(
            &pool,
            &conversation.id,
            "prepared",
            Some("session-1"),
            Some("turn-1"),
        )
        .await
        .expect("restore prepared"));

        prepare_conversation_replay(&pool, prepare("ready"))
            .await
            .expect("prepare ready");
        complete_conversation_replay(&pool, &conversation.id, "ready")
            .await
            .expect("mark ready");
        assert!(restore_conversation_replay(
            &pool,
            &conversation.id,
            "ready",
            Some("session-1"),
            Some("turn-1"),
        )
        .await
        .expect("restore ready"));

        // An empty launched placeholder is still safe to compensate after a crash.
        prepare_conversation_replay(&pool, prepare("empty-launch"))
            .await
            .expect("prepare empty launch");
        complete_conversation_replay(&pool, &conversation.id, "empty-launch")
            .await
            .expect("mark empty launch ready");
        mark_conversation_replay_launched(&pool, &conversation.id, "empty-launch")
            .await
            .expect("mark launched");
        import_messages(
            &pool,
            &conversation.id,
            vec![ImportMessageInput {
                id: "placeholder".to_string(),
                turn_id: Some("turn-1".to_string()),
                role: "assistant".to_string(),
                content: String::new(),
                created_at: "2026-03-19T00:00:02.000Z".to_string(),
                completion_reason: None,
            }],
        )
        .await
        .expect("insert placeholder");
        assert!(restore_conversation_replay(
            &pool,
            &conversation.id,
            "empty-launch",
            Some("session-1"),
            Some("turn-1"),
        )
        .await
        .expect("restore empty launch"));

        // A different turn is a durable fence. The old snapshot remains pending
        // until bootstrap can classify it, but must never overwrite the winner.
        prepare_conversation_replay(&pool, prepare("fenced"))
            .await
            .expect("prepare fenced");
        complete_conversation_replay(&pool, &conversation.id, "fenced")
            .await
            .expect("ready fenced");
        mark_conversation_replay_launched(&pool, &conversation.id, "fenced")
            .await
            .expect("launched fenced");
        import_messages(
            &pool,
            &conversation.id,
            vec![ImportMessageInput {
                id: "newer-turn".to_string(),
                turn_id: Some("turn-2".to_string()),
                role: "user".to_string(),
                content: "Winning request".to_string(),
                created_at: "2026-03-19T00:00:03.000Z".to_string(),
                completion_reason: None,
            }],
        )
        .await
        .expect("insert newer turn");
        assert!(!restore_conversation_replay(
            &pool,
            &conversation.id,
            "fenced",
            Some("session-1"),
            Some("turn-1"),
        )
        .await
        .expect("fence recovery"));
        assert!(list_messages(&pool, &conversation.id)
            .await
            .expect("winning transcript")
            .iter()
            .any(|message| message.id == "newer-turn"));
    }

    #[tokio::test]
    async fn replay_recovery_keeps_the_marker_after_a_sqlite_failure_and_retries() {
        let (_temp_dir, pool) = test_pool().await;
        let conversation = create_test_conversation(&pool, "Replay retry").await;
        import_messages(
            &pool,
            &conversation.id,
            vec![
                ImportMessageInput {
                    id: "anchor".to_string(),
                    turn_id: Some("turn-1".to_string()),
                    role: "user".to_string(),
                    content: "Original".to_string(),
                    created_at: "2026-03-19T00:00:00.000Z".to_string(),
                    completion_reason: None,
                },
                ImportMessageInput {
                    id: "tail".to_string(),
                    turn_id: Some("turn-1".to_string()),
                    role: "assistant".to_string(),
                    content: "Tail".to_string(),
                    created_at: "2026-03-19T00:00:01.000Z".to_string(),
                    completion_reason: None,
                },
            ],
        )
        .await
        .expect("seed messages");
        prepare_conversation_replay(
            &pool,
            PrepareConversationReplayInput {
                conversation_id: &conversation.id,
                message_id: "anchor",
                session_id: "session-1",
                turn_id: "turn-1",
                replay_id: "retry",
                content: "Edited",
                hidden_context: None,
                provider_input_items_json: None,
                code_checkpoints_json: None,
                delete_context_compaction_state: false,
            },
        )
        .await
        .expect("prepare replay");
        sqlx::query(&format!(
            "CREATE TRIGGER fail_replay_restore BEFORE UPDATE ON messages WHEN OLD.conversation_id = '{}' BEGIN SELECT RAISE(ABORT, 'injected recovery failure'); END",
            conversation.id
        ))
        .execute(&pool)
        .await
        .expect("install failure trigger");

        assert!(restore_conversation_replay(
            &pool,
            &conversation.id,
            "retry",
            Some("session-1"),
            Some("turn-1"),
        )
        .await
        .is_err());
        assert!(
            get_app_setting(&pool, &replay_recovery_key(&conversation.id))
                .await
                .expect("load marker")
                .is_some()
        );
        assert_eq!(
            list_messages(&pool, &conversation.id)
                .await
                .expect("trim remains committed")
                .len(),
            1
        );

        sqlx::query("DROP TRIGGER fail_replay_restore")
            .execute(&pool)
            .await
            .expect("remove failure trigger");
        assert!(restore_conversation_replay(
            &pool,
            &conversation.id,
            "retry",
            Some("session-1"),
            Some("turn-1"),
        )
        .await
        .expect("retry restore"));
        assert!(
            get_app_setting(&pool, &replay_recovery_key(&conversation.id))
                .await
                .expect("load marker")
                .is_none()
        );
    }

    #[tokio::test]
    async fn conversation_citations_crud_and_cascade_with_conversation() {
        let (_temp_dir, pool) = test_pool().await;
        let conversation = create_test_conversation(&pool, "Sources").await;

        let created = upsert_conversation_citation(
            &pool,
            UpsertConversationCitationInput {
                id: "cite-1".to_string(),
                conversation_id: conversation.id.clone(),
                message_id: "message-1".to_string(),
                r#type: "source_passage".to_string(),
                scope: "source".to_string(),
                source: "notes.md".to_string(),
                title: "Original".to_string(),
                snippet: Some("Saved passage".to_string()),
                content: Some("Saved passage".to_string()),
                url: None,
                favicon: None,
                path: Some("notes.md".to_string()),
                language: Some("markdown".to_string()),
                size_bytes: Some(14),
                kind: Some("interesting".to_string()),
                reason: Some("Worth saving".to_string()),
                timestamp: Some("2026-07-04T12:00:00Z".to_string()),
            },
        )
        .await
        .expect("insert citation");

        assert_eq!(created.id, "cite-1");
        assert_eq!(created.kind.as_deref(), Some("interesting"));

        let updated = upsert_conversation_citation(
            &pool,
            UpsertConversationCitationInput {
                id: "cite-1".to_string(),
                conversation_id: conversation.id.clone(),
                message_id: "message-2".to_string(),
                r#type: "source_passage".to_string(),
                scope: "source".to_string(),
                source: "notes.md".to_string(),
                title: "Updated".to_string(),
                snippet: Some("Saved passage".to_string()),
                content: Some("Saved passage".to_string()),
                url: None,
                favicon: None,
                path: Some("notes.md".to_string()),
                language: Some("markdown".to_string()),
                size_bytes: Some(14),
                kind: Some("used".to_string()),
                reason: Some("Used in answer".to_string()),
                timestamp: Some("2026-07-04T12:01:00Z".to_string()),
            },
        )
        .await
        .expect("update citation");

        assert_eq!(updated.created_at, "2026-07-04T12:00:00Z");
        assert_eq!(updated.updated_at, "2026-07-04T12:01:00Z");
        assert_eq!(updated.title, "Updated");
        assert_eq!(updated.kind.as_deref(), Some("used"));

        let listed = list_conversation_citations(&pool, &conversation.id)
            .await
            .expect("list citations");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "cite-1");
        assert_eq!(listed[0].content, None);
        assert_eq!(
            get_conversation_citation_content(&pool, "cite-1")
                .await
                .expect("citation content")
                .as_deref(),
            Some("Saved passage")
        );

        let metadata_only = upsert_conversation_citation(
            &pool,
            UpsertConversationCitationInput {
                id: "cite-1".to_string(),
                conversation_id: conversation.id.clone(),
                message_id: "message-2".to_string(),
                r#type: "source_passage".to_string(),
                scope: "source".to_string(),
                source: "notes.md".to_string(),
                title: "Metadata only".to_string(),
                snippet: Some("Lightweight passage".to_string()),
                content: None,
                url: None,
                favicon: None,
                path: Some("notes.md".to_string()),
                language: Some("markdown".to_string()),
                size_bytes: Some(14),
                kind: Some("used".to_string()),
                reason: Some("Metadata refreshed".to_string()),
                timestamp: Some("2026-07-04T12:01:30Z".to_string()),
            },
        )
        .await
        .expect("metadata-only update citation");

        assert_eq!(metadata_only.title, "Metadata only");
        assert_eq!(
            get_conversation_citation_content(&pool, "cite-1")
                .await
                .expect("citation content after metadata-only update")
                .as_deref(),
            Some("Saved passage")
        );

        delete_conversation_citation(&pool, "cite-1")
            .await
            .expect("delete citation");
        assert!(list_conversation_citations(&pool, &conversation.id)
            .await
            .expect("list after delete")
            .is_empty());

        upsert_conversation_citation(
            &pool,
            UpsertConversationCitationInput {
                id: "cite-cascade".to_string(),
                conversation_id: conversation.id.clone(),
                message_id: "message-3".to_string(),
                r#type: "web".to_string(),
                scope: "context".to_string(),
                source: "https://example.com".to_string(),
                title: "Example".to_string(),
                snippet: Some("Example snippet".to_string()),
                content: Some("Example content".to_string()),
                url: Some("https://example.com".to_string()),
                favicon: None,
                path: None,
                language: None,
                size_bytes: None,
                kind: None,
                reason: None,
                timestamp: Some("2026-07-04T12:02:00Z".to_string()),
            },
        )
        .await
        .expect("insert cascade citation");

        delete_conversation(&pool, &conversation.id)
            .await
            .expect("delete conversation");
        assert!(list_conversation_citations(&pool, &conversation.id)
            .await
            .expect("list after conversation delete")
            .is_empty());
    }

    #[tokio::test]
    async fn conversation_toolbox_state_crud_and_cascade_with_conversation() {
        let (_temp_dir, pool) = test_pool().await;
        let conversation = create_test_conversation(&pool, "Toolbox").await;

        let created = upsert_conversation_toolbox_state(
            &pool,
            UpsertConversationToolboxStateInput {
                conversation_id: conversation.id.clone(),
                composer_context_refs_json: r#"[{"id":"cite-1","kind":"source","title":"Source"}]"#
                    .to_string(),
                timestamp: Some("2026-07-04T13:00:00Z".to_string()),
            },
        )
        .await
        .expect("insert toolbox state");

        assert_eq!(created.conversation_id, conversation.id);
        assert_eq!(created.created_at, "2026-07-04T13:00:00Z");
        assert_eq!(created.updated_at, "2026-07-04T13:00:00Z");

        let updated = upsert_conversation_toolbox_state(
            &pool,
            UpsertConversationToolboxStateInput {
                conversation_id: conversation.id.clone(),
                composer_context_refs_json:
                    r#"[{"id":"file-1","kind":"file","title":"README.md"}]"#.to_string(),
                timestamp: Some("2026-07-04T13:01:00Z".to_string()),
            },
        )
        .await
        .expect("update toolbox state");

        assert_eq!(updated.created_at, "2026-07-04T13:00:00Z");
        assert_eq!(updated.updated_at, "2026-07-04T13:01:00Z");
        assert!(updated.composer_context_refs_json.contains("README.md"));

        let loaded = get_conversation_toolbox_state(&pool, &conversation.id)
            .await
            .expect("get toolbox state")
            .expect("toolbox state");
        assert_eq!(
            loaded.composer_context_refs_json,
            updated.composer_context_refs_json
        );

        delete_conversation_toolbox_state(&pool, &conversation.id)
            .await
            .expect("delete toolbox state");
        assert!(get_conversation_toolbox_state(&pool, &conversation.id)
            .await
            .expect("get after delete")
            .is_none());

        upsert_conversation_toolbox_state(
            &pool,
            UpsertConversationToolboxStateInput {
                conversation_id: conversation.id.clone(),
                composer_context_refs_json:
                    r#"[{"id":"cite-2","kind":"source","title":"Source 2"}]"#.to_string(),
                timestamp: Some("2026-07-04T13:02:00Z".to_string()),
            },
        )
        .await
        .expect("insert cascade toolbox state");

        delete_conversation(&pool, &conversation.id)
            .await
            .expect("delete conversation");
        assert!(get_conversation_toolbox_state(&pool, &conversation.id)
            .await
            .expect("get after conversation delete")
            .is_none());
    }

    #[tokio::test]
    async fn reconcile_project_registry_preserves_valid_project_contexts() {
        let (_temp_dir, pool) = test_pool().await;

        upsert_project_context_state(
            &pool,
            UpsertProjectContextStateInput {
                project_id: "project-valid".to_string(),
                group_id: Some("group-valid".to_string()),
                focus_project_id: Some("project-valid".to_string()),
                last_plan_id: Some("plan-1".to_string()),
                last_task_id: Some("task-1".to_string()),
                architect_conversation_id: None,
                implement_conversation_id: None,
            },
        )
        .await
        .expect("insert valid context");
        upsert_project_context_state(
            &pool,
            UpsertProjectContextStateInput {
                project_id: "project-invalid".to_string(),
                group_id: Some("group-valid".to_string()),
                focus_project_id: Some("project-invalid".to_string()),
                last_plan_id: None,
                last_task_id: None,
                architect_conversation_id: None,
                implement_conversation_id: None,
            },
        )
        .await
        .expect("insert invalid context");
        upsert_project_context_state(
            &pool,
            UpsertProjectContextStateInput {
                project_id: "project-stale-links".to_string(),
                group_id: Some("group-stale".to_string()),
                focus_project_id: Some("project-invalid".to_string()),
                last_plan_id: None,
                last_task_id: None,
                architect_conversation_id: None,
                implement_conversation_id: None,
            },
        )
        .await
        .expect("insert stale linked context");

        let report = reconcile_project_registry(
            &pool,
            ReconcileProjectRegistryInput {
                valid_group_ids: vec!["group-valid".to_string()],
                valid_project_ids: vec![
                    "project-valid".to_string(),
                    "project-stale-links".to_string(),
                ],
                selected_group_id: None,
                selected_project_id: None,
            },
        )
        .await
        .expect("reconcile registry");

        assert_eq!(report.project_contexts_deleted, 1);
        assert_eq!(report.project_contexts_updated, 1);

        let preserved = get_project_context_state(&pool, "project-valid")
            .await
            .expect("get preserved context")
            .expect("preserved context");
        assert_eq!(preserved.group_id.as_deref(), Some("group-valid"));
        assert_eq!(preserved.focus_project_id.as_deref(), Some("project-valid"));

        assert!(get_project_context_state(&pool, "project-invalid")
            .await
            .expect("get deleted context")
            .is_none());

        let cleaned = get_project_context_state(&pool, "project-stale-links")
            .await
            .expect("get cleaned context")
            .expect("cleaned context");
        assert_eq!(cleaned.group_id, None);
        assert_eq!(cleaned.focus_project_id, None);
    }
}
