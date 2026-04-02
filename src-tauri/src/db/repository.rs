use super::models::*;
use super::{ensure_git_tracking_tables, DbResult};
use sqlx::sqlite::SqlitePool;
use sqlx::Row;
use std::collections::HashSet;

// ============ CONVERSATIONS ============

pub async fn list_conversations(pool: &SqlitePool) -> DbResult<Vec<Conversation>> {
    let rows = sqlx::query(
        r#"
        SELECT id, title, description, task_id, group_id, project_id, created_at, updated_at, last_message, message_count, is_pinned
        FROM conversations
        ORDER BY is_pinned DESC, updated_at DESC
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
            task_id: row.get("task_id"),
            group_id: row.get("group_id"),
            project_id: row.get("project_id"),
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
        SELECT id, title, description, task_id, group_id, project_id, created_at, updated_at, last_message, message_count, is_pinned
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
        task_id: row.get("task_id"),
        group_id: row.get("group_id"),
        project_id: row.get("project_id"),
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
        INSERT INTO conversations (id, title, description, task_id, group_id, project_id, created_at, updated_at, message_count, is_pinned)
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 0, 0)
        "#,
    )
    .bind(&id)
    .bind(&title)
    .bind(&input.task_id)
    .bind(&input.group_id)
    .bind(&input.project_id)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(Conversation {
        id,
        title,
        description: None,
        task_id: input.task_id,
        group_id: input.group_id,
        project_id: input.project_id,
        created_at: now.clone(),
        updated_at: now,
        last_message: None,
        message_count: 0,
        is_pinned: false,
    })
}

fn truncate_last_message(content: &str) -> String {
    if content.len() > 100 {
        format!("{}...", &content[..100])
    } else {
        content.to_string()
    }
}

