//! Embedded SQLite uses one schema and transaction implementation in both modes.
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
    Connection, SqlitePool,
};
use std::{path::Path, time::Duration};

/// Initial engine-only schema equivalent to Macro after its migration 042.
/// Macro keeps its migration ledger and must not replay this initializer.
pub const INITIAL_SCHEMA: &str = include_str!("../assets/schema/post042.sql");
pub const SCHEMA_REVISION: &str = "post-042";

fn options() -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .foreign_keys(true)
        .synchronous(SqliteSynchronous::Full)
        .busy_timeout(Duration::from_secs(30))
}
async fn connect(options: SqliteConnectOptions) -> Result<SqlitePool, sqlx::Error> {
    // Keep a connection alive for the entire pool lifetime, including idle runs.
    SqlitePoolOptions::new()
        .min_connections(1)
        .max_connections(4)
        .max_lifetime(None)
        .idle_timeout(None)
        .connect_with(options)
        .await
}
async fn initialize(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let mut connection = pool.acquire().await?;
    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
    let objects: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
            .fetch_one(&mut *tx)
            .await?;
    if objects != 0 {
        return Err(sqlx::Error::Protocol(
            "Standalone engine initialization requires an empty database".into(),
        ));
    }
    sqlx::raw_sql(INITIAL_SCHEMA).execute(&mut *tx).await?;
    sqlx::query("CREATE TABLE argentic_schema_revision (revision TEXT PRIMARY KEY NOT NULL)")
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO argentic_schema_revision VALUES (?)")
        .bind(SCHEMA_REVISION)
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}

/// New, isolated shared-memory SQLite database. Every connection in the pool
/// sees this database; another pool gets a different name and different data.
pub async fn memory() -> Result<SqlitePool, sqlx::Error> {
    // SQLx gives sqlite::memory: a unique URI name shared by this pool's connections.
    let parsed: SqliteConnectOptions = "sqlite::memory:".parse()?;
    let pool = connect(
        parsed
            .foreign_keys(true)
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(Duration::from_secs(30))
            .journal_mode(SqliteJournalMode::Memory),
    )
    .await?;
    initialize(&pool).await?;
    Ok(pool)
}

/// Initialize a new standalone file database. Existing Macro databases are
/// migrated by Macro and attached to Engine explicitly, never initialized here.
pub async fn create_file(path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let pool = connect(
        options()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal),
    )
    .await?;
    initialize(&pool).await?;
    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn memory_pool_shares_connections_and_isolates_instances() {
        let first = memory().await.unwrap();
        let other = memory().await.unwrap();
        let mut writer = first.acquire().await.unwrap();
        let mut reader = first.acquire().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA foreign_keys")
                .fetch_one(&mut *reader)
                .await
                .unwrap(),
            1
        );
        sqlx::query("CREATE TABLE pool_probe(value TEXT)")
            .execute(&mut *writer)
            .await
            .unwrap();
        sqlx::query("INSERT INTO pool_probe VALUES('shared')")
            .execute(&mut *writer)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT value FROM pool_probe")
                .fetch_one(&mut *reader)
                .await
                .unwrap(),
            "shared"
        );
        assert!(
            sqlx::query_scalar::<_, String>("SELECT value FROM pool_probe")
                .fetch_one(&other)
                .await
                .is_err()
        );
        drop(writer);
        drop(reader);
        tokio::task::yield_now().await;
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT value FROM pool_probe")
                .fetch_one(&first)
                .await
                .unwrap(),
            "shared"
        );
        first.close().await;
        other.close().await;
    }
    #[tokio::test]
    async fn file_and_memory_have_identical_engine_objects_and_enforce_foreign_keys() {
        let temp = tempfile::tempdir().unwrap();
        let file = create_file(&temp.path().join("engine.sqlite"))
            .await
            .unwrap();
        let memory = memory().await.unwrap();
        let query = "SELECT type,name,tbl_name,coalesce(sql,'') FROM sqlite_schema WHERE tbl_name LIKE 'engine_flow030_%' OR tbl_name LIKE 'engine_start030_%' ORDER BY type,name";
        let left: Vec<(String, String, String, String)> =
            sqlx::query_as(query).fetch_all(&file).await.unwrap();
        let right = sqlx::query_as::<_, (String, String, String, String)>(query)
            .fetch_all(&memory)
            .await
            .unwrap();
        assert_eq!(left, right);
        for pool in [&file, &memory] {
            assert!(
                sqlx::query("INSERT INTO engine_start030_entries VALUES('delivery','absent')")
                    .execute(pool)
                    .await
                    .is_err()
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("PRAGMA foreign_keys")
                    .fetch_one(pool)
                    .await
                    .unwrap(),
                1
            );
            assert!(initialize(pool).await.is_err());
        }
        file.close().await;
        memory.close().await;
    }
}
