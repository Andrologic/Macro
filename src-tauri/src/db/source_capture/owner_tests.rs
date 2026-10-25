use super::*;
use crate::{
    core::db_state::{DbInitializationState, DbPool},
    db::source_capture::{owner::*, types::*},
};
use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicI64, Ordering},
    Arc,
};
use tokio::sync::{RwLock, Semaphore};
#[path = "opening_lifetime_tests.rs"]
mod opening_lifetime_tests;
#[path = "schema_trust_tests.rs"]
mod schema_trust_tests;
fn json<T: serde::Serialize>(v: &T) -> Vec<u8> {
    serde_json::to_vec(v).unwrap()
}
async fn authorized(
    owner: DbPool,
    capture_id: String,
    mode: Mode,
    clock: Arc<AtomicI64>,
) -> SourceCapture {
    let DbInitializationState::Ready(ready) = owner.current() else {
        panic!("ready fixture required")
    };
    SourceCapture {
        transport: None,
        owner,
        generation: Some(ready.catalog_generation),
        authority: Some(Arc::new(RwLock::new(Authority {
            enabled: true,
            capture_id,
            conversation: "s".into(),
            actor: "synthetic-actor".into(),
            mode,
            policy: Policy {
                budget: 128 * 1024 * 1024,
                max_receipts: 64,
                absolute_ms: 3_600_000,
                idle_ms: 600_000,
            },
        }))),
        permit: Arc::new(Semaphore::new(1)),
        clock: Arc::new(move || clock.load(Ordering::SeqCst)),
        cleanup_started: None,
        reads: Arc::default(),
    }
}
async fn capture_fixture() -> (TempDir, SqlitePool, SourceCapture, Arc<AtomicI64>) {
    let (dir, pool) = fixture().await;
    let owner = DbPool::default();
    owner.set_ready(pool.clone()).await.unwrap();
    let clock = Arc::new(AtomicI64::new(1_000_000));
    let capture = authorized(
        owner,
        uuid::Uuid::new_v4().to_string(),
        Mode::Continue,
        clock.clone(),
    )
    .await;
    (dir, pool, capture, clock)
}
async fn begin(c: &SourceCapture) -> Receipt {
    let id = c
        .authority
        .as_ref()
        .unwrap()
        .read()
        .await
        .capture_id
        .clone();
    c.begin(&json(&Open {
        capture_id: id,
        conversation_id: "s".into(),
    }))
    .await
    .unwrap()
}
async fn copy_all(c: &SourceCapture) -> Receipt {
    let mut receipt = c.status().await.unwrap();
    for _ in 0..100_000 {
        let result = c
            .copy_next(&json(&Copy {
                cursor: receipt.cursor.clone(),
                expected_revision: receipt.revision,
            }))
            .await
            .unwrap();
        receipt = result.receipt;
        if result.ack.is_none() {
            return receipt;
        }
    }
    panic!("fixture exceeded work bound")
}
async fn rich(pool: &SqlitePool) {
    let bytes = b"required native asset\n";
    let digest = format!("{:x}", Sha256::digest(bytes));
    sqlx::query("UPDATE messages SET content=?,hidden_context=?,provider_input_items_json=?,context_refs_json=? WHERE id='m'").bind("history é🙂").bind("indispensable raw context ALPHA").bind(r#"[{"type":"message","content":"provider history"}]"#).bind(r#"[{"kind":"source","id":"orphan","title":"historical"}]"#).execute(pool).await.unwrap();
    sqlx::raw_sql("INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES('assistant','s','assistant','answer','u'),('unknown-role','s','system','historical data only','v'); INSERT INTO app_settings(key,value_json,updated_at) VALUES('chat:assistant-visible-provenance:v1:assistant','{\"version\":2}','t'); INSERT INTO conversation_compactions(conversation_id,up_to_message_id,summary_text,tool_digest_json,used_source_passage_ids_json,interesting_source_passage_ids_json,estimated_tokens_before,estimated_tokens_after,fingerprint,created_at,updated_at) VALUES('s','m','historical summary','[]','[\"orphan\"]','[]',1,1,'synthetic-fingerprint','t','t'); INSERT INTO conversation_citations(id,conversation_id,message_id,type,scope,source,title,content,created_at,updated_at) VALUES('orphan','s','no-message','document','context','synthetic','valid toolbox source','citation facts','t','t'); INSERT INTO conversation_toolbox_state VALUES('s','[]','t','t');").execute(pool).await.unwrap();
    sqlx::query("INSERT INTO pilot_message_attachments VALUES('asset','owner','instance','ref','m','asset.txt','text/plain',?,?,?)").bind(bytes.len() as i64).bind(digest).bind(bytes.as_slice()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO conversation_citations(id,conversation_id,message_id,type,scope,source,title,content,path,created_at,updated_at) VALUES('asset','s','m','file','context','pilot_attachment','asset.txt',?,'attachment://asset','t','t')").bind(std::str::from_utf8(bytes).unwrap()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO pilot_file_sends(owner_key,ref_key,send_intent_id,scope_key,digest,message_id,turn_id,state,attachment_ids_json,assistant_message_id,context_state,intent_expires_at) VALUES('owner','ref','intent','scope','digest','m','turn','confirmed','[\"asset\"]','removed-historical-assistant','ready',1)").execute(pool).await.unwrap();
}
#[tokio::test]
async fn closed_owner_refuses_every_method_before_ready_or_parsing() {
    let c = SourceCapture::closed(DbPool::default());
    assert_eq!(
        c.begin(b"not-json").await.unwrap_err(),
        "source_capture_disabled"
    );
    assert_eq!(
        c.copy_next(b"not-json").await.unwrap_err(),
        "source_capture_disabled"
    );
    assert_eq!(c.seal_raw().await.unwrap_err(), "source_capture_disabled");
    assert_eq!(c.status().await.unwrap_err(), "source_capture_disabled");
    assert_eq!(c.abort().await.unwrap_err(), "source_capture_disabled");
    assert_eq!(c.expire().await.unwrap_err(), "source_capture_disabled");
    assert_eq!(
        c.readback(None, 0).await.unwrap_err(),
        "source_capture_disabled"
    );
    assert_eq!(
        c.readback_relations(None, 0).await.unwrap_err(),
        "source_capture_disabled"
    );
}
#[tokio::test]
async fn real_native_capture_replays_and_reopens_sealed_after_source_deletion() {
    let (dir, pool, c, clock) = capture_fixture().await;
    rich(&pool).await;
    let content = conversation_content::conversation_content_version(&pool, "s")
        .await
        .unwrap();
    let dependencies = token(&pool).await;
    let catalog = crate::db::conversation_catalog::conversation_catalog_version(
        &pool,
        &"0".repeat(32),
        &crate::db::models::ConversationCatalogVersionInput::default(),
    )
    .await
    .unwrap();
    let first = begin(&c).await;
    let request = json(&Copy {
        cursor: first.cursor,
        expected_revision: first.revision,
    });
    let copied = c.copy_next(&request).await.unwrap();
    let replay = c.copy_next(&request).await.unwrap();
    assert_eq!(copied.ack, replay.ack);
    assert_eq!(copied.receipt, replay.receipt);
    copy_all(&c).await;
    let sealed = c.seal_raw().await.unwrap();
    assert_eq!(sealed.receipt.phase, 2);
    assert!(!sealed.limits.is_empty());
    assert_eq!(
        content,
        conversation_content::conversation_content_version(&pool, "s")
            .await
            .unwrap()
    );
    assert_eq!(dependencies, token(&pool).await);
    assert_eq!(
        catalog,
        crate::db::conversation_catalog::conversation_catalog_version(
            &pool,
            &"0".repeat(32),
            &crate::db::models::ConversationCatalogVersionInput::default()
        )
        .await
        .unwrap()
    );
    let relations = c.readback_relations(None, 32).await.unwrap();
    assert!(relations.iter().any(|r| r.kind == 6 && r.status == 1));
    assert!(relations.iter().any(|r| r.kind == 11 && r.status == 2));
    assert!(relations.iter().any(|r| r.kind == 12 && r.status == 1));
    assert!(relations.iter().any(|r| r.kind == 13 && r.status == 0));
    let mut cursor = None;
    let mut hashes = Vec::new();
    loop {
        let page = c.readback(cursor, 32).await.unwrap();
        for f in &page.fragments {
            assert!(f.data.len() <= 4093);
            hashes.push((f.field.ordinal, f.offset, f.sha256.clone()));
        }
        cursor = page.next;
        if cursor.is_none() {
            break;
        }
    }
    let id = sealed.receipt.capture_id.clone();
    sqlx::query("DELETE FROM conversations WHERE id='s'")
        .execute(&pool)
        .await
        .unwrap();
    c.owner.set_initializing().await;
    pool.close().await;
    let reopened = create_pool(&dir.path().join("source.db")).await.unwrap();
    c.owner.set_ready(reopened.clone()).await.unwrap();
    assert!(c.readback(None, 32).await.is_err());
    let closed = SourceCapture::closed(c.owner.clone());
    assert_eq!(
        closed.status().await.unwrap_err(),
        "source_capture_disabled"
    );
    let read = authorized(c.owner.clone(), id, Mode::SealedRead, clock).await;
    let mut cursor = None;
    let mut restored = Vec::new();
    loop {
        let page = read.readback(cursor, 32).await.unwrap();
        assert_eq!(page.manifest.as_ref(), Some(&sealed.manifest));
        for f in page.fragments {
            restored.push((f.field.ordinal, f.offset, f.sha256));
        }
        cursor = page.next;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(hashes, restored);
    assert!(read.copy_next(b"{}").await.is_err());
    reopened.close().await;
}
#[tokio::test]
async fn source_mutation_refuses_copy_and_new_generation_can_only_abandon_incomplete() {
    let (_dir, pool, c, clock) = capture_fixture().await;
    begin(&c).await;
    sqlx::query("INSERT INTO conversation_toolbox_state VALUES('other','[]','t','t')")
        .execute(&pool)
        .await
        .unwrap();
    let before = c.status().await.unwrap();
    assert_eq!(
        c.copy_next(&json(&Copy {
            cursor: before.cursor.clone(),
            expected_revision: before.revision
        }))
        .await
        .unwrap_err(),
        "stale_revision"
    );
    assert_eq!(c.status().await.unwrap(), before);
    c.owner.set_ready(pool.clone()).await.unwrap();
    assert!(c.status().await.is_err());
    let recovery = authorized(
        c.owner.clone(),
        before.capture_id.clone(),
        Mode::Recovery,
        clock,
    )
    .await;
    assert_eq!(recovery.status().await.unwrap(), before);
    let terminal = recovery.abort().await.unwrap();
    assert_eq!(terminal.phase, 3);
    assert_eq!(terminal, recovery.abort().await.unwrap());
    assert!(recovery
        .begin(&json(&Open {
            capture_id: before.capture_id,
            conversation_id: "s".into()
        }))
        .await
        .is_err());
}

#[tokio::test]
async fn common_preparation_quota_counts_both_owners_and_staging_in_every_order() {
    use crate::db::{
        inactive_budget,
        inactive_storage::tests::{shared_attachment_reservation, shared_preparation_owner},
    };
    for order in [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ] {
        let (_dir, pool, c, clock) = capture_fixture().await;
        clock.store(1_800_000_000_000, Ordering::SeqCst);
        c.authority.as_ref().unwrap().write().await.policy.budget = 4096;
        let (target, intent) =
            shared_preparation_owner(pool.clone(), clock, 4096, 64, "shared-target").await;
        // Prepare the existing attachment authority/scope before opening a
        // capture. A zero-sized request fails native file validation and keeps
        // no upload bytes, while the synthetic scope is durable.
        assert!(shared_attachment_reservation(&pool, "prepare", 0)
            .await
            .is_err());
        let mut before = 0;
        for (index, which) in order.into_iter().enumerate() {
            let result = match which {
                0 => {
                    let id = c
                        .authority
                        .as_ref()
                        .unwrap()
                        .read()
                        .await
                        .capture_id
                        .clone();
                    c.begin(&json(&Open {
                        capture_id: id,
                        conversation_id: "s".into(),
                    }))
                    .await
                    .map(|_| ())
                }
                1 => target.begin(&json(&intent)).await.map(|_| ()),
                _ => shared_attachment_reservation(&pool, "reserved", 3000)
                    .await
                    .map(|_| ()),
            };
            if index < 2 {
                result.unwrap();
            } else {
                assert_eq!(result.unwrap_err(), "resource_limit");
            }
            let actual = inactive_budget::retained(&mut *pool.acquire().await.unwrap())
                .await
                .unwrap();
            if index == 2 {
                assert_eq!(actual, before, "refusal retained new bytes in {order:?}");
            } else {
                assert!(actual > before);
                before = actual;
            }
            assert!(actual <= 4096);
        }
    }
}
#[tokio::test]
async fn source_only_missing_domain_and_terminal_receipts_cannot_reset_common_budget() {
    use crate::db::{
        inactive_budget,
        inactive_storage::tests::{shared_attachment_reservation, shared_preparation_owner},
    };
    let (_dir, pool, c, clock) = capture_fixture().await;
    c.authority
        .as_ref()
        .unwrap()
        .write()
        .await
        .policy
        .max_receipts = 1;
    begin(&c).await;
    let terminal = c.abort().await.unwrap();
    assert_eq!(terminal.phase, 3);
    assert_eq!(
        inactive_budget::journal_count(&mut *pool.acquire().await.unwrap())
            .await
            .unwrap(),
        1
    );
    let (target, intent) = shared_preparation_owner(
        pool.clone(),
        clock.clone(),
        128 * 1024 * 1024,
        1,
        "new-target",
    )
    .await;
    assert_eq!(
        target.begin(&json(&intent)).await.unwrap_err(),
        "resource_limit"
    );
    sqlx::query("DELETE FROM e_inactive_domain")
        .execute(&pool)
        .await
        .unwrap();
    let another = authorized(
        c.owner.clone(),
        uuid::Uuid::new_v4().to_string(),
        Mode::Continue,
        clock.clone(),
    )
    .await;
    assert_eq!(
        another
            .begin(&json(&Open {
                capture_id: another
                    .authority
                    .as_ref()
                    .unwrap()
                    .read()
                    .await
                    .capture_id
                    .clone(),
                conversation_id: "s".into()
            }))
            .await
            .unwrap_err(),
        "database_unavailable"
    );
    let (target, intent) =
        shared_preparation_owner(pool.clone(), clock, 128 * 1024 * 1024, 64, "new-target-2").await;
    assert_eq!(
        target.begin(&json(&intent)).await.unwrap_err(),
        "database_unavailable"
    );
    assert_eq!(
        shared_attachment_reservation(&pool, "no-reset", 1)
            .await
            .unwrap_err(),
        "database_unavailable"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM e_inactive_domain")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM e_source_captures")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
}
#[tokio::test]
async fn raw_dependency_failure_and_expiration_publish_no_false_sealed_capture() {
    let (_dir, pool, c, clock) = capture_fixture().await;
    rich(&pool).await;
    sqlx::query("DELETE FROM pilot_message_attachments")
        .execute(&pool)
        .await
        .unwrap();
    begin(&c).await;
    copy_all(&c).await;
    assert!(c.seal_raw().await.is_err());
    assert_ne!(c.status().await.unwrap().phase, 2);
    let before = c.status().await.unwrap();
    clock.fetch_add(600_000, Ordering::SeqCst);
    let expired = c.expire().await.unwrap();
    assert_eq!(expired.phase, 4);
    assert!(expired.charge < before.charge);
    assert_eq!(expired, c.expire().await.unwrap());
}

#[path = "proof.rs"]
mod proof;

#[path = "failure_tests.rs"]
mod failure;
#[path = "portable_normalization_proof.rs"]
mod portable_normalization_proof;

#[tokio::test]
async fn connect_transfer_capture_lease_survives_ttl_and_restart_without_opening_source() {
    let (dir, pool, capture, clock) = capture_fixture().await;
    let receipt = begin(&capture).await;
    let runtime = crate::db::chat_admission::runtime::ChatAdmissionRuntime::default();
    runtime
        .open_browser(capture.owner.clone(), "window", "browser")
        .await
        .unwrap();
    let inspection = runtime
        .begin_reconciliation(&capture.owner, "window", "browser", "s")
        .await
        .unwrap();
    runtime
        .complete_reconciliation(
            &capture.owner,
            "window",
            "browser",
            &inspection,
            &crate::db::chat_admission::reconciliation::BrowserInspection {
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
    runtime
        .reserve_reconciled_source(&capture.owner, "window", "browser", &inspection)
        .await
        .unwrap();
    // This fixture installs only a lease relation after the real 017 freeze.
    // No fixture authority is added to any production constructor.
    sqlx::query("INSERT INTO connect_transfers(transfer_id,local_role,relay_origin,account_id,source_instance_id,source_conversation_id,source_epoch,target_instance_id,source_generation,target_generation,binding_digest,binding_json,expectation_json,reserve_request,fingerprint,local_generation,ownership_incarnation,ownership_revision,content_incarnation,content_revision,source_capture_id,phase,charge_bytes) SELECT '00000000-0000-4000-8000-000000000002','source','https://relay.invalid','account','source','s',1,'target','sg','tg',zeroblob(32),x'7b7d',x'7b7d',x'7b7d',zeroblob(32),json_extract(c.binding_json,'$.generation'),o.incarnation,o.revision,json_extract(c.binding_json,'$.content.incarnation'),json_extract(c.binding_json,'$.content.revision'),c.id,'reserved',512 FROM e_source_captures c JOIN chat_admission_owners o ON o.conversation_id='s' WHERE c.capture_id=?")
        .bind(&receipt.capture_id).execute(&pool).await.unwrap();
    clock.store(10_000_000, Ordering::SeqCst);
    assert_eq!(
        capture.expire().await.unwrap_err(),
        "connect_transfer_leased"
    );
    copy_all(&capture).await;
    let sealed = capture.seal_raw().await.unwrap();
    assert_eq!(sealed.receipt.phase, 2);
    assert!(sqlx::query("DELETE FROM e_source_fields")
        .execute(&pool)
        .await
        .is_err());
    capture.owner.set_initializing().await;
    drop(capture);
    drop(runtime);
    pool.close().await;
    let pool = create_pool(&dir.path().join("source.db")).await.unwrap();
    crate::db::chat_admission::reconcile_after_restart(&pool)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT mode FROM chat_admission_owners WHERE conversation_id='s'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        "frozen"
    );
    assert!(sqlx::query("DELETE FROM e_source_captures")
        .execute(&pool)
        .await
        .is_err());
    let owner=DbPool::default();owner.set_ready(pool.clone()).await.unwrap();
    let capture=authorized(owner.clone(),receipt.capture_id.clone(),Mode::SealedRead,clock).await;
    assert_eq!(capture.status().await.unwrap().phase,2);
    assert!(!capture.readback(None,32).await.unwrap().fragments.is_empty());
    crate::db::connect_transfer::commit_source_fixture(&pool,"00000000-0000-4000-8000-000000000002").await;
    crate::db::repository::delete_conversations_admitted(&owner,&["s".into()]).await.unwrap();
    assert_eq!(capture.status().await.unwrap_err(),"connect_content_removed");
    assert_eq!(capture.readback(None,32).await.unwrap_err(),"connect_content_removed");
    capture.authority.as_ref().unwrap().write().await.mode=Mode::Continue;
    assert_eq!(capture.seal_raw().await.unwrap_err(),"connect_content_removed");
    for table in ["e_source_fields","e_source_fragments","e_source_relations"] {
        assert_eq!(sqlx::query_scalar::<_,i64>(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}"))).fetch_one(&pool).await.unwrap(),0,"{table}");
    }
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM e_source_captures WHERE charge_bytes=216+length(CAST(binding_json AS BLOB))+length(manifest_hash)").fetch_one(&pool).await.unwrap(),1);
    assert_eq!(sqlx::query_scalar::<_,String>("SELECT mode FROM chat_admission_owners WHERE conversation_id='s'").fetch_one(&pool).await.unwrap(),"ceded");
    owner.set_initializing().await; owner.set_ready(pool.clone()).await.unwrap();
}
