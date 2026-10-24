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
        lease_cleanup_started: None,
    }
}
fn intent(records: &[(RecordKind, Vec<u8>)]) -> (Begin, Vec<RecordHeader>) {
    let headers: Vec<_> = records
        .iter()
        .enumerate()
        .map(|(ordinal, (entry, bytes))| RecordHeader {
            origin: None,
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
    crate::db::source_capture::tests::remove_reference_schema_in(db).await;
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
    let authority = store.authorize().await.unwrap();
    let mut lease = store.lease().await.unwrap();
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await.unwrap();
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

use crate::db::pilot_files as files;
const FILE_TIME: i64 = 1_800_000_000_000;
fn date(time: i64) -> String {
    chrono::DateTime::from_timestamp_millis(time)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
async fn file_scope(pool: &SqlitePool, instance: &str, session: &str) -> files::PilotFileScope {
    sqlx::query("INSERT OR IGNORE INTO conversations(id,title,scope_mode,created_at,updated_at) VALUES('file-chat','Synthetic','Chat','now','now')").execute(pool).await.unwrap();
    let scope = files::PilotFileScope {
        account_id: "synthetic-account".into(),
        session_id: session.into(),
        instance_id: instance.into(),
        authority_binding: "synthetic-generation".into(),
        r#ref: files::PilotFileRef {
            conversation_id: "file-chat".into(),
            conversation_kind: files::PilotConversationKind::Chat,
            workspace_id: Some("workspace:configuration".into()),
            project_id: None,
            task_id: None,
        },
    };
    files::authorize(
        pool,
        files::PilotFileAuthorizeInput {
            scope: scope.clone(),
            execute_before: date(FILE_TIME + 3_600_000),
            active: true,
        },
        &|| FILE_TIME,
    )
    .await
    .unwrap();
    scope
}
fn file_begin(
    scope: &files::PilotFileScope,
    intent: &str,
    bytes: i64,
) -> files::PilotFileBeginInput {
    files::PilotFileBeginInput {
        scope: scope.clone(),
        execute_before: date(FILE_TIME + 3_600_000),
        intent_id: intent.into(),
        batch_id: intent.into(),
        file_name: "synthetic.txt".into(),
        mime_type: "text/plain".into(),
        total_bytes: bytes,
        sha256: digest(b"synthetic"),
        intent_expires_at: date(FILE_TIME + 900_000),
    }
}
async fn retained(store: &InactiveStorage) -> i64 {
    let mut lease = store.lease().await.unwrap();
    let mut tx = lease.begin_with("BEGIN IMMEDIATE").await.unwrap();
    inactive_budget::retained(&mut tx).await.unwrap()
}

#[tokio::test]
async fn missing_persisted_domain_refuses_new_e_and_attachment_admission_without_repair() {
    let (_dir, store, clock) = fixture().await;
    clock.store(FILE_TIME, Ordering::SeqCst);
    let (mut begin, _) = intent(&[(RecordKind::Message { role: Role::User }, b"x".to_vec())]);
    let original = store.begin(json(&begin).unwrap().as_bytes()).await.unwrap();
    let scope = file_scope(&store.pool, "instance", "session").await;
    sqlx::query("DELETE FROM e_inactive_domain")
        .execute(&store.pool)
        .await
        .unwrap();
    {
        let mut authority = store.authority.as_ref().unwrap().write().await;
        authority.identity.transfer = "different-transfer".into();
        authority.policy.budget *= 2;
        begin.identity = authority.identity.clone();
    }
    for _ in 0..2 {
        assert_eq!(
            store
                .begin(json(&begin).unwrap().as_bytes())
                .await
                .unwrap_err(),
            "database_unavailable"
        );
        assert_eq!(
            files::begin(&store.pool, file_begin(&scope, "no-repair", 1), &|| {
                FILE_TIME
            })
            .await
            .unwrap_err(),
            "database_unavailable"
        );
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM e_inactive_domain")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM e_inactive_imports")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT charge_bytes FROM e_inactive_imports")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        original.charge_bytes
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM pilot_file_transfers")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn first_e_admission_counts_all_staging_but_never_retroactively_caps_ordinary_assets() {
    let (_dir, store, clock) = fixture().await;
    clock.store(FILE_TIME, Ordering::SeqCst);
    store
        .authority
        .as_ref()
        .unwrap()
        .write()
        .await
        .policy
        .budget = 4096;
    for instance in ["first", "second"] {
        let scope = file_scope(&store.pool, instance, "old-session").await;
        files::begin(&store.pool, file_begin(&scope, instance, 2500), &|| {
            FILE_TIME
        })
        .await
        .unwrap();
    }
    // An ordinary pre-existing asset is deliberately larger than the E test
    // budget. Ordinary assets are outside this preparation-owned domain.
    sqlx::query("INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES('old-message','file-chat','user','old','now')").execute(&store.pool).await.unwrap();
    sqlx::query("INSERT INTO pilot_message_attachments(id,owner_key,instance_id,ref_key,message_id,file_name,mime_type,total_bytes,sha256,data) VALUES('ordinary','old','old','old','old-message','old.txt','text/plain',65536,?,zeroblob(65536))").bind(digest(&[])).execute(&store.pool).await.unwrap();
    let (begin, _) = intent(&[(RecordKind::Message { role: Role::User }, b"x".to_vec())]);
    assert_eq!(
        store
            .begin(json(&begin).unwrap().as_bytes())
            .await
            .unwrap_err(),
        "resource_limit"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM e_inactive_domain")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM e_inactive_imports")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        0
    );
    let third = file_scope(&store.pool, "third", "new-session").await;
    files::begin(
        &store.pool,
        file_begin(&third, "legacy-still-works", 1),
        &|| FILE_TIME,
    )
    .await
    .unwrap();
    sqlx::query("UPDATE pilot_file_transfers SET state='aborted',data=X''")
        .execute(&store.pool)
        .await
        .unwrap();
    let receipt = store.begin(json(&begin).unwrap().as_bytes()).await.unwrap();
    assert!(receipt.charge_bytes < 4096);
    assert_eq!(
        retained(&store).await,
        receipt.charge_bytes + inactive_budget::DOMAIN_BYTES
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT length(data) FROM pilot_message_attachments WHERE id='ordinary'"
        )
        .fetch_one(&store.pool)
        .await
        .unwrap(),
        65536
    );
}

#[tokio::test]
async fn common_reservation_race_is_atomic_and_budget_survives_normal_reopen_session_and_restart() {
    let (dir, store, clock) = fixture().await;
    clock.store(FILE_TIME, Ordering::SeqCst);
    let scope = file_scope(&store.pool, "file-instance", "first-session").await;
    let payload = b"bounded payload";
    let (begin, headers) = intent(&[(RecordKind::Message { role: Role::User }, payload.to_vec())]);
    let base = JOURNAL_BYTES + json(&begin).unwrap().len() as i64 + inactive_budget::DOMAIN_BYTES;
    let extra = RECORD_BYTES
        + json(&headers[0]).unwrap().len() as i64
        + MAPPING_BYTES
        + FRAGMENT_META_BYTES
        + payload.len() as i64
        + payload.len().min(22) as i64;
    // The literal scanner retains at most secret.len()-1 = 22 bytes.
    let cap = base + extra;
    store
        .authority
        .as_ref()
        .unwrap()
        .write()
        .await
        .policy
        .budget = cap;
    let receipt = store.begin(json(&begin).unwrap().as_bytes()).await.unwrap();
    let frame = json(&Append {
        record: headers[0].clone(),
        offset: 0,
        sha256: digest(payload),
    })
    .unwrap();
    let (e, file) = tokio::join!(
        store.append(&receipt.key, frame.as_bytes(), payload),
        files::begin(&store.pool, file_begin(&scope, "racing", extra), &|| {
            FILE_TIME
        })
    );
    assert_eq!(usize::from(e.is_ok()) + usize::from(file.is_ok()), 1);
    assert_eq!(
        if let Err(error) = &e {
            error
        } else {
            file.as_ref().unwrap_err()
        },
        "resource_limit"
    );
    assert_eq!(retained(&store).await, cap);
    assert_charge(&store, &receipt.key).await;
    if e.is_err() {
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM e_inactive_records")
                .fetch_one(&store.pool)
                .await
                .unwrap(),
            0
        );
    }
    let pool = store.pool.clone();
    drop(store);
    pool.close().await;
    let pool = create_pool(&dir.path().join("target.db")).await.unwrap();
    let closed = InactiveStorage::closed(pool.clone());
    assert_eq!(
        closed.begin(b"invalid").await.unwrap_err(),
        "inactive_storage_disabled"
    );
    let new_scope = file_scope(&pool, "other-instance", "new-session").await;
    assert_eq!(
        files::begin(&pool, file_begin(&new_scope, "after-restart", 1), &|| {
            FILE_TIME
        })
        .await
        .unwrap_err(),
        "resource_limit"
    );
    let resumed = active(pool, clock);
    assert_eq!(retained(&resumed).await, cap);
    let tombstone = resumed.abort_receiving(&receipt.key).await.unwrap();
    assert_eq!(tombstone.charge_bytes, receipt.charge_bytes);
    let after = retained(&resumed).await;
    assert_eq!(
        resumed.abort_receiving(&receipt.key).await.unwrap(),
        tombstone
    );
    assert_eq!(retained(&resumed).await, after);
    assert_eq!(after, base + if e.is_err() { extra } else { 0 });
}

