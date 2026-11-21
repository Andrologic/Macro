//! Short catalog snapshots. Admission returns only numbers before fetching strings.
use super::{conversation_content::*, models::*, DbError, DbResult};
use sqlx::{Connection, QueryBuilder, Row, Sqlite, SqliteConnection, SqlitePool};
use tokio::sync::OnceCell;

const MIGRATION: &str = include_str!("migrations/014_conversation_catalog_version.sql");
const OBJECTS: &str =
    "name = 'conversation_catalog_version' OR (type = 'trigger' AND name GLOB 'catalog_version_*')";
static EXPECTED: OnceCell<Vec<(String, String)>> = OnceCell::const_new();

async fn expected_objects() -> DbResult<&'static Vec<(String, String)>> {
    EXPECTED
        .get_or_try_init(|| async {
            let mut reference = SqliteConnection::connect("sqlite::memory:").await?;
            sqlx::raw_sql(super::MIGRATION_001_SQL)
                .execute(&mut reference)
                .await?;
            sqlx::raw_sql(MIGRATION).execute(&mut reference).await?;
            let objects = sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "SELECT name, sql FROM sqlite_master WHERE {OBJECTS} ORDER BY name"
            )))
            .fetch_all(&mut reference)
            .await?;
            reference.close().await?;
            Ok(objects)
        })
        .await
}

pub(crate) async fn validate_schema(db: &mut SqliteConnection) -> DbResult<()> {
    let expected = expected_objects().await?;
    // Compare DDL inside SQLite. A corrupted schema's SQL never crosses SQLx.
    let mut query = QueryBuilder::<Sqlite>::new(format!(
        "SELECT (SELECT COUNT(*) FROM sqlite_master WHERE {OBJECTS}) = "
    ));
    query.push_bind(expected.len() as i64);
    for (name, ddl) in expected {
        query
            .push(" AND EXISTS(SELECT 1 FROM sqlite_master WHERE name = ")
            .push_bind(name)
            .push(" AND sql = ")
            .push_bind(ddl)
            .push(")");
    }
    query.push(" AND EXISTS(SELECT 1 FROM schema_migrations WHERE version=14 AND name='014_conversation_catalog_version')");
    let valid: i64 = query.build_query_scalar().fetch_one(&mut *db).await?;
    if valid != 1 {
        return Err(DbError::Migration(
            "Incomplete conversation catalog schema".into(),
        ));
    }
    // Real types and size flags only, including for malformed incarnation values.
    let valid: i64 = sqlx::query_scalar("SELECT CASE WHEN COUNT(*)=1 AND MIN(singleton)=1 AND MIN(typeof(incarnation)='text' AND length(CAST(incarnation AS BLOB))=32 AND incarnation NOT GLOB '*[^0-9a-f]*' AND typeof(revision)='integer' AND revision>=0) THEN 1 ELSE 0 END FROM conversation_catalog_version")
        .fetch_one(&mut *db).await?;
    if valid != 1 {
        return Err(DbError::Migration(
            "Invalid conversation catalog singleton".into(),
        ));
    }
    Ok(())
}

