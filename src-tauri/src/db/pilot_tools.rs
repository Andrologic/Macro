use serde::Serialize;
use sqlx::{Row, Sqlite, SqlitePool, Transaction};
use thiserror::Error;

const MAX_TRACE_ENTRIES: i64 = 2_000;
const TRACE_QUERY_LIMIT: i64 = MAX_TRACE_ENTRIES + 1;
const MAX_METADATA_BYTES: i64 = 1024 * 1024;
const MAX_DETAIL_BYTES: i64 = 1024 * 1024;
const MAX_TRACE_RECORD_BYTES: i64 = 16 * 1024 * 1024;
const MAX_ID_OR_NAME_BYTES: i64 = 16 * 1024;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PilotToolTraceError {
    #[error("not_found")]
    NotFound,
    #[error("content_unavailable")]
    ContentUnavailable,
    #[error("resource_limit")]
    ResourceLimit,
    #[error("stale_revision")]
    StaleRevision,
    #[error("database_unavailable")]
    Database,
}

impl From<sqlx::Error> for PilotToolTraceError {
    fn from(_: sqlx::Error) -> Self {
        Self::Database
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PilotToolTraceList {
    pub revision: i64,
    pub traces: Vec<PilotToolTraceMetadata>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PilotToolTraceMetadata {
    pub message_id: String,
    pub trace_index: i64,
    pub tool_call_id: String,
    pub tool_name: String,
    pub status: String,
    pub has_detail: bool,
    pub detail_bytes: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PilotToolTraceRead {
    pub revision: i64,
    pub detail: String,
}

pub async fn list_tool_traces(
    pool: &SqlitePool,
    conversation_id: &str,
) -> Result<PilotToolTraceList, PilotToolTraceError> {
    validate_identifier(conversation_id)?;
    let mut transaction = pool.begin().await?;
    let revision = conversation_revision(&mut transaction, conversation_id).await?;
    reject_oversized_trace_json(&mut transaction, conversation_id).await?;
    validate_conversation_trace_shapes(&mut transaction, conversation_id).await?;

    let summary = sqlx::query(
        r#"
        SELECT COUNT(*) AS trace_count,
               COALESCE(SUM(
                   64 + length(CAST(bounded_traces.id AS BLOB))
                     + CASE WHEN bounded_traces.trace_type = 'object'
                            THEN CASE WHEN json_type(bounded_traces.value, '$.tool_call_id') = 'text'
                                      THEN length(CAST(json_extract(bounded_traces.value, '$.tool_call_id') AS BLOB)) ELSE 0 END
                            ELSE 0 END
                     + CASE WHEN bounded_traces.trace_type = 'object'
                            THEN CASE WHEN json_type(bounded_traces.value, '$.tool_name') = 'text'
                                      THEN length(CAST(json_extract(bounded_traces.value, '$.tool_name') AS BLOB)) ELSE 0 END
                            ELSE 0 END
                     + CASE WHEN bounded_traces.trace_type = 'object'
                            THEN CASE WHEN json_type(bounded_traces.value, '$.status') = 'text'
                                      THEN length(CAST(json_extract(bounded_traces.value, '$.status') AS BLOB)) ELSE 0 END
                            ELSE 0 END
               ), 0) AS metadata_bytes,
               COALESCE(MAX(COALESCE(length(CAST(bounded_traces.value AS BLOB)), 0)), 0) AS max_trace_bytes
        FROM (
            SELECT m.id, j.value, j.type AS trace_type
            FROM messages AS m
            JOIN json_each(m.tool_traces_json) AS j
            WHERE m.conversation_id = ?
              AND m.role = 'assistant'
            LIMIT ?
        ) AS bounded_traces
        "#,
    )
    .bind(conversation_id)
    .bind(TRACE_QUERY_LIMIT)
    .fetch_one(&mut *transaction)
    .await?;

    let trace_count: i64 = summary.get("trace_count");
    let metadata_bytes: i64 = summary.get("metadata_bytes");
    let max_trace_bytes: i64 = summary.get("max_trace_bytes");
    if trace_count > MAX_TRACE_ENTRIES
        || metadata_bytes > MAX_METADATA_BYTES
        || max_trace_bytes > MAX_TRACE_RECORD_BYTES
    {
        return Err(PilotToolTraceError::ResourceLimit);
    }

    let rows = sqlx::query(
        r#"
        SELECT m.id AS message_id,
               CAST(j.key AS INTEGER) AS trace_index,
               j.type AS trace_type,
               CASE WHEN j.type = 'object'
                    THEN CASE WHEN json_type(j.value, '$.tool_call_id') = 'text'
                              THEN json_extract(j.value, '$.tool_call_id') END END AS tool_call_id,
               CASE WHEN j.type = 'object'
                    THEN CASE WHEN json_type(j.value, '$.tool_name') = 'text'
                              THEN json_extract(j.value, '$.tool_name') END END AS tool_name,
               CASE WHEN j.type = 'object'
                    THEN CASE WHEN json_type(j.value, '$.status') = 'text'
                              THEN json_extract(j.value, '$.status') END END AS status,
               CASE WHEN j.type = 'object' THEN json_type(j.value, '$.tool_call_id') END AS tool_call_id_type,
               CASE WHEN j.type = 'object' THEN json_type(j.value, '$.tool_name') END AS tool_name_type,
               CASE WHEN j.type = 'object' THEN json_type(j.value, '$.status') END AS status_type,
               CASE WHEN j.type = 'object' THEN json_type(j.value, '$.detail') END AS detail_type,
               CASE WHEN j.type = 'object'
                    THEN CASE WHEN json_type(j.value, '$.detail') = 'text'
                              THEN COALESCE(length(CAST(json_extract(j.value, '$.detail') AS BLOB)), 0) ELSE 0 END
                    ELSE 0 END AS detail_bytes,
               COALESCE(length(CAST(j.value AS BLOB)), 0) AS trace_bytes
        FROM messages AS m
        JOIN json_each(m.tool_traces_json) AS j
        WHERE m.conversation_id = ?
          AND m.role = 'assistant'
        ORDER BY m.created_at ASC, m.id ASC, CAST(j.key AS INTEGER) ASC
        LIMIT ?
        "#,
    )
    .bind(conversation_id)
    .bind(TRACE_QUERY_LIMIT)
    .fetch_all(&mut *transaction)
    .await?;

    if rows.len() as i64 > MAX_TRACE_ENTRIES {
        return Err(PilotToolTraceError::ResourceLimit);
    }

    let mut traces = Vec::with_capacity(rows.len());
    for row in rows {
        let trace_type: String = row.get("trace_type");
        let tool_call_id_type: Option<String> = row.get("tool_call_id_type");
        let tool_name_type: Option<String> = row.get("tool_name_type");
        let status_type: Option<String> = row.get("status_type");
        let detail_type: Option<String> = row.get("detail_type");
        let trace_bytes: i64 = row.get("trace_bytes");
        let detail_bytes: i64 = row.get("detail_bytes");
        if trace_bytes > MAX_TRACE_RECORD_BYTES {
            return Err(PilotToolTraceError::ResourceLimit);
        }
        if trace_type != "object"
            || tool_call_id_type.as_deref() != Some("text")
            || tool_name_type.as_deref() != Some("text")
            || status_type.as_deref() != Some("text")
            || !matches!(detail_type.as_deref(), None | Some("text"))
        {
            return Err(PilotToolTraceError::ContentUnavailable);
        }

        let message_id: String = row.get("message_id");
        let tool_call_id: String = row.get("tool_call_id");
        let tool_name: String = row.get("tool_name");
        let status: String = row.get("status");
        validate_id_or_name(&message_id)?;
        validate_id_or_name(&tool_call_id)?;
        validate_id_or_name(&tool_name)?;
        if !valid_status(&status) || tool_call_id.is_empty() || tool_name.is_empty() {
            return Err(PilotToolTraceError::ContentUnavailable);
        }

        traces.push(PilotToolTraceMetadata {
            message_id,
            trace_index: row.get("trace_index"),
            tool_call_id,
            tool_name,
            status,
            has_detail: detail_type.as_deref() == Some("text") && detail_bytes > 0,
            detail_bytes,
        });
    }

    transaction.rollback().await?;
    Ok(PilotToolTraceList { revision, traces })
}

pub async fn read_tool_trace(
    pool: &SqlitePool,
    conversation_id: &str,
    message_id: &str,
    trace_index: i64,
    expected_revision: i64,
) -> Result<PilotToolTraceRead, PilotToolTraceError> {
    validate_identifier(conversation_id)?;
    validate_identifier(message_id)?;
    if trace_index < 0 {
        return Err(PilotToolTraceError::NotFound);
    }

    let mut transaction = pool.begin().await?;
    let revision = conversation_revision(&mut transaction, conversation_id).await?;
    if revision != expected_revision {
        return Err(PilotToolTraceError::StaleRevision);
    }
    reject_oversized_message_trace_json(&mut transaction, conversation_id, message_id).await?;

    let row = sqlx::query(
        r#"
        SELECT m.role,
               CASE WHEN json_valid(m.tool_traces_json) = 1
                    THEN CASE WHEN json_type(m.tool_traces_json) = 'array' THEN 1 ELSE 0 END
                    ELSE 0 END AS traces_are_array,
               j.type AS trace_type,
               CASE WHEN j.type = 'object' THEN json_type(j.value, '$.tool_call_id') END AS tool_call_id_type,
               CASE WHEN j.type = 'object' THEN json_type(j.value, '$.tool_name') END AS tool_name_type,
               CASE WHEN j.type = 'object' THEN json_type(j.value, '$.status') END AS status_type,
               CASE WHEN j.type = 'object'
                    THEN CASE WHEN json_type(j.value, '$.tool_call_id') = 'text'
                              THEN json_extract(j.value, '$.tool_call_id') END END AS tool_call_id,
               CASE WHEN j.type = 'object'
                    THEN CASE WHEN json_type(j.value, '$.tool_name') = 'text'
                              THEN json_extract(j.value, '$.tool_name') END END AS tool_name,
               CASE WHEN j.type = 'object'
                    THEN CASE WHEN json_type(j.value, '$.status') = 'text'
                              THEN json_extract(j.value, '$.status') END END AS status,
               CASE WHEN j.type = 'object' THEN json_type(j.value, '$.detail') END AS detail_type,
               CASE WHEN j.type = 'object'
                    THEN CASE WHEN json_type(j.value, '$.detail') = 'text'
                              THEN COALESCE(length(CAST(json_extract(j.value, '$.detail') AS BLOB)), 0) ELSE 0 END
                    ELSE 0 END AS detail_bytes,
               CASE WHEN j.type = 'object'
                    THEN CASE WHEN json_type(j.value, '$.detail') = 'text'
                                   AND length(CAST(json_extract(j.value, '$.detail') AS BLOB)) <= ?
                              THEN json_extract(j.value, '$.detail') END
                    ELSE NULL END AS detail,
               COALESCE(length(CAST(j.value AS BLOB)), 0) AS trace_bytes
        FROM messages AS m
        LEFT JOIN json_each(
            CASE WHEN json_valid(m.tool_traces_json) = 1
                 THEN CASE WHEN json_type(m.tool_traces_json) = 'array'
                           THEN m.tool_traces_json ELSE '[]' END
                 ELSE '[]' END
        ) AS j ON CAST(j.key AS INTEGER) = ?
        WHERE m.conversation_id = ? AND m.id = ?
        "#,
    )
    .bind(MAX_DETAIL_BYTES)
    .bind(trace_index)
    .bind(conversation_id)
    .bind(message_id)
    .fetch_optional(&mut *transaction)
    .await?;

    let Some(row) = row else {
        return Err(PilotToolTraceError::NotFound);
    };
    let role: String = row.get("role");
    let traces_are_array: i64 = row.get("traces_are_array");
    let trace_type: Option<String> = row.get("trace_type");
    let detail_type: Option<String> = row.get("detail_type");
    let detail_bytes: i64 = row.get("detail_bytes");
    let trace_bytes: i64 = row.get("trace_bytes");
    if role != "assistant" || traces_are_array != 1 {
        return Err(PilotToolTraceError::ContentUnavailable);
    }
    if trace_type.is_none() {
        return Err(PilotToolTraceError::NotFound);
    }
    if trace_type.as_deref() != Some("object") {
        return Err(PilotToolTraceError::ContentUnavailable);
    }
    if trace_bytes > MAX_TRACE_RECORD_BYTES {
        return Err(PilotToolTraceError::ResourceLimit);
    }
    if detail_bytes > MAX_DETAIL_BYTES {
        return Err(PilotToolTraceError::ResourceLimit);
    }
    if row.get::<Option<String>, _>("tool_call_id_type").as_deref() != Some("text")
        || row.get::<Option<String>, _>("tool_name_type").as_deref() != Some("text")
        || row.get::<Option<String>, _>("status_type").as_deref() != Some("text")
        || !matches!(detail_type.as_deref(), None | Some("text"))
    {
        return Err(PilotToolTraceError::ContentUnavailable);
    }

    let tool_call_id: String = row.get("tool_call_id");
    let tool_name: String = row.get("tool_name");
    let status: String = row.get("status");
    validate_id_or_name(&tool_call_id)?;
    validate_id_or_name(&tool_name)?;
    if tool_call_id.is_empty() || tool_name.is_empty() || !valid_status(&status) {
        return Err(PilotToolTraceError::ContentUnavailable);
    }

    let detail = row
        .try_get::<Option<String>, _>("detail")
        .map_err(|_| PilotToolTraceError::ContentUnavailable)?
        .unwrap_or_default();
    if detail.as_bytes().len() as i64 > MAX_DETAIL_BYTES {
        return Err(PilotToolTraceError::ResourceLimit);
    }
    transaction.rollback().await?;
    Ok(PilotToolTraceRead { revision, detail })
}

async fn conversation_revision(
    transaction: &mut Transaction<'_, Sqlite>,
    conversation_id: &str,
) -> Result<i64, PilotToolTraceError> {
    let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM conversations WHERE id = ?")
        .bind(conversation_id)
        .fetch_one(&mut **transaction)
        .await?;
    if exists == 0 {
        return Err(PilotToolTraceError::NotFound);
    }

    Ok(sqlx::query_scalar(
        "SELECT COALESCE((SELECT revision FROM conversation_tool_trace_revisions WHERE conversation_id = ?), 0)",
    )
    .bind(conversation_id)
    .fetch_one(&mut **transaction)
    .await?)
}

async fn validate_conversation_trace_shapes(
    transaction: &mut Transaction<'_, Sqlite>,
    conversation_id: &str,
) -> Result<(), PilotToolTraceError> {
    let invalid: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM messages
        WHERE conversation_id = ?
          AND tool_traces_json IS NOT NULL
          AND (
              role <> 'assistant'
              OR json_valid(tool_traces_json) <> 1
              OR json_type(CASE WHEN json_valid(tool_traces_json) = 1
                                THEN tool_traces_json ELSE 'null' END) <> 'array'
          )
        "#,
    )
    .bind(conversation_id)
    .fetch_one(&mut **transaction)
    .await?;
    if invalid > 0 {
        return Err(PilotToolTraceError::ContentUnavailable);
    }
    Ok(())
}

async fn reject_oversized_trace_json(
    transaction: &mut Transaction<'_, Sqlite>,
    conversation_id: &str,
) -> Result<(), PilotToolTraceError> {
    let oversized: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM messages
        WHERE conversation_id = ?
          AND tool_traces_json IS NOT NULL
          AND length(CAST(tool_traces_json AS BLOB)) > ?
        "#,
    )
    .bind(conversation_id)
    .bind(MAX_TRACE_RECORD_BYTES)
    .fetch_one(&mut **transaction)
    .await?;
    if oversized > 0 {
        return Err(PilotToolTraceError::ResourceLimit);
    }
    Ok(())
}

async fn reject_oversized_message_trace_json(
    transaction: &mut Transaction<'_, Sqlite>,
    conversation_id: &str,
    message_id: &str,
) -> Result<(), PilotToolTraceError> {
    let oversized: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM messages
        WHERE conversation_id = ?
          AND id = ?
          AND tool_traces_json IS NOT NULL
          AND length(CAST(tool_traces_json AS BLOB)) > ?
        "#,
    )
    .bind(conversation_id)
    .bind(message_id)
    .bind(MAX_TRACE_RECORD_BYTES)
    .fetch_one(&mut **transaction)
    .await?;
    if oversized > 0 {
        return Err(PilotToolTraceError::ResourceLimit);
    }
    Ok(())
}

fn validate_identifier(value: &str) -> Result<(), PilotToolTraceError> {
    if value.is_empty() || value.len() as i64 > MAX_ID_OR_NAME_BYTES {
        return Err(if value.is_empty() {
            PilotToolTraceError::NotFound
        } else {
            PilotToolTraceError::ResourceLimit
        });
    }
    Ok(())
}

fn validate_id_or_name(value: &str) -> Result<(), PilotToolTraceError> {
    if value.len() as i64 > MAX_ID_OR_NAME_BYTES {
        Err(PilotToolTraceError::ResourceLimit)
    } else {
        Ok(())
    }
}

fn valid_status(value: &str) -> bool {
    matches!(value, "running" | "pending_approval" | "denied" | "done")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn test_pool() -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("pool");
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .expect("foreign keys");
        sqlx::query(
            "CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
        )
        .execute(&pool)
        .await
        .expect("conversations");
        sqlx::query(
            "CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, tool_traces_json TEXT, hidden_context TEXT, provider_input_items_json TEXT, provider_turn_state_json TEXT, FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE)",
        )
        .execute(&pool)
        .await
        .expect("messages");
        sqlx::raw_sql(include_str!(
            "migrations/005_pilot_tool_trace_revisions.sql"
        ))
        .execute(&pool)
        .await
        .expect("migration");
        sqlx::query("INSERT INTO conversations VALUES ('c1', 'Test', 'now', 'now')")
            .execute(&pool)
            .await
            .expect("conversation");
        pool
    }