#[tokio::test]
async fn finalized_attachment_promotion_releases_one_owned_reservation_and_keeps_ordinary_copy() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let (_dir, store, clock) = fixture().await;
    clock.store(FILE_TIME, Ordering::SeqCst);
    let scope = file_scope(&store.pool, "instance", "session").await;
    let (begin, _) = intent(&[(
        RecordKind::Message { role: Role::User },
        b"history".to_vec(),
    )]);
    store.begin(json(&begin).unwrap().as_bytes()).await.unwrap();
    let baseline = retained(&store).await;
    let bytes = b"ordinary text asset";
    let mut input = file_begin(&scope, "asset", bytes.len() as i64);
    input.sha256 = digest(bytes);
    let received = files::begin(&store.pool, input.clone(), &|| FILE_TIME)
        .await
        .unwrap();
    assert_eq!(retained(&store).await, baseline + bytes.len() as i64);
    files::chunk(
        &store.pool,
        files::PilotFileChunkInput {
            scope: scope.clone(),
            execute_before: input.execute_before.clone(),
            transfer_id: received.transfer_id.clone(),
            offset_bytes: 0,
            data_base64: STANDARD.encode(bytes),
            sha256: digest(bytes),
        },
        &|| FILE_TIME,
    )
    .await
    .unwrap();
    let transfer = files::PilotFileTransferInput {
        scope: scope.clone(),
        execute_before: input.execute_before.clone(),
        transfer_id: received.transfer_id.clone(),
    };
    let finalized = files::finalize(&store.pool, transfer.clone(), &|| FILE_TIME)
        .await
        .unwrap();
    assert_eq!(retained(&store).await, baseline + bytes.len() as i64);
    let prep = files::PilotPrepareSendInput {
        scope: scope.clone(),
        execute_before: input.execute_before.clone(),
        intent_expires_at: input.intent_expires_at,
        send_intent_id: "send".into(),
        content: "Synthetic".into(),
        attachment_ids: vec![finalized.attachment_id.unwrap()],
        expected_revision: 1,
    };
    let sent = files::prepare_send(&store.pool, prep.clone(), &|| FILE_TIME)
        .await
        .unwrap();
    assert_eq!(retained(&store).await, baseline);
    files::prepare_send(&store.pool, prep, &|| FILE_TIME)
        .await
        .unwrap();
    assert_eq!(retained(&store).await, baseline);
    assert_eq!(
        files::abort(&store.pool, transfer, &|| FILE_TIME)
            .await
            .unwrap_err(),
        "intent_conflict"
    );
    assert_eq!(
        sqlx::query_scalar::<_, Vec<u8>>(
            "SELECT data FROM pilot_message_attachments WHERE message_id=?"
        )
        .bind(sent.message.id)
        .fetch_one(&store.pool)
        .await
        .unwrap(),
        bytes
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn seal_revalidates_revision_after_abort_and_holds_authority_through_final_write() {
    for abort in [true, false] {
        let (_dir, mut store, _clock) = fixture().await;
        let (begin, headers) = intent(&[(
            RecordKind::Message { role: Role::User },
            b"history".to_vec(),
        )]);
        let receipt = store.begin(json(&begin).unwrap().as_bytes()).await.unwrap();
        append_record(&store, &receipt.key, &headers[0], b"history").await;
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let rendezvous = barrier.clone();
        let calls = AtomicI64::new(0);
        store.clock = Arc::new(move || {
            let call = calls.fetch_add(1, Ordering::SeqCst) + 1;
            if call == if abort { 2 } else { 3 } {
                rendezvous.wait();
                rendezvous.wait();
            }
            100
        });
        let store = Arc::new(store);
        let worker = store.clone();
        let key = receipt.key.clone();
        let sealing = tokio::spawn(async move { worker.seal_storage(&key).await });
        barrier.wait();
        assert!(
            store.authority.as_ref().unwrap().try_write().is_err(),
            "authority must remain locked during paged verification and final write"
        );
        if abort {
            store.abort_receiving(&receipt.key).await.unwrap();
        }
        barrier.wait();
        let result = sealing.await.unwrap();
        if abort {
            assert_eq!(result.unwrap_err(), "stale_revision");
            assert_eq!(
                store.status(&receipt.key).await.unwrap().phase,
                Phase::Aborted
            );
        } else {
            assert_eq!(result.unwrap().receipt.phase, Phase::SealedStorage);
        }
        store.authority.as_ref().unwrap().write().await.enabled = false;
        assert_eq!(
            store.readback(&receipt.key, None, 1).await.unwrap_err(),
            "inactive_storage_disabled"
        );
    }
}

#[tokio::test]
async fn migration15_failure_rolls_back_and_does_not_change_existing_content_tokens() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("upgrade.db");
    let pool = create_pool(&path).await.unwrap();
    let before: (String, i64) =
        sqlx::query_as("SELECT incarnation,revision FROM conversation_catalog_version")
            .fetch_one(&pool)
            .await
            .unwrap();
    remove_reference_schema_in(&mut *pool.acquire().await.unwrap()).await;
    sqlx::raw_sql("CREATE TRIGGER synthetic_reject_15 BEFORE INSERT ON schema_migrations WHEN NEW.version=15 BEGIN SELECT RAISE(ABORT,'synthetic'); END").execute(&pool).await.unwrap();
    assert!(crate::db::run_migrations(&pool).await.is_err());
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'e_inactive_%'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT MAX(version) FROM schema_migrations")
            .fetch_one(&pool)
            .await
            .unwrap(),
        14
    );
    sqlx::query("DROP TRIGGER synthetic_reject_15")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let pool = create_pool(&path).await.unwrap();
    let after: (String, i64) =
        sqlx::query_as("SELECT incarnation,revision FROM conversation_catalog_version")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(before, after);
}

