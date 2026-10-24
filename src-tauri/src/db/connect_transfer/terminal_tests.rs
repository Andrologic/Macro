use super::*;
use crate::db::connect_transfer::journal::tests::{fixture, source_for_terminal};
async fn terminal(pool: &SqlitePool, transfer: &str, outcome: Outcome) -> TerminalWrite {
    let row = sqlx::query(
        "SELECT fingerprint,binding_digest,source_epoch FROM connect_transfers WHERE transfer_id=?",
    )
    .bind(transfer)
    .fetch_one(pool)
    .await
    .unwrap();
    TerminalWrite {
        transfer_id: transfer.into(),
        reservation_fingerprint: row.get("fingerprint"),
        binding_digest: row.get("binding_digest"),
        source_epoch: row.get("source_epoch"),
        outcome,
        decision_revision: "3".into(),
        exact: b"SQL-only terminal fixture, no authentication".to_vec(),
        canonical_digest: vec![4; 32],
        prepared_digest: None,
    }
}
#[tokio::test]
async fn connect_terminal_source_commit_cedes_permanently_and_rejects_conflicting_terminal() {
    let (dir, pool) = fixture().await;
    let transfer = source_for_terminal(&pool).await;
    let mut t = terminal(&pool, &transfer, Outcome::Committed).await;
    assert_eq!(
        apply_source(&pool, &t).await.unwrap(),
        SourceApplication::Applied
    );
    assert_eq!(
        apply_source(&pool, &t).await.unwrap(),
        SourceApplication::PreviouslyApplied
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT mode FROM chat_admission_owners WHERE conversation_id='source'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        "ceded"
    );
    t.outcome = Outcome::Aborted;
    assert!(apply_source(&pool, &t).await.is_err());
    assert!(sqlx::query(
        "UPDATE chat_admission_owners SET mode='open' WHERE conversation_id='source'"
    )
    .execute(&pool)
    .await
    .is_err());
    pool.close().await;
    let pool = crate::db::create_pool(&dir.path().join("journal.db"))
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, Vec<u8>>("SELECT terminal_exact FROM connect_transfers")
            .fetch_one(&pool)
            .await
            .unwrap(),
        t.exact
    );
    assert!(crate::db::repository::delete_conversation(&pool, "source")
        .await
        .is_err());
}
#[tokio::test]
async fn connect_terminal_old_abort_does_not_thaw_a_new_epoch() {
    let (_dir, pool) = fixture().await;
    let (owner, runtime, handle, input) =
        crate::db::connect_transfer::journal::tests::inspected(&pool).await;
    runtime
        .reserve_reconciled_transfer(&owner, "window", "browser", &handle, &input)
        .await
        .unwrap();
    let transfer: String = sqlx::query_scalar("SELECT transfer_id FROM connect_transfers")
        .fetch_one(&pool)
        .await
        .unwrap();
    let t = terminal(&pool, &transfer, Outcome::Aborted).await;
    apply_source(&pool, &t).await.unwrap();
    crate::db::connect_transfer::journal::tests::reserve_next_source_after_abort(
        &pool, &owner, &runtime,
    )
    .await;
    assert_eq!(
        apply_source(&pool, &t).await.unwrap(),
        SourceApplication::PreviouslyApplied
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT mode FROM chat_admission_owners WHERE conversation_id='source'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        "frozen"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM connect_transfers")
            .fetch_one(&pool)
            .await
            .unwrap(),
        2
    );
}
#[tokio::test]
async fn connect_terminal_restore_hold_stores_exact_terminal_without_resolving_source() {
    let (_dir, pool) = fixture().await;
    let transfer = source_for_terminal(&pool).await;
    let t = terminal(&pool, &transfer, Outcome::Aborted).await;
    crate::db::chat_admission::hold_restored_profile(&pool)
        .await
        .unwrap();
    assert_eq!(
        apply_source(&pool, &t).await.unwrap(),
        SourceApplication::Held
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT mode FROM chat_admission_owners WHERE conversation_id='source'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        "restore_hold"
    );
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM connect_transfers WHERE resolution IS NULL AND terminal_exact IS NOT NULL AND restore_hold=1").fetch_one(&pool).await.unwrap(),1);
}

