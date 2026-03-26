pub mod models;
pub mod repository;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use sqlx::Row;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use tauri::{AppHandle, Manager};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum DbError {
    #[error("Database error: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("Failed to get app data directory")]
    AppDataDir,
    #[error("Migration error: {0}")]
    Migration(String),
}

pub type DbResult<T> = Result<T, DbError>;

fn app_db_path(app_dir: &Path) -> PathBuf {
    app_dir.join("macro.db")
}

/// Initialize the desktop database connection pool in the app data directory.
pub async fn init_db(app_handle: &AppHandle) -> DbResult<SqlitePool> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|_| DbError::AppDataDir)?;

    // Create the directory if it doesn't exist
    std::fs::create_dir_all(&app_dir).map_err(|e| DbError::Migration(e.to_string()))?;

    let db_path = app_db_path(&app_dir);

    create_pool(&db_path).await
}

/// Create a connection pool for the given database path
async fn create_pool(db_path: &PathBuf) -> DbResult<SqlitePool> {
    let db_url = format!("sqlite:{}?mode=rwc", db_path.display());

    let options = SqliteConnectOptions::from_str(&db_url)?
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
        .busy_timeout(std::time::Duration::from_secs(30));

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;

    // Run migrations
    run_migrations(&pool).await?;

    Ok(pool)
}

/// Run database migrations
async fn run_migrations(pool: &SqlitePool) -> DbResult<()> {
    sqlx::query("PRAGMA foreign_keys = ON;")
        .execute(pool)
        .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT,
            task_id TEXT,
            group_id TEXT,
            project_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_message TEXT,
            message_count INTEGER DEFAULT 0,
            is_pinned INTEGER DEFAULT 0
        );
        "#,
    )
    .execute(pool)
    .await?;

    let conversation_columns = sqlx::query("PRAGMA table_info(conversations)")
        .fetch_all(pool)
        .await?;
    let has_description = conversation_columns
        .iter()
        .any(|row| row.get::<String, _>("name") == "description");
    let has_task_id = conversation_columns
        .iter()
        .any(|row| row.get::<String, _>("name") == "task_id");
    let has_group_id = conversation_columns
        .iter()
        .any(|row| row.get::<String, _>("name") == "group_id");
    let has_project_id = conversation_columns
        .iter()
        .any(|row| row.get::<String, _>("name") == "project_id");
    if !has_description {
        sqlx::query("ALTER TABLE conversations ADD COLUMN description TEXT")
            .execute(pool)
            .await?;
    }
    if !has_task_id {
        sqlx::query("ALTER TABLE conversations ADD COLUMN task_id TEXT")
            .execute(pool)
            .await?;
    }
    if !has_group_id {
        sqlx::query("ALTER TABLE conversations ADD COLUMN group_id TEXT")
            .execute(pool)
            .await?;
    }
    if !has_project_id {
        sqlx::query("ALTER TABLE conversations ADD COLUMN project_id TEXT")
            .execute(pool)
            .await?;
    }

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_conversations_project_scope
        ON conversations(project_id, updated_at DESC);
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_conversations_group_scope
        ON conversations(group_id, updated_at DESC);
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_conversations_task_scope
        ON conversations(task_id, updated_at DESC);
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            token_count INTEGER,
            tool_traces_json TEXT,
            hidden_context TEXT,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
        "#,
    )
    .execute(pool)
    .await?;

    let message_columns = sqlx::query("PRAGMA table_info(messages)")
        .fetch_all(pool)
        .await?;
    let has_tool_traces_json = message_columns
        .iter()
        .any(|row| row.get::<String, _>("name") == "tool_traces_json");
    let has_hidden_context = message_columns
        .iter()
        .any(|row| row.get::<String, _>("name") == "hidden_context");
    if !has_tool_traces_json {
        sqlx::query("ALTER TABLE messages ADD COLUMN tool_traces_json TEXT")
            .execute(pool)
            .await?;
    }
    if !has_hidden_context {
        sqlx::query("ALTER TABLE messages ADD COLUMN hidden_context TEXT")
            .execute(pool)
            .await?;
    }

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_messages_conversation 
        ON messages(conversation_id);
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS provider_configs (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            provider_type TEXT NOT NULL,
            base_url TEXT NOT NULL,
            api_key TEXT,
            is_enabled INTEGER DEFAULT 1,
            is_local INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await?;

    let provider_columns = sqlx::query("PRAGMA table_info(provider_configs)")
        .fetch_all(pool)
        .await?;
    let has_auth_status = provider_columns
        .iter()
        .any(|row| row.get::<String, _>("name") == "auth_status");
    let has_auth_source = provider_columns
        .iter()
        .any(|row| row.get::<String, _>("name") == "auth_source");
    let has_plan_type = provider_columns
        .iter()
        .any(|row| row.get::<String, _>("name") == "plan_type");
    let has_account_label = provider_columns
        .iter()
        .any(|row| row.get::<String, _>("name") == "account_label");
    let has_token_expires_at = provider_columns
        .iter()
        .any(|row| row.get::<String, _>("name") == "token_expires_at");
    if !has_auth_status {
        sqlx::query("ALTER TABLE provider_configs ADD COLUMN auth_status TEXT")
            .execute(pool)
            .await?;
    }
    if !has_auth_source {
        sqlx::query("ALTER TABLE provider_configs ADD COLUMN auth_source TEXT")
            .execute(pool)
            .await?;
    }
    if !has_plan_type {
        sqlx::query("ALTER TABLE provider_configs ADD COLUMN plan_type TEXT")
            .execute(pool)
            .await?;
    }
    if !has_account_label {
        sqlx::query("ALTER TABLE provider_configs ADD COLUMN account_label TEXT")
            .execute(pool)
            .await?;
    }
    if !has_token_expires_at {
        sqlx::query("ALTER TABLE provider_configs ADD COLUMN token_expires_at TEXT")
            .execute(pool)
            .await?;
    }

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS ai_models (
            id TEXT PRIMARY KEY,
            provider_id TEXT NOT NULL,
            model_id TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            owned_by TEXT,
            pricing_prompt TEXT,
            pricing_completion TEXT,
            pricing_request TEXT,
            is_enabled INTEGER DEFAULT 1,
            first_seen_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            FOREIGN KEY (provider_id) REFERENCES provider_configs(id) ON DELETE CASCADE
        );
        "#,
    )
    .execute(pool)
    .await?;

    let ai_models_columns = sqlx::query("PRAGMA table_info(ai_models)")
        .fetch_all(pool)
        .await?;
    let has_is_manual = ai_models_columns
        .iter()
        .any(|row| row.get::<String, _>("name") == "is_manual");
    if !has_is_manual {
        sqlx::query("ALTER TABLE ai_models ADD COLUMN is_manual INTEGER DEFAULT 0")
            .execute(pool)
            .await?;
    }

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_ai_models_provider
        ON ai_models(provider_id);
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS provider_settings (
            provider_id TEXT PRIMARY KEY,
            filter_free_models INTEGER DEFAULT 0,
            FOREIGN KEY (provider_id) REFERENCES provider_configs(id) ON DELETE CASCADE
        );
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS terminal_tabs (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            task_id TEXT,
            project_id TEXT NOT NULL,
            project_name TEXT NOT NULL,
            mount_name TEXT NOT NULL,
            workspace_path TEXT NOT NULL,
            cwd TEXT NOT NULL,
            title TEXT NOT NULL,
            status TEXT NOT NULL,
            snapshot TEXT NOT NULL DEFAULT '',
            last_command TEXT,
            last_exit_code INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_terminal_tabs_updated_at
        ON terminal_tabs(updated_at DESC);
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_terminal_tabs_task_project
        ON terminal_tabs(task_id, project_id);
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS project_context_states (
            project_id TEXT PRIMARY KEY,
            group_id TEXT,
            focus_project_id TEXT,
            last_plan_id TEXT,
            last_task_id TEXT,
            architect_conversation_id TEXT,
            implement_conversation_id TEXT,
            updated_at TEXT NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await?;

    let project_context_columns = sqlx::query("PRAGMA table_info(project_context_states)")
        .fetch_all(pool)
        .await?;
    let has_project_context_group_id = project_context_columns
        .iter()
        .any(|row| row.get::<String, _>("name") == "group_id");
    let has_focus_project_id = project_context_columns
        .iter()
        .any(|row| row.get::<String, _>("name") == "focus_project_id");
    if !has_project_context_group_id {
        sqlx::query("ALTER TABLE project_context_states ADD COLUMN group_id TEXT")
            .execute(pool)
            .await?;
    }
    if !has_focus_project_id {
        sqlx::query("ALTER TABLE project_context_states ADD COLUMN focus_project_id TEXT")
            .execute(pool)
            .await?;
    }

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS session_context_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            selected_group_id TEXT,
            selected_project_id TEXT,
            mode TEXT,
            updated_at TEXT NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_project_context_state_updated_at
        ON project_context_states(updated_at DESC);
        "#,
    )
    .execute(pool)
    .await?;

    // Insert default providers if they don't exist
    insert_default_providers(pool).await?;

    Ok(())
}