#[path = "lifetime_tests.rs"]
mod lifetime;
#[path = "proof.rs"]
mod proof;
#[path = "portable_profile_tests.rs"]
mod portable_profile_tests;

#[tokio::test]
async fn sqlite_full_rolls_back_payload_mapping_and_charge_before_ack() {
    let (dir, original, clock) = fixture().await;
    original.pool.close().await;
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(dir.path().join("target.db"))
                .foreign_keys(true),
        )
        .await
        .unwrap();
    let store = active(pool, clock);
    let payload = vec![b'x'; FRAGMENT_BYTES];
    let (begin, headers) = intent(&[(RecordKind::Message { role: Role::User }, payload.clone())]);
    let receipt = store.begin(json(&begin).unwrap().as_bytes()).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA freelist_count")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        0
    );
    let pages: i64 = sqlx::query_scalar("PRAGMA page_count")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "PRAGMA max_page_count={pages}"
    )))
    .execute(&store.pool)
    .await
    .unwrap();
    let control = json(&Append {
        record: headers[0].clone(),
        offset: 0,
        sha256: digest(&payload),
    })
    .unwrap();
    assert_eq!(
        store
            .append(&receipt.key, control.as_bytes(), &payload)
            .await
            .unwrap_err(),
        "database_unavailable"
    );
    assert_eq!(store.status(&receipt.key).await.unwrap(), receipt);
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
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "PRAGMA max_page_count={}",
        pages + 100
    )))
    .execute(&store.pool)
    .await
    .unwrap();
    sqlx::raw_sql("CREATE TEMP TABLE successful_connection_marker(value INTEGER); INSERT INTO successful_connection_marker VALUES(123)").execute(&store.pool).await.unwrap();
    let ack = store
        .append(&receipt.key, control.as_bytes(), &payload)
        .await
        .unwrap();
    assert_eq!(
        ack.revision, 1,
        "failed append must not publish a revision or ACK"
    );
    store.seal_storage(&receipt.key).await.unwrap();
    store.status(&receipt.key).await.unwrap();
    store.readback(&receipt.key, None, 1).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT value FROM successful_connection_marker")
            .fetch_one(&store.pool)
            .await
            .unwrap(),
        123,
        "successful owner operations must reuse the same pooled connection"
    );
}

