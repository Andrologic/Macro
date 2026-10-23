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
    runtime.open_browser(owner.clone(), "window", "browser").await.unwrap();
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
            owner.clone(),
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
    let fingerprint = runtime::completion_fingerprint("response", &response_write("saved")).unwrap();
    assert!(runtime::replay_completion(&owner, "window", &context, "source", &fingerprint).await.unwrap());
    runtime.acknowledge_completion(&owner, "window", &context, "source").await.unwrap();
    runtime.acknowledge_completion(&owner, "window", &context, "source").await.unwrap();
    assert!(runtime.parent("window", &context, "source").await.is_err());
    drop(runtime);
    // A lost IPC ACK can be replayed after destruction of all live handles.
    assert!(runtime::replay_completion(&owner, "window", &context, "source", &fingerprint).await.unwrap());
    assert!(!runtime::replay_completion(&owner, "other-window", &context, "source", &fingerprint).await.unwrap());
    assert!(runtime::replay_completion(&owner, "window", &context, "source", "response:different").await.is_err());
    let replacement = runtime::ChatAdmissionRuntime::default();
    assert!(replacement.parent("window", &context, "source").await.is_err());

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
    let tool = parent.tool_permit(&input().identity).await.unwrap();
    let physical = tool
        .child(WorkKind::Tool, Some("physical-write"))
        .await
        .unwrap();
    physical.dispatched().await.unwrap();
    assert!(parent
        .finish_tool(input().identity, Some("receipt".into()))
        .await
        .is_err());
    physical.result_pending().await.unwrap();
    physical.completed().await.unwrap();
    parent
        .finish_tool(input().identity, Some("receipt".into()))
        .await
        .unwrap();
    parent
        .finish_tool(input().identity, Some("receipt".into()))
        .await
        .unwrap();
    assert!(parent
        .finish_tool(input().identity, Some("different-receipt".into()))
        .await
        .is_err());
    assert!(tool
        .child(WorkKind::Tool, Some("late-write"))
        .await
        .is_err());
    let mut uncertain = input();
    uncertain.identity.call_id = "uncertain-call".into();
    let identity = uncertain.identity.clone();
    parent.record_tool(uncertain).await.unwrap();
    parent.finish_tool(identity.clone(), None).await.unwrap();
    assert!(parent
        .finish_tool(identity, Some("late-receipt".into()))
        .await
        .is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn tool_task_owns_a_real_child_and_waits_for_cleanup_before_its_receipt() {
    use crate::db::tool_invocations::{
        RecordToolInvocationInput, ToolEffectClass, ToolInvocationIdentity,
    };
    use tokio::io::AsyncBufReadExt;
    let (_dir, pool) = fixture().await;
    let owner = crate::core::db_state::DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let parent = OperationPermit::begin_turn(owner, "source", "turn")
        .await
        .unwrap();
    let identity = ToolInvocationIdentity {
        conversation_id: "source".into(),
        turn_id: "turn".into(),
        message_id: "message".into(),
        call_id: "process-call".into(),
    };
    parent
        .record_tool(RecordToolInvocationInput {
            identity: identity.clone(),
            tool_name: "terminal_run".into(),
            effect_class: ToolEffectClass::ExternalEffect,
            arguments: serde_json::json!({"synthetic":true}),
            remote_execution_id: None,
        })
        .await
        .unwrap();
    let tool = parent.tool_permit(&identity).await.unwrap();
    let physical = std::sync::Arc::new(
        tool.child(WorkKind::Tool, Some("physical-process"))
            .await
            .unwrap(),
    );
    let state = crate::ai::AiState::default();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, cleanup) = tokio::sync::oneshot::channel();
    let result = state
        .reserve_stream("physical-process".into())
        .unwrap()
        .spawn_tool(physical, move |cancel| async move {
            let mut child = tokio::process::Command::new("/bin/sh")
                .args(["-c", "printf 'synthetic-ready\n' >&2; exec sleep 30"])
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let mut stderr = tokio::io::BufReader::new(child.stderr.take().unwrap()).lines();
            assert_eq!(
                stderr.next_line().await.unwrap().as_deref(),
                Some("synthetic-ready")
            );
            started.send(()).unwrap();
            cancel.cancelled().await;
            child.start_kill().unwrap();
            child.wait().await.unwrap();
            assert!(stderr.next_line().await.unwrap().is_none());
            cleanup.await.unwrap();
            Ok::<_, String>("physical cleanup finished")
        })
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), ready)
        .await
        .unwrap()
        .unwrap();
    let cancelling_state = state.clone();
    let mut cancelled = tokio::spawn(async move {
        cancelling_state
            .cancel_stream_task("physical-process")
            .await
    });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(30), &mut cancelled)
            .await
            .is_err()
    );
    assert!(parent
        .finish_tool(identity.clone(), Some("premature".into()))
        .await
        .is_err());
    release.send(()).unwrap();
    cancelled.await.unwrap().unwrap();
    assert_eq!(result.await.unwrap().unwrap(), "physical cleanup finished");
    assert!(state.join_stream_task("physical-process").await.is_none());
    // Physical cancellation is not a claim that arbitrary shell effects did not occur.
    parent.finish_tool(identity.clone(), None).await.unwrap();
    assert!(parent
        .finish_tool(identity, Some("invented-success".into()))
        .await
        .is_err());
}

#[tokio::test]
async fn browser_retirement_joins_owned_work_and_preserves_uncertainty() {
    use std::sync::Arc;
    let (_dir, pool) = fixture().await;
    let owner = crate::core::db_state::DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let runtime = Arc::new(runtime::ChatAdmissionRuntime::default());
    let context = runtime.begin(owner.clone(), "window", "browser", "source", "turn").await.unwrap();
    assert!(runtime.open_browser(owner.clone(), "second", "other").await.is_err());
    let parent = runtime.parent("window", &context, "source").await.unwrap();
    let work = Arc::new(parent.child(WorkKind::Tool, Some("browser-child")).await.unwrap());
    let ai = crate::ai::AiState::default();
    let http = Arc::new(crate::ai::admitted_http::AdmittedHttp::default());
    let (started, ready) = tokio::sync::oneshot::channel();
    let (cancelled, observed) = tokio::sync::oneshot::channel();
    let (release, cleanup) = tokio::sync::oneshot::channel();
    let result = ai.reserve_stream("browser-child".into()).unwrap().spawn_tool(work, move |cancel| async move {
        started.send(()).unwrap();
        cancel.cancelled().await;
        cancelled.send(()).unwrap();
        cleanup.await.unwrap();
        Ok::<_, String>(())
    }).unwrap();
    ready.await.unwrap();
    let closing_runtime = runtime.clone();
    let closing_owner = owner.clone();
    let closing_ai = ai.clone();
    let closing_http = http.clone();
    let mut closing = tokio::spawn(async move {
        closing_runtime.close_browser(&closing_owner, &closing_ai, &closing_http, "window", "browser").await
    });
    observed.await.unwrap();
    assert!(runtime.parent("window", &context, "source").await.is_err());
    assert!(tokio::time::timeout(std::time::Duration::from_millis(30), &mut closing).await.is_err());
    let phase: String = sqlx::query_scalar("SELECT phase FROM chat_admission_browsers WHERE runtime='browser'").fetch_one(&pool).await.unwrap();
    assert_eq!(phase, "retiring");
    release.send(()).unwrap();
    closing.await.unwrap().unwrap();
    assert!(result.await.is_err());
    assert!(ai.join_stream_task("browser-child").await.is_none());
    let phases: Vec<String> = sqlx::query_scalar("SELECT phase FROM chat_admission_operations WHERE request_id='browser-child'").fetch_all(&pool).await.unwrap();
    assert_eq!(phases, ["unknown"]);
    runtime.close_browser(&owner, &ai, &http, "window", "browser").await.unwrap();
    assert!(runtime.open_browser(owner.clone(), "window", "browser").await.is_err());
    runtime.open_browser(owner.clone(), "window", "fresh-browser").await.unwrap();
    // A new browser does not reconcile an uncertain provider/tool context.
    assert!(runtime.parent("window", &context, "source").await.is_err());
}

