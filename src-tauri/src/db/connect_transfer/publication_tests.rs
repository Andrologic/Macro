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
async fn staged() -> (
    tempfile::TempDir,
    SqlitePool,
    Spec,
    Allocation,
    inactive_storage::InactiveStorage,
    String,
) {
    let (dir, pool) = journal::fixture().await;
    let (transfer, begin_input) = journal::target_for_publication(&pool).await;
    let (store, key, sealed) = inactive_storage::tests::seal_transfer_fixture(
        pool.clone(),
        begin_input,
        vec![
            (
                RecordKind::Message { role: Role::User },
                b"History remains recoverable".to_vec(),
            ),
            (
                RecordKind::Asset {
                    mime: Mime::ImagePng,
                },
                b"synthetic image bytes".to_vec(),
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
    put(
        pool,
        &spec.transfer_id,
        0,
        Some(0),
        Header::Message {
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
        &[("data", b"synthetic image bytes")],
    )
    .await;
    finish(pool, &spec.transfer_id, &allocation.fingerprint, &[9; 32])
        .await
        .unwrap();
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
    db::repository::delete_conversation(&pool, &allocation.conversation_id)
        .await
        .unwrap();
    assert_eq!(publish(&pool, &input).await.unwrap(), receipt);
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
    assert_eq!(
        store
            .readback(&key, None, 32)
            .await
            .unwrap()
            .fragments
            .len(),
        3
    );
}