#[tokio::test]
async fn cancelled_lease_rolls_back_and_discards_unfinished_connection_without_replaying_work() {
    let (_dir, store, _clock) = fixture().await;
    let (begin, _) = intent(&[(
        RecordKind::Message { role: Role::User },
        b"history".to_vec(),
    )]);
    let receipt = store.begin(json(&begin).unwrap().as_bytes()).await.unwrap();
    let store = Arc::new(store);
    let worker = store.clone();
    let key = receipt.key.clone();
    let (entered, waiting) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let authority = worker.authorize().await.unwrap();
        let mut lease = worker.lease().await.unwrap();
        let mut tx = lease.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let journal = worker.load(&mut tx, &key, &authority).await.unwrap();
        sqlx::query("UPDATE e_inactive_imports SET revision=revision+1,received_bytes=1,charge_bytes=charge_bytes+1 WHERE id=?").bind(journal.id).execute(&mut *tx).await.unwrap();
        entered.send(()).unwrap();
        std::future::pending::<()>().await;
        tx.commit().await.unwrap();
    });
    waiting.await.unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert_eq!(store.status(&receipt.key).await.unwrap(), receipt);
    assert_charge(&store, &receipt.key).await;
    assert_eq!(
        store.begin(json(&begin).unwrap().as_bytes()).await.unwrap(),
        receipt
    );
}

