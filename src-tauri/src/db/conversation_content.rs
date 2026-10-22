//! Short SQLite snapshots with numeric admission before any returned strings are fetched.
//! These repository ports do not create captures, change text policy, or expose IPC.
use super::{conversation_management::METADATA_QUERY, models::*, DbError, DbResult};
use sqlx::{sqlite::SqliteRow, Connection, Row, SqliteConnection, SqlitePool};
use std::collections::HashSet;

const LIMIT: usize = 100;
const MAX_BYTES: u64 = 4_194_304;
const PROVENANCE_PREFIX: &str = "chat:assistant-visible-provenance:v1:";
const MIGRATION: &str = include_str!("migrations/013_conversation_content_versions.sql");
const DESCRIPTOR_FIELDS: &[&str] = &["m.id", "m.conversation_id", "m.role", "m.created_at"];
const BODY_FIELDS: &[&str] = &[
    "m.id",
    "m.conversation_id",
    "m.role",
    "m.content",
    "m.created_at",
    "m.completion_reason",
    "m.provider_turn_state_json",
    "m.tool_traces_json",
    "p.value_json",
];
const CONVERSATION_FIELDS: &[&str] = &[
    "id",
    "title",
    "description",
    "scope_mode",
    "task_id",
    "group_id",
    "project_id",
    "provider_id",
    "model_id",
    "reasoning_effort",
    "created_at",
    "updated_at",
    "last_message",
];
fn fail(code: &str) -> DbError {
    DbError::Validation(code.into())
}
fn unavailable(_: sqlx::Error) -> DbError {
    fail("unavailable")
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
fn check_id(id: &str) -> DbResult<()> {
    if !valid_id(id) {
        return Err(fail("validation_failed"));
    }
    Ok(())
}
fn check_token(token: &ConversationContentToken) -> DbResult<()> {
    if token.version != 1
        || token.incarnation.len() != 32
        || token.revision.len() > 19
        || !token
            .incarnation
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
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
fn add(a: u64, b: u64) -> DbResult<u64> {
    a.checked_add(b).ok_or_else(|| fail("resource_limit"))
}
fn text_cost(bytes: u64) -> DbResult<u64> {
    bytes.checked_mul(6).ok_or_else(|| fail("resource_limit"))
}
fn request_size(parts: impl IntoIterator<Item = usize>) -> DbResult<()> {
    let mut size = 0;
    for n in parts {
        size = add(size, n as u64)?;
    }
    if size > MAX_BYTES {
        return Err(fail("resource_limit"));
    }
    Ok(())
}
fn lengths(fields: &[&str]) -> String {
    fields
        .iter()
        .enumerate()
        .map(|(i, f)| format!("COALESCE(length(CAST({f} AS BLOB)),0) AS l{i}"))
        .collect::<Vec<_>>()
        .join(",")
}
fn row_bytes(row: &SqliteRow, fields: usize) -> DbResult<u64> {
    let mut total = 0;
    for i in 0..fields {
        let value: i64 = row.try_get(format!("l{i}").as_str()).map_err(unavailable)?;
        total = add(
            total,
            u64::try_from(value).map_err(|_| fail("resource_limit"))?,
        )?;
    }
    Ok(total)
}

// Build the expected objects with SQLite itself, using the shipped schemas.
// This startup check also rejects a stamp 13 with missing or altered objects.
async fn schema_objects(db: &mut SqliteConnection) -> DbResult<Vec<(String, String)>> {
    Ok(sqlx::query_as("SELECT name, sql FROM sqlite_master WHERE name = 'conversation_content_versions' OR (type = 'trigger' AND name GLOB 'content_versions_*') ORDER BY name")
        .fetch_all(db).await?)
}
pub(super) async fn validate_schema(db: &mut SqliteConnection) -> DbResult<()> {
    let mut reference = SqliteConnection::connect("sqlite::memory:").await?;
    for script in [
        super::MIGRATION_001_SQL,
        include_str!("migrations/007_conversation_management.sql"),
        MIGRATION,
    ] {
        sqlx::raw_sql(script).execute(&mut reference).await?;
    }
    let expected = schema_objects(&mut reference).await?;
    let actual = schema_objects(db).await?;
    reference.close().await?;
    if actual != expected {
        return Err(DbError::Migration(
            "Incomplete conversation content schema".into(),
        ));
    }
    Ok(())
}
pub(crate) async fn remove_reference_schema(db: &SqlitePool) -> DbResult<()> {
    // Only the freshly created reference pool, never an unvalidated archive.
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'content_versions_*'",
    )
    .fetch_all(db)
    .await?;
    for name in names {
        sqlx::query(sqlx::AssertSqlSafe(format!("DROP TRIGGER {name}")))
            .execute(db)
            .await?;
    }
    sqlx::query("DROP TABLE conversation_content_versions")
        .execute(db)
        .await?;
    Ok(())
}
async fn token_in(
    db: &mut SqliteConnection,
    id: &str,
    expected: Option<&ConversationContentToken>,
) -> DbResult<ConversationContentToken> {
    let row = sqlx::query("SELECT CASE WHEN length(v.incarnation) = 32 THEN v.incarnation END AS incarnation, v.revision FROM conversations c LEFT JOIN conversation_content_versions v ON v.conversation_id = c.id WHERE c.id = ?")
        .bind(id).fetch_optional(&mut *db).await.map_err(unavailable)?.ok_or_else(|| fail("not_found"))?;
    let incarnation: Option<String> = row.try_get(0).map_err(unavailable)?;
    let revision: Option<i64> = row.try_get(1).map_err(unavailable)?;
    let token = ConversationContentToken {
        version: 1,
        incarnation: incarnation.ok_or_else(|| fail("unavailable"))?,
        revision: revision.ok_or_else(|| fail("unavailable"))?.to_string(),
    };
    check_token(&token).map_err(|_| fail("unavailable"))?;
    if expected.is_some_and(|value| value != &token) {
        return Err(fail("stale_revision"));
    }
    Ok(token)
}
pub async fn conversation_content_version(
    pool: &SqlitePool,
    id: &str,
) -> DbResult<ConversationContentToken> {
    check_id(id)?;
    let mut tx = pool.begin().await.map_err(unavailable)?;
    let token = token_in(&mut tx, id, None).await?;
    tx.commit().await.map_err(unavailable)?;
    Ok(token)
}
async fn opening(
    db: &mut SqliteConnection,
    id: &str,
    estimate: &mut u64,
) -> DbResult<ConversationContentOpening> {
    let query = format!(
        "SELECT {} FROM conversations WHERE id = ?",
        lengths(CONVERSATION_FIELDS)
    );
    let sizes = sqlx::query(sqlx::AssertSqlSafe(query))
        .bind(id)
        .fetch_one(&mut *db)
        .await
        .map_err(unavailable)?;
    *estimate = add(
        *estimate,
        text_cost(row_bytes(&sizes, CONVERSATION_FIELDS.len())?)?,
    )?;
    let metadata_query = format!("{METADATA_QUERY} WHERE s.conversation_id = ?");
    let query = format!("WITH observed AS ({metadata_query}) SELECT {}, revision, response_revision, read_revision FROM observed", lengths(&["conversation_id", "question_message_id", "preview_message_id"]));
    let sizes = sqlx::query(sqlx::AssertSqlSafe(query))
        .bind(id)
        .fetch_optional(&mut *db)
        .await
        .map_err(unavailable)?
        .ok_or_else(|| fail("unavailable"))?;
    *estimate = add(*estimate, text_cost(row_bytes(&sizes, 3)?)?)?;
    // Decimal integers, field names, bools and object syntax fit the fixed reserve.
    if *estimate > MAX_BYTES {
        return Err(fail("resource_limit"));
    }
    let conversation = super::repository::get_conversation_with_connection(db, id)
        .await
        .map_err(|_| fail("unavailable"))?
        .ok_or_else(|| fail("not_found"))?;
    let row = sqlx::query(sqlx::AssertSqlSafe(metadata_query))
        .bind(id)
        .fetch_one(&mut *db)
        .await
        .map_err(unavailable)?;
    let metadata = ConversationContentMetadata {
        conversation_id: row.try_get("conversation_id").map_err(unavailable)?,
        revision: row
            .try_get::<i64, _>("revision")
            .map_err(unavailable)?
            .to_string(),
        response_revision: row
            .try_get::<i64, _>("response_revision")
            .map_err(unavailable)?
            .to_string(),
        read_revision: row
            .try_get::<i64, _>("read_revision")
            .map_err(unavailable)?
            .to_string(),
        archived: row.try_get::<i64, _>("archived").map_err(unavailable)? != 0,
        pending_tool: row.try_get::<i64, _>("pending_tool").map_err(unavailable)? != 0,
        provider_failed: row
            .try_get::<i64, _>("provider_failed")
            .map_err(unavailable)?
            != 0,
        question_message_id: row.try_get("question_message_id").map_err(unavailable)?,
        preview_message_id: row.try_get("preview_message_id").map_err(unavailable)?,
    };
    let totals: (i64, i64) = sqlx::query_as("SELECT COUNT(*), COALESCE(SUM(role IN ('user','assistant')),0) FROM messages WHERE conversation_id = ?")
        .bind(id).fetch_one(db).await.map_err(unavailable)?;
    Ok(ConversationContentOpening {
        total_raw: totals.0.to_string(),
        total_exportable: totals.1.to_string(),
        conversation,
        metadata,
    })
}
pub async fn conversation_content_metadata(
    pool: &SqlitePool,
    input: &ConversationContentMetadataInput,
) -> DbResult<ConversationContentMetadataPage> {
    check_id(&input.conversation_id)?;
    if input.limit == 0
        || input.limit as usize > LIMIT
        || (input.after.is_some() && input.expected_token.is_none())
    {
        return Err(fail("validation_failed"));
    }
    if let Some(token) = &input.expected_token {
        check_token(token)?;
    }
    if let Some(after) = &input.after {
        check_id(&after.id)?;
    }
    request_size([
        input.conversation_id.len(),
        input.after.as_ref().map_or(0, |a| a.created_at.len()),
        input.after.as_ref().map_or(0, |a| a.id.len()),
        input
            .expected_token
            .as_ref()
            .map_or(0, |t| t.incarnation.len()),
        input
            .expected_token
            .as_ref()
            .map_or(0, |t| t.revision.len()),
    ])?;
    let mut tx = pool.begin().await.map_err(unavailable)?;
    let token = token_in(
        &mut tx,
        &input.conversation_id,
        input.expected_token.as_ref(),
    )
    .await?;
    let mut estimate = 4096;
    let opening = if input.after.is_none() {
        Some(opening(&mut tx, &input.conversation_id, &mut estimate).await?)
    } else {
        None
    };
    if let Some(after) = &input.after {
        let found: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM messages WHERE conversation_id = ? AND id = ? COLLATE BINARY AND created_at = ? COLLATE BINARY)")
            .bind(&input.conversation_id).bind(&after.id).bind(&after.created_at).fetch_one(&mut *tx).await.map_err(unavailable)?;
        if !found {
            return Err(fail("validation_failed"));
        }
    }
    let query = format!("SELECT m.rowid AS message_rowid, {} FROM messages m WHERE m.conversation_id = ? AND (? IS NULL OR m.created_at > ? COLLATE BINARY OR (m.created_at = ? COLLATE BINARY AND m.id > ? COLLATE BINARY)) ORDER BY m.created_at COLLATE BINARY, m.id COLLATE BINARY LIMIT ?", lengths(DESCRIPTOR_FIELDS));
    let after = input.after.as_ref();
    let rows = sqlx::query(sqlx::AssertSqlSafe(query))
        .bind(&input.conversation_id)
        .bind(after.map(|a| a.created_at.as_str()))
        .bind(after.map(|a| a.created_at.as_str()))
        .bind(after.map(|a| a.created_at.as_str()))
        .bind(after.map(|a| a.id.as_str()))
        .bind(input.limit as i64 + 1)
        .fetch_all(&mut *tx)
        .await
        .map_err(unavailable)?;
    let mut admitted = 0;
    let mut payload = estimate;
    for (index, row) in rows.iter().take(input.limit as usize).enumerate() {
        payload = add(
            payload,
            add(2048, text_cost(row_bytes(row, DESCRIPTOR_FIELDS.len())?)?)?,
        )?;
        if payload > MAX_BYTES {
            break;
        }
        let anchor_bytes = add(
            u64::try_from(row.try_get::<i64, _>("l0").map_err(unavailable)?)
                .map_err(|_| fail("resource_limit"))?,
            u64::try_from(row.try_get::<i64, _>("l3").map_err(unavailable)?)
                .map_err(|_| fail("resource_limit"))?,
        )?;
        let candidate = if rows.len() > index + 1 {
            add(payload, text_cost(anchor_bytes)?)?
        } else {
            payload
        };
        if candidate <= MAX_BYTES {
            admitted = index + 1;
            estimate = candidate;
        }
    }
    if admitted == 0 && !rows.is_empty() {
        return Err(fail("resource_limit"));
    }
    let has_more = rows.len() > admitted;
    let mut items = Vec::with_capacity(admitted);
    for row in rows.iter().take(admitted) {
        let rowid: i64 = row.try_get("message_rowid").map_err(unavailable)?;
        let r = sqlx::query(
            "SELECT id, conversation_id, role, created_at FROM messages WHERE rowid = ?",
        )
        .bind(rowid)
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
        items.push(ConversationContentDescriptor {
            id: r.try_get(0).map_err(unavailable)?,
            conversation_id: r.try_get(1).map_err(unavailable)?,
            role: r.try_get(2).map_err(unavailable)?,
            created_at: r.try_get(3).map_err(unavailable)?,
        });
    }
    let next_after = if has_more {
        items.last().map(|d| ConversationContentAnchor {
            id: d.id.clone(),
            created_at: d.created_at.clone(),
        })
    } else {
        None
    };
    tx.commit().await.map_err(unavailable)?;
    Ok(ConversationContentMetadataPage {
        token,
        opening,
        items,
        next_after,
        admission_estimate_bytes: estimate,
    })
}
pub async fn conversation_content_window(
    pool: &SqlitePool,
    input: &ConversationContentWindowInput,
) -> DbResult<ConversationContentWindow> {
    check_id(&input.conversation_id)?;
    check_token(&input.expected_token)?;
    if input.ids.is_empty() || input.ids.len() > LIMIT {
        return Err(fail("validation_failed"));
    }
    let mut seen = HashSet::new();
    for id in &input.ids {
        check_id(id)?;
        if !seen.insert(id) {
            return Err(fail("validation_failed"));
        }
    }
    request_size(input.ids.iter().map(|id| id.len()).chain([
        input.conversation_id.len(),
        input.expected_token.incarnation.len(),
        input.expected_token.revision.len(),
    ]))?;
    let mut tx = pool.begin().await.map_err(unavailable)?;
    let token = token_in(&mut tx, &input.conversation_id, Some(&input.expected_token)).await?;
    let rows = body_sizes(&mut tx, input).await?;
    let admitted = admit_body(&rows)?;
    let estimate = admitted.1;
    let items = fetch_body(&mut tx, &rows[..admitted.0]).await?;
    tx.commit().await.map_err(unavailable)?;
    Ok(ConversationContentWindow {
        token,
        consumed_count: items.len() as u32,
        items,
        admission_estimate_bytes: estimate,
    })
}
async fn body_sizes(
    db: &mut SqliteConnection,
    input: &ConversationContentWindowInput,
) -> DbResult<Vec<SqliteRow>> {
    let query = format!("SELECT CAST(request.key AS INTEGER) AS ordinal, m.rowid AS message_rowid, m.conversation_id = ? AS owned, m.role IN ('user','assistant') AS exported, {} FROM json_each(?) request LEFT JOIN messages m ON m.id = request.value COLLATE BINARY LEFT JOIN app_settings p ON m.role = 'assistant' AND p.key = ? || m.id COLLATE BINARY ORDER BY ordinal", lengths(BODY_FIELDS));
    let ids = serde_json::to_string(&input.ids).map_err(|_| fail("unavailable"))?;
    let rows = sqlx::query(sqlx::AssertSqlSafe(query))
        .bind(&input.conversation_id)
        .bind(ids)
        .bind(PROVENANCE_PREFIX)
        .fetch_all(db)
        .await
        .map_err(unavailable)?;
    if rows.len() != input.ids.len() {
        return Err(fail("unavailable"));
    }
    // Validate the whole requested set before admitting any prefix. Only numeric
    // ownership/role flags and lengths have crossed from SQLite at this point.
    for (ordinal, row) in rows.iter().enumerate() {
        if row
            .try_get::<Option<i64>, _>("message_rowid")
            .map_err(unavailable)?
            .is_none()
            || row
                .try_get::<Option<i64>, _>("owned")
                .map_err(unavailable)?
                != Some(1)
            || row
                .try_get::<Option<i64>, _>("exported")
                .map_err(unavailable)?
                != Some(1)
            || row.try_get::<i64, _>("ordinal").map_err(unavailable)? != ordinal as i64
        {
            return Err(fail("validation_failed"));
        }
    }
    Ok(rows)
}
fn admit_body(rows: &[SqliteRow]) -> DbResult<(usize, u64)> {
    let mut estimate = 4096;
    let mut count = 0;
    for row in rows {
        let next = add(
            estimate,
            add(2048, text_cost(row_bytes(row, BODY_FIELDS.len())?)?)?,
        )?;
        if next > MAX_BYTES {
            break;
        }
        estimate = next;
        count += 1;
    }
    if count == 0 {
        return Err(fail("resource_limit"));
    }
    Ok((count, estimate))
}
async fn fetch_body(
    db: &mut SqliteConnection,
    rows: &[SqliteRow],
) -> DbResult<Vec<ConversationContentItem>> {
    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        let id: i64 = row.try_get("message_rowid").map_err(unavailable)?;
        let r = sqlx::query("SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, m.completion_reason, m.provider_turn_state_json, m.tool_traces_json, p.value_json FROM messages m LEFT JOIN app_settings p ON m.role = 'assistant' AND p.key = ? || m.id COLLATE BINARY WHERE m.rowid = ?")
            .bind(PROVENANCE_PREFIX).bind(id).fetch_one(&mut *db).await.map_err(unavailable)?;
        items.push(ConversationContentItem {
            id: r.try_get(0).map_err(unavailable)?,
            conversation_id: r.try_get(1).map_err(unavailable)?,
            role: r.try_get(2).map_err(unavailable)?,
            content: r.try_get(3).map_err(unavailable)?,
            created_at: r.try_get(4).map_err(unavailable)?,
            completion_reason: r.try_get(5).map_err(unavailable)?,
            provider_turn_state_json: r.try_get(6).map_err(unavailable)?,
            tool_traces_json: r.try_get(7).map_err(unavailable)?,
            provenance_json: r.try_get(8).map_err(unavailable)?,
        });
    }
    Ok(items)
}

#[cfg(test)]
mod tests;