    async fn insert_message(pool: &SqlitePool, id: &str, role: &str, traces: &str) {
        sqlx::query("INSERT INTO messages (id, conversation_id, role, content, created_at, tool_traces_json, hidden_context, provider_input_items_json, provider_turn_state_json) VALUES (?, 'c1', ?, 'visible', 'now', ?, ?, ?, ?)")
            .bind(id)
            .bind(role)
            .bind(traces)
            .bind("hidden")
            .bind("provider input")
            .bind("provider state")
            .execute(pool)
            .await
            .expect("message");
    }

    fn trace(detail: Option<&str>) -> serde_json::Value {
        let mut value = json!({
            "tool_call_id": "call-1",
            "tool_name": "read",
            "status": "done"
        });
        if let Some(detail) = detail {
            value["detail"] = json!(detail);
        }
        value
    }

    #[tokio::test]
    async fn list_does_not_load_unrelated_message_content_or_detail() {
        let pool = test_pool().await;
        insert_message(
            &pool,
            "m1",
            "assistant",
            &json!([trace(Some("small"))]).to_string(),
        )
        .await;
        sqlx::query("UPDATE messages SET content = ?, hidden_context = ?, provider_input_items_json = ?, provider_turn_state_json = ? WHERE id = 'm1'")
            .bind("x".repeat(2 * 1024 * 1024))
            .bind("hidden".repeat(2 * 1024 * 1024))
            .bind("provider".repeat(2 * 1024 * 1024))
            .bind("state".repeat(2 * 1024 * 1024))
            .execute(&pool)
            .await
            .expect("large unrelated fields");

        let result = list_tool_traces(&pool, "c1").await.expect("list");
        assert_eq!(result.traces[0].detail_bytes, 5);
        assert_eq!(result.traces[0].has_detail, true);
    }