#[tokio::test]
async fn browser_close_before_registration_tombstones_delayed_open() {
    let (_dir, pool) = fixture().await;
    let owner = crate::core::db_state::DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let runtime = runtime::ChatAdmissionRuntime::default();
    let ai = crate::ai::AiState::default();
    let http = crate::ai::admitted_http::AdmittedHttp::default();
    runtime.close_browser(&owner, &ai, &http, "window", "delayed").await.unwrap();
    runtime.close_browser(&owner, &ai, &http, "window", "delayed").await.unwrap();
    assert!(runtime.open_browser(owner.clone(), "window", "delayed").await.is_err());
    assert!(runtime.close_browser(&owner, &ai, &http, "other", "delayed").await.is_err());
    runtime.open_browser(owner, "window", "fresh").await.unwrap();
}

#[tokio::test]
async fn browser_retirement_removes_http_receiver_after_real_transport_join() {
    use crate::ai::{admitted_http::{AdmittedHttp, HttpPart}, provider_work::{ProviderAdmission, ProviderWork, tests::HttpServer}, AiState};
    let (_dir, pool) = fixture().await;
    let owner = crate::core::db_state::DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let runtime = runtime::ChatAdmissionRuntime::default();
    let context = runtime.begin(owner.clone(), "window", "browser", "source", "turn").await.unwrap();
    let work = std::sync::Arc::new(ProviderWork::admit(&pool, &runtime, "window", ProviderAdmission::GlobalChat { context }, Some("source"), "browser-http").await.unwrap());
    let server = HttpServer::start(vec![Some("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")]).await;
    let ai = AiState::default();
    let http = AdmittedHttp::default();
    let client = reqwest::Client::new();
    let request = client.post(&server.url).body("synthetic").build().unwrap();
    http.start("window", "browser-http".into(), ai.reserve_stream("browser-http".into()).unwrap(), work, "synthetic-provider".into(), client, request).await.unwrap();
    assert!(matches!(http.read("window", "browser-http").await.unwrap(), HttpPart::Headers { .. }));
    assert!(matches!(http.read("window", "browser-http").await.unwrap(), HttpPart::Bytes { .. }));
    assert!(matches!(http.read("window", "browser-http").await.unwrap(), HttpPart::End));
    // The browser disappears before the codec ACK. EOF alone cannot complete it.
    runtime.close_browser(&owner, &ai, &http, "window", "browser").await.unwrap();
    assert!(http.read("window", "browser-http").await.is_err());
    assert!(ai.join_stream_task("browser-http").await.is_none());
    let phases: Vec<String> = sqlx::query_scalar("SELECT phase FROM chat_admission_operations WHERE kind='provider'").fetch_all(&pool).await.unwrap();
    assert_eq!(phases, ["unknown", "unknown"]);
    assert_eq!(server.stop().await, 1);
}

#[tokio::test]
async fn cancellation_while_writer_is_locked_never_polls_the_tool_executor() {
    use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
    let (_dir, pool) = fixture().await;
    let owner = crate::core::db_state::DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let parent = OperationPermit::begin_turn(owner, "source", "turn").await.unwrap();
    let tool = Arc::new(parent.child(WorkKind::Tool, Some("pre-poll")).await.unwrap());
    let mut writer = pool.acquire().await.unwrap();
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *writer).await.unwrap();
    let ai = crate::ai::AiState::default();
    let polled = Arc::new(AtomicBool::new(false));
    let execution = polled.clone();
    let result = ai.reserve_stream("pre-poll".into()).unwrap().spawn_tool(tool, move |_| async move {
        execution.store(true, Ordering::SeqCst);
        Ok::<_, String>(())
    }).unwrap();
    // Cancellation owns the pre-registered task even while SQLite holds it.
    let cancelling = ai.clone();
    let mut joined = tokio::spawn(async move { cancelling.cancel_stream_task("pre-poll").await });
    assert!(tokio::time::timeout(std::time::Duration::from_millis(30), &mut joined).await.is_err());
    sqlx::query("COMMIT").execute(&mut *writer).await.unwrap();
    joined.await.unwrap().unwrap();
    assert!(result.await.is_err());
    assert!(!polled.load(Ordering::SeqCst));
    let phase: String = sqlx::query_scalar("SELECT phase FROM chat_admission_operations WHERE request_id='pre-poll'").fetch_one(&pool).await.unwrap();
    assert_eq!(phase, "no_effect");
}


#[tokio::test]
async fn native_page_change_retires_an_open_still_waiting_for_sqlite() {
    let (_dir, pool) = fixture().await;
    let owner = crate::core::db_state::DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let runtime = runtime::ChatAdmissionRuntime::default();
    let ai = crate::ai::AiState::default();
    let http = crate::ai::admitted_http::AdmittedHttp::default();
    let mut writer = pool.acquire().await.unwrap();
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *writer).await.unwrap();
    let opening = runtime.open_browser(owner.clone(), "window", "old-browser");
    tokio::pin!(opening);
    assert!(futures::poll!(opening.as_mut()).is_pending());
    let page = runtime.invalidate_page("window");
    sqlx::query("COMMIT").execute(&mut *writer).await.unwrap();
    assert!(opening.await.is_err());
    runtime.close_previous_page(&owner, &ai, &http, "window", &page).await.unwrap();
    runtime.open_browser(owner.clone(), "window", "new-browser").await.unwrap();
    // A delayed callback for an older page must not close this replacement.
    runtime.close_previous_page(&owner, &ai, &http, "window", "older-page").await.unwrap();
    runtime.begin_root(owner, "window", "new-browser", "source", "turn", "attempt", RootWorkKind::Turn).await.unwrap();
}


#[tokio::test]
async fn tool_constructor_panic_is_durable_unknown_and_releases_registration() {
    let (_dir, pool) = fixture().await;
    let owner = crate::core::db_state::DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let parent = OperationPermit::begin_turn(owner, "source", "turn").await.unwrap();
    let tool = std::sync::Arc::new(parent.child(WorkKind::Tool, Some("constructor-panic")).await.unwrap());
    let ai = crate::ai::AiState::default();
    let result = ai.reserve_stream("constructor-panic".into()).unwrap().spawn_tool(tool, |_| {
        panic!("synthetic constructor panic");
        #[allow(unreachable_code)]
        std::future::ready(Ok::<(), String>(()))
    }).unwrap();
    assert!(result.await.is_err());
    assert!(ai.join_stream_task("constructor-panic").await.is_none());
    let phase: String = sqlx::query_scalar("SELECT phase FROM chat_admission_operations WHERE request_id='constructor-panic'").fetch_one(&pool).await.unwrap();
    assert_eq!(phase, "unknown");
}

