use super::*;
use crate::db::{conversation_content, create_pool, repository};
use sqlx::Row;
use tempfile::TempDir;

async fn fixture() -> (TempDir, SqlitePool) {
    let dir = TempDir::new().unwrap();
    let pool = create_pool(&dir.path().join("chat.db")).await.unwrap();
    let mut connection = pool.acquire().await.unwrap();
    let recursive: i64 = sqlx::query_scalar("PRAGMA recursive_triggers")
        .fetch_one(&mut *connection)
        .await
        .unwrap();
    let trusted: i64 = sqlx::query_scalar("PRAGMA trusted_schema")
        .fetch_one(&mut *connection)
        .await
        .unwrap();
    assert_eq!((recursive, trusted), (1, 1));
    drop(connection);
    sqlx::raw_sql("INSERT INTO conversations(id,title,scope_mode,created_at,updated_at) VALUES('source','Synthetic','Chat','t','t'); INSERT INTO messages(id,conversation_id,role,content,created_at,turn_id) VALUES('message','source','assistant','history','t','turn');")
        .execute(&pool).await.unwrap();
    (dir, pool)
}

#[tokio::test]
async fn fresh_database_stamps_the_exact_admission_schema() {
    let dir = TempDir::new().unwrap();
    let pool = create_pool(&dir.path().join("fresh.db")).await.unwrap();
    let versions: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM schema_migrations ORDER BY version")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        versions,
        [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]
    );
    let stamp: String = sqlx::query_scalar("SELECT name FROM schema_migrations WHERE version=17")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(stamp, "017_chat_admission");
    let mut connection = pool.acquire().await.unwrap();
    super::validate_schema(&mut connection).await.unwrap();
}

