use super::super::{DbError, DbResult};
use sqlx::{Connection, QueryBuilder, Row, Sqlite, SqliteConnection};
use tokio::sync::OnceCell;

const MIGRATION: &str = include_str!("../migrations/016_source_capture.sql");
const OBJECTS: &str = "name GLOB 'e_source_*' OR tbl_name GLOB 'e_source_*'";
const FAMILIES: &[&str] = &[
    "conversation_compactions",
    "conversation_citations",
    "conversation_toolbox_state",
    "pilot_message_attachments",
    "pilot_file_sends",
];
static EXPECTED: OnceCell<Vec<(String, Option<String>)>> = OnceCell::const_new();
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(super) struct Version {
    pub incarnation: String,
    pub revision: i64,
}
fn corrupt() -> DbError {
    DbError::Migration("Incomplete source capture schema".into())
}
async fn expected() -> DbResult<&'static Vec<(String, Option<String>)>> {
    EXPECTED
        .get_or_try_init(|| async {
            let mut db = SqliteConnection::connect("sqlite::memory:").await?;
            // Version triggers observe only table mutations, no source column names.
            for table in FAMILIES {
                sqlx::query(sqlx::AssertSqlSafe(format!(
                    "CREATE TABLE {table}(dummy INTEGER)"
                )))
                .execute(&mut db)
                .await?;
            }
            sqlx::raw_sql(MIGRATION).execute(&mut db).await?;
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
pub(crate) async fn validate_schema(db: &mut SqliteConnection) -> DbResult<()> {
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
    query.push(" AND EXISTS(SELECT 1 FROM schema_migrations WHERE version=16 AND name='016_source_capture')");
    if query
        .build_query_scalar::<i64>()
        .fetch_one(&mut *db)
        .await?
        != 1
    {
        return Err(corrupt());
    }
    token(db).await?;
    Ok(())
}
pub(super) async fn token(db: &mut SqliteConnection) -> DbResult<Version> {
    // SQL flags prevent malformed long values crossing the native boundary.
    let row=sqlx::query("SELECT COUNT(*) AS n, (SELECT COUNT(*) FROM e_source_version) AS total, CASE WHEN typeof(incarnation)='text' AND length(CAST(incarnation AS BLOB))=32 AND incarnation NOT GLOB '*[^0-9a-f]*' THEN incarnation END AS incarnation, CASE WHEN typeof(revision)='integer' AND revision>=0 THEN revision END AS revision FROM e_source_version WHERE singleton=1")
        .fetch_one(db).await?;
    if row.try_get::<i64, _>("n")? != 1 || row.try_get::<i64, _>("total")? != 1 {
        return Err(corrupt());
    }
    Ok(Version {
        incarnation: row
            .try_get::<Option<String>, _>("incarnation")?
            .ok_or_else(corrupt)?,
        revision: row
            .try_get::<Option<i64>, _>("revision")?
            .ok_or_else(corrupt)?,
    })
}
