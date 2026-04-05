pub mod models;
pub mod repository;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use sqlx::Row;
use std::collections::HashSet;
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
    #[error("Validation error: {0}")]
    Validation(String),
    #[error("Migration error: {0}")]
    Migration(String),
}

pub type DbResult<T> = Result<T, DbError>;

const MIGRATION_001_VERSION: i64 = 1;
const MIGRATION_001_NAME: &str = "001_initial";
const MIGRATION_001_SQL: &str = include_str!("migrations/001_initial.sql");

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
async fn create_pool(db_path: &Path) -> DbResult<SqlitePool> {
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

    ensure_schema_migrations_table(pool).await?;

    let user_tables = list_user_tables(pool).await?;
    let applied_migrations = list_applied_migrations(pool).await?;

    if user_tables.is_empty() {
        if !applied_migrations.contains(&MIGRATION_001_VERSION) {
            apply_migration(
                pool,
                MIGRATION_001_VERSION,
                MIGRATION_001_NAME,
                MIGRATION_001_SQL,
            )
            .await?;
        }
    } else if applied_migrations.is_empty() {
        upgrade_legacy_schema_to_baseline(pool).await?;
        stamp_migration(pool, MIGRATION_001_VERSION, MIGRATION_001_NAME).await?;
    }

    // Baseline migration stamping is not enough for additive, idempotent schema updates.
    // Re-run the legacy ensure helpers on every startup so older runtime databases pick up
    // newly added columns and indexes even when schema_migrations is already populated.
    upgrade_legacy_schema_to_baseline(pool).await?;

    // Insert default providers if they don't exist
    insert_default_providers(pool).await?;

    Ok(())
}

async fn ensure_schema_migrations_table(pool: &SqlitePool) -> DbResult<()> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await?;

    Ok(())
}

async fn list_user_tables(pool: &SqlitePool) -> DbResult<Vec<String>> {
    let rows = sqlx::query(
        r#"
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
          AND name <> 'schema_migrations'
        ORDER BY name ASC
        "#,
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| row.get::<String, _>("name"))
        .collect())
}

async fn list_applied_migrations(pool: &SqlitePool) -> DbResult<HashSet<i64>> {
    let rows = sqlx::query("SELECT version FROM schema_migrations")
        .fetch_all(pool)
        .await?;

    Ok(rows
        .into_iter()
        .map(|row| row.get::<i64, _>("version"))
        .collect())
}

async fn apply_migration(pool: &SqlitePool, version: i64, name: &str, sql: &str) -> DbResult<()> {
    for statement in sql.split(';') {
        let statement = statement.trim();
        if statement.is_empty() {
            continue;
        }
        sqlx::query(statement).execute(pool).await?;
    }

    stamp_migration(pool, version, name).await
}

async fn stamp_migration(pool: &SqlitePool, version: i64, name: &str) -> DbResult<()> {
    let applied_at = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        r#"
        INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
        VALUES (?, ?, ?)
        "#,
    )
    .bind(version)
    .bind(name)
    .bind(applied_at)
    .execute(pool)
    .await?;

    Ok(())
}

async fn table_columns(pool: &SqlitePool, table: &str) -> DbResult<HashSet<String>> {
    let pragma = format!("PRAGMA table_info({})", table);
    let rows = sqlx::query(&pragma).fetch_all(pool).await?;

    Ok(rows
        .into_iter()
        .map(|row| row.get::<String, _>("name"))
        .collect())
}

async fn table_exists(pool: &SqlitePool, table: &str) -> DbResult<bool> {
    let count = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(*)
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
        "#,
    )
    .bind(table)
    .fetch_one(pool)
    .await?;

    Ok(count > 0)
}

async fn upgrade_legacy_schema_to_baseline(pool: &SqlitePool) -> DbResult<()> {
    ensure_legacy_conversations(pool).await?;
    ensure_legacy_messages(pool).await?;
    ensure_conversation_compactions(pool).await?;
    ensure_legacy_settings(pool).await?;
    ensure_legacy_git_tables(pool).await?;
    ensure_legacy_provider_configs(pool).await?;
    ensure_legacy_ai_models(pool).await?;
    ensure_legacy_provider_settings(pool).await?;
    ensure_legacy_app_settings(pool).await?;
    ensure_legacy_terminal_tabs(pool).await?;
    ensure_legacy_project_context_states(pool).await?;
    ensure_legacy_session_context_state(pool).await?;

    Ok(())
}

