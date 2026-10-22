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

async fn fixture() -> (TempDir, InactiveStorage, Arc<AtomicI64>) {
    let dir = TempDir::new().unwrap();
    let pool = create_pool(&dir.path().join("target.db")).await.unwrap();
    let clock = Arc::new(AtomicI64::new(100));
    let store = active(pool, clock.clone());
    (dir, store, clock)
}
async fn assert_charge(store: &InactiveStorage, key: &str) {
    let mut tx = store.tx().await.unwrap();
    let authority = store.authorize().await.unwrap();
    let journal = store.load(&mut tx, key, &authority).await.unwrap();
    assert_eq!(journal.charge, charge(&mut tx, journal.id).await.unwrap());
}

#[tokio::test]
async fn closed_framing_rejects_duplicate_unknown_and_large_headers_without_publication() {
    let (_dir, store, _clock) = fixture().await;
    let (begin, headers) = intent(&[(RecordKind::Message { role: Role::User }, b"a".to_vec())]);
    let valid = json(&begin).unwrap();
    let frames = vec![
        valid.replacen("\"version\":1", "\"version\":1,\"version\":1", 1),
        valid.replacen("\"origin\":", "\"extra\":1,\"origin\":", 1),
        valid.replacen(
            "\"target_instance\":",
            "\"actor\":\"duplicate\",\"target_instance\":",
            1,
        ),
        valid.replacen("\"records\":1", "\"records\":1.0", 1),
        valid.replacen("synthetic_history_v1", "unknown_profile", 1),
        valid.replacen("\"version\":1", "\"version\":2", 1),
        valid.replacen("\"bytes\":1", "\"bytes\":9223372036854775808", 1),
        " ".repeat(CONTROL_BYTES + 1),
    ];
    for frame in frames {
        assert!(
            store.begin(frame.as_bytes()).await.is_err(),
            "accepted {frame}"
        );
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM e_inactive_imports")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM e_inactive_domain")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        0
    );
    let receipt = store.begin(valid.as_bytes()).await.unwrap();
    let append = json(&Append {
        record: headers[0].clone(),
        offset: 0,
        sha256: digest(b"a"),
    })
    .unwrap();
    for frame in [
        append.replacen("\"offset\":0", "\"offset\":0,\"offset\":0", 1),
        append.replacen(
            "\"kind\":\"message\"",
            "\"kind\":\"message\",\"kind\":\"message\"",
            1,
        ),
        append.replacen(
            "\"role\":\"user\"",
            "\"role\":\"user\",\"role\":\"user\"",
            1,
        ),
        append.replacen("\"role\":\"user\"", "\"role\":\"system\"", 1),
        append.replacen("\"role\":\"user\"", "\"role\":\"user\",\"unknown\":0", 1),
    ] {
        assert_eq!(
            store
                .append(&receipt.key, frame.as_bytes(), b"a")
                .await
                .unwrap_err(),
            "invalid_frame"
        );
    }
    assert_eq!(store.status(&receipt.key).await.unwrap(), receipt);
}

