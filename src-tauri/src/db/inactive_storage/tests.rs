use super::*;
use crate::db::create_pool;
use sqlx::sqlite::SqlitePoolOptions;
use std::sync::atomic::{AtomicI64, Ordering};
use tempfile::TempDir;

fn identity() -> Identity {
    Identity {
        origin: "synthetic".into(),
        account_incarnation: "account-1".into(),
        source_instance: "source-1".into(),
        source_conversation: "chat-1".into(),
        transfer: "transfer-1".into(),
        source_epoch: "epoch-1".into(),
    }
}
fn bindings() -> Bindings {
    Bindings {
        target_instance: "target-1".into(),
        source_generation: "source-generation-1".into(),
        target_generation: "target-generation-1".into(),
        actor: "actor-1".into(),
        initial_session: "session-1".into(),
        policy_revision: "policy-1".into(),
    }
}
fn active(pool: SqlitePool, clock: Arc<AtomicI64>) -> InactiveStorage {
    InactiveStorage {
        pool,
        authority: Some(Arc::new(RwLock::new(Authority {
            enabled: true,
            identity: identity(),
            bindings: bindings(),
            policy: Policy {
                budget: 128 * 1024 * 1024,
                max_receipts: 64,
                absolute_ms: 3_600_000,
                idle_ms: 600_000,
                secrets: vec![b"synthetic-private-token".to_vec()],
            },
        }))),
        clock: Arc::new(move || clock.load(Ordering::SeqCst)),
    }
}
fn intent(records: &[(RecordKind, Vec<u8>)]) -> (Begin, Vec<RecordHeader>) {
    let headers: Vec<_> = records
        .iter()
        .enumerate()
        .map(|(ordinal, (entry, bytes))| RecordHeader {
            ordinal: ordinal as u64,
            entry: entry.clone(),
            bytes: bytes.len() as u64,
            sha256: digest(bytes),
        })
        .collect();
    let mut begin = Begin {
        version: 1,
        identity: identity(),
        bindings: bindings(),
        profile: Profile::SyntheticHistoryV1,
        records: headers.len() as u64,
        bytes: records.iter().map(|(_, b)| b.len() as u64).sum(),
        manifest_sha256: "0".repeat(64),
    };
    let mut manifest = Manifest::new(&begin).unwrap();
    for header in &headers {
        manifest.record(header).unwrap();
    }
    begin.manifest_sha256 = manifest.finish();
    (begin, headers)
}
async fn append_record(store: &InactiveStorage, key: &str, header: &RecordHeader, payload: &[u8]) {
    if payload.is_empty() {
        store
            .append(
                key,
                json(&Append {
                    record: header.clone(),
                    offset: 0,
                    sha256: digest(&[]),
                })
                .unwrap()
                .as_bytes(),
                &[],
            )
            .await
            .unwrap();
    }
    for (i, chunk) in payload.chunks(FRAGMENT_BYTES).enumerate() {
        let frame = Append {
            record: header.clone(),
            offset: (i * FRAGMENT_BYTES) as u64,
            sha256: digest(chunk),
        };
        store
            .append(key, json(&frame).unwrap().as_bytes(), chunk)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn normal_composition_refuses_every_operation_before_parsing_or_database_access() {
    // No tables or connection exist. A misplaced gate would fail differently.
    let pool = SqlitePoolOptions::new()
        .connect_lazy("sqlite::memory:")
        .unwrap();
    let store = InactiveStorage::closed(pool);
    assert_eq!(
        store.begin(b"malformed").await.unwrap_err(),
        "inactive_storage_disabled"
    );
    assert_eq!(
        store
            .append("bad", b"malformed", &vec![0; FRAGMENT_BYTES + 1])
            .await
            .unwrap_err(),
        "inactive_storage_disabled"
    );
    assert_eq!(
        store.status("bad").await.unwrap_err(),
        "inactive_storage_disabled"
    );
    assert_eq!(
        store.abort_receiving("bad").await.unwrap_err(),
        "inactive_storage_disabled"
    );
    assert_eq!(
        store.seal_storage("bad").await.unwrap_err(),
        "inactive_storage_disabled"
    );
    assert_eq!(
        store.readback("bad", None, 0).await.unwrap_err(),
        "inactive_storage_disabled"
    );
}

#[tokio::test]
async fn two_database_storage_roundtrip_reopens_with_persistent_mapping_and_no_ordinary_chat() {
    let temp = TempDir::new().unwrap();
    let source = create_pool(&temp.path().join("source.db")).await.unwrap();
    let target_path = temp.path().join("target.db");
    let target = create_pool(&target_path).await.unwrap();
    sqlx::query("INSERT INTO conversations(id,title,created_at,updated_at) VALUES('source-chat','Synthetic','2026-01-01','2026-01-01')").execute(&source).await.unwrap();
    sqlx::query("INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES('source-message','source-chat','user',?,'synthetic')").bind("Un fait historique récupérable 🦀").execute(&source).await.unwrap();
    let text: String = sqlx::query_scalar("SELECT content FROM messages WHERE id='source-message'")
        .fetch_one(&source)
        .await
        .unwrap();
    let records = vec![
        (RecordKind::Message { role: Role::User }, text.into_bytes()),
        (
            RecordKind::Asset {
                mime: Mime::TextPlain,
            },
            b"required synthetic asset".to_vec(),
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
    ];
    let (begin, headers) = intent(&records);
    let clock = Arc::new(AtomicI64::new(100));
    let store = active(target.clone(), clock.clone());
    let receipt = store.begin(json(&begin).unwrap().as_bytes()).await.unwrap();
    assert_eq!(
        store.begin(json(&begin).unwrap().as_bytes()).await.unwrap(),
        receipt
    );
    for (header, (_, payload)) in headers.iter().zip(&records) {
        append_record(&store, &receipt.key, header, payload).await;
    }
    let sealed = store.seal_storage(&receipt.key).await.unwrap();
    assert_eq!(sealed.receipt.phase, Phase::SealedStorage);
    assert_eq!(store.seal_storage(&receipt.key).await.unwrap(), sealed);
    let page = store.readback(&receipt.key, None, 32).await.unwrap();
    assert_eq!(page.fragments.len(), 3);
    assert_eq!(page.fragments[0].bytes, records[0].1);
    assert_eq!(page.fragments[1].bytes, records[1].1);
    assert!(page.fragments[2].target_uuid.is_none());
    let mapping = page.fragments[0].target_uuid.clone();
    assert_ne!(mapping.as_deref(), Some("source-message"));
    assert_eq!(
        store.abort_receiving(&receipt.key).await.unwrap_err(),
        "storage_pinned"
    );
    let content_versions: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM conversation_content_versions")
            .fetch_one(&target)
            .await
            .unwrap();
    assert_eq!(content_versions, 0);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM conversations")
            .fetch_one(&target)
            .await
            .unwrap(),
        0
    );
    drop(store);
    target.close().await;
    let reopened = create_pool(&target_path).await.unwrap();
    let closed = InactiveStorage::closed(reopened.clone());
    assert_eq!(
        closed.status(&receipt.key).await.unwrap_err(),
        "inactive_storage_disabled"
    );
    let resumed = active(reopened, clock);
    assert_eq!(resumed.status(&receipt.key).await.unwrap(), sealed.receipt);
    assert_eq!(
        resumed
            .readback(&receipt.key, None, 1)
            .await
            .unwrap()
            .fragments[0]
            .target_uuid,
        mapping
    );
    assert!(sqlx::query("PRAGMA foreign_key_check")
        .fetch_optional(&resumed.pool)
        .await
        .unwrap()
        .is_none());
}

// Downgrade helpers are restricted to synthetic test databases, never recovery.
pub(crate) async fn remove_reference_schema_in(db: &mut sqlx::SqliteConnection) {
    sqlx::raw_sql("DROP TABLE e_inactive_mapping; DROP TABLE e_inactive_fragments; DROP TABLE e_inactive_records; DROP TABLE e_inactive_imports; DROP TABLE e_inactive_domain; DELETE FROM schema_migrations WHERE version=15;").execute(db).await.unwrap();
}
