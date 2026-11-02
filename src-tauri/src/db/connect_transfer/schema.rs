use super::*;
use sqlx::{Connection, QueryBuilder, Sqlite};
use tokio::sync::OnceCell;
const MIGRATION: &str = include_str!("../migrations/018_connect_transfer.sql");
const PUBLICATION: &str = include_str!("../migrations/019_connect_publication.sql");
const OBJECTS: &str = "name GLOB 'connect_*' OR tbl_name GLOB 'connect_*' OR name='conversation_portable_archives' OR tbl_name='conversation_portable_archives'";
static EXPECTED: OnceCell<Vec<(String, Option<String>)>> = OnceCell::const_new();
async fn expected() -> DbResult<&'static Vec<(String, Option<String>)>> {
    EXPECTED
        .get_or_try_init(|| async {
            let mut db = SqliteConnection::connect("sqlite::memory:").await?;
            for table in [
                "conversations",
                "chat_admission_owners",
                "e_source_captures",
                "e_source_fields",
                "e_source_fragments",
                "e_source_relations",
                "e_inactive_imports",
                "e_inactive_records",
                "e_inactive_fragments",
                "e_inactive_mapping",
            ] {
                sqlx::query(sqlx::AssertSqlSafe(format!(
                    "CREATE TABLE {table}(id INTEGER PRIMARY KEY)"
                )))
                .execute(&mut db)
                .await?;
            }
            sqlx::raw_sql(MIGRATION).execute(&mut db).await?;
            sqlx::raw_sql(PUBLICATION).execute(&mut db).await?;
            let objects = sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "SELECT name,sql FROM sqlite_master WHERE {OBJECTS} ORDER BY name"
            )))
            .fetch_all(&mut db)
            .await?;
            db.close().await?;
            Ok(objects)
        })
        .await
}
pub(in crate::db) async fn validate_schema(db: &mut SqliteConnection) -> DbResult<()> {
    let objects = expected().await?;
    let mut query = QueryBuilder::<Sqlite>::new(format!(
        "SELECT (SELECT COUNT(*) FROM sqlite_master WHERE {OBJECTS})="
    ));
    query.push_bind(objects.len() as i64);
    for (name, ddl) in objects {
        query
            .push(" AND EXISTS(SELECT 1 FROM sqlite_master WHERE name=")
            .push_bind(name)
            .push(" AND sql IS ")
            .push_bind(ddl)
            .push(")");
    }
    query.push(" AND EXISTS(SELECT 1 FROM schema_migrations WHERE version=18 AND name='018_connect_transfer') AND EXISTS(SELECT 1 FROM schema_migrations WHERE version=19 AND name='019_connect_publication')");
    if query
        .build_query_scalar::<i64>()
        .fetch_one(&mut *db)
        .await?
        != 1
    {
        return Err(DbError::Migration(
            "Incomplete connect transfer schema".into(),
        ));
    }
    let inconsistent:i64=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM connect_transfers t LEFT JOIN chat_admission_owners o ON o.conversation_id=t.source_conversation_id WHERE t.local_role='source' AND t.resolution IS NOT 'aborted' AND (o.conversation_id IS NULL OR o.incarnation<>t.ownership_incarnation OR o.mode NOT IN ('frozen','ceded','restore_hold')))")
        .fetch_one(db).await?;
    if inconsistent != 0 {
        return Err(invalid("connect_transfer_ownership_inconsistent"));
    }
    Ok(())
}
/// Fresh backup reference or synthetic legacy fixture only, never an archive.
pub(crate) async fn remove_reference_schema_in(db: &mut SqliteConnection) -> DbResult<()> {
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'connect_*'",
    )
    .fetch_all(&mut *db)
    .await?;
    for name in names {
        sqlx::query(sqlx::AssertSqlSafe(format!("DROP TRIGGER {name}")))
            .execute(&mut *db)
            .await?;
    }
    sqlx::raw_sql("DROP VIEW IF EXISTS connect_published_assets; DROP TABLE IF EXISTS connect_activation_receipts; DROP TABLE IF EXISTS conversation_portable_archives; DROP TABLE IF EXISTS connect_projection_fragments; DROP TABLE IF EXISTS connect_projection_fields; DROP TABLE IF EXISTS connect_projection_assets; DROP TABLE IF EXISTS connect_projection_citations; DROP TABLE IF EXISTS connect_projection_messages; DROP TABLE IF EXISTS connect_preparations; DROP TABLE connect_raw_chunks; DROP TABLE connect_raw_prefix; DROP TABLE connect_exchanges; DROP TABLE connect_transfers;")
        .execute(db).await?;
    Ok(())
}

/// Only downgrade a fresh, empty backup reference, never application/archive data.
pub(crate) async fn remove_publication_reference_in(db: &mut SqliteConnection) -> DbResult<()> {
    remove_reference_schema_in(db).await?;
    sqlx::raw_sql(MIGRATION).execute(db).await?;
    Ok(())
}