#[tokio::test]
async fn restored_source_rejects_writers_and_conflict_victims_without_blocking_new_chat() {
    let (_dir, pool) = fixture().await;
    sqlx::raw_sql("INSERT INTO pilot_message_attachments VALUES('asset','owner','instance','ref','message','file.txt','text/plain',1,'hash',X'61'); INSERT INTO pilot_file_sends(owner_key,ref_key,send_intent_id,scope_key,digest,message_id,turn_id,state,attachment_ids_json,context_state,intent_expires_at) VALUES('owner','ref','intent','scope','hash','message','turn','confirmed','[]','ready',1);")
        .execute(&pool).await.unwrap();
    sqlx::raw_sql("UPDATE conversations SET rowid=-1 WHERE id='source'; UPDATE messages SET rowid=-1 WHERE id='message'; UPDATE pilot_message_attachments SET rowid=-1 WHERE id='asset'; UPDATE pilot_file_sends SET rowid=-1 WHERE message_id='message';")
        .execute(&pool).await.unwrap();
    hold_restored_profile(&pool).await.unwrap();
    sqlx::raw_sql("INSERT INTO conversations(id,title,scope_mode,created_at,updated_at) VALUES('other','Other','Chat','t','t'); INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES('other-message','other','user','new','t');")
        .execute(&pool).await.unwrap();
    repository::rename_conversation(&pool, "other", "Allowed")
        .await
        .unwrap();
    // C1 may conservatively invalidate a rowid=-1 observation on unrelated
    // inserts. Only the rejected mutations below must leave this token intact.
    let token = conversation_content::conversation_content_version(&pool, "source")
        .await
        .unwrap();
    assert!(repository::rename_conversation(&pool, "source", "Denied")
        .await
        .is_err());
    for statement in [
        "UPDATE messages SET content='changed' WHERE id='message'",
        "UPDATE messages SET conversation_id='other' WHERE id='message'",
        "UPDATE OR REPLACE messages SET rowid=-1 WHERE id='other-message'",
        "UPDATE OR REPLACE conversations SET rowid=-1 WHERE id='other'",
        "DELETE FROM conversations WHERE id IN ('other','source')",
        "INSERT OR REPLACE INTO messages(id,conversation_id,role,content,created_at) VALUES('message','other','user','replacement','t')",
        "INSERT OR REPLACE INTO messages(rowid,id,conversation_id,role,content,created_at) SELECT rowid,'new-id','other','user','replacement','t' FROM messages WHERE id='message'",
        "INSERT OR REPLACE INTO conversations(rowid,id,title,scope_mode,created_at,updated_at) VALUES(-1,'replacement','Replacement','Chat','t','t')",
        "UPDATE conversations SET scope_mode='Architect' WHERE id='source'",
        "DELETE FROM conversations WHERE id='source'",
        "UPDATE conversation_management SET read_revision=read_revision+1 WHERE conversation_id='source'",
        "UPDATE conversation_response_versions SET read_revision=read_revision+1 WHERE message_id='message'",
        "INSERT INTO conversation_citations(id,conversation_id,message_id,type,scope,source,title,created_at,updated_at) VALUES('citation','source','message','document','context','test','title','t','t')",
        "INSERT INTO conversation_toolbox_state VALUES('source','[]','t','t')",
        "INSERT INTO conversation_compactions(conversation_id,up_to_message_id,summary_text,tool_digest_json,used_source_passage_ids_json,interesting_source_passage_ids_json,estimated_tokens_before,estimated_tokens_after,fingerprint,created_at,updated_at) VALUES('source','message','summary','[]','[]','[]',1,1,'hash','t','t')",
        "INSERT INTO conversation_compaction_events(id,conversation_id,trigger,status,created_at) VALUES('event','source','manual','completed','t')",
        "INSERT INTO app_settings(key,value_json,updated_at) VALUES('chat:assistant-visible-provenance:v1:message','{}','t')",
        "DELETE FROM pilot_message_attachments WHERE id='asset'",
        "INSERT OR REPLACE INTO pilot_message_attachments(rowid,id,owner_key,instance_id,ref_key,message_id,file_name,mime_type,total_bytes,sha256,data) VALUES(-1,'other-asset','owner','instance','ref','other-message','file.txt','text/plain',1,'hash',X'61')",
        "UPDATE pilot_file_sends SET state='launch_uncertain' WHERE message_id='message'",
        "INSERT OR REPLACE INTO pilot_file_sends(owner_key,ref_key,send_intent_id,scope_key,digest,message_id,turn_id,state,attachment_ids_json,context_state,intent_expires_at) VALUES('owner','ref','intent','scope','hash','other-message','turn','confirmed','[]','ready',1)",
    ] {
        let error = sqlx::query(statement).execute(&pool).await.unwrap_err();
        assert!(error.to_string().contains("chat_admission_read_only"), "{statement}: {error}");
    }
    assert_eq!(
        token,
        conversation_content::conversation_content_version(&pool, "source")
            .await
            .unwrap()
    );
    let content: String = sqlx::query_scalar("SELECT content FROM messages WHERE id='message'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(content, "history");
}

#[tokio::test]
async fn startup_keeps_unknown_work_and_restore_hold() {
    let (dir, pool) = fixture().await;
    sqlx::query("INSERT INTO chat_admission_operations(operation_id,conversation_id,incarnation,runtime_generation,kind,phase,turn_id) SELECT 'op',conversation_id,incarnation,'old','turn','dispatched','turn' FROM chat_admission_owners WHERE conversation_id='source'")
        .execute(&pool).await.unwrap();
    hold_restored_profile(&pool).await.unwrap();
    pool.close().await;
    let reopened = create_pool(&dir.path().join("chat.db")).await.unwrap();
    reconcile_after_restart(&reopened).await.unwrap();
    let state: (String, String, i64) = sqlx::query_as("SELECT o.mode,p.phase,o.browser_reconciled FROM chat_admission_owners o JOIN chat_admission_operations p ON p.conversation_id=o.conversation_id")
        .fetch_one(&reopened).await.unwrap();
    assert_eq!(state, ("restore_hold".into(), "unknown".into(), 0));
}

#[tokio::test]
async fn migration_backfills_owners_and_rejects_altered_guard_on_reopen() {
    let (dir, pool) = fixture().await;
    remove_reference_schema(&pool).await.unwrap();
    sqlx::query("DELETE FROM schema_migrations WHERE version=17")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let reopened = create_pool(&dir.path().join("chat.db")).await.unwrap();
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM chat_admission_owners WHERE conversation_id='source'",
    )
    .fetch_one(&reopened)
    .await
    .unwrap();
    assert_eq!(count, 1);
    sqlx::raw_sql("DROP TRIGGER chat_admission_messages_update; CREATE TRIGGER chat_admission_messages_update BEFORE UPDATE ON messages BEGIN SELECT 1; END;").execute(&reopened).await.unwrap();
    assert!(crate::db::validate_source_opening(&reopened, None)
        .await
        .is_err());
    reopened.close().await;
    assert!(create_pool(&dir.path().join("chat.db")).await.is_err());
}