pub async fn refresh_conversation_metadata(
    pool: &SqlitePool,
    conversation_id: &str,
    updated_at_override: Option<&str>,
) -> DbResult<()> {
    let count: i32 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE conversation_id = ?")
        .bind(conversation_id)
        .fetch_one(pool)
        .await?;

    let latest_row = sqlx::query(
        r#"
        SELECT content, created_at
        FROM messages
        WHERE conversation_id = ?
        ORDER BY created_at DESC
        LIMIT 1
        "#,
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await?;

    let last_message = latest_row
        .as_ref()
        .map(|row| truncate_last_message(&row.get::<String, _>("content")));
    let fallback_updated_at = chrono::Utc::now().to_rfc3339();
    let updated_at = updated_at_override
        .map(str::to_string)
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
    .bind(conversation_id)
    .execute(pool)
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

pub async fn delete_conversation(pool: &SqlitePool, id: &str) -> DbResult<()> {
    // Messages are deleted via CASCADE
    sqlx::query("DELETE FROM conversations WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;

    Ok(())
}

pub async fn delete_conversations(pool: &SqlitePool, ids: &[String]) -> DbResult<()> {
    if ids.is_empty() {
        return Ok(());
    }

    let placeholders = vec!["?"; ids.len()].join(", ");
    let query = format!("DELETE FROM conversations WHERE id IN ({})", placeholders);

    let mut tx = pool.begin().await?;
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
    ensure_git_tracking_tables(pool).await?;
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
    ensure_git_tracking_tables(pool).await?;
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
    ensure_git_tracking_tables(pool).await?;
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
    ensure_git_tracking_tables(pool).await?;
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
        SELECT id, conversation_id, role, content, created_at, token_count, tool_traces_json, hidden_context
        FROM messages
        WHERE conversation_id = ?
        ORDER BY created_at ASC
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
            role: row.get("role"),
            content: row.get("content"),
            created_at: row.get("created_at"),
            token_count: row.get("token_count"),
            tool_traces_json: row.get("tool_traces_json"),
            hidden_context: row.get("hidden_context"),
        })
        .collect();

    Ok(messages)
}

pub async fn list_all_messages(pool: &SqlitePool) -> DbResult<Vec<Message>> {
    let rows = sqlx::query(
        r#"
        SELECT id, conversation_id, role, content, created_at, token_count, tool_traces_json, hidden_context
        FROM messages
        ORDER BY created_at ASC
        "#,
    )
    .fetch_all(pool)
    .await?;

    let messages = rows
        .into_iter()
        .map(|row| Message {
            id: row.get("id"),
            conversation_id: row.get("conversation_id"),
            role: row.get("role"),
            content: row.get("content"),
            created_at: row.get("created_at"),
            token_count: row.get("token_count"),
            tool_traces_json: row.get("tool_traces_json"),
            hidden_context: row.get("hidden_context"),
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

pub async fn create_message(pool: &SqlitePool, input: CreateMessageInput) -> DbResult<Message> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        r#"
        INSERT INTO messages (
            id,
            conversation_id,
            role,
            content,
            created_at,
            token_count,
            tool_traces_json,
            hidden_context
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&id)
    .bind(&input.conversation_id)
    .bind(&input.role)
    .bind(&input.content)
    .bind(&now)
    .bind(input.token_count)
    .bind(&input.tool_traces_json)
    .bind(&input.hidden_context)
    .execute(pool)
    .await?;

    refresh_conversation_metadata(pool, &input.conversation_id, Some(&now)).await?;

    Ok(Message {
        id,
        conversation_id: input.conversation_id,
        role: input.role,
        content: input.content,
        created_at: now,
        token_count: input.token_count,
        tool_traces_json: input.tool_traces_json,
        hidden_context: input.hidden_context,
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
                role,
                content,
                created_at,
                token_count,
                tool_traces_json,
                hidden_context
            )
            VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)
            ON CONFLICT(id) DO NOTHING
            "#,
        )
        .bind(&message.id)
        .bind(conversation_id)
        .bind(&message.role)
        .bind(&message.content)
        .bind(&message.created_at)
        .execute(&mut *transaction)
        .await?;

        if result.rows_affected() == 0 {
            continue;
        }

        last_created_at = Some(message.created_at.clone());
        inserted.push(Message {
            id: message.id,
            conversation_id: conversation_id.to_string(),
            role: message.role,
            content: message.content,
            created_at: message.created_at,
            token_count: None,
            tool_traces_json: None,
            hidden_context: None,
        });
    }

    transaction.commit().await?;
    refresh_conversation_metadata(pool, conversation_id, last_created_at.as_deref()).await?;

    Ok(inserted)
}

pub async fn update_message_content(
    pool: &SqlitePool,
    id: &str,
    content: &str,
    token_count: Option<i32>,
    tool_traces_json: Option<String>,
    hidden_context: Option<String>,
) -> DbResult<()> {
    sqlx::query(
        r#"
        UPDATE messages
        SET content = ?, token_count = ?, tool_traces_json = ?, hidden_context = ?
        WHERE id = ?
        "#,
    )
    .bind(content)
    .bind(token_count)
    .bind(tool_traces_json)
    .bind(hidden_context)
    .bind(id)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn delete_messages_after(
    pool: &SqlitePool,
    conversation_id: &str,
    after_message_id: &str,
) -> DbResult<()> {
    // Get the created_at of the reference message
    let row = sqlx::query("SELECT created_at FROM messages WHERE id = ?")
        .bind(after_message_id)
        .fetch_one(pool)
        .await?;

    let created_at: String = row.get("created_at");

    sqlx::query(
        r#"
        DELETE FROM messages 
        WHERE conversation_id = ? AND created_at > ?
        "#,
    )
    .bind(conversation_id)
    .bind(&created_at)
    .execute(pool)
    .await?;

    Ok(())
}

// ============ PROVIDER CONFIGS ============

pub async fn list_provider_configs(pool: &SqlitePool) -> DbResult<Vec<ProviderConfig>> {
    let rows = sqlx::query(
        r#"
        SELECT id, name, provider_type, base_url, is_enabled, is_local,
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
        SELECT id, name, provider_type, base_url, is_enabled, is_local,
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
    let mut has_base_url = false;
    let mut has_enabled = false;

    if input.name.is_some() {
        updates.push("name = ?".to_string());
        has_name = true;
    }
    if input.base_url.is_some() {
        updates.push("base_url = ?".to_string());
        has_base_url = true;
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
    if has_base_url {
        q = q.bind(input.base_url.unwrap());
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
    _api_key: Option<&str>,
    is_local: bool,
) -> DbResult<ProviderConfig> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        r#"
        INSERT INTO provider_configs (id, name, provider_type, base_url, api_key, is_enabled, is_local, created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, 1, ?, ?, ?)
        "#,
    )
    .bind(&id)
    .bind(name)
    .bind(provider_type)
    .bind(base_url)
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
        is_enabled: true,
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
    sqlx::query("DELETE FROM ai_models WHERE provider_id = ?")
        .bind(id)
        .execute(pool)
        .await?;

    sqlx::query("DELETE FROM provider_settings WHERE provider_id = ?")
        .bind(id)
        .execute(pool)
        .await?;

    sqlx::query("DELETE FROM provider_configs WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;

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
             is_enabled, is_manual, first_seen_at, last_seen_at
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
                is_enabled, is_manual, first_seen_at, last_seen_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                description = excluded.description,
                owned_by = excluded.owned_by,
                pricing_prompt = excluded.pricing_prompt,
                pricing_completion = excluded.pricing_completion,
                pricing_request = excluded.pricing_request,
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
            is_enabled, is_manual, first_seen_at, last_seen_at
        )
        VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 1, 1, ?, ?)
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
        SELECT provider_id, filter_free_models
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
    })
}

pub async fn update_provider_settings(
    pool: &SqlitePool,
    provider_id: &str,
    filter_free_models: bool,
) -> DbResult<()> {
    ensure_provider_settings(pool, provider_id).await?;

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
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            updated_at = excluded.updated_at
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
        if !valid_group_ids.contains(&project_id) {
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