    #[tokio::test]
    async fn list_rejects_scalar_traces_and_missing_read_index_without_panicking() {
        for scalar in ["null", "\"word\"", "1", "true", "[]"] {
            let pool = test_pool().await;
            insert_message(&pool, "m1", "assistant", &format!("[{scalar}]")).await;
            assert_eq!(
                list_tool_traces(&pool, "c1").await,
                Err(PilotToolTraceError::ContentUnavailable),
                "scalar trace {scalar}"
            );
        }

        let pool = test_pool().await;
        insert_message(&pool, "m1", "assistant", "[]").await;
        let listed = list_tool_traces(&pool, "c1").await.expect("empty list");
        assert_eq!(
            read_tool_trace(&pool, "c1", "m1", 0, listed.revision).await,
            Err(PilotToolTraceError::NotFound)
        );
    }

    #[tokio::test]
    async fn list_handles_nine_one_megabyte_details_without_returning_them() {
        let pool = test_pool().await;
        let traces: Vec<_> = (0..9)
            .map(|index| {
                let mut item = trace(Some(&"x".repeat(1024 * 1024)));
                item["tool_call_id"] = json!(format!("call-{index}"));
                item
            })
            .collect();
        insert_message(
            &pool,
            "m1",
            "assistant",
            &serde_json::to_string(&traces).unwrap(),
        )
        .await;

        let result = list_tool_traces(&pool, "c1").await.expect("list");
        assert_eq!(result.traces.len(), 9);
        assert!(result
            .traces
            .iter()
            .all(|trace| trace.detail_bytes == 1024 * 1024));
    }