async fn insert_default_providers(pool: &SqlitePool) -> DbResult<()> {
    let default_providers = vec![
        (
            "chatgpt",
            "ChatGPT",
            "chatgpt",
            "https://chatgpt.com/backend-api",
            false,
        ),
        (
            "openai",
            "OpenAI",
            "openai",
            "https://api.openai.com/v1",
            false,
        ),
        (
            "zai",
            "z.ai",
            "openai",
            "https://api.z.ai/api/coding/paas/v4",
            false,
        ),
        (
            "anthropic",
            "Anthropic",
            "anthropic",
            "https://api.anthropic.com/v1",
            false,
        ),
        (
            "openrouter",
            "OpenRouter",
            "openrouter",
            "https://openrouter.ai/api/v1",
            false,
        ),
        (
            "ollama",
            "Ollama",
            "ollama",
            "http://localhost:11434/v1",
            true,
        ),
        (
            "lmstudio",
            "LM Studio",
            "lmstudio",
            "http://localhost:1234/v1",
            true,
        ),
    ];

    for (id, name, provider_type, base_url, is_local) in default_providers {
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT OR IGNORE INTO provider_configs (id, name, provider_type, base_url, is_local, is_enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?)
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
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::app_db_path;
    use std::path::Path;

    #[test]
    fn app_db_path_is_rooted_in_app_data_dir() {
        let app_dir = Path::new("/tmp/macro-app-data");
        assert_eq!(app_db_path(app_dir), app_dir.join("macro.db"));
    }
}