#[tokio::test]
async fn utf8_replay_ack_and_generation_binding_survive_restart() {
    let (dir, store, clock) = fixture().await;
    let payload = format!("{}🙂 suite", "x".repeat(FRAGMENT_BYTES - 1)).into_bytes();
    let records = vec![(
        RecordKind::Message {
            role: Role::Assistant,
        },
        payload.clone(),
    )];
    let (begin, headers) = intent(&records);
    let receipt = store.begin(json(&begin).unwrap().as_bytes()).await.unwrap();
    let first = &payload[..FRAGMENT_BYTES];
    let frame = Append {
        record: headers[0].clone(),
        offset: 0,
        sha256: digest(first),
    };
    let control = json(&frame).unwrap();
    let ack = store
        .append(&receipt.key, control.as_bytes(), first)
        .await
        .unwrap();
    let tail: Vec<u8> = sqlx::query_scalar("SELECT utf8_tail FROM e_inactive_records")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(tail.len(), 1);
    drop(store);
    let pool = create_pool(&dir.path().join("target.db")).await.unwrap();
    let store = active(pool, clock);
    let rest = &payload[FRAGMENT_BYTES..];
    store
        .append(
            &receipt.key,
            json(&Append {
                record: headers[0].clone(),
                offset: FRAGMENT_BYTES as u64,
                sha256: digest(rest),
            })
            .unwrap()
            .as_bytes(),
            rest,
        )
        .await
        .unwrap();
    let before = store.status(&receipt.key).await.unwrap();
    assert_eq!(
        store
            .append(&receipt.key, control.as_bytes(), first)
            .await
            .unwrap(),
        ack
    );
    assert_eq!(store.status(&receipt.key).await.unwrap(), before);
    let sealed = store.seal_storage(&receipt.key).await.unwrap();
    assert_eq!(
        store
            .append(&receipt.key, control.as_bytes(), first)
            .await
            .unwrap(),
        ack
    );
    assert_eq!(store.status(&receipt.key).await.unwrap(), sealed.receipt);
    assert_charge(&store, &receipt.key).await;
    let mut authority = store.authority.as_ref().unwrap().write().await;
    authority.bindings.target_generation = "new-target-generation".into();
    drop(authority);
    assert_eq!(
        store.readback(&receipt.key, None, 1).await.unwrap_err(),
        "binding_conflict"
    );
    let mut changed = begin.clone();
    changed.bindings.target_generation = "new-target-generation".into();
    assert_eq!(
        store
            .begin(json(&changed).unwrap().as_bytes())
            .await
            .unwrap_err(),
        "intent_conflict"
    );
    assert_eq!(identity_key(&changed.identity).unwrap(), receipt.key);
}

#[tokio::test]
async fn append_failure_is_atomic_and_abort_keeps_a_non_reusable_charged_tombstone() {
    let (_dir, store, clock) = fixture().await;
    let payload = b"safe history";
    let (begin, headers) = intent(&[(RecordKind::Message { role: Role::User }, payload.to_vec())]);
    let original = store.begin(json(&begin).unwrap().as_bytes()).await.unwrap();
    let control = json(&Append {
        record: headers[0].clone(),
        offset: 0,
        sha256: digest(payload),
    })
    .unwrap();
    sqlx::raw_sql("CREATE TRIGGER synthetic_append_crash BEFORE UPDATE ON e_inactive_imports BEGIN SELECT RAISE(ABORT,'synthetic crash before ACK commit'); END").execute(&store.pool).await.unwrap();
    assert_eq!(
        store
            .append(&original.key, control.as_bytes(), payload)
            .await
            .unwrap_err(),
        "database_unavailable"
    );
    sqlx::query("DROP TRIGGER synthetic_append_crash")
        .execute(&store.pool)
        .await
        .unwrap();
    assert_eq!(store.status(&original.key).await.unwrap(), original);
    for table in [
        "e_inactive_records",
        "e_inactive_fragments",
        "e_inactive_mapping",
    ] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(format!(
                "SELECT COUNT(*) FROM {table}"
            )))
            .fetch_one(&store.pool)
            .await
            .unwrap(),
            0
        );
    }
    store
        .append(&original.key, control.as_bytes(), payload)
        .await
        .unwrap();
    assert_charge(&store, &original.key).await;
    clock.store(600_100, Ordering::SeqCst); // Idle deadline, before absolute deadline.
    let tombstone = store.abort_receiving(&original.key).await.unwrap();
    assert_eq!(tombstone.phase, Phase::Expired);
    assert_eq!(tombstone.charge_bytes, original.charge_bytes);
    assert_eq!(tombstone.received_bytes, 0);
    assert_eq!(
        store.abort_receiving(&original.key).await.unwrap(),
        tombstone
    );
    assert_eq!(
        store.begin(json(&begin).unwrap().as_bytes()).await.unwrap(),
        tombstone
    );
    assert_eq!(
        store
            .append(&original.key, control.as_bytes(), payload)
            .await
            .unwrap_err(),
        "not_receiving"
    );
    assert_charge(&store, &original.key).await;
    for table in [
        "e_inactive_records",
        "e_inactive_fragments",
        "e_inactive_mapping",
    ] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(format!(
                "SELECT COUNT(*) FROM {table}"
            )))
            .fetch_one(&store.pool)
            .await
            .unwrap(),
            0
        );
    }
}