async fn ensure_legacy_conversations(pool: &SqlitePool) -> DbResult<()> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT,
            scope_mode TEXT NOT NULL DEFAULT 'Chat',
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

    let columns = table_columns(pool, "conversations").await?;
    if !columns.contains("description") {
        sqlx::query("ALTER TABLE conversations ADD COLUMN description TEXT")
            .execute(pool)
            .await?;
    }
    if !columns.contains("task_id") {
        sqlx::query("ALTER TABLE conversations ADD COLUMN task_id TEXT")
            .execute(pool)
            .await?;
    }
    if !columns.contains("group_id") {
        sqlx::query("ALTER TABLE conversations ADD COLUMN group_id TEXT")
            .execute(pool)
            .await?;
    }
    if !columns.contains("project_id") {
        sqlx::query("ALTER TABLE conversations ADD COLUMN project_id TEXT")
            .execute(pool)
            .await?;
    }
    let scope_mode_was_added = !columns.contains("scope_mode");
    if scope_mode_was_added {
        sqlx::query("ALTER TABLE conversations ADD COLUMN scope_mode TEXT NOT NULL DEFAULT 'Chat'")
            .execute(pool)
            .await?;
    }
    if !columns.contains("created_at") {
        sqlx::query("ALTER TABLE conversations ADD COLUMN created_at TEXT")
            .execute(pool)
            .await?;
    }
    if !columns.contains("is_pinned") {
        sqlx::query("ALTER TABLE conversations ADD COLUMN is_pinned INTEGER DEFAULT 0")
            .execute(pool)
            .await?;
    }

    sqlx::query(
        r#"
        UPDATE conversations
        SET created_at = COALESCE(NULLIF(TRIM(created_at), ''), updated_at, CURRENT_TIMESTAMP)
        WHERE created_at IS NULL OR TRIM(created_at) = ''
        "#,
    )
    .execute(pool)
    .await?;

    backfill_conversation_scope_mode(pool, scope_mode_was_added).await?;

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_conversations_scope_mode
        ON conversations(scope_mode, updated_at DESC);
        "#,
    )
    .execute(pool)
    .await?;
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

    Ok(())
}

async fn ensure_legacy_messages(pool: &SqlitePool) -> DbResult<()> {
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
            provider_input_items_json TEXT,
            provider_turn_state_json TEXT,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
        "#,
    )
    .execute(pool)
    .await?;

    let columns = table_columns(pool, "messages").await?;
    if !columns.contains("created_at") {
        sqlx::query("ALTER TABLE messages ADD COLUMN created_at TEXT")
            .execute(pool)
            .await?;
    }
    if !columns.contains("token_count") {
        sqlx::query("ALTER TABLE messages ADD COLUMN token_count INTEGER")
            .execute(pool)
            .await?;
    }
    if !columns.contains("tool_traces_json") {
        sqlx::query("ALTER TABLE messages ADD COLUMN tool_traces_json TEXT")
            .execute(pool)
            .await?;
    }
    if !columns.contains("hidden_context") {
        sqlx::query("ALTER TABLE messages ADD COLUMN hidden_context TEXT")
            .execute(pool)
            .await?;
    }
    if !columns.contains("provider_input_items_json") {
        sqlx::query("ALTER TABLE messages ADD COLUMN provider_input_items_json TEXT")
            .execute(pool)
            .await?;
    }
    if !columns.contains("provider_turn_state_json") {
        sqlx::query("ALTER TABLE messages ADD COLUMN provider_turn_state_json TEXT")
            .execute(pool)
            .await?;
    }

    if columns.contains("timestamp") {
        sqlx::query(
            r#"
            UPDATE messages
            SET created_at = COALESCE(NULLIF(TRIM(created_at), ''), timestamp, CURRENT_TIMESTAMP)
            WHERE created_at IS NULL OR TRIM(created_at) = ''
            "#,
        )
        .execute(pool)
        .await?;
    } else {
        sqlx::query(
            r#"
            UPDATE messages
            SET created_at = COALESCE(NULLIF(TRIM(created_at), ''), CURRENT_TIMESTAMP)
            WHERE created_at IS NULL OR TRIM(created_at) = ''
            "#,
        )
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

    Ok(())
}

async fn ensure_conversation_compactions(pool: &SqlitePool) -> DbResult<()> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS conversation_compactions (
            conversation_id TEXT PRIMARY KEY,
            up_to_message_id TEXT NOT NULL,
            summary_text TEXT NOT NULL,
            tool_digest_json TEXT NOT NULL,
            used_source_passage_ids_json TEXT NOT NULL,
            interesting_source_passage_ids_json TEXT NOT NULL,
            estimated_tokens_before INTEGER NOT NULL,
            estimated_tokens_after INTEGER NOT NULL,
            fingerprint TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
        "#,
    )
    .execute(pool)
    .await?;

    let columns = table_columns(pool, "conversation_compactions").await?;
    if !columns.contains("version") {
        sqlx::query("ALTER TABLE conversation_compactions ADD COLUMN version INTEGER DEFAULT 1")
            .execute(pool)
            .await?;
    }

    sqlx::query(
        r#"
        CREATE INDEX IF NOT EXISTS idx_conversation_compactions_updated_at
        ON conversation_compactions(updated_at DESC);
        "#,
    )
    .execute(pool)
    .await?;

    Ok(())
}