    #[tokio::test]
    async fn list_caps_trace_count_and_rejects_malformed_content() {
        let pool = test_pool().await;
        let traces: Vec<_> = (0..2_001)
            .map(|index| {
                let mut item = trace(None);
                item["tool_call_id"] = json!(format!("call-{index}"));
                item
            })
            .collect();
        insert_message(
            &pool,
            "m1",
            "assistant",
            &serde_json::to_string(&traces).unwrap(),
        )
        .await;
        assert_eq!(
            list_tool_traces(&pool, "c1").await,
            Err(PilotToolTraceError::ResourceLimit)
        );

        let pool = test_pool().await;
        insert_message(
            &pool,
            "m1",
            "assistant",
            "[{\"tool_call_id\":\"call-1\",\"tool_name\":\"read\",\"status\":\"unknown\"}]",
        )
        .await;
        assert_eq!(
            list_tool_traces(&pool, "c1").await,
            Err(PilotToolTraceError::ContentUnavailable)
        );

        let pool = test_pool().await;
        insert_message(
            &pool,
            "m1",
            "assistant",
            "[{\"tool_call_id\":\"call-1\",\"tool_name\":\"read\",\"status\":\"done\",\"detail\":null}]",
        )
        .await;
        assert_eq!(
            list_tool_traces(&pool, "c1").await,
            Err(PilotToolTraceError::ContentUnavailable)
        );
    }

