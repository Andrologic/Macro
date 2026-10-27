//! Synthetic SQLite tests only. No fixture constitutes producer/network authority.
use super::*;
use crate::db::connect_transfer::staging::{self, Chunk, Session};
use crate::db::{
    self,
    chat_admission::{reconciliation::BrowserInspection, runtime::ChatAdmissionRuntime},
};
use tempfile::TempDir;

pub(in crate::db::connect_transfer) async fn fixture() -> (TempDir, SqlitePool) {
    let dir = TempDir::new().unwrap();
    let pool = db::create_pool(&dir.path().join("journal.db"))
        .await
        .unwrap();
    sqlx::raw_sql("INSERT INTO e_inactive_domain VALUES(1,16777216,64); INSERT INTO conversations(id,title,scope_mode,created_at,updated_at) VALUES('source','Synthetic','Chat','t','t'); INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES('message','source','user','complete history','t');")
        .execute(&pool).await.unwrap();
    (dir, pool)
}
pub(in crate::db::connect_transfer) async fn input(pool: &SqlitePool) -> Reservation {
    Reservation {
        native_authority: None,
        native_target_prepared: None,
        native_target_activation: None,
        native_lineage_id: String::new(),
        native_installation_id: String::new(),
        native_birth_generation: String::new(),
        transfer_id: uuid::Uuid::new_v4().to_string(),
        relay_origin: "https://relay.invalid".into(),
        account_id: "account-1".into(),
        source_instance_id: "source-pc".into(),
        source_conversation_id: "source".into(),
        source_epoch: 1,
        target_instance_id: "target-pc".into(),
        source_generation: "source-generation".into(),
        target_generation: "target-generation".into(),
        binding_digest: vec![1; 32],
        // Storage-only closed bytes. Tests do not claim canonical reception.
        binding_json: br#"{"synthetic":"binding"}"#.to_vec(),
        expectation_json: br#"{"synthetic":"expectation"}"#.to_vec(),
        reserve_request: br#"{"synthetic":"reserve"}"#.to_vec(),
        expected_ownership_revision: 1,
        expected_content: db::conversation_content::conversation_content_version(pool, "source")
            .await
            .unwrap(),
    }
}
pub(in crate::db::connect_transfer) async fn inspected(
    pool: &SqlitePool,
) -> (DbPool, ChatAdmissionRuntime, String, Reservation) {
    let owner = DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let runtime = ChatAdmissionRuntime::default();
    runtime
        .open_browser(owner.clone(), "window", "browser")
        .await
        .unwrap();
    let handle = runtime
        .begin_reconciliation(&owner, "window", "browser", "source")
        .await
        .unwrap();
    runtime
        .complete_reconciliation(
            &owner,
            "window",
            "browser",
            &handle,
            &BrowserInspection {
                queue: vec![],
                unsaved: vec![],
                approvals: vec![],
                questions: vec![],
                drafts: vec![],
                steers: vec![],
            },
        )
        .await
        .unwrap();
    let mut input = input(pool).await;
    input.expected_ownership_revision = sqlx::query_scalar::<_, i64>(
        "SELECT revision+1 FROM chat_admission_owners WHERE conversation_id='source'",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    (owner, runtime, handle, input)
}

/// Storage-only chain fixture. Reservation fields remain private to journal;
/// reconciliation and freezing still use the real native 017 owner.
pub(in crate::db::connect_transfer) async fn reserve_published_as_source(
    pool: &SqlitePool,
    conversation: &str,
) -> (DbPool, String) {
    let owner = DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let runtime = ChatAdmissionRuntime::default();
    runtime
        .open_browser(owner.clone(), "chain-window", "chain-browser")
        .await
        .unwrap();
    let inspection = runtime
        .begin_reconciliation(&owner, "chain-window", "chain-browser", conversation)
        .await
        .unwrap();
    runtime
        .complete_reconciliation(
            &owner,
            "chain-window",
            "chain-browser",
            &inspection,
            &BrowserInspection {
                queue: vec![],
                unsaved: vec![],
                approvals: vec![],
                questions: vec![],
                drafts: vec![],
                steers: vec![],
            },
        )
        .await
        .unwrap();
    let mut outgoing = input(pool).await;
    outgoing.source_conversation_id = conversation.into();
    outgoing.source_instance_id = "target-pc".into();
    outgoing.target_instance_id = "third-pc".into();
    outgoing.expected_ownership_revision = sqlx::query_scalar::<_, i64>(
        "SELECT revision+1 FROM chat_admission_owners WHERE conversation_id=?",
    )
    .bind(conversation)
    .fetch_one(pool)
    .await
    .unwrap();
    outgoing.expected_content =
        db::conversation_content::conversation_content_version(pool, conversation)
            .await
            .unwrap();
    runtime
        .reserve_reconciled_transfer(
            &owner,
            "chain-window",
            "chain-browser",
            &inspection,
            &outgoing,
        )
        .await
        .unwrap();
    (owner, outgoing.transfer_id)
}
#[tokio::test]
async fn connect_transfer_reserves_on_a_new_database_without_preseeded_budget() {
    let dir = TempDir::new().unwrap();
    let pool = db::create_pool(&dir.path().join("fresh.db")).await.unwrap();
    sqlx::raw_sql("INSERT INTO conversations(id,title,scope_mode,created_at,updated_at) VALUES('source','Synthetic','Chat','t','t'); INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES('message','source','user','complete history','t');")
        .execute(&pool).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM e_inactive_domain")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    let (owner, runtime, handle, input) = inspected(&pool).await;
    runtime
        .reserve_reconciled_transfer(&owner, "window", "browser", &handle, &input)
        .await
        .unwrap();
    let policy: (i64, i64) =
        sqlx::query_as("SELECT budget_bytes,max_receipts FROM e_inactive_domain WHERE singleton=1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(policy, (16 * 1024 * 1024, 64));
}

#[tokio::test]
async fn connect_transfer_freeze_and_identity_commit_together_with_real_017_guards() {
    let (_dir, pool) = fixture().await;
    let (owner, runtime, handle, mut input) = inspected(&pool).await;
    let receipt = runtime
        .reserve_reconciled_transfer(&owner, "window", "browser", &handle, &input)
        .await
        .unwrap();
    assert_eq!(
        receipt.ownership_revision,
        Some(input.expected_ownership_revision)
    );
    let replay = runtime
        .reserve_reconciled_transfer(&owner, "window", "browser", &handle, &input)
        .await
        .unwrap();
    assert_eq!(
        (
            &replay.transfer_id,
            &replay.fingerprint,
            replay.ownership_revision
        ),
        (
            &receipt.transfer_id,
            &receipt.fingerprint,
            receipt.ownership_revision
        )
    );
    assert!(receipt.native_source_frozen);
    assert!(!replay.native_source_frozen);
    input.reserve_request.push(b' ');
    assert!(runtime
        .reserve_reconciled_transfer(&owner, "window", "browser", &handle, &input)
        .await
        .is_err());
    assert!(
        db::repository::rename_conversation(&pool, "source", "blocked")
            .await
            .is_err()
    );
    assert!(sqlx::query(
        "UPDATE chat_admission_owners SET mode='open' WHERE conversation_id='source'"
    )
    .execute(&pool)
    .await
    .is_err());
    let mut competing = input.clone();
    competing.transfer_id = uuid::Uuid::new_v4().to_string();
    competing.source_epoch = 2;
    assert!(runtime
        .reserve_reconciled_transfer(&owner, "window", "browser", &handle, &competing)
        .await
        .is_err());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM connect_transfers")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    let state:(String,String,i64)=sqlx::query_as("SELECT o.mode,t.transfer_id,t.source_epoch FROM chat_admission_owners o JOIN connect_transfers t ON t.source_conversation_id=o.conversation_id").fetch_one(&pool).await.unwrap();
    assert_eq!(state, ("frozen".into(), input.transfer_id.clone(), 1));
    // No terminal API exists in this slice. Local time or a not_found error has
    // no mutation path, and restart reconciliation preserves the same freeze.
    db::chat_admission::reconcile_after_restart(&pool)
        .await
        .unwrap();
    let state:(String,String)=sqlx::query_as("SELECT o.mode,t.phase FROM chat_admission_owners o JOIN connect_transfers t ON t.source_conversation_id=o.conversation_id").fetch_one(&pool).await.unwrap();
    assert_eq!(state, ("frozen".into(), "reconciliation_required".into()));
}
#[tokio::test]
async fn connect_transfer_refused_journal_or_stale_inspection_cannot_leave_a_freeze() {
    for stale in [false, true] {
        let (_dir, pool) = fixture().await;
        let (owner, runtime, handle, input) = inspected(&pool).await;
        if stale {
            db::repository::rename_conversation(&pool, "source", "changed")
                .await
                .unwrap();
        } else {
            sqlx::query("UPDATE e_inactive_domain SET budget_bytes=1")
                .execute(&pool)
                .await
                .unwrap();
        }
        assert!(runtime
            .reserve_reconciled_transfer(&owner, "window", "browser", &handle, &input)
            .await
            .is_err());
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT mode FROM chat_admission_owners WHERE conversation_id='source'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            "open"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM connect_transfers")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
    }
}
#[tokio::test]
async fn connect_transfer_competing_native_work_or_writer_has_one_winner() {
    for writer in [false, true] {
        let (_dir, pool) = fixture().await;
        let (owner, runtime, handle, input) = inspected(&pool).await;
        if writer {
            let (reserved, written) = tokio::join!(
                runtime.reserve_reconciled_transfer(&owner, "window", "browser", &handle, &input),
                db::repository::rename_conversation(&pool, "source", "changed")
            );
            assert_ne!(reserved.is_ok(), written.is_ok());
        } else {
            let (reserved, admitted) = tokio::join!(
                runtime.reserve_reconciled_transfer(&owner, "window", "browser", &handle, &input),
                db::chat_admission::OperationPermit::begin_turn(
                    owner.clone(),
                    "source",
                    "competing"
                )
            );
            assert_ne!(reserved.is_ok(), admitted.is_ok());
        }
    }
}
fn session(input: &Reservation, bytes: i64) -> Session {
    Session {
        transfer_id: input.transfer_id.clone(),
        transit_id: uuid::Uuid::new_v4().to_string(),
        producer_generation: input.target_generation.clone(),
        binding_digest: input.binding_digest.clone(),
        session_json: br#"{"synthetic":"session"}"#.to_vec(),
        stream_bytes: bytes,
    }
}
fn chunk<'a>(sequence: i64, offset: i64, data: &'a [u8], hash: &'a [u8], eof: bool) -> Chunk<'a> {
    Chunk {
        sequence,
        offset,
        data,
        sha256: hash,
        eof,
    }
}
#[tokio::test]
async fn connect_transfer_raw_staging_retries_reopen_exact_bytes_and_bills_once() {
    let (dir, pool) = fixture().await;
    let input = input(&pool).await;
    reserve_target(&pool, &input).await.unwrap();
    let session = session(&input, 65_539);
    staging::open_prefix(&pool, &session).await.unwrap();
    let data = vec![b'x'; 65_536];
    let digest = hash(&data);
    let first = chunk(0, 0, &data, &digest, false);
    let prefix = staging::stage(&pool, &session, &first).await.unwrap();
    let charged = db::inactive_budget::retained(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        staging::stage(&pool, &session, &first).await.unwrap(),
        prefix
    );
    assert_eq!(
        db::inactive_budget::retained(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap(),
        charged
    );
    let final_hash = hash(b"\xC3\xA9\n");
    let final_chunk = chunk(1, 65_536, b"\xC3\xA9\n", &final_hash, true);
    let end = staging::stage(&pool, &session, &final_chunk).await.unwrap();
    assert!(end.eof);
    assert_eq!((end.next_sequence, end.next_offset), (2, 65_539));
    assert_eq!(
        staging::stage(&pool, &session, &final_chunk).await.unwrap(),
        end
    );
    pool.close().await;
    let pool = db::create_pool(&dir.path().join("journal.db"))
        .await
        .unwrap();
    assert_eq!(staging::open_prefix(&pool, &session).await.unwrap(), end);
    assert_eq!(staging::read_chunk(&pool, &session, 0).await.unwrap(), data);
    assert_eq!(
        staging::read_chunk(&pool, &session, 1).await.unwrap(),
        b"\xC3\xA9\n"
    );
    // Only the last descriptor may be retried, and EOF is not a prepared pin.
    assert!(staging::stage(&pool, &session, &first).await.is_err());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM conversations")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM e_inactive_imports")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
}
#[tokio::test]
async fn connect_transfer_raw_refusals_and_disk_limit_leave_the_prefix_unchanged() {
    let (_dir, pool) = fixture().await;
    let input = input(&pool).await;
    reserve_target(&pool, &input).await.unwrap();
    let mut session = session(&input, 4);
    let empty = staging::open_prefix(&pool, &session).await.unwrap();
    let digest = hash(b"ab");
    for invalid in [
        chunk(1, 0, b"ab", &digest, false),
        chunk(0, 1, b"ab", &digest, false),
        chunk(0, 0, b"ab", &digest, true),
        chunk(0, 0, b"xx", &digest, false),
    ] {
        assert!(staging::stage(&pool, &session, &invalid).await.is_err());
        assert_eq!(staging::open_prefix(&pool, &session).await.unwrap(), empty);
    }
    let original = session.transit_id.clone();
    session.transit_id = uuid::Uuid::new_v4().to_string();
    assert!(staging::open_prefix(&pool, &session).await.is_err());
    session.transit_id = original;
    sqlx::query("UPDATE e_inactive_domain SET budget_bytes=1")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        staging::stage(&pool, &session, &chunk(0, 0, b"ab", &digest, false))
            .await
            .is_err()
    );
    assert_eq!(staging::open_prefix(&pool, &session).await.unwrap(), empty);
}
#[tokio::test]
async fn connect_transfer_exchange_acceptance_and_result_are_durable_local_facts() {
    let (dir, pool) = fixture().await;
    let input = input(&pool).await;
    reserve_target(&pool, &input).await.unwrap();
    let mut exchange = Exchange {
        delivery_id: uuid::Uuid::new_v4().to_string(),
        transfer_id: input.transfer_id.clone(),
        challenge_id: uuid::Uuid::new_v4().to_string(),
        request_id: "request-1".into(),
        kind: "target_pinned".into(),
        subject_digest: vec![2; 32],
        prior_receipt_digest: None,
        producer_generation: input.target_generation.clone(),
        connection_id: uuid::Uuid::new_v4().to_string(),
        canonical_request: br#"{"synthetic":"challenge"}"#.to_vec(),
        expectation_json: br#"{"synthetic":"expectation"}"#.to_vec(),
    };
    let accepted = accept_exchange(&pool, &exchange).await.unwrap();
    assert_eq!(accept_exchange(&pool, &exchange).await.unwrap(), accepted);
    exchange.expectation_json.push(b' ');
    assert!(accept_exchange(&pool, &exchange).await.is_err());
    exchange.expectation_json.pop();
    record_local_result(
        &pool,
        &exchange.delivery_id,
        &accepted,
        b"local-unit-result",
    )
    .await
    .unwrap();
    assert!(
        record_local_result(&pool, &exchange.delivery_id, &accepted, b"changed")
            .await
            .is_err()
    );
    pool.close().await;
    let pool = db::create_pool(&dir.path().join("journal.db"))
        .await
        .unwrap();
    record_local_result(
        &pool,
        &exchange.delivery_id,
        &accepted,
        b"local-unit-result",
    )
    .await
    .unwrap();
    let row: (String, Vec<u8>) =
        sqlx::query_as("SELECT phase,local_result FROM connect_exchanges WHERE delivery_id=?")
            .bind(&exchange.delivery_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        row,
        ("result_pending".into(), b"local-unit-result".to_vec())
    );
}
#[tokio::test]
async fn connect_transfer_restore_hold_survives_reopen_and_refuses_more_bytes() {
    let (dir, pool) = fixture().await;
    let input = input(&pool).await;
    reserve_target(&pool, &input).await.unwrap();
    let session = session(&input, 2);
    let before = staging::open_prefix(&pool, &session).await.unwrap();
    db::chat_admission::hold_restored_profile(&pool)
        .await
        .unwrap();
    pool.close().await;
    let pool = db::create_pool(&dir.path().join("journal.db"))
        .await
        .unwrap();
    let owner = DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let digest = hash(b"ab");
    assert!(
        staging::stage(&pool, &session, &chunk(0, 0, b"ab", &digest, true))
            .await
            .is_err()
    );
    assert_eq!(staging::open_prefix(&pool, &session).await.unwrap(), before);
    let row: (i64, String) = sqlx::query_as("SELECT restore_hold,phase FROM connect_transfers")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row, (1, "reconciliation_required".into()));
}
#[tokio::test]
async fn connect_transfer_budget_checks_native_i64_sums_without_real_promotion() {
    let (_dir, pool) = fixture().await;
    let input = input(&pool).await;
    reserve_target(&pool, &input).await.unwrap();
    let session = session(&input, 1);
    staging::open_prefix(&pool, &session).await.unwrap();
    sqlx::query("UPDATE connect_transfers SET charge_bytes=9223372036854775807")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        db::inactive_budget::retained(&mut *pool.acquire().await.unwrap())
            .await
            .is_err()
    );
    let digest = hash(b"x");
    assert!(
        staging::stage(&pool, &session, &chunk(0, 0, b"x", &digest, true))
            .await
            .is_err()
    );
}
#[tokio::test]
async fn connect_transfer_missing_or_altered_retention_guard_fails_before_ready() {
    let (_dir, pool) = fixture().await;
    sqlx::query("DROP TRIGGER connect_fragments_delete")
        .execute(&pool)
        .await
        .unwrap();
    assert!(db::validate_source_opening(&pool, None).await.is_err());
    let owner = DbPool::default();
    assert!(owner.set_ready(pool).await.is_err());
}