#[tokio::test]
async fn privacy_across_blocks_bad_utf8_offsets_and_hashes_refuse_without_residue() {
    let (_dir, store, clock) = fixture().await;
    let bytes = b"prefix synthetic-private-token suffix";
    let (begin, headers) = intent(&[(RecordKind::Message { role: Role::User }, bytes.to_vec())]);
    let receipt = store.begin(json(&begin).unwrap().as_bytes()).await.unwrap();
    let first = &bytes[..20];
    store
        .append(
            &receipt.key,
            json(&Append {
                record: headers[0].clone(),
                offset: 0,
                sha256: digest(first),
            })
            .unwrap()
            .as_bytes(),
            first,
        )
        .await
        .unwrap();
    let before = store.status(&receipt.key).await.unwrap();
    let rest = &bytes[20..];
    let mut frame = Append {
        record: headers[0].clone(),
        offset: 20,
        sha256: digest(rest),
    };
    assert_eq!(
        store
            .append(&receipt.key, json(&frame).unwrap().as_bytes(), rest)
            .await
            .unwrap_err(),
        "private_context"
    );
    frame.offset = 21;
    assert_eq!(
        store
            .append(&receipt.key, json(&frame).unwrap().as_bytes(), rest)
            .await
            .unwrap_err(),
        "invalid_offset"
    );
    frame.offset = 20;
    frame.sha256 = digest(b"wrong");
    assert_eq!(
        store
            .append(&receipt.key, json(&frame).unwrap().as_bytes(), rest)
            .await
            .unwrap_err(),
        "integrity_failed"
    );
    frame.sha256 = digest(&[255]);
    assert_eq!(
        store
            .append(&receipt.key, json(&frame).unwrap().as_bytes(), &[255])
            .await
            .unwrap_err(),
        "invalid_utf8"
    );
    clock.store(99, Ordering::SeqCst);
    assert_eq!(
        store
            .append(&receipt.key, json(&frame).unwrap().as_bytes(), &[255])
            .await
            .unwrap_err(),
        "clock_rollback"
    );
    assert_eq!(store.status(&receipt.key).await.unwrap(), before);
    assert_charge(&store, &receipt.key).await;
}

#[tokio::test]
async fn seal_rejects_missing_dependencies_and_corruption_and_preserves_c1_c2_tokens() {
    let (_dir, store, _clock) = fixture().await;
    let before: (String, i64) =
        sqlx::query_as("SELECT incarnation,revision FROM conversation_catalog_version")
            .fetch_one(&store.pool)
            .await
            .unwrap();
    let records = vec![
        (RecordKind::Message { role: Role::User }, b"a".to_vec()),
        (
            RecordKind::Association {
                from: 0,
                to: 99,
                position: 0,
                relation: Relation::AssetForMessage,
            },
            vec![],
        ),
    ];
    let (begin, headers) = intent(&records);
    let receipt = store.begin(json(&begin).unwrap().as_bytes()).await.unwrap();
    assert_eq!(
        store.seal_storage(&receipt.key).await.unwrap_err(),
        "incomplete_storage"
    );
    for (h, (_, b)) in headers.iter().zip(&records) {
        append_record(&store, &receipt.key, h, b).await;
    }
    assert_eq!(
        store.seal_storage(&receipt.key).await.unwrap_err(),
        "invalid_association"
    );
    assert_eq!(
        store.status(&receipt.key).await.unwrap().phase,
        Phase::Verifying
    );
    assert_eq!(
        store.readback(&receipt.key, None, 1).await.unwrap_err(),
        "not_sealed"
    );
    sqlx::query("UPDATE e_inactive_fragments SET data=X'62' WHERE ordinal=0")
        .execute(&store.pool)
        .await
        .unwrap();
    assert_eq!(
        store.seal_storage(&receipt.key).await.unwrap_err(),
        "integrity_failed"
    );
    assert_eq!(
        store.abort_receiving(&receipt.key).await.unwrap().phase,
        Phase::Aborted
    );
    let after: (String, i64) =
        sqlx::query_as("SELECT incarnation,revision FROM conversation_catalog_version")
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert_eq!(before, after);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM conversation_content_versions")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        0
    );
}
