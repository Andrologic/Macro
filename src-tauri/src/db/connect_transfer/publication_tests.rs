//! Real SQLite/E/017 storage proofs only. No canonical transport or AI builder
//! is simulated as product authority, and no provider call can occur here.
use super::*;
use crate::db::connect_transfer::{
    journal::tests as journal,
    publication::{publish, PublishWrite},
    terminal,
};
use crate::db::{
    self,
    inactive_storage::{self, Mime, RecordKind, Relation, Role},
};
fn bytes(hex: &str) -> Vec<u8> {
    hex.as_bytes()
        .chunks_exact(2)
        .map(|v| u8::from_str_radix(std::str::from_utf8(v).unwrap(), 16).unwrap())
        .collect()
}

#[tokio::test]
async fn connect_local_deletion_removes_payload_once_retains_receipts_and_rejects_archive_reuse() {
    let (_dir, pool, spec, allocation, store, key) = staged_with_history(vec![b'x'; 260_000]).await;
    fill(&pool, &spec, &allocation).await;
    pinned(&pool, &spec, &allocation).await;
    let input = publish_input(&pool, &spec, &allocation).await;
    let published = publish(&pool, &input).await.unwrap();
    let conversation = published.conversation_id.clone();
    let before = crate::db::inactive_budget::retained(&mut *pool.acquire().await.unwrap()).await.unwrap();
    assert!(db::repository::delete_conversation(&pool, &conversation).await.is_err());
    let owner = crate::core::db_state::DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let ids = [conversation.clone()];
    let (a,b) = tokio::join!(db::repository::delete_conversations_admitted(&owner, &ids), db::repository::delete_conversations_admitted(&owner, &ids));
    a.unwrap(); b.unwrap();
    let mut connection = pool.acquire().await.unwrap();
    for table in ["conversation_citations", "conversation_portable_archives", "connect_projection_messages", "connect_projection_citations", "connect_projection_assets", "connect_projection_fields", "connect_projection_fragments", "connect_projection_display", "connect_raw_prefix", "connect_raw_chunks", "e_inactive_records", "e_inactive_fragments", "e_inactive_mapping"] {
        let count: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}"))).fetch_one(&mut *connection).await.unwrap();
        assert_eq!(count, 0, "{table}");
    }
    for table in ["conversations", "messages"] {
        let column = if table == "conversations" { "id" } else { "conversation_id" };
        assert_eq!(sqlx::query_scalar::<_,i64>(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table} WHERE {column}=?"))).bind(&conversation).fetch_one(&mut *connection).await.unwrap(),0);
    }
    let after = crate::db::inactive_budget::retained(&mut connection).await.unwrap();
    assert!(after < before);
    let receipt: (Vec<u8>,Vec<u8>,String) = sqlx::query_as("SELECT receipt,fingerprint,phase FROM connect_local_deletions").fetch_one(&mut *connection).await.unwrap();
    assert_eq!(hash(&receipt.0), receipt.1); assert_eq!(receipt.2, "deleted");
    assert!(sqlx::query("PRAGMA foreign_key_check").fetch_all(&mut *connection).await.unwrap().is_empty());
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM message_search WHERE message_search MATCH 'Full'").fetch_one(&mut *connection).await.unwrap(),0);
    drop(connection);
    let repeated = publish(&pool, &input).await.unwrap();
    assert_eq!(repeated.receipt,published.receipt);
    assert_eq!(repeated.disposition,super::publication::LocalDisposition::Removed);
    assert!(store.status(&key).await.is_err());
    assert!(super::reader::page_in(&mut *pool.acquire().await.unwrap(),"g",&conversation,super::reader::Selector::All,None,1).await.is_err());
    db::repository::delete_conversations_admitted(&owner, &[conversation]).await.unwrap();
    assert_eq!(crate::db::inactive_budget::retained(&mut *pool.acquire().await.unwrap()).await.unwrap(),after);
    assert_eq!(sqlx::query_as::<_,(Vec<u8>,Vec<u8>,String)>("SELECT receipt,fingerprint,phase FROM connect_local_deletions").fetch_one(&pool).await.unwrap(),receipt);
    owner.set_initializing().await;
    owner.set_ready(pool.clone()).await.unwrap();
}