#[tokio::test]
async fn connect_transfer_attachment_validates_bindings_and_retains_immutable_resource_relation() {
    let (_dir, pool) = fixture().await;
    let (owner, runtime, handle, input) = inspected(&pool).await;
    runtime
        .reserve_reconciled_transfer(&owner, "window", "browser", &handle, &input)
        .await
        .unwrap();
    let generation = match owner.current() {
        crate::core::db_state::DbInitializationState::Ready(ready) => ready.catalog_generation,
        _ => panic!("ready fixture"),
    };
    let dependencies: (String, i64) =
        sqlx::query_as("SELECT incarnation,revision FROM e_source_version")
            .fetch_one(&pool)
            .await
            .unwrap();
    let schema: i64 = sqlx::query_scalar("PRAGMA schema_version")
        .fetch_one(&pool)
        .await
        .unwrap();
    let binding=serde_json::json!({"version":1,"conversation":"source","generation":generation,"actor":"synthetic","content":input.expected_content,"dependencies":{"incarnation":dependencies.0,"revision":dependencies.1},"schema":schema,"budget":16777216,"max_receipts":64}).to_string();
    let capture = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO e_source_captures(capture_id,binding_json,phase,revision,family,cursor_field,cursor_offset,row_ordinal,fields_count,rows_count,bytes_received,charge_bytes,created_at,progressed_at,expires_at,idle_ms,last_clock) VALUES(?,?,0,0,0,0,0,0,0,0,0,1024,0,0,1,1,0)")
        .bind(&capture).bind(&binding).execute(&pool).await.unwrap();
    attach_capture(&pool, &input, &capture).await.unwrap();
    attach_capture(&pool, &input, &capture).await.unwrap();
    let other = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO e_source_captures(capture_id,binding_json,phase,revision,family,cursor_field,cursor_offset,row_ordinal,fields_count,rows_count,bytes_received,charge_bytes,created_at,progressed_at,expires_at,idle_ms,last_clock) VALUES(?,?,0,0,0,0,0,0,0,0,0,1024,0,0,1,1,0)")
        .bind(&other).bind(&binding).execute(&pool).await.unwrap();
    assert!(attach_capture(&pool, &input, &other).await.is_err());
    assert!(
        sqlx::query("UPDATE e_source_captures SET phase=4,charge_bytes=0 WHERE capture_id=?")
            .bind(&capture)
            .execute(&pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("DELETE FROM e_source_captures WHERE capture_id=?")
            .bind(&capture)
            .execute(&pool)
            .await
            .is_err()
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM e_source_captures")
            .fetch_one(&pool)
            .await
            .unwrap(),
        2
    );
}

#[tokio::test]
async fn connect_transfer_target_import_attachment_uses_full_source_and_generation_identity() {
    use crate::db::inactive_storage::{identity_key, Begin, Bindings, Identity, Profile};
    let (_dir, pool) = fixture().await;
    let input = input(&pool).await;
    reserve_target(&pool, &input).await.unwrap();
    let mut begin = Begin {
        version: 1,
        identity: Identity {
            origin: input.relay_origin.clone(),
            account_incarnation: input.account_id.clone(),
            source_instance: input.source_instance_id.clone(),
            source_conversation: input.source_conversation_id.clone(),
            transfer: input.transfer_id.clone(),
            source_epoch: input.source_epoch.to_string(),
        },
        bindings: Bindings {
            target_instance: input.target_instance_id.clone(),
            source_generation: input.source_generation.clone(),
            target_generation: input.target_generation.clone(),
            actor: "synthetic".into(),
            initial_session: "synthetic".into(),
            policy_revision: "synthetic".into(),
        },
        profile: Profile::PortableChatHistoryV1,
        records: 1,
        bytes: 1,
        manifest_sha256: "0".repeat(64),
    };
    let key = identity_key(&begin.identity).unwrap();
    begin.bindings.target_generation = "wrong-generation".into();
    sqlx::query("INSERT INTO e_inactive_imports(identity_key,begin_json,phase,revision,next_record,received_bytes,charge_bytes,created_at,progressed_at,expires_at,idle_ms,last_clock) VALUES(?,?,0,0,0,0,1024,0,0,1,1,0)")
        .bind(&key).bind(serde_json::to_string(&begin).unwrap()).execute(&pool).await.unwrap();
    assert!(attach_import(&pool, &input, &key).await.is_err());
    begin.bindings.target_generation = input.target_generation.clone();
    sqlx::query("UPDATE e_inactive_imports SET begin_json=? WHERE identity_key=?")
        .bind(serde_json::to_string(&begin).unwrap())
        .bind(&key)
        .execute(&pool)
        .await
        .unwrap();
    attach_import(&pool, &input, &key).await.unwrap();
    attach_import(&pool, &input, &key).await.unwrap();
    assert!(
        sqlx::query("UPDATE e_inactive_imports SET phase=4 WHERE identity_key=?")
            .bind(&key)
            .execute(&pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("DELETE FROM e_inactive_imports WHERE identity_key=?")
            .bind(&key)
            .execute(&pool)
            .await
            .is_err()
    );
    db::chat_admission::hold_restored_profile(&pool)
        .await
        .unwrap();
    assert!(attach_import(&pool, &input, &key).await.is_err());
}

#[tokio::test]
async fn connect_transfer_sqlite_full_returns_no_prefix_and_rolls_back_storage_charge() {
    let (dir, pool) = fixture().await;
    let input = input(&pool).await;
    reserve_target(&pool, &input).await.unwrap();
    let session = session(&input, 65_536);
    let before = staging::open_prefix(&pool, &session).await.unwrap();
    let retained = db::inactive_budget::retained(&mut *pool.acquire().await.unwrap())
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
    let data = vec![b'x'; 65_536];
    let digest = hash(&data);
    let error = staging::stage(&pool, &session, &chunk(0, 0, &data, &digest, true))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("full"), "{error}");
    assert_eq!(staging::open_prefix(&pool, &session).await.unwrap(), before);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM connect_raw_chunks")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        db::inactive_budget::retained(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap(),
        retained
    );
}

