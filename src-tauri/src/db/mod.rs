pub mod models;
pub mod repository;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use std::path::PathBuf;
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

/// Initialize the database connection pool
pub async fn init_db(app_handle: &AppHandle) -> DbResult<SqlitePool> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|_| DbError::AppDataDir)?;
    
    // Create the directory if it doesn't exist
    std::fs::create_dir_all(&app_dir).map_err(|e| DbError::Migration(e.to_string()))?;
    
    let db_path = app_dir.join("macro.db");
    
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

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            token_count INTEGER,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
        "#,
    )
    .execute(pool)
    .await?;

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

    // Insert default providers if they don't exist
    insert_default_providers(pool).await?;

    Ok(())
}

async fn insert_default_providers(pool: &SqlitePool) -> DbResult<()> {
    let default_providers = vec![
        ("openai", "OpenAI", "openai", "https://api.openai.com/v1", false),
        ("zai", "z.ai", "openai", "https://api.z.ai/api/coding/paas/v4", false),
        ("anthropic", "Anthropic", "anthropic", "https://api.anthropic.com/v1", false),
        ("openrouter", "OpenRouter", "openrouter", "https://openrouter.ai/api/v1", false),
        ("ollama", "Ollama", "ollama", "http://localhost:11434/v1", true),
        ("lmstudio", "LM Studio", "lmstudio", "http://localhost:1234/v1", true),
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
