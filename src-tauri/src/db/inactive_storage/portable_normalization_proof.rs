//! Test-only bridge. Actual target API, framing, hashes, seal and reopen.
use super::*;
use crate::db::portable_normalization_io::private_file;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use std::{
    fs::File,
    io::{BufRead, BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    time::Instant,
};
fn disk(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fragment {
    header: RecordHeader,
    offset: u64,
    data: String,
}
fn each(path: &Path, mut use_line: impl FnMut(Fragment)) -> usize {
    let mut input = BufReader::with_capacity(8192, File::open(path).unwrap());
    let mut line = Vec::with_capacity(8193);
    let mut maximum = 0;
    loop {
        line.clear();
        let count = Read::by_ref(&mut input)
            .take(8193)
            .read_until(b'\n', &mut line)
            .unwrap();
        if count == 0 {
            break;
        }
        assert!(count <= 8192);
        maximum = maximum.max(count);
        use_line(serde_json::from_slice(&line).unwrap());
    }
    maximum
}
async fn dump_archive(
    store: &InactiveStorage,
    key: &str,
    begin: &Begin,
    path: &Path,
) -> (usize, u64) {
    let mut output = BufWriter::new(private_file(path));
    writeln!(output,"{}",serde_json::json!({"kind":"archive","profile":"portable_chat_history_v1","records":begin.records,"binding":{"version":1,"importKey":key,"manifest":begin.manifest_sha256}})).unwrap();
    let mut cursor = None;
    let mut maximum = 0;
    let mut bytes = 0;
    loop {
        let page = store.readback(key, cursor, 32).await.unwrap();
        maximum = maximum.max(page.fragments.iter().map(|f| f.bytes.len()).sum());
        for fragment in page.fragments {
            bytes += fragment.bytes.len() as u64;
            writeln!(output,"{}",serde_json::json!({"kind":"fragment","header":fragment.record,"offset":fragment.offset,"data":STANDARD.encode(fragment.bytes),"targetUuid":fragment.target_uuid})).unwrap();
        }
        cursor = page.next;
        if cursor.is_none() {
            break;
        }
    }
    output.flush().unwrap();
    (maximum, bytes)
}
async fn rejects_corruption(store: &InactiveStorage, key: &str) {
    let mut cursor = None;
    loop {
        match store.readback(key, cursor, 32).await {
            Err(error) => {
                assert_eq!(error, "integrity_failed");
                break;
            }
            Ok(page) => {
                cursor = page.next;
                assert!(cursor.is_some(), "corruption must be observed");
            }
        }
    }
}
#[tokio::test]
#[ignore = "explicit two-database normalization recipe requires private MACRO_PORTABLE_NORMALIZATION_DIR"]
async fn portable_normalization_target() {
    let root = PathBuf::from(
        std::env::var_os("MACRO_PORTABLE_NORMALIZATION_DIR").expect("private recipe directory"),
    );
    let mut measures = Vec::new();
    for provider in ["codex", "macro-ai"] {
        let source = root.join(format!("normalized-{provider}.ndjson"));
        let mut begin = Begin {
            version: 1,
            identity: identity(),
            bindings: bindings(),
            profile: Profile::PortableChatHistoryV1,
            records: 0,
            bytes: 0,
            manifest_sha256: "0".repeat(64),
        };
        let mut previous = None;
        each(&source, |fragment| {
            if previous != Some(fragment.header.ordinal) {
                assert_eq!(fragment.header.ordinal, begin.records);
                begin.records += 1;
                begin.bytes += fragment.header.bytes;
                previous = Some(fragment.header.ordinal);
            }
        });
        let mut manifest = Manifest::new(&begin).unwrap();
        previous = None;
        let max_line = each(&source, |fragment| {
            if previous != Some(fragment.header.ordinal) {
                manifest.record(&fragment.header).unwrap();
                previous = Some(fragment.header.ordinal);
            }
        });
        begin.manifest_sha256 = manifest.finish();
        let path = root.join(format!("target-{provider}.db"));
        assert!(!path.exists(), "recipe target must be fresh");
        let clock = Arc::new(AtomicI64::new(1_000_000));
        let store = active(create_pool(&path).await.unwrap(), clock.clone());
        let started = Instant::now();
        let receipt = store.begin(json(&begin).unwrap().as_bytes()).await.unwrap();
        // Bounded input lines, never a whole normalized payload/record buffer.
        let mut input = BufReader::with_capacity(8192, File::open(&source).unwrap());
        let mut line = Vec::with_capacity(8193);
        let mut appends = 0u64;
        let mut wal_max = 0u64;
        loop {
            line.clear();
            let n = Read::by_ref(&mut input)
                .take(8193)
                .read_until(b'\n', &mut line)
                .unwrap();
            if n == 0 {
                break;
            }
            assert!(n <= 8192);
            let fragment: Fragment = serde_json::from_slice(&line).unwrap();
            let bytes = STANDARD.decode(fragment.data).unwrap();
            assert!(bytes.len() <= FRAGMENT_BYTES);
            let control = Append {
                record: fragment.header,
                offset: fragment.offset,
                sha256: digest(&bytes),
            };
            store
                .append(&receipt.key, json(&control).unwrap().as_bytes(), &bytes)
                .await
                .unwrap();
            appends += 1;
            if appends % 128 == 0 {
                wal_max = wal_max.max(disk(&root.join(format!("target-{provider}.db-wal"))));
            }
        }
        let receive_ms = started.elapsed().as_millis();
        let seal_started = Instant::now();
        let sealed = store.seal_storage(&receipt.key).await.unwrap();
        let seal_ms = seal_started.elapsed().as_millis();
        let ordinary: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM conversations")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(ordinary, 0);
        let before = store.pool.clone();
        drop(store);
        before.close().await;
        let reopened = active(create_pool(&path).await.unwrap(), clock);
        assert_eq!(
            reopened
                .begin(json(&begin).unwrap().as_bytes())
                .await
                .unwrap(),
            sealed.receipt
        );
        let (max_page, readback_bytes) = dump_archive(
            &reopened,
            &receipt.key,
            &begin,
            &root.join(format!("target-{provider}.ndjson")),
        )
        .await;
        assert_eq!(readback_bytes, begin.bytes);
        measures.push(serde_json::json!({"provider":provider,"records":begin.records,"raw_target_payload_bytes":begin.bytes,"appends":appends,"max_input_line_bytes":max_line,"receive_ms":receive_ms,"seal_ms":seal_ms,"readback_page_payload_max":max_page,"logical_charge_bytes":sealed.receipt.charge_bytes,"normalized_spool_bytes":disk(&source),"archive_spool_bytes":disk(&root.join(format!("target-{provider}.ndjson"))),"db_bytes_after_reopen":disk(&path),"wal_bytes_after_reopen":disk(&root.join(format!("target-{provider}.db-wal"))),"wal_max_sampled_every_128_appends":wal_max,"ordinary_conversations":ordinary}));
        if provider == "codex" {
            let mut controls = Vec::new();
            for marker in ["HIDDEN_ONLY_FACT", "PROVIDER_ONLY_FACT", "CITATION_FACT"] {
                let row=sqlx::query("SELECT ordinal,offset_bytes,data FROM e_inactive_fragments WHERE instr(CAST(data AS TEXT),?)>0 LIMIT 1").bind(marker).fetch_one(&reopened.pool).await.unwrap();
                let ordinal: i64 = row.get("ordinal");
                let offset: i64 = row.get("offset_bytes");
                let original: Vec<u8> = row.get("data");
                let mut corrupt = original.clone();
                corrupt[0] ^= 1;
                sqlx::query(
                    "UPDATE e_inactive_fragments SET data=? WHERE ordinal=? AND offset_bytes=?",
                )
                .bind(corrupt)
                .bind(ordinal)
                .bind(offset)
                .execute(&reopened.pool)
                .await
                .unwrap();
                rejects_corruption(&reopened, &receipt.key).await;
                sqlx::query(
                    "UPDATE e_inactive_fragments SET data=? WHERE ordinal=? AND offset_bytes=?",
                )
                .bind(original)
                .bind(ordinal)
                .bind(offset)
                .execute(&reopened.pool)
                .await
                .unwrap();
                controls
                    .push(serde_json::json!({"marker":marker,"native_corruption_refused":true}));
            }
            let row=sqlx::query("SELECT f.ordinal,f.offset_bytes,f.data FROM e_inactive_fragments f JOIN e_inactive_records r ON r.ordinal=f.ordinal AND r.import_id=f.import_id WHERE r.kind=3 LIMIT 1").fetch_one(&reopened.pool).await.unwrap();
            let ordinal: i64 = row.get("ordinal");
            let offset: i64 = row.get("offset_bytes");
            let original: Vec<u8> = row.get("data");
            let mut corrupt = original.clone();
            corrupt[0] ^= 1;
            sqlx::query(
                "UPDATE e_inactive_fragments SET data=? WHERE ordinal=? AND offset_bytes=?",
            )
            .bind(corrupt)
            .bind(ordinal)
            .bind(offset)
            .execute(&reopened.pool)
            .await
            .unwrap();
            rejects_corruption(&reopened, &receipt.key).await;
            sqlx::query(
                "UPDATE e_inactive_fragments SET data=? WHERE ordinal=? AND offset_bytes=?",
            )
            .bind(&original)
            .bind(ordinal)
            .bind(offset)
            .execute(&reopened.pool)
            .await
            .unwrap();
            controls.push(serde_json::json!({"marker":"asset","native_corruption_refused":true}));
            for (name, kind) in [("missing-asset", 3i64), ("missing-association", 4)] {
                let row=sqlx::query("SELECT f.* FROM e_inactive_fragments f JOIN e_inactive_records r ON r.ordinal=f.ordinal AND r.import_id=f.import_id WHERE r.kind=? LIMIT 1").bind(kind).fetch_one(&reopened.pool).await.unwrap();
                let import_id: i64 = row.get("import_id");
                let ordinal: i64 = row.get("ordinal");
                let offset: i64 = row.get("offset_bytes");
                sqlx::query("DELETE FROM e_inactive_fragments WHERE import_id=? AND ordinal=? AND offset_bytes=?").bind(import_id).bind(ordinal).bind(offset).execute(&reopened.pool).await.unwrap();
                dump_archive(
                    &reopened,
                    &receipt.key,
                    &begin,
                    &root.join(format!("target-negative-{name}.ndjson")),
                )
                .await;
                sqlx::query("INSERT INTO e_inactive_fragments(import_id,ordinal,offset_bytes,data,sha256,ack_next_offset,ack_total_received,ack_revision) VALUES(?,?,?,?,?,?,?,?)")
                    .bind(import_id)
                    .bind(ordinal)
                    .bind(offset)
                    .bind(row.get::<Vec<u8>, _>("data"))
                    .bind(row.get::<Vec<u8>, _>("sha256"))
                    .bind(row.get::<i64, _>("ack_next_offset"))
                    .bind(row.get::<i64, _>("ack_total_received"))
                    .bind(row.get::<i64, _>("ack_revision"))
                    .execute(&reopened.pool)
                    .await
                    .unwrap();
                controls.push(
                    serde_json::json!({"removed":name,"native_readback_archive_emitted":true}),
                );
            }
            assert_eq!(reopened.status(&receipt.key).await.unwrap(), sealed.receipt);
            serde_json::to_writer_pretty(
                private_file(&root.join("target-negative-controls.json")),
                &controls,
            )
            .unwrap();
        }
        reopened.pool.close().await;
    }
    serde_json::to_writer_pretty(
        private_file(&root.join("target-native-measures.json")),
        &measures,
    )
    .unwrap();
}

#[derive(Deserialize)]
struct PreparedCase {
    target: String,
    phase: String,
    request: crate::ai::types::AiChatRequest,
    facts: Vec<String>,
    forbidden_system: Vec<String>,
    require_image: bool,
}
#[test]
#[ignore = "requires target-only real Bun preparation artifacts in MACRO_PORTABLE_NORMALIZATION_DIR"]
fn portable_normalization_serializers() {
    let root = PathBuf::from(
        std::env::var_os("MACRO_PORTABLE_NORMALIZATION_DIR").expect("private recipe directory"),
    );
    let cases: Vec<PreparedCase> = serde_json::from_reader(BufReader::new(
        File::open(root.join("prepared-requests.json")).unwrap(),
    ))
    .unwrap();
    assert_eq!(cases.len(), 8);
    let required = [
        "PROVIDER_ONLY_FACT",
        "HIDDEN_ONLY_FACT",
        "CITATION_FACT",
        "ASSET_TEXT_FACT",
        "ASSET_FIRST_FACT",
    ];
    let forbidden = [
        "SOURCE_CHECKPOINT_HISTORY",
        "TARGET_CHECKPOINT_HISTORY",
        "OBSERVABLE_REFLECTION",
        "OMITTED_ARCHIVE_FACT=violet-73",
    ];
    let mut seen = std::collections::BTreeSet::new();
    let mut output = BufWriter::new(private_file(&root.join("native-wire.ndjson")));
    let mut measures = Vec::new();
    for case in cases {
        assert!(["codex", "macro-ai"].contains(&case.target.as_str()));
        assert!([
            "codex-compacted",
            "codex-recovered",
            "macro-ai-compacted",
            "macro-ai-recovered"
        ]
        .contains(&case.phase.as_str()));
        assert!(
            seen.insert((case.target.clone(), case.phase.clone())),
            "duplicate adapter phase"
        );
        assert!(case.require_image);
        for fact in required {
            assert!(case.facts.iter().any(|value| value == fact));
        }
        for marker in forbidden {
            assert!(case.forbidden_system.iter().any(|value| value == marker));
        }
        let body = if case.target == "codex" {
            crate::ai::chatgpt::portable_history_proof_request(&case.request).unwrap()
        } else {
            assert_eq!(case.target, "macro-ai");
            crate::ai::openai_compatible::portable_history_proof_request(&case.request).unwrap()
        };
        let encoded = serde_json::to_string(&body).unwrap();
        for fact in required.iter().copied().chain(
            case.phase
                .ends_with("-recovered")
                .then_some("OMITTED_ARCHIVE_FACT=violet-73"),
        ) {
            assert!(
                encoded.contains(fact),
                "required fact absent in {} {}",
                case.target,
                case.phase
            );
        }
        let systems = if case.target == "codex" {
            body["instructions"].as_str().unwrap().to_string()
        } else {
            body["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|m| m["role"] == "system" || m["role"] == "developer")
                .map(|m| m["content"].as_str().unwrap())
                .collect::<Vec<_>>()
                .join("\n")
        };
        assert!(!systems.is_empty());
        for marker in forbidden {
            assert!(
                !systems.contains(marker),
                "historical data promoted to system"
            );
        }
        for key in ["input", "messages"] {
            if let Some(messages) = body[key].as_array() {
                for message in messages {
                    if message["role"] == "system" || message["role"] == "developer" {
                        for marker in forbidden {
                            assert!(!message.to_string().contains(marker));
                        }
                    }
                    assert!(message.get("tool_calls").is_none());
                    assert!(message.get("tool_call_id").is_none());
                    assert!(
                        message["type"] != "function_call"
                            && message["type"] != "function_call_output"
                    );
                }
            }
        }
        assert!(
            encoded.find("PROVIDER_ONLY_FACT").unwrap() < encoded.find("HIDDEN_ONLY_FACT").unwrap()
        );
        assert!(
            encoded.find("ASSET_FIRST_FACT").unwrap() < encoded.find("ASSET_TEXT_FACT").unwrap()
        );
        if case.phase.ends_with("-compacted") {
            assert!(
                !encoded.contains("OMITTED_ARCHIVE_FACT=violet-73"),
                "recovery fact must be absent before archive retrieval"
            );
        }
        assert!(!encoded.contains("synthetic-private-token"));
        assert!(body.get("previous_response_id").is_none());
        assert!(body.get("conversation").is_none());
        if case.require_image {
            assert!(encoded.contains("data:image/png;base64,"));
            assert!(encoded.contains(if case.target == "codex" {
                "input_image"
            } else {
                "image_url"
            }));
        }
        measures.push(serde_json::json!({"target":case.target,"phase":case.phase,"serialized_provider_body_bytes":encoded.len()}));
        writeln!(
            output,
            "{}",
            serde_json::json!({"target":case.target,"phase":case.phase,"body":body})
        )
        .unwrap();
    }
    output.flush().unwrap();
    let expected: std::collections::BTreeSet<_> = ["codex", "macro-ai"]
        .into_iter()
        .flat_map(|target| {
            [
                "codex-compacted",
                "codex-recovered",
                "macro-ai-compacted",
                "macro-ai-recovered",
            ]
            .into_iter()
            .map(move |phase| (target.to_string(), phase.to_string()))
        })
        .collect();
    assert_eq!(seen, expected);
    serde_json::to_writer_pretty(
        private_file(&root.join("native-wire-measures.json")),
        &measures,
    )
    .unwrap();
}