    #[tokio::test]
    async fn metadata_budget_rejects_large_names_before_returning_rows() {
        let pool = test_pool().await;
        let traces: Vec<_> = (0..100).map(|index| json!({
            "tool_call_id": format!("call-{index}"), "tool_name": "x".repeat(16 * 1024), "status": "done"
        })).collect();
        insert_message(
            &pool,
            "m1",
            "assistant",
            &serde_json::to_string(&traces).unwrap(),
        )
        .await;
        assert_eq!(
            list_tool_traces(&pool, "c1").await,
            Err(PilotToolTraceError::ResourceLimit)
        );
    }

    #[tokio::test]
    async fn full_trace_json_limit_is_checked_before_json1() {
        let pool = test_pool().await;
        let oversized = format!(
            "[{{\"tool_call_id\":\"call-1\",\"tool_name\":\"read\",\"status\":\"done\",\"detail\":\"{}\"}}]",
            "x".repeat(MAX_TRACE_RECORD_BYTES as usize)
        );
        insert_message(&pool, "m1", "assistant", &oversized).await;
        assert_eq!(
            list_tool_traces(&pool, "c1").await,
            Err(PilotToolTraceError::ResourceLimit)
        );
        let revision = 1;
        assert_eq!(
            read_tool_trace(&pool, "c1", "m1", 0, revision).await,
            Err(PilotToolTraceError::ResourceLimit)
        );
    }