async fn ensure_legacy_settings(pool: &SqlitePool) -> DbResult<()> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await?;

    Ok(())
}

async fn ensure_legacy_git_tables(pool: &SqlitePool) -> DbResult<()> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS git_repositories (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            path TEXT NOT NULL,
            default_branch TEXT,
            last_commit TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        UPDATE git_repositories
        SET created_at = COALESCE(NULLIF(TRIM(created_at), ''), CURRENT_TIMESTAMP),
            updated_at = COALESCE(NULLIF(TRIM(updated_at), ''), created_at, CURRENT_TIMESTAMP)
        WHERE created_at IS NULL OR TRIM(created_at) = ''
           OR updated_at IS NULL OR TRIM(updated_at) = ''
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE UNIQUE INDEX IF NOT EXISTS idx_git_repositories_path
        ON git_repositories(path);
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS git_worktrees (
            id TEXT PRIMARY KEY,
            repo_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            worktree_name TEXT NOT NULL,
            path TEXT NOT NULL,
            branch TEXT NOT NULL,
            head_commit TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_used_at TEXT,
            is_active INTEGER DEFAULT 1,
            is_prunable INTEGER DEFAULT 0,
            FOREIGN KEY (repo_id) REFERENCES git_repositories(id) ON DELETE CASCADE
        );
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        UPDATE git_worktrees
        SET created_at = COALESCE(NULLIF(TRIM(created_at), ''), CURRENT_TIMESTAMP),
            updated_at = COALESCE(NULLIF(TRIM(updated_at), ''), created_at, CURRENT_TIMESTAMP)
        WHERE created_at IS NULL OR TRIM(created_at) = ''
           OR updated_at IS NULL OR TRIM(updated_at) = ''
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE UNIQUE INDEX IF NOT EXISTS idx_git_worktrees_path
        ON git_worktrees(path);
        "#,
    )
    .execute(pool)
    .await?;
    sqlx::query(
        r#"
        CREATE UNIQUE INDEX IF NOT EXISTS idx_git_worktrees_task
        ON git_worktrees(repo_id, task_id);
        "#,
    )
    .execute(pool)
    .await?;

    Ok(())
}

async fn ensure_legacy_provider_configs(pool: &SqlitePool) -> DbResult<()> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS provider_configs (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            provider_type TEXT NOT NULL,
            base_url TEXT NOT NULL,
            api_key TEXT,
            has_stored_api_key INTEGER NOT NULL DEFAULT 0,
            is_enabled INTEGER DEFAULT 1,
            is_local INTEGER DEFAULT 0,
            auth_status TEXT,
            auth_source TEXT,
            plan_type TEXT,
            account_label TEXT,
            token_expires_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await?;

    let columns = table_columns(pool, "provider_configs").await?;
    if !columns.contains("created_at") {
        sqlx::query("ALTER TABLE provider_configs ADD COLUMN created_at TEXT")
            .execute(pool)
            .await?;
    }
    if !columns.contains("updated_at") {
        sqlx::query("ALTER TABLE provider_configs ADD COLUMN updated_at TEXT")
            .execute(pool)
            .await?;
    }
    if !columns.contains("api_key") {
        sqlx::query("ALTER TABLE provider_configs ADD COLUMN api_key TEXT")
            .execute(pool)
            .await?;
    }
    let has_stored_api_key = columns.contains("has_stored_api_key");
    if !has_stored_api_key {
        sqlx::query(
            "ALTER TABLE provider_configs ADD COLUMN has_stored_api_key INTEGER NOT NULL DEFAULT 0",
        )
        .execute(pool)
        .await?;
    }
    if !columns.contains("auth_status") {
        sqlx::query("ALTER TABLE provider_configs ADD COLUMN auth_status TEXT")
            .execute(pool)
            .await?;
    }
    if !columns.contains("auth_source") {
        sqlx::query("ALTER TABLE provider_configs ADD COLUMN auth_source TEXT")
            .execute(pool)
            .await?;
    }
    if !columns.contains("plan_type") {
        sqlx::query("ALTER TABLE provider_configs ADD COLUMN plan_type TEXT")
            .execute(pool)
            .await?;
    }
    if !columns.contains("account_label") {
        sqlx::query("ALTER TABLE provider_configs ADD COLUMN account_label TEXT")
            .execute(pool)
            .await?;
    }
    if !columns.contains("token_expires_at") {
        sqlx::query("ALTER TABLE provider_configs ADD COLUMN token_expires_at TEXT")
            .execute(pool)
            .await?;
    }

    if !has_stored_api_key {
        sqlx::query(
            r#"
            UPDATE provider_configs
            SET has_stored_api_key = CASE
                WHEN api_key IS NOT NULL AND TRIM(api_key) <> '' THEN 1
                ELSE 0
            END
            "#,
        )
        .execute(pool)
        .await?;
    }

    sqlx::query(
        r#"
        UPDATE provider_configs
        SET created_at = COALESCE(NULLIF(TRIM(created_at), ''), CURRENT_TIMESTAMP),
            updated_at = COALESCE(NULLIF(TRIM(updated_at), ''), created_at, CURRENT_TIMESTAMP)
        WHERE created_at IS NULL OR TRIM(created_at) = ''
           OR updated_at IS NULL OR TRIM(updated_at) = ''
        "#,
    )
    .execute(pool)
    .await?;

    Ok(())
}