#[tokio::test]
async fn connect_transfer_migration_and_stamp_roll_back_together() {
    // A schema reference has no user conversations. Seeded journal fixtures do.
    let dir = tempfile::tempdir().unwrap();
    let pool = db::create_pool(&dir.path().join("journal.db"))
        .await
        .unwrap();
    crate::db::connect_transfer::remove_reference_schema_in(&mut *pool.acquire().await.unwrap())
        .await
        .unwrap();
    sqlx::raw_sql("DELETE FROM schema_migrations WHERE version>=18; CREATE TRIGGER synthetic_reject_f_stamp BEFORE INSERT ON schema_migrations WHEN NEW.version=18 BEGIN SELECT RAISE(ABORT,'synthetic'); END;").execute(&pool).await.unwrap();
    pool.close().await;
    assert!(db::create_pool(&dir.path().join("journal.db"))
        .await
        .is_err());
    let mut connection = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(dir.path().join("journal.db")),
    )
    .await
    .unwrap();
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM sqlite_master WHERE name GLOB 'connect_*' OR tbl_name GLOB 'connect_*'").fetch_one(&mut connection).await.unwrap(),0);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM schema_migrations WHERE version=18")
            .fetch_one(&mut connection)
            .await
            .unwrap(),
        0
    );
    connection.close().await.unwrap();
}