#[tokio::test]
async fn e_and_attachment_reservations_enforce_the_same_boundary_in_both_orders() {
    for file_first in [true, false] {
        let (_dir, store, clock) = fixture().await;
        clock.store(FILE_TIME, Ordering::SeqCst);
        let scope = file_scope(&store.pool, "instance", "session").await;
        let payload = b"payload";
        let (begin, headers) =
            intent(&[(RecordKind::Message { role: Role::User }, payload.to_vec())]);
        let base =
            JOURNAL_BYTES + json(&begin).unwrap().len() as i64 + inactive_budget::DOMAIN_BYTES;
        let extra = RECORD_BYTES
            + json(&headers[0]).unwrap().len() as i64
            + MAPPING_BYTES
            + FRAGMENT_META_BYTES
            + 2 * payload.len() as i64;
        store
            .authority
            .as_ref()
            .unwrap()
            .write()
            .await
            .policy
            .budget = base + extra;
        let receipt = store.begin(json(&begin).unwrap().as_bytes()).await.unwrap();
        let control = json(&Append {
            record: headers[0].clone(),
            offset: 0,
            sha256: digest(payload),
        })
        .unwrap();
        if file_first {
            files::begin(&store.pool, file_begin(&scope, "first", extra), &|| {
                FILE_TIME
            })
            .await
            .unwrap();
            assert_eq!(
                store
                    .append(&receipt.key, control.as_bytes(), payload)
                    .await
                    .unwrap_err(),
                "resource_limit"
            );
            assert_eq!(store.status(&receipt.key).await.unwrap(), receipt);
        } else {
            store
                .append(&receipt.key, control.as_bytes(), payload)
                .await
                .unwrap();
            assert_eq!(
                files::begin(&store.pool, file_begin(&scope, "second", extra), &|| {
                    FILE_TIME
                })
                .await
                .unwrap_err(),
                "resource_limit"
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM pilot_file_transfers")
                    .fetch_one(&store.pool)
                    .await
                    .unwrap(),
                0
            );
        }
        assert_eq!(retained(&store).await, base + extra);
        assert_charge(&store, &receipt.key).await;
    }
}

