//! Explicit synthetic bridge: native capture/readback, not a product wire.
use super::*;
use crate::db::portable_normalization_io::private_file;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    fs::File,
    io::{BufWriter, Write},
    path::Path,
    time::Instant,
};
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn disk(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}
#[tokio::test]
#[ignore = "explicit two-database normalization recipe requires private MACRO_PORTABLE_NORMALIZATION_DIR"]
async fn portable_normalization_source() {
    let root = std::path::PathBuf::from(
        std::env::var_os("MACRO_PORTABLE_NORMALIZATION_DIR").expect("private recipe directory"),
    );
    let mut measures = Vec::new();
    for provider in ["codex", "macro-ai"] {
        let (dir, pool, capture, _clock) = capture_fixture().await;
        // The fixture seed is intentionally materialized before measurement.
        // No source SELECT returning a long field is used by the measured path.
        {
            let seed: Value = serde_json::from_reader(
                File::open(root.join(format!("seed-{provider}.json"))).unwrap(),
            )
            .unwrap();
            sqlx::query("DELETE FROM messages WHERE conversation_id='s'")
                .execute(&pool)
                .await
                .unwrap();
            for row in seed.as_array().unwrap() {
                let family = row["family"].as_u64().unwrap() as usize;
                let spec = &crate::db::source_capture::allowlist::FAMILIES[family];
                let mut columns = spec.columns.join(",");
                let mut slots = vec!["?"; spec.columns.len()].join(",");
                if family == 2 {
                    columns.push_str(",updated_at");
                    slots.push_str(",'2026-01-01T00:00:00Z'");
                }
                if family == 8 {
                    columns.push_str(",owner_key,instance_id,ref_key");
                    slots.push_str(",'proof-owner','proof-instance','proof-ref'");
                }
                if family == 9 {
                    columns.push_str(
                        ",owner_key,ref_key,send_intent_id,scope_key,digest,intent_expires_at",
                    );
                    slots.push_str(",'proof-owner','proof-ref','proof-intent','proof-scope','proof-digest',100000000");
                }
                let sql = format!(
                    "INSERT OR REPLACE INTO {}({columns}) VALUES({slots})",
                    spec.table
                );
                let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
                for field in row["fields"].as_array().unwrap() {
                    let bytes = STANDARD.decode(field["data"].as_str().unwrap()).unwrap();
                    query = match field["sql_type"].as_u64().unwrap() {
                        0 => query.bind(None::<String>),
                        1 => query.bind(i64::from_le_bytes(bytes.try_into().unwrap())),
                        2 => query.bind(String::from_utf8(bytes).unwrap()),
                        3 => query.bind(bytes),
                        _ => panic!("closed fixture type"),
                    };
                }
                query.execute(&pool).await.unwrap();
            }
        }
        let started = Instant::now();
        begin(&capture).await;
        let copied = copy_all(&capture).await;
        let sealed = capture.seal_raw().await.unwrap();
        assert!(sealed.receipt.revision > copied.revision);
        let capture_ms = started.elapsed().as_millis();
        let mut output = BufWriter::new(private_file(
            &root.join(format!("source-{provider}.ndjson")),
        ));
        writeln!(output,"{}",json!({"kind":"capture","manifest":hex(&sealed.manifest),"binding":sealed.binding,"limits":sealed.limits})).unwrap();
        let mut cursor = None;
        let mut fragments = 0u64;
        let mut payload_bytes = 0u64;
        let mut max_page_bytes = 0usize;
        loop {
            let page = capture.readback(cursor, 32).await.unwrap();
            max_page_bytes = max_page_bytes.max(page.fragments.iter().map(|f| f.data.len()).sum());
            for fragment in page.fragments {
                assert!(fragment.data.len() <= 4093);
                payload_bytes += fragment.data.len() as u64;
                fragments += 1;
                writeln!(output,"{}",json!({"kind":"fragment","field":fragment.field,"offset":fragment.offset,"fragment_sha256":hex(&fragment.sha256),"data":STANDARD.encode(fragment.data)})).unwrap();
            }
            cursor = page.next;
            if cursor.is_none() {
                break;
            }
        }
        let mut after = None;
        let mut relations = 0usize;
        loop {
            let page = capture.readback_relations(after, 32).await.unwrap();
            if page.is_empty() {
                break;
            }
            for relation in page {
                after = Some((relation.from, relation.kind, relation.position));
                relations += 1;
                writeln!(output, "{}", json!({"kind":"relation","relation":relation})).unwrap();
            }
        }
        output.flush().unwrap();
        measures.push(json!({"provider":provider,"raw_payload_bytes":payload_bytes,"fragments":fragments,"relations":relations,"max_readback_page_payload_bytes":max_page_bytes,"capture_ms":capture_ms,"capture_and_readback_ms":started.elapsed().as_millis(),"source_db_bytes":disk(&dir.path().join("source.db")),"source_wal_bytes_at_end":disk(&dir.path().join("source.db-wal")),"spool_bytes":disk(&root.join(format!("source-{provider}.ndjson"))),"logical_charge_bytes":sealed.receipt.charge}));
        drop(capture);
        pool.close().await;
        drop(pool);
        drop(dir);
    }
    serde_json::to_writer_pretty(
        private_file(&root.join("source-native-measures.json")),
        &measures,
    )
    .unwrap();
}
