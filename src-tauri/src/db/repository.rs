use super::models::*;
use super::DbResult;
use sqlx::sqlite::SqlitePool;
use sqlx::Row;

// ============ CONVERSATIONS ============

pub async fn list_conversations(pool: &SqlitePool) -> DbResult<Vec<Conversation>> {
    let rows = sqlx::query(
        r#"
        SELECT id, title, created_at, updated_at, last_message, message_count, is_pinned
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
        SELECT id, title, created_at, updated_at, last_message, message_count, is_pinned
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
    let title = input.title.unwrap_or_else(|| "New Conversation".to_string());

    sqlx::query(
        r#"
        INSERT INTO conversations (id, title, created_at, updated_at, message_count, is_pinned)
        VALUES (?, ?, ?, ?, 0, 0)
        "#,
    )
    .bind(&id)
    .bind(&title)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(Conversation {
        id,
        title,
        created_at: now.clone(),
        updated_at: now,
        last_message: None,
        message_count: 0,
        is_pinned: false,
    })
}

pub async fn update_conversation_metadata(
    pool: &SqlitePool,
    id: &str,
    last_message: Option<&str>,
    message_count: i32,
) -> DbResult<()> {
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        r#"
        UPDATE conversations
        SET last_message = ?, message_count = ?, updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(last_message)
    .bind(message_count)
    .bind(&now)
    .bind(id)
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

pub async fn delete_conversation(pool: &SqlitePool, id: &str) -> DbResult<()> {
    // Messages are deleted via CASCADE
    sqlx::query("DELETE FROM conversations WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;

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

// ============ MESSAGES ============

pub async fn list_messages(pool: &SqlitePool, conversation_id: &str) -> DbResult<Vec<Message>> {
    let rows = sqlx::query(
        r#"
        SELECT id, conversation_id, role, content, created_at, token_count
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
        })
        .collect();

    Ok(messages)
}

pub async fn create_message(pool: &SqlitePool, input: CreateMessageInput) -> DbResult<Message> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        r#"
        INSERT INTO messages (id, conversation_id, role, content, created_at, token_count)
        VALUES (?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&id)
    .bind(&input.conversation_id)
    .bind(&input.role)
    .bind(&input.content)
    .bind(&now)
    .bind(input.token_count)
    .execute(pool)
    .await?;

    // Update conversation metadata
    let count: i32 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE conversation_id = ?")
        .bind(&input.conversation_id)
        .fetch_one(pool)
        .await?;

    let truncated_content = if input.content.len() > 100 {
        format!("{}...", &input.content[..100])
    } else {
        input.content.clone()
    };

    update_conversation_metadata(pool, &input.conversation_id, Some(&truncated_content), count)
        .await?;

    Ok(Message {
        id,
        conversation_id: input.conversation_id,
        role: input.role,
        content: input.content,
        created_at: now,
        token_count: input.token_count,
    })
}

pub async fn update_message_content(
    pool: &SqlitePool,
    id: &str,
    content: &str,
    token_count: Option<i32>,
) -> DbResult<()> {
    sqlx::query(
        r#"
        UPDATE messages
        SET content = ?, token_count = ?
        WHERE id = ?
        "#,
    )
    .bind(content)
    .bind(token_count)
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
        SELECT id, name, provider_type, base_url, is_enabled, is_local, created_at, updated_at
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
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
        })
        .collect();

    Ok(configs)
}

pub async fn get_provider_config(pool: &SqlitePool, id: &str) -> DbResult<Option<ProviderConfig>> {
    let row = sqlx::query(
        r#"
        SELECT id, name, provider_type, base_url, is_enabled, is_local, created_at, updated_at
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
        created_at: now.clone(),
        updated_at: now,
    })
}

pub async fn delete_provider_config(pool: &SqlitePool, id: &str) -> DbResult<()> {
    sqlx::query("DELETE FROM provider_configs WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;

    Ok(())
}