#[tokio::test]
async fn deleting_open_transcript_keeps_its_owner_tombstone() {
    let (_dir, pool) = fixture().await;
    repository::delete_conversation(&pool, "source")
        .await
        .unwrap();
    let mode: String =
        sqlx::query_scalar("SELECT mode FROM chat_admission_owners WHERE conversation_id='source'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(mode, "removed");
    assert!(sqlx::query("INSERT INTO conversations(id,title,scope_mode,created_at,updated_at) VALUES('source','Reused','Chat','t','t')").execute(&pool).await.is_err());
}

#[tokio::test]
async fn native_parent_waits_for_child_and_terminal_ack_can_be_retried() {
    let (_dir, pool) = fixture().await;
    let owner = crate::core::db_state::DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let parent = OperationPermit::begin_turn(owner.clone(), "source", "turn")
        .await
        .unwrap();
    assert!(
        OperationPermit::begin_turn(owner.clone(), "source", "second")
            .await
            .is_err()
    );
    parent.dispatched().await.unwrap();
    let child = parent
        .provider_attempt(
            "request",
            "synthetic-provider",
            "synthetic-provider-context",
        )
        .await
        .unwrap();
    assert!(parent
        .provider_attempt(
            "request",
            "synthetic-provider",
            "synthetic-provider-context"
        )
        .await
        .is_err());
    child.dispatched().await.unwrap();
    parent.result_pending().await.unwrap();
    assert!(parent.completed().await.is_err());
    assert!(owner.set_ready(pool.clone()).await.is_err());
    child.result_pending().await.unwrap();
    child.completed().await.unwrap();
    child.completed().await.unwrap();
    parent.completed().await.unwrap();
    parent.completed().await.unwrap();
    assert!(parent
        .provider_attempt("late", "synthetic-provider", "synthetic-provider-context")
        .await
        .is_err());
    // A terminal receipt alone does not prove the task owning it has returned.
    assert!(owner.set_ready(pool.clone()).await.is_err());
    drop(child);
    drop(parent);
    owner.set_ready(pool).await.unwrap();
}

#[tokio::test]
async fn unknown_provider_cannot_be_turned_into_completed_by_retry() {
    let (_dir, pool) = fixture().await;
    let owner = crate::core::db_state::DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let parent = OperationPermit::begin_turn(owner, "source", "turn")
        .await
        .unwrap();
    parent.dispatched().await.unwrap();
    let child = parent
        .provider_attempt(
            "request",
            "synthetic-provider",
            "synthetic-provider-context",
        )
        .await
        .unwrap();
    child.dispatched().await.unwrap();
    child.unknown().await.unwrap();
    assert!(child.result_pending().await.is_err());
    parent.result_pending().await.unwrap();
    assert!(parent.completed().await.is_err());
    let phase: String = sqlx::query_scalar(
        "SELECT phase FROM chat_admission_operations WHERE request_id='request'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(phase, "unknown");
}

#[tokio::test]
async fn open_replace_renews_incarnation_but_cannot_revive_an_old_tombstone() {
    let (_dir, pool) = fixture().await;
    let before: String = sqlx::query_scalar(
        "SELECT incarnation FROM chat_admission_owners WHERE conversation_id='source'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT OR REPLACE INTO conversations(id,title,scope_mode,created_at,updated_at) VALUES('source','Replacement','Chat','t','t')")
        .execute(&pool).await.unwrap();
    let after: (String, String) = sqlx::query_as(
        "SELECT incarnation,mode FROM chat_admission_owners WHERE conversation_id='source'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_ne!(before, after.0);
    assert_eq!(after.1, "open");
    repository::delete_conversation(&pool, "source")
        .await
        .unwrap();
    assert!(sqlx::query("INSERT OR REPLACE INTO conversations(id,title,scope_mode,created_at,updated_at) VALUES('source','Revived','Chat','t','t')")
        .execute(&pool).await.is_err());
}

#[tokio::test]
async fn nonconforming_connection_cannot_skip_replace_victim_guards() {
    let (_dir, pool) = fixture().await;
    hold_restored_profile(&pool).await.unwrap();
    let mut connection = pool.acquire().await.unwrap();
    sqlx::query("PRAGMA recursive_triggers=OFF")
        .execute(&mut *connection)
        .await
        .unwrap();
    let error = sqlx::query("INSERT OR REPLACE INTO messages(id,conversation_id,role,content,created_at) VALUES('message','source','user','changed','t')")
        .execute(&mut *connection).await.unwrap_err();
    assert!(error
        .to_string()
        .contains("chat_admission_connection_config"));
    sqlx::query("PRAGMA recursive_triggers=ON")
        .execute(&mut *connection)
        .await
        .unwrap();
    sqlx::query("PRAGMA trusted_schema=OFF")
        .execute(&mut *connection)
        .await
        .unwrap();
    assert!(validate_schema(&mut connection)
        .await
        .unwrap_err()
        .to_string()
        .contains("chat_admission_schema_configuration"));
    let trusted: i64 = sqlx::query_scalar("PRAGMA trusted_schema")
        .fetch_one(&mut *connection)
        .await
        .unwrap();
    assert_eq!(trusted, 0);
}

#[tokio::test]
async fn revoking_ready_does_not_forget_unfinished_generation() {
    for failed in [false, true] {
        let (_dir, pool) = fixture().await;
        let owner = crate::core::db_state::DbPool::default();
        owner.set_ready(pool.clone()).await.unwrap();
        let parent = OperationPermit::begin_turn(owner.clone(), "source", "turn")
            .await
            .unwrap();
        parent.dispatched().await.unwrap();
        if failed {
            owner.set_failed("synthetic").await;
        } else {
            owner.set_initializing().await;
        }
        // Even startup-style reconciliation cannot prove a task from this
        // still-live process stopped. The task must release its native lifetime.
        reconcile_after_restart(&pool).await.unwrap();
        assert!(owner.set_ready(pool.clone()).await.is_err());
        assert!(owner.ready_pool().is_none());
        assert!(parent.result_pending().await.is_err());
        drop(parent);
        owner.set_ready(pool.clone()).await.unwrap();
        let phase: String =
            sqlx::query_scalar("SELECT phase FROM chat_admission_operations WHERE kind='turn'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(phase, "unknown");
    }
}

#[tokio::test]
async fn restored_pending_tool_is_unknown_before_read_only_startup() {
    let (_dir, pool) = fixture().await;
    use crate::db::tool_invocations::{
        record, RecordToolInvocationInput, ToolEffectClass, ToolInvocationIdentity,
    };
    record(
        &pool,
        RecordToolInvocationInput {
            identity: ToolInvocationIdentity {
                conversation_id: "source".into(),
                turn_id: "turn".into(),
                message_id: "message".into(),
                call_id: "call".into(),
            },
            tool_name: "synthetic".into(),
            effect_class: ToolEffectClass::ExternalEffect,
            arguments: serde_json::json!({"input":"synthetic"}),
            remote_execution_id: None,
        },
    )
    .await
    .unwrap();
    hold_restored_profile(&pool).await.unwrap();
    crate::db::tool_invocations::reconcile_pending_after_restart(&pool)
        .await
        .unwrap();
    let status: String =
        sqlx::query_scalar("SELECT status FROM tool_invocations WHERE call_id='call'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "unknown");
    assert!(sqlx::query(
        "UPDATE tool_invocations SET status='completed',receipt_id='receipt' WHERE call_id='call'"
    )
    .execute(&pool)
    .await
    .is_err());
}

#[tokio::test]
async fn response_versions_guard_both_declared_and_message_owners() {
    let (_dir, pool) = fixture().await;
    sqlx::raw_sql("INSERT INTO conversations(id,title,scope_mode,created_at,updated_at) VALUES('other','Other','Chat','t','t');
        INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES
        ('cross-existing','source','user','','t'),('cross-new','source','user','','t'),('other-message','other','user','','t');
        INSERT INTO conversation_response_versions VALUES('cross-existing','other',1,0),('other-message','other',1,0);
        UPDATE chat_admission_owners SET mode='frozen' WHERE conversation_id='source';")
        .execute(&pool).await.unwrap();
    for statement in [
        "INSERT INTO conversation_response_versions VALUES('cross-new','other',1,0)",
        "INSERT OR REPLACE INTO conversation_response_versions VALUES('cross-existing','other',2,0)",
        "UPDATE conversation_response_versions SET read_revision=1 WHERE message_id='cross-existing'",
        "DELETE FROM conversation_response_versions WHERE message_id='cross-existing'",
        "UPDATE conversation_response_versions SET message_id='cross-new' WHERE message_id='other-message'",
        "UPDATE OR REPLACE conversation_response_versions SET message_id='cross-existing' WHERE message_id='other-message'",
        "UPDATE conversation_response_versions SET conversation_id='source' WHERE message_id='other-message'",
    ] {
        let error = sqlx::query(statement).execute(&pool).await.unwrap_err();
        assert!(error.to_string().contains("chat_admission_read_only"), "{statement}: {error}");
    }
    sqlx::query("UPDATE conversation_response_versions SET read_revision=1 WHERE message_id='other-message'")
        .execute(&pool).await.unwrap();
    let rows: Vec<(String, String, i64)> = sqlx::query_as("SELECT message_id,conversation_id,read_revision FROM conversation_response_versions ORDER BY message_id")
        .fetch_all(&pool).await.unwrap();
    assert_eq!(
        rows,
        vec![
            ("cross-existing".into(), "other".into(), 0),
            ("message".into(), "source".into(), 0),
            ("other-message".into(), "other".into(), 1)
        ]
    );
}

#[tokio::test]
async fn provenance_guards_use_message_primary_key_for_old_and_new_keys() {
    let (_dir, pool) = fixture().await;
    // Explain the installed predicate, rather than a separately maintained query.
    // Its cost must not grow with the number of messages for ordinary settings.
    for operation in ["insert", "update", "delete"] {
        let sql: String =
            sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?")
                .bind(format!("chat_admission_app_settings_{operation}"))
                .fetch_one(&pool)
                .await
                .unwrap();
        let predicate = sql
            .split("WHERE EXISTS(\n")
            .last()
            .unwrap()
            .strip_suffix("\n );\nEND")
            .unwrap()
            .replace("NEW.key", "?1")
            .replace("OLD.key", "?1");
        let plan = format!("EXPLAIN QUERY PLAN {predicate}");
        for key in [
            "ordinary-setting",
            "chat:assistant-visible-provenance:v1:message",
        ] {
            let rows = sqlx::query(sqlx::AssertSqlSafe(plan.clone()))
                .bind(key)
                .fetch_all(&pool)
                .await
                .unwrap();
            let details: Vec<String> = rows.iter().map(|row| row.get("detail")).collect();
            assert!(
                !details.iter().any(|line| line.contains("SCAN messages")),
                "{operation}: {details:?}"
            );
            assert_eq!(
                details
                    .iter()
                    .filter(|line| line
                        .contains("SEARCH messages USING INDEX sqlite_autoindex_messages_"))
                    .count(),
                if operation == "update" { 2 } else { 1 },
                "{operation}: {details:?}"
            );
        }
    }
}

#[tokio::test]
async fn uncertain_provider_context_cannot_be_replayed_under_a_new_turn_or_generation() {
    let (_dir, pool) = fixture().await;
    let owner = crate::core::db_state::DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let parent = OperationPermit::begin_turn(owner.clone(), "source", "turn-one")
        .await
        .unwrap();
    parent.dispatched().await.unwrap();
    let attempt = parent
        .provider_attempt("attempt-one", "synthetic-provider", "context-one")
        .await
        .unwrap();
    attempt.dispatched().await.unwrap();
    attempt.unknown().await.unwrap();
    parent.unknown().await.unwrap();
    drop(attempt);
    drop(parent);
    owner.set_ready(pool.clone()).await.unwrap();
    assert!(
        OperationPermit::begin_turn(owner.clone(), "source", "turn-two")
            .await
            .is_err()
    );
    sqlx::query("INSERT INTO conversations(id,title,scope_mode,created_at,updated_at) VALUES('unrelated','Other','Chat','t','t')")
        .execute(&pool).await.unwrap();
    let other = OperationPermit::begin_turn(owner, "unrelated", "other-turn")
        .await
        .unwrap();
    assert!(other
        .child(WorkKind::Provider, Some("missing-context"))
        .await
        .is_err());
    let safe = other
        .provider_attempt("other-context", "other-provider", "context-two")
        .await
        .unwrap();
    safe.no_effect().await.unwrap();
    other.no_effect().await.unwrap();
    let phase: String = sqlx::query_scalar(
        "SELECT phase FROM chat_admission_operations WHERE request_id='attempt-one'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(phase, "unknown");
}

#[tokio::test]
async fn only_confirmed_rejection_allows_another_attempt_in_the_same_context() {
    let (_dir, pool) = fixture().await;
    let owner = crate::core::db_state::DbPool::default();
    owner.set_ready(pool).await.unwrap();
    let parent = OperationPermit::begin_turn(owner, "source", "turn")
        .await
        .unwrap();
    let first = parent
        .provider_attempt("attempt-one", "synthetic-provider", "context")
        .await
        .unwrap();
    first.dispatched().await.unwrap();
    assert!(parent
        .provider_attempt("attempt-two", "synthetic-provider", "context")
        .await
        .is_err());
    first.rejected_before_prompt().await.unwrap();
    let second = parent
        .provider_attempt("attempt-two", "synthetic-provider", "context")
        .await
        .unwrap();
    second.no_effect().await.unwrap();
    parent.no_effect().await.unwrap();
}

fn response_write(content: &str) -> repository::UpdateMessageContentInput<'_> {
    repository::UpdateMessageContentInput {
        id: "message",
        turn_id: Some("turn".into()),
        content,
        token_count: None,
        tool_traces_json: None,
        hidden_context: Some("Synthetic hidden result".into()),
        provider_input_items_json: Some(
            "[{\"type\":\"message\",\"content\":\"synthetic\"}]".into(),
        ),
        provider_turn_state_json: None,
        context_refs_json: None,
        completion_reason: Some("completed".into()),
        generation_attempts_json: None,
    }
}

#[tokio::test]
async fn response_and_parent_close_commit_together_after_children_finish() {
    let (_dir, pool) = fixture().await;
    sqlx::raw_sql("CREATE TRIGGER synthetic_save_failure BEFORE UPDATE ON messages WHEN EXISTS(SELECT 1 FROM app_settings WHERE key='synthetic-fail-write') BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END;").execute(&pool).await.unwrap();
    let owner = crate::core::db_state::DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let parent = OperationPermit::begin_turn(owner.clone(), "source", "turn")
        .await
        .unwrap();
    let child = parent
        .child(WorkKind::Tool, Some("synthetic-tool"))
        .await
        .unwrap();
    assert!(parent
        .finish_response(response_write("new response"))
        .await
        .is_err());
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT content FROM messages WHERE id='message'")
            .fetch_one(&pool)
            .await
            .unwrap(),
        "history"
    );
    child.no_effect().await.unwrap();
    sqlx::query("INSERT INTO app_settings(key,value_json,updated_at) VALUES('synthetic-fail-write','true','t')").execute(&pool).await.unwrap();
    let error = parent
        .finish_response(response_write("new response"))
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("synthetic write failure"),
        "{error}"
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT phase FROM chat_admission_operations WHERE parent_id IS NULL"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        "prepared"
    );
    sqlx::query("DELETE FROM app_settings WHERE key='synthetic-fail-write'")
        .execute(&pool)
        .await
        .unwrap();
    parent
        .finish_response(response_write("new response"))
        .await
        .unwrap();
    let saved: (String, String, String) = sqlx::query_as(
        "SELECT content,hidden_context,provider_input_items_json FROM messages WHERE id='message'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        saved,
        (
            "new response".into(),
            "Synthetic hidden result".into(),
            "[{\"type\":\"message\",\"content\":\"synthetic\"}]".into()
        )
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT phase FROM chat_admission_operations WHERE parent_id IS NULL"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        "completed"
    );
    assert!(parent
        .child(WorkKind::Tool, Some("late-tool"))
        .await
        .is_err());
    let next = OperationPermit::begin_turn(owner, "source", "next-turn")
        .await
        .unwrap();
    next.no_effect().await.unwrap();
}

#[tokio::test]
async fn uncertain_provider_cannot_be_closed_by_saving_a_response() {
    let (_dir, pool) = fixture().await;
    let owner = crate::core::db_state::DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let parent = OperationPermit::begin_turn(owner.clone(), "source", "turn")
        .await
        .unwrap();
    let attempt = parent
        .provider_attempt("attempt", "synthetic-provider", "synthetic-context")
        .await
        .unwrap();
    attempt.dispatched().await.unwrap();
    attempt.unknown().await.unwrap();
    assert!(parent
        .finish_response(response_write("not a terminal receipt"))
        .await
        .is_err());
    assert!(OperationPermit::begin_turn(owner, "source", "new-turn")
        .await
        .is_err());
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT content FROM messages WHERE id='message'")
            .fetch_one(&pool)
            .await
            .unwrap(),
        "history"
    );
}

#[tokio::test]
async fn local_compaction_root_is_distinct_and_excludes_concurrent_turns() {
    let (_dir, pool) = fixture().await;
    let owner = crate::core::db_state::DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let compaction =
        OperationPermit::begin_root(owner.clone(), "source", "compact", RootWorkKind::Compaction)
            .await
            .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT kind FROM chat_admission_operations WHERE parent_id IS NULL"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        "compaction"
    );
    assert!(OperationPermit::begin_turn(owner, "source", "turn")
        .await
        .is_err());
    assert!(compaction
        .finish_response(response_write("not a turn"))
        .await
        .is_err());
    compaction.no_effect().await.unwrap();
}

#[tokio::test]
async fn concurrent_final_response_retries_share_the_exact_local_receipt() {
    let (_dir, pool) = fixture().await;
    let owner = crate::core::db_state::DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let runtime = runtime::ChatAdmissionRuntime::default();
    let context = runtime
        .begin_root(
            owner.clone(),
            "window",
            "browser",
            "source",
            "turn",
            "attempt",
            RootWorkKind::Turn,
        )
        .await
        .unwrap();
    let same = runtime
        .begin_root(
            owner.clone(),
            "window",
            "browser",
            "source",
            "turn",
            "attempt",
            RootWorkKind::Turn,
        )
        .await
        .unwrap();
    assert_eq!(context.handle, same.handle);
    assert!(runtime
        .begin_root(
            owner,
            "window",
            "browser",
            "source",
            "turn",
            "another-attempt",
            RootWorkKind::Turn
        )
        .await
        .is_err());
    let (first, retry) = tokio::join!(
        runtime.finish_response("window", &context, "source", response_write("saved")),
        runtime.finish_response("window", &context, "source", response_write("saved")),
    );
    first.unwrap();
    retry.unwrap();
    assert!(runtime
        .finish_response("window", &context, "source", response_write("different"))
        .await
        .is_err());
    assert!(runtime
        .finish_response("other-window", &context, "source", response_write("saved"))
        .await
        .is_err());
    assert!(runtime.parent("window", &context, "source").await.is_err());
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT content FROM messages WHERE id='message'")
            .fetch_one(&pool)
            .await
            .unwrap(),
        "saved"
    );
}

#[tokio::test]
async fn tool_intent_and_admitted_child_are_atomic_and_duplicates_never_dispatch() {
    use crate::db::tool_invocations::{
        RecordToolInvocationInput, ToolEffectClass, ToolInvocationIdentity,
    };
    let (_dir, pool) = fixture().await;
    let owner = crate::core::db_state::DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let parent = OperationPermit::begin_turn(owner, "source", "turn")
        .await
        .unwrap();
    let input = || RecordToolInvocationInput {
        identity: ToolInvocationIdentity {
            conversation_id: "source".into(),
            turn_id: "turn".into(),
            message_id: "message".into(),
            call_id: "call".into(),
        },
        tool_name: "write".into(),
        effect_class: ToolEffectClass::WorkspaceMutation,
        arguments: serde_json::json!({"path":"synthetic.txt"}),
        remote_execution_id: None,
    };
    // Leave a child whose legacy journal row is absent. The existing unique
    // identity constraint must fail after record_on_connection inserted it.
    sqlx::query("INSERT INTO chat_admission_operations(operation_id,conversation_id,incarnation,parent_id,runtime_generation,kind,phase,turn_id,message_id,call_id) SELECT 'synthetic-conflict',conversation_id,incarnation,operation_id,runtime_generation,'tool','unknown',turn_id,'message','call' FROM chat_admission_operations WHERE parent_id IS NULL")
        .execute(&pool).await.unwrap();
    let error = parent.record_tool(input()).await.unwrap_err();
    assert!(
        error.to_string().contains("UNIQUE constraint failed"),
        "{error}"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM tool_invocations")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    sqlx::query("DELETE FROM chat_admission_operations WHERE operation_id='synthetic-conflict'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(parent.record_tool(input()).await.unwrap().is_new);
    assert!(!parent.record_tool(input()).await.unwrap().is_new);
    let linked: (String, String, String) = sqlx::query_as("SELECT p.phase,p.message_id,p.call_id FROM chat_admission_operations p JOIN tool_invocations t ON t.conversation_id=p.conversation_id AND t.turn_id=p.turn_id AND t.message_id=p.message_id AND t.call_id=p.call_id WHERE p.kind='tool'").fetch_one(&pool).await.unwrap();
    assert_eq!(
        linked,
        ("dispatched".into(), "message".into(), "call".into())
    );
    assert!(parent
        .finish_response(response_write("not finished"))
        .await
        .is_err());
}