#[tokio::test]
async fn connect_local_deletion_rolls_back_all_copies_when_ordinary_delete_fails() {
    let (_dir,pool,spec,allocation,_store,_key)=staged().await;
    fill(&pool,&spec,&allocation).await;
    pinned(&pool,&spec,&allocation).await;
    let input=publish_input(&pool,&spec,&allocation).await;
    let published=publish(&pool,&input).await.unwrap();
    let owner=crate::core::db_state::DbPool::default();
    let before=crate::db::inactive_budget::retained(&mut *pool.acquire().await.unwrap()).await.unwrap();
    sqlx::raw_sql("CREATE TRIGGER test_refuse_local_delete BEFORE DELETE ON conversations BEGIN SELECT RAISE(ABORT,'injected_local_failure'); END;").execute(&pool).await.unwrap();
    owner.set_ready(pool.clone()).await.unwrap();
    let failure = db::repository::delete_conversations_admitted(&owner,&[published.conversation_id.clone()]).await.unwrap_err();
    assert!(failure.to_string().contains("injected_local_failure"),"{failure}");
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM connect_local_deletions").fetch_one(&pool).await.unwrap(),0);
    assert_eq!(crate::db::inactive_budget::retained(&mut *pool.acquire().await.unwrap()).await.unwrap(),before);
    assert_eq!(db::repository::list_messages(&pool,&published.conversation_id).await.unwrap().len(),2);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM e_inactive_records").fetch_one(&pool).await.unwrap(),3);
    // Test-only failure injection is removed, never an application guard.
    sqlx::raw_sql("DROP TRIGGER test_refuse_local_delete").execute(&pool).await.unwrap();
    assert!(db::repository::delete_conversations_admitted(&owner,&[published.conversation_id.clone()]).await.unwrap_err().to_string().contains("stale_revision"));
    owner.set_initializing().await; owner.set_ready(pool.clone()).await.unwrap();
    db::repository::delete_conversations_admitted(&owner,&[published.conversation_id]).await.unwrap();
}
#[test]
fn connect_projection_without_display_metadata_preserves_pre020_fingerprint_shape() {
    let header = Header::Message {
        role: "user".into(), created_at: "1970-01-01T00:00:00.000Z".into(), display_date: None,
    };
    assert_eq!(serde_json::to_string(&header).unwrap(), r#"{"Message":{"role":"user","created_at":"1970-01-01T00:00:00.000Z"}}"#);
}

#[tokio::test]
async fn connect_local_deletion_rejects_ambiguous_effects_from_an_old_incarnation() {
    let (_dir,pool,spec,allocation,_store,_key)=staged().await;
    fill(&pool,&spec,&allocation).await; pinned(&pool,&spec,&allocation).await;
    let input=publish_input(&pool,&spec,&allocation).await;
    let published=publish(&pool,&input).await.unwrap();
    let conversation=&published.conversation_id;
    let owner=crate::core::db_state::DbPool::default(); owner.set_ready(pool.clone()).await.unwrap();
    let before=db::inactive_budget::retained(&mut *pool.acquire().await.unwrap()).await.unwrap();
    // An old incarnation is deliberately different from the current owner.
    // This is operation storage only, never a provider request or capability.
    sqlx::query("INSERT INTO chat_admission_operations(operation_id,conversation_id,incarnation,runtime_generation,kind,phase,request_id) VALUES('old-ambiguous',?,'historical-incarnation','historical-generation','provider','unknown','historical-request')")
        .bind(conversation).execute(&pool).await.unwrap();
    for phase in ["unknown", "completed"] {
        sqlx::query("UPDATE chat_admission_operations SET phase=? WHERE operation_id='old-ambiguous'").bind(phase).execute(&pool).await.unwrap();
        assert!(db::repository::delete_conversations_admitted(&owner,&[conversation.clone()]).await.is_err());
        assert_eq!(db::inactive_budget::retained(&mut *pool.acquire().await.unwrap()).await.unwrap(),before);
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM connect_local_deletions").fetch_one(&pool).await.unwrap(),0);
        assert_eq!(db::repository::list_messages(&pool,conversation).await.unwrap().len(),2);
    }
    sqlx::query("UPDATE chat_admission_operations SET local_closed_at='2026-01-01' WHERE operation_id='old-ambiguous'").execute(&pool).await.unwrap();
    db::repository::delete_conversations_admitted(&owner,&[conversation.clone()]).await.unwrap();
}

#[tokio::test]
async fn connect_local_deletion_target_then_source_keeps_both_parentages_and_ceded_owner() {
    let (_dir,pool,spec,allocation,_store,_key)=staged().await;
    fill(&pool,&spec,&allocation).await; pinned(&pool,&spec,&allocation).await;
    let input=publish_input(&pool,&spec,&allocation).await;
    let published=publish(&pool,&input).await.unwrap();
    let conversation=&published.conversation_id;
    let (owner,outgoing)=journal::reserve_published_as_source(&pool,conversation).await;
    assert!(db::repository::delete_conversations_admitted(&owner,&[conversation.clone()]).await.is_err());
    terminal::commit_source_fixture(&pool,&outgoing).await;
    db::repository::delete_conversations_admitted(&owner,&[conversation.clone()]).await.unwrap();
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM connect_local_deletions WHERE conversation_id=? AND phase='deleted'").bind(conversation).fetch_one(&pool).await.unwrap(),2);
    assert_eq!(sqlx::query_scalar::<_,String>("SELECT mode FROM chat_admission_owners WHERE conversation_id=?").bind(conversation).fetch_one(&pool).await.unwrap(),"ceded");
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM e_inactive_records").fetch_one(&pool).await.unwrap(),0);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM connect_transfers").fetch_one(&pool).await.unwrap(),2);
    assert!(sqlx::query("PRAGMA foreign_key_check").fetch_all(&pool).await.unwrap().is_empty());
    assert_eq!(publish(&pool,&input).await.unwrap().disposition,super::publication::LocalDisposition::Removed);
    db::repository::delete_conversations_admitted(&owner,&[conversation.clone()]).await.unwrap();
}

#[tokio::test]
async fn connect_local_deletion_sqlite_full_after_payload_removal_rolls_back_every_copy() {
    let (dir,pool,spec,allocation,_store,_key)=staged_with_history(vec![b'x';260_000]).await;
    fill(&pool,&spec,&allocation).await; pinned(&pool,&spec,&allocation).await;
    let input=publish_input(&pool,&spec,&allocation).await;
    let published=publish(&pool,&input).await.unwrap();
    // Test-only page pressure, after F/E purge, forces the real SQLite pager to
    // fail with SQLITE_FULL inside the same ordinary deletion transaction.
    sqlx::raw_sql("CREATE TABLE test_local_delete_pressure(bytes BLOB); CREATE TRIGGER test_local_delete_pressure AFTER DELETE ON conversations BEGIN INSERT INTO test_local_delete_pressure VALUES(zeroblob(16777216)); END;").execute(&pool).await.unwrap();
    // max_page_count belongs to a connection. The ordinary fixture's pool has
    // several, so reopen with one to constrain the actual deletion writer.
    pool.close().await;
    let pool=sqlx::sqlite::SqlitePoolOptions::new().max_connections(1)
        .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(dir.path().join("journal.db"))
            .foreign_keys(true).pragma("recursive_triggers","ON").journal_mode(sqlx::sqlite::SqliteJournalMode::Wal))
        .await.unwrap();
    let owner=crate::core::db_state::DbPool::default(); owner.set_ready(pool.clone()).await.unwrap();
    let before=db::inactive_budget::retained(&mut *pool.acquire().await.unwrap()).await.unwrap();
    let pages:i64=sqlx::query_scalar("PRAGMA page_count").fetch_one(&pool).await.unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!("PRAGMA max_page_count={pages}"))).execute(&pool).await.unwrap();
    let error=db::repository::delete_conversations_admitted(&owner,&[published.conversation_id.clone()]).await.unwrap_err();
    assert!(error.to_string().contains("full"),"{error}");
    assert_eq!(db::inactive_budget::retained(&mut *pool.acquire().await.unwrap()).await.unwrap(),before);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM connect_local_deletions").fetch_one(&pool).await.unwrap(),0);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM test_local_delete_pressure").fetch_one(&pool).await.unwrap(),0);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM e_inactive_records").fetch_one(&pool).await.unwrap(),3);
    assert_eq!(db::repository::list_messages(&pool,&published.conversation_id).await.unwrap().len(),2);
    sqlx::raw_sql("DROP TRIGGER test_local_delete_pressure; DROP TABLE test_local_delete_pressure;").execute(&pool).await.unwrap();
    owner.set_initializing().await; owner.set_ready(pool.clone()).await.unwrap();
    db::repository::delete_conversations_admitted(&owner,&[published.conversation_id]).await.unwrap();
}

#[tokio::test]
#[ignore="subprocess entrypoint, called by connect_local_deletion_process_death_keeps_atomic_disposition"]
async fn connect_local_deletion_crash_child() {
    let path=std::env::var("MACRO_LOCAL_DELETION_CRASH_DB").unwrap();
    let conversation=std::env::var("MACRO_LOCAL_DELETION_CRASH_CONVERSATION").unwrap();
    let pool=db::create_pool(std::path::Path::new(&path)).await.unwrap();
    let owner=crate::core::db_state::DbPool::default(); owner.set_ready(pool).await.unwrap();
    db::repository::delete_conversations_admitted(&owner,&[conversation]).await.unwrap();
    panic!("deletion checkpoint was not reached");
}

