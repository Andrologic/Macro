//! Untimed file-backed contract checks for the benchmark itself.
use super::{assert_path, db, repository, Result};
use db::models::{CreateConversationInput, CreateMessageInput, ImportMessageInput, Message};
use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};

fn input(conversation: &str, id: &str, content: &str) -> CreateMessageInput {
    CreateMessageInput {
        id: Some(id.into()),
        conversation_id: conversation.into(),
        turn_id: Some("turn".into()),
        role: "assistant".into(),
        content: content.into(),
        token_count: Some(37),
        tool_traces_json: Some("[]".into()),
        hidden_context: Some("Contexte synthétique".into()),
        provider_input_items_json: Some("[]".into()),
        provider_turn_state_json: Some("{}".into()),
        context_refs_json: Some("[]".into()),
        completion_reason: Some("stop".into()),
        generation_attempts_json: Some("[]".into()),
    }
}
async fn fts_count(pool: &SqlitePool, term: &str) -> Result<i64> {
    Ok(
        sqlx::query_scalar("SELECT COUNT(*) FROM message_search WHERE message_search MATCH ?")
            .bind(term)
            .fetch_one(pool)
            .await?,
    )
}

pub(super) async fn run() -> Result<Value> {
    let directory = tempfile::Builder::new()
        .prefix("macro-native-contract-")
        .tempdir()?;
    let path = directory.path().join("fixture.db");
    let pool = db::create_pool(&path).await?;
    let result: Result<Value> = async {
        assert_path(&pool,&path).await?;
        let conversation = repository::create_conversation(&pool,CreateConversationInput {
            title:Some("Synthetic contracts".into()),scope_mode:"Chat".into(),task_id:None,group_id:None,
            project_id:None,provider_id:None,model_id:None,reasoning_effort:None }).await?;
        let id = &conversation.id;
        assert!(repository::list_messages(&pool,id).await?.is_empty());
        assert!(repository::list_messages(&pool,"missing").await?.is_empty());
        // Reverse insertion order, identical timestamps, and a future latest row.
        let future = "9999-01-01T00:00:00Z";
        let unicode = "é界🙂".repeat(50);
        repository::import_messages(&pool,id,["tie-z","tie-a"].into_iter().map(|key|ImportMessageInput {
            id:key.into(),turn_id:None,role:"user".into(),content:unicode.clone(),created_at:future.into(),completion_reason:None
        }).collect()).await?;
        let rows = repository::list_messages(&pool,id).await?;
        let golden:Vec<_> = ["tie-a","tie-z"].into_iter().map(|key|Message {
            id:key.into(),conversation_id:id.clone(),turn_id:None,role:"user".into(),content:unicode.clone(),
            created_at:future.into(),token_count:None,tool_traces_json:None,hidden_context:None,
            provider_input_items_json:None,provider_turn_state_json:None,context_refs_json:None,
            completion_reason:None,generation_attempts_json:None }).collect();
        assert_eq!(serde_json::to_value(rows)?,serde_json::to_value(golden)?);
        let created = repository::create_message(&pool,input(id,"full-fields","synthetic fullfields")).await?;
        assert_eq!(serde_json::to_value(&created)?,serde_json::to_value(repository::get_message(&pool,&created.id).await?.unwrap())?);
        let listed = repository::list_messages(&pool,id).await?;
        assert_eq!(serde_json::to_value(&created)?,serde_json::to_value(&listed[0])?);
        let metadata = repository::get_conversation(&pool,id).await?.unwrap();
        assert_eq!(metadata.message_count,3);
        assert_eq!(metadata.updated_at,created.created_at);
        assert_eq!(metadata.last_message,Some(format!("{}...",unicode.chars().take(100).collect::<String>())));
        assert_eq!(fts_count(&pool,"fullfields").await?,1);
        // Unique/FK failures must leave transcript and metadata unchanged.
        assert!(repository::create_message(&pool,input(id,"full-fields","duplicatetoken")).await.is_err());
        assert!(repository::create_message(&pool,input("missing","invalid-fk","invalidtoken")).await.is_err());
        // Fail after insert, during metadata refresh. Both table and FTS roll back.
        sqlx::query("CREATE TRIGGER reject_metadata BEFORE UPDATE ON conversations BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
            .execute(&pool).await?;
        assert!(repository::create_message(&pool,input(id,"rollback-message","rollbacktoken")).await.is_err());
        sqlx::query("DROP TRIGGER reject_metadata").execute(&pool).await?;
        for term in ["duplicatetoken","invalidtoken","rollbacktoken"] { assert_eq!(fts_count(&pool,term).await?,0); }
        assert_eq!(serde_json::to_value(repository::list_messages(&pool,id).await?)?,serde_json::to_value(&listed)?);
        assert_eq!(serde_json::to_value(repository::get_conversation(&pool,id).await?.unwrap())?,serde_json::to_value(&metadata)?);
        // WAL readers remain usable while another connection owns the writer.
        let mut writer = pool.begin_with("BEGIN IMMEDIATE").await?;
        sqlx::query("UPDATE conversations SET title = title WHERE id = ?").bind(id).execute(&mut *writer).await?;
        let other_pool = pool.clone(); let other_id = id.clone();
        let mut pending = tokio::spawn(async move {
            repository::create_message(&other_pool,input(&other_id,"concurrent","concurrenttoken")).await
        });
        let early = tokio::time::timeout(std::time::Duration::from_millis(100), &mut pending).await;
        assert!(early.is_err(),"Writer must wait until the lock is released");
        let read_result = tokio::time::timeout(std::time::Duration::from_secs(2),repository::list_messages(&pool,id)).await;
        writer.commit().await?;
        let appended = pending.await??;
        assert_eq!(read_result??.len(),3);
        assert_eq!(fts_count(&pool,"concurrenttoken").await?,1);
        let before = repository::list_messages(&pool,id).await?;
        assert_eq!(before.len(),4);
        assert!(before.windows(2).all(|pair|(&pair[0].created_at,&pair[0].id)<=(&pair[1].created_at,&pair[1].id)));
        let metadata = repository::get_conversation(&pool,id).await?.unwrap();
        assert_eq!(metadata.message_count,4);
        assert_eq!(metadata.updated_at,appended.created_at);
        pool.close().await;
        let reopened = db::create_pool(&path).await?;
        let check:Result<()> = async {
            assert_path(&reopened,&path).await?;
            assert_eq!(serde_json::to_value(repository::list_messages(&reopened,id).await?)?,serde_json::to_value(before)?);
            assert_eq!(serde_json::to_value(repository::get_conversation(&reopened,id).await?.unwrap())?,serde_json::to_value(metadata)?);
            assert_eq!(fts_count(&reopened,"fullfields").await?,1);
            assert_eq!(fts_count(&reopened,"concurrenttoken").await?,1);
            assert_eq!(fts_count(&reopened,"rollbacktoken").await?,0);
            assert_eq!(sqlx::query_scalar::<_,String>("PRAGMA integrity_check").fetch_one(&reopened).await?,"ok");
            assert!(sqlx::query("PRAGMA foreign_key_check").fetch_all(&reopened).await?.is_empty());
            Ok(())
        }.await;
        reopened.close().await;
        check?;
        Ok(json!({"empty_and_missing":true,"timestamp_id_ties":true,"all_14_fields":true,
            "unicode_preview_future_latest":true,"duplicate_and_foreign_key_errors":true,
            "metadata_failure_rolls_back_message_and_fts":true,"wal_reader_and_writer_wait":true,
            "commit_file_reopen_exact_content_metadata_fts":true,"rows_after_reopen":4}))
    }.await;
    pool.close().await;
    directory.close()?;
    result
}
