use super::version;
use crate::db::{conversation_content, create_pool};
use sqlx::{Connection, SqliteConnection, SqlitePool};
use tempfile::TempDir;

pub(crate) async fn remove_reference_schema_in(db: &mut SqliteConnection) {
    crate::db::chat_admission::remove_reference_schema_in(db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM schema_migrations WHERE version=17")
        .execute(&mut *db)
        .await
        .unwrap();
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'e_source_version_*'",
    )
    .fetch_all(&mut *db)
    .await
    .unwrap();
    for name in names {
        sqlx::query(sqlx::AssertSqlSafe(format!("DROP TRIGGER {name}")))
            .execute(&mut *db)
            .await
            .unwrap();
    }
    sqlx::raw_sql("DROP TABLE e_source_relations; DROP TABLE e_source_fragments; DROP TABLE e_source_fields; DROP TABLE e_source_captures; DROP TABLE e_source_version; DELETE FROM schema_migrations WHERE version=16;").execute(db).await.unwrap();
}
async fn fixture() -> (TempDir, SqlitePool) {
    let dir = TempDir::new().unwrap();
    let pool = create_pool(&dir.path().join("source.db")).await.unwrap();
    sqlx::raw_sql("INSERT INTO conversations(id,title,scope_mode,created_at,updated_at) VALUES('s','Synthetic','Chat','t','t'),('other','Other','Chat','t','t'); INSERT INTO messages(id,conversation_id,role,content,created_at,turn_id) VALUES('m','s','user','history','t','turn'),('m2','other','user','history','t','turn2');").execute(&pool).await.unwrap();
    (dir, pool)
}
async fn token(pool: &SqlitePool) -> version::Version {
    version::token(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap()
}
const INSERTS: &[&str] = &[
"INSERT INTO conversation_compactions(conversation_id,up_to_message_id,summary_text,tool_digest_json,used_source_passage_ids_json,interesting_source_passage_ids_json,estimated_tokens_before,estimated_tokens_after,fingerprint,created_at,updated_at) VALUES('s','m','summary','[]','[]','[]',1,1,'hash','t','t')",
"INSERT INTO conversation_citations(id,conversation_id,message_id,type,scope,source,title,created_at,updated_at) VALUES('c','other','toolbox-only','document','context','synthetic','citation','t','t')",
"INSERT INTO conversation_toolbox_state VALUES('s','[]','t','t')",
"INSERT INTO pilot_message_attachments VALUES('a','owner','instance','ref','m','file.txt','text/plain',1,'hash',X'61')",
"INSERT INTO pilot_file_sends(owner_key,ref_key,send_intent_id,scope_key,digest,message_id,turn_id,state,attachment_ids_json,context_state,intent_expires_at) VALUES('owner','ref','intent','scope','hash','m','turn','confirmed','[\"a\"]','ready',1)",
];
#[tokio::test]
async fn global_version_observes_all_five_families_without_changing_c1_c2() {
    let (_dir, pool) = fixture().await;
    let c2 = crate::db::conversation_catalog::conversation_catalog_version(
        &pool,
        &"0".repeat(32),
        &crate::db::models::ConversationCatalogVersionInput::default(),
    )
    .await
    .unwrap();
    let c1 = conversation_content::conversation_content_version(&pool, "s")
        .await
        .unwrap();
    let mut before = token(&pool).await;
    for sql in INSERTS {
        sqlx::query(*sql).execute(&pool).await.unwrap();
        let next = token(&pool).await;
        assert_ne!(before, next);
        before = next;
    }
    for sql in ["UPDATE conversation_compactions SET summary_text=summary_text", "UPDATE conversation_citations SET title=title", "UPDATE conversation_toolbox_state SET composer_context_refs_json=composer_context_refs_json", "UPDATE pilot_message_attachments SET owner_key='not-projected'", "UPDATE pilot_file_sends SET scope_key='not-projected'"] {
        sqlx::query(sql).execute(&pool).await.unwrap(); let next=token(&pool).await; assert_ne!(before,next); before=next;
    }
    for table in [
        "conversation_compactions",
        "conversation_citations",
        "conversation_toolbox_state",
        "pilot_message_attachments",
        "pilot_file_sends",
    ] {
        sqlx::query(sqlx::AssertSqlSafe(format!("DELETE FROM {table}")))
            .execute(&pool)
            .await
            .unwrap();
        let next = token(&pool).await;
        assert_ne!(before, next);
        before = next;
    }
    assert_eq!(
        c1,
        conversation_content::conversation_content_version(&pool, "s")
            .await
            .unwrap()
    );
    assert_eq!(
        c2,
        crate::db::conversation_catalog::conversation_catalog_version(
            &pool,
            &"0".repeat(32),
            &crate::db::models::ConversationCatalogVersionInput::default()
        )
        .await
        .unwrap()
    );
    let before = token(&pool).await;
    sqlx::query("INSERT INTO e_source_captures(capture_id,binding_json,phase,revision,family,cursor_field,cursor_offset,row_ordinal,fields_count,rows_count,bytes_received,charge_bytes,created_at,progressed_at,expires_at,idle_ms,last_clock) VALUES('00000000-0000-0000-0000-000000000000','{}',0,0,0,0,0,0,0,0,0,216,0,0,1,1,0)").execute(&pool).await.unwrap();
    assert_eq!(before, token(&pool).await);
}
#[tokio::test]
async fn replace_move_rollback_and_rollover_cannot_reuse_a_version() {
    let (_dir, pool) = fixture().await;
    for sql in INSERTS {
        sqlx::query(*sql).execute(&pool).await.unwrap();
    }
    let mut before = token(&pool).await;
    for sql in [
        "INSERT OR REPLACE INTO conversation_citations(rowid,id,conversation_id,message_id,type,scope,source,title,created_at,updated_at) SELECT rowid,'replacement','s','missing','document','context','synthetic','new','t','t' FROM conversation_citations WHERE id='c'",
        "UPDATE conversation_citations SET conversation_id='other'",
        "UPDATE conversation_citations SET conversation_id='s'",
        "INSERT INTO pilot_file_sends(owner_key,ref_key,send_intent_id,scope_key,digest,message_id,turn_id,state,attachment_ids_json,context_state,intent_expires_at) VALUES('other','other','other','other','hash','m2','turn2','confirmed','[]','ready',1)",
        "UPDATE OR REPLACE pilot_file_sends SET message_id='m2' WHERE message_id='m'",
    ] { sqlx::query(sql).execute(&pool).await.unwrap(); let next=token(&pool).await; assert_ne!(before,next); before=next; }
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("DELETE FROM conversation_citations")
        .execute(&mut *tx)
        .await
        .unwrap();
    assert_ne!(before, version::token(&mut tx).await.unwrap());
    tx.rollback().await.unwrap();
    assert_eq!(before, token(&pool).await);
    sqlx::query("UPDATE e_source_version SET revision=9223372036854775807")
        .execute(&pool)
        .await
        .unwrap();
    let before = token(&pool).await;
    sqlx::query("UPDATE conversation_citations SET title=title")
        .execute(&pool)
        .await
        .unwrap();
    let next = token(&pool).await;
    assert_eq!(next.revision, 0);
    assert_ne!(before.incarnation, next.incarnation);
}
#[tokio::test]
async fn trusted_schema_refuses_missing_altered_or_malformed_objects_without_repair() {
    let (_dir, pool) = fixture().await;
    let mut db = pool.acquire().await.unwrap();
    version::validate_schema(&mut db).await.unwrap();
    sqlx::query("PRAGMA ignore_check_constraints=ON")
        .execute(&mut *db)
        .await
        .unwrap();
    sqlx::query("UPDATE e_source_version SET incarnation=printf('%.*c',100000,'x')")
        .execute(&mut *db)
        .await
        .unwrap();
    assert!(version::validate_schema(&mut db).await.is_err());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT length(incarnation) FROM e_source_version")
            .fetch_one(&mut *db)
            .await
            .unwrap(),
        100000
    );
    sqlx::query("UPDATE e_source_version SET incarnation=lower(hex(randomblob(16)))")
        .execute(&mut *db)
        .await
        .unwrap();
    sqlx::query("DROP TRIGGER e_source_version_conversation_citations_update")
        .execute(&mut *db)
        .await
        .unwrap();
    assert!(version::validate_schema(&mut db).await.is_err());
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM sqlite_master WHERE name='e_source_version_conversation_citations_update'").fetch_one(&mut *db).await.unwrap(),0);
}
#[tokio::test]
async fn migration16_and_its_stamp_roll_back_together() {
    let (dir, pool) = fixture().await;
    remove_reference_schema_in(&mut *pool.acquire().await.unwrap()).await;
    sqlx::query("CREATE TRIGGER reject_source_stamp BEFORE INSERT ON schema_migrations WHEN NEW.version=16 BEGIN SELECT RAISE(ABORT,'synthetic stamp failure'); END").execute(&pool).await.unwrap();
    pool.close().await;
    assert!(create_pool(&dir.path().join("source.db")).await.is_err());
    let mut db = SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(dir.path().join("source.db")),
    )
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM sqlite_master WHERE name GLOB 'e_source_*'"
        )
        .fetch_one(&mut db)
        .await
        .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM schema_migrations WHERE version=16")
            .fetch_one(&mut db)
            .await
            .unwrap(),
        0
    );
    sqlx::query("DROP TRIGGER reject_source_stamp")
        .execute(&mut db)
        .await
        .unwrap();
    db.close().await.unwrap();
    let pool = create_pool(&dir.path().join("source.db")).await.unwrap();
    version::validate_schema(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
}

#[path = "owner_tests.rs"]
mod owner_tests;