#[tokio::test]
async fn connect_local_deletion_process_death_keeps_atomic_disposition() {
    for phase in ["before_commit","after_commit"] {
        let (dir,pool,spec,allocation,_store,_key)=staged().await;
        fill(&pool,&spec,&allocation).await; pinned(&pool,&spec,&allocation).await;
        let input=publish_input(&pool,&spec,&allocation).await;
        let published=publish(&pool,&input).await.unwrap();
        pool.close().await;
        let output=std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact","db::connect_transfer::preparation::tests::connect_local_deletion_crash_child","--ignored","--nocapture"])
            .env("MACRO_LOCAL_DELETION_CRASH_DB",dir.path().join("journal.db"))
            .env("MACRO_LOCAL_DELETION_CRASH_CONVERSATION",&published.conversation_id)
            .env("MACRO_LOCAL_DELETION_CRASH_PHASE",phase).output().unwrap();
        assert_eq!(output.status.code(),Some(92),"{}\n{}",String::from_utf8_lossy(&output.stdout),String::from_utf8_lossy(&output.stderr));
        let pool=db::create_pool(&dir.path().join("journal.db")).await.unwrap();
        let deleted=phase=="after_commit";
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM connect_local_deletions WHERE phase='deleted'").fetch_one(&pool).await.unwrap(),i64::from(deleted));
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM e_inactive_records").fetch_one(&pool).await.unwrap(),if deleted {0}else{3});
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM conversations WHERE id=?").bind(&published.conversation_id).fetch_one(&pool).await.unwrap(),i64::from(!deleted));
        assert!(sqlx::query("PRAGMA foreign_key_check").fetch_all(&pool).await.unwrap().is_empty());
        assert_eq!(sqlx::query_scalar::<_,String>("PRAGMA integrity_check").fetch_one(&pool).await.unwrap(),"ok");
        let owner=crate::core::db_state::DbPool::default(); owner.set_ready(pool.clone()).await.unwrap();
        db::repository::delete_conversations_admitted(&owner,&[published.conversation_id.clone()]).await.unwrap();
        let receipt:Vec<u8>=sqlx::query_scalar("SELECT receipt FROM connect_local_deletions").fetch_one(&pool).await.unwrap();
        db::repository::delete_conversations_admitted(&owner,&[published.conversation_id.clone()]).await.unwrap();
        assert_eq!(sqlx::query_scalar::<_,Vec<u8>>("SELECT receipt FROM connect_local_deletions").fetch_one(&pool).await.unwrap(),receipt);
        assert_eq!(publish(&pool,&input).await.unwrap().disposition,super::publication::LocalDisposition::Removed);
    }
}
async fn staged() -> (
    tempfile::TempDir,
    SqlitePool,
    Spec,
    Allocation,
    inactive_storage::InactiveStorage,
    String,
) {
    staged_with_history(b"History remains recoverable".to_vec()).await
}
async fn staged_with_history(history: Vec<u8>) -> (
    tempfile::TempDir, SqlitePool, Spec, Allocation,
    inactive_storage::InactiveStorage, String,
) {
    staged_with_resources(history,b"synthetic image bytes".to_vec()).await
}
async fn staged_with_resources(history:Vec<u8>,image:Vec<u8>) -> (
    tempfile::TempDir,SqlitePool,Spec,Allocation,inactive_storage::InactiveStorage,String,
) {
    let (dir, pool) = journal::fixture().await;
    let (transfer, begin_input) = journal::target_for_publication(&pool).await;
    let (store, key, sealed) = inactive_storage::tests::seal_transfer_fixture(
        pool.clone(),
        begin_input,
        vec![
            (
                RecordKind::Message { role: Role::User },
                history,
            ),
            (
                RecordKind::Asset {
                    mime: Mime::ImagePng,
                },
                image,
            ),
            (
                RecordKind::Association {
                    from: 0,
                    to: 1,
                    position: 0,
                    relation: Relation::AssetForMessage,
                },
                vec![],
            ),
        ],
    )
    .await;
    journal::attach_for_publication(&pool, &transfer, &key).await;
    let fp: Vec<u8> =
        sqlx::query_scalar("SELECT fingerprint FROM connect_transfers WHERE transfer_id=?")
            .bind(&transfer)
            .fetch_one(&pool)
            .await
            .unwrap();
    let spec = Spec {
        transfer_id: transfer,
        reservation_fingerprint: fp,
        import_key: key.clone(),
        import_revision: sealed.receipt.revision,
        lineage_id: uuid::Uuid::new_v4().to_string(),
        raw_manifest: vec![2; 32],
        portable_manifest: vec![3; 32],
        storage_manifest: bytes(&sealed.manifest_sha256),
        mapping_hash: bytes(sealed.receipt.mapping_sha256.as_ref().unwrap()),
        local_generation: "local-generation".into(),
        source_generation: "source-generation".into(),
        target_generation: "target-generation".into(),
        configuration_digest: vec![5; 32],
        preparators_digest: vec![6; 32],
        preparation_revision: 1,
        provider_id: "macro-ai".into(),
        model_id: "synthetic-model".into(),
        reasoning_effort: None,
        title: "Historical global chat".into(),
        created_at: "2026-01-01T00:00:00Z".into(),
        message_count: 2,
        citation_count: 1,
        asset_count: 1,
    };
    let allocation = begin(&pool, &spec).await.unwrap();
    (dir, pool, spec, allocation, store, key)
}
async fn put(
    pool: &SqlitePool,
    transfer: &str,
    ordinal: i64,
    source_ordinal: Option<i64>,
    header: Header,
    fields: &[(&str, &[u8])],
) -> String {
    let item = Entry {
        transfer_id: transfer.into(),
        ordinal,
        source_ordinal,
        header,
        fields: fields
            .iter()
            .map(|(name, data)| Field {
                name: (*name).into(),
                bytes: data.len() as i64,
                sha256: hash(data),
            })
            .collect(),
    };
    let id = entry(pool, &item).await.unwrap();
    assert_eq!(entry(pool, &item).await.unwrap(), id);
    for (field, data) in fields {
        for (n, page) in data.chunks(4093).enumerate() {
            let digest = hash(page);
            let f = Fragment {
                transfer,
                kind: item.header.kind(),
                ordinal,
                field,
                offset: (n * 4093) as i64,
                data: page,
                sha256: &digest,
            };
            append(pool, &f).await.unwrap();
            append(pool, &f).await.unwrap();
        }
    }
    id
}
async fn fill(pool: &SqlitePool, spec: &Spec, allocation: &Allocation) {
    fill_with_image(pool,spec,allocation,b"synthetic image bytes").await;
}
async fn fill_with_image(pool:&SqlitePool,spec:&Spec,allocation:&Allocation,image:&[u8]) {
    fill_projection(pool, spec, allocation, Some(DisplayDate {
        original_date: Some("2025-06-01T12:00:00Z".into()), inherited_from: None,
    }),image).await;
}
async fn fill_with_display(pool: &SqlitePool, spec: &Spec, allocation: &Allocation, display_date: Option<DisplayDate>) {
    fill_projection(pool,spec,allocation,display_date,b"synthetic image bytes").await;
}
async fn fill_projection(pool:&SqlitePool,spec:&Spec,allocation:&Allocation,display_date:Option<DisplayDate>,image:&[u8]) {
    put(
        pool,
        &spec.transfer_id,
        0,
        Some(0),
        Header::Message {
            display_date,
            role: "user".into(),
            created_at: "1970-01-01T00:00:00.000Z".into(),
        },
        &[("content", b"History remains recoverable")],
    )
    .await;
    let long = "Compacted fact café é🙂 recoveryneedle\n".repeat(2500);
    put(
        pool,
        &spec.transfer_id,
        1,
        None,
        Header::Message {
            display_date: None,
            role: "assistant".into(),
            created_at: "1970-01-01T00:00:00.001Z".into(),
        },
        &[("content", long.as_bytes())],
    )
    .await;
    put(
        pool,
        &spec.transfer_id,
        0,
        None,
        Header::Citation {
            message_ordinal: 0,
            r#type: "document".into(),
            scope: "context".into(),
            kind: None,
        },
        &[
            ("source", b"archive"),
            ("title", b"Historical source"),
            ("content", b"Complete citation text"),
        ],
    )
    .await;
    put(
        pool,
        &spec.transfer_id,
        0,
        Some(1),
        Header::Asset {
            message_ordinal: 0,
            position: 0,
            mime_type: "image/png".into(),
        },
        &[("data", image)],
    )
    .await;
    finish(pool, &spec.transfer_id, &allocation.fingerprint, &[9; 32])
        .await
        .unwrap();
}