#[tokio::test]
async fn intent_receipts_survive_lost_ack_and_refuse_stale_browser_revisions() {
    use super::intents::{IntentIdentity, IntentKind, IntentMutation};
    let (_dir, pool) = fixture().await;
    let owner = crate::core::db_state::DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let runtime = runtime::ChatAdmissionRuntime::default();
    runtime.open_browser(owner.clone(), "window", "old").await.unwrap();
    let identity = IntentIdentity { conversation_id: "source".into(), kind: IntentKind::Queue, id: "queued".into() };
    let first = runtime.begin_intent(&owner, "window", "old", identity.clone(), IntentMutation::Retain).await.unwrap();
    let repeated = runtime.begin_intent(&owner, "window", "old", identity.clone(), IntentMutation::Retain).await.unwrap();
    assert_eq!(first.operation_id, repeated.operation_id);
    assert_eq!(first.revision + 1, repeated.revision);
    runtime.close_browser(&owner, &crate::ai::AiState::default(), &crate::ai::admitted_http::AdmittedHttp::default(), "window", "old").await.unwrap();
    runtime.open_browser(owner.clone(), "window", "new").await.unwrap();
    let retained = runtime.begin_intent(&owner, "window", "new", identity.clone(), IntentMutation::Retain).await.unwrap();
    assert_eq!(retained.operation_id, first.operation_id);
    assert_eq!(retained.revision, repeated.revision + 1);
    assert!(runtime.finish_intent(&owner, "window", &first).await.is_err());
    runtime.finish_intent(&owner, "window", &retained).await.unwrap();
    runtime.finish_intent(&owner, "window", &retained).await.unwrap();
    let replay = runtime.begin_intent(&owner, "window", "new", identity.clone(), IntentMutation::Remove).await.unwrap();
    runtime.finish_intent(&owner, "window", &replay).await.unwrap();
    assert!(runtime.begin_intent(&owner, "window", "new", identity, IntentMutation::Retain).await.is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM chat_admission_operations WHERE kind='queue' AND phase='completed'").fetch_one(&pool).await.unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn queued_intent_is_claimed_atomically_and_cannot_relaunch_after_retirement() {
    use super::intents::{IntentIdentity, IntentKind, IntentMutation};
    let (_dir, pool) = fixture().await;
    let owner = crate::core::db_state::DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let runtime = runtime::ChatAdmissionRuntime::default();
    runtime.open_browser(owner.clone(), "window", "old").await.unwrap();
    let identity = IntentIdentity { conversation_id: "source".into(), kind: IntentKind::Queue, id: "queued".into() };
    let before = runtime.begin_intent(&owner, "window", "old", identity.clone(), IntentMutation::Retain).await.unwrap();
    let parent = runtime.begin(owner.clone(), "window", "old", "source", "queued").await.unwrap();
    let claimed: (String, String) = sqlx::query_as("SELECT parent_id,phase FROM chat_admission_operations WHERE operation_id=?").bind(&before.operation_id).fetch_one(&pool).await.unwrap();
    assert_eq!(claimed, (parent.handle, "result_pending".into()));
    assert!(runtime.finish_intent(&owner, "window", &before).await.is_err());
    runtime.close_browser(&owner, &crate::ai::AiState::default(), &crate::ai::admitted_http::AdmittedHttp::default(), "window", "old").await.unwrap();
    runtime.open_browser(owner.clone(), "window", "new").await.unwrap();
    let removal = runtime.begin_intent(&owner, "window", "new", identity, IntentMutation::Remove).await.unwrap();
    assert!(runtime.begin(owner.clone(), "window", "new", "source", "queued").await.is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM chat_admission_operations WHERE kind='turn'").fetch_one(&pool).await.unwrap();
    assert_eq!(count, 1, "the refused claim must roll back the new parent");
    runtime.finish_intent(&owner, "window", &removal).await.unwrap();
}

#[tokio::test]
async fn approval_registry_cas_preserves_other_chats_and_reserves_generic_writers() {
    use super::intents::{self, IntentIdentity, IntentKind, IntentMutation};
    let (_dir, pool) = fixture().await;
    sqlx::query("INSERT INTO conversations(id,title,scope_mode,created_at,updated_at) VALUES('other','Other','Chat','t','t')").execute(&pool).await.unwrap();
    sqlx::query("UPDATE chat_admission_owners SET mode='frozen' WHERE conversation_id='other'").execute(&pool).await.unwrap();
    let before = r#"{"version":1,"requests":{"other":{"opaque":"preserved"}}}"#;
    sqlx::query("INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,'t')").bind(intents::APPROVAL_REGISTRY_KEY).bind(before).execute(&pool).await.unwrap();
    let owner = crate::core::db_state::DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let runtime = runtime::ChatAdmissionRuntime::default();
    runtime.open_browser(owner.clone(), "window", "browser").await.unwrap();
    let receipt = runtime.begin_intent(&owner, "window", "browser", IntentIdentity {
        conversation_id: "source".into(), kind: IntentKind::Approval, id: "approval-call".into(),
    }, IntentMutation::Retain).await.unwrap();
    let after = r#"{"version":1,"requests":{"other":{"opaque":"preserved"},"source":{"opaque":"new"}}}"#;
    intents::write_approval_registry(&owner, "window", "source", Some(&receipt), Some(before), Some(after)).await.unwrap();
    intents::write_approval_registry(&owner, "window", "source", Some(&receipt), Some(before), Some(after)).await.unwrap();
    let foreign = r#"{"version":1,"requests":{"other":{"opaque":"changed"},"source":{"opaque":"new"}}}"#;
    assert!(intents::write_approval_registry(&owner, "window", "source", Some(&receipt), Some(after), Some(foreign)).await.is_err());
    assert!(intents::write_approval_registry(&owner, "window", "source", None, Some(after), Some(before)).await.is_err());
    assert!(intents::write_approval_registry(&owner, "window", "source", Some(&receipt), None, Some(before)).await.is_err());
    assert!(repository::set_app_setting(&pool, intents::APPROVAL_REGISTRY_KEY, "{}").await.is_err());
    assert!(repository::delete_app_setting(&pool, intents::APPROVAL_REGISTRY_KEY).await.is_err());
    assert!(repository::compare_and_swap_app_setting(&pool, intents::APPROVAL_REGISTRY_KEY, Some(after), "{}").await.is_err());
    let stored = repository::get_app_setting(&pool, intents::APPROVAL_REGISTRY_KEY).await.unwrap().unwrap();
    assert_eq!(stored.value_json, after);
    intents::write_approval_registry(&owner, "window", "source", Some(&receipt), Some(after), Some(before)).await.unwrap();
    runtime.finish_intent(&owner, "window", &receipt).await.unwrap();
}

#[tokio::test]
async fn deleted_chat_allows_only_orphan_copy_cleanup_without_clearing_unknown_effects() {
    use super::intents::{self, IntentIdentity, IntentKind, IntentMutation, IntentScope};
    let (_dir, pool) = fixture().await;
    let owner = crate::core::db_state::DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let runtime = runtime::ChatAdmissionRuntime::default();
    runtime.open_browser(owner.clone(), "window", "browser").await.unwrap();
    let receipt = runtime.begin_intent(&owner, "window", "browser", IntentIdentity {
        conversation_id: "source".into(), kind: IntentKind::Queue, id: "waiting".into(),
    }, IntentMutation::Retain).await.unwrap();
    let parent = OperationPermit::begin_turn(owner.clone(), "source", "active-turn").await.unwrap();
    let provider = parent.provider_invocation("request").await.unwrap();
    provider.dispatched().await.unwrap();
    provider.unknown().await.unwrap();
    repository::delete_conversation(&pool, "source").await.unwrap();
    let mut connection = pool.acquire().await.unwrap();
    assert_eq!(intents::classify_copy(&mut connection, "source", IntentMutation::Remove).await.unwrap(), IntentScope::Removed);
    assert!(intents::classify_copy(&mut connection, "source", IntentMutation::Retain).await.is_err());
    drop(connection);
    assert!(OperationPermit::begin_turn(owner, "source", "forbidden").await.is_err());
    let phases: Vec<(String, String)> = sqlx::query_as("SELECT kind,phase FROM chat_admission_operations WHERE conversation_id='source' ORDER BY kind").fetch_all(&pool).await.unwrap();
    assert!(phases.contains(&("provider".into(), "unknown".into())));
    assert!(phases.iter().any(|(kind,phase)| kind=="queue" && phase!="completed"));
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM chat_admission_operations WHERE operation_id=?").bind(receipt.operation_id).fetch_one(&pool).await.unwrap(), 1);
}

#[tokio::test]
async fn approval_opaque_root_is_preserved_verbatim_without_granting_reconciliation() {
    use super::intents::{self, IntentIdentity, IntentKind, IntentMutation};
    let (_dir, pool) = fixture().await;
    let opaque = "{unreadable";
    sqlx::query("INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,'t')").bind(intents::APPROVAL_REGISTRY_KEY).bind(opaque).execute(&pool).await.unwrap();
    let owner = crate::core::db_state::DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let runtime = runtime::ChatAdmissionRuntime::default();
    runtime.open_browser(owner.clone(), "window", "browser").await.unwrap();
    let receipt = runtime.begin_intent(&owner, "window", "browser", IntentIdentity {
        conversation_id: "source".into(), kind: IntentKind::Approval, id: "new".into(),
    }, IntentMutation::Retain).await.unwrap();
    let preserved = serde_json::json!({"version":1,"preservedData":[{"valueJson":opaque}],"requests":{"source":{"opaque":"current"}}}).to_string();
    let lost = serde_json::json!({"version":1,"requests":{"source":{"opaque":"current"}}}).to_string();
    assert!(intents::write_approval_registry(&owner, "window", "source", Some(&receipt), Some(opaque), Some(&lost)).await.is_err());
    intents::write_approval_registry(&owner, "window", "source", Some(&receipt), Some(opaque), Some(&preserved)).await.unwrap();
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT browser_reconciled FROM chat_admission_owners WHERE conversation_id='source'").fetch_one(&pool).await.unwrap(),0);
}

#[tokio::test]
async fn steer_handoff_requires_completed_provider_and_same_persisted_turn() {
    use super::intents::{self, IntentIdentity, IntentKind, IntentMutation};
    let (_dir, pool) = fixture().await;
    let owner = crate::core::db_state::DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let runtime = runtime::ChatAdmissionRuntime::default();
    let context = runtime.begin(owner.clone(), "window", "browser", "source", "turn").await.unwrap();
    let parent = runtime.parent("window", &context, "source").await.unwrap();
    let receipt = runtime.begin_intent(&owner, "window", "browser", IntentIdentity {
        conversation_id: "source".into(), kind: IntentKind::Steer, id: "steer-message".into(),
    }, IntentMutation::Retain).await.unwrap();
    sqlx::query("INSERT INTO messages(id,conversation_id,role,content,created_at,turn_id) VALUES('steer-message','source','user','Direction','t','turn')").execute(&pool).await.unwrap();
    assert!(runtime.finish_intent(&owner, "window", &receipt).await.is_err());
    let provider = parent.provider_invocation("request").await.unwrap();
    assert!(intents::complete_steer_handoff(&parent, "window", "request", &[receipt.clone()]).await.is_err());
    provider.dispatched().await.unwrap();
    provider.result_pending().await.unwrap();
    provider.completed().await.unwrap();
    intents::complete_steer_handoff(&parent, "window", "request", &[receipt.clone()]).await.unwrap();
    intents::complete_steer_handoff(&parent, "window", "request", &[receipt.clone()]).await.unwrap();
    assert!(intents::complete_steer_handoff(&parent, "other-window", "request", &[receipt.clone()]).await.is_err());
    let unknown = parent.provider_invocation("unknown-request").await.unwrap();
    unknown.dispatched().await.unwrap();
    unknown.unknown().await.unwrap();
    assert!(intents::complete_steer_handoff(&parent, "window", "unknown-request", &[receipt]).await.is_err());
}

#[tokio::test]
async fn questionnaire_handoff_requires_the_persisted_answer_and_admitted_parent() {
    use super::intents::{self, IntentIdentity, IntentKind, IntentMutation};
    let (_dir, pool) = fixture().await;
    let owner = crate::core::db_state::DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let runtime = runtime::ChatAdmissionRuntime::default();
    runtime.open_browser(owner.clone(), "window", "browser").await.unwrap();
    let question = runtime.begin_intent(&owner, "window", "browser", IntentIdentity {
        conversation_id: "source".into(), kind: IntentKind::Question, id: "message".into(),
    }, IntentMutation::Retain).await.unwrap();
    assert!(runtime.finish_intent(&owner, "window", &question).await.is_err());
    let context = runtime.begin(owner.clone(), "window", "browser", "source", "reply-turn").await.unwrap();
    let parent = runtime.parent("window", &context, "source").await.unwrap();
    assert!(intents::complete_question_handoff(&parent, "window", &question, "reply").await.is_err());
    sqlx::query("INSERT INTO messages(id,conversation_id,role,content,created_at,turn_id) VALUES('reply','source','user','Human answer','t','reply-turn')").execute(&pool).await.unwrap();
    intents::complete_question_handoff(&parent, "window", &question, "reply").await.unwrap();
    intents::complete_question_handoff(&parent, "window", &question, "reply").await.unwrap();
    assert!(intents::complete_question_handoff(&parent, "other-window", &question, "reply").await.is_err());
    let state: (String, String, String) = sqlx::query_as("SELECT phase,parent_id,message_id FROM chat_admission_operations WHERE operation_id=?")
        .bind(&question.operation_id).fetch_one(&pool).await.unwrap();
    assert_eq!(state, ("completed".into(), context.handle, "reply".into()));
    let provider = parent.provider_invocation("not-dispatched").await.unwrap();
    assert!(parent.no_effect().await.is_err());
    provider.no_effect().await.unwrap();
    // The human answer can remain saved even if later preparation has no effect.
    // Closing this parent never claims a provider/tool effect succeeded.
    parent.no_effect().await.unwrap();
}

#[tokio::test]
async fn response_recovery_reservation_survives_browser_loss_and_never_closes_unknown_provider() {
    use super::intents::{self, IntentMutation};
    for uncertain in [false, true] {
        let (_dir, pool) = fixture().await;
        let owner = crate::core::db_state::DbPool::default();
        owner.set_ready(pool.clone()).await.unwrap();
        let runtime = runtime::ChatAdmissionRuntime::default();
        let context = runtime.begin(owner.clone(), "window", "old", "source", "turn").await.unwrap();
        let parent = runtime.parent("window", &context, "source").await.unwrap();
        let receipt = intents::reserve_response(&parent, "window", "message").await.unwrap();
        assert_eq!(intents::reserve_response(&parent, "window", "message").await.unwrap().operation_id, receipt.operation_id);
        assert!(intents::reserve_response(&parent, "window", "missing").await.is_err());
        let child = parent.provider_invocation("request").await.unwrap();
        child.dispatched().await.unwrap();
        if uncertain { child.unknown().await.unwrap(); }
        else { child.result_pending().await.unwrap(); child.completed().await.unwrap(); }
        runtime.close_browser(&owner, &crate::ai::AiState::default(), &crate::ai::admitted_http::AdmittedHttp::default(), "window", "old").await.unwrap();
        runtime.open_browser(owner.clone(), "window", "new").await.unwrap();
        // An empty browser observation cannot erase an unknown provider, nor
        // certify a completed provider whose response copy was never persisted.
        let inspection = runtime.begin_reconciliation(&owner,"window","new","source").await.unwrap();
        let error = runtime.complete_reconciliation(&owner,"window","new",&inspection,&no_browser_intentions()).await.unwrap_err().to_string();
        assert!(error.contains(if uncertain {"work_unreconciled"} else {"response_recovery_missing"}), "{error}");
        assert!(runtime.reserve_reconciled_source(&owner,"window","new",&inspection).await.is_err());
        assert_eq!(sqlx::query_scalar::<_,String>("SELECT phase FROM chat_admission_operations WHERE operation_id=?").bind(&receipt.operation_id).fetch_one(&pool).await.unwrap(), "prepared");
        let identity = intents::response_recovery_identity(&owner, "source", "message").await.unwrap();
        assert_eq!(identity.id, context.handle);
        let recovered = runtime.begin_intent(&owner, "window", "new", identity, IntentMutation::Retain).await.unwrap();
        assert!(intents::recover_response(&owner, "wrong-window", &recovered, response_write("saved")).await.is_err());
        let result = intents::recover_response(&owner, "window", &recovered, response_write("saved")).await;
        assert_eq!(result.is_err(), uncertain, "{result:?}");
        if uncertain {
            assert_eq!(sqlx::query_scalar::<_,String>("SELECT phase FROM chat_admission_operations WHERE request_id='request'").fetch_one(&pool).await.unwrap(), "unknown");
            assert_eq!(sqlx::query_scalar::<_,String>("SELECT content FROM messages WHERE id='message'").fetch_one(&pool).await.unwrap(), "history");
        } else {
            // Lost recovery ACK replays the same native writer receipt. The
            // remaining browser copy still blocks another turn until removal.
            intents::recover_response(&owner, "window", &recovered, response_write("saved")).await.unwrap();
            assert!(runtime.begin(owner.clone(), "window", "new", "source", "next").await.is_err());
            runtime.finish_intent(&owner, "window", &recovered).await.unwrap();
            runtime.finish_intent(&owner, "window", &recovered).await.unwrap();
            runtime.begin(owner.clone(), "window", "new", "source", "next").await.unwrap();
        }
    }
}

#[tokio::test]
async fn preparation_receipt_waits_for_metadata_and_replays_after_handle_ack() {
    for uncertain in [false, true] {
        let (_dir, pool) = fixture().await;
        let owner = crate::core::db_state::DbPool::default();
        owner.set_ready(pool.clone()).await.unwrap();
        let runtime = runtime::ChatAdmissionRuntime::default();
        let context = runtime.begin(owner.clone(), "window", "browser", "source", "turn").await.unwrap();
        let parent = runtime.parent("window", &context, "source").await.unwrap();
        let metadata = parent.provider_invocation("metadata-request").await.unwrap();
        assert!(runtime.close_preparation("window", &context, "source").await.is_err());
        metadata.dispatched().await.unwrap();
        if uncertain { metadata.unknown().await.unwrap(); }
        else { metadata.result_pending().await.unwrap(); metadata.completed().await.unwrap(); }
        let result = runtime.close_preparation("window", &context, "source").await;
        assert_eq!(result.is_err(), uncertain);
        if !uncertain {
            let fingerprint = runtime::completion_fingerprint("preparation", &()).unwrap();
            assert!(runtime::replay_completion(&owner, "window", &context, "source", &fingerprint).await.unwrap());
            runtime.acknowledge_completion(&owner, "window", &context, "source").await.unwrap();
            assert!(runtime.parent("window", &context, "source").await.is_err());
            assert!(runtime::replay_completion(&owner, "window", &context, "source", &fingerprint).await.unwrap());
            assert_eq!(sqlx::query_scalar::<_,String>("SELECT phase FROM chat_admission_operations WHERE operation_id=?").bind(&context.handle).fetch_one(&pool).await.unwrap(), "completed");
        }
    }
}

#[tokio::test]
async fn recovery_draft_can_reopen_but_old_receipts_cannot_close_new_writes() {
    use super::intents::{IntentIdentity, IntentKind, IntentMutation};
    let (_dir, pool) = fixture().await;
    let owner = crate::core::db_state::DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let runtime = runtime::ChatAdmissionRuntime::default();
    runtime.open_browser(owner.clone(), "window", "browser").await.unwrap();
    let identity = IntentIdentity { conversation_id: "source".into(), kind: IntentKind::Recovery, id: "questionnaire-draft".into() };
    let first = runtime.begin_intent(&owner,"window","browser",identity.clone(),IntentMutation::Retain).await.unwrap();
    let revision: i64 = sqlx::query_scalar("SELECT revision FROM chat_admission_owners WHERE conversation_id='source'").fetch_one(&pool).await.unwrap();
    let changed = runtime.begin_intent(&owner,"window","browser",identity.clone(),IntentMutation::Retain).await.unwrap();
    assert!(runtime.finish_intent(&owner,"window",&first).await.is_err());
    assert!(sqlx::query_scalar::<_,i64>("SELECT revision FROM chat_admission_owners WHERE conversation_id='source'").fetch_one(&pool).await.unwrap()>revision);
    runtime.finish_intent(&owner,"window",&changed).await.unwrap();
    let reopened = runtime.begin_intent(&owner,"window","browser",identity.clone(),IntentMutation::Retain).await.unwrap();
    assert_eq!(reopened.operation_id,first.operation_id);
    assert!(runtime.finish_intent(&owner,"window",&changed).await.is_err());
    runtime.finish_intent(&owner,"window",&reopened).await.unwrap();
    hold_restored_profile(&pool).await.unwrap();
    assert!(runtime.begin_intent(&owner,"window","browser",identity,IntentMutation::Retain).await.is_err());
}

fn no_browser_intentions() -> super::reconciliation::BrowserInspection {
    super::reconciliation::BrowserInspection { queue:vec![],unsaved:vec![],approvals:vec![],questions:vec![],drafts:vec![],steers:vec![] }
}

#[tokio::test]
async fn real_reservation_competes_with_admission_and_ordinary_writer() {
    for competing_writer in [false,true] {
        let (_dir,pool)=fixture().await;
        let owner=crate::core::db_state::DbPool::default(); owner.set_ready(pool.clone()).await.unwrap();
        let runtime=runtime::ChatAdmissionRuntime::default(); runtime.open_browser(owner.clone(),"window","browser").await.unwrap();
        let handle=runtime.begin_reconciliation(&owner,"window","browser","source").await.unwrap();
        assert!(runtime.reserve_reconciled_source(&owner,"window","browser",&handle).await.is_err());
        runtime.complete_reconciliation(&owner,"window","browser",&handle,&no_browser_intentions()).await.unwrap();
        // A lost inspection ACK is replayable, with no effect dispatch capability.
        runtime.complete_reconciliation(&owner,"window","browser",&handle,&no_browser_intentions()).await.unwrap();
        if competing_writer {
            let (reserved,written)=tokio::join!(runtime.reserve_reconciled_source(&owner,"window","browser",&handle),repository::rename_conversation(&pool,"source","changed"));
            assert_ne!(reserved.is_ok(),written.is_ok());
        } else {
            let (reserved,admitted)=tokio::join!(runtime.reserve_reconciled_source(&owner,"window","browser",&handle),OperationPermit::begin_turn(owner.clone(),"source","competing"));
            assert_ne!(reserved.is_ok(),admitted.is_ok());
        }
    }
}

#[tokio::test]
async fn inspection_revision_and_pending_browser_copies_refuse_reservation() {
    use super::intents::{IntentIdentity,IntentKind,IntentMutation};
    let (_dir,pool)=fixture().await;
    let owner=crate::core::db_state::DbPool::default();owner.set_ready(pool.clone()).await.unwrap();
    let runtime=runtime::ChatAdmissionRuntime::default();runtime.open_browser(owner.clone(),"window","browser").await.unwrap();
    let handle=runtime.begin_reconciliation(&owner,"window","browser","source").await.unwrap();
    let mut observed=no_browser_intentions();observed.drafts.push("message".into());
    assert!(runtime.complete_reconciliation(&owner,"window","browser",&handle,&observed).await.is_err());
    let copy=runtime.begin_intent(&owner,"window","browser",IntentIdentity{conversation_id:"source".into(),kind:IntentKind::Recovery,id:"questionnaire-draft".into()},IntentMutation::Retain).await.unwrap();
    assert!(runtime.complete_reconciliation(&owner,"window","browser",&handle,&no_browser_intentions()).await.is_err());
    runtime.finish_intent(&owner,"window",&copy).await.unwrap();
    let current=runtime.begin_reconciliation(&owner,"window","browser","source").await.unwrap();
    assert!(runtime.complete_reconciliation(&owner,"other","browser",&current,&no_browser_intentions()).await.is_err());
    runtime.complete_reconciliation(&owner,"window","browser",&current,&no_browser_intentions()).await.unwrap();
    runtime.reserve_reconciled_source(&owner,"window","browser",&current).await.unwrap();
    assert!(repository::rename_conversation(&pool,"source","forbidden").await.is_err());
    assert!(runtime.begin(owner,"window","browser","source","late").await.is_err());
}

#[tokio::test]
async fn question_ack_loss_and_orphan_before_dispatch_reconcile_without_another_send() {
    use super::intents::{self,IntentIdentity,IntentKind,IntentMutation};
    for orphan_response in [false,true] {
        let (_dir,pool)=fixture().await;
        let owner=crate::core::db_state::DbPool::default();owner.set_ready(pool.clone()).await.unwrap();
        let runtime=runtime::ChatAdmissionRuntime::default();runtime.open_browser(owner.clone(),"window","old").await.unwrap();
        let context=runtime.begin(owner.clone(),"window","old","source","reply").await.unwrap();
        let parent=runtime.parent("window",&context,"source").await.unwrap();
        if orphan_response {
            sqlx::query("INSERT INTO messages(id,conversation_id,role,content,created_at,turn_id) VALUES('orphan','source','assistant','','t','reply')").execute(&pool).await.unwrap();
            intents::reserve_response(&parent,"window","orphan").await.unwrap();
        } else {
            let question=runtime.begin_intent(&owner,"window","old",IntentIdentity{conversation_id:"source".into(),kind:IntentKind::Question,id:"message".into()},IntentMutation::Retain).await.unwrap();
            sqlx::query("INSERT INTO messages(id,conversation_id,role,content,created_at,turn_id) VALUES('answer','source','user','Human answer','t','reply')").execute(&pool).await.unwrap();
            intents::complete_question_handoff(&parent,"window",&question,"answer").await.unwrap();
            // COMMIT succeeded but the browser receives no ACK and closes preparation.
            runtime.close_preparation("window",&context,"source").await.unwrap();
        }
        drop(parent);
        runtime.close_browser(&owner,&crate::ai::AiState::default(),&crate::ai::admitted_http::AdmittedHttp::default(),"window","old").await.unwrap();
        runtime.open_browser(owner.clone(),"window","new").await.unwrap();
        let handle=runtime.begin_reconciliation(&owner,"window","new","source").await.unwrap();
        runtime.complete_reconciliation(&owner,"window","new",&handle,&no_browser_intentions()).await.unwrap();
        runtime.reserve_reconciled_source(&owner,"window","new",&handle).await.unwrap();
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM chat_admission_operations WHERE kind='provider'").fetch_one(&pool).await.unwrap(),0);
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM messages WHERE id='answer'").fetch_one(&pool).await.unwrap(),if orphan_response {0}else{1});
    }
}

#[tokio::test]
async fn reservation_attests_pool_connections_and_only_blocks_correlated_goal_writers() {
    let (_dir,pool)=fixture().await;
    let mut connections=Vec::new();
    for _ in 0..5 { connections.push(pool.acquire().await.unwrap()); }
    for connection in &mut connections {
        assert_eq!(sqlx::query_scalar::<_,i64>("PRAGMA recursive_triggers").fetch_one(&mut **connection).await.unwrap(),1);
        assert_eq!(sqlx::query_scalar::<_,i64>("PRAGMA trusted_schema").fetch_one(&mut **connection).await.unwrap(),1);
    }
    drop(connections);
    sqlx::raw_sql("INSERT INTO conversations(id,title,scope_mode,created_at,updated_at) VALUES('other','Other','Chat','t','t');
        INSERT INTO conversation_goals(rowid,goal_id,conversation_id,revision,objective,success_criteria_json,status,created_at,updated_at) VALUES(-1,'goal','source',1,'Goal','[]','active_ready','t','t');").execute(&pool).await.unwrap();
    let owner=crate::core::db_state::DbPool::default();owner.set_ready(pool.clone()).await.unwrap();
    let runtime=runtime::ChatAdmissionRuntime::default();runtime.open_browser(owner.clone(),"window","browser").await.unwrap();
    let handle=runtime.begin_reconciliation(&owner,"window","browser","source").await.unwrap();
    assert!(runtime.complete_reconciliation(&owner,"window","browser",&handle,&no_browser_intentions()).await.is_err());
    sqlx::query("UPDATE conversation_goals SET status='achieved' WHERE goal_id='goal'").execute(&pool).await.unwrap();
    runtime.complete_reconciliation(&owner,"window","browser",&handle,&no_browser_intentions()).await.unwrap();
    runtime.reserve_reconciled_source(&owner,"window","browser",&handle).await.unwrap();
    sqlx::query("INSERT INTO conversation_goals(goal_id,conversation_id,revision,objective,success_criteria_json,status,created_at,updated_at) VALUES('other-goal','other',1,'Other','[]','active_ready','t','t')").execute(&pool).await.unwrap();
    sqlx::query("UPDATE conversation_goals SET objective='Still writable' WHERE goal_id='other-goal'").execute(&pool).await.unwrap();
    assert!(sqlx::query("INSERT OR REPLACE INTO conversation_goals(rowid,goal_id,conversation_id,revision,objective,success_criteria_json,status,created_at,updated_at) VALUES(-1,'replacement','other',1,'Replacement','[]','achieved','t','t')").execute(&pool).await.is_err());
    assert!(sqlx::query("UPDATE conversation_goals SET objective='forbidden' WHERE goal_id='goal'").execute(&pool).await.is_err());
    let mut connection=pool.acquire().await.unwrap();
    sqlx::query("PRAGMA recursive_triggers=OFF").execute(&mut *connection).await.unwrap();
    // No global Goal guard was added: an unrelated mutation stays permitted.
    // This does not claim REPLACE-victim protection on an external OFF connection.
    sqlx::query("UPDATE conversation_goals SET objective='Unrelated' WHERE goal_id='other-goal'").execute(&mut *connection).await.unwrap();
    sqlx::query("PRAGMA recursive_triggers=ON").execute(&mut *connection).await.unwrap();
}

#[tokio::test]
async fn reservation_resolves_cross_audit_run_links_and_guards_their_writers() {
    for through_link in [false,true] {
        let (_dir,pool)=fixture().await;
        sqlx::raw_sql("INSERT INTO conversations(id,title,scope_mode,created_at,updated_at) VALUES('other','Other','Chat','t','t');
            INSERT INTO agent_runs(id,parent_conversation_id,agent_profile,depth,status,prompt,attempt_count,created_at,updated_at,started_at,finished_at) VALUES
              ('source-run','source','synthetic',1,'completed','Synthetic',1,'t','t','t','t'),
              ('other-run','other','synthetic',1,'completed','Synthetic',1,'t','t','t','t');
            INSERT INTO agent_runs(id,parent_conversation_id,agent_profile,depth,status,prompt,created_at,updated_at) VALUES('unrelated','other','synthetic',1,'queued','Unrelated','t','t');
            INSERT INTO conversation_goals(goal_id,conversation_id,revision,objective,success_criteria_json,status,created_at,updated_at) VALUES('other-goal','other',1,'Other','[]','achieved','t','t');")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO conversation_goal_audits(audit_id,conversation_id,goal_id,goal_revision,executor_turn_id,current_run_id,status,created_at,updated_at) VALUES('audit','other','other-goal',1,'turn',?,'ready_for_verdict','t','t')")
            .bind(if through_link {"other-run"}else{"source-run"}).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO conversation_goal_audit_runs(audit_id,run_id,attempt,linked_at) VALUES('audit',?,1,'t')")
            .bind(if through_link {"source-run"}else{"other-run"}).execute(&pool).await.unwrap();
        assert!(sqlx::query("PRAGMA foreign_key_check").fetch_all(&pool).await.unwrap().is_empty());
        let owner=crate::core::db_state::DbPool::default();owner.set_ready(pool.clone()).await.unwrap();
        let runtime=runtime::ChatAdmissionRuntime::default();runtime.open_browser(owner.clone(),"window","browser").await.unwrap();
        let handle=runtime.begin_reconciliation(&owner,"window","browser","source").await.unwrap();
        assert!(runtime.complete_reconciliation(&owner,"window","browser",&handle,&no_browser_intentions()).await.unwrap_err().to_string().contains("related_work_pending"));
        sqlx::query("UPDATE conversation_goal_audits SET status='applied' WHERE audit_id='audit'").execute(&pool).await.unwrap();
        runtime.complete_reconciliation(&owner,"window","browser",&handle,&no_browser_intentions()).await.unwrap();
        // The final reservation re-reads relations in its own transaction.
        sqlx::query("UPDATE conversation_goal_audits SET status='queued' WHERE audit_id='audit'").execute(&pool).await.unwrap();
        assert!(runtime.reserve_reconciled_source(&owner,"window","browser",&handle).await.unwrap_err().to_string().contains("related_work_pending"));
        sqlx::query("UPDATE conversation_goal_audits SET status='applied' WHERE audit_id='audit'").execute(&pool).await.unwrap();
        runtime.reserve_reconciled_source(&owner,"window","browser",&handle).await.unwrap();
        assert!(sqlx::query("UPDATE agent_runs SET prompt='forbidden' WHERE id='other-run'").execute(&pool).await.is_err());
        assert!(sqlx::query("DELETE FROM conversation_goal_audit_runs WHERE audit_id='audit'").execute(&pool).await.is_err());
        assert!(sqlx::query("UPDATE conversation_goal_audits SET status='queued' WHERE audit_id='audit'").execute(&pool).await.is_err());
        sqlx::query("UPDATE agent_runs SET prompt='Still independent' WHERE id='unrelated'").execute(&pool).await.unwrap();
    }
}

#[tokio::test]
async fn independent_turn_waits_for_real_descendant_cleanup_and_preserves_unknown_tool() {
    use std::sync::Arc;
    use tokio::io::AsyncBufReadExt;
    use crate::db::tool_invocations::{RecordToolInvocationInput,ToolInvocationIdentity,ToolEffectClass};
    let (_dir,pool)=fixture().await;
    let owner=crate::core::db_state::DbPool::default();owner.set_ready(pool.clone()).await.unwrap();
    let runtime=Arc::new(runtime::ChatAdmissionRuntime::default());
    let context=runtime.begin(owner.clone(),"window","browser","source","turn").await.unwrap();
    let parent=runtime.parent("window",&context,"source").await.unwrap();
    let provider=parent.provider_attempt_with_boundary("lost-provider","provider","context",ProviderBoundary::IndependentRequest).await.unwrap();
    provider.dispatched().await.unwrap();provider.settle_provider_return(&Err("lost ACK".into())).await.unwrap();drop(provider);
    let identity=ToolInvocationIdentity{conversation_id:"source".into(),turn_id:"turn".into(),message_id:"message".into(),call_id:"tool".into()};
    parent.record_tool(RecordToolInvocationInput{identity:identity.clone(),tool_name:"terminal_run".into(),effect_class:ToolEffectClass::ExternalEffect,arguments:serde_json::json!({}),remote_execution_id:None}).await.unwrap();
    let ai=crate::ai::AiState::default();let http=Arc::new(crate::ai::admitted_http::AdmittedHttp::default());
    let reservation=ai.reserve_stream("descendant".into()).unwrap();
    let marker=parent.tool_permit(&identity).await.unwrap();
    let physical=Arc::new(marker.child(WorkKind::Tool,Some("descendant")).await.unwrap());drop(marker);
    let (started,ready)=tokio::sync::oneshot::channel();
    let (cancelled,observed)=tokio::sync::oneshot::channel();
    let (release,cleanup)=tokio::sync::oneshot::channel();
    let result=reservation.spawn_tool(physical,move |cancel|async move {
        let mut child=tokio::process::Command::new("/bin/sh").args(["-c","printf 'synthetic-ready\n' >&2; exec sleep 30"])
            .stderr(std::process::Stdio::piped()).kill_on_drop(true).spawn().unwrap();
        let mut stderr=tokio::io::BufReader::new(child.stderr.take().unwrap()).lines();
        assert_eq!(stderr.next_line().await.unwrap().as_deref(),Some("synthetic-ready"));started.send(()).unwrap();
        cancel.cancelled().await;child.start_kill().unwrap();child.wait().await.unwrap();
        assert!(stderr.next_line().await.unwrap().is_none());cancelled.send(()).unwrap();
        cleanup.await.unwrap();Ok::<_,String>(())
    }).unwrap();
    ready.await.unwrap();
    let r=runtime.clone();let o=owner.clone();let a=ai.clone();let h=http.clone();
    let mut closing=tokio::spawn(async move {r.retire_previous_unknown_turns(&o,&a,&h,"window","browser","source","new-user-turn").await});
    observed.await.unwrap();
    assert!(tokio::time::timeout(std::time::Duration::from_millis(30),&mut closing).await.is_err());
    assert!(owner.set_ready(pool.clone()).await.unwrap_err().message.contains("generation_busy"));
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT local_closed_at IS NULL FROM chat_admission_operations WHERE operation_id=?").bind(&context.handle).fetch_one(&pool).await.unwrap(),1);
    assert!(OperationPermit::begin_turn(owner.clone(),"source","new-user-turn").await.is_err());
    release.send(()).unwrap();closing.await.unwrap().unwrap();assert!(result.await.is_err());
    assert!(runtime.parent("window",&context,"source").await.is_err());
    assert!(runtime.begin(owner.clone(),"window","browser","source","turn").await.is_err());
    let next=runtime.begin(owner.clone(),"window","browser","source","new-user-turn").await.unwrap();
    let next_parent=runtime.parent("window",&next,"source").await.unwrap();
    assert!(next_parent.provider_attempt("opaque","provider","context").await.is_err());
    let independent=next_parent.provider_attempt_with_boundary("independent","provider","context",ProviderBoundary::IndependentRequest).await.unwrap();
    independent.no_effect().await.unwrap();
    // The old unknown tool does not prevent this distinct turn's real writer.
    sqlx::query("INSERT INTO messages(id,conversation_id,role,content,turn_id,created_at) VALUES('next-message','source','assistant','','new-user-turn','t')").execute(&pool).await.unwrap();
    let mut write=response_write("New response");write.id="next-message";write.turn_id=Some("new-user-turn".into());
    next_parent.finish_response(write).await.unwrap();
    assert_eq!(sqlx::query_scalar::<_,String>("SELECT status FROM tool_invocations WHERE call_id='tool'").fetch_one(&pool).await.unwrap(),"unknown");
    let inspection=runtime.begin_reconciliation(&owner,"window","browser","source").await.unwrap();
    assert!(runtime.complete_reconciliation(&owner,"window","browser",&inspection,&no_browser_intentions()).await.is_err());
    assert!(runtime.reserve_reconciled_source(&owner,"window","browser",&inspection).await.is_err());
    drop(parent);drop(next_parent);drop(independent);
}

#[tokio::test]
async fn official_startup_closes_only_local_lifetime_and_keeps_same_turn_blocked() {
    let (_dir,pool)=fixture().await;
    let owner=crate::core::db_state::DbPool::default();owner.set_ready(pool.clone()).await.unwrap();
    let parent=OperationPermit::begin_turn(owner.clone(),"source","old-turn").await.unwrap();
    let attempt=parent.provider_attempt_with_boundary("attempt","provider","context",ProviderBoundary::IndependentRequest).await.unwrap();
    attempt.dispatched().await.unwrap();attempt.unknown().await.unwrap();drop(attempt);drop(parent);
    owner.set_initializing().await;
    reconcile_after_restart(&pool).await.unwrap();
    owner.set_ready(pool.clone()).await.unwrap();
    assert!(OperationPermit::begin_turn(owner.clone(),"source","old-turn").await.is_err());
    let next=OperationPermit::begin_turn(owner,"source","new-turn").await.unwrap();
    assert!(next.provider_attempt("opaque","provider","context").await.is_err());
    next.provider_attempt_with_boundary("fresh","provider","context",ProviderBoundary::IndependentRequest).await.unwrap();
    assert_eq!(sqlx::query_scalar::<_,String>("SELECT phase FROM chat_admission_operations WHERE request_id='attempt'").fetch_one(&pool).await.unwrap(),"unknown");
}

#[tokio::test]
async fn missing_physical_receipt_keeps_only_the_affected_chat_unreconciled() {
    use std::sync::Arc;
    for panic in [false,true] {
        let (_dir,pool)=fixture().await;
        let owner=crate::core::db_state::DbPool::default();owner.set_ready(pool.clone()).await.unwrap();
        let runtime=runtime::ChatAdmissionRuntime::default();
        let context=runtime.begin(owner.clone(),"window","browser","source","old").await.unwrap();
        let parent=runtime.parent("window",&context,"source").await.unwrap();
        let ai=crate::ai::AiState::default();
        let reservation=ai.reserve_stream("cleanup-failure".into()).unwrap();
        let work=Arc::new(parent.child(WorkKind::Tool,Some("cleanup-failure")).await.unwrap());
        let executed=work.clone();
        let received=reservation.spawn_tool(work,move |_|async move {
            if panic { panic!("synthetic cleanup panic"); }
            executed.unknown().await.unwrap();
            Err::<(),_>("synthetic cleanup failure".to_string())
        }).unwrap();
        assert!(received.await.is_err());
        let http=crate::ai::admitted_http::AdmittedHttp::default();
        assert!(runtime.retire_previous_unknown_turns(&owner,&ai,&http,"window","browser","source","next").await.unwrap_err().to_string().contains("local_lifetime_unreconciled"));
        assert!(runtime.begin(owner.clone(),"window","browser","source","next").await.is_err());
        drop(parent);drop(runtime);
        owner.set_initializing().await;reconcile_after_restart(&pool).await.unwrap();owner.set_ready(pool.clone()).await.unwrap();
        assert!(OperationPermit::begin_turn(owner.clone(),"source","after-restart").await.is_err());
        sqlx::query("INSERT INTO conversations(id,title,scope_mode,created_at,updated_at) VALUES('unrelated','Other','Chat','t','t')").execute(&pool).await.unwrap();
        OperationPermit::begin_turn(owner,"unrelated","independent").await.unwrap();
    }
}

#[tokio::test]
async fn opaque_provider_without_local_receipt_is_not_closed_by_restart() {
    let (_dir,pool)=fixture().await;
    let owner=crate::core::db_state::DbPool::default();owner.set_ready(pool.clone()).await.unwrap();
    let parent=OperationPermit::begin_turn(owner.clone(),"source","old").await.unwrap();
    let attempt=parent.provider_attempt("opaque","provider","bridge-session").await.unwrap();
    attempt.dispatched().await.unwrap();attempt.unknown().await.unwrap();drop(attempt);drop(parent);
    owner.set_initializing().await;reconcile_after_restart(&pool).await.unwrap();owner.set_ready(pool.clone()).await.unwrap();
    assert!(OperationPermit::begin_turn(owner,"source","new").await.is_err());
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM chat_admission_operations WHERE local_closed_at IS NOT NULL").fetch_one(&pool).await.unwrap(),0);
}
