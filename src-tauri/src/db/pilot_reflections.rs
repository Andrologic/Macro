//! Minimal presentation source for the authenticated Pilot reflection host.
use super::DbResult;
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

const SOURCE_MAX_BYTES: i64 = 1024 * 1024;
const METADATA_MAX_BYTES: i64 = 64 * 1024;
const METADATA_FIXED_BYTES: i64 = 512;
const MAX_TOOL_ANCHORS: usize = 128;
const MAX_ANCHOR_STRING_BYTES: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum PilotReflectionToolStatus {
    Running,
    PendingApproval,
    Denied,
    Done,
}

/// Only fields that select the renderer's structured branch and its anchors.
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
pub struct PilotReflectionToolAnchor {
    pub tool_call_id: String,
    pub tool_name: String,
    pub status: PilotReflectionToolStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub visible_offset: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
pub struct PilotReflectionMessage {
    pub id: String,
    pub conversation_id: String,
    pub turn_id: Option<String>,
    pub conversation_scope_mode: String,
    pub conversation_task_id: Option<String>,
    pub role: String,
    /// Raw persisted content, before questionnaire presentation or trimming.
    pub content: String,
    pub has_hidden_context: bool,
    pub tool_traces: Vec<PilotReflectionToolAnchor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum PilotReflectionMessageRead {
    Ready { message: PilotReflectionMessage },
    Unavailable { message: Option<()> },
    TooLarge { message: Option<()> },
    Withheld { message: Option<()> },
}

// Check byte lengths before fetching any source strings. The stored tool JSON
// also has a scan budget; it is never returned or deserialized in Rust.
const SOURCE_SIZE_SQL: &str = r#"
SELECT octet_length(m.id) + octet_length(m.conversation_id)
       + COALESCE(octet_length(m.turn_id), 0)
       + octet_length(c.scope_mode)
       + COALESCE(octet_length(c.task_id), 0) AS metadata_bytes,
       octet_length(m.content) AS source_bytes,
       COALESCE(octet_length(m.tool_traces_json), 0) AS tool_scan_bytes
FROM messages AS m JOIN conversations AS c ON c.id = m.conversation_id
WHERE m.conversation_id = ? AND m.id = ? AND m.role = 'assistant'
"#;

const TOOL_ANCHORS_SQL: &str = r#"
SELECT json_object(
    'tool_call_id', json_extract(t.value, '$.tool_call_id'),
    'tool_name', json_extract(t.value, '$.tool_name'),
    'status', json_extract(t.value, '$.status'),
    'visible_offset', json(t.value -> '$.visible_offset')
) AS anchor_json
FROM messages AS m,
     json_each(CASE WHEN json_valid(m.tool_traces_json)
                    THEN CASE WHEN json_type(m.tool_traces_json) = 'array'
                              THEN m.tool_traces_json ELSE '[]' END
                    ELSE '[]' END) AS t
WHERE m.conversation_id = ? AND m.id = ? AND m.role = 'assistant'
  AND t.type = 'object'
  AND json_type(t.value, '$.tool_call_id') = 'text'
  AND json_type(t.value, '$.tool_name') = 'text'
  AND json_extract(t.value, '$.status') IN ('running', 'pending_approval', 'denied', 'done')
ORDER BY CAST(t.key AS INTEGER)
LIMIT 129
"#;

// JSON.parse uses the last duplicate key; SQLite json_extract uses the first.
// Retain ambiguous relevant keys rather than silently changing the anchors.
const TOOL_AMBIGUITY_SQL: &str = r#"
SELECT EXISTS(
    SELECT 1 FROM messages AS m,
         json_each(CASE WHEN json_valid(m.tool_traces_json)
                        THEN CASE WHEN json_type(m.tool_traces_json) = 'array'
                                  THEN m.tool_traces_json ELSE '[]' END
                        ELSE '[]' END) AS t,
         json_each(CASE WHEN t.type = 'object' THEN t.value ELSE '{}' END) AS field
    WHERE m.conversation_id = ? AND m.id = ? AND m.role = 'assistant'
      AND field.key IN ('tool_call_id', 'tool_name', 'status', 'visible_offset')
    GROUP BY t.key, field.key HAVING COUNT(*) > 1
)
"#;

// Size this exact minimal JSON in the same transaction before fetching anchors.
const TOOL_ANCHOR_SIZE_SQL: &str = r#"
SELECT COALESCE(SUM(octet_length(anchor_json)), 0) AS anchor_bytes,
       COUNT(*) AS anchor_count
FROM (
"#;

const SOURCE_SELECT_SQL: &str = r#"
SELECT m.id, m.conversation_id, m.turn_id, m.role, m.content,
       c.scope_mode AS conversation_scope_mode, c.task_id AS conversation_task_id,
       COALESCE(octet_length(m.hidden_context), 0) > 0 AS has_hidden_context
FROM messages AS m JOIN conversations AS c ON c.id = m.conversation_id
WHERE m.conversation_id = ? AND m.id = ? AND m.role = 'assistant'
"#;

fn source_sizes_within_limits(
    source: i64,
    scan: i64,
    metadata: i64,
    anchors: i64,
    count: i64,
) -> bool {
    (0..=SOURCE_MAX_BYTES).contains(&source)
        && (0..=SOURCE_MAX_BYTES).contains(&scan)
        && (0..=METADATA_MAX_BYTES).contains(&metadata)
        && (0..=METADATA_MAX_BYTES).contains(&anchors)
        // Six bytes per identity byte covers JSON escaping; anchors are already JSON.
        && METADATA_FIXED_BYTES + 6 * metadata + anchors <= METADATA_MAX_BYTES
        && (0..=MAX_TOOL_ANCHORS as i64).contains(&count)
}

fn anchor_fields_within_limits(call_id: &str, tool_name: &str, offset: Option<f64>) -> bool {
    call_id.len() <= MAX_ANCHOR_STRING_BYTES
        && tool_name.len() <= MAX_ANCHOR_STRING_BYTES
        && offset.is_none_or(f64::is_finite)
}

fn decode_anchor(raw: &str) -> Result<PilotReflectionToolAnchor, ()> {
    let anchor: PilotReflectionToolAnchor = serde_json::from_str(raw).map_err(|_| ())?;
    if !anchor_fields_within_limits(
        &anchor.tool_call_id,
        &anchor.tool_name,
        anchor.visible_offset,
    ) {
        return Err(());
    }
    Ok(anchor)
}

/// Association, byte preflight, anchor selection and content share one snapshot.
/// Authorization and the working-memory reservation are the host's responsibility.
pub async fn get_pilot_reflection_message(
    pool: &SqlitePool,
    conversation_id: &str,
    message_id: &str,
) -> DbResult<PilotReflectionMessageRead> {
    if conversation_id.is_empty() || message_id.is_empty() {
        return Ok(PilotReflectionMessageRead::Unavailable { message: None });
    }
    let mut tx = pool.begin().await?;
    // Column octet_length uses SQLite record metadata instead of materializing
    // over-limit text or hidden context. UTF-8 is required for exact wire budgets.
    let encoding: String = sqlx::query_scalar("PRAGMA encoding")
        .fetch_one(&mut *tx)
        .await?;
    if encoding != "UTF-8" {
        return Ok(PilotReflectionMessageRead::Withheld { message: None });
    }
    let Some(size) = sqlx::query(SOURCE_SIZE_SQL)
        .bind(conversation_id)
        .bind(message_id)
        .fetch_optional(&mut *tx)
        .await?
    else {
        return Ok(PilotReflectionMessageRead::Unavailable { message: None });
    };
    let source_bytes: i64 = size.try_get("source_bytes")?;
    let tool_scan_bytes: i64 = size.try_get("tool_scan_bytes")?;
    let metadata_bytes: i64 = size.try_get("metadata_bytes")?;
    if !source_sizes_within_limits(source_bytes, tool_scan_bytes, metadata_bytes, 0, 0) {
        return Ok(PilotReflectionMessageRead::TooLarge { message: None });
    }
    let ambiguous: i64 = sqlx::query_scalar(TOOL_AMBIGUITY_SQL)
        .bind(conversation_id)
        .bind(message_id)
        .fetch_one(&mut *tx)
        .await?;
    if ambiguous != 0 {
        return Ok(PilotReflectionMessageRead::Withheld { message: None });
    }
    let mut anchor_size_sql = sqlx::QueryBuilder::<sqlx::Sqlite>::new(TOOL_ANCHOR_SIZE_SQL);
    anchor_size_sql.push(TOOL_ANCHORS_SQL).push(")");
    let size = anchor_size_sql
        .build()
        .bind(conversation_id)
        .bind(message_id)
        .fetch_one(&mut *tx)
        .await?;
    let anchor_bytes: i64 = size.try_get("anchor_bytes")?;
    let anchor_count: i64 = size.try_get("anchor_count")?;
    if !source_sizes_within_limits(
        source_bytes,
        tool_scan_bytes,
        metadata_bytes,
        anchor_bytes,
        anchor_count,
    ) {
        return Ok(PilotReflectionMessageRead::TooLarge { message: None });
    }
    let mut tool_traces = Vec::with_capacity(anchor_count as usize);
    for row in sqlx::query(TOOL_ANCHORS_SQL)
        .bind(conversation_id)
        .bind(message_id)
        .fetch_all(&mut *tx)
        .await?
    {
        let raw: String = row.try_get("anchor_json")?;
        let Ok(anchor) = decode_anchor(&raw) else {
            return Ok(PilotReflectionMessageRead::Withheld { message: None });
        };
        tool_traces.push(anchor);
    }
    let row = sqlx::query(SOURCE_SELECT_SQL)
        .bind(conversation_id)
        .bind(message_id)
        .fetch_one(&mut *tx)
        .await?;
    let message = PilotReflectionMessage {
        id: row.try_get("id")?,
        conversation_id: row.try_get("conversation_id")?,
        turn_id: row.try_get("turn_id")?,
        conversation_scope_mode: row.try_get("conversation_scope_mode")?,
        conversation_task_id: row.try_get("conversation_task_id")?,
        role: row.try_get("role")?,
        content: row.try_get("content")?,
        has_hidden_context: row.try_get::<i64, _>("has_hidden_context")? != 0,
        tool_traces,
    };
    tx.commit().await?;
    Ok(PilotReflectionMessageRead::Ready { message })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_byte_budget_helpers_include_boundaries_and_reject_overflow() {
        assert!(source_sizes_within_limits(
            SOURCE_MAX_BYTES,
            SOURCE_MAX_BYTES,
            0,
            METADATA_MAX_BYTES - METADATA_FIXED_BYTES,
            MAX_TOOL_ANCHORS as i64
        ));
        assert!(!source_sizes_within_limits(
            SOURCE_MAX_BYTES + 1,
            0,
            0,
            0,
            0
        ));
        assert!(!source_sizes_within_limits(
            0,
            SOURCE_MAX_BYTES + 1,
            0,
            0,
            0
        ));
        assert!(!source_sizes_within_limits(0, 0, 1, METADATA_MAX_BYTES, 0));
        assert!(!source_sizes_within_limits(
            0,
            0,
            0,
            0,
            MAX_TOOL_ANCHORS as i64 + 1
        ));
        assert!(!source_sizes_within_limits(-1, 0, 0, 0, 0));
        assert!(!anchor_fields_within_limits("call", "read", Some(f64::NAN)));
        assert!(!anchor_fields_within_limits(
            "call",
            "read",
            Some(f64::INFINITY)
        ));
        assert!(anchor_fields_within_limits("call", "read", Some(-3.5)));
        assert!(anchor_fields_within_limits(
            "call",
            &"é".repeat(MAX_ANCHOR_STRING_BYTES / 2),
            None
        ));
        assert!(!anchor_fields_within_limits(
            "call",
            &"é".repeat(MAX_ANCHOR_STRING_BYTES / 2 + 1),
            None
        ));
        assert!(!anchor_fields_within_limits(
            &"a".repeat(MAX_ANCHOR_STRING_BYTES + 1),
            "read",
            None
        ));
    }

    #[test]
    fn anchor_decoder_rejects_ambiguous_offsets_and_bounds_utf8() {
        assert!(
            decode_anchor(r#"{"tool_call_id":"call","tool_name":"read","status":"done"}"#).is_ok()
        );
        assert!(decode_anchor(
            r#"{"tool_call_id":"call","tool_name":"read","status":"done","visible_offset":"3"}"#
        )
        .is_err());
        assert!(decode_anchor(
            r#"{"tool_call_id":"call","tool_name":"read","status":"done","visible_offset":null}"#
        )
        .unwrap()
        .visible_offset
        .is_none());
        for offset in ["true", "false", "{}", "[]", "1e999"] {
            let raw = format!(
                r#"{{"tool_call_id":"call","tool_name":"read","status":"done","visible_offset":{offset}}}"#
            );
            assert!(decode_anchor(&raw).is_err());
        }
        let name = "é".repeat(MAX_ANCHOR_STRING_BYTES / 2);
        let raw = serde_json::json!({"tool_call_id":"call", "tool_name":name, "status":"done", "visible_offset":2});
        assert!(decode_anchor(&raw.to_string()).is_ok());
        let raw = serde_json::json!({"tool_call_id":"call", "tool_name":format!("{name}é"), "status":"done"});
        assert!(decode_anchor(&raw.to_string()).is_err());
    }

    #[tokio::test]
    async fn reader_associates_assistant_and_exports_only_presentation() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE conversations (id TEXT PRIMARY KEY, scope_mode TEXT NOT NULL, task_id TEXT)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO conversations VALUES ('chat', 'Chat', NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, turn_id TEXT, role TEXT, content TEXT, hidden_context TEXT, tool_traces_json TEXT)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO messages VALUES ('assistant', 'chat', 'turn', 'assistant', '<think>é</think>', 'private', ?), ('user', 'chat', 'turn', 'user', '<think>no</think>', NULL, NULL)")
            .bind(r#"[{"tool_call_id":"call","tool_name":"read","status":"done","visible_offset":0,"arguments":{"secret":"excluded"},"result":"excluded"}]"#)
            .execute(&pool).await.unwrap();
        assert!(matches!(
            get_pilot_reflection_message(&pool, "other", "assistant")
                .await
                .unwrap(),
            PilotReflectionMessageRead::Unavailable { .. }
        ));
        assert!(matches!(
            get_pilot_reflection_message(&pool, "chat", "user")
                .await
                .unwrap(),
            PilotReflectionMessageRead::Unavailable { .. }
        ));
        let read = get_pilot_reflection_message(&pool, "chat", "assistant")
            .await
            .unwrap();
        let PilotReflectionMessageRead::Ready { message } = read else {
            panic!("ready")
        };
        assert_eq!(message.turn_id.as_deref(), Some("turn"));
        assert_eq!(message.conversation_scope_mode, "Chat");
        assert_eq!(message.conversation_task_id, None);
        assert_eq!(message.content, "<think>é</think>");
        assert!(message.has_hidden_context);
        assert_eq!(message.tool_traces.len(), 1);
        let json = serde_json::to_string(&message).unwrap();
        assert!(
            !json.contains("private") && !json.contains("excluded") && !json.contains("arguments")
        );
        sqlx::query("UPDATE messages SET content = ? WHERE id = 'assistant'")
            .bind("é".repeat(SOURCE_MAX_BYTES as usize / 2 + 1))
            .execute(&pool)
            .await
            .unwrap();
        assert!(matches!(
            get_pilot_reflection_message(&pool, "chat", "assistant")
                .await
                .unwrap(),
            PilotReflectionMessageRead::TooLarge { .. }
        ));
    }
}