pub(in crate::db::connect_transfer) async fn published_reader_fixture() -> (tempfile::TempDir,SqlitePool,String) {
    let image=include_bytes!("../../../icons/32x32.png");
    let (dir,pool,spec,allocation,_store,_key)=staged_with_resources("Original compacted fact café é🙂.\n".repeat(10_000).into_bytes(),image.to_vec()).await;
    fill_with_image(&pool,&spec,&allocation,image).await;
    pinned(&pool,&spec,&allocation).await;
    let input=publish_input(&pool,&spec,&allocation).await;
    let receipt=publish(&pool,&input).await.unwrap();
    (dir,pool,receipt.conversation_id)
}

#[tokio::test]
async fn connect_archive_origin_survives_all_product_reads_and_new_messages_are_ordinary() {
    let (dir, pool, spec, allocation, _store, _key) = staged().await;
    fill(&pool, &spec, &allocation).await;
    pinned(&pool, &spec, &allocation).await;
    let input = publish_input(&pool, &spec, &allocation).await;
    let published = publish(&pool, &input).await.unwrap();
    assert!(sqlx::query("UPDATE connect_projection_display SET original_date='2099-01-01T00:00:00Z'").execute(&pool).await.is_err());
    let conversation = &published.conversation_id;
    let publication_time: String = sqlx::query_scalar("SELECT published_at FROM connect_publication_times")
        .fetch_one(&pool).await.unwrap();
    assert!(!publication_time.starts_with("1970"));
    let before = db::repository::get_conversation(&pool, conversation).await.unwrap().unwrap();
    assert_eq!(before.updated_at, publication_time);
    for messages in [
        db::repository::list_messages(&pool, conversation).await.unwrap(),
        db::repository::list_messages_bounded(&pool, conversation).await.unwrap(),
        db::repository::list_all_messages(&pool).await.unwrap().into_iter().filter(|m| &m.conversation_id==conversation).collect(),
        db::repository::get_chat_bootstrap_snapshot(&pool, &[conversation.clone()]).await.unwrap().messages_by_conversation_id.remove(conversation).unwrap(),
    ] {
        assert_eq!(messages.len(), 2);
        let origin = messages[0].portable_history.as_ref().unwrap();
        assert_eq!(origin.ordinal, "0");
        assert_eq!(origin.display_date.as_deref(), Some("2025-06-01T12:00:00Z"));
        assert_eq!(messages[0].created_at, "1970-01-01T00:00:00.000Z");
        assert!(messages[1].portable_history.as_ref().unwrap().display_date.is_none());
        assert!(db::repository::get_message(&pool, &messages[0].id).await.unwrap().unwrap().portable_history.is_some());
    }
    pool.close().await;
    let pool = db::create_pool(&dir.path().join("journal.db")).await.unwrap();
    assert_eq!(db::repository::get_conversation(&pool, conversation).await.unwrap().unwrap().updated_at, publication_time);
    sqlx::query("INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES('ordinary',?,'user','New ordinary activity','2026-10-24T12:00:00Z')")
        .bind(conversation).execute(&pool).await.unwrap();
    let messages = db::repository::list_messages(&pool, conversation).await.unwrap();
    assert_eq!(messages.last().unwrap().id, "ordinary");
    assert!(messages.last().unwrap().portable_history.is_none());
    assert!(super::super::remove_reader_reference_in(&mut *pool.acquire().await.unwrap()).await.is_err());
}

#[tokio::test]
async fn connect_history_native_mutations_refuse_but_new_local_messages_remain_editable() {
    use db::repository::{self, UpdateMessageContentInput};
    let (_dir, pool, spec, allocation, _store, _key) = staged().await;
    fill(&pool, &spec, &allocation).await;
    pinned(&pool, &spec, &allocation).await;
    let input = publish_input(&pool, &spec, &allocation).await;
    let published = publish(&pool, &input).await.unwrap();
    let messages = repository::list_messages(&pool, &published.conversation_id).await.unwrap();
    let historical = &messages[0];
    let write = |id| UpdateMessageContentInput {
        id, content: "changed", turn_id: None, token_count: None,
        tool_traces_json: None, hidden_context: None, provider_input_items_json: None,
        provider_turn_state_json: None, context_refs_json: None, completion_reason: None,
        generation_attempts_json: None,
    };
    assert!(repository::update_message_content(&pool, write(&historical.id)).await.is_err());
    assert!(repository::delete_messages_after(&pool, &published.conversation_id, &historical.id).await.is_err());
    assert!(repository::trim_conversation_replay(&pool, &published.conversation_id, &historical.id, Some("[]"), true).await.is_err());
    assert!(repository::prepare_conversation_replay(&pool, repository::PrepareConversationReplayInput {
        conversation_id: &published.conversation_id, message_id: &historical.id,
        session_id: "local-session", turn_id: "local-turn", replay_id: "invalid-history-replay",
        content: "changed", hidden_context: None, provider_input_items_json: None,
        code_checkpoints_json: Some("[]".into()), delete_context_compaction_state: true,
    }).await.is_err());
    assert_eq!(repository::list_messages(&pool, &published.conversation_id).await.unwrap()[0].content, historical.content);
    assert!(repository::get_app_setting(&pool, &format!("agentCodeCheckpoints:{}", published.conversation_id)).await.unwrap().is_none());
    sqlx::query("INSERT INTO messages(id,conversation_id,turn_id,role,content,created_at) VALUES('local-edit',?,'local-turn','user','ordinary','2026-10-24T12:00:00Z')")
        .bind(&published.conversation_id).execute(&pool).await.unwrap();
    repository::update_message_content(&pool, write("local-edit")).await.unwrap();
    assert_eq!(repository::get_message(&pool, "local-edit").await.unwrap().unwrap().content, "changed");
    repository::trim_conversation_replay(&pool, &published.conversation_id, "local-edit", None, false).await.unwrap();
    assert_eq!(repository::list_messages(&pool, &published.conversation_id).await.unwrap().len(), 3);
    // Even if an ordinary row has a date before the imported ordering prefix,
    // an explicit replay cannot trim that prefix as a side effect.
    sqlx::query("UPDATE messages SET created_at='1960-01-01T00:00:00Z' WHERE id='local-edit'").execute(&pool).await.unwrap();
    assert!(repository::delete_messages_after(&pool, &published.conversation_id, "local-edit").await.is_err());
    assert_eq!(repository::list_messages(&pool, &published.conversation_id).await.unwrap().len(), 3);
}