pub(crate) async fn shared_preparation_owner(
    pool: SqlitePool,
    clock: Arc<AtomicI64>,
    budget: i64,
    maximum: i64,
    transfer: &str,
) -> (InactiveStorage, Begin) {
    let store = active(pool, clock);
    let (mut begin, headers) = intent(&[(
        RecordKind::Message { role: Role::User },
        b"shared synthetic context".to_vec(),
    )]);
    begin.identity.transfer = transfer.into();
    let mut manifest = Manifest::new(&begin).unwrap();
    for h in &headers {
        manifest.record(h).unwrap();
    }
    begin.manifest_sha256 = manifest.finish();
    {
        let mut authority = store.authority.as_ref().unwrap().write().await;
        authority.identity = begin.identity.clone();
        authority.policy.budget = budget;
        authority.policy.max_receipts = maximum;
    }
    (store, begin)
}
pub(crate) async fn shared_attachment_reservation(
    pool: &SqlitePool,
    intent: &str,
    bytes: i64,
) -> Result<files::PilotFileReceipt> {
    let scope = file_scope(pool, "shared-instance", "shared-session").await;
    files::begin(pool, file_begin(&scope, intent, bytes), &|| FILE_TIME).await
}
#[path = "portable_normalization_proof.rs"]
mod portable_normalization_proof;

#[tokio::test]
async fn connect_transfer_import_lease_survives_ttl_and_blocks_destructive_abort() {
    let directory = TempDir::new().unwrap();
    let pool = create_pool(&directory.path().join("leased.db"))
        .await
        .unwrap();
    let clock = Arc::new(AtomicI64::new(100));
    let store = active(pool.clone(), clock.clone());
    let payload = b"complete retained history".to_vec();
    let (mut begin, headers) =
        intent(&[(RecordKind::Message { role: Role::User }, payload.clone())]);
    begin.identity.origin = "https://relay.invalid".into();
    begin.identity.transfer = "00000000-0000-4000-8000-000000000001".into();
    begin.identity.source_epoch = "1".into();
    let mut manifest = Manifest::new(&begin).unwrap();
    for header in &headers {
        manifest.record(header).unwrap();
    }
    begin.manifest_sha256 = manifest.finish();
    store.authority.as_ref().unwrap().write().await.identity = begin.identity.clone();
    let receipt = store.begin(json(&begin).unwrap().as_bytes()).await.unwrap();
    // Synthetic persisted relation only. No producer/pin or network receipt is
    // manufactured, and normal InactiveStorage::closed remains unchanged.
    sqlx::query("INSERT INTO connect_transfers(transfer_id,local_role,relay_origin,account_id,source_instance_id,source_conversation_id,source_epoch,target_instance_id,source_generation,target_generation,binding_digest,binding_json,expectation_json,reserve_request,fingerprint,inactive_import_id,phase,charge_bytes) SELECT '00000000-0000-4000-8000-000000000001','target',json_extract(begin_json,'$.identity.origin'),json_extract(begin_json,'$.identity.account_incarnation'),json_extract(begin_json,'$.identity.source_instance'),json_extract(begin_json,'$.identity.source_conversation'),1,json_extract(begin_json,'$.bindings.target_instance'),json_extract(begin_json,'$.bindings.source_generation'),json_extract(begin_json,'$.bindings.target_generation'),zeroblob(32),x'7b7d',x'7b7d',x'7b7d',zeroblob(32),id,'receiving',512 FROM e_inactive_imports WHERE identity_key=?")
        .bind(&receipt.key).execute(&pool).await.unwrap();
    clock.store(10_000_000, Ordering::SeqCst);
    assert_eq!(
        store.abort_receiving(&receipt.key).await.unwrap_err(),
        "connect_transfer_leased"
    );
    append_record(&store, &receipt.key, &headers[0], &payload).await;
    let sealed = store.seal_storage(&receipt.key).await.unwrap();
    assert_eq!(sealed.receipt.phase, Phase::SealedStorage);
    assert_eq!(
        store
            .readback(&receipt.key, None, 32)
            .await
            .unwrap()
            .fragments[0]
            .bytes,
        payload
    );
    drop(store);
    pool.close().await;
    let pool = create_pool(&directory.path().join("leased.db"))
        .await
        .unwrap();
    assert!(sqlx::query("DELETE FROM e_inactive_fragments")
        .execute(&pool)
        .await
        .is_err());
    assert!(sqlx::query("DELETE FROM e_inactive_imports")
        .execute(&pool)
        .await
        .is_err());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM e_inactive_fragments")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
}