async fn ensure_legacy_ai_models(pool: &SqlitePool) -> DbResult<()> {
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
            reasoning_efforts_json TEXT,
            default_reasoning_effort TEXT,
            context_window_tokens INTEGER,
            is_enabled INTEGER DEFAULT 1,
            is_manual INTEGER DEFAULT 0,
            first_seen_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            FOREIGN KEY (provider_id) REFERENCES provider_configs(id) ON DELETE CASCADE
        );
        "#,
    )
    .execute(pool)
    .await?;

    let columns = table_columns(pool, "ai_models").await?;
    if !columns.contains("first_seen_at") {
        sqlx::query("ALTER TABLE ai_models ADD COLUMN first_seen_at TEXT")
            .execute(pool)
            .await?;
    }
    if !columns.contains("last_seen_at") {
        sqlx::query("ALTER TABLE ai_models ADD COLUMN last_seen_at TEXT")
            .execute(pool)
            .await?;
    }
    if !columns.contains("is_manual") {
        sqlx::query("ALTER TABLE ai_models ADD COLUMN is_manual INTEGER DEFAULT 0")
            .execute(pool)
            .await?;
    }
    if !columns.contains("reasoning_efforts_json") {
        sqlx::query("ALTER TABLE ai_models ADD COLUMN reasoning_efforts_json TEXT")
            .execute(pool)
            .await?;
    }
    if !columns.contains("default_reasoning_effort") {
        sqlx::query("ALTER TABLE ai_models ADD COLUMN default_reasoning_effort TEXT")
            .execute(pool)
            .await?;
    }
    if !columns.contains("context_window_tokens") {
        sqlx::query("ALTER TABLE ai_models ADD COLUMN context_window_tokens INTEGER")
            .execute(pool)
            .await?;
    }

    sqlx::query(
        r#"
        UPDATE ai_models
        SET first_seen_at = COALESCE(NULLIF(TRIM(first_seen_at), ''), CURRENT_TIMESTAMP),
            last_seen_at = COALESCE(NULLIF(TRIM(last_seen_at), ''), first_seen_at, CURRENT_TIMESTAMP)
        WHERE first_seen_at IS NULL OR TRIM(first_seen_at) = ''
           OR last_seen_at IS NULL OR TRIM(last_seen_at) = ''
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

    Ok(())
}

async fn ensure_legacy_provider_settings(pool: &SqlitePool) -> DbResult<()> {
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

    Ok(())
}

async fn ensure_legacy_app_settings(pool: &SqlitePool) -> DbResult<()> {
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

    Ok(())
}