#[tokio::test]
async fn connect_archive_reader_pages_empty_associations_and_native_uuid_without_ttl() {
    use super::super::reader::{page_in, Selector};
    let (_dir, pool, spec, allocation, _store, _key) = staged().await;
    fill(&pool, &spec, &allocation).await;
    pinned(&pool, &spec, &allocation).await;
    let input = publish_input(&pool, &spec, &allocation).await;
    let published = publish(&pool, &input).await.unwrap();
    let mut db = pool.acquire().await.unwrap();
    // Expiration and restart reconciliation do not remove a published archive.
    let expires: i64 = sqlx::query_scalar("SELECT expires_at FROM e_inactive_imports").fetch_one(&mut *db).await.unwrap();
    assert!(expires < chrono::Utc::now().timestamp_millis());
    super::super::hold_in(&mut db, false).await.unwrap();
    let mut page = page_in(&mut db, "catalog", &published.conversation_id, Selector::All, None, 1).await.unwrap();
    assert_eq!(page.fragments.len(), 1);
    assert_eq!(page.fragments[0].bytes, b"History remains recoverable");
    let id = page.fragments[0].target_uuid.clone().unwrap();
    let cursor = page.next.clone().unwrap();
    assert!(page_in(&mut db, "new-catalog", &published.conversation_id, Selector::All, Some(&cursor), 1).await.is_err());
    assert!(page_in(&mut db, "catalog", "foreign-conversation", Selector::All, Some(&cursor), 1).await.is_err());
    assert!(page_in(&mut db, "catalog", &published.conversation_id, Selector::Ordinal(0), Some(&cursor), 1).await.is_err());
    page = page_in(&mut db, "catalog", &published.conversation_id, Selector::All, Some(&cursor), 1).await.unwrap();
    assert_eq!(page.fragments[0].record.ordinal, 1);
    assert_eq!(page.fragments[0].bytes, b"synthetic image bytes");
    page = page_in(&mut db, "catalog", &published.conversation_id, Selector::All, page.next.as_ref(), 1).await.unwrap();
    assert_eq!(page.fragments[0].record.ordinal, 2);
    assert!(matches!(page.fragments[0].record.entry, RecordKind::Association { .. }));
    assert!(page.fragments[0].bytes.is_empty());
    assert!(page.fragments[0].target_uuid.is_none());
    assert!(page.next.is_none());
    let by_uuid = page_in(&mut db, "catalog", &published.conversation_id, Selector::Uuid(&id), None, 1).await.unwrap();
    assert_eq!(by_uuid.fragments[0].record.ordinal, 0);
    assert!(by_uuid.next.is_none());
    assert!(page_in(&mut db, "catalog", &published.conversation_id, Selector::Ordinal(3), None, 1).await.is_err());
    assert!(page_in(&mut db, "catalog", &published.conversation_id, Selector::All, None, 0).await.is_err());
}

#[tokio::test]
async fn connect_archive_reader_crosses_page_boundaries_without_truncating_a_large_record() {
    use super::super::reader::{page_in, Selector};
    let history = "Complete raw historical record café é🙂\n".repeat(6000).into_bytes();
    let (_dir, pool, spec, allocation, _store, _key) = staged_with_history(history.clone()).await;
    fill(&pool, &spec, &allocation).await;
    pinned(&pool, &spec, &allocation).await;
    let input = publish_input(&pool, &spec, &allocation).await;
    let published = publish(&pool, &input).await.unwrap();
    let mut db = pool.acquire().await.unwrap();
    let mut cursor = None;
    let mut content = Vec::new();
    let mut image = Vec::new();
    let mut associations = 0;
    let mut pages = 0;
    loop {
        let page = page_in(&mut db, "catalog", &published.conversation_id, Selector::All, cursor.as_ref(), 3).await.unwrap();
        assert!(!page.fragments.is_empty());
        assert!(page.fragments.len() <= 3);
        for fragment in page.fragments {
            assert!(fragment.bytes.len() <= 4093);
            match fragment.record.ordinal {
                0 => { assert_eq!(fragment.offset as usize, content.len()); content.extend(fragment.bytes); }
                1 => image.extend(fragment.bytes),
                2 => { assert!(fragment.bytes.is_empty()); associations += 1; }
                _ => panic!("unexpected archive record"),
            }
        }
        pages += 1;
        if page.next.is_none() { break; }
        assert_ne!(page.next, cursor);
        cursor = page.next;
    }
    assert!(pages > 20);
    assert_eq!(content, history);
    assert_eq!(image, b"synthetic image bytes");
    assert_eq!(associations, 1);
}

// Construct an old database by removing 020 from a fresh empty reference and
// then copying SQL-only fixture rows under the real 019 constraints. No guard
// is removed from populated storage and no transport authority is synthesized.
async fn pre020_copy(source: &std::path::Path, destination: &std::path::Path) {
    let old = db::create_pool(destination).await.unwrap();
    let mut connection = old.acquire().await.unwrap();
    super::super::remove_reader_reference_in(&mut connection).await.unwrap();
    sqlx::query("DELETE FROM schema_migrations WHERE version=20").execute(&mut *connection).await.unwrap();
    sqlx::query("ATTACH DATABASE ? AS pre020").bind(source.to_str().unwrap()).execute(&mut *connection).await.unwrap();
    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await.unwrap();
    for table in ["e_inactive_domain", "e_inactive_imports", "e_inactive_records", "e_inactive_fragments", "e_inactive_mapping", "connect_transfers", "connect_raw_prefix", "connect_raw_chunks", "connect_exchanges"] {
        sqlx::query(sqlx::AssertSqlSafe(format!("INSERT INTO {table} SELECT * FROM pre020.{table}"))).execute(&mut *tx).await.unwrap();
    }
    sqlx::raw_sql("CREATE TEMP TABLE legacy_preparation AS SELECT * FROM pre020.connect_preparations; UPDATE legacy_preparation SET phase='preparing',pin_receipt=NULL,pin_fingerprint=NULL; INSERT INTO connect_preparations SELECT * FROM legacy_preparation;")
        .execute(&mut *tx).await.unwrap();
    for table in ["connect_projection_messages", "connect_projection_citations", "connect_projection_assets", "connect_projection_fields", "connect_projection_fragments"] {
        sqlx::query(sqlx::AssertSqlSafe(format!("INSERT INTO {table} SELECT * FROM pre020.{table}"))).execute(&mut *tx).await.unwrap();
    }
    sqlx::query("UPDATE connect_preparations SET phase='prepared' WHERE transfer_id IN (SELECT transfer_id FROM pre020.connect_preparations WHERE phase IN ('prepared','pinned'))").execute(&mut *tx).await.unwrap();
    sqlx::query("UPDATE connect_preparations SET phase='pinned',pin_receipt=(SELECT pin_receipt FROM pre020.connect_preparations s WHERE s.transfer_id=connect_preparations.transfer_id),pin_fingerprint=(SELECT pin_fingerprint FROM pre020.connect_preparations s WHERE s.transfer_id=connect_preparations.transfer_id) WHERE transfer_id IN (SELECT transfer_id FROM pre020.connect_preparations WHERE phase='pinned')").execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    sqlx::query("DETACH DATABASE pre020").execute(&mut *connection).await.unwrap();
    drop(connection);
    old.close().await;
}

