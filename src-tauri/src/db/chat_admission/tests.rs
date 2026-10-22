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
        .child(WorkKind::Provider, Some("request"))
        .await
        .unwrap();
    assert!(parent
        .child(WorkKind::Provider, Some("request"))
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
        .child(WorkKind::Provider, Some("late"))
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
        .child(WorkKind::Provider, Some("request"))
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