// Only fresh trusted reference pools and synthetic historical fixtures use this.
pub(crate) async fn remove_reference_schema(pool: &SqlitePool) -> DbResult<()> {
    let mut db = pool.acquire().await?;
    remove_reference_schema_in(&mut db).await
}
pub(crate) async fn remove_reference_schema_in(db: &mut SqliteConnection) -> DbResult<()> {
    sqlx::raw_sql("DROP TRIGGER catalog_version_conversations_insert; DROP TRIGGER catalog_version_conversations_update; DROP TRIGGER catalog_version_conversations_delete; DROP TABLE conversation_catalog_version;")
        .execute(db).await?;
    Ok(())
}
fn hex32(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn check_token(token: &ConversationCatalogToken) -> DbResult<()> {
    if token.version != 1
        || !hex32(&token.generation)
        || !hex32(&token.incarnation)
        || token.revision.len() > 19
        || token
            .revision
            .parse::<i64>()
            .ok()
            .filter(|n| *n >= 0)
            .map(|n| n.to_string())
            .as_deref()
            != Some(token.revision.as_str())
    {
        return Err(fail("validation_failed"));
    }
    Ok(())
}
fn check_expected(generation: &str, expected: Option<&ConversationCatalogToken>) -> DbResult<()> {
    if !hex32(generation) {
        return Err(fail("unavailable"));
    }
    if let Some(token) = expected {
        check_token(token)?;
        if token.generation != generation {
            return Err(fail("stale_revision"));
        }
    }
    Ok(())
}
async fn token_in(
    db: &mut SqliteConnection,
    generation: &str,
    expected: Option<&ConversationCatalogToken>,
) -> DbResult<ConversationCatalogToken> {
    validate_schema(db).await.map_err(|_| fail("unavailable"))?;
    let row = sqlx::query(
        "SELECT incarnation, revision FROM conversation_catalog_version WHERE singleton=1",
    )
    .fetch_one(&mut *db)
    .await
    .map_err(unavailable)?;
    let token = ConversationCatalogToken {
        version: 1,
        generation: generation.into(),
        incarnation: row.try_get(0).map_err(unavailable)?,
        revision: row.try_get::<i64, _>(1).map_err(unavailable)?.to_string(),
    };
    check_token(&token).map_err(|_| fail("unavailable"))?;
    if expected.is_some_and(|e| e != &token) {
        return Err(fail("stale_revision"));
    }
    Ok(token)
}
pub async fn conversation_catalog_version(
    pool: &SqlitePool,
    generation: &str,
    input: &ConversationCatalogVersionInput,
) -> DbResult<ConversationCatalogToken> {
    check_expected(generation, input.expected_token.as_ref())?;
    let mut tx = pool.begin().await.map_err(unavailable)?;
    let token = token_in(&mut tx, generation, input.expected_token.as_ref()).await?;
    tx.commit().await.map_err(unavailable)?;
    Ok(token)
}
async fn admit(
    db: &mut SqliteConnection,
    input: &ConversationCatalogPageInput,
) -> DbResult<(Vec<i64>, bool, u64)> {
    let mut predicates: Vec<String> = CONVERSATION_FIELDS
        .iter()
        .map(|field| {
            let nullable = !matches!(
                *field,
                "id" | "title" | "scope_mode" | "created_at" | "updated_at"
            );
            format!(
                "(typeof({field})='text'{} )",
                if nullable {
                    format!(" OR {field} IS NULL")
                } else {
                    String::new()
                }
            )
        })
        .collect();
    for field in ["message_count", "is_pinned"] {
        predicates.push(format!(
            "typeof({field})='integer' AND {field} BETWEEN -2147483648 AND 2147483647"
        ));
    }
    let query = format!("SELECT rowid AS catalog_rowid, {}, CASE WHEN {} THEN 1 ELSE 0 END AS types_valid FROM conversations WHERE (? IS NULL OR id COLLATE BINARY > ?) ORDER BY id COLLATE BINARY ASC LIMIT ?", lengths(CONVERSATION_FIELDS), predicates.join(" AND "));
    let after = input.after.as_ref().map(|a| a.id.as_str());
    let rows = sqlx::query(sqlx::AssertSqlSafe(query))
        .bind(after)
        .bind(after)
        .bind(i64::from(input.limit) + 1)
        .fetch_all(&mut *db)
        .await
        .map_err(unavailable)?;
    // Validate every candidate before any raw conversation field is returned.
    for row in &rows {
        if row.try_get::<i64, _>("types_valid").map_err(unavailable)? != 1 {
            return Err(fail("unavailable"));
        }
    }
    let mut payload = 4096;
    let mut estimate = payload;
    let mut ids = Vec::with_capacity(input.limit as usize);
    for (index, row) in rows.iter().take(input.limit as usize).enumerate() {
        payload = add(
            payload,
            add(2048, text_cost(row_bytes(row, CONVERSATION_FIELDS.len())?)?)?,
        )?;
        let candidate = if rows.len() > index + 1 {
            let anchor = u64::try_from(row.try_get::<i64, _>("l0").map_err(unavailable)?)
                .map_err(|_| fail("resource_limit"))?;
            add(payload, text_cost(anchor)?)?
        } else {
            payload
        };
        if candidate > MAX_BYTES {
            break;
        }
        estimate = candidate;
        ids.push(row.try_get("catalog_rowid").map_err(unavailable)?);
    }
    if ids.is_empty() && !rows.is_empty() {
        return Err(fail("resource_limit"));
    }
    let more = rows.len() > ids.len();
    Ok((ids, more, estimate))
}
async fn fetch(db: &mut SqliteConnection, ids: &[i64]) -> DbResult<Vec<Conversation>> {
    let mut items = Vec::with_capacity(ids.len());
    for rowid in ids {
        let row = sqlx::query("SELECT id, title, description, scope_mode, task_id, group_id, project_id, provider_id, model_id, reasoning_effort, created_at, updated_at, last_message, message_count, is_pinned FROM conversations WHERE rowid = ?")
            .bind(rowid).fetch_one(&mut *db).await.map_err(unavailable)?;
        items
            .push(super::repository::conversation_from_row(&row).map_err(|_| fail("unavailable"))?);
    }
    Ok(items)
}
pub async fn conversation_catalog_page(
    pool: &SqlitePool,
    generation: &str,
    input: &ConversationCatalogPageInput,
) -> DbResult<ConversationCatalogPage> {
    if input.limit == 0
        || input.limit as usize > LIMIT
        || (input.after.is_some() && input.expected_token.is_none())
    {
        return Err(fail("validation_failed"));
    }
    check_expected(generation, input.expected_token.as_ref())?;
    request_size([input.after.as_ref().map_or(0, |a| a.id.len())])?;
    if let Some(after) = &input.after {
        if add(4096, text_cost(after.id.len() as u64)?)? > MAX_BYTES {
            return Err(fail("resource_limit"));
        }
    }
    let mut tx = pool.begin().await.map_err(unavailable)?;
    let token = token_in(&mut tx, generation, input.expected_token.as_ref()).await?;
    let total_raw = if input.after.is_none() {
        Some(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM conversations")
                .fetch_one(&mut *tx)
                .await
                .map_err(unavailable)?
                .to_string(),
        )
    } else {
        None
    };
    if let Some(after) = &input.after {
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM conversations WHERE typeof(id)='text' AND id = ? COLLATE BINARY)").bind(&after.id).fetch_one(&mut *tx).await.map_err(unavailable)?;
        if !exists {
            return Err(fail("validation_failed"));
        }
    }
    let (ids, more, admission_estimate_bytes) = admit(&mut tx, input).await?;
    let items = fetch(&mut tx, &ids).await?;
    let next_after = if more {
        items
            .last()
            .map(|c| ConversationCatalogAnchor { id: c.id.clone() })
    } else {
        None
    };
    tx.commit().await.map_err(unavailable)?;
    Ok(ConversationCatalogPage {
        token,
        total_raw,
        items,
        next_after,
        admission_estimate_bytes,
    })
}
#[cfg(test)]
mod tests;
