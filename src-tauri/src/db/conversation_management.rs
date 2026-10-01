//! Shared Chat metadata and atomic action receipts. No transcript or provider
//! payload is stored in these tables. Transport authority stays at the host.
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
pub struct ConversationMetadata {
    pub conversation_id: String,
    pub revision: i64,
    pub archived: bool,
    pub response_revision: i64,
    pub read_revision: i64,
    pub pending_tool: bool,
    pub provider_failed: bool,
    pub question_message_id: Option<String>,
    pub preview_message_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
pub struct ConversationActionInput {
    pub receipt_key: String,
    pub digest: String,
    pub action: String,
    pub conversation_id: String,
    pub expected_revision: Option<i64>,
    pub title: Option<String>,
    pub project_id: Option<String>,
    pub execute_before: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
pub struct ConversationActionResult {
    pub outcome: String,
    pub conversation_id: String,
    pub revision: i64,
}
fn db(_: sqlx::Error) -> String {
    "unavailable".into()
}
fn guard(deadline: &str) -> Result<(), String> {
    let expires =
        chrono::DateTime::parse_from_rfc3339(deadline).map_err(|_| "validation_failed")?;
    if expires <= chrono::Utc::now() {
        return Err("unavailable".into());
    }
    Ok(())
}
pub async fn metadata(pool: &SqlitePool) -> Result<Vec<ConversationMetadata>, String> {
    let rows = sqlx::query("SELECT s.conversation_id, s.revision, s.archived, COALESCE((SELECT MAX(revision) FROM conversation_response_versions v WHERE v.conversation_id = s.conversation_id),0) AS response_revision, s.read_revision,
 EXISTS(SELECT 1 FROM messages m, json_each(CASE WHEN json_valid(m.tool_traces_json) THEN m.tool_traces_json ELSE '[]' END) trace
 WHERE m.conversation_id = s.conversation_id AND m.role = 'assistant' AND m.completion_reason IS NOT 'provider_error' AND CASE WHEN trace.type = 'object' THEN json_extract(trace.value, '$.status') END = 'pending_approval'
 AND CASE WHEN trace.type = 'object' THEN json_type(trace.value, '$.tool_call_id') END = 'text'
 AND CASE WHEN trace.type = 'object' THEN json_type(trace.value, '$.tool_name') END = 'text') AS pending_tool,
 EXISTS(SELECT 1 FROM messages m WHERE m.id = (SELECT id FROM messages latest WHERE latest.conversation_id = s.conversation_id ORDER BY created_at DESC, id DESC LIMIT 1) AND m.role = 'assistant' AND m.completion_reason = 'provider_error') AS provider_failed,
 (SELECT m.id FROM messages m WHERE m.conversation_id = s.conversation_id AND m.role = 'assistant'
 AND m.completion_reason IS NOT 'provider_error' AND (instr(lower(COALESCE(m.hidden_context,'')), '<questionnaire_context>') > 0 OR instr(lower(m.content), '[quick-replies]') > 0)
 AND NOT EXISTS(SELECT 1 FROM messages u WHERE u.conversation_id = m.conversation_id AND u.role = 'user' AND (u.created_at > m.created_at OR (u.created_at = m.created_at AND u.id > m.id)))
 ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS question_message_id,
 (SELECT id FROM messages preview WHERE preview.conversation_id = s.conversation_id AND preview.role = 'user' ORDER BY created_at DESC, id DESC LIMIT 1) AS preview_message_id
 FROM conversation_management s").fetch_all(pool).await.map_err(db)?;
    Ok(rows
        .into_iter()
        .map(|r| ConversationMetadata {
            conversation_id: r.get("conversation_id"),
            revision: r.get("revision"),
            archived: r.get::<i64, _>("archived") != 0,
            response_revision: r.get("response_revision"),
            read_revision: r.get("read_revision"),
            pending_tool: r.get::<i64, _>("pending_tool") != 0,
            provider_failed: r.get::<i64, _>("provider_failed") != 0,
            question_message_id: r.get("question_message_id"),
            preview_message_id: r.get("preview_message_id"),
        })
        .collect())
}
pub async fn response_version(
    pool: &SqlitePool,
    message_id: &str,
    content: &str,
) -> Result<i64, String> {
    let row = sqlx::query("SELECT m.content, v.revision FROM messages m JOIN conversation_response_versions v ON v.message_id = m.id WHERE m.id = ?").bind(message_id).fetch_optional(pool).await.map_err(db)?.ok_or("not_found")?;
    if row.get::<String, _>("content") != content {
        return Err("stale_revision".into());
    }
    Ok(row.get("revision"))
}
pub async fn acknowledge(
    pool: &SqlitePool,
    conversation_id: &str,
    observed: i64,
) -> Result<(), String> {
    if observed < 0 {
        return Err("validation_failed".into());
    }
    let result = sqlx::query("UPDATE conversation_management SET read_revision = MAX(read_revision, ?) WHERE conversation_id = ? AND response_revision >= ?")
        .bind(observed).bind(conversation_id).bind(observed).execute(pool).await.map_err(db)?;
    if result.rows_affected() != 1 {
        return Err("stale_revision".into());
    }
    Ok(())
}
/// First hydration imports legacy archive preferences once. Later catalog reads
/// and both desktop/mobile mutations use the same authoritative state.
pub async fn import_archives(pool: &SqlitePool, ids: &[String]) -> Result<(), String> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
    let inserted = sqlx::query("INSERT OR IGNORE INTO app_settings(key, value_json, updated_at) VALUES('chat:archive-import:1', 'true', ?)").bind(chrono::Utc::now().to_rfc3339()).execute(&mut *tx).await.map_err(db)?.rows_affected();
    if inserted == 1 {
        for id in ids {
            sqlx::query("UPDATE conversation_management SET archived = 1, revision = revision + 1 WHERE conversation_id = ?").bind(id).execute(&mut *tx).await.map_err(db)?;
        }
    }
    tx.commit().await.map_err(db)
}
pub async fn action(
    pool: &SqlitePool,
    input: ConversationActionInput,
) -> Result<ConversationActionResult, String> {
    guard(&input.execute_before)?;
    if !["rename", "pin", "unpin", "archive", "restore", "create"].contains(&input.action.as_str())
        || input.receipt_key.len() != 64
        || !input.receipt_key.bytes().all(|b| b.is_ascii_hexdigit())
        || input.digest.len() != 64
        || !input.digest.bytes().all(|b| b.is_ascii_hexdigit())
        || input.conversation_id.is_empty()
        || input.conversation_id.len() > 128
        || input
            .title
            .as_ref()
            .is_some_and(|t| t.trim().is_empty() || t.len() > 1024)
    {
        return Err("validation_failed".into());
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
    if let Some(r) = sqlx::query("SELECT digest, conversation_id, revision FROM conversation_action_receipts WHERE receipt_key = ?").bind(&input.receipt_key).fetch_optional(&mut *tx).await.map_err(db)? {
        if r.get::<String,_>("digest") != input.digest { return Err("conflict".into()); }
        guard(&input.execute_before)?;
        return Ok(ConversationActionResult { outcome: "duplicate".into(), conversation_id: r.get("conversation_id"), revision: r.get("revision") });
    }
    // Cap durable receipt growth without evicting old keys and permitting duplicates.
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM conversation_action_receipts")
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
    if count >= 10000 {
        return Err("resource_limit".into());
    }
    let revision;
    if input.action == "create" {
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO conversations(id,title,scope_mode,project_id,created_at,updated_at,message_count,is_pinned) VALUES(?,?,'Chat',?,?,?,0,0)")
            .bind(&input.conversation_id).bind(input.title.as_deref().unwrap_or("New Conversation")).bind(&input.project_id).bind(&now).bind(&now).execute(&mut *tx).await.map_err(db)?;
        revision = 1;
    } else {
        let row = sqlx::query("SELECT c.scope_mode, s.revision FROM conversations c JOIN conversation_management s ON s.conversation_id = c.id WHERE c.id = ?").bind(&input.conversation_id).fetch_optional(&mut *tx).await.map_err(db)?.ok_or("not_found")?;
        if row.get::<String, _>("scope_mode") != "Chat" {
            return Err("forbidden".into());
        }
        let old: i64 = row.get("revision");
        if input.expected_revision != Some(old) {
            return Err("stale_revision".into());
        }
        revision = old
            .checked_add(1)
            .filter(|r| *r <= 9007199254740991)
            .ok_or("resource_limit")?;
        match input.action.as_str() {
            "rename" => {
                sqlx::query("UPDATE conversations SET title = ? WHERE id = ?")
                    .bind(input.title.as_deref().ok_or("validation_failed")?)
                    .bind(&input.conversation_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(db)?;
            }
            "pin" | "unpin" => {
                sqlx::query("UPDATE conversations SET is_pinned = ? WHERE id = ?")
                    .bind(i64::from(input.action == "pin"))
                    .bind(&input.conversation_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(db)?;
            }
            "archive" | "restore" => {
                sqlx::query("UPDATE conversation_management SET archived = ?, revision = revision + 1 WHERE conversation_id = ?").bind(i64::from(input.action == "archive")).bind(&input.conversation_id).execute(&mut *tx).await.map_err(db)?;
            }
            _ => return Err("validation_failed".into()),
        }
    }
    sqlx::query("INSERT INTO conversation_action_receipts(receipt_key,digest,conversation_id,revision,created_at) VALUES(?,?,?,?,?)")
        .bind(&input.receipt_key).bind(&input.digest).bind(&input.conversation_id).bind(revision).bind(chrono::Utc::now().to_rfc3339()).execute(&mut *tx).await.map_err(db)?;
    guard(&input.execute_before)?;
    tx.commit().await.map_err(db)?;
    Ok(ConversationActionResult {
        outcome: "applied".into(),
        conversation_id: input.conversation_id,
        revision,
    })
}

/// The existing desktop bulk archive control commits a set atomically. Desired
/// state avoids toggle/retry races and leaves unselected conversations intact.
pub async fn set_archives(pool: &SqlitePool, ids: &[String], archived: bool) -> Result<(), String> {
    if ids.len() > 10000 {
        return Err("resource_limit".into());
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
    for id in ids {
        let mode: Option<String> =
            sqlx::query_scalar("SELECT scope_mode FROM conversations WHERE id = ?")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?;
        if mode.as_deref() != Some("Chat") {
            return Err("not_found".into());
        }
        sqlx::query("UPDATE conversation_management SET archived = ?, revision = revision + 1 WHERE conversation_id = ? AND archived != ?")
            .bind(i64::from(archived)).bind(id).bind(i64::from(archived)).execute(&mut *tx).await.map_err(db)?;
    }
    tx.commit().await.map_err(db)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{create_pool, models::CreateConversationInput, repository};
    async fn setup() -> (tempfile::TempDir, SqlitePool, String) {
        let temp = tempfile::tempdir().unwrap();
        let pool = create_pool(&temp.path().join("synthetic.db"))
            .await
            .unwrap();
        let c = repository::create_conversation(
            &pool,
            CreateConversationInput {
                title: Some("Synthetic Chat".into()),
                scope_mode: "Chat".into(),
                task_id: None,
                group_id: None,
                project_id: None,
                provider_id: None,
                model_id: None,
                reasoning_effort: None,
            },
        )
        .await
        .unwrap();
        (temp, pool, c.id)
    }
    fn input(id: &str, action: &str, revision: Option<i64>) -> ConversationActionInput {
        ConversationActionInput {
            receipt_key: "a".repeat(64),
            digest: "b".repeat(64),
            action: action.into(),
            conversation_id: id.into(),
            expected_revision: revision,
            title: None,
            project_id: None,
            execute_before: (chrono::Utc::now() + chrono::Duration::seconds(10)).to_rfc3339(),
        }
    }
    #[tokio::test]
    async fn atomic_actions_replay_after_lost_response_and_reject_key_reuse() {
        let (_temp, pool, id) = setup().await;
        let command = input(&id, "archive", Some(1));
        let applied = action(&pool, command.clone()).await.unwrap();
        assert_eq!(applied.revision, 2);
        assert!(metadata(&pool).await.unwrap()[0].archived);
        let replay = action(&pool, command.clone()).await.unwrap();
        assert_eq!(replay.outcome, "duplicate");
        assert_eq!(replay.revision, 2);
        let mut changed = command;
        changed.digest = "c".repeat(64);
        assert_eq!(action(&pool, changed).await.unwrap_err(), "conflict");
        let mut restore = input(&id, "restore", Some(2));
        restore.receipt_key = "d".repeat(64);
        assert_eq!(action(&pool, restore).await.unwrap().revision, 3);
        assert!(!metadata(&pool).await.unwrap()[0].archived);
    }
    #[tokio::test]
    async fn desktop_edits_stale_remote_revision_and_task_scope_is_protected() {
        let (_temp, pool, id) = setup().await;
        repository::rename_conversation(&pool, &id, "Desktop edit")
            .await
            .unwrap();
        assert_eq!(
            action(&pool, input(&id, "pin", Some(1))).await.unwrap_err(),
            "stale_revision"
        );
        let mut pin = input(&id, "pin", Some(2));
        pin.receipt_key = "d".repeat(64);
        assert_eq!(action(&pool, pin).await.unwrap().revision, 3);
        sqlx::query("UPDATE conversations SET scope_mode='Implement' WHERE id=?")
            .bind(&id)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            action(&pool, input(&id, "archive", Some(4)))
                .await
                .unwrap_err(),
            "forbidden"
        );
    }
    #[tokio::test]
    async fn double_creation_commits_conversation_and_receipt_once() {
        let (_temp, pool, _) = setup().await;
        let mut create = input("synthetic-created", "create", None);
        create.title = Some("New synthetic Chat".into());
        let first = action(&pool, create.clone()).await.unwrap();
        let duplicate = action(&pool, create).await.unwrap();
        assert_eq!(first.conversation_id, duplicate.conversation_id);
        assert_eq!(duplicate.outcome, "duplicate");
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM conversations WHERE id='synthetic-created'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 1);
        assert_eq!(metadata(&pool).await.unwrap().len(), 2);
    }
    #[tokio::test]
    async fn expired_authorization_rolls_back_and_archive_import_is_once() {
        let (_temp, pool, id) = setup().await;
        let mut command = input(&id, "archive", Some(1));
        command.execute_before = "2020-01-01T00:00:00Z".into();
        assert_eq!(action(&pool, command).await.unwrap_err(), "unavailable");
        import_archives(&pool, std::slice::from_ref(&id))
            .await
            .unwrap();
        assert!(metadata(&pool).await.unwrap()[0].archived);
        let restore = input(&id, "restore", Some(2));
        action(&pool, restore).await.unwrap();
        import_archives(&pool, std::slice::from_ref(&id))
            .await
            .unwrap();
        assert!(!metadata(&pool).await.unwrap()[0].archived);
    }
    #[tokio::test]
    async fn acknowledgement_is_monotonic_and_preserves_concurrent_reply() {
        let (_temp, pool, id) = setup().await;
        sqlx::query("INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES('answer',?,'assistant','Observed','2026-01-01T00:00:00Z')").bind(&id).execute(&pool).await.unwrap();
        let observed = response_version(&pool, "answer", "Observed").await.unwrap();
        sqlx::query("UPDATE messages SET content='Concurrent' WHERE id='answer'")
            .execute(&pool)
            .await
            .unwrap();
        acknowledge(&pool, &id, observed).await.unwrap();
        let state = metadata(&pool).await.unwrap().remove(0);
        assert!(state.response_revision > state.read_revision);
        assert_eq!(
            response_version(&pool, "answer", "Observed")
                .await
                .unwrap_err(),
            "stale_revision"
        );
        let current = response_version(&pool, "answer", "Concurrent")
            .await
            .unwrap();
        acknowledge(&pool, &id, current).await.unwrap();
        acknowledge(&pool, &id, observed).await.unwrap();
        let state = metadata(&pool).await.unwrap().remove(0);
        assert_eq!(state.response_revision, state.read_revision);
        assert_eq!(
            acknowledge(&pool, &id, current + 100).await.unwrap_err(),
            "stale_revision"
        );
    }
    #[tokio::test]
    async fn metadata_reports_durable_pending_requests_without_histories() {
        let (_temp, pool, id) = setup().await;
        sqlx::query("INSERT INTO messages(id,conversation_id,role,content,created_at,tool_traces_json,hidden_context) VALUES('question',?,'assistant','Question','2026-01-01T00:00:00Z','[\"not-an-object\",{\"status\":\"pending_approval\",\"tool_call_id\":\"synthetic-call\",\"tool_name\":\"synthetic-tool\"}]','<questionnaire_context>{}</questionnaire_context>')").bind(&id).execute(&pool).await.unwrap();
        let state = metadata(&pool).await.unwrap().remove(0);
        assert!(state.pending_tool);
        assert_eq!(state.question_message_id.as_deref(), Some("question"));
        sqlx::query("UPDATE messages SET tool_traces_json='[]' WHERE id='question'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES('user-reply',?,'user','Answered','2026-01-01T00:01:00Z')").bind(&id).execute(&pool).await.unwrap();
        let state = metadata(&pool).await.unwrap().remove(0);
        assert!(!state.pending_tool);
        assert!(state.question_message_id.is_none());
    }
    #[tokio::test]
    async fn concurrent_creation_and_mutation_have_one_winner() {
        let (_temp, pool, id) = setup().await;
        let create = input("concurrent-created", "create", None);
        let (first, second) = tokio::join!(action(&pool, create.clone()), action(&pool, create));
        let mut outcomes = vec![first.unwrap().outcome, second.unwrap().outcome];
        outcomes.sort();
        assert_eq!(outcomes, vec!["applied", "duplicate"]);
        let mut pin = input(&id, "pin", Some(1));
        pin.receipt_key = "c".repeat(64);
        let mut rename = input(&id, "rename", Some(1));
        rename.receipt_key = "d".repeat(64);
        rename.title = Some("Concurrent rename".into());
        let (a, b) = tokio::join!(action(&pool, pin), action(&pool, rename));
        assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
        assert_eq!(a.err().or(b.err()).as_deref(), Some("stale_revision"));
    }
    #[tokio::test]
    async fn a_delivery_expiring_while_waiting_for_sqlite_does_not_commit() {
        let (_temp, pool, id) = setup().await;
        let tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let mut command = input(&id, "archive", Some(1));
        command.execute_before =
            (chrono::Utc::now() + chrono::Duration::milliseconds(30)).to_rfc3339();
        let release = async {
            tokio::time::sleep(std::time::Duration::from_millis(60)).await;
            tx.rollback().await.unwrap();
        };
        let (result, _) = tokio::join!(action(&pool, command), release);
        assert_eq!(result.unwrap_err(), "unavailable");
        assert!(!metadata(&pool).await.unwrap()[0].archived);
        let receipts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM conversation_action_receipts")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(receipts, 0);
    }
    #[tokio::test]
    async fn recovered_migration_history_preserves_read_state_and_receipts() {
        let (temp, pool, id) = setup().await;
        sqlx::query("INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES('observed',?,'assistant','Visible','2026-01-01T00:00:00Z')")
            .bind(&id).execute(&pool).await.unwrap();
        acknowledge(&pool, &id, 1).await.unwrap();
        let command = input(&id, "archive", Some(1));
        action(&pool, command.clone()).await.unwrap();
        sqlx::query("DROP TABLE schema_migrations")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        let reopened = create_pool(&temp.path().join("synthetic.db"))
            .await
            .unwrap();
        let state = metadata(&reopened).await.unwrap().remove(0);
        assert!(state.archived);
        assert_eq!(state.revision, 2);
        assert_eq!(state.read_revision, 1);
        assert_eq!(state.response_revision, 1);
        assert_eq!(
            action(&reopened, command).await.unwrap().outcome,
            "duplicate"
        );
    }
    #[tokio::test]
    async fn desktop_archives_are_atomic_and_provider_failure_is_not_an_approval() {
        let (_temp, pool, id) = setup().await;
        assert_eq!(
            set_archives(&pool, &[id.clone(), "missing".into()], true)
                .await
                .unwrap_err(),
            "not_found"
        );
        assert!(!metadata(&pool).await.unwrap()[0].archived);
        set_archives(&pool, std::slice::from_ref(&id), true)
            .await
            .unwrap();
        let revision = metadata(&pool).await.unwrap()[0].revision;
        set_archives(&pool, std::slice::from_ref(&id), true)
            .await
            .unwrap();
        assert_eq!(metadata(&pool).await.unwrap()[0].revision, revision);
        sqlx::query("INSERT INTO messages(id,conversation_id,role,content,created_at,completion_reason,tool_traces_json,hidden_context) VALUES('error',?,'assistant','Failure','2026-01-01T00:00:00Z','provider_error','[{\"status\":\"pending_approval\",\"tool_name\":\"synthetic-tool\",\"tool_call_id\":\"call\"}]','<questionnaire_context>{}</questionnaire_context>')").bind(&id).execute(&pool).await.unwrap();
        let state = metadata(&pool).await.unwrap().remove(0);
        assert!(state.provider_failed);
        assert!(!state.pending_tool);
        assert!(state.question_message_id.is_none());
        sqlx::query("DELETE FROM messages WHERE id='error'")
            .execute(&pool)
            .await
            .unwrap();
        let state = metadata(&pool).await.unwrap().remove(0);
        assert!(!state.provider_failed);
        assert_eq!(state.response_revision, 0);
    }
}