    #[tokio::test]
    async fn read_enforces_body_limit_and_same_length_edits_change_revision() {
        let pool = test_pool().await;
        insert_message(
            &pool,
            "m1",
            "assistant",
            &json!([trace(Some("abc"))]).to_string(),
        )
        .await;
        let listed = list_tool_traces(&pool, "c1").await.expect("list");
        assert_eq!(
            read_tool_trace(&pool, "c1", "m1", 0, listed.revision)
                .await
                .unwrap()
                .detail,
            "abc"
        );

        sqlx::query("UPDATE messages SET tool_traces_json = ? WHERE id = 'm1'")
            .bind(json!([trace(Some("xyz"))]).to_string())
            .execute(&pool)
            .await
            .expect("same length update");
        assert_eq!(
            read_tool_trace(&pool, "c1", "m1", 0, listed.revision).await,
            Err(PilotToolTraceError::StaleRevision)
        );

        let oversized = "x".repeat(1024 * 1024 + 1);
        sqlx::query("UPDATE messages SET tool_traces_json = ? WHERE id = 'm1'")
            .bind(json!([trace(Some(&oversized))]).to_string())
            .execute(&pool)
            .await
            .expect("oversized update");
        let revision = list_tool_traces(&pool, "c1").await.expect("list").revision;
        assert_eq!(
            read_tool_trace(&pool, "c1", "m1", 0, revision).await,
            Err(PilotToolTraceError::ResourceLimit)
        );
    }

