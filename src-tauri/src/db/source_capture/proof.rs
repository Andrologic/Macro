//! Explicit native-only experiment. Seed/oracle preparation is outside the
//! measured copy; no provider, normalization, or entire-value source reader.
use super::*;
use crate::db::source_capture::types::{Readback, Stored, StoredRelation};
use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    time::Instant,
};
fn private_file(path: &Path) -> File {
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).unwrap()
}
fn disk(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}
async fn expected(db: &SqlitePool, family: i64, key: &str, tag: i64, value: &[u8]) {
    sqlx::query("INSERT INTO expected VALUES(?,?,?,?,?,0)")
        .bind(family)
        .bind(key)
        .bind(tag)
        .bind(value.len() as i64)
        .bind(Sha256::digest(value).as_slice())
        .execute(db)
        .await
        .unwrap();
}
struct Pending {
    header: crate::db::source_capture::types::FieldInfo,
    hash: Sha256,
    bytes: i64,
    id: Vec<u8>,
}
async fn finish(field: Pending, key: &mut String, oracle: &SqlitePool, manifest: &mut Sha256) {
    assert_eq!(field.bytes, field.header.bytes);
    let hash = field.hash.finalize();
    for forbidden in [
        b"excluded authority secret".as_slice(),
        b"excluded send authority secret",
    ] {
        assert_ne!(
            hash.as_slice(),
            Sha256::digest(forbidden).as_slice(),
            "authority bytes were copied"
        );
    }
    assert_eq!(Some(hash.as_slice()), field.header.sha256.as_deref());
    if field.header.tag == 0 {
        *key = String::from_utf8(field.id).unwrap();
    }
    let expected =
        sqlx::query("SELECT bytes,hash FROM expected WHERE family=? AND key=? AND tag=?")
            .bind(field.header.family)
            .bind(&*key)
            .bind(field.header.tag)
            .fetch_optional(oracle)
            .await
            .unwrap();
    if let Some(row) = expected {
        use sqlx::Row;
        assert_eq!(row.get::<i64, _>("bytes"), field.bytes);
        assert_eq!(row.get::<Vec<u8>, _>("hash"), hash.as_slice());
        sqlx::query("UPDATE expected SET seen=1 WHERE family=? AND key=? AND tag=?")
            .bind(field.header.family)
            .bind(&*key)
            .bind(field.header.tag)
            .execute(oracle)
            .await
            .unwrap();
    }
    for n in [
        field.header.ordinal,
        field.header.row,
        field.header.family,
        field.header.tag,
        field.header.sql_type,
        field.header.bytes,
    ] {
        manifest.update(n.to_le_bytes());
    }
    manifest.update(hash);
}
async fn verify(c: &SourceCapture, oracle: &SqlitePool) -> (Vec<u8>, u64, u64) {
    let mut cursor = None;
    let mut current: Option<Pending> = None;
    let mut key = String::new();
    let mut manifest = Sha256::new();
    manifest.update(b"macro.raw.native.source.v1\0");
    let mut first = true;
    let mut fragments = 0;
    let mut max_page = 0;
    loop {
        let Readback {
            binding,
            manifest: stored,
            fragments: page,
            next,
            limits,
            ..
        } = c.readback(cursor, 32).await.unwrap();
        assert!(!limits.is_empty());
        if first {
            first = false;
            for value in [
                serde_json::to_vec(&binding).unwrap(),
                serde_json::to_vec(limits).unwrap(),
            ] {
                manifest.update((value.len() as u64).to_le_bytes());
                manifest.update(value);
            }
        }
        max_page = max_page.max(page.iter().map(|r| r.data.len() as u64).sum());
        for Stored {
            field,
            offset,
            sha256,
            data,
        } in page
        {
            assert_eq!(Sha256::digest(&data).as_slice(), sha256);
            assert!(data.len() <= 4093);
            if current
                .as_ref()
                .is_none_or(|old| old.header.ordinal != field.ordinal)
            {
                if let Some(old) = current.take() {
                    finish(old, &mut key, oracle, &mut manifest).await;
                }
                current = Some(Pending {
                    header: field,
                    hash: Sha256::new(),
                    bytes: 0,
                    id: Vec::new(),
                });
            }
            let pending = current.as_mut().unwrap();
            assert_eq!(offset, pending.bytes);
            pending.hash.update(&data);
            pending.bytes += data.len() as i64;
            if pending.header.tag == 0 {
                assert!(pending.id.len() + data.len() <= 256);
                pending.id.extend_from_slice(&data);
            }
            fragments += 1;
        }
        cursor = next;
        if cursor.is_none() {
            if let Some(old) = current.take() {
                finish(old, &mut key, oracle, &mut manifest).await;
            }
            let mut after = None;
            loop {
                let page = c.readback_relations(after, 32).await.unwrap();
                if page.is_empty() {
                    break;
                }
                for StoredRelation {
                    from,
                    kind,
                    position,
                    to,
                    status,
                } in page
                {
                    for n in [from, kind, position, to.unwrap_or(-1), status] {
                        manifest.update(n.to_le_bytes());
                    }
                    after = Some((from, kind, position));
                }
            }
            let hash = manifest.finalize().to_vec();
            assert_eq!(Some(&hash), stored.as_ref());
            return (hash, fragments, max_page);
        }
    }
}
#[tokio::test]
#[ignore = "explicit native-only experiment requires private MACRO_SOURCE_CAPTURE_PROOF_DIR"]
async fn full_native_source_capture_experiment() {
    let output = PathBuf::from(
        std::env::var_os("MACRO_SOURCE_CAPTURE_PROOF_DIR")
            .expect("private proof directory required"),
    );
    assert!(output.is_dir());
    let (dir, pool, c, clock) = capture_fixture().await;
    rich(&pool).await;
    let oracle = create_pool(&dir.path().join("oracle.db")).await.unwrap();
    sqlx::query("CREATE TABLE expected(family INTEGER,key TEXT,tag INTEGER,bytes INTEGER,hash BLOB,seen INTEGER,PRIMARY KEY(family,key,tag))").execute(&oracle).await.unwrap();
    // This large seed is dropped before the measured API path. It is never
    // loaded again by the source copier or decoder.
    let large = "é🙂\n".repeat(700_000);
    let long_bytes = large.len();
    assert!(long_bytes > 4 * 1024 * 1024);
    expected(&oracle, 1, "m", 4, large.as_bytes()).await;
    sqlx::query("UPDATE messages SET content=? WHERE id='m'")
        .bind(&large)
        .execute(&pool)
        .await
        .unwrap();
    drop(large);
    let hidden = "indispensable ALPHA é🙂\n".repeat(1200);
    assert!(hidden.len() > 16 * 1024);
    expected(&oracle, 1, "m", 8, hidden.as_bytes()).await;
    sqlx::query("UPDATE messages SET hidden_context=? WHERE id='m'")
        .bind(&hidden)
        .execute(&pool)
        .await
        .unwrap();
    drop(hidden);
    let provider = serde_json::to_string(
        &serde_json::json!([{"type":"message","content":"provider raw é🙂".repeat(1800)}]),
    )
    .unwrap();
    expected(&oracle, 1, "m", 9, provider.as_bytes()).await;
    sqlx::query("UPDATE messages SET provider_input_items_json=? WHERE id='m'")
        .bind(&provider)
        .execute(&pool)
        .await
        .unwrap();
    drop(provider);
    let citation = "native citation ALPHA é🙂\n".repeat(1500);
    expected(&oracle, 6, "orphan", 8, citation.as_bytes()).await;
    sqlx::query("UPDATE conversation_citations SET content=? WHERE id='orphan'")
        .bind(&citation)
        .execute(&pool)
        .await
        .unwrap();
    drop(citation);
    expected(&oracle, 8, "asset", 6, b"required native asset\n").await;
    expected(&oracle, 5, "s", 1, b"m").await;
    expected(&oracle, 5, "s", 2, b"historical summary").await;
    expected(&oracle, 5, "s", 4, br#"["orphan"]"#).await;
    expected(&oracle, 6, "asset", 8, b"required native asset\n").await;
    expected(&oracle, 9, "m", 4, br#"["asset"]"#).await;
    expected(&oracle, 1, "assistant", 4, b"answer").await;
    expected(&oracle, 1, "unknown-role", 4, b"historical data only").await;

    sqlx::query("UPDATE pilot_message_attachments SET owner_key='excluded authority secret'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE pilot_file_sends SET scope_key='excluded send authority secret'")
        .execute(&pool)
        .await
        .unwrap();
    for i in 0..257 {
        expected(
            &oracle,
            1,
            &format!("extra-{i:04}"),
            4,
            format!("recoverable native message {i} é🙂").as_bytes(),
        )
        .await;
        sqlx::query(
            "INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,'s',?,?,?)",
        )
        .bind(format!("extra-{i:04}"))
        .bind(if i % 2 == 0 { "user" } else { "assistant" })
        .bind(format!("recoverable native message {i} é🙂"))
        .bind(format!("w{i:04}"))
        .execute(&pool)
        .await
        .unwrap();
    }
    let content = conversation_content::conversation_content_version(&pool, "s")
        .await
        .unwrap();
    let dependencies = token(&pool).await;
    let catalog = crate::commands::conversation_catalog::version(&c.owner, Default::default())
        .await
        .unwrap();
    let source_seed_db_bytes = disk(&dir.path().join("source.db"));
    let source_seed_wal_bytes = disk(&dir.path().join("source.db-wal"));
    let oracle_db_bytes = disk(&dir.path().join("oracle.db"));
    let oracle_wal_bytes = disk(&dir.path().join("oracle.db-wal"));
    let started = Instant::now();
    let mut receipt = begin(&c).await;
    let mut steps = 0u64;
    let mut wal = 0;
    let mut max_copy_us = 0;
    let mut min_copy_us = u128::MAX;
    loop {
        let block_start = Instant::now();
        let result = c
            .copy_next(&json(&Copy {
                cursor: receipt.cursor.clone(),
                expected_revision: receipt.revision,
            }))
            .await
            .unwrap();
        let elapsed = block_start.elapsed().as_micros();
        max_copy_us = max_copy_us.max(elapsed);
        min_copy_us = min_copy_us.min(elapsed);
        receipt = result.receipt;
        steps += 1;
        if steps % 128 == 0 {
            wal = wal.max(disk(&dir.path().join("source.db-wal")));
        }
        if result.ack.is_none() {
            break;
        }
    }
    let copy_ms = started.elapsed().as_millis();
    let seal_start = Instant::now();
    let sealed = c.seal_raw().await.unwrap();
    let seal_ms = seal_start.elapsed().as_millis();
    let read_start = Instant::now();
    let (hash, fragments, max_page) = verify(&c, &oracle).await;
    let read_ms = read_start.elapsed().as_millis();
    assert_eq!(hash, sealed.manifest);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM expected WHERE seen=0")
            .fetch_one(&oracle)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        content,
        conversation_content::conversation_content_version(&pool, "s")
            .await
            .unwrap()
    );
    assert_eq!(dependencies, token(&pool).await);
    assert_eq!(
        catalog,
        crate::commands::conversation_catalog::version(&c.owner, Default::default())
            .await
            .unwrap()
    );
    let db_bytes = disk(&dir.path().join("source.db"));
    let wal_bytes = disk(&dir.path().join("source.db-wal"));
    let blob_reads = c.reads.calls.load(Ordering::Relaxed);
    let blob_bytes = c.reads.bytes.load(Ordering::Relaxed);
    let max_blob = c.reads.max.load(Ordering::Relaxed);
    assert_eq!(max_blob, 4093);
    assert!(blob_reads > long_bytes as u64 / 4093);
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
    let read = authorized(c.owner.clone(), id, Mode::SealedRead, clock).await;
    assert_eq!(verify(&read, &oracle).await.0, hash);
    let result = serde_json::json!({"messages":260,"single_field_raw_bytes":long_bytes,"copy_steps":steps,"native_blob_reads":blob_reads,"native_blob_bytes":blob_bytes,"max_native_blob_read_bytes":max_blob,"readback_fragments":fragments,"max_readback_page_payload_bytes":max_page,"raw_payload_bytes":sealed.receipt.bytes,"logical_capture_charge_bytes":sealed.receipt.charge,"source_and_copy_db_bytes_before_delete":db_bytes,"source_and_copy_wal_bytes_before_delete":wal_bytes,"wal_max_sampled_every_128_copy_steps":wal,"copy_ms":copy_ms,"max_copy_call_us":max_copy_us,"min_copy_call_us":min_copy_us,"source_seed_db_bytes":source_seed_db_bytes,"source_seed_wal_bytes":source_seed_wal_bytes,"oracle_db_bytes":oracle_db_bytes,"oracle_wal_bytes":oracle_wal_bytes,"oracle_expected_fields":sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM expected").fetch_one(&oracle).await.unwrap(),"seal_ms":seal_ms,"readback_and_independent_oracle_ms":read_ms,"manifest_sha256":hash.iter().map(|b|format!("{b:02x}")).collect::<String>(),"source_seed_materialized_only_before_measurement":true,"oracle_is_separate_real_sqlite":true,"readback_after_source_deletion_and_reopen":true,"C1_C2_complementary_versions_unchanged_by_capture":true,"limits":sealed.limits,"global_heap_rss_claim":false,"provider_calls":0});
    serde_json::to_writer_pretty(
        private_file(&output.join("native-source-measures.json")),
        &result,
    )
    .unwrap();
    oracle.close().await;
    reopened.close().await;
}