fn maintenance(input: &Reservation, source: bool) -> Exchange {
    Exchange {
        delivery_id: uuid::Uuid::new_v4().to_string(),
        transfer_id: input.transfer_id.clone(),
        challenge_id: uuid::Uuid::new_v4().to_string(),
        request_id: "maintenance-request".into(),
        kind: if source {
            "source_maintained"
        } else {
            "target_maintained"
        }
        .into(),
        subject_digest: vec![3; 32],
        prior_receipt_digest: Some(vec![4; 32]),
        producer_generation: if source {
            input.source_generation.clone()
        } else {
            input.target_generation.clone()
        },
        connection_id: uuid::Uuid::new_v4().to_string(),
        canonical_request: br#"{"synthetic":"maintenance-request"}"#.to_vec(),
        expectation_json: br#"{"synthetic":"maintenance-expectation"}"#.to_vec(),
    }
}
#[tokio::test]
async fn connect_transfer_restart_refuses_new_exchange_and_new_result_but_keeps_receipts() {
    let (_dir, pool) = fixture().await;
    let input = input(&pool).await;
    reserve_target(&pool, &input).await.unwrap();
    let exchange = maintenance(&input, false);
    let fingerprint = accept_exchange(&pool, &exchange).await.unwrap();
    db::chat_admission::reconcile_after_restart(&pool)
        .await
        .unwrap();
    assert_eq!(
        accept_exchange(&pool, &exchange).await.unwrap(),
        fingerprint
    );
    let next = maintenance(&input, false);
    let error = accept_exchange(&pool, &next).await.unwrap_err();
    assert!(
        error.to_string().contains("connect_transfer_recovery_hold"),
        "{error}"
    );
    assert!(record_local_result(
        &pool,
        &exchange.delivery_id,
        &fingerprint,
        b"new local result"
    )
    .await
    .is_err());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM connect_exchanges")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
}
#[tokio::test]
async fn connect_transfer_maintenance_renews_only_recorded_slot_with_bounded_previous_receipt() {
    for source in [false, true] {
        let (_dir, pool) = fixture().await;
        let input = if source {
            let (owner, runtime, handle, input) = inspected(&pool).await;
            runtime
                .reserve_reconciled_transfer(&owner, "window", "browser", &handle, &input)
                .await
                .unwrap();
            input
        } else {
            let input = input(&pool).await;
            reserve_target(&pool, &input).await.unwrap();
            input
        };
        let mut current = maintenance(&input, source);
        let mut fingerprint = accept_exchange(&pool, &current).await.unwrap();
        let unrecorded = RecordedExchange {
            transfer_id: input.transfer_id.clone(),
            kind: current.kind.clone(),
            delivery_id: current.delivery_id.clone(),
            fingerprint: fingerprint.clone(),
            receipt: b"storage-only-receipt".to_vec(),
        };
        assert!(
            renew_maintained_exchange(&pool, &maintenance(&input, source), &unrecorded)
                .await
                .is_err()
        );
        let mut steady_charge = None;
        for _ in 0..6 {
            record_local_result(
                &pool,
                &current.delivery_id,
                &fingerprint,
                b"storage-only-result",
            )
            .await
            .unwrap();
            let recorded = record_exchange_receipt(
                &pool,
                &current.delivery_id,
                &fingerprint,
                b"storage-only-receipt",
            )
            .await
            .unwrap();
            assert!(record_exchange_receipt(
                &pool,
                &current.delivery_id,
                &fingerprint,
                b"changed receipt"
            )
            .await
            .is_err());
            let mut next = maintenance(&input, source);
            // Keep connection identity and request fixed: a new challenge can be
            // needed for the same canonical commit request, not only a new one.
            next.connection_id = current.connection_id.clone();
            assert!(accept_exchange(&pool, &next)
                .await
                .unwrap_err()
                .to_string()
                .contains("renewal_required"));
            let next_fingerprint = renew_maintained_exchange(&pool, &next, &recorded)
                .await
                .unwrap();
            assert_eq!(accept_exchange(&pool, &current).await.unwrap(), fingerprint);
            record_local_result(
                &pool,
                &current.delivery_id,
                &fingerprint,
                b"storage-only-result",
            )
            .await
            .unwrap();
            record_exchange_receipt(
                &pool,
                &current.delivery_id,
                &fingerprint,
                b"storage-only-receipt",
            )
            .await
            .unwrap();
            current.expectation_json.push(b' ');
            assert!(accept_exchange(&pool, &current).await.is_err());
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM connect_exchanges")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                1
            );
            let charge: i64 = sqlx::query_scalar("SELECT charge_bytes FROM connect_exchanges")
                .fetch_one(&pool)
                .await
                .unwrap();
            if let Some(previous) = steady_charge {
                assert_eq!(charge, previous);
            } else {
                steady_charge = Some(charge);
            }
            current = next;
            fingerprint = next_fingerprint;
        }
        db::chat_admission::reconcile_after_restart(&pool)
            .await
            .unwrap();
        let previous = RecordedExchange {
            transfer_id: input.transfer_id.clone(),
            kind: current.kind.clone(),
            delivery_id: current.delivery_id.clone(),
            fingerprint: fingerprint.clone(),
            receipt: b"storage-only-receipt".to_vec(),
        };
        let error = renew_maintained_exchange(&pool, &maintenance(&input, source), &previous)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("recovery_hold"), "{error}");
    }
}