#[tokio::test]
async fn connect_projection_019_partial_and_pinned_retries_survive_real_020_migration() {
    for old_pin in [false, true] {
        let (dir, pool, spec, allocation, _store, _key) = staged().await;
        let legacy_entry = Entry {
            transfer_id: spec.transfer_id.clone(), ordinal: 0, source_ordinal: Some(0),
            header: Header::Message { role: "user".into(), created_at: "1970-01-01T00:00:00.000Z".into(), display_date: None },
            fields: vec![Field { name: "content".into(), bytes: 27, sha256: hash(b"History remains recoverable") }],
        };
        let id = entry(&pool, &legacy_entry).await.unwrap();
        if old_pin {
            fill_with_display(&pool, &spec, &allocation, None).await;
            pinned(&pool, &spec, &allocation).await;
        }
        let before: (Vec<u8>, Option<Vec<u8>>, Option<Vec<u8>>) = sqlx::query_as("SELECT fingerprint,pin_receipt,pin_fingerprint FROM connect_preparations WHERE transfer_id=?")
            .bind(&spec.transfer_id).fetch_one(&pool).await.unwrap();
        let destination = tempfile::tempdir().unwrap();
        let path = destination.path().join("pre020.db");
        pre020_copy(&dir.path().join("journal.db"), &path).await;
        let migrated = db::create_pool(&path).await.unwrap();
        assert_eq!(entry(&migrated, &legacy_entry).await.unwrap(), id);
        if old_pin { pinned(&migrated, &spec, &allocation).await; }
        let changed = Entry { header: Header::Message { role: "user".into(), created_at: "1970-01-01T00:00:00.000Z".into(), display_date: Some(DisplayDate { original_date: Some("2025-06-01T12:00:00Z".into()), inherited_from: None }) }, ..legacy_entry };
        assert!(entry(&migrated, &changed).await.is_err());
        let after: (Vec<u8>, Option<Vec<u8>>, Option<Vec<u8>>) = sqlx::query_as("SELECT fingerprint,pin_receipt,pin_fingerprint FROM connect_preparations WHERE transfer_id=?")
            .bind(&spec.transfer_id).fetch_one(&migrated).await.unwrap();
        assert_eq!(before, after);
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM connect_projection_display").fetch_one(&migrated).await.unwrap(), 0);
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT MAX(version) FROM schema_migrations").fetch_one(&migrated).await.unwrap(), 20);
    }
}
async fn pinned(pool: &SqlitePool, spec: &Spec, allocation: &Allocation) {
    let projection_hash =
        sqlx::query_scalar("SELECT projection_hash FROM connect_preparations WHERE transfer_id=?")
            .bind(&spec.transfer_id)
            .fetch_one(pool)
            .await
            .unwrap();
    let check = PinWrite {
        transfer_id: spec.transfer_id.clone(),
        preparation_fingerprint: allocation.fingerprint.clone(),
        local_generation: spec.local_generation.clone(),
        configuration_digest: spec.configuration_digest.clone(),
        preparators_digest: spec.preparators_digest.clone(),
        prepared_digest: vec![9; 32],
        projection_hash,
        exact_local_receipt: b"immutable SQL storage pin, not product preparation authority"
            .to_vec(),
    };
    pin(pool, &check).await.unwrap();
    pin(pool, &check).await.unwrap();
}
async fn publish_input(pool: &SqlitePool, spec: &Spec, allocation: &Allocation) -> PublishWrite {
    let terminal = terminal::store_target_fixture(pool, &spec.transfer_id, &[9; 32]).await;
    PublishWrite {
        transfer_id: spec.transfer_id.clone(),
        terminal_fingerprint: terminal,
        preparation_fingerprint: allocation.fingerprint.clone(),
        local_generation: spec.local_generation.clone(),
        configuration_digest: spec.configuration_digest.clone(),
    }
}
#[tokio::test]
async fn connect_publication_streams_full_text_assets_citations_once_under_concurrency() {
    let (dir, pool, spec, allocation, store, key) = staged().await;
    assert_eq!(begin(&pool, &spec).await.unwrap(), allocation);
    fill(&pool, &spec, &allocation).await;
    pinned(&pool, &spec, &allocation).await;
    let input = publish_input(&pool, &spec, &allocation).await;
    let (a, b) = tokio::join!(publish(&pool, &input), publish(&pool, &input));
    let a = a.unwrap();
    assert_eq!(a, b.unwrap());
    assert_eq!(a.conversation_id, allocation.conversation_id);
    let row = sqlx::query(
        "SELECT scope_mode,project_id,group_id,task_id,message_count FROM conversations WHERE id=?",
    )
    .bind(&a.conversation_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.get::<String, _>("scope_mode"), "Chat");
    for name in ["project_id", "group_id", "task_id"] {
        assert!(row.get::<Option<String>, _>(name).is_none());
    }
    assert_eq!(row.get::<i64, _>("message_count"), 2);
    let full: String = sqlx::query_scalar(
        "SELECT content FROM messages WHERE conversation_id=? AND role='assistant'",
    )
    .bind(&a.conversation_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        full,
        "Compacted fact café é🙂 recoveryneedle\n".repeat(2500)
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM message_search WHERE message_search MATCH 'recoveryneedle'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    sqlx::query("INSERT INTO message_search(message_search,rank) VALUES('integrity-check',1)")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT content FROM conversation_citations WHERE conversation_id=?"
        )
        .bind(&a.conversation_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        "Complete citation text"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM connect_published_assets WHERE conversation_id=?"
        )
        .bind(&a.conversation_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        store
            .readback(&key, None, 32)
            .await
            .unwrap()
            .fragments
            .len(),
        3
    );
    assert!(sqlx::query("UPDATE e_inactive_fragments SET data=x'00'")
        .execute(&pool)
        .await
        .is_err());
    pool.close().await;
    let pool = db::create_pool(&dir.path().join("journal.db"))
        .await
        .unwrap();
    assert_eq!(publish(&pool, &input).await.unwrap(), a);
    assert_eq!(
        sqlx::query_scalar::<_, Vec<u8>>(
            "SELECT data FROM connect_projection_fragments WHERE kind='asset'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        b"synthetic image bytes"
    );
}
#[tokio::test]
async fn connect_publication_id_collision_rolls_back_every_ordinary_write_and_charge() {
    let (_dir, pool, spec, allocation, _store, _key) = staged().await;
    fill(&pool, &spec, &allocation).await;
    pinned(&pool, &spec, &allocation).await;
    let input = publish_input(&pool, &spec, &allocation).await;
    let id: String =
        sqlx::query_scalar("SELECT id FROM connect_projection_messages WHERE ordinal=1")
            .fetch_one(&pool)
            .await
            .unwrap();
    sqlx::query("INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,'source','user','collision','t')").bind(id).execute(&pool).await.unwrap();
    let before = db::inactive_budget::retained(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    assert!(publish(&pool, &input).await.is_err());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM conversations WHERE id=?")
            .bind(&allocation.conversation_id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM connect_activation_receipts")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        db::inactive_budget::retained(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap(),
        before
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT phase FROM connect_preparations")
            .fetch_one(&pool)
            .await
            .unwrap(),
        "pinned"
    );
}
#[tokio::test]
async fn connect_preparation_rejects_incomplete_changed_mapping_config_and_payload() {
    let (_dir, pool, mut spec, allocation, _store, _key) = staged().await;
    assert!(
        finish(&pool, &spec.transfer_id, &allocation.fingerprint, &[9; 32])
            .await
            .is_err()
    );
    spec.mapping_hash[0] ^= 1;
    assert!(begin(&pool, &spec).await.is_err());
    spec.mapping_hash[0] ^= 1;
    fill(&pool, &spec, &allocation).await;
    assert!(
        sqlx::query("UPDATE connect_projection_fragments SET data=x'00'")
            .execute(&pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("UPDATE connect_preparations SET title='changed'")
            .execute(&pool)
            .await
            .is_err()
    );
    let projection_hash = sqlx::query_scalar("SELECT projection_hash FROM connect_preparations")
        .fetch_one(&pool)
        .await
        .unwrap();
    let check = PinWrite {
        transfer_id: spec.transfer_id.clone(),
        preparation_fingerprint: allocation.fingerprint.clone(),
        local_generation: spec.local_generation.clone(),
        configuration_digest: vec![0; 32],
        preparators_digest: spec.preparators_digest.clone(),
        prepared_digest: vec![9; 32],
        projection_hash,
        exact_local_receipt: b"fixture".to_vec(),
    };
    assert!(pin(&pool, &check).await.is_err());
    pinned(&pool, &spec, &allocation).await;
    assert!(sqlx::query("DELETE FROM e_inactive_imports")
        .execute(&pool)
        .await
        .is_err());
}
#[tokio::test]
async fn connect_publication_restore_preserves_all_preparation_phases_before_ready() {
    for phase in ["preparing", "prepared", "pinned", "published"] {
        let (_dir, pool, spec, allocation, store, key) = staged().await;
        if phase != "preparing" {
            fill(&pool, &spec, &allocation).await;
        }
        if matches!(phase, "pinned" | "published") {
            pinned(&pool, &spec, &allocation).await;
        }
        let input = if phase == "published" {
            let input = publish_input(&pool, &spec, &allocation).await;
            publish(&pool, &input).await.unwrap();
            Some(input)
        } else {
            None
        };
        db::chat_admission::hold_restored_profile(&pool)
            .await
            .unwrap();
        let owner = crate::core::db_state::DbPool::default();
        owner.set_ready(pool.clone()).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT phase FROM connect_preparations")
                .fetch_one(&pool)
                .await
                .unwrap(),
            phase
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT restore_hold FROM connect_transfers")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
        assert!(!store
            .readback(&key, None, 32)
            .await
            .unwrap()
            .fragments
            .is_empty());
        if let Some(input) = input {
            assert_eq!(
                publish(&pool, &input).await.unwrap().conversation_id,
                allocation.conversation_id
            );
        } else {
            assert!(entry(
                &pool,
                &Entry {
                    transfer_id: spec.transfer_id.clone(),
                    ordinal: 100,
                    source_ordinal: None,
                    header: Header::Message {
            display_date: None,
                        role: "user".into(),
                        created_at: "t".into()
                    },
                    fields: vec![Field {
                        name: "content".into(),
                        bytes: 0,
                        sha256: hash(b"")
                    }]
                }
            )
            .await
            .is_err());
        }
    }
}
#[tokio::test]
async fn connect_publication_budget_overflow_refuses_before_pin_or_publication() {
    let (_dir, pool, spec, allocation, _store, _key) = staged().await;
    fill(&pool, &spec, &allocation).await;
    sqlx::query("UPDATE connect_preparations SET charge_bytes=9223372036854775807")
        .execute(&pool)
        .await
        .unwrap();
    let projection_hash = sqlx::query_scalar("SELECT projection_hash FROM connect_preparations")
        .fetch_one(&pool)
        .await
        .unwrap();
    let check = PinWrite {
        transfer_id: spec.transfer_id.clone(),
        preparation_fingerprint: allocation.fingerprint,
        local_generation: spec.local_generation,
        configuration_digest: spec.configuration_digest,
        preparators_digest: spec.preparators_digest,
        prepared_digest: vec![9; 32],
        projection_hash,
        exact_local_receipt: b"fixture".to_vec(),
    };
    assert!(pin(&pool, &check).await.is_err());
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT phase FROM connect_preparations")
            .fetch_one(&pool)
            .await
            .unwrap(),
        "prepared"
    );
}

#[tokio::test]
async fn connect_publication_disk_full_keeps_pin_archive_and_all_charges() {
    let (dir, pool, spec, allocation, _store, _key) = staged().await;
    fill(&pool, &spec, &allocation).await;
    pinned(&pool, &spec, &allocation).await;
    let input = publish_input(&pool, &spec, &allocation).await;
    let before = db::inactive_budget::retained(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    pool.close().await;
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(dir.path().join("journal.db"))
                .foreign_keys(true)
                .pragma("recursive_triggers", "ON")
                .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal),
        )
        .await
        .unwrap();
    let pages: i64 = sqlx::query_scalar("PRAGMA page_count")
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "PRAGMA max_page_count={pages}"
    )))
    .execute(&pool)
    .await
    .unwrap();
    let error = publish(&pool, &input).await.unwrap_err();
    assert!(error.to_string().contains("full"), "{error}");
    assert_eq!(
        db::inactive_budget::retained(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap(),
        before
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM conversations WHERE id=?")
            .bind(&allocation.conversation_id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM connect_activation_receipts")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT phase FROM connect_preparations")
            .fetch_one(&pool)
            .await
            .unwrap(),
        "pinned"
    );
}
#[tokio::test]
async fn connect_preparation_and_published_archive_survive_ttl_without_losing_bytes() {
    let (_dir, pool, spec, allocation, mut store, key) = staged().await;
    fill(&pool, &spec, &allocation).await;
    pinned(&pool, &spec, &allocation).await;
    let original = store.readback(&key, None, 32).await.unwrap();
    inactive_storage::tests::advance_transfer_fixture(&mut store, i64::MAX / 2);
    assert!(store.abort_receiving(&key).await.is_err());
    assert_eq!(
        store.seal_storage(&key).await.unwrap().receipt.revision,
        spec.import_revision
    );
    let input = publish_input(&pool, &spec, &allocation).await;
    publish(&pool, &input).await.unwrap();
    let after = store.readback(&key, None, 32).await.unwrap();
    assert_eq!(
        after
            .fragments
            .iter()
            .map(|f| (&f.bytes, &f.target_uuid))
            .collect::<Vec<_>>(),
        original
            .fragments
            .iter()
            .map(|f| (&f.bytes, &f.target_uuid))
            .collect::<Vec<_>>()
    );
    assert!(sqlx::query("DELETE FROM e_inactive_records")
        .execute(&pool)
        .await
        .is_err());
    assert!(sqlx::query("DELETE FROM connect_preparations")
        .execute(&pool)
        .await
        .is_err());
    assert!(
        db::inactive_budget::retained(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap()
            > 0
    );
}
#[tokio::test]
async fn connect_projection_has_no_256_message_cutoff_and_allocates_each_id_once() {
    let (dir, pool, spec, _allocation, _store, _key) = staged().await;
    // Separate transfer fixture: its declared shape is changed before creating
    // preparation, not by relaxing a product history limit.
    pool.close().await;
    drop(dir);
    let (_dir, pool) = journal::fixture().await;
    let (transfer, begin_input) = journal::target_for_publication(&pool).await;
    let (_store, key, sealed) = inactive_storage::tests::seal_transfer_fixture(
        pool.clone(),
        begin_input,
        vec![(
            RecordKind::Message { role: Role::User },
            b"full archive".to_vec(),
        )],
    )
    .await;
    journal::attach_for_publication(&pool, &transfer, &key).await;
    let mut spec = Spec {
        transfer_id: transfer.clone(),
        import_key: key,
        import_revision: sealed.receipt.revision,
        storage_manifest: bytes(&sealed.manifest_sha256),
        mapping_hash: bytes(sealed.receipt.mapping_sha256.as_ref().unwrap()),
        message_count: 257,
        citation_count: 0,
        asset_count: 0,
        ..spec
    };
    spec.reservation_fingerprint =
        sqlx::query_scalar("SELECT fingerprint FROM connect_transfers WHERE transfer_id=?")
            .bind(&transfer)
            .fetch_one(&pool)
            .await
            .unwrap();
    let allocation = begin(&pool, &spec).await.unwrap();
    for ordinal in 0..257 {
        put(
            &pool,
            &transfer,
            ordinal,
            None,
            Header::Message {
            display_date: None,
                role: "user".into(),
                created_at: format!("{ordinal:08}"),
            },
            &[("content", b"complete")],
        )
        .await;
    }
    finish(&pool, &transfer, &allocation.fingerprint, &[9; 32])
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(DISTINCT id) FROM connect_projection_messages")
            .fetch_one(&pool)
            .await
            .unwrap(),
        257
    );
}
#[tokio::test]
#[ignore = "subprocess entrypoint, executed by connect_publication_process_death_at_commit_boundaries"]
async fn connect_publication_crash_child() {
    let path = std::env::var("MACRO_PUBLICATION_CRASH_DB").unwrap();
    let transfer = std::env::var("MACRO_PUBLICATION_CRASH_TRANSFER").unwrap();
    let pool = db::create_pool(std::path::Path::new(&path)).await.unwrap();
    let row=sqlx::query("SELECT p.fingerprint,p.local_generation,p.configuration_digest,t.terminal_fingerprint FROM connect_preparations p JOIN connect_transfers t USING(transfer_id) WHERE transfer_id=?").bind(&transfer).fetch_one(&pool).await.unwrap();
    let input = PublishWrite {
        transfer_id: transfer,
        terminal_fingerprint: row.get("terminal_fingerprint"),
        preparation_fingerprint: row.get("fingerprint"),
        local_generation: row.get("local_generation"),
        configuration_digest: row.get("configuration_digest"),
    };
    let _ = publish(&pool, &input).await.unwrap();
    panic!("crash checkpoint was not reached");
}
#[tokio::test]
async fn connect_publication_process_death_at_commit_boundaries() {
    for phase in ["before_commit", "after_commit"] {
        let (dir, pool, spec, allocation, _store, _key) = staged().await;
        fill(&pool, &spec, &allocation).await;
        pinned(&pool, &spec, &allocation).await;
        let input = publish_input(&pool, &spec, &allocation).await;
        pool.close().await;
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "db::connect_transfer::preparation::tests::connect_publication_crash_child",
                "--ignored",
                "--nocapture",
            ])
            .env("MACRO_PUBLICATION_CRASH_DB", dir.path().join("journal.db"))
            .env("MACRO_PUBLICATION_CRASH_TRANSFER", &spec.transfer_id)
            .env("MACRO_PUBLICATION_CRASH_PHASE", phase)
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(91),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        let pool = db::create_pool(&dir.path().join("journal.db"))
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("PRAGMA integrity_check")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "ok"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM connect_activation_receipts")
                .fetch_one(&pool)
                .await
                .unwrap(),
            i64::from(phase == "after_commit")
        );
        let a = publish(&pool, &input).await.unwrap();
        assert_eq!(a, publish(&pool, &input).await.unwrap());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM conversations WHERE id=?")
                .bind(&allocation.conversation_id)
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
    }
}