#[tokio::test]
async fn connect_terminal_stale_owner_rolls_back_terminal_and_charge() {
    let (_dir, pool) = fixture().await;
    let transfer = source_for_terminal(&pool).await;
    let input = terminal(&pool, &transfer, Outcome::Committed).await;
    let before = crate::db::inactive_budget::retained(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    sqlx::query(
        "UPDATE chat_admission_owners SET revision=revision+1 WHERE conversation_id='source'",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert!(apply_source(&pool, &input)
        .await
        .unwrap_err()
        .to_string()
        .contains("owner_stale"));
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM connect_transfers WHERE terminal_exact IS NULL AND resolution IS NULL").fetch_one(&pool).await.unwrap(),1);
    assert_eq!(
        crate::db::inactive_budget::retained(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap(),
        before
    );
}

#[tokio::test]
async fn connect_local_deletion_source_ceded_keeps_tombstone_and_old_aborted_epochs_together() {
    for outcome in [Outcome::Committed, Outcome::Aborted] {
        let (_dir,pool)=fixture().await;
        let (owner,runtime,handle,input)=crate::db::connect_transfer::journal::tests::inspected(&pool).await;
        runtime.reserve_reconciled_transfer(&owner,"window","browser",&handle,&input).await.unwrap();
        let old_id: String = sqlx::query_scalar("SELECT transfer_id FROM connect_transfers").fetch_one(&pool).await.unwrap();
        let old=terminal(&pool,&old_id,Outcome::Aborted).await;
        apply_source(&pool,&old).await.unwrap();
        crate::db::connect_transfer::journal::tests::reserve_next_source_after_abort(&pool,&owner,&runtime).await;
        assert!(crate::db::repository::delete_conversations_admitted(&owner,&["source".into()]).await.is_err());
        let next: String = sqlx::query_scalar("SELECT transfer_id FROM connect_transfers WHERE transfer_id<>?").bind(&old_id).fetch_one(&pool).await.unwrap();
        let current=terminal(&pool,&next,outcome).await;
        apply_source(&pool,&current).await.unwrap();
        crate::db::repository::delete_conversations_admitted(&owner,&["source".into()]).await.unwrap();
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM conversations").fetch_one(&pool).await.unwrap(),0);
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM messages").fetch_one(&pool).await.unwrap(),0);
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM connect_local_deletions WHERE phase='deleted'").fetch_one(&pool).await.unwrap(),2);
        assert_eq!(sqlx::query_scalar::<_,String>("SELECT mode FROM chat_admission_owners WHERE conversation_id='source'").fetch_one(&pool).await.unwrap(),if outcome==Outcome::Committed {"ceded"} else {"removed"});
        assert_eq!(apply_source(&pool,&old).await.unwrap(),SourceApplication::PreviouslyApplied);
        assert_eq!(apply_source(&pool,&current).await.unwrap(),SourceApplication::PreviouslyApplied);
        assert!(sqlx::query("INSERT INTO conversations(id,title,scope_mode,created_at,updated_at) VALUES('source','Again','Chat','t','t')").execute(&pool).await.is_err());
    }
}

#[tokio::test]
async fn connect_local_deletion_never_clears_a_restore_hold_or_ceded_tombstone() {
    let (_dir,pool)=fixture().await;
    let transfer=source_for_terminal(&pool).await;
    let t=terminal(&pool,&transfer,Outcome::Committed).await;
    apply_source(&pool,&t).await.unwrap();
    crate::db::chat_admission::hold_restored_profile(&pool).await.unwrap();
    let owner=crate::core::db_state::DbPool::default();owner.set_ready(pool.clone()).await.unwrap();
    assert!(crate::db::repository::delete_conversations_admitted(&owner,&["source".into()]).await.is_err());
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM connect_local_deletions").fetch_one(&pool).await.unwrap(),0);
    // Restore independently holds F and preserves a ceded owner permanently.
    assert_eq!(sqlx::query_scalar::<_,String>("SELECT mode FROM chat_admission_owners WHERE conversation_id='source'").fetch_one(&pool).await.unwrap(),"ceded");
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT restore_hold FROM connect_transfers").fetch_one(&pool).await.unwrap(),1);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM messages").fetch_one(&pool).await.unwrap(),1);
}
