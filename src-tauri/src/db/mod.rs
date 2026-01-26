use std::path::Path;
use sqlx::SqlitePool;

pub mod schema;

pub use sqlx::SqlitePool as DbPool;

/// Initialize the database connection pool
pub async fn init_db(db_path: &Path) -> crate::core::Result<SqlitePool> {
    // Ensure the database directory exists
    if let Some(parent) = db_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let database_url = format!("sqlite:{}?mode=rwc", db_path.display());
    let pool = SqlitePool::connect(&database_url).await?;

    // Run migrations
    sqlx::query(include_str!("migrations/001_initial.sql"))
        .execute(&pool)
        .await?;

    Ok(pool)
}