#[tokio::test]
async fn connect_publication_rejects_removed_017_guard_and_restored_pin() {
    for restored in [false, true] {
        let (_dir, pool, spec, allocation, _store, _key) = staged().await;
        fill(&pool, &spec, &allocation).await;
        pinned(&pool, &spec, &allocation).await;
        if restored {
            db::chat_admission::hold_restored_profile(&pool)
                .await
                .unwrap();
        } else {
            sqlx::query("DROP TRIGGER chat_admission_register_insert")
                .execute(&pool)
                .await
                .unwrap();
        }
        let input = publish_input(&pool, &spec, &allocation).await;
        assert!(publish(&pool, &input).await.is_err());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM conversations WHERE id=?")
                .bind(&allocation.conversation_id)
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM connect_activation_receipts")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
    }
}

#[tokio::test]
async fn connect_publication_deleted_chat_does_not_reappear_or_expose_assets_from_receipt() {
    let (_dir, pool, spec, allocation, store, key) = staged().await;
    fill(&pool, &spec, &allocation).await;
    pinned(&pool, &spec, &allocation).await;
    let input = publish_input(&pool, &spec, &allocation).await;
    let receipt = publish(&pool, &input).await.unwrap();
    let owner = crate::core::db_state::DbPool::default(); owner.set_ready(pool.clone()).await.unwrap();
    db::repository::delete_conversations_admitted(&owner, &[allocation.conversation_id.clone()])
        .await
        .unwrap();
    let retry=publish(&pool, &input).await.unwrap();
    assert_eq!(retry.receipt,receipt.receipt);
    assert_eq!(retry.disposition,super::publication::LocalDisposition::Removed);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM connect_published_assets")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM conversations WHERE id=?")
            .bind(&allocation.conversation_id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    sqlx::query("INSERT INTO message_search(message_search,rank) VALUES('integrity-check',1)")
        .execute(&pool)
        .await
        .unwrap();
    assert!(store.readback(&key, None, 32).await.is_err());
}