async fn ensure_legacy_terminal_tabs(pool: &SqlitePool) -> DbResult<()> {
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
            prompt_context_json TEXT,
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

    let columns = table_columns(pool, "terminal_tabs").await?;
    if !columns.contains("created_at") {
        sqlx::query("ALTER TABLE terminal_tabs ADD COLUMN created_at TEXT")
            .execute(pool)
            .await?;
    }
    if !columns.contains("updated_at") {
        sqlx::query("ALTER TABLE terminal_tabs ADD COLUMN updated_at TEXT")
            .execute(pool)
            .await?;
    }
    if !columns.contains("prompt_context_json") {
        sqlx::query("ALTER TABLE terminal_tabs ADD COLUMN prompt_context_json TEXT")
            .execute(pool)
            .await?;
    }

    sqlx::query(
        r#"
        UPDATE terminal_tabs
        SET created_at = COALESCE(NULLIF(TRIM(created_at), ''), CURRENT_TIMESTAMP),
            updated_at = COALESCE(NULLIF(TRIM(updated_at), ''), created_at, CURRENT_TIMESTAMP)
        WHERE created_at IS NULL OR TRIM(created_at) = ''
           OR updated_at IS NULL OR TRIM(updated_at) = ''
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

    Ok(())
}

async fn ensure_legacy_project_context_states(pool: &SqlitePool) -> DbResult<()> {
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

    let columns = table_columns(pool, "project_context_states").await?;
    if !columns.contains("updated_at") {
        sqlx::query("ALTER TABLE project_context_states ADD COLUMN updated_at TEXT")
            .execute(pool)
            .await?;
    }
    if !columns.contains("group_id") {
        sqlx::query("ALTER TABLE project_context_states ADD COLUMN group_id TEXT")
            .execute(pool)
            .await?;
    }
    if !columns.contains("focus_project_id") {
        sqlx::query("ALTER TABLE project_context_states ADD COLUMN focus_project_id TEXT")
            .execute(pool)
            .await?;
    }

    sqlx::query(
        r#"
        UPDATE project_context_states
        SET updated_at = COALESCE(NULLIF(TRIM(updated_at), ''), CURRENT_TIMESTAMP)
        WHERE updated_at IS NULL OR TRIM(updated_at) = ''
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

    Ok(())
}

async fn ensure_legacy_session_context_state(pool: &SqlitePool) -> DbResult<()> {
    if !table_exists(pool, "session_context_state").await? {
        sqlx::query(
            r#"
            CREATE TABLE session_context_state (
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
    } else {
        let columns = table_columns(pool, "session_context_state").await?;
        if !columns.contains("updated_at") {
            sqlx::query("ALTER TABLE session_context_state ADD COLUMN updated_at TEXT")
                .execute(pool)
                .await?;
        }

        sqlx::query(
            r#"
            UPDATE session_context_state
            SET updated_at = COALESCE(NULLIF(TRIM(updated_at), ''), CURRENT_TIMESTAMP)
            WHERE updated_at IS NULL OR TRIM(updated_at) = ''
            "#,
        )
        .execute(pool)
        .await?;
    }

    Ok(())
}

async fn backfill_conversation_scope_mode(
    pool: &SqlitePool,
    force_reclassify_all_rows: bool,
) -> DbResult<()> {
    let query = if force_reclassify_all_rows {
        r#"
        UPDATE conversations
        SET scope_mode = CASE
            WHEN task_id IS NOT NULL AND TRIM(task_id) <> '' THEN 'Implement'
            WHEN (group_id IS NOT NULL AND TRIM(group_id) <> '') OR (project_id IS NOT NULL AND TRIM(project_id) <> '') THEN 'Architect'
            ELSE 'Chat'
        END
        "#
    } else {
        r#"
        UPDATE conversations
        SET scope_mode = CASE
            WHEN task_id IS NOT NULL AND TRIM(task_id) <> '' THEN 'Implement'
            WHEN (group_id IS NOT NULL AND TRIM(group_id) <> '') OR (project_id IS NOT NULL AND TRIM(project_id) <> '') THEN 'Architect'
            ELSE 'Chat'
        END
        WHERE scope_mode IS NULL
           OR TRIM(scope_mode) = ''
           OR scope_mode NOT IN ('Chat', 'Architect', 'Implement', 'Debug')
        "#
    };

    sqlx::query(query).execute(pool).await?;

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
            "copilot",
            "GitHub Copilot",
            "copilot",
            "copilot://cli",
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
    use super::{
        app_db_path, apply_migration, create_pool, ensure_schema_migrations_table,
        MIGRATION_001_NAME, MIGRATION_001_SQL, MIGRATION_001_VERSION,
    };
    use sqlx::Row;
    use std::path::Path;
    use tempfile::TempDir;

    async fn create_legacy_conversations_table(pool: &sqlx::SqlitePool, extra_columns: &[&str]) {
        let mut columns = vec![
            "id TEXT PRIMARY KEY".to_string(),
            "title TEXT NOT NULL".to_string(),
            "created_at TEXT NOT NULL".to_string(),
            "updated_at TEXT NOT NULL".to_string(),
            "last_message TEXT".to_string(),
            "message_count INTEGER DEFAULT 0".to_string(),
            "is_pinned INTEGER DEFAULT 0".to_string(),
        ];
        columns.extend(extra_columns.iter().map(|column| (*column).to_string()));

        let statement = format!(
            "CREATE TABLE conversations (\n    {}\n)",
            columns.join(",\n    ")
        );

        sqlx::query(&statement)
            .execute(pool)
            .await
            .expect("create legacy conversations");
    }

    async fn seed_legacy_conversation(pool: &sqlx::SqlitePool, columns: &[&str], values_sql: &str) {
        let mut insert_columns = vec![
            "id",
            "title",
            "created_at",
            "updated_at",
            "message_count",
            "is_pinned",
        ];
        insert_columns.extend(columns.iter().copied());

        let statement = format!(
            "INSERT INTO conversations ({}) VALUES {}",
            insert_columns.join(", "),
            values_sql
        );

        sqlx::query(&statement)
            .execute(pool)
            .await
            .expect("seed legacy conversations");
    }

    async fn assert_conversation_scopes_and_indexes(
        pool: &sqlx::SqlitePool,
        expected_scopes: &[(&str, &str)],
    ) {
        let rows = sqlx::query(
            r#"
            SELECT id, scope_mode
            FROM conversations
            ORDER BY id ASC
            "#,
        )
        .fetch_all(pool)
        .await
        .expect("scope rows");

        let scopes = rows
            .into_iter()
            .map(|row| {
                (
                    row.get::<String, _>("id"),
                    row.get::<String, _>("scope_mode"),
                )
            })
            .collect::<Vec<_>>();

        let expected = expected_scopes
            .iter()
            .map(|(id, scope)| ((*id).to_string(), (*scope).to_string()))
            .collect::<Vec<_>>();

        assert_eq!(scopes, expected);

        let scope_mode_exists = sqlx::query(
            r#"
            SELECT COUNT(*) AS count
            FROM pragma_table_info('conversations')
            WHERE name = 'scope_mode'
            "#,
        )
        .fetch_one(pool)
        .await
        .expect("scope_mode pragma")
        .get::<i64, _>("count");
        assert_eq!(scope_mode_exists, 1);

        let index_names = sqlx::query(
            r#"
            SELECT name
            FROM sqlite_master
            WHERE type = 'index'
              AND name IN (
                'idx_conversations_scope_mode',
                'idx_conversations_project_scope',
                'idx_conversations_group_scope',
                'idx_conversations_task_scope'
              )
            ORDER BY name ASC
            "#,
        )
        .fetch_all(pool)
        .await
        .expect("index lookup")
        .into_iter()
        .map(|row| row.get::<String, _>("name"))
        .collect::<Vec<_>>();

        assert_eq!(
            index_names,
            vec![
                "idx_conversations_group_scope".to_string(),
                "idx_conversations_project_scope".to_string(),
                "idx_conversations_scope_mode".to_string(),
                "idx_conversations_task_scope".to_string(),
            ]
        );
    }

    async fn assert_migration_001_applied(pool: &sqlx::SqlitePool) {
        let row = sqlx::query(
            r#"
            SELECT version, name
            FROM schema_migrations
            WHERE version = 1
            "#,
        )
        .fetch_one(pool)
        .await
        .expect("migration 001 row");

        assert_eq!(row.get::<i64, _>("version"), 1);
        assert_eq!(row.get::<String, _>("name"), "001_initial");
    }

    #[test]
    fn app_db_path_is_rooted_in_app_data_dir() {
        let app_dir = Path::new("/tmp/macro-app-data");
        assert_eq!(app_db_path(app_dir), app_dir.join("macro.db"));
    }

    #[tokio::test]
    async fn create_pool_applies_sql_baseline_to_empty_db() {
        let temp_dir = TempDir::new().expect("temp dir");
        let db_path = temp_dir.path().join("macro.db");
        let pool = create_pool(&db_path).await.expect("db pool");

        let table_names = sqlx::query(
            r#"
            SELECT name
            FROM sqlite_master
            WHERE type = 'table'
              AND name IN (
                'schema_migrations',
                'conversations',
                'messages',
                'settings',
                'git_repositories',
                'git_worktrees',
                'provider_configs',
                'ai_models',
                'provider_settings',
                'app_settings',
                'terminal_tabs',
                'project_context_states',
                'session_context_state'
              )
            ORDER BY name ASC
            "#,
        )
        .fetch_all(&pool)
        .await
        .expect("table lookup")
        .into_iter()
        .map(|row| row.get::<String, _>("name"))
        .collect::<Vec<_>>();

        assert_eq!(
            table_names,
            vec![
                "ai_models".to_string(),
                "app_settings".to_string(),
                "conversations".to_string(),
                "git_repositories".to_string(),
                "git_worktrees".to_string(),
                "messages".to_string(),
                "project_context_states".to_string(),
                "provider_configs".to_string(),
                "provider_settings".to_string(),
                "schema_migrations".to_string(),
                "session_context_state".to_string(),
                "settings".to_string(),
                "terminal_tabs".to_string(),
            ]
        );

        assert_migration_001_applied(&pool).await;
    }

    #[tokio::test]
    async fn create_pool_runs_git_tracking_migrations() {
        let temp_dir = TempDir::new().expect("temp dir");
        let db_path = temp_dir.path().join("macro.db");
        let pool = create_pool(&db_path).await.expect("db pool");

        let table_names = sqlx::query(
            r#"
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name IN ('git_repositories', 'git_worktrees')
            ORDER BY name ASC
            "#,
        )
        .fetch_all(&pool)
        .await
        .expect("table lookup")
        .into_iter()
        .map(|row| row.get::<String, _>("name"))
        .collect::<Vec<_>>();

        assert_eq!(table_names, vec!["git_repositories", "git_worktrees"]);
        assert_migration_001_applied(&pool).await;
    }

    #[tokio::test]
    async fn create_pool_stamps_existing_runtime_schema_without_schema_migrations() {
        let temp_dir = TempDir::new().expect("temp dir");
        let db_path = temp_dir.path().join("macro.db");
        let db_url = format!("sqlite:{}?mode=rwc", db_path.display());
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&db_url)
            .await
            .expect("baseline pool");

        ensure_schema_migrations_table(&pool)
            .await
            .expect("schema migrations table");
        apply_migration(
            &pool,
            MIGRATION_001_VERSION,
            MIGRATION_001_NAME,
            MIGRATION_001_SQL,
        )
        .await
        .expect("apply baseline");

        sqlx::query("DROP TABLE schema_migrations")
            .execute(&pool)
            .await
            .expect("drop schema migrations");

        drop(pool);

        let migrated_pool = create_pool(&db_path).await.expect("migrated pool");
        assert_migration_001_applied(&migrated_pool).await;

        let reapplied_pool = create_pool(&db_path).await.expect("reapplied pool");
        assert_migration_001_applied(&reapplied_pool).await;
    }

    #[tokio::test]
    async fn create_pool_backfills_additive_ai_model_columns_for_already_migrated_db() {
        let temp_dir = TempDir::new().expect("temp dir");
        let db_path = temp_dir.path().join("macro.db");
        let db_url = format!("sqlite:{}?mode=rwc", db_path.display());
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&db_url)
            .await
            .expect("baseline pool");

        ensure_schema_migrations_table(&pool)
            .await
            .expect("schema migrations table");
        apply_migration(
            &pool,
            MIGRATION_001_VERSION,
            MIGRATION_001_NAME,
            MIGRATION_001_SQL,
        )
        .await
        .expect("apply baseline");

        let columns_before = sqlx::query(
            r#"
            SELECT name
            FROM pragma_table_info('ai_models')
            ORDER BY cid ASC
            "#,
        )
        .fetch_all(&pool)
        .await
        .expect("ai_models columns before")
        .into_iter()
        .map(|row| row.get::<String, _>("name"))
        .collect::<Vec<_>>();

        assert!(!columns_before.contains(&"reasoning_efforts_json".to_string()));
        assert!(!columns_before.contains(&"default_reasoning_effort".to_string()));

        drop(pool);

        let migrated_pool = create_pool(&db_path).await.expect("migrated pool");
        let columns_after = sqlx::query(
            r#"
            SELECT name
            FROM pragma_table_info('ai_models')
            ORDER BY cid ASC
            "#,
        )
        .fetch_all(&migrated_pool)
        .await
        .expect("ai_models columns after")
        .into_iter()
        .map(|row| row.get::<String, _>("name"))
        .collect::<Vec<_>>();

        assert!(columns_after.contains(&"reasoning_efforts_json".to_string()));
        assert!(columns_after.contains(&"default_reasoning_effort".to_string()));
    }

    #[tokio::test]
    async fn create_pool_backfills_conversation_scope_mode() {
        let temp_dir = TempDir::new().expect("temp dir");
        let db_path = temp_dir.path().join("macro.db");
        let db_url = format!("sqlite:{}?mode=rwc", db_path.display());
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&db_url)
            .await
            .expect("legacy pool");

        create_legacy_conversations_table(
            &pool,
            &[
                "description TEXT",
                "task_id TEXT",
                "group_id TEXT",
                "project_id TEXT",
            ],
        )
        .await;
        seed_legacy_conversation(
            &pool,
            &["description", "task_id", "group_id", "project_id"],
            r#"(
                'chat-conv', 'Chat', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0, 0, NULL, NULL, NULL, NULL
            ), (
                'architect-conv', 'Architect', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0, 0, NULL, NULL, 'group-1', NULL
            ), (
                'implement-conv', 'Implement', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0, 0, NULL, 'task-1', NULL, 'project-1'
            )"#,
        )
        .await;

        drop(pool);

        let migrated_pool = create_pool(&db_path).await.expect("migrated pool");
        assert_conversation_scopes_and_indexes(
            &migrated_pool,
            &[
                ("architect-conv", "Architect"),
                ("chat-conv", "Chat"),
                ("implement-conv", "Implement"),
            ],
        )
        .await;
    }

    #[tokio::test]
    async fn create_pool_backfills_scope_mode_when_task_id_column_is_missing() {
        let temp_dir = TempDir::new().expect("temp dir");
        let db_path = temp_dir.path().join("macro.db");
        let db_url = format!("sqlite:{}?mode=rwc", db_path.display());
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&db_url)
            .await
            .expect("legacy pool");

        create_legacy_conversations_table(&pool, &["group_id TEXT", "project_id TEXT"]).await;
        seed_legacy_conversation(
            &pool,
            &["group_id", "project_id"],
            r#"(
                'architect-conv', 'Architect', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0, 0, 'group-1', NULL
            ), (
                'chat-conv', 'Chat', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0, 0, NULL, NULL
            )"#,
        )
        .await;

        drop(pool);

        let migrated_pool = create_pool(&db_path).await.expect("migrated pool");
        assert_conversation_scopes_and_indexes(
            &migrated_pool,
            &[("architect-conv", "Architect"), ("chat-conv", "Chat")],
        )
        .await;
    }

    #[tokio::test]
    async fn create_pool_backfills_scope_mode_when_group_id_column_is_missing() {
        let temp_dir = TempDir::new().expect("temp dir");
        let db_path = temp_dir.path().join("macro.db");
        let db_url = format!("sqlite:{}?mode=rwc", db_path.display());
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&db_url)
            .await
            .expect("legacy pool");

        create_legacy_conversations_table(&pool, &["task_id TEXT", "project_id TEXT"]).await;
        seed_legacy_conversation(
            &pool,
            &["task_id", "project_id"],
            r#"(
                'implement-conv', 'Implement', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0, 0, 'task-1', 'project-1'
            ), (
                'architect-conv', 'Architect', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0, 0, NULL, 'project-1'
            )"#,
        )
        .await;

        drop(pool);

        let migrated_pool = create_pool(&db_path).await.expect("migrated pool");
        assert_conversation_scopes_and_indexes(
            &migrated_pool,
            &[
                ("architect-conv", "Architect"),
                ("implement-conv", "Implement"),
            ],
        )
        .await;
    }

    #[tokio::test]
    async fn create_pool_backfills_scope_mode_when_project_id_column_is_missing() {
        let temp_dir = TempDir::new().expect("temp dir");
        let db_path = temp_dir.path().join("macro.db");
        let db_url = format!("sqlite:{}?mode=rwc", db_path.display());
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&db_url)
            .await
            .expect("legacy pool");

        create_legacy_conversations_table(&pool, &["task_id TEXT", "group_id TEXT"]).await;
        seed_legacy_conversation(
            &pool,
            &["task_id", "group_id"],
            r#"(
                'implement-conv', 'Implement', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0, 0, 'task-1', NULL
            ), (
                'architect-conv', 'Architect', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0, 0, NULL, 'group-1'
            )"#,
        )
        .await;

        drop(pool);

        let migrated_pool = create_pool(&db_path).await.expect("migrated pool");
        assert_conversation_scopes_and_indexes(
            &migrated_pool,
            &[
                ("architect-conv", "Architect"),
                ("implement-conv", "Implement"),
            ],
        )
        .await;
    }

    #[tokio::test]
    async fn create_pool_backfills_scope_mode_for_minimal_legacy_conversations_table() {
        let temp_dir = TempDir::new().expect("temp dir");
        let db_path = temp_dir.path().join("macro.db");
        let db_url = format!("sqlite:{}?mode=rwc", db_path.display());
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&db_url)
            .await
            .expect("legacy pool");

        create_legacy_conversations_table(&pool, &[]).await;
        seed_legacy_conversation(
            &pool,
            &[],
            r#"(
                'chat-conv', 'Chat', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0, 0
            )"#,
        )
        .await;

        drop(pool);

        let migrated_pool = create_pool(&db_path).await.expect("migrated pool");
        assert_conversation_scopes_and_indexes(&migrated_pool, &[("chat-conv", "Chat")]).await;
    }

    #[tokio::test]
    async fn create_pool_normalizes_invalid_existing_scope_mode_values() {
        let temp_dir = TempDir::new().expect("temp dir");
        let db_path = temp_dir.path().join("macro.db");
        let db_url = format!("sqlite:{}?mode=rwc", db_path.display());
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&db_url)
            .await
            .expect("legacy pool");

        create_legacy_conversations_table(
            &pool,
            &[
                "scope_mode TEXT",
                "task_id TEXT",
                "group_id TEXT",
                "project_id TEXT",
            ],
        )
        .await;
        seed_legacy_conversation(
            &pool,
            &["scope_mode", "task_id", "group_id", "project_id"],
            r#"(
                'blank-scope', 'Blank', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0, 0, '', NULL, NULL, NULL
            ), (
                'invalid-scope', 'Invalid', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0, 0, 'Weird', NULL, 'group-1', NULL
            ), (
                'debug-scope', 'Debug', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0, 0, 'Debug', NULL, NULL, NULL
            )"#,
        )
        .await;

        drop(pool);

        let migrated_pool = create_pool(&db_path).await.expect("migrated pool");
        assert_conversation_scopes_and_indexes(
            &migrated_pool,
            &[
                ("blank-scope", "Chat"),
                ("debug-scope", "Debug"),
                ("invalid-scope", "Architect"),
            ],
        )
        .await;
    }
}