pub(in crate::db::connect_transfer) async fn target_for_publication(
    pool: &SqlitePool,
) -> (String, crate::db::inactive_storage::Begin) {
    use crate::db::inactive_storage::{Begin, Bindings, Identity, Profile};
    let input = input(pool).await;
    reserve_target(pool, &input).await.unwrap();
    let session = session(&input, 3);
    staging::open_prefix(pool, &session).await.unwrap();
    let digest = hash(b"raw");
    staging::stage(pool, &session, &chunk(0, 0, b"raw", &digest, true))
        .await
        .unwrap();
    let begin = Begin {
        version: 1,
        identity: Identity {
            origin: input.relay_origin.clone(),
            account_incarnation: input.account_id.clone(),
            source_instance: input.source_instance_id.clone(),
            source_conversation: input.source_conversation_id.clone(),
            transfer: input.transfer_id.clone(),
            source_epoch: input.source_epoch.to_string(),
        },
        bindings: Bindings {
            target_instance: input.target_instance_id.clone(),
            source_generation: input.source_generation.clone(),
            target_generation: input.target_generation.clone(),
            actor: "synthetic".into(),
            initial_session: "synthetic".into(),
            policy_revision: "synthetic".into(),
        },
        profile: Profile::SyntheticHistoryV1,
        records: 0,
        bytes: 0,
        manifest_sha256: "0".repeat(64),
    };
    (input.transfer_id, begin)
}
pub(in crate::db::connect_transfer) async fn attach_for_publication(
    pool: &SqlitePool,
    transfer: &str,
    key: &str,
) {
    let mut input = input(pool).await;
    input.transfer_id = transfer.into();
    attach_import(pool, &input, key).await.unwrap();
}
pub(in crate::db::connect_transfer) async fn source_for_terminal(pool: &SqlitePool) -> String {
    let (owner, runtime, handle, input) = inspected(pool).await;
    runtime
        .reserve_reconciled_transfer(&owner, "window", "browser", &handle, &input)
        .await
        .unwrap();
    input.transfer_id
}

pub(in crate::db::connect_transfer) async fn reserve_next_source_after_abort(
    pool: &SqlitePool,
    owner: &DbPool,
    runtime: &ChatAdmissionRuntime,
) {
    let handle = runtime
        .begin_reconciliation(owner, "window", "browser", "source")
        .await
        .unwrap();
    runtime
        .complete_reconciliation(
            owner,
            "window",
            "browser",
            &handle,
            &BrowserInspection {
                queue: vec![],
                unsaved: vec![],
                approvals: vec![],
                questions: vec![],
                drafts: vec![],
                steers: vec![],
            },
        )
        .await
        .unwrap();
    let mut next = input(pool).await;
    next.source_epoch = 2;
    next.expected_ownership_revision = sqlx::query_scalar(
        "SELECT revision+1 FROM chat_admission_owners WHERE conversation_id='source'",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    runtime
        .reserve_reconciled_transfer(owner, "window", "browser", &handle, &next)
        .await
        .unwrap();
}