    #[tokio::test]
    async fn reads_do_not_write_revision_bookkeeping() {
        let pool = test_pool().await;
        insert_message(&pool, "m1", "assistant", &json!([trace(None)]).to_string()).await;
        let changes_before: i64 = sqlx::query_scalar("SELECT total_changes()")
            .fetch_one(&pool)
            .await
            .unwrap();
        let listed = list_tool_traces(&pool, "c1").await.unwrap();
        assert_eq!(
            read_tool_trace(&pool, "c1", "m1", 0, listed.revision)
                .await
                .unwrap()
                .detail,
            ""
        );
        let changes_after: i64 = sqlx::query_scalar("SELECT total_changes()")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(changes_before, changes_after);
    }

    #[tokio::test]
    async fn deleting_conversation_with_cascade_does_not_fail_on_revision_trigger() {
        let pool = test_pool().await;
        insert_message(&pool, "m1", "assistant", &json!([trace(None)]).to_string()).await;

        sqlx::query("DELETE FROM conversations WHERE id = 'c1'")
            .execute(&pool)
            .await
            .expect("conversation cascade");

        let messages: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages")
            .fetch_one(&pool)
            .await
            .expect("messages count");
        let revisions: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM conversation_tool_trace_revisions WHERE conversation_id = 'c1'",
        )
        .fetch_one(&pool)
        .await
        .expect("revision count");
        assert_eq!(messages, 0);
        assert_eq!(revisions, 0);
    }

    #[tokio::test]
    async fn moving_message_revises_both_conversation_ids() {
        let pool = test_pool().await;
        sqlx::query("INSERT INTO conversations VALUES ('c2', 'Second', 'now', 'now')")
            .execute(&pool)
            .await
            .expect("second conversation");
        insert_message(&pool, "m1", "assistant", &json!([trace(None)]).to_string()).await;

        sqlx::query("UPDATE messages SET conversation_id = 'c2' WHERE id = 'm1'")
            .execute(&pool)
            .await
            .expect("move message");

        let first_revision: i64 = sqlx::query_scalar(
            "SELECT revision FROM conversation_tool_trace_revisions WHERE conversation_id = 'c1'",
        )
        .fetch_one(&pool)
        .await
        .expect("first revision");
        let second_revision: i64 = sqlx::query_scalar(
            "SELECT revision FROM conversation_tool_trace_revisions WHERE conversation_id = 'c2'",
        )
        .fetch_one(&pool)
        .await
        .expect("second revision");
        assert_eq!(first_revision, 2);
        assert_eq!(second_revision, 1);
    }
}
